import { useEffect } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowUpRight, Copy, WifiOff } from 'lucide-react';
import type { Studio } from '../hooks/useStudio';
import { Brand, Button, EmptyArt, useNotify } from './ui';
import {panelSourceLabel} from '@comictoons/core';
import { MangaPage } from './MangaPage';

export function Recap({ studio }: { studio: Studio }) {
  const { state, loading, error, offline } = studio;
  const notify = useNotify();
  const sourceLabel=panelSourceLabel(state.panels);
  useEffect(() => {
    try {
      if (window.sessionStorage.getItem('comictoons-export-ready') === '1') {
        window.sessionStorage.removeItem('comictoons-export-ready');
        notify({ message: 'Your recap issue is ready to share.' });
      }
    } catch { /* Storage is optional. */ }
  }, [notify]);
  async function copy() {
    try { await navigator.clipboard.writeText(location.href); notify({ message: 'Issue link copied. Let the story travel.' }); }
    catch { notify({ message: 'Copy isn’t available. Share this page’s address instead.' }); }
  }
  return <main className="recap-page" id="main-content"><div className="recap-sheet"><header className="recap-masthead"><Brand light/><span>THE STREAM RECAP COMIC · {sourceLabel}</span><a href="/studio"><ArrowLeft size={16}/>Back to studio</a></header>
    {loading ? <section className="recap-loading skeleton" data-testid="loading-skeleton" role="status"><div/><div/><div/><h1 className="sr-only">Your recap issue</h1><p>Binding your recap issue…</p></section> : !state.panels.length ? <section className="recap-empty" role={error ? 'alert' : undefined}><EmptyArt/><h1>{error ? 'This issue is taking a detour.' : 'A blank page. A new beginning.'}</h1><p>{error || 'There aren’t any approved moments in this issue yet. Head back to the studio and make your first strip.'}</p>{error ? <Button variant="primary" onClick={() => void studio.refresh()}>Try again</Button> : <a className="button button-primary" href="/studio">Open the studio<ArrowUpRight size={18}/></a>}</section> : <>
      {error && <div className="recap-error" role="alert"><WifiOff size={18}/><span>{offline ? 'You’re viewing the last saved issue. We’re reconnecting.' : error}</span><button onClick={() => void studio.refresh()}>Retry</button></div>}
      <div className="issue-details"><span>ISSUE NO. 001</span><span>{state.panels.length} APPROVED MOMENTS</span><span>{sourceLabel}</span></div>
      <header className="manga-issue-title"><h1>{state.issueTitle}</h1><p>Your stream, retold scene by scene.</p></header>
      <div className="share-dock"><span>Your stream. Out in the world.</span><div className="share-actions"><Button onClick={() => void copy()}><Copy size={16}/>Copy issue link</Button><a className={`button button-primary ${!state.shareUrl ? 'is-disabled' : ''}`} href={state.shareUrl || '#'} aria-disabled={!state.shareUrl} download onClick={event => { if (!state.shareUrl) event.preventDefault(); else notify({ message: 'Share card download started. Go make someone curious.' }); }}><ArrowDownToLine size={17}/>Download share card</a></div></div>
      <MangaPage panels={state.panels} theme={state.mangaTheme}/>
      {!!state.pageUrls?.length && <nav className="manga-page-downloads" aria-label="Download manga pages">{state.pageUrls.map((url,index) => <a key={url} className="button button-ink" href={url} download><ArrowDownToLine size={16}/>Download page {index + 1}</a>)}</nav>}
      <section className="recap-outro"><div><h2>Same time,<br/><em>next adventure?</em></h2><p>The stream may be over. Your favorite moments have somewhere to live.</p></div><a className="button button-ink" href="/studio">Make another issue<ArrowUpRight size={18}/></a></section>
    </>}
    <footer className="recap-footer"><Brand light/><span>MADE LIVE. REMEMBERED IN INK.</span><span>{sourceLabel}</span></footer></div></main>;
}
