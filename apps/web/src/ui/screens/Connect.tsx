import { canUseChannelFeatures, showSampleAccountBadge } from '../data/adapter';
import { studioPhase, useAdapter, useUi } from '../data/store';
import { RetryButton, ScreenState } from '../components/ScreenState';
import { Logo, Sample } from '../components/Brand';
import { AffiliateNotice, ConnectButton, KEYLESS_BODY, KEYLESS_TITLE, TryAgain } from '../components/TwitchConnect';
import { isKeyless } from './studio/live';
import { Arrow } from '../components/Icons';
import { twitchErrorCopy } from '../data/twitch-copy';
import { href } from '../router';
import '../styles/connect.css';

const SCOPES = [
  { scope: 'chat:read', why: 'Read chat through the read-only IRC fallback.' },
  { scope: 'bits:read', why: 'Turn cheers into live comic moments.' },
  { scope: 'channel:read:hype_train', why: 'Follow hype train moments.' },
  { scope: 'user:read:chat', why: 'Read your chat, so the writer knows what’s happening.' },
  { scope: 'channel:manage:redemptions', why: 'Create the Ink me reward and mark redemptions done or refunded.' },
  { scope: 'channel:manage:polls', why: 'Run “Chat votes the bubble” as a real Twitch poll.' },
  { scope: 'channel:manage:predictions', why: 'Start and pay out predictions about what happens next.' },
];

export function Connect() {
  const ui = useUi();
  const adapter = useAdapter();
  const { twitch } = ui;
  const affiliate = canUseChannelFeatures(twitch);
  // UI3: until the studio answers we don't know the sign-in state, so no Connect button and no made-up account.
  const phase = studioPhase(ui);
  const known = phase === 'ready' || phase === 'empty';
  const keyless = isKeyless(twitch);
  const features = [
    { name: 'Live chat into panels', ok: true },
    { name: 'Raids get a “Previously on” catch-up', ok: true },
    { name: 'Chat votes with !1, !2, !3', ok: true },
    { name: 'Ink me channel-point reward', ok: affiliate },
    { name: 'Twitch polls and predictions', ok: affiliate },
  ];
  return <div className="ct-app ct-connect">
    <header className="ct-appbar ct-on-ink">
      <Logo/>
      <div className="ct-appbar__right"><a className="ct-btn ct-btn--back ct-btn--sm" href={href('/studio')}><Arrow dir="left"/>Studio</a></div>
    </header>
    <main className="ct-connect__main" id="ct-main">
      <section className="ct-connect__card" aria-labelledby="ct-connect-title" aria-busy={twitch.state === 'connecting' || phase === 'loading' || undefined}>
        <p className="ct-kicker">Optional</p>
        <h1 id="ct-connect-title" className="ct-display">{known && twitch.state === 'connected' ? <>You’re in, @{twitch.login}</> : <>Bring your chat in</>}</h1>

        {phase === 'loading' && <ScreenState kind="loading" compact title="Checking your sign-in">
          <p>Asking the studio whether you’re already signed in to Twitch…</p>
        </ScreenState>}

        {phase === 'error' && <ScreenState kind="error" compact title="The studio isn’t answering" actions={<RetryButton onRetry={() => void adapter.refresh()} busy={ui.busy === 'refresh'}/>}>
          <p>{ui.error || 'ComicToons couldn’t reach the studio server on this computer.'}</p>
          <p>Signing in to Twitch goes through the studio on your computer. Check ComicToons is running there, then try again.</p>
        </ScreenState>}

        {known && twitch.state === 'signed-out' && <>
          <p className="ct-connect__lede">Sign in with Twitch and your own chat starts writing the comic. Until then the studio runs on a Sample stream, so you can try everything first.</p>
          <ConnectButton wide/>
          <p className="ct-note">Sample data until you connect.</p>
        </>}

        {known && twitch.state === 'connecting' && <>
          <p className="ct-connect__lede">Twitch opened in a new tab. Approve ComicToons there and you’ll come straight back here.</p>
          <ConnectButton wide/>
          <button type="button" className="ct-btn ct-btn--ghost" onClick={() => void adapter.cancelConnect()}>Cancel</button>
        </>}

        {/* UI-HEAD #4: a keyless computer never tried a sign-in, so this is set-up copy, not a failure. */}
        {known && keyless && <>
          <p className="ct-connect__lede">For now the studio runs on a Sample stream, so you can try everything first.</p>
          <div className="ct-banner ct-banner--paper ct-connect__err" role="status" aria-live="polite" data-keyless>
            <p id="ct-keyless-note"><strong>{KEYLESS_TITLE}</strong> {KEYLESS_BODY}</p>
          </div>
          <div className="ct-connect__acts">
            <ConnectButton wide/>
            <a className="ct-btn ct-btn--ghost" href={href('/studio')}>Use Sample data</a>
          </div>
        </>}

        {known && twitch.state === 'error' && !keyless && <>
          {/* W4 + item 9: purple Connect is the one primary (a new sign-in); the ink Try again only re-checks Twitch. */}
          <div className="ct-banner ct-banner--paper ct-connect__err" role="status" aria-live="polite">
            <p><strong>{twitchErrorCopy(twitch.error).heading}</strong> {twitch.error ?? 'You may have cancelled it, or Twitch didn’t answer.'} Your sample replay is still running.</p>
            <TryAgain/>
          </div>
          <div className="ct-connect__acts">
            <ConnectButton wide/>
            <button type="button" className="ct-btn ct-btn--ghost" onClick={() => adapter.dismissTwitchError()}>Dismiss</button>
          </div>
          <p className="ct-note">Try again checks whether you finished signing in on Twitch. Connect with Twitch starts a new sign-in.</p>
        </>}

        {known && twitch.state === 'connected' && <>
          <p className="ct-connect__lede">{affiliate ? 'Everything is switched on. Live chat is feeding the studio now.' : 'Live chat is feeding the studio now. A couple of extras wait for Affiliate.'} {showSampleAccountBadge(adapter.kind, twitch) && <Sample label="Sample account"/>}</p>
          <ul className="ct-ready" aria-label="What’s ready">
            {features.map(feature => <li key={feature.name} data-ok={feature.ok}><span aria-hidden="true">{feature.ok ? '✓' : '–'}</span>{feature.name}<span className="ct-sr">{feature.ok ? ': ready' : ': needs Affiliate or Partner'}</span></li>)}
          </ul>
          {!affiliate && <AffiliateNotice feature="Ink me" fallback={ui.participation.reward.chatFallback}/>}
          <div className="ct-connect__acts">
            <a className="ct-btn ct-btn--ink" href={href('/studio')}>Open the studio <Arrow/></a>
            <button type="button" className="ct-btn ct-btn--ghost" onClick={() => void adapter.disconnectTwitch()}>Disconnect</button>
          </div>
        </>}
        <p className="ct-sr" role="status" aria-live="polite">{twitch.state === 'connecting' ? 'Waiting for Twitch.' : twitch.state === 'connected' ? `Connected as @${twitch.login}.` : ''}</p>
      </section>

      <aside className="ct-connect__why" aria-labelledby="ct-scope-title">
        <h2 id="ct-scope-title" className="ct-display">What we ask Twitch for</h2>
        <ul className="ct-scopes">
          {(ui.requestedScopes??SCOPES.map(item=>item.scope)).map(scope=>({scope,why:SCOPES.find(item=>item.scope===scope)?.why??(scope==='user:write:chat'?'Send chat acknowledgements when bot replies are enabled.':'Enable the configured Twitch feature.')})).map(item => <li key={item.scope}><code>{item.scope}</code><p>{item.why}</p></li>)}
        </ul>
        <p className="ct-note">Polls, predictions and channel-point rewards are Twitch features for Affiliate and Partner channels. On any other channel ComicToons skips them and uses chat votes instead.</p>
        <p className="ct-note">We never see your stream key or whispers. Disconnect here, or remove ComicToons under Connections in your Twitch settings.</p>
      </aside>
    </main>
  </div>;
}
