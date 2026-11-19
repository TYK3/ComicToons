import {imageCredentials,type ImageCredential,type BasicProvider} from './credentials.ts';
import {imageMime} from '../scenes/providers.ts';

export const BASIC_IMAGE_PROMPT='Credential diagnostic only: draw one full-colour four-panel comic page about an original adult gardener finding a small friendly robot in a sunny garden. Chronological setup, discovery, greeting, happy resolution. Natural skin and clothing colours, vivid plants. One readable speech balloon saying READY! inside the third illustration, placed in empty sky. Keep every face, eyes, mouth, hands and key action fully visible, never covered by balloons, overlays, effects or crops. No logos, celebrities, existing characters or other text.';
export class ImageSmokeError extends Error{constructor(readonly code:string,message:string){super(message);}}
export function credentialIssue(c:ImageCredential){
  if(c.key.length<12||c.key.length>512||/\s/.test(c.key))return 'invalid-key-format';
  if(c.provider==='pollinations'&&c.key.startsWith('pk_'))return 'secret-key-required';
  if(c.provider==='cloudflare'&&!/^[a-f0-9]{32}$/i.test(c.accountId??''))return 'matching-account-id-required';
}
export function imageCredentialStatus(env:Record<string,string|undefined>){
  const credentials=imageCredentials(env);
  return (['gemini','pollinations','cloudflare'] as BasicProvider[]).flatMap(provider=>[1,2,3].map(slot=>{
    const c=credentials.find(c=>c.provider===provider&&c.slot===slot);
    return {provider,slot,status:c?(credentialIssue(c)??'ready'):'empty-or-duplicate'};
  }));
}
/** One request, one selected account, fixed provider endpoints. Never logs keys or raw errors. */
export class BasicImageGenerator{
  constructor(private fetchImpl:typeof fetch=fetch){}
  async generate(c:ImageCredential):Promise<{image:Buffer;mime:string;model:string}>{
    const issue=credentialIssue(c);if(issue)throw new ImageSmokeError(issue,'Credential configuration needs correction.');
    let url:string,init:RequestInit,model:string;
    if(c.provider==='gemini'){
      model='gemini-3.1-flash-image';url=`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
      init={method:'POST',headers:{'x-goog-api-key':c.key,'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:BASIC_IMAGE_PROMPT}]}],generationConfig:{responseModalities:['TEXT','IMAGE'],imageConfig:{aspectRatio:'2:3',imageSize:'1K'}}})};
    }else if(c.provider==='cloudflare'){
      model='@cf/black-forest-labs/flux-1-schnell';url=`https://api.cloudflare.com/client/v4/accounts/${c.accountId}/ai/run/${model}`;
      init={method:'POST',headers:{Authorization:`Bearer ${c.key}`,'Content-Type':'application/json'},body:JSON.stringify({prompt:BASIC_IMAGE_PROMPT,steps:4})};
    }else{
      model='black-forest-labs/flux.1-schnell';url=`https://gen.pollinations.ai/image/${encodeURIComponent(BASIC_IMAGE_PROMPT)}?model=${encodeURIComponent(model)}&width=512&height=768`;
      init={headers:{Authorization:`Bearer ${c.key}`}};
    }
    let response:Response,image:Buffer;
    try{
      response=await this.fetchImpl(url,{...init,signal:AbortSignal.timeout(180000)});
      if(!response.ok)throw new ImageSmokeError(`http-${response.status}`,[401,403].includes(response.status)?'Key or account access rejected.':[402,429].includes(response.status)?'Credits, quota or rate limit prevented generation.':`Provider request failed (HTTP ${response.status}).`);
      if(c.provider==='gemini'){
        const data=await response.json() as {candidates?:{content?:{parts?:{inlineData?:{data?:string}}[]}}[]};
        image=Buffer.from(data.candidates?.[0]?.content?.parts?.find(p=>p.inlineData?.data)?.inlineData?.data??'','base64');
      }else if(c.provider==='cloudflare'){
        const data=await response.json() as {result?:{image?:string}};image=Buffer.from(data.result?.image??'','base64');
      }else image=Buffer.from(await response.arrayBuffer());
    }catch(error){if(error instanceof ImageSmokeError)throw error;throw new ImageSmokeError('transport-or-format','Provider transport, timeout or response-format failure.');}
    const mime=imageMime(image);if(image.length<32||image.length>25000000||!mime)throw new ImageSmokeError('not-an-image','Provider did not return a usable PNG, JPEG or WebP.');
    return {image,mime,model};
  }
}
