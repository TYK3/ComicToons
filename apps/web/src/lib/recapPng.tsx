import {renderToStaticMarkup} from 'react-dom/server';
import {panelSourceLabel} from '@comictoons/core';
import {MangaPage} from '../components/MangaPage';
import type {StudioState} from '../types';
import {freezePngSheet} from './pngSheet';

const displayFont=new URL('../../../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-normal.woff2',import.meta.url).href;
const italicFont=new URL('../../../../node_modules/@fontsource/barlow-condensed/files/barlow-condensed-latin-700-italic.woff2',import.meta.url).href;
const bodyFont=new URL('../../../../node_modules/@fontsource/dm-sans/files/dm-sans-latin-400-normal.woff2',import.meta.url).href;

async function dataUrl(url:string) {
  const response=await fetch(url,{signal:AbortSignal.timeout(20_000)});
  if(!response.ok)throw new Error('An illustration or font could not load. Try the PNG download again.');
  const blob=await response.blob();
  return new Promise<string>((resolve,reject)=>{
    const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('An export asset could not be read.'));reader.readAsDataURL(blob);
  });
}

/** Draw the complete approved issue locally. No server PNG/end endpoint is used. */
export async function recapPng(state:StudioState):Promise<{blob:Blob;filename:string}> {
  if(!state.panels.length)throw new Error('Approve a panel before downloading your recap.');
  const savedId=state.recapUrl?.match(/^\/(?:recap|r)\/([a-z0-9-]+)$/)?.[1];
  if(!savedId)throw new Error('Save the recap before downloading its PNG.');
  const snapshot=structuredClone(state);
  const images=new Map<string,Promise<string>>();
  const embed=(url:string)=>{
    if(!/^\/art\/generated\/panel-[a-z0-9-]+\.(?:png|webp)$/.test(url))throw new Error('This illustration cannot be exported locally.');
    if(!images.has(url))images.set(url,dataUrl(url));
    return images.get(url)!;
  };
  const [display,italic,body]=await Promise.all([dataUrl(displayFont),dataUrl(italicFont),dataUrl(bodyFont)]);
  const panels=await Promise.all(snapshot.panels.map(async panel=>({...panel,imageUrl:await embed(panel.imageUrl),
    storyBeats:panel.storyBeats?await Promise.all(panel.storyBeats.map(async beat=>({...beat,imageUrl:await embed(beat.imageUrl)}))):undefined})));
  const width=1080;
  const markup=renderToStaticMarkup(<div className="recap-png-sheet" style={{width,padding:28,background:'#fff',color:'#111',fontFamily:'DM Sans, sans-serif'}}>
    <style>{'*{box-sizing:border-box}.png-title{font:700 40px/1.1 "Barlow Condensed",sans-serif;margin:0 0 18px;overflow-wrap:anywhere}.png-source{font:400 14px/1.5 "DM Sans",sans-serif;margin:0 0 14px}'}</style>
    <h1 className="png-title">{snapshot.issueTitle || snapshot.streamTitle}</h1><p className="png-source">COMICTOONS · {panelSourceLabel(snapshot.panels)}</p>
    <MangaPage panels={panels} theme={snapshot.mangaTheme}/>
  </div>);
  const measure=document.createElement('iframe');measure.setAttribute('aria-hidden','true');measure.setAttribute('data-png-measure','');measure.tabIndex=-1;measure.inert=true;measure.sandbox.add('allow-same-origin');
  Object.assign(measure.style,{position:'fixed',left:'-20000px',top:'0',width:`${width}px`,pointerEvents:'none'});
  // All markup is React-escaped and all image/font resources are local data URLs.
  document.body.append(measure);
  const frame=measure.contentDocument!;const view=measure.contentWindow!;
  frame.open();frame.write(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;width:${width}px;background:#fff;color:#111;color-scheme:light}*,*::before,*::after{box-sizing:border-box}</style></head><body>${markup}</body></html>`);frame.close();
  const faces=[new FontFace('ComicToonsExportDisplay',`url('${display}')`,{weight:'700'}),new FontFace('ComicToonsExportDisplay',`url('${italic}')`,{weight:'700',style:'italic'}),new FontFace('ComicToonsExportBody',`url('${body}')`,{weight:'400'})];
  const frameFaces=[new FontFace('Barlow Condensed',`url('${display}')`,{weight:'700'}),new FontFace('Barlow Condensed',`url('${italic}')`,{weight:'700',style:'italic'}),new FontFace('DM Sans',`url('${body}')`,{weight:'400'})];
  try {
    await Promise.all(faces.map(async face=>{await face.load();document.fonts.add(face);}));
    await Promise.all(frameFaces.map(async face=>{await face.load();frame.fonts.add(face);}));
    const loaded=await Promise.all([frame.fonts.load('700 40px "Barlow Condensed"'),frame.fonts.load('400 14px "DM Sans"')]);
    if(loaded.some(fonts=>!fonts.length))throw new Error('The PNG font could not load. Try again.');
    await frame.fonts.ready;await Promise.all([...frame.querySelectorAll('img')].map(image=>image.decode()));
    const sheet=frame.querySelector<HTMLElement>('.recap-png-sheet')!;
    const height=Math.ceil(sheet.getBoundingClientRect().height);
    if(height<1||height>16384)throw new Error('This issue is too tall for one browser PNG. Download its individual pages from the saved recap.');
    const frozen=freezePngSheet(sheet,view);
    const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${new XMLSerializer().serializeToString(frozen)}</foreignObject></svg>`;
    const image=new Image();image.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');if(!context)throw new Error('Your browser could not create a PNG. Try again.');
    context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(image,0,0);
    const blob=await new Promise<Blob>((resolve,reject)=>canvas.toBlob(value=>value?resolve(value):reject(new Error('Your browser could not save the PNG. Try again.')),'image/png'));
    return {blob,filename:`comictoons-recap-${savedId}.png`};
  } finally {for(const face of frameFaces)frame.fonts.delete(face);measure.remove();for(const face of faces)document.fonts.delete(face);}
}

export async function downloadRecapPng(state:StudioState) {
  const {blob,filename}=await recapPng(state);
  const url=URL.createObjectURL(blob);const link=document.createElement('a');link.href=url;link.download=filename;
  document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),30_000);
}
