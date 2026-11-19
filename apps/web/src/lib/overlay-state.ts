import type {StudioState} from '../types';

/** A transport failure does not supersede the last complete event-stream snapshot. */
export function overlayState(stream:StudioState|undefined,snapshot:StudioState):StudioState {
  return stream??snapshot;
}

export function overlayPanels<T extends {origin?:string}>(panels:T[]):T[] {
  if(!panels.some(panel=>panel.origin==='twitch'))return panels;
  return panels.filter(panel=>panel.origin==='twitch');
}
