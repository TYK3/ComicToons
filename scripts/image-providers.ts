import {mkdir,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {loadEnv} from '../apps/server/src/env.ts';
import {imageCredentials} from '../apps/server/src/pipeline/credentials.ts';
import {BasicImageGenerator,ImageSmokeError,imageCredentialStatus,BASIC_IMAGE_PROMPT} from '../apps/server/src/pipeline/provider-smoke.ts';

loadEnv();
const args=process.argv.slice(2);
if(args.some(arg=>!/^--(?:generate|provider=(?:gemini|pollinations|cloudflare)|slot=[123])$/.test(arg)))throw new Error('Use --generate, --provider=gemini|pollinations|cloudflare and/or --slot=1|2|3. Never pass keys as command arguments.');
const provider=args.find(a=>a.startsWith('--provider='))?.split('=')[1];
const slot=Number(args.find(a=>a.startsWith('--slot='))?.split('=')[1])||undefined;
const selected=imageCredentials().filter(c=>(!provider||c.provider===provider)&&(!slot||c.slot===slot));
console.table(imageCredentialStatus(process.env).filter(c=>(!provider||c.provider===provider)&&(!slot||c.slot===slot)));
if(!args.includes('--generate'))console.log('Configuration only; no network requests or generation charges. Run npm run images:test for one basic image per configured, distinct slot (up to nine images).');
else{
  if(!selected.length){console.log('No image credentials configured. Fill .env.images first. No provider request made.');process.exitCode=1;}
  else{
    const directory=resolve('artifacts/qa/image-providers',new Date().toISOString().replace(/[:.]/g,'-'));
    await mkdir(directory,{recursive:true});await writeFile(resolve(directory,'prompt.txt'),BASIC_IMAGE_PROMPT);
    const generator=new BasicImageGenerator();const results:Record<string,unknown>[]=[];
    for(const credential of selected){
      const start=Date.now();console.log(`Testing ${credential.provider} slot ${credential.slot}: one image, no retry or fallback.`);
      try{
        const output=await generator.generate(credential);const ext=output.mime==='image/png'?'png':output.mime==='image/jpeg'?'jpg':'webp';
        const file=`${credential.provider}-${credential.slot}.${ext}`;await writeFile(resolve(directory,file),output.image);
        results.push({provider:credential.provider,slot:credential.slot,status:'image-received',model:output.model,file,sha256:createHash('sha256').update(output.image).digest('hex'),ms:Date.now()-start,visualReview:'pending'});
      }catch(error){results.push({provider:credential.provider,slot:credential.slot,status:'failed',code:error instanceof ImageSmokeError?error.code:'local-output-failure',ms:Date.now()-start});process.exitCode=1;}
      await writeFile(resolve(directory,'report.json'),JSON.stringify({kind:'Fictional basic credential diagnostic; not real-stream reconstruction QA',results},null,2));
      console.log(`${credential.provider} slot ${credential.slot}: ${results.at(-1)!.status}${results.at(-1)!.code?` (${results.at(-1)!.code})`:''}`);
    }
    console.log(`Results saved in ${directory}. Inspect all images for faces, lettering and quality before calling visual QA passed.`);
  }
}
