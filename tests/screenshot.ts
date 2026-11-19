import {writeFile} from 'node:fs/promises';
import type {Page} from '@playwright/test';

/** Cost-bounded evidence: requested viewport rendered, JPEG output capped at 1280px. */
export async function capture(page:Page,options:{path:string;fullPage?:boolean;animations?:'disabled'|'allow';omitBackground?:boolean}){
  const pixels=await page.screenshot({type:'jpeg',quality:60,animations:options.animations??'disabled',fullPage:false});
  const base64=await page.evaluate(async encoded=>{
    const image=new Image();image.src=`data:image/jpeg;base64,${encoded}`;await image.decode();
    const scale=Math.min(1,1280/image.width);const canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);
    canvas.getContext('2d')!.drawImage(image,0,0,canvas.width,canvas.height);
    return canvas.toDataURL('image/jpeg',.6).split(',')[1]!;
  },pixels.toString('base64'));
  await writeFile(options.path.replace(/\.png$/,'.jpg'),Buffer.from(base64,'base64'));
}
