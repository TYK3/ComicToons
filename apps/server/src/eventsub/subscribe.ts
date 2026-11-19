import type {TwitchAuthProvider} from './types.ts';
import type {SubscriptionCreator} from './messages.ts';

// POST https://api.twitch.tv/helix/eventsub/subscriptions with a user access token and
// transport {method:'websocket',session_id} (https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription,
// checked 31 Oct 2026): 202 Accepted; 401 bad token; 403 missing scopes; 409 already exists;
// 429 too many. Rate limits: https://dev.twitch.tv/docs/api/guide/#twitch-rate-limits (Ratelimit-Reset is epoch seconds).
// Only this one EventSub call lives here; the rest of Helix belongs to twitch-api/ (T3b).
export const HELIX_URL='https://api.twitch.tv/helix';

export class EventSubSubscribeError extends Error {
  constructor(readonly status:number,message:string,readonly detail?:string){super(message);this.name='EventSubSubscribeError';}
}

export interface SubscribeOptions {
  auth:TwitchAuthProvider;
  fetch?:typeof fetch;
  /** Helix base. The Twitch CLI mock WebSocket server takes subscriptions at http://127.0.0.1:8080. */
  baseUrl?:string;
  sleep?:(ms:number)=>Promise<void>;
  now?:()=>number;
  /** Longest a 429 may hold the call before giving up. */
  maxRateLimitWaitMs?:number;
}

const wait=(ms:number)=>new Promise<void>(resolve=>{setTimeout(resolve,ms).unref?.();});

/** Never puts the token in an error message or log line. */
export function createSubscriptionCreator(options:SubscribeOptions):SubscriptionCreator {
  const doFetch=options.fetch??globalThis.fetch;const sleep=options.sleep??wait;const now=options.now??(()=>Date.now());
  const url=`${(options.baseUrl??HELIX_URL).replace(/\/$/,'')}/eventsub/subscriptions`;
  return {async createEventSubSubscription(input){
    let refreshed=false,waited=false;
    for(;;){
      const auth=await options.auth.getAuth();
      if(!auth)throw new EventSubSubscribeError(401,'Sign in to Twitch first.');
      const response=await doFetch(url,{method:'POST',headers:{Authorization:`Bearer ${auth.accessToken}`,'Client-Id':auth.clientId,'Content-Type':'application/json'},
        body:JSON.stringify({type:input.type,version:input.version,condition:input.condition,transport:{method:'websocket',session_id:input.sessionId}})});
      const body=await response.json().catch(()=>undefined) as {data?:{id?:string}[];id?:string;message?:string}|undefined;
      if(response.status===202||response.status===200){const id=body?.data?.[0]?.id;if(!id)throw new EventSubSubscribeError(response.status,'Twitch accepted the subscription but sent no id.');return {id};}
      // Already subscribed for this type and condition: that is the state we wanted.
      if(response.status===409)return {id:body?.data?.[0]?.id??body?.id??'existing'};
      if(response.status===401&&!refreshed){refreshed=true;await options.auth.refresh();continue;}
      if(response.status===429&&!waited){
        const reset=Number(response.headers.get('Ratelimit-Reset'));
        const delay=Number.isFinite(reset)&&reset>0?Math.max(0,reset*1000-now()):1000;
        if(delay<=(options.maxRateLimitWaitMs??60_000)){waited=true;await sleep(delay);continue;}
      }
      const detail=typeof body?.message==='string'?body.message.slice(0,200):'';
      const reason=response.status===401?'Twitch sign-in expired; sign in again.':response.status===403?'The Twitch sign-in is missing a permission this event needs.':response.status===429?'Twitch is rate limiting; try again shortly.':`Twitch refused the subscription (${response.status}).`;
      // Twitch's own text stays on .detail (for logs), never in the message the status shows.
      throw new EventSubSubscribeError(response.status,reason,detail||undefined);
    }
  }};
}
