import type {MangaTheme} from '@comictoons/core';
import type { LetteringMap } from '../../../packages/core/src/lettering';
import type { ChatSourceState, StoryBeat, StoryAtlas } from '@comictoons/core';
export interface Panel {
  releaseBlocked?: string;
  imageRevision?: {status:'rendering'|'failed';reason?:string};
  origin?: 'sample' | 'twitch';
  storyBeats?: StoryBeat[];
  storyCaption?: string;
  atlas?: StoryAtlas;
  sourceId?: string;
  lettering?: LetteringMap;
  id: string;
  caption: string;
  dialogue: string[];
  altText: string;
  imageUrl: string;
  provenance?: { provider: string; asset?: string; style: string; fallback: boolean };
  composition?: number;
  sfx?: string;
  bubblePlacement?: 'top-left' | 'top-right' | 'bottom-left';
  at?: number;
}

export interface StudioState {
  overlayHidden?: boolean;
  /** CLIP-WATCH-1: clips brought in this live session. */
  clips?: number;
  mangaTheme?: MangaTheme;
  source?: ChatSourceState;
  status: string;
  fixtureId: string;
  speed: number;
  style: string;
  approvalMode: boolean;
  panels: Panel[];
  pendingPanels: Panel[];
  streamTitle: string;
  issueTitle: string;
  elapsed?: number;
  duration?: number;
  recapUrl?: string;
  latestRecapUrl?: string;
  savedIssueDiffers?: boolean;
  shareUrl?: string;
  pageUrls?: string[];
  shareVerticalUrl?: string;
}

export interface Fixture { id: string; streamTitle: string }
export const initialState: StudioState = {
  mangaTheme: 'festival', status: 'idle', fixtureId: 'tabletop-night', speed: 60, style: 'risograph',
  approvalMode: true, panels: [], pendingPanels: [], streamTitle: 'Tabletop night',
  issueTitle: 'The story is still unfolding', elapsed: 0, duration: 1800,
};

export function timecode(seconds = 0) {
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60).toString().padStart(2, '0')}:${(safe % 60).toString().padStart(2, '0')}`;
}
