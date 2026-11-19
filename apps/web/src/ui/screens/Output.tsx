import { useEffect, useRef, useState } from 'react';
import type { BindResult, OutputMode } from '../data/adapter';
import { studioPhase, useAdapter, useUi } from '../data/store';
import { RetryButton, ScreenState } from '../components/ScreenState';
import { ReaderBar } from '../components/ReaderBar';
import { LookArt } from '../components/Panel';
import { Arrow } from '../components/Icons';
import { href, type Route } from '../router';
import { useReveal } from '../motion';
import '../styles/pages.css';
import '../styles/readers.css';

const MODES: { id: OutputMode; name: string; line: string }[] = [
  { id: 'book', name: 'Comic book', line: 'A cover, printed pages of four panels, and a back page. Flip through it or save pages as PNGs.' },
  { id: 'series', name: 'Manga series', line: 'Tonight becomes the next episode in a vertical strip that reads well on a phone.' },
  { id: 'catchup', name: 'Catch-up', line: 'A “Previously on…” card for raiders and late arrivals, on the overlay and as a link.' },
];
const STEPS = ['Collecting approved panels', 'Laying out the pages', 'Lettering captions', 'Binding the issue'];

/** Output: end the stream, pick what to make, watch it bind, then open the results. */
export function Output({ route }: { route: Route }) {
  const adapter = useAdapter();
  const ui = useUi();
  const { studio } = ui;
  const [title, setTitle] = useState(studio.issueTitle);
  // UI3: the title arrives with the first snapshot when the page opened while loading.
  useEffect(() => { if (studio.issueTitle) setTitle(value => value || studio.issueTitle); }, [studio.issueTitle]);
  const phase = studioPhase(ui);
  const [modes, setModes] = useState<OutputMode[]>(['book', 'series', 'catchup']);
  const [step, setStep] = useState(-1);
  const [failed, setFailed] = useState('');
  const root = useRef<HTMLDivElement>(null);
  const done = studio.status === 'ended' || route.params.get('done') === '1';
  useReveal(root, [done]);
  useEffect(() => {
    if (step < 0 || step >= STEPS.length - 1) return;
    const timer = setTimeout(() => setStep(value => value + 1), 260);
    return () => clearTimeout(timer);
  }, [step]);
  const [bound, setBound] = useState<BindResult | null>(null);
  // The bound issue, else the latest saved one (studio.recapUrl is '/recap/<id>' on the server), else the Sample issue.
  const id = bound?.recapId ?? studio.recapUrl?.split('/').pop() ?? `sample-${studio.fixtureId}`;
  const panels = studio.panels;
  const pageCount = Math.max(1, Math.ceil(panels.length / 4)) + 1;
  const bind = async () => {
    binding.current = true;
    setFailed(''); setStep(0);
    try { setBound(await adapter.endStream(title, modes, studio.look)); setStep(STEPS.length); }
    catch (cause) { setFailed(cause instanceof Error ? cause.message : 'Binding failed.'); setStep(-1); }
  };
  const toggle = (mode: OutputMode) => setModes(list => list.includes(mode) ? list.filter(entry => entry !== mode) : [...list, mode]);
  const art = (index: number) => panels[index % Math.max(1, panels.length)];
  // A11Y-fix #5: the bind button goes disabled while binding and the form goes when done, so move focus along with it:
  // to the progress list, then to the "is ready" heading, or to Try again if binding failed.
  const progress = useRef<HTMLOListElement>(null);
  const banner = useRef<HTMLDivElement>(null);
  const ready = useRef<HTMLHeadingElement>(null);
  const binding = useRef(false);
  const lost = () => { const active = document.activeElement as HTMLButtonElement | null; return !active || active === document.body || !active.isConnected || active.disabled; };
  useEffect(() => { if (step === 0 && binding.current && lost()) progress.current?.focus(); }, [step]);
  useEffect(() => { if (failed && binding.current && lost()) banner.current?.querySelector<HTMLElement>('button')?.focus(); }, [failed]);
  useEffect(() => { if (done && binding.current && lost()) { binding.current = false; ready.current?.focus(); } }, [done]);

  return <div className="ct-reader">
    <a className="ct-skip" href="#ct-main">Skip to the outputs</a>
    <ReaderBar><span className="ct-reader__crumb">Output</span></ReaderBar>
    <main id="ct-main" className="ct-reader__main">
      <div className="ct-output" ref={root}>
        {phase === 'loading' ? <ScreenState kind="loading" level={1} title="Loading tonight’s issue"><p>Counting your approved panels…</p></ScreenState>
          : phase === 'error' ? <ScreenState kind="error" level={1} title="Can’t reach your studio" actions={<>
            <RetryButton onRetry={() => void adapter.refresh()} busy={ui.busy === 'refresh'}/>
            <a className="ct-btn" href={href('/studio')}>Back to the studio</a>
          </>}>
            <p>{ui.error || 'ComicToons couldn’t reach the studio server on this computer.'}</p>
            <p>Binding happens on the studio computer. Check ComicToons is running there, then try again. Your approved panels are kept there.</p>
          </ScreenState>
          : phase === 'empty' && !done ? <ScreenState kind="empty" level={1} title="Nothing to bind yet" actions={<a className="ct-btn ct-btn--ink" href={href('/studio')}>Open the studio</a>}>
            <p>An issue is made from approved panels, and there aren’t any yet.</p>
            <p>Approve a few in the studio as your stream goes, then come back here to bind them into a comic.</p>
          </ScreenState>
          : !done ? <>
          <header className="ct-output__head" data-reveal="up">
            <p className="ct-kicker">End of stream</p>
            <h1 className="ct-display">Bind tonight’s issue</h1>
            <p className="ct-output__lede">{panels.length ? `${panels.length} approved panels are ready.` : 'Approve at least one panel in the studio first.'} Nothing goes public until you share a link.</p>
          </header>
          <form className="ct-output__form" onSubmit={event => { event.preventDefault(); void bind(); }}>
            <label className="ct-field"><span className="ct-tool__label">Issue title</span><input value={title} maxLength={60} onChange={event => setTitle(event.target.value)} required/></label>
            <fieldset className="ct-output__modes">
              <legend className="ct-tool__label">Make</legend>
              {MODES.map((mode, index) => <label key={mode.id} className="ct-mode" data-on={modes.includes(mode.id)}>
                <input type="checkbox" checked={modes.includes(mode.id)} onChange={() => toggle(mode.id)}/>
                <span className="ct-mode__art">{art(index) && <LookArt panel={art(index)!} look={studio.look}/>}</span>
                <span className="ct-mode__name">{mode.name}</span>
                <span className="ct-mode__line">{mode.line}</span>
              </label>)}
            </fieldset>
            {step >= 0 && <ol ref={progress} tabIndex={-1} className="ct-bindsteps" aria-live="polite" aria-label="Binding progress">
              {STEPS.map((label, index) => <li key={label} data-state={index < step ? 'done' : index === step ? 'now' : 'todo'}>{label}</li>)}
            </ol>}
            {failed && <div ref={banner} className="ct-banner ct-banner--paper" role="status" aria-live="polite">
              <p><strong>Binding didn’t finish.</strong> {failed}</p>
              <RetryButton onRetry={() => void bind()} ink={false}/>
            </div>}
            <div className="ct-row">
              <button type="submit" className="ct-btn ct-btn--ink" disabled={!modes.length || !panels.length || step >= 0}>{step >= 0 ? 'Binding…' : 'End stream and bind'}</button>
              <a className="ct-btn" href={href('/studio')}>Keep streaming</a>
            </div>
          </form>
        </> : <>
          <header className="ct-output__head ct-output__head--done" data-reveal="slam">
            <p className="ct-kicker">Bound · Sample</p>
            <h1 ref={ready} tabIndex={-1} className="ct-display">“{studio.issueTitle}” is ready</h1>
            <p className="ct-output__lede">{panels.length} panels · {pageCount} pages including the cover. Open any of them, or share the recap link.</p>
          </header>
          <ul className="ct-results">
            {[
              { name: 'Recap', line: 'Every page at a glance, with PNG downloads.', to: `/recap/${id}` },
              { name: 'Comic book', line: 'Cover to back page, two pages at a time.', to: `/book/${id}` },
              { name: 'Manga series', line: 'Tonight is the newest episode.', to: `/series/${id}` },
              { name: 'Catch-up', line: 'The “Previously on…” card for raiders.', to: '/catchup' },
            ].map((result, index) => <li key={result.name} data-reveal="up" data-delay={String(index * 70)}>
              <a className="ct-result" href={href(result.to)}>
                <span className="ct-result__art">{art(index) && <LookArt panel={art(index)!} look={studio.look}/>}</span>
                <span className="ct-result__name">{result.name} <Arrow/></span>
                <span className="ct-result__line">{result.line}</span>
              </a>
            </li>)}
          </ul>
          <ShareLink to={`/recap/${id}`}/>
        </>}
      </div>
    </main>
  </div>;
}

function ShareLink({ to }: { to: string }) {
  const [copied, setCopied] = useState('');
  const url = `${location.origin}${location.pathname}#${to}`;
  return <div className="ct-share">
    <label className="ct-field"><span className="ct-tool__label">Recap link</span><input readOnly value={url} onFocus={event => event.currentTarget.select()}/></label>
    <button type="button" className="ct-btn" onClick={() => { void navigator.clipboard?.writeText(url).then(() => setCopied('Link copied.'), () => setCopied('Copy the link from the box.')); }}>Copy link</button>
    <span className="ct-note" role="status">{copied}</span>
  </div>;
}
