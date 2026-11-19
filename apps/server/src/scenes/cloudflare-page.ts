import sharp from 'sharp';
import type {ScenePlan,SourceChat,AuthoredLettering} from '@comictoons/core';

const escape=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
export function panelLettering(plan:ScenePlan,chat:SourceChat[],index:number,authored?:AuthoredLettering){
  const panel=plan.panels[index]!;
  const lines:string[]=[];
  if(index===0&&authored)lines.push(`${authored.attribution}: ${authored.text}`);
  else if((panel.narration.trim()||panel.description).trim())lines.push((panel.narration.trim()||panel.description).trim());
  for(const id of panel.chatIds){const quote=chat.find(q=>q.id===id);if(!quote)throw Error('Selected chat evidence is missing.');lines.push(`Chat: ${quote.text}`);}
  return lines;
}
function wrap(text:string,max=40){
  const lines:string[]=[];let line='';
  for(const word of text.split(/\s+/)){if(word.length>max)throw Error('Lettering contains a word too long to fit safely.');if(line&&`${line} ${word}`.length>max){lines.push(line);line=word;}else line=line?`${line} ${word}`:word;}
  if(line)lines.push(line);return lines;
}
export function validatePageLettering(plan:ScenePlan,chat:SourceChat[],authored?:AuthoredLettering){
  const texts=plan.panels.map((_,i)=>panelLettering(plan,chat,i,authored).flatMap(text=>wrap(text)));
  if(texts.some(lines=>lines.length>14))throw Error('Exact lettering exceeds the panel space; shorten it before generating.');
  return texts;
}
/** Dedicated lettering space is part of every illustrated panel; art is contained,
 * never cropped or covered. Excess lettering fails rather than truncating words. */
export async function composeCloudflarePage(images:Buffer[],plan:ScenePlan,chat:SourceChat[],authored?:AuthoredLettering){
  if(images.length!==plan.panels.length||images.length<4||images.length>6)throw Error('A complete four to six panel page is required.');
  const panelWidth=512,artHeight=384,fontSize=20,lineHeight=26;
  validatePageLettering(plan,chat,authored);
  const groups=images.map((_,i)=>panelLettering(plan,chat,i,authored).map(text=>wrap(text)));
  const letteringHeight=Math.max(96,...groups.map(items=>items.reduce((height,lines)=>height+lines.length*lineHeight+36,24)));
  const panelHeight=artHeight+letteringHeight,rows=Math.ceil(images.length/2);
  const panels=await Promise.all(images.map(async(image,i)=>{
    const art=await sharp(image).resize({width:panelWidth-16,height:artHeight-12,fit:'contain',background:'#fff9ed'}).png().toBuffer();
    let y=artHeight+12;
    const text=groups[i]!.map((lines,groupIndex)=>{
      const balloon=groupIndex>0||(i===0&&!!authored),height=lines.length*lineHeight+16;
      const shape=`<rect x="18" y="${y}" width="476" height="${height}" rx="${balloon?20:4}" fill="${balloon?'#ffffff':'#fff0bd'}" stroke="#171717" stroke-width="2"/>${balloon?`<path d="M 62 ${y+height-1} L 74 ${y+height+13} L 88 ${y+height-1}" fill="#ffffff" stroke="#171717" stroke-width="2"/>`:''}`;
      const label=`<text font-family="Arial,sans-serif" font-size="${fontSize}" fill="#171717">${lines.map((line,n)=>`<tspan x="30" y="${y+26+n*lineHeight}">${escape(line)}</tspan>`).join('')}</text>`;
      y+=height+20;return shape+label;
    }).join('');
    const overlay=Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${panelHeight}"><rect x="4" y="4" width="504" height="${panelHeight-8}" rx="4" fill="none" stroke="#171717" stroke-width="5"/>${text}</svg>`);
    const panel=await sharp({create:{width:panelWidth,height:panelHeight,channels:3,background:'#fff9ed'}}).composite([{input:art,left:8,top:8},{input:overlay,left:0,top:0}]).png().toBuffer();
    return {input:panel,left:(i%2)*panelWidth,top:Math.floor(i/2)*panelHeight};
  }));
  return sharp({create:{width:1024,height:rows*panelHeight,channels:3,background:'#fff9ed'}}).composite(panels).png().toBuffer();
}
