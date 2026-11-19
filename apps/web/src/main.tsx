import {installDirectorKeyTransport} from './lib/director-key';
import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/700-italic.css';
import '@fontsource/dm-sans/400.css';
import '@fontsource/dm-sans/500.css';
import '@fontsource/dm-sans/600.css';
import '@fontsource/dm-sans/700.css';
// Display, lettering and reader faces named first by the book, series and catch-up CSS (OFL-1.1).
import '@fontsource/bangers/400.css';
import '@fontsource/comic-neue/700.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/700.css';
import { useStudio } from './hooks/useStudio';
import { Providers } from './components/ui';
import { Studio } from './components/Studio';
import { Overlay } from './components/Overlay';
import { Recap } from './components/Recap';
import { Landing } from './components/Landing';
import { Connect } from './components/Connect';
import { CatchUp } from './components/CatchUp';
import { Book } from './components/Book';
import { Series } from './components/Series';
import { Director } from './components/Director';
import './style.css';
import './wow.css';

installDirectorKeyTransport();
const overlay = location.pathname.startsWith('/overlay');
const recap = location.pathname.startsWith('/r/') || location.pathname.startsWith('/recap/');
document.documentElement.classList.toggle('overlay-root', overlay);
document.body.classList.toggle('overlay-body', overlay);

function Workspace() {
  const studio = useStudio(recap ? location.pathname.split('/')[2] : undefined);
  return <Providers>{!overlay && <a className="skip-link" href="#main-content">Skip to content</a>}{overlay ? <Overlay studio={studio}/> : recap ? <Recap studio={studio}/> : <Studio studio={studio}/>}</Providers>;
}

// New stub pages for S1/S3/S4; existing routes (/, /overlay, /r/:id, /recap/:id, studio) are untouched.
function stubRouteFor(pathname: string) {
  if (pathname === '/connect' || pathname === '/auth') return <Connect/>;
  if (pathname.startsWith('/catchup')) return <CatchUp/>;
  if (pathname === '/director') return <Director/>;
  const book = pathname.match(/^\/book\/([^/]+)/);
  if (book) return <Book id={decodeURIComponent(book[1]!)}/>;
  const series = pathname.match(/^\/series\/([^/]+)/);
  if (series) return <Series id={decodeURIComponent(series[1]!)}/>;
  return null;
}
const stub = stubRouteFor(location.pathname);

createRoot(document.getElementById('root')!).render(<React.StrictMode>{stub ? <Providers>{stub}</Providers> : ['/','/classic','/classic.html'].includes(location.pathname) ? <Providers><Landing/></Providers> : <Workspace/>}</React.StrictMode>);
