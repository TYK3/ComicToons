import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsync, onRequestHookHandler } from 'fastify';
import type { ImportResults } from '../import/results.ts';
import type { ChannelSeriesStore } from './store.ts';

export interface SeriesRouteOptions {
  store: ChannelSeriesStore;
  results: ImportResults;
  /** The app's directorGuard: appending a chapter is a Studio write. Reading stays open, like other reads. */
  guard: onRequestHookHandler;
  now?: () => number;
}

const CHANNEL = '^[a-z0-9_]{1,25}$';

/**
 * A channel's manga series: every chapter it has logged, oldest first, numbered from 1.
 * GET  /api/channel-series/:channel
 * POST /api/channel-series/:channel/chapters {importId, title?}: appends a finished import (from /api/import).
 * Named channel-series so it never clashes with the per-issue GET /api/series/:id.
 */
export const seriesRoutes: FastifyPluginAsync<SeriesRouteOptions> = async (app, options) => {
  const now = options.now ?? (() => Date.now());
  const params = { type: 'object', required: ['channel'], properties: { channel: { type: 'string', pattern: CHANNEL } } };
  const numbered = (series: Awaited<ReturnType<ChannelSeriesStore['read']>>) =>
    ({ channel: series.channel, chapters: series.chapters.map((chapter, index) => ({ number: index + 1, ...chapter })) });

  app.get('/api/channel-series/:channel', { schema: { params } }, async req => {
    const { channel } = req.params as { channel: string };
    return numbered(await options.store.read(channel));
  });

  app.post('/api/channel-series/:channel/chapters', {
    onRequest: options.guard,
    schema: { params, body: { type: 'object', additionalProperties: false, required: ['importId'], properties: {
      importId: { type: 'string', minLength: 1, maxLength: 64 },
      title: { type: 'string', minLength: 1, maxLength: 160 },
    } } },
  }, async (req, reply) => {
    const { channel } = req.params as { channel: string };
    const body = req.body as { importId: string; title?: string };
    const result = options.results.get(body.importId);
    if (!result) return reply.code(404).send({ error: 'That import is no longer held here. Import it again, then add it to the series.' });
    const title = body.title?.trim() || result.title;
    const chapter = { id: randomUUID(), title, sourceUrl: result.sourceUrl, sourceKind: result.kind, createdAt: now(), panels: result.panels, ...(result.note ? { note: result.note } : {}) };
    const series = await options.store.append(channel, chapter);
    return reply.code(201).send({ chapter: { number: series.chapters.length, ...chapter }, series: numbered(series) });
  });
};
