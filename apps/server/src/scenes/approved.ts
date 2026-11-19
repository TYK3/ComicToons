import type {StudioState} from '../studio.ts';

/** Viewer projection contains released artwork only; never source chat or broadcaster controls. */
export function approvedPages(state:StudioState,channel:string){
  const matching=state.source?.active==='twitch'&&state.source.channel===channel;
  return matching?state.panels.filter(p=>p.origin==='twitch'&&!p.releaseBlocked).map(p=>({id:p.id,imageUrl:p.imageUrl,caption:p.caption,altText:p.altText,at:p.at})):[];
}
