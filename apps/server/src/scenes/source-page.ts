import type {ScenePlan,SourceChat} from '@comictoons/core';
import type {FrameInput} from './providers.ts';
export function sourcePlan(frames:FrameInput[],chat:SourceChat[]):ScenePlan{
  if(frames.length<4)throw Error('Four actual stream frames are required.');
  return {supported:true,highlight:false,title:'Source-frame comic',reason:'Actual chronological Twitch frames with attributed chat. No AI illustration or speech transcription.',panels:frames.slice(0,6).map((frame,index)=>({frameId:frame.id,description:`Captured stream frame at ${frame.videoTime.toFixed(1)} seconds.`,narration:`Captured scene · ${frame.videoTime.toFixed(1)}s`,chatIds:index===0?chat.slice(-1).map(q=>q.id):[]}))};
}
