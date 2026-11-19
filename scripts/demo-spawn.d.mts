import type { ChildProcess, SpawnOptions } from 'node:child_process';

export type NpmSpawnPlan = { command: string; args: string[]; options: SpawnOptions };
export function npmSpawnPlan(args: readonly string[], options: SpawnOptions, platform?: NodeJS.Platform): NpmSpawnPlan;
export function spawnNpm(
  args: readonly string[],
  options: SpawnOptions,
  stubs?: { platform?: NodeJS.Platform; spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess },
): ChildProcess;
