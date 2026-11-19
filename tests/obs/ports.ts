import {readProductEnv} from '../../packages/core/src/env.mjs';

export function obsPorts(env:Record<string,string|undefined>=process.env){
  const port=(name:string,fallbackName:string,fallback:number)=>{
    const raw=readProductEnv(name,env)??readProductEnv(fallbackName,env);
    const value=raw===undefined?fallback:Number(raw);
    if(!Number.isInteger(value)||value<1024||value>65535)throw new Error(`Invalid ${name}: expected an integer port from 1024 to 65535.`);
    return value;
  };
  const api=port('COMICTOONS_OBS_API_PORT','COMICTOONS_TWITCH_TEST_APP_PORT',3102);
  const web=port('COMICTOONS_OBS_WEB_PORT','COMICTOONS_TWITCH_TEST_FAKE_PORT',4102);
  if(api===web)throw new Error('OBS API and web ports must differ.');
  return {api,web};
}
