import {createContext,useContext,useState,Fragment,type ReactNode} from 'react';
import type {ComicToonsAdapter} from './adapter';
import {AdapterProvider} from './store';
import {SampleStudioAdapter} from './sampleStudio';
import {liveWorkspace} from './workspace';
import {useRoute,routeWorkspace,href,type Workspace} from '../router';

export const STUDIO_MODE_KEY='comictoons-studio-mode-v1';
export const LIVE_CHANNEL_KEY='comictoons-studio-live-channel-v1';
const ModeContext=createContext<{mode:Workspace;setMode:(mode:Workspace)=>void}>({mode:'sample',setMode:()=>{}});
export const useStudioMode=()=>useContext(ModeContext);
const samples=new WeakMap<ComicToonsAdapter,SampleStudioAdapter>();
const liveViews=new WeakMap<ComicToonsAdapter,ComicToonsAdapter>();
const broadcasts=new WeakMap<ComicToonsAdapter,ComicToonsAdapter>();
export function StudioSessionProvider({adapter,children}:{adapter:ComicToonsAdapter;children:ReactNode}){
  if(!samples.has(adapter))samples.set(adapter,new SampleStudioAdapter());
  if(!liveViews.has(adapter))liveViews.set(adapter,liveWorkspace(adapter));
  if(!broadcasts.has(adapter))broadcasts.set(adapter,liveWorkspace(adapter,true));
  const route=useRoute();
  const [preferred,setPreferred]=useState<Workspace>(()=>{try{return localStorage.getItem(STUDIO_MODE_KEY)==='live'?'live':'sample';}catch{return 'sample';}});
  const mode=routeWorkspace(route,preferred);
  const setMode=(next:Workspace)=>{
    setPreferred(next);try{localStorage.setItem(STUDIO_MODE_KEY,next);}catch{/* this window */}
    // Other open workspace tabs keep their own URL and data context.
    location.hash=href('/studio',{workspace:next}).slice(1);
  };
  const workspace=['studio','director','overlay','audience','catchup','output','flow','issues','recap','book','series','read'].includes(route.name);
  const selected=workspace?(mode==='sample'?samples.get(adapter)!:route.name==='studio'?liveViews.get(adapter)!:broadcasts.get(adapter)!):adapter;
  return <ModeContext.Provider value={{mode,setMode}}><AdapterProvider adapter={selected}><Fragment key={mode}>{children}</Fragment></AdapterProvider></ModeContext.Provider>;
}
