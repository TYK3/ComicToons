import {randomBytes} from 'node:crypto';
import type {FastifyPluginAsync} from 'fastify';
import {readProductEnv} from '../../../../packages/core/src/env.mjs';
import {directorGuard, isLocalRequest} from '../director-access.ts';
import type {BroadcasterType} from '../twitch-api/types.ts';
import type {TwitchTokenStore} from './token-store.ts';

/** LIVE-TEST BUG-1: new on every server process. The Twitch sign-in lives in memory, so a new bootId with no
 * sign-out reason tells the Studio the server restarted (e.g. a dev reload), not that Young signed out. Not a secret. */
const BOOT_ID = randomBytes(6).toString('hex');

export interface RouteContext {store: TwitchTokenStore; directorKey?: string; env?: Record<string, string | undefined>; now?: () => number;getBroadcasterType?:()=>Promise<BroadcasterType|undefined>}
export const twitchRoutes: FastifyPluginAsync<RouteContext> = async (app, {store, directorKey, env = process.env, now = Date.now,getBroadcasterType}) => {
  let channelType:BroadcasterType|undefined;let checkedAt:number|undefined;let lookup:Promise<void>|undefined;let generation=0;
  const off=store.onChange(()=>{if(!store.status().connected){generation++;channelType=undefined;checkedAt=undefined;lookup=undefined;}});
  app.addHook('onClose',async()=>{off();});
  const states = new Map<string, number>();
  const requestedPort = Number(readProductEnv('COMICTOONS_WEB_PORT', env) ?? 4173);
  const webPort = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535 ? requestedPort : 4173;
  const returnTo = (result: string) => `http://localhost:${webPort}/ui.html#/connect?twitch=${result}`;
  app.addHook('onClose', async () => {states.clear();});
  // Silent route loggers prevent codes and state in callback query strings entering request logs.
  app.get('/auth/twitch/login', {logLevel: 'silent'}, async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    if (!isLocalRequest(req)) return reply.code(403).send({error: 'Start Twitch sign-in from this machine.'});
    if (!store.config.configured) return reply.code(503).send({error: 'Set COMICTOONS_TWITCH_CLIENT_ID, COMICTOONS_TWITCH_CLIENT_SECRET and COMICTOONS_TWITCH_REDIRECT_URI, then restart ComicToons.'});
    for (const [state, expiry] of states) if (expiry <= now()) states.delete(state);
    while (states.size >= 256) states.delete(states.keys().next().value!);
    const state = randomBytes(32).toString('hex');
    states.set(state, now() + 10 * 60_000);
    return reply.redirect(store.oauth.authorize(state));
  });
  app.get('/auth/twitch/callback', {logLevel: 'silent'}, async (req, reply) => {
    reply.header('Cache-Control', 'no-store').header('Referrer-Policy', 'no-referrer');
    const query = req.query as Record<string, unknown>;
    const state = typeof query.state === 'string' ? query.state : '';
    const expiry = states.get(state);
    states.delete(state);
    if (!expiry || expiry <= now()) return reply.code(400).send({error: 'Twitch sign-in expired or was already used. Start again.'});
    if (query.error === 'access_denied') return reply.redirect(returnTo('denied'));
    if (typeof query.code !== 'string' || !query.code || query.error) return reply.code(400).send({error: 'Twitch sign-in was not completed. Start again.'});
    try {
      await store.connect(query.code);
      return reply.redirect(returnTo('connected'));
    } catch { return reply.code(502).send({error: 'Twitch sign-in could not be completed. Start again.'}); }
  });
  app.get('/api/twitch/status', async (_req, reply) => {
    if(store.status().connected&&getBroadcasterType&&(checkedAt===undefined||now()-checkedAt>=60_000)){
      const current=generation;
      lookup??=(async()=>{try{const value=await getBroadcasterType();if(current===generation)channelType=value;}catch{/* Unknown is not Affiliate. */}finally{if(current===generation){checkedAt=now();lookup=undefined;}}})();
      await lookup;
    }
    return reply.header('Cache-Control','no-store').send({...store.status(),broadcaster_type:store.status().connected?channelType??null:null,requestedScopes:[...store.config.scopes],bootId:BOOT_ID});
  });
  app.post('/api/twitch/disconnect', {onRequest: directorGuard(directorKey)}, async () => {
    states.clear(); store.disconnect(); return store.status();
  });
};
