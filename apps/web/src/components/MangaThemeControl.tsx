import {useEffect,useRef} from 'react';
import {mangaThemes,resolveMangaTheme,type MangaTheme} from '@comictoons/core';
import type {Studio} from '../hooks/useStudio';

const storageKey='comictoons-manga-theme';
export function MangaThemeControl({studio}:{studio:Studio}) {
  const restored=useRef(false);
  const theme=resolveMangaTheme(studio.state.mangaTheme);
  useEffect(()=>{
    if(restored.current||studio.loading||studio.busy)return;
    let stored:string|null=null;
    try{stored=localStorage.getItem(storageKey);}catch{/* Shared studio setting still survives page reloads. */}
    restored.current=true;
    if(stored){const restoredTheme=resolveMangaTheme(stored);if(restoredTheme!==theme)void studio.mutate('/api/settings',{mangaTheme:restoredTheme}).catch(()=>{});}
  },[studio.loading,studio.busy,studio.mutate,theme]);
  async function choose(value:MangaTheme) {
    if(studio.busy)return;
    try{
      const result=await studio.mutate<{mangaTheme?:MangaTheme}>('/api/settings',{mangaTheme:value});
      if(result?.mangaTheme===value)try{localStorage.setItem(storageKey,value);}catch{/* Browser storage is optional. */}
    }catch{/* The existing studio banner displays settings failures. */}
  }
  return <section className="manga-theme-control" aria-label="Manga colour theme"><label htmlFor="manga-theme">Manga colour theme<select id="manga-theme" value={theme} disabled={!!studio.busy||studio.offline} onChange={event=>void choose(event.target.value as MangaTheme)}>{mangaThemes.map(option=><option key={option.id} value={option.id}>{option.name}</option>)}</select></label><p>{mangaThemes.find(option=>option.id===theme)?.blurb}</p></section>;
}
