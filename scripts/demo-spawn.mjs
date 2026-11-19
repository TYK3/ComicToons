import { spawn as nodeSpawn } from 'node:child_process';

// On Windows `npm` is a batch file (npm.cmd). spawn('npm') without a shell fails there with
// ENOENT, and since Node 20.12.2 spawning npm.cmd without a shell is refused with EINVAL, so on
// win32 only the demo starts npm through the shell. Every other platform is unchanged.
const PLAIN_ARGUMENT = /^[A-Za-z0-9@/._:=-]+$/;

/** How scripts/demo.mjs starts `npm <args>` on the given platform. */
export function npmSpawnPlan(args, options, platform = process.platform) {
  if (platform !== 'win32') return { command: 'npm', args: [...args], options: { ...options } };
  // The shell sees one command line, so only plain arguments (no spaces, quotes or cmd.exe
  // metacharacters such as & | < > ^ %) may be passed through.
  for (const arg of args) if (!PLAIN_ARGUMENT.test(arg)) throw new Error(`Unsafe npm argument for the Windows shell: ${JSON.stringify(arg)}`);
  return { command: ['npm', ...args].join(' '), args: [], options: { ...options, shell: true } };
}

/** Starts `npm <args>`; `platform` and `spawn` can be stubbed in tests. */
export function spawnNpm(args, options, { platform = process.platform, spawn = nodeSpawn } = {}) {
  const plan = npmSpawnPlan(args, options, platform);
  return spawn(plan.command, plan.args, plan.options);
}
