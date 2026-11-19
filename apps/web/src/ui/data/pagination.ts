/** A generated scene image is already a complete comic page, so it gets its own leaf. */
export function comicPageGroups<T>(list:T[],size=4):T[][]{
  const result:T[][]=[];let current:T[]=[];
  const flush=()=>{if(current.length)result.push(current);current=[];};
  for(const item of list){const provider=(item as {provenance?:{provider?:string}}|null)?.provenance?.provider;
    if(provider?.startsWith('scene-')){flush();result.push([item]);}
    else{current.push(item);if(current.length>=size)flush();}
  }
  flush();return result;
}
