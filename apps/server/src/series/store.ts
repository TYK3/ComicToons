import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { appendChapter, emptyChannelSeries, type ChannelSeries, type SeriesChapter } from '../../../../packages/core/src/manga.ts';

/**
 * IMPORT-1: one JSON file per channel under `directory`, written atomically (a temp file, then a
 * rename), so a crash mid-write never leaves a half-written series. Appends to one channel run one
 * at a time. In tests `directory` is a fresh temp directory, never the repo.
 */
export class ChannelSeriesStore {
  private cache = new Map<string, ChannelSeries>();
  private queue = new Map<string, Promise<unknown>>();
  constructor(private directory: string) {}

  private path(channel: string): string {
    if (!/^[a-z0-9_]{1,25}$/.test(channel)) throw new Error('Invalid Twitch channel name.');
    return resolve(this.directory, `${channel}.json`);
  }

  async read(channel: string): Promise<ChannelSeries> {
    const file = this.path(channel);
    const cached = this.cache.get(channel);
    if (cached) return structuredClone(cached);
    let series: ChannelSeries;
    try { series = JSON.parse(await readFile(file, 'utf8')) as ChannelSeries; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') series = emptyChannelSeries(channel); else throw error; }
    this.cache.set(channel, series);
    return structuredClone(series);
  }

  private async write(channel: string, series: ChannelSeries): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const temporary = resolve(this.directory, `${channel}-${randomUUID()}.tmp`);
    try { await writeFile(temporary, JSON.stringify(series, null, 2)); await rename(temporary, this.path(channel)); }
    catch (error) { await unlink(temporary).catch(() => {}); throw error; }
    this.cache.set(channel, series);
  }

  /** Appends one chapter and persists the result; the returned series is the new, full list. */
  async append(channel: string, chapter: SeriesChapter): Promise<ChannelSeries> {
    this.path(channel);
    const run = (this.queue.get(channel) ?? Promise.resolve()).catch(() => undefined).then(async () => {
      const next = appendChapter(await this.read(channel), chapter);
      await this.write(channel, next);
      return structuredClone(next);
    });
    this.queue.set(channel, run);
    try { return await run; } finally { if (this.queue.get(channel) === run) this.queue.delete(channel); }
  }
}
