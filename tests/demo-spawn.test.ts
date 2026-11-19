import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { npmSpawnPlan, spawnNpm } from '../scripts/demo-spawn.mjs';

const args = ['run', 'dev', '-w', '@comictoons/server'];
const env = { COMICTOONS_API_PORT: '3122' };

function withPlatform<T>(platform: NodeJS.Platform, run: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { return run(); } finally { Object.defineProperty(process, 'platform', original); }
}

function recordSpawn() {
  const calls: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  const spawn = (command: string, spawnArgs: string[], options: Record<string, unknown>) => { calls.push({ command, args: spawnArgs, options }); return { pid: 1 }; };
  return { calls, spawn };
}

test('on Linux the demo still spawns npm directly, with no shell (unchanged behaviour)', () => {
  const { calls, spawn } = recordSpawn();
  withPlatform('linux', () => spawnNpm(args, { stdio: 'inherit', env }, { spawn } as never));
  assert.deepEqual(calls, [{ command: 'npm', args, options: { stdio: 'inherit', env } }]);
  assert.equal('shell' in calls[0]!.options, false);
});

test('on Windows the demo starts npm through the shell, since npm is npm.cmd there', () => {
  const { calls, spawn } = recordSpawn();
  withPlatform('win32', () => spawnNpm(args, { stdio: 'inherit', env }, { spawn } as never));
  assert.equal(calls.length, 1);
  // A bare 'npm' with shell:false fails with ENOENT on Windows, and npm.cmd without a shell
  // is refused with EINVAL by Node 20.12.2 and later, so the shell is required.
  assert.equal(calls[0]!.options.shell, true);
  assert.equal(calls[0]!.command, 'npm run dev -w @comictoons/server');
  assert.deepEqual(calls[0]!.args, []);
  assert.equal(calls[0]!.options.stdio, 'inherit');
  assert.equal(calls[0]!.options.env, env);
});

test('the platform can also be passed explicitly', () => {
  assert.equal((npmSpawnPlan as (...a: unknown[]) => { options: { shell?: boolean } })(args, {}, 'win32').options.shell, true);
  assert.equal((npmSpawnPlan as (...a: unknown[]) => { options: { shell?: boolean } })(args, {}, 'darwin').options.shell, undefined);
});

test('on Windows only plain npm arguments may reach the shell', () => {
  const plan = npmSpawnPlan as (...a: unknown[]) => unknown;
  for (const bad of ['dev & calc', 'a|b', '"x"', '%PATH%', 'x>y', '^', ''])
    assert.throws(() => plan(['run', bad], {}, 'win32'), /Unsafe npm argument/);
});

test('scripts/demo.mjs starts both workspaces through spawnNpm, never a bare spawn of npm', () => {
  const source = readFileSync(new URL('../scripts/demo.mjs', import.meta.url), 'utf8');
  assert.match(source, /from '\.\/demo-spawn\.mjs'/);
  assert.doesNotMatch(source, /\bspawn\(\s*'npm'/);
  assert.doesNotMatch(source, /node:child_process/);
});
