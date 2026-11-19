/**
 * IMPORT-1: "Make a comic from a Twitch link". Paste a VOD, clip or channel link (or up to 6 clip links,
 * one per line), optionally attach a chat log (.txt or .json), get panels back from POST /api/import,
 * then add them to the channel's manga series (POST /api/channel-series/:channel/chapters).
 * A channel link switches the Studio to Live chat on that channel instead.
 * No network here (tests/ui-no-network.test.ts): both calls go through an ImportClient, by default the
 * Studio's adapter (data/server.ts sends them with write(), so the director key header is added there like
 * every other Studio write; data/mock.ts rejects with plain words). An adapter without them gets a note.
 */
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { ImportLinkBody, ImportResponse, SavedChapter } from '../../data/adapter';
import { resolveLook, type LookId } from '../../data/adapter';
import { useAdapter, useUi } from '../../data/store';
import { LookArt } from '../../components/Panel';
import { placeImportBubbles } from './importLettering';
import '../../styles/import.css';

export type { ImportResponse, SavedChapter } from '../../data/adapter';
/** The two writes this card makes (ComicToonsAdapter.importLink/addSeriesChapter). Both reject with the server's error text. */
export interface ImportClient {
  importLink(body: ImportLinkBody): Promise<ImportResponse>; // POST /api/import
  addSeriesChapter(channel: string, body: { importId: string; title?: string }): Promise<{ chapter: SavedChapter }>; // POST /api/channel-series/:channel/chapters
}
const isImportClient = (value: unknown): value is ImportClient =>
  !!value && typeof (value as ImportClient).importLink === 'function' && typeof (value as ImportClient).addSeriesChapter === 'function';
const message = (error: unknown) => error instanceof Error && error.message ? error.message : 'The Studio server could not be reached.';

const minutes = (seconds: number) => `${Math.max(1, Math.round(seconds / 60))} min`;
/** .json files are read as JSON; anything else as plain text, one line per message. */
export const chatLogFormat = (fileName: string): 'txt' | 'json' => /\.json$/i.test(fileName) ? 'json' : 'txt';

/**
 * The lead's ruling (22:56): a VOD over 10 min is clamped to its first 10 min, and the result says so in plain words,
 * e.g. "Used the first 10 min of a 47 min video." The server's sentence is used; the same words are built here
 * only if an older server sent the window without it.
 */
export function clampNote(result: ImportResponse): string | undefined {
  const window = result.window;
  return result.note ?? window?.note ?? (window?.capped ? `Used the first ${minutes(window.usedSeconds)} of a ${minutes(window.vodSeconds)} video.` : undefined);
}

/** One line under the preview: what was read, so a missing clip is never a surprise. The clamp note is its own line. */
export function importSummary(result: ImportResponse): string {
  if (result.kind === 'live') return `Live chat is now reading #${result.channel}.`;
  const count = result.panels?.length ?? 0;
  const parts = [`${count} panel${count === 1 ? '' : 's'}`];
  if (result.window && !result.window.capped) parts.push(`from a ${minutes(result.window.vodSeconds)} video`);
  if (result.missing?.length) parts.push(`${result.missing.length} clip${result.missing.length === 1 ? '' : 's'} not found: ${result.missing.join(', ')}`);
  return `${parts.join(' · ')}.`;
}

/** The import's panels: each one comic frame (caption bar, art, chat strip), words never on the art (importLettering.ts). */
function ImportPanels({ result, look }: { result: ImportResponse; look: LookId }) {
  const panels = result.panels ?? [];
  return <ol className="ct-import-panels" data-count={panels.length}>
    {panels.map(panel => {
      const bubbles = placeImportBubbles(panel.dialogue.length, { rail: true });
      return <li key={panel.id} className="ct-import-panel">
        <p className="ct-import-cap" data-lettering-kind="caption">{panel.caption}</p>
        <figure className="ct-panel ct-import-art" data-look={look}>
          <LookArt panel={{ imageUrl: panel.imageUrl, altText: panel.altText, art: { width: 1280, height: 720, tone: 'colour' } }} look={look} eager/>
        </figure>
        {panel.dialogue.length > 0 && <div className="ct-import-rail" role="group" aria-label="Chat">
          {panel.dialogue.map((line, index) => <p key={index} className="ct-bubble" data-lettering-kind="bubble" data-zone={bubbles[index]?.zone}>{line}</p>)}
        </div>}
      </li>;
      })}
  </ol>;
}

/** "Open in reader": the import's panels at reading size, in a modal sheet. */
export function ImportReader({ result, look = 'festival', onClose }: { result: ImportResponse; look?: LookId; onClose: () => void }) {
  // Closing gives focus back to the control that opened the reader (tests/a11y-fix-keyboard.spec.ts #3).
  // The opener is read during the first render, before focus moves into the reader.
  const [opener] = useState(() => typeof document !== 'undefined' && document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const dialog = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  // IMPORT-UI-1 r1: focus moves onto Close when the reader opens (by click or Enter), so Escape works at once.
  useEffect(() => { close.current?.focus(); }, []);
  useEffect(() => () => { if (opener?.isConnected) opener.focus(); }, [opener]);
  // Escape closes; Tab and Shift+Tab stay inside the reader (aria-modal).
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
    if (event.key !== 'Tab' || !dialog.current) return;
    const items = Array.from(dialog.current.querySelectorAll<HTMLElement>('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])'));
    if (!items.length) { event.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1], active = document.activeElement;
    if (event.shiftKey && (active === first || !dialog.current.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !dialog.current.contains(active))) { event.preventDefault(); first.focus(); }
  };
  return <div ref={dialog} className="ct-import-reader" role="dialog" aria-modal="true" aria-labelledby="ct-import-reader-title" onKeyDown={onKeyDown}>
    <div className="ct-import-reader__sheet">
      <div className="ct-import-reader__bar">
        <h2 id="ct-import-reader-title" className="ct-display">{importSummary(result)}</h2>
        <button ref={close} type="button" className="ct-btn ct-btn--sm" onClick={onClose}>Close reader</button>
      </div>
      <ImportPanels result={result} look={look}/>
    </div>
  </div>;
}

export function ImportPreview({ result, saved, look = 'festival', onRead }: { result: ImportResponse; saved?: SavedChapter; look?: LookId; onRead?: () => void }) {
  return <div className="ct-import-preview" data-import-kind={result.kind}>
    <p className="ct-note" role="status">{importSummary(result)}</p>
    {clampNote(result) && <p className="ct-note" data-import-clamp=""><strong>{clampNote(result)}</strong></p>}
    {!!result.panels?.length && <ImportPanels result={result} look={look}/>}
    {!!result.panels?.length && onRead && <p className="ct-import-acts"><button type="button" className="ct-btn ct-btn--sm ct-import-read" onClick={onRead}>Open in reader</button></p>}
    {saved && <p className="ct-note" role="status">Added as chapter {saved.number}: {saved.title}.{saved.note ? ` ${saved.note}` : ''}</p>}
  </div>;
}

export function MakeFromLink({ client }: { client?: ImportClient }) {
  const adapter = useAdapter();
  const look = resolveLook(useUi().studio?.look);
  const api = client ?? (isImportClient(adapter) ? adapter : undefined);
  const [input, setInput] = useState('');
  const [chatLog, setChatLog] = useState<{ name: string; text: string } | undefined>();
  const [result, setResult] = useState<ImportResponse | undefined>();
  const [title, setTitle] = useState('');
  const [saved, setSaved] = useState<SavedChapter | undefined>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<'' | 'import' | 'save'>('');
  const [reading, setReading] = useState(false);

  const generate = async (event: FormEvent) => {
    event.preventDefault();
    if (!api) return;
    setBusy('import'); setError(''); setResult(undefined); setSaved(undefined); setReading(false);
    try {
      const next = await api.importLink({ input, ...(chatLog ? { chatLog: chatLog.text, chatLogFormat: chatLogFormat(chatLog.name) } : {}) });
      setResult(next); setTitle(next.title ?? '');
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(''); }
  };

  const save = async () => {
    if (!api || !result?.importId || !result.channel) return;
    setBusy('save'); setError('');
    try {
      const { chapter } = await api.addSeriesChapter(result.channel, { importId: result.importId, ...(title.trim() ? { title: title.trim() } : {}) });
      setSaved(chapter);
    } catch (failure) { setError(message(failure)); }
    finally { setBusy(''); }
  };

  return <section className="ct-card ct-import-card" aria-labelledby="ct-import-title">
    <header className="ct-card__head ct-on-ink"><h2 id="ct-import-title" tabIndex={-1}>Make a comic from a link</h2></header>
    <div className="ct-card__body">
      <form className="ct-import-form" onSubmit={event => void generate(event)}>
        <label className="ct-field">Twitch VOD, clip or channel link
          <textarea rows={2} value={input} maxLength={4000} onChange={event => setInput(event.target.value)} placeholder="https://clips.twitch.tv/…" required/>
        </label>
        <p className="ct-note">A video longer than 10 min is cut to its first 10 min, and the result says so. Up to 6 of its clips make one panel each. One clip makes 1–4 panels. Up to 6 clip links, one per line.</p>
        <div className="ct-import-row"><label className="ct-field ct-import-chat">Chat log (optional, .txt or .json)
          <input type="file" accept=".txt,.json,text/plain,application/json" onChange={event => {
            const file = event.target.files?.[0];
            if (!file) { setChatLog(undefined); return; }
            void file.text().then(text => setChatLog({ name: file.name, text }));
          }}/>
        </label><button type="submit" className="ct-btn ct-import-go" disabled={!api || busy !== '' || !input.trim()}>{busy === 'import' ? 'Making…' : 'Make comic'}</button></div>
        {!api && <p className="ct-note">Making comics from links isn’t available in this Studio yet.</p>}
      </form>
      {error && <p className="ct-note" role="status">{error}</p>}
      {result && <ImportPreview result={result} saved={saved} look={look} onRead={() => setReading(true)}/>}
      {result && reading && <ImportReader result={result} look={look} onClose={() => setReading(false)}/>}
      {result?.importId && (result.channel
        ? !saved && <div className="ct-import-row ct-import-save">
          <label className="ct-field">Chapter title<input value={title} maxLength={160} onChange={event => setTitle(event.target.value)}/></label>
          <button type="button" className="ct-btn ct-import-go" onClick={() => void save()} disabled={busy !== ''}>{busy === 'save' ? 'Adding…' : `Add to #${result.channel}’s manga series`}</button>
        </div>
        : <p className="ct-note">Twitch didn’t say whose channel this is, so it can’t be added to a series. Paste the twitch.tv/&lt;channel&gt;/clip/… form instead.</p>)}
    </div>
  </section>;
}
