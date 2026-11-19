// Optional bridge to the official Twitch CLI (https://dev.twitch.tv/docs/cli/).
// The CLI's mock EventSub WebSocket server and `twitch event trigger` are used as a
// conformance oracle: if the CLI is installed, a test compares its frames with the
// fake's. The CLI is never required, never added as a dependency, and every command
// here stays on 127.0.0.1 (https://dev.twitch.tv/docs/cli/websocket-event-command/).
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {existsSync} from 'node:fs';

/** Environment for every CLI call: no update check, no network, no saved config. */
export const cliEnv = () => ({...process.env, TWITCH_DISABLE_UPDATE_CHECKS: 'true', CI: 'true'});

/** TWITCH_CLI_BIN (a path) wins; otherwise `twitch` on PATH. Returns undefined when absent. */
export function findTwitchCli(): string | undefined {
  const candidates = [process.env.TWITCH_CLI_BIN, 'twitch'].filter((c): c is string => !!c);
  for (const candidate of candidates) {
    if (candidate.includes('/') && !existsSync(candidate)) continue;
    const probe = spawnSync(candidate, ['version'], {env: cliEnv(), encoding: 'utf8', timeout: 10_000});
    if (probe.status === 0 && /twitch-cli/i.test(`${probe.stdout}${probe.stderr}`)) return candidate;
  }
  return undefined;
}

export interface CliWebsocketServer { child: ChildProcess; url: string; output: () => string; stop: () => Promise<void> }

/** Starts `twitch event websocket start-server -p <port>` and waits until it listens.
 * stop() signals only this exact child PID. */
export function startCliWebsocket(bin: string, port: number, extraArgs: string[] = []): Promise<CliWebsocketServer> {
  const child = spawn(bin, ['event', 'websocket', 'start-server', '--ip', '127.0.0.1', '-p', String(port), ...extraArgs], {env: cliEnv(), stdio: ['ignore', 'pipe', 'pipe']});
  let log = '';
  const collect = (chunk: Buffer) => { log += chunk.toString('utf8'); };
  child.stdout!.on('data', collect); child.stderr!.on('data', collect);
  const stop = () => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    const hard = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 3000);
    hard.unref();
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stop(); reject(new Error('Twitch CLI websocket server did not start within 15 s')); }, 15_000);
    const check = () => {
      if (/Connect to the WebSocket server at/.test(log)) {
        clearTimeout(timer); child.stdout!.off('data', check); child.stderr!.off('data', check);
        resolve({child, url: `ws://127.0.0.1:${port}/ws`, output: () => log, stop});
      }
    };
    child.stdout!.on('data', check); child.stderr!.on('data', check);
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Twitch CLI exited early (${code})`)); });
  });
}

/** `twitch event trigger <type> --transport=websocket`, forwarded to the running CLI server. */
export function triggerCli(bin: string, type: string, args: string[] = []) {
  const run = spawnSync(bin, ['event', 'trigger', type, '--transport=websocket', '--no-config', ...args], {env: cliEnv(), encoding: 'utf8', timeout: 15_000});
  return {ok: run.status === 0, output: `${run.stdout ?? ''}${run.stderr ?? ''}`};
}

/** `twitch event websocket reconnect`: sends session_reconnect to connected clients. */
export function reconnectCli(bin: string) {
  const run = spawnSync(bin, ['event', 'websocket', 'reconnect'], {env: cliEnv(), encoding: 'utf8', timeout: 15_000});
  return {ok: run.status === 0, output: `${run.stdout ?? ''}${run.stderr ?? ''}`};
}
