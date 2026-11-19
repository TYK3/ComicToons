import { useEffect } from 'react';
import { useUi } from './data/store';
import { useRoute } from './router';
import { Landing } from './screens/Landing';
import { Connect } from './screens/Connect';
import { Studio } from './screens/Studio';
import { Director } from './screens/Director';
import { Overlay } from './screens/Overlay';
import { Book, CatchUp, Reader, Recap, Series } from './screens/Readers';
import { Output } from './screens/Output';

export function App() {
  const route = useRoute();
  const { studio } = useUi();
  // One Look for every view: the attribute drives page-level touches; panels read the Look from the store.
  useEffect(() => { document.documentElement.dataset.look = studio.look; }, [studio.look]);
  useEffect(() => { document.documentElement.dataset.screen = route.name; }, [route.name]);
  switch (route.name) {
    case 'connect': return <Connect/>;
    case 'studio': return <Studio/>;
    case 'director': return <Director/>;
    case 'overlay': return <Overlay route={route}/>;
    case 'recap': return <Recap key={route.id} route={route}/>;
    case 'book': return <Book key={route.id} route={route}/>;
    case 'series': return <Series key={route.id} route={route}/>;
    case 'read': return <Reader key={route.id} route={route}/>;
    case 'catchup': return <CatchUp route={route}/>;
    case 'output': return <Output route={route}/>;
    default: return <Landing/>;
  }
}
