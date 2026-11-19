import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,readdir,rename,stat,unlink,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {DEFAULT_MANGA_THEME,fixtures,mangaThemes,resolveMangaTheme,type MangaTheme} from '@comictoons/core';
import type {StudioState} from './studio.ts';

function canonical(value:unknown):unknown {
  if(Array.isArray(value))return value.map(canonical);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,item])=>item!==undefined).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,item])=>[key,canonical(item)]));
  return value;
}
/** Content signature fences stale state updates and identifies stale artifacts. */
export function recapSignature(state:StudioState) {
  return createHash('sha256').update(JSON.stringify(canonical({version:1,issueTitle:state.issueTitle,streamTitle:state.streamTitle,style:state.style,mangaTheme:resolveMangaTheme(state.mangaTheme),panels:state.panels}))).digest('hex');
}

/** A curated fixture or a live IRC session is the story; lettering and palette
 * are revisions of that story. Legacy sources fall back to immutable frame ids. */
function storySignature(state:StudioState) {
  const sessions=new Set(state.panels.map(panel=>/^irc-([a-f0-9-]{36})-\d+$/.exec(panel.id)?.[1]));
  const identity=fixtures.some(fixture=>fixture.id===state.fixtureId)?{sample:state.fixtureId}
    :state.fixtureId==='twitch'&&sessions.size===1&&!sessions.has(undefined)?{live:[...sessions][0]}
    :{source:state.fixtureId,frames:state.panels.map(panel=>panel.id).sort()};
  return createHash('sha256').update(JSON.stringify(canonical({version:2,identity}))).digest('hex');
}

/** Earlier generated ids redundantly included the filename's recap- prefix.
 * Keep those URLs as read aliases without changing the content signature. */
function recapId(id:string){return /^recap-[a-f0-9]{32}$/.test(id)?id.slice(6):id;}
function namedSnapshot(snapshot:StudioState):StudioState {
  const id=snapshot.recapUrl?.match(/^\/(?:recap|r)\/([a-z0-9-]+)$/)?.[1];
  return {...snapshot,recapUrl:id?`/recap/${recapId(id)}`:snapshot.recapUrl};
}

const outputDirectories=new Map<string,string>();
/** MEM-1a #9: recent first-use order; the oldest name is forgotten past 1000 (read() records it again). */
const MAX_OUTPUT_DIRECTORIES=1000;
function rememberDirectory(id:string,directory:string){outputDirectories.delete(id);outputDirectories.set(id,directory);while(outputDirectories.size>MAX_OUTPUT_DIRECTORIES)outputDirectories.delete(outputDirectories.keys().next().value!);}
export async function readEditionTitle(id:string){const directory=outputDirectories.get(recapId(id));if(!directory)return undefined;try{return JSON.parse(await readFile(resolve(directory,'edition.json'),'utf8')).title as string;}catch{return undefined;}}
export async function writeEditionTitle(id:string,title:string){const directory=outputDirectories.get(recapId(id));if(!directory)throw new Error('Save the recap before naming its edition.');await writeFile(resolve(directory,'edition.json'),JSON.stringify({title}));}

/** An explicit Look must be one the product offers, or a legacy id (ink, noir, pop), which maps
 * to festival; a genuinely unknown one is an error, never a silent fallback. Without one, the
 * state's own Look is used (also resolved, so no theme or a legacy 'ink' becomes festival). */
const LEGACY_LOOKS=new Set(['ink','noir','pop']);
export function chooseLook(state:{mangaTheme?:unknown},look?:string):MangaTheme {
  if(look===undefined)return resolveMangaTheme(state.mangaTheme);
  if(LEGACY_LOOKS.has(look))return DEFAULT_MANGA_THEME;
  if(!mangaThemes.some(theme=>theme.id===look))throw new Error('Unknown Look.');
  return look as MangaTheme;
}

export class RecapStore {
  private records=new Map<string,StudioState>();
  private pending=new Map<string,Promise<StudioState>>();
  /** MEM-1a #9: disk is the source of truth, so only the most recently used recaps stay in memory. */
  constructor(private directory:string,private maxRecords=20){}
  private remember(id:string,snapshot:StudioState){this.records.delete(id);this.records.set(id,snapshot);while(this.records.size>this.maxRecords)this.records.delete(this.records.keys().next().value!);}
  path(id:string){if(!/^[a-z0-9-]+$/.test(id))throw new Error('Invalid issue address.');return resolve(this.directory,recapId(id));}
  async latest():Promise<StudioState|undefined>{
    const entries=await readdir(this.directory,{withFileTypes:true}).catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT')return [];
      throw error;
    });
    const candidates=await Promise.all(entries.filter(entry=>entry.isDirectory()&&/^[a-z0-9-]+$/.test(entry.name)).map(async entry=>{
      try{return {id:entry.name,modified:(await stat(resolve(this.directory,entry.name,'recap.json'))).mtimeMs};}catch{return undefined;}
    }));
    for(const candidate of candidates.filter(item=>item!==undefined).sort((a,b)=>b.modified-a.modified||a.id.localeCompare(b.id))){
      try{return {...await this.read(candidate.id),recapUrl:`/recap/${recapId(candidate.id)}`};}catch{/* Ignore an incomplete older export. */}
    }
    return undefined;
  }
  async read(id:string):Promise<StudioState> {
    id=recapId(id);
    rememberDirectory(id,this.path(id));
    const cached=this.records.get(id);if(cached){this.remember(id,cached);return structuredClone(cached);}
    const data=await readFile(resolve(this.path(id),'recap.json'),'utf8').catch(error=>{
      if((error as NodeJS.ErrnoException).code==='ENOENT'&&/^[a-f0-9]{32}$/.test(id))return readFile(resolve(this.directory,`recap-${id}`,'recap.json'),'utf8');
      throw error;
    });
    const snapshot=namedSnapshot(JSON.parse(data) as StudioState);
    this.remember(id,snapshot);return structuredClone(snapshot);
  }
  async write(id:string,snapshot:StudioState) {
    id=recapId(id);snapshot=namedSnapshot(snapshot);
    const directory=this.path(id);await mkdir(directory,{recursive:true});
    const temporary=resolve(directory,`recap-${randomUUID()}.tmp`);
    try{await writeFile(temporary,JSON.stringify(snapshot,null,2));await rename(temporary,resolve(directory,'recap.json'));}
    catch(error){await unlink(temporary).catch(()=>{});throw error;}
    this.remember(id,structuredClone(snapshot));
  }
  /** Saves the story once; the first persisted approval keeps its panels and captions. The
   * Look is not part of that lock: a save in another Look (the state's current Look, or an
   * explicit `look`) revises the saved issue's Look, so the recap and the export follow the
   * Look the director picked last. Share and page images drawn in the old Look are dropped
   * from the snapshot because they no longer match it; the next export redraws them. */
  async save(state:StudioState,options:{look?:string}={}):Promise<{id:string;snapshot:StudioState;directory:string}> {
    if(!state.panels.length)throw new Error('Approve at least one panel before saving the recap.');
    const look=chooseLook(state,options.look);
    const current={...structuredClone(state),mangaTheme:look};const story=storySignature(current);
    let id=story.slice(0,32);
    const candidate=current.recapUrl?.match(/^\/(?:recap|r)\/([a-z0-9-]+)$/)?.[1];
    if(candidate){const saved=await this.read(candidate).catch(()=>undefined);if(saved&&storySignature(saved)===story)id=recapId(candidate);}
    // Serialize saves for the story so the first persisted approval wins (Look revisions apply in order).
    const previous=this.pending.get(id);
    const pending=(async()=>{
        await previous?.catch(()=>{});
        const existing=await this.read(id).catch(()=>undefined);
        if(existing&&storySignature(existing)!==story)throw new Error('The saved recap does not match this story.');
        if(existing){
          if(resolveMangaTheme(existing.mangaTheme)===look)return existing;
          const revised:StudioState=JSON.parse(JSON.stringify({...existing,mangaTheme:look,shareUrl:undefined,pageUrls:undefined}));
          await this.write(id,revised);return revised;
        }
        const snapshot:StudioState=JSON.parse(JSON.stringify({...current,status:'saved',pendingPanels:[],recapUrl:`/recap/${id}`,shareUrl:undefined,pageUrls:undefined}));
        await this.write(id,snapshot);return snapshot;
      })();
    this.pending.set(id,pending);
    void pending.finally(()=>{if(this.pending.get(id)===pending)this.pending.delete(id);}).catch(()=>{});
    return {id,snapshot:structuredClone(await pending),directory:this.path(id)};
  }
}
