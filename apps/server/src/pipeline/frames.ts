import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ClipRef { url: string; thumbnailUrl: string }
export interface InkFrameOptions {
  timeoutMs?: number;
  ffmpegPath?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: (command: string, args: string[]) => ChildProcessWithoutNullStreams;
}
export interface InkFrameResult { buffer: Buffer; ms: number }

const DEFAULT_TIMEOUT_MS = 20_000;
const INK_FILTER = "format=gray,eq=contrast=1.6:brightness=0.02,curves=all='0/0 0.5/0.42 1/1',"
  + 'split[s0][s1],[s0]palettegen=max_colors=4[p],[s1][p]paletteuse=dither=bayer:bayer_scale=3';

export function ffmpegAvailable(path: string): boolean {
  try { return existsSync(path); } catch { return false; }
}

export type SpawnImpl = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

/** Generic piped ffmpeg run: writes `input` to stdin, reads a single encoded image from
 * stdout. Shared by the clip ink filter here and by imagegen's PNG transcode step. */
export function runFfmpeg(input: Buffer, args: string[], options: { ffmpegPath: string; timeoutMs: number; spawnImpl?: SpawnImpl }): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const spawnImpl = options.spawnImpl ?? nodeSpawn;
    let child: ChildProcessWithoutNullStreams;
    try { child = spawnImpl(options.ffmpegPath, args); } catch { resolve(undefined); return; }
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: Buffer | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } finish(undefined); }, Math.max(1, options.timeoutMs));
    child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.on('error', () => finish(undefined));
    child.on('close', (code) => finish(code === 0 && chunks.length > 0 ? Buffer.concat(chunks) : undefined));
    child.stdin?.on('error', () => { /* a closed pipe after a failed spawn is expected, not fatal */ });
    try { child.stdin?.end(input); } catch { finish(undefined); }
  });
}

/**
 * Downloads a Twitch clip's still thumbnail and runs it through a local, no-key
 * halftone/ink filter so it reads as a manga panel. It is a no-op without a clip
 * (Helix clips arrive later from S1), and falls through gracefully when ffmpeg is
 * unavailable, the download fails, or either step times out.
 */
export async function inkClipFrame(clip: ClipRef | undefined, options: InkFrameOptions = {}): Promise<InkFrameResult | undefined> {
  if (!clip?.thumbnailUrl) return undefined;
  const ffmpegPath = options.ffmpegPath ?? '/usr/bin/ffmpeg';
  if (!ffmpegAvailable(ffmpegPath)) return undefined;
  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(clip.thumbnailUrl, { signal: controller.signal });
    if (!response.ok) return undefined;
    const still = Buffer.from(await response.arrayBuffer());
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) return undefined;
    const args = ['-hide_banner', '-loglevel', 'error', '-i', '-', '-vf', INK_FILTER, '-f', 'image2', '-vframes', '1', '-vcodec', 'png', '-'];
    const buffer = await runFfmpeg(still, args, { ffmpegPath, timeoutMs: remaining, spawnImpl: options.spawnImpl });
    if (!buffer) return undefined;
    return { buffer, ms: Date.now() - started };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
