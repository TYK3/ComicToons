import type {TwitchAuthProvider} from '../eventsub/types.ts';
import type {FetchLike} from '../twitch-api/types.ts';
import {CaptureError} from './capture.ts';
export function liveSourceCheck({auth,baseUrl='https://api.twitch.tv/helix',fetchImpl=fetch}:{auth:TwitchAuthProvider;baseUrl?:string;fetchImpl?:FetchLike}){
  return async(channel:string)=>{
    try{
      const credentials=await auth.getAuth();if(!credentials)throw Error();
      const url=new URL(`${baseUrl.replace(/\/$/,'')}/streams`);url.searchParams.set('user_login',channel);
      const request={method:'GET',headers:{Authorization:`Bearer ${credentials.accessToken}`,'Client-Id':credentials.clientId},signal:AbortSignal.timeout(10000)};
      const response=await fetchImpl(url,request);
      if(!response.ok)throw Error();const body=JSON.parse(await response.text()) as {data?:{user_login?:string;type?:string}[]};
      if(!Array.isArray(body.data))throw Error();return body.data.some(stream=>stream.user_login?.toLowerCase()===channel.toLowerCase()&&stream.type==='live');
    }catch{throw new CaptureError('status','Twitch live status could not be verified. No archived footage was substituted. Try again shortly.');}
  };
}
