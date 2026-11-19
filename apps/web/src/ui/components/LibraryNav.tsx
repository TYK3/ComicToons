import {href} from '../router';

/** Both Library destinations keep the active workspace in their links. */
export function LibraryNav({current}:{current:'issues'|'output'}){
  return <nav className="ct-library-nav" aria-label="Library">
    <a href={href('/issues')} aria-current={current==='issues'?'page':undefined}>Saved issues</a>
    <a href={href('/output')} aria-current={current==='output'?'page':undefined}>Create & export</a>
  </nav>;
}
