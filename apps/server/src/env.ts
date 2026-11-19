import {readProductEnv} from '../../../packages/core/src/env.mjs';
import {resolve} from 'node:path';

// Loads the repo-root .env (git-ignored) if present. Values already in process.env always win,
// matching process.loadEnvFile's own precedence, so CI/host environment variables are never overridden.
export function loadEnv(path:string=resolve(import.meta.dirname,'../../../.env')):void {
  try { process.loadEnvFile(path); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
}

/** Explicit test endpoints are loopback-only unless remote overrides are deliberately enabled. */
export function twitchEndpoints(env:Record<string,string|undefined>=process.env){
  const read=(name:string,protocols:string[])=>{
    const raw=readProductEnv(name,env);if(raw===undefined||raw==='')return undefined;
    try{
      const url=new URL(raw);
      if(!protocols.includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error();
      if(!['localhost','127.0.0.1','[::1]','::1'].includes(url.hostname)&&readProductEnv('COMICTOONS_TWITCH_ALLOW_REMOTE_OVERRIDES',env)!=='1')throw new Error();
      return url;
    }catch{throw new Error(`Invalid ${name}`);}
  };
  const auth=read('COMICTOONS_TWITCH_AUTH_BASE_URL',['http:','https:']);
  if(auth&&!['','/','/oauth2','/oauth2/'].includes(auth.pathname))throw new Error('Invalid COMICTOONS_TWITCH_AUTH_BASE_URL');
  const helix=read('COMICTOONS_TWITCH_HELIX_BASE_URL',['http:','https:']);
  const websocket=read('COMICTOONS_TWITCH_EVENTSUB_WS_URL',['ws:','wss:']);
  const irc=read('COMICTOONS_TWITCH_IRC_URL',['irc:','ircs:']);
  if(irc&&(!['localhost','127.0.0.1','[::1]','::1'].includes(irc.hostname)||!irc.port||!['','/'].includes(irc.pathname)))throw new Error('Invalid COMICTOONS_TWITCH_IRC_URL');
  return {authBaseUrl:auth?.origin,helixBaseUrl:helix?.href.replace(/\/$/,''),eventSubUrl:websocket?.href,ircUrl:irc?.href};
}
