import { useEffect, useRef } from 'react';
import { useAdapter, useUi } from './data/store';
import { useRoute } from './router';
import { Landing } from './screens/Landing';
import { Connect } from './screens/Connect';
import { Studio } from './screens/Studio';
import { Director } from './screens/Director';
import { Overlay } from './screens/Overlay';
import { Book, CatchUp, Reader, Recap, Series } from './screens/Readers';
import { StoryFlow } from './screens/StoryFlow';
import { Output } from './screens/Output';
import {Audience} from './screens/Audience';
import {Issues} from './screens/Issues';
import {Viewer} from './screens/Viewer';
import {RoleChoice} from './components/RoleChoice';
import {useWatch} from './data/watch';
import {useStudioMode} from './data/StudioSession';

export function App() {
  const route = useRoute();
  const { studio } = useUi();
  const {role}=useWatch();
  const {mode}=useStudioMode();
  const adapter=useAdapter();
  const previousRole=useRef(role);
  useEffect(()=>{
    if(previousRole.current==='viewer'&&role==='streamer')void adapter.refresh();
    previousRole.current=role;
  },[role,adapter]);
  // One Look for every view: the attribute drives page-level touches; panels read the Look from the store.
  useEffect(() => { document.documentElement.dataset.look = studio.look; }, [studio.look]);
  useEffect(() => { document.documentElement.dataset.screen = route.name; }, [route.name]);
  if(mode==='live'&&role==='viewer'&&['studio','viewer','connect','flow','director','output'].includes(route.name))return <Viewer/>;
  switch (route.name) {
    case 'connect': return <Connect/>;
    case 'flow': return <StoryFlow/>;
    case 'viewer': return <Viewer/>;
    case 'studio': return mode==='sample'?<Studio/>:<><RoleChoice/><Studio/></>;
    case 'director': return <Director/>;
    case 'overlay': return <Overlay route={route}/>;
    case 'audience': return <Audience/>;
    case 'issues': return <Issues/>;
    case 'recap': return <Recap key={route.id} route={route}/>;
    case 'book': return <Book key={route.id} route={route}/>;
    case 'series': return <Series key={route.id} route={route}/>;
    case 'read': return <Reader key={route.id} route={route}/>;
    case 'catchup': return <CatchUp route={route}/>;
    case 'output': return <Output/>;
    default: return <Landing/>;
  }
}
