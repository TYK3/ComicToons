import {createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {Studio} from '../../apps/web/src/components/Studio';
import {Providers} from '../../apps/web/src/components/ui';
import type {Studio as StudioController} from '../../apps/web/src/hooks/useStudio';
import type {StudioState} from '../../apps/web/src/types';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/dm-sans/400.css';
import '../../apps/web/src/style.css';
import '../../apps/web/src/wow.css';

// Component contract probe: simulate the hook's busy-ref refusal without timing
// races or adding a test-only switch to the production application.
const state:StudioState=await (await fetch('/api/state')).json();
const controller:StudioController={state,fixtures:[],loading:false,offline:false,error:'',busy:'',sampleReady:true,
  mutate:async path=>{if(path==='/api/recaps')Object.assign(window,{downloadNoopCalls:((window as unknown as {downloadNoopCalls?:number}).downloadNoopCalls??0)+1});return undefined;},
  useSampleData:async()=>{},refresh:async()=>{},pausePolling:()=>{}};
createRoot(document.getElementById('root')!).render(createElement(Providers,{children:createElement(Studio,{studio:controller})}));
