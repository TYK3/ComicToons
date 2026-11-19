import { randomUUID } from 'node:crypto';
import type { ComicPanel } from '@comictoons/core';
import type { SeriesSourceKind } from '../../../../packages/core/src/manga.ts';
import { IMPORT_RESULTS_LIMIT } from './caps.ts';

/** What "Add to my manga series" needs from a finished import. */
export interface ImportResult {
  kind: Exclude<SeriesSourceKind, 'live'>; sourceUrl: string; title: string; channel?: string; panels: ComicPanel[];
  /** Plain words when only part of the source was used, e.g. "Used the first 10 min of a 47 min video." */
  note?: string;
}

/**
 * The last IMPORT_RESULTS_LIMIT imports, in memory, by a random id. The series route appends from
 * here, so the panels a chapter stores are the server's own, never panels a client sent back.
 */
export class ImportResults {
  private items = new Map<string, ImportResult>();
  constructor(private readonly limit = IMPORT_RESULTS_LIMIT) {}
  add(result: ImportResult): string {
    const id = randomUUID();
    this.items.set(id, structuredClone(result));
    while (this.items.size > this.limit) this.items.delete(this.items.keys().next().value!);
    return id;
  }
  get(id: string): ImportResult | undefined {
    const item = this.items.get(id);
    return item ? structuredClone(item) : undefined;
  }
}
