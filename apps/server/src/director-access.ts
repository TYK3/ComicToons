import {createHash, timingSafeEqual} from 'node:crypto';
import {isIP} from 'node:net';
import type {FastifyRequest, onRequestHookHandler} from 'fastify';
import {readProductEnv} from '../../../packages/core/src/env.mjs';

export const DIRECTOR_KEY_ENV = 'COMICTOONS_DIRECTOR_KEY';
export const DIRECTOR_KEY_HEADER = 'x-comictoons-director-key';
export function readDirectorKey(env: Record<string, string | undefined> = process.env): string | undefined {
  return readProductEnv(DIRECTOR_KEY_ENV, env)?.trim() || undefined;
}
const digest = (value: string) => createHash('sha256').update(value).digest();
function loopback(address: string): boolean {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  return ip === '::1' || (isIP(ip) === 4 && ip.startsWith('127.'));
}

/** A proxy may only preserve locality when its socket and every forwarded hop are local. */
export function isLocalRequest(req: Pick<FastifyRequest, 'headers' | 'socket'>): boolean {
  const forwarded = req.headers['x-forwarded-for'];
  const hops = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map(hop => hop.trim()).filter(Boolean);
  return loopback(req.socket.remoteAddress ?? '') && hops.every(loopback);
}

/** The key stays server-side; failures contain only fixed guidance. */
export function directorAccess(req: Pick<FastifyRequest, 'headers' | 'socket'>, key: string | undefined):
  {ok: true} | {ok: false; status: 401 | 403; error: string} {
  const expected = key?.trim();
  if (expected) {
    const sent = req.headers[DIRECTOR_KEY_HEADER];
    const value = Array.isArray(sent) ? sent[0] : sent;
    if (typeof value === 'string' && timingSafeEqual(digest(value), digest(expected))) return {ok: true};
    return {ok: false, status: 401, error: 'Enter the director key to use this page.'};
  }
  if (isLocalRequest(req)) return {ok: true};
  return {ok: false, status: 403, error: `Studio writes from another device need a key. Set ${DIRECTOR_KEY_ENV} and restart ComicToons.`};
}

/** Use onRequest so authentication precedes body parsing and schema validation. */
export function directorGuard(key: string | undefined): onRequestHookHandler {
  const expected = key?.trim();
  return async (req, reply) => {
    const access = directorAccess(req, expected);
    if (!access.ok) return reply.code(access.status).send({error: access.error});
  };
}
