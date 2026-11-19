import type {GenerationProvider} from '@comictoons/core';
import type {ProviderConfig} from '../scenes/providers.ts';

export type BasicProvider='gemini'|'pollinations'|'cloudflare';
export interface ImageCredential {provider:BasicProvider;slot:number;key:string;accountId?:string}
export function imageCredentials(env:Record<string,string|undefined>=process.env):ImageCredential[]{
  const rows:ImageCredential[]=[];
  for(const provider of ['gemini','pollinations','cloudflare'] as const){
    const seen=new Set<string>();
    for(const slot of [1,2,3]){
      const suffix=slot===1?'':`_${slot}`;
      const name=provider==='gemini'?'GEMINI_API_KEY':provider==='pollinations'?'POLLINATIONS_API_KEY':'CLOUDFLARE_API_TOKEN';
      const key=env[name+suffix]?.trim();if(!key||seen.has(key))continue;seen.add(key);
      rows.push({provider,slot,key,...(provider==='cloudflare'?{accountId:env[`CLOUDFLARE_ACCOUNT_ID${suffix}`]?.trim()||undefined}:{})});
    }
  }
  return rows;
}
/** Select one explicitly configured reference provider; never fall through to another provider. */
export function referenceDefaults(env:Record<string,string|undefined>):ProviderConfig[]{
  if(env.COMICTOONS_IMAGE_PROVIDER==='source')return [{provider:'source',model:'source-frames',key:'local-source-frame-mode'}];
  const selected=env.COMICTOONS_IMAGE_PROVIDER?.trim();if(selected&&!['openai','gemini','pollinations','cloudflare'].includes(selected))return [];
  if(selected==='cloudflare'){
    // One explicitly chosen account; never rotate accounts after a quota failure.
    const slot=Number(env.CLOUDFLARE_REFERENCE_SLOT||'1');if(![1,2,3].includes(slot))return [];
    const credential=imageCredentials(env).find(c=>c.provider==='cloudflare'&&c.slot===slot);
    if(!credential?.accountId||!/^[a-f0-9]{32}$/i.test(credential.accountId))return [];
    return [{provider:'cloudflare',model:env.CLOUDFLARE_REFERENCE_MODEL||'@cf/black-forest-labs/flux-2-klein-9b',key:credential.key,accountId:credential.accountId}];
  }
  const provider:GenerationProvider=env.COMICTOONS_IMAGE_PROVIDER==='pollinations'?'pollinations':env.COMICTOONS_IMAGE_PROVIDER==='gemini'?'gemini':env.COMICTOONS_IMAGE_PROVIDER==='openai'?'openai':env.OPENAI_API_KEY?'openai':'gemini';
  if(provider==='openai')return env.OPENAI_API_KEY?[{provider,model:env.OPENAI_IMAGE_MODEL||'gpt-image-1.5',key:env.OPENAI_API_KEY}]:[];
  return imageCredentials(env).filter(c=>c.provider===provider).map(c=>({provider,model:provider==='pollinations'?(env.POLLINATIONS_REFERENCE_MODEL||'google/gemini-3.1-flash-image'):(env.GEMINI_IMAGE_MODEL||'gemini-3.1-flash-image'),key:c.key}));
}
