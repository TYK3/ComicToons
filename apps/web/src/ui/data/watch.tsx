import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react';
import type {WatchRole,WatchSnapshot} from '@comictoons/core';
import {directorHeaders} from './directorKey';
interface WatchContext {role:WatchRole;state?:WatchSnapshot;error:string;choose:(role:WatchRole)=>Promise<void>;action:(path:string,body?:unknown)=>Promise<WatchSnapshot>;refresh:()=>Promise<void>}
const Context=createContext<WatchContext|null>(null);
export function WatchProvider({children,active=true}:{children:ReactNode;active?:boolean}){
  const [role,setRole]=useState<WatchRole>(()=>sessionStorage.getItem('comictoons-role')==='viewer'?'viewer':'streamer');
  const [state,setState]=useState<WatchSnapshot>();const [error,setError]=useState('');const generation=useRef(0);
  const request=useCallback(async(path:string,body?:unknown)=>{
    const response=await fetch(`/api/watch${path}`,body===undefined?undefined:{method:'POST',headers:{'Content-Type':'application/json',...directorHeaders()},body:JSON.stringify(body)});
    const value=await response.json();if(!response.ok)throw new Error(typeof value.error==='string'?value.error:'The viewing session could not be reached.');return value as WatchSnapshot;
  },[]);
  const accept=useCallback((value:WatchSnapshot)=>{setState(value);setRole(value.role);sessionStorage.setItem('comictoons-role',value.role);},[]);
  const refresh=useCallback(async()=>{const version=generation.current;try{const value=await request('');if(version===generation.current){accept(value);setError('');}}catch{/* A new browser has no session until a role/action is selected. */}},[request,accept]);
  const action=useCallback(async(path:string,body:unknown={})=>{generation.current++;try{const value=await request(path,body);accept(value);setError('');return value;}catch(cause){const message=cause instanceof Error?cause.message:'Request failed.';setError(message);throw cause;}},[request,accept]);
  const choose=useCallback(async(next:WatchRole)=>{await action('/session',{role:next});},[action]);
  useEffect(()=>{if(!active)return;void refresh();const timer=setInterval(()=>void refresh(),2000);return()=>clearInterval(timer);},[refresh,active]);
  return <Context.Provider value={{role,state,error,choose,action,refresh}}>{children}</Context.Provider>;
}
export function useWatch(){const context=useContext(Context);if(!context)throw new Error('WatchProvider is missing.');return context;}
