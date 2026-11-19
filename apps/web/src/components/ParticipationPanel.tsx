import { useCallback, useEffect, useState } from 'react';
import './participation.css';

// Audience participation (S4). Shape mirrors GET /api/participation/status.
type Flags = { polls: boolean; twitchPolls: boolean; inkMe: boolean; catchup: boolean; hype: boolean; director: boolean; noink: boolean; botReplies: boolean };
type PollView = { id: string; panelId: string; mode: 'twitch' | 'chat'; endsAt: number; fallbackReason?: string; total: number; choices: { key: number; title: string; caption: string; votes: number }[] };
type PollResult = { outcome: string; caption?: string; voters: number; panelId?: string };
type Redemption = { id: string; name: string; at: number; status: 'drafted' | 'queued' | 'fulfilled' | 'canceled'; note: string };
type InkChat = { active: boolean; text: string; cooldownEndsAt?: number; note?: string; requests: { id: string; name: string; at: number; status: 'queued' | 'drafted' | 'approved' | 'rejected' | 'withdrawn'; note: string }[] };
type Status = {
  flags: Flags; budget: { perHour: number; used: number; remaining: number; resetAt?: number };
  poll: PollView | null; lastPollResult: PollResult | null;
  reward: { status: string; error?: string; title: string; cost: number; cooldownEndsAt?: number; redemptions: Redemption[] } | null;
  inkChat?: InkChat | null;
  catchups: { reason: string; at: number; raider?: string; viewers?: number }[];
  hype: { hype?: { level: number; phase: string; splashPanelId?: string }; prediction?: { title: string; status: string; outcomes: { title: string; users: number }[]; winner?: string }; punchline?: { text: string; panelId?: string }; error?: string } | null;
  director: { log: { action: string; by: string; via: string }[] } | null; optedOut: number;
};

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'That did not work. Try again.');
  return data;
}
const clock = (at?: number) => at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
const anyVisible = (flags: Flags) => flags.polls || flags.inkMe || flags.catchup || flags.hype || flags.director;

export function ParticipationPanel() {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const refresh = useCallback(async () => { try { setStatus(await call<Status>('/api/participation/status')); } catch { /* server offline: keep the last view */ } }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const live = !!status && anyVisible(status.flags);
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => { setNow(Date.now()); void refresh(); }, 1000);
    return () => window.clearInterval(timer);
  }, [live, refresh]);
  // Nothing to show with every feature switched off: the studio stays exactly as before.
  if (!status || !live) return null;
  const act = (path: string, body: unknown = {}) => { setError(''); call(path, body).then(refresh).catch((reason: Error) => setError(reason.message)); };
  const { flags, budget, poll, lastPollResult: result, reward, hype, inkChat } = status;
  const paused = budget.remaining === 0;
  const leader = poll ? Math.max(...poll.choices.map(choice => choice.votes)) : 0;
  return (
    <section className="pc-part" aria-label="Audience participation">
      {paused && <p className="pc-part__throttle" role="status">Panel budget: {budget.perHour} per hour. You’ve used {budget.used} of {budget.perHour} this hour. Votes and redemptions pause until {clock(budget.resetAt)}; redemptions stay unfulfilled, not lost.</p>}
      {error && <p className="pc-part__error" role="alert">{error}</p>}
      <div className="pc-part__grid">
        {flags.polls && <article className="pc-card" aria-labelledby="pc-vote-title">
          <header className="pc-card__head"><p className="pc-card__kicker">{poll?.mode === 'twitch' ? 'Twitch poll' : 'Chat vote'}</p><h2 id="pc-vote-title">Chat votes the bubble</h2>{poll && <span className="pc-card__timer" aria-label="Time left">{Math.max(0, Math.ceil((poll.endsAt - now) / 1000))}s</span>}</header>
          {poll ? <>
            <ol className="pc-vote">{poll.choices.map(choice => {
              const share = poll.total ? Math.round(choice.votes / poll.total * 100) : 0;
              return <li key={choice.key} className={choice.votes === leader && leader > 0 ? 'is-leading' : ''}><span className="pc-vote__key">{choice.key}</span><span className="pc-vote__text">“{choice.caption}”</span><span className="pc-vote__pct">{share}%</span><span className="pc-vote__bar" aria-hidden="true"><i style={{ width: `${share}%` }}/></span>{choice.votes === leader && leader > 0 && <span className="pc-vote__lead">← leading</span>}</li>;
            })}</ol>
            <p className="pc-note">{poll.mode === 'chat' ? `Viewers vote by typing ${poll.choices.map(choice => `!${choice.key}`).join(', ')} in chat.` : 'Viewers vote in the Twitch poll.'}{poll.fallbackReason && poll.mode === 'chat' && !poll.fallbackReason.startsWith('Twitch polls are off') ? ` ${poll.fallbackReason}` : ''}</p>
            <button type="button" className="pc-btn" onClick={() => act('/api/participation/polls/end')}>End vote now</button>
          </> : <>
            {result && <p className="pc-note" role="status">{result.outcome === 'applied' ? `Last vote: “${result.caption}” won with ${result.voters} ${result.voters === 1 ? 'vote' : 'votes'}.` : result.outcome === 'rendering' ? 'Winning line selected; rendering the revised picture.' : result.outcome === 'image-failed' ? 'Winning image revision failed; original picture retained.' : result.outcome === 'no-votes' ? 'Last vote: nobody voted, so the caption stayed.' : 'Last vote: the panel was already gone.'}</p>}
            <button type="button" className="pc-btn pc-btn--ink" disabled={paused} onClick={() => act('/api/participation/polls', { duration: 45 })}>Start a vote on the next panel</button>
            <p className="pc-note">{flags.twitchPolls ? 'Uses a Twitch poll. ' : ''}Not an Affiliate or Partner? Viewers vote by typing !1, !2 or !3 in chat instead.</p>
          </>}
        </article>}
        {flags.inkMe && reward && <article className="pc-card" aria-labelledby="pc-ink-title">
          <header className="pc-card__head"><p className="pc-card__kicker">Channel points</p><h2 id="pc-ink-title">{reward.title}</h2><span className="pc-coin" aria-label={`${reward.cost} points`}>{reward.cost}</span></header>
          <p className="pc-note">Custom reward · {reward.cost} points · 1 per viewer per stream · 5-minute global cooldown</p>
          {reward.status !== 'ready' && <><p className="pc-note" role="status">{reward.status === 'unavailable' ? `Reward not created: ${reward.error ?? 'Twitch said no.'} Channel points need Affiliate or Partner.` : 'Created when you connect Twitch.'}</p><button type="button" className="pc-btn" onClick={() => act('/api/participation/rewards/connect')}>Create reward</button></>}
          {inkChat?.active && <>
            <p className="pc-note" role="status">{inkChat.text}</p>
            {!flags.director && <p className="pc-note">Chat answers need director mode (COMICTOONS_FLAG_DIRECTOR=1). Until then, approve cameos in the review queue.</p>}
            {inkChat.note && <p className="pc-note">{inkChat.note}</p>}
            {inkChat.requests.length > 0 && <ul className="pc-redeem" aria-label="!ink requests from chat">{inkChat.requests.map(entry => <li key={entry.id}>
              <span className="pc-redeem__who">{entry.name}</span><span className="pc-redeem__note">{entry.note}</span>
            </li>)}</ul>}
            {inkChat.cooldownEndsAt && <p className="pc-note">Cooldown: !ink opens again at {clock(inkChat.cooldownEndsAt)}</p>}
          </>}
          {reward.redemptions.length > 0 && <ul className="pc-redeem">{reward.redemptions.map(entry => <li key={entry.id}>
            <span className="pc-redeem__who">{entry.name}</span><span className="pc-redeem__note">{entry.note}</span>
            {(entry.status === 'drafted' || entry.status === 'queued') && <span className="pc-redeem__actions">
              {entry.status === 'drafted' && <button type="button" className="pc-btn pc-btn--ink" onClick={() => act(`/api/participation/redemptions/${encodeURIComponent(entry.id)}`, { action: 'fulfil' })}>Fulfil</button>}
              <button type="button" className="pc-btn" onClick={() => act(`/api/participation/redemptions/${encodeURIComponent(entry.id)}`, { action: 'cancel' })}>Refund</button>
            </span>}
          </li>)}</ul>}
          {reward.cooldownEndsAt && <p className="pc-note">Cooldown: open again at {clock(reward.cooldownEndsAt)}</p>}
          <p className="pc-note">Refund marks the redemption cancelled so the viewer gets their points back. Only people who redeem are drawn in.</p>
        </article>}
        {(flags.catchup || flags.director || flags.noink) && <article className="pc-card" aria-labelledby="pc-safety-title">
          <header className="pc-card__head"><p className="pc-card__kicker">Catch-up &amp; safety</p><h2 id="pc-safety-title">Who sees what</h2></header>
          <ul className="pc-rules">
            <li><span>Raids trigger a “Previously on…”</span><b>{flags.catchup ? 'On' : 'Off'}</b></li>
            <li><span>Viewers can type !previously</span><b>{flags.catchup ? 'On' : 'Off'}</b></li>
            <li><span>Mods can approve with !ink yes / no</span><b>{flags.director ? 'On' : 'Off'}</b></li>
            <li><span>Respect !noink opt-outs</span><b>Always on</b></li>
          </ul>
          {status.optedOut > 0 && <p className="pc-note">{status.optedOut} {status.optedOut === 1 ? 'viewer has' : 'viewers have'} opted out. They are never drawn or quoted.</p>}
          {flags.catchup && <button type="button" className="pc-btn pc-btn--ink" onClick={() => act('/api/participation/catchup')}>▶ Play “Previously on…”</button>}
          {status.catchups[0] && <p className="pc-note">Last catch-up: {status.catchups[0].reason === 'raid' ? `raid${status.catchups[0].raider ? ` from ${status.catchups[0].raider}` : ''}` : status.catchups[0].reason === 'command' ? 'a viewer typed !previously' : 'you'} at {clock(status.catchups[0].at)}</p>}
          {flags.director && <p className="pc-note">On your phone, open <a href="/director">/director</a> to approve panels.</p>}
        </article>}
        {flags.hype && hype && <article className="pc-card" aria-labelledby="pc-hype-title">
          <header className="pc-card__head"><p className="pc-card__kicker">Hype train</p><h2 id="pc-hype-title">Splash &amp; punchline</h2></header>
          <p className="pc-note" role="status">{hype.hype ? (hype.hype.phase === 'begin' ? `Hype train level ${hype.hype.level}! ${hype.hype.splashPanelId ? 'The next panel is a full-page splash.' : 'The next panel becomes a full-page splash.'}` : 'The hype train has ended.') : 'When a hype train starts, the next panel becomes a full-page splash.'}</p>
          {hype.prediction && <p className="pc-note">Prediction “{hype.prediction.title}”: {hype.prediction.outcomes.map(outcome => `${outcome.title} ${outcome.users}`).join(' · ')}{hype.prediction.winner ? `. Result: ${hype.prediction.winner}.` : ''}</p>}
          {hype.punchline && <p className="pc-punch">{hype.punchline.text}</p>}
          {hype.error && <p className="pc-note">{hype.error}</p>}
        </article>}
      </div>
    </section>
  );
}
