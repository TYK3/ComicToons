/**
 * Rebuilt equivalents of components/ChatSource.tsx and components/ParticipationPanel.tsx, behind the adapter.
 * Real Twitch features only: polls, predictions and channel-point rewards need Affiliate or Partner;
 * chat votes (!1, !2, !3), raids, !previously and !noink work on any channel.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { isSampleSource, type ChatSourceState } from '@comictoons/core';
import { canUseChannelFeatures, type ChatLine, type InkMeReward } from '../../data/adapter';
import { useAdapter, useNow, useUi } from '../../data/store';
import { AffiliateNotice } from '../../components/TwitchConnect';
import { Sample } from '../../components/Brand';
import { CHAT_QUIET_MS, INK_CHAT_LABEL, chatSourceChip, chatStateText, inkChatWaiting, isLiveChatQuiet, readInkChat, time24, type InkChatView } from './live';

const clock = (ms: number) => { const total = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`; };
const ago = (now: number, at: number) => { const minutes = Math.round((now - at) / 60_000); return minutes < 1 ? 'just now' : `${minutes} min ago`; };

/**
 * A11Y-fix: when an action removes the focused control (an approved panel, a fulfilled redemption), React drops focus
 * to the page. Call the returned function with a picker before the action; after the next renders, if focus has
 * fallen to the page, the picked control gets it. The hand-off expires after a few seconds.
 */
export function useFocusRescue() {
  const pending = useRef<{ pick: () => HTMLElement | null | undefined; until: number } | null>(null);
  useEffect(() => {
    const entry = pending.current;
    if (!entry) return;
    if (Date.now() > entry.until) { pending.current = null; return; }
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && active.isConnected && !(active as HTMLButtonElement).disabled) return;
    const target = entry.pick();
    if (target) { pending.current = null; target.focus(); }
  });
  return (pick: () => HTMLElement | null | undefined) => { pending.current = { pick, until: Date.now() + 5000 }; };
}

function Card({ title, sample, children, id }: { title: string; sample?: boolean; children: ReactNode; id?: string }) {
  return <section className="ct-card ct-side-card" aria-labelledby={id}>
    <header className="ct-card__head ct-on-ink"><h2 id={id} tabIndex={-1}>{title}</h2>{sample && <Sample/>}</header>
    <div className="ct-card__body">{children}</div>
  </section>;
}

/** Chat votes the bubble: a Twitch poll on Affiliate/Partner channels, !1/!2/!3 chat votes everywhere else. */
export function VoteCard() {
  const ui = useUi();
  const now = useNow();
  const adapter = useAdapter();
  const { poll, lastPoll } = ui.participation;
  const official = canUseChannelFeatures(ui.twitch);
  return <Card title="Chat votes the bubble" sample={!poll || poll.id.startsWith('sample')} id="ct-vote-title">
    {poll ? <>
      <p className="ct-note"><strong>{poll.mode === 'twitch' ? 'Twitch poll' : 'Chat vote: type !1, !2 or !3'}</strong> · {poll.total} votes · ends in {clock(poll.endsAt - now)}</p>
      <ol className="ct-vote">
        {poll.choices.map(choice => {
          const pct = poll.total ? Math.round(choice.votes / poll.total * 100) : 0;
          return <li key={choice.key}>
            <span className="ct-vote__key">!{choice.key}</span>
            <span className="ct-vote__text">{choice.caption}</span>
            <span className="ct-vote__pct">{pct}%</span>
            <span className="ct-bar" aria-hidden="true"><i style={{ width: `${pct}%` }}/></span>
          </li>;
        })}
      </ol>
      <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.endPoll()}>End vote now</button>
    </> : <>
      <p className="ct-note">Let chat pick the speech bubble for the next waiting panel. {official ? 'Runs as a Twitch poll.' : 'Viewers type !1, !2 or !3 in chat. No Affiliate needed.'}</p>
      {lastPoll && <p className="ct-note">Last vote: <strong>“{lastPoll.caption}”</strong> from {lastPoll.voters} voters.</p>}
      <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => void adapter.startPoll()} disabled={!ui.studio.pendingPanels.length && !ui.studio.panels.length}>Start a 45-second vote</button>
    </>}
    {ui.twitch.state === 'connected' && !official && <p className="ct-note">Twitch polls need Affiliate or Partner, so this uses chat votes instead.</p>}
  </Card>;
}

export function PredictionCard() {
  const ui = useUi();
  const now = useNow();
  const adapter = useAdapter();
  const { prediction } = ui.participation;
  const connected = ui.twitch.state === 'connected';
  const allowed = canUseChannelFeatures(ui.twitch);
  if (connected && !allowed) return <Card title="Prediction" id="ct-pred-title"><AffiliateNotice feature="Predictions"/></Card>;
  const total = prediction ? prediction.outcomes.reduce((sum, outcome) => sum + outcome.points, 0) : 0;
  return <Card title="Prediction" sample id="ct-pred-title">
    {prediction ? <>
      <p className="ct-pred__q">{prediction.title}</p>
      <ul className="ct-pred">
        {prediction.outcomes.map(outcome => {
          const pct = total ? Math.round(outcome.points / total * 100) : 0;
          const won = prediction.winner === outcome.title;
          return <li key={outcome.title} data-won={won || undefined}>
            <span><strong>{outcome.title}</strong>{won && ' ✓'}</span>
            <span className="ct-muted">{outcome.users} viewers · {outcome.points.toLocaleString('en-GB')} pts</span>
            <span className="ct-bar ct-bar--tone" aria-hidden="true"><i style={{ width: `${pct}%` }}/></span>
            {prediction.status !== 'resolved' && <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.resolvePrediction(outcome.title)}>Pay out</button>}
          </li>;
        })}
      </ul>
      <p className="ct-note">{prediction.status === 'resolved' ? 'Paid out. The result goes into the next caption.' : prediction.endsAt ? `Locks in ${clock(prediction.endsAt - now)}.` : 'Locked.'}</p>
    </> : <>
      <p className="ct-note">Viewers bet channel points on what happens next. The result gets inked into the next panel.</p>
      <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => void adapter.startPrediction()}>Start a prediction</button>
    </>}
    {!connected && <p className="ct-note">Predictions need an Affiliate or Partner channel. Sample until you connect.</p>}
  </Card>;
}

/** Item 10: `error` and `chatFallback` are shown exactly as the server sends them (no full stop added, no stand-in text). */

/**
 * Ink me: one switch for the channel-point reward (rewards/connect on, rewards/disconnect off).
 * T3b R3: while status is 'unavailable', `error` and `chatFallback` sit right beside the switch.
 * A normal (non-Affiliate) channel gets a plain message instead of a switch that can never turn on.
 */
export function InkMeCard() {
  const ui = useUi();
  const now = useNow();
  const adapter = useAdapter();
  const [failed, setFailed] = useState('');
  const list = useRef<HTMLUListElement>(null);
  const rescue = useFocusRescue();
  const { reward } = ui.participation;
  const connected = ui.twitch.state === 'connected';
  const sample = adapter.kind === 'mock';
  const notAffiliate = reward.offReason === 'not-affiliate' || (connected && !canUseChannelFeatures(ui.twitch));
  // UI-LIVE-B #2: while channel points are refused the server runs !ink from chat (inkChat). Its text replaces the older chatFallback.
  const inkChat = readInkChat(ui.participation);
  const chatInk = inkChat?.active ? <InkChatRequests inkChat={inkChat} reward={reward} now={now} modApprove={ui.participation.rules.modApprove}/> : null;
  if (notAffiliate) return <Card title="Ink me" sample={sample} id="ct-ink-title">
    <div className="ct-notice ct-inkme__plain" role="status" data-off-reason="not-affiliate">
      <span className="ct-notice__mark" aria-hidden="true">!?</span>
      <div className="ct-inkme__text">
        <p><strong>{reward.error ?? 'Ink me is off on this channel'}</strong></p>
        {!chatInk && reward.chatFallback && <p className="ct-note" data-verbatim="chatFallback">{reward.chatFallback}</p>}
        <p><a className="ct-inline-link" href="https://help.twitch.tv/s/article/joining-the-affiliate-program" target="_blank" rel="noopener noreferrer">How to become an Affiliate</a></p>
      </div>
    </div>
    {chatInk}
  </Card>;
  const on = reward.status === 'ready' || reward.status === 'creating';
  const off = reward.status === 'unavailable';
  const toggle = async (next: boolean) => {
    setFailed('');
    try { await adapter.setInkMe(next); } catch (cause) { setFailed(cause instanceof Error ? cause.message : 'Twitch didn’t answer. Try again.'); }
  };
  const queue = reward.redemptions.filter(entry => entry.status === 'queued' || entry.status === 'drawing');
  const done = reward.redemptions.filter(entry => entry.status === 'fulfilled' || entry.status === 'refunded');
  const cooling = reward.cooldownEndsAt && reward.cooldownEndsAt > now;
  // A11Y-fix #2: the row goes once resolved, so hand focus to the next row's Fulfil, else the card heading.
  const resolve = (id: string, kind: 'fulfil' | 'cancel', index: number) => {
    rescue(() => {
      const rows = list.current?.querySelectorAll<HTMLButtonElement>('.ct-queue__actions button:first-child');
      return rows?.length ? rows[Math.min(index, rows.length - 1)] : document.getElementById('ct-ink-title');
    });
    void adapter.resolveRedemption(id, kind);
  };
  const headline = reward.status === 'ready' ? 'Ink me is on Twitch' : reward.status === 'creating' ? 'Creating the reward on Twitch…' : 'Ink me is off';
  return <Card title="Ink me" sample={sample} id="ct-ink-title">
    <p className="ct-note">Channel-point reward <strong>“{reward.title}”</strong> · {reward.cost} points · {reward.perViewer} per viewer per stream · {reward.cooldownMinutes} min cooldown{cooling ? `, next in ${clock(reward.cooldownEndsAt! - now)}` : ''}.</p>
    {connected && <div className="ct-inkme" data-status={reward.status}>
      <label className="ct-switch">
        <input type="checkbox" role="switch" checked={on} disabled={reward.status === 'creating'} aria-describedby={off || failed ? 'ct-inkme-why' : undefined} onChange={event => void toggle(event.target.checked)}/>
        <span className="ct-switch__track" aria-hidden="true"/>
        <span><strong>{headline}</strong><span className="ct-note"> {on ? 'Viewers spend points to be drawn into a panel. You approve each one.' : off ? 'Turn it on to try again.' : 'Turn it on to create the reward on your channel.'}</span></span>
      </label>
      {(off || failed) && <div className="ct-inkme__why" id="ct-inkme-why" role="status" data-off-reason={reward.offReason}>
        <p><strong>{failed || reward.error || 'Ink me is off.'}</strong></p>
        {!chatInk && reward.chatFallback && <p className="ct-note" data-verbatim="chatFallback">{reward.chatFallback}</p>}
      </div>}
    </div>}
    {queue.length ? <ul className="ct-queue" ref={list}>
      {queue.map((entry, index) => <li key={entry.id}>
        <div><strong>@{entry.name}</strong> <span className="ct-chip ct-chip--sm">{entry.status === 'drawing' ? 'Drawing' : 'Queued'}</span><p className="ct-note">{entry.note} · {ago(now, entry.at)}</p></div>
        <div className="ct-queue__actions">
          <button type="button" className="ct-btn ct-btn--ink ct-btn--sm" onClick={() => resolve(entry.id, 'fulfil', index)}>Fulfil</button>
          <button type="button" className="ct-btn ct-btn--sm" onClick={() => resolve(entry.id, 'cancel', index)}>Refund</button>
        </div>
      </li>)}
    </ul> : <p className="ct-note">No one is waiting. New redemptions appear here.</p>}
    {done.length > 0 && <p className="ct-note">{done.map(entry => `@${entry.name} ${entry.status === 'fulfilled' ? 'inked' : 'refunded'}`).join(' · ')}</p>}
    {!connected && <p className="ct-note">Channel-point rewards need an Affiliate or Partner channel. Sample until you connect.</p>}
    {chatInk}
  </Card>;
}

/**
 * UI-LIVE-B #2: Ink me without channel points, as the server runs it (ink-chat.ts). The viewer copy, the limits and
 * every note are the server's own; times are UK 24-hour clock times.
 */
function InkChatRequests({ inkChat, reward, now, modApprove }: { inkChat: InkChatView; reward: InkMeReward; now: number; modApprove: boolean }) {
  const cooling = inkChat.cooldownEndsAt !== undefined && inkChat.cooldownEndsAt > now;
  const waiting = inkChatWaiting(inkChat);
  return <div className="ct-inkme__text" data-ink-chat="active">
    <p className="ct-kicker">!ink from chat</p>
    {inkChat.text && <p className="ct-note" data-verbatim="inkChat.text">{inkChat.text}</p>}
    <p className="ct-note">{reward.perViewer} per viewer per stream, one every {reward.cooldownMinutes} minutes. <strong data-ink-cooldown={cooling || undefined}>{cooling ? `Next !ink from ${time24(inkChat.cooldownEndsAt!)}.` : '!ink is open now.'}</strong></p>
    {!modApprove && <p className="ct-note">Chat answers are off on this studio, so approve cameos here in Waiting.</p>}
    {inkChat.note && <p className="ct-note" data-verbatim="inkChat.note">{inkChat.note}</p>}
    <p className="ct-sr" role="status" aria-live="polite">{waiting ? `${waiting} !ink ${waiting === 1 ? 'request' : 'requests'} waiting` : ''}</p>
    {inkChat.requests.length ? <ul className="ct-queue" aria-label="!ink requests from chat">
      {inkChat.requests.map(entry => <li key={entry.id} data-status={entry.status}>
        <div><strong>{entry.status === 'withdrawn' ? entry.name : `@${entry.name}`}</strong> <span className="ct-chip ct-chip--sm">{INK_CHAT_LABEL[entry.status]}</span>
          <p className="ct-note">{entry.note ? `${entry.note} · ` : ''}<time dateTime={new Date(entry.at).toISOString()}>{time24(entry.at)}</time></p></div>
      </li>)}
    </ul> : <p className="ct-note">No !ink requests yet.</p>}
  </div>;
}

export function SafetyCard() {
  const ui = useUi();
  const now = useNow();
  const adapter = useAdapter();
  const { optedOut, rules, lastCatchup } = ui.participation;
  return <Card title="Who sees what" id="ct-safe-title">
    <ul className="ct-rules">
      <li><strong>!noink</strong> Viewers who type it are never drawn or quoted. {adapter.kind === 'mock' && <span className="ct-sample">Sample</span>} {optedOut ? <span className="ct-chip ct-chip--sm">{optedOut} {optedOut === 1 ? 'viewer has' : 'viewers have'} opted out</span> : <span className="ct-muted">No one yet.</span>}</li>
      <li><strong>Raids</strong> {rules.raidCatchup ? 'Raiders get a three-panel “Previously on” on the overlay.' : 'Off.'}</li>
      <li><strong>!previously</strong> {rules.previouslyCommand ? 'Any viewer can replay the catch-up, once a minute.' : 'Off.'}</li>
      <li><strong>Mods</strong> {rules.modApprove ? 'Mods can type !ink yes or !ink no to approve a waiting panel.' : 'Only you approve panels.'}</li>
    </ul>
    {lastCatchup && <p className="ct-note">Last catch-up: {lastCatchup.reason === 'raid' ? `raid from @${lastCatchup.raider} with ${lastCatchup.viewers} viewers` : lastCatchup.reason === 'command' ? '!previously' : 'played by you'}, {ago(now, lastCatchup.at)}.</p>}
    <button type="button" className="ct-btn ct-btn--sm" onClick={() => void adapter.playCatchup()} disabled={!ui.studio.panels.length}>Play catch-up on the overlay</button>
  </Card>;
}

const KIND: Record<ChatLine['kind'], string> = { chat: '', command: 'Command', raid: 'Raid', redemption: 'Reward' };

/** BANNER-RAID-1: the page notes when the source's line count last changed, and re-renders when the quiet window ends. */
function useLiveChatQuiet(source: ChatSourceState, quietMs: number): boolean {
  const [mark, setMark] = useState(() => ({ received: source.received, at: Date.now() }));
  if (mark.received !== source.received) setMark({ received: source.received, at: Date.now() });
  const [now, setNow] = useState(mark.at);
  const due = mark.at + quietMs;
  const watching = isLiveChatQuiet(source, mark.at, due, quietMs);
  useEffect(() => {
    if (!watching) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, due - Date.now()));
    return () => clearTimeout(timer);
  }, [watching, due]);
  return isLiveChatQuiet(source, mark.at, now, quietMs);
}

/** Rebuilt ChatSource.tsx: where chat comes from, and what it is saying. `quietAfterMs`: see CHAT_QUIET_MS. */
export function ChatCard({ quietAfterMs = CHAT_QUIET_MS }: { quietAfterMs?: number }) {
  const ui = useUi();
  const { source } = ui.studio;
  const quiet = useLiveChatQuiet(source, quietAfterMs);
  const sample = isSampleSource(source);
  // UI-LIVE-B #1, #5, #6: the transport label only when the server gives one, no raw reason tokens, and a count that
  // agrees with the list. The words match the header chip (chatSourceChip).
  const channel = source.channel ? `#${source.channel}` : '';
  const label = source.active === 'twitch' || source.requested === 'twitch' ? channel || chatSourceChip(source) : 'Sample chat';
  // CHAT-BANNER-1: lines read stay read when chat goes quiet and the server shows Sample data meanwhile.
  const read = source.active === 'twitch' || source.requested === 'twitch' ? source.received : 0;
  return <Card title="Chat" sample={sample} id="ct-chat-title">
    <p className="ct-note" data-chat-state={source.connection}><strong>{label}</strong> · {chatStateText(source, quiet)}{read ? ` · ${read} read` : source.active !== 'twitch' && ui.chat.length ? ` · ${ui.chat.length} lines` : ''}</p>
    {!ui.chat.length && <p className="ct-note">{read ? 'Lines read before this page opened aren’t listed here. New lines show as they arrive.' : 'No chat yet. Lines show here as they arrive.'}</p>}
    <ol className="ct-chat" aria-live="off">
      {ui.chat.slice(-7).map(line => <li key={line.id} data-kind={line.kind}>
        {KIND[line.kind] && <span className="ct-chip ct-chip--sm">{KIND[line.kind]}</span>}
        <strong>{line.user}</strong> <span>{line.text}</span>
      </li>)}
    </ol>
  </Card>;
}
