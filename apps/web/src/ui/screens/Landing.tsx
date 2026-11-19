import { useEffect, useRef, useState } from 'react';
import type { IssueView, LookId, UiPanel } from '../data/adapter';
import { useAdapter, useLoad, useUi } from '../data/store';
import { Logo, Sample } from '../components/Brand';
import { LookArt, Panel } from '../components/Panel';
import { LookPicker } from '../components/LookPicker';
import { ConnectButton } from '../components/TwitchConnect';
import { Arrow } from '../components/Icons';
import { RetryButton, ScreenState } from '../components/ScreenState';
import { href, useRoute } from '../router';
import { reducedMotion, useReveal } from '../motion';
import { libraryArt } from '../data/art';
import { HeroDrift } from './landing/HeroDrift';
import { SampleSets } from './landing/SampleSets';
import '../styles/landing.css';

const ISSUE_IDS = ['sample-tabletop-night', 'sample-speedrun-fail', 'sample-irl-cooking'];

/**
 * L-FB: a fresh server has no approved panels, so the hero plate, the Featured page and the What it makes cards
 * borrow the library art bundled with the app (fixtures/art/generated, 1280×720, no network). Always shown as Sample.
 * Order matters: [1] is the hero plate; the Featured page shows them all. (LANDING-2: What it makes now shows the
 * full Sample sets from ./landing/sampleSetData.ts instead of cards.)
 */
const SAMPLE_ART = [
  { file: 'panel-02-clutch-comeback.webp', caption: 'Clutch comeback', line: 'One hit point. Still counts!', sfx: 'YES!', alt: 'Sample art: a streamer in a purple hoodie cheers with both arms up while her cat celebrates beside the desk.' },
  { file: 'panel-03-boss-fight.webp', caption: 'The boss wakes up', line: 'Chat, do not say it.', sfx: 'BOOM!', alt: 'Sample art: a streamer grips her controller as a huge shadowy boss fills the screen, her cat watching.' },
  { file: 'panel-05-raid-arrives.webp', caption: 'The raid arrives', line: 'Welcome in, raiders!', alt: 'Sample art: a crowd of cheerful creatures pours across a rainbow bridge towards a castle in the clouds.' },
  { file: 'panel-06-hype-train.webp', caption: 'Hype train, all aboard', line: 'Level five. Keep it going!', sfx: 'CHOO!', alt: 'Sample art: a golden steam train with a star on the front races past a cheering crowd at sunset.' },
  { file: 'panel-11-speedrun-record.webp', caption: 'New personal best', line: 'Frame perfect. FRAME PERFECT!', alt: 'Sample art: the streamer sprints through a finish ribbon, her cat running alongside.' },
  { file: 'panel-12-cooking-chaos.webp', caption: 'Kitchen chaos', line: 'That is meant to be on fire.', sfx: 'FWOOSH!', alt: 'Sample art: the streamer flips a pan as flames leap up in a busy kitchen, her cat ducking by the pot.' },
] as const;

function samplePanels(): UiPanel[] {
  return SAMPLE_ART.flatMap((entry, index) => {
    const art = libraryArt.find(asset => asset.file === entry.file);
    if (!art) return [];
    return [{
      id: `sample-landing-${index}`, origin: 'sample', caption: entry.caption, dialogue: [entry.line], altText: entry.alt,
      imageUrl: art.url, art: { width: art.width, height: art.height, tone: art.tone }, sfx: 'sfx' in entry ? entry.sfx : undefined,
      source: 'generated', generatedCaption: false, at: index * 120, bubblePlacement: index % 2 ? 'top-right' : 'bottom-left',
      provenance: { provider: 'library', asset: art.file, style: 'risograph', fallback: true },
    } satisfies UiPanel];
  });
}
const SAMPLE_PANELS = samplePanels();

export function Landing() {
  const ui = useUi();
  const adapter = useAdapter();
  const root = useRef<HTMLDivElement>(null);
  const look = ui.studio.look;
  // The landing page previews bundled stories; saved live issues stay in the workspace/readers.
  const issues = useLoad(async () => (await Promise.all(ISSUE_IDS.map(id => adapter.getIssue(id, look)))).filter(issue => issue.panels.length), [adapter, look]);
  const retryShelf = () => { void adapter.refresh().finally(issues.retry); };
  useReveal(root, [issues.data]);
  const fromSample = true;
  const panels = SAMPLE_PANELS;
  const plate = panels[1] ?? panels[0];
  return <div className="ct-landing" ref={root}>
    <a className="ct-skip" href="#ct-main">Skip to content</a>
    {/* A11Y-fix #11: one main landmark from the hero to the last section; the footer stays outside. The skip link still lands on the hero copy. */}
    <main className="ct-landing__main">
    <section className="ct-hero ct-on-ink" aria-labelledby="ct-hero-title">
      {plate && <div className="ct-hero__plate" aria-hidden="true"><LookArt panel={plate} look={ui.studio.look} eager/><span className="ct-hero__tone"/><span className="ct-hero__lines"/></div>}
      <HeroDrift/>
      {plate && fromSample && <p className="ct-hero__sample"><Sample label="Sample art"/></p>}
      <header className="ct-hero__nav">
        <Logo/>
        <nav className="ct-pill" aria-label="Main">
          <a href="#ct-how">How it works</a>
          <a href="#ct-makes">What it makes</a>
          <a href={href('/connect')}>Connect Twitch</a>
          <a className="ct-pill__cta" href={href('/studio',{workspace:'live'})}>Live Studio</a>
        </nav>
      </header>
      <div className="ct-hero__copy" id="ct-main">
        <p className="ct-kicker" data-reveal="fade">A live comic for Twitch streams <Sample/></p>
        <h1 id="ct-hero-title" className="ct-display ct-hero__title" data-reveal="slam"><span>Your stream,</span> <span>inked live.</span></h1>
        <p className="ct-hero__sub" data-reveal="up" data-delay="120">Chat’s best moments become comic panels on your overlay as they happen. You approve every one. When you log off, the whole night is a comic you can share.</p>
        <div className="ct-hero__cta" data-reveal="up" data-delay="200">
          <ConnectButton/>
          <a className="ct-btn ct-btn--paper" href={href('/studio',{workspace:'sample'})}>Try Sample demo <Arrow/></a>
        </div>
        <p className="ct-hero__note" data-reveal="up" data-delay="240">No sign-in needed: try the Sample stream, or connect your Twitch account.</p>
      </div>
      <div className="ct-issues" aria-label="Sample issues" aria-busy={!issues.data && !issues.error ? true : undefined}>
        {issues.error ? <ScreenState kind="error" compact className="ct-issues__state" title="The issues didn’t load" actions={<>
          <RetryButton onRetry={retryShelf} busy={issues.retrying}/>
          <a className="ct-btn" href={href('/studio')}>Open Studio</a>
        </>}><p>{issues.error} Check ComicToons is running on the studio computer, then try again.</p></ScreenState>
          : !issues.data ? <>
            <p className="ct-sr" role="status" aria-live="polite">Loading the issues…</p>
            {[0, 1, 2].map(index => <div key={index} className="ct-cover ct-skel" aria-hidden="true"/>)}
          </>
          : !issues.data.length ? <ScreenState kind="empty" compact className="ct-issues__state" title="No issues yet" actions={<a className="ct-btn ct-btn--ink" href={href('/studio')}>Open Studio</a>}>
            <p>An issue is bound when a stream ends. Open the Studio, approve a few panels, and your first cover lands here.</p>
          </ScreenState>
          : issues.data.map((issue, index) => <Cover key={issue.id} issue={issue} index={index} look={ui.studio.look}/>)}
      </div>
    </section>

    <section className="ct-about" aria-label="About">
      <p className="ct-about__line" data-reveal="up"><span>Chat is already telling the story.</span> <span className="ct-about__soft">ComicToons just draws it, panel by panel, while you keep playing.</span></p>
    </section>

    <section className="ct-feature" id="ct-how" aria-labelledby="ct-how-title">
      <Featured panels={panels}/>
      <div className="ct-glass" data-reveal="up" data-delay="100">
        <h2 id="ct-how-title" className="ct-display">How it works</h2>
        <ol className="ct-steps">
          <li><span className="ct-steps__body"><strong>Connect your channel.</strong> Or skip it and try the Sample stream first.</span></li>
          <li><span className="ct-steps__body"><strong>Chat does its thing.</strong> Big reactions, votes and raids are spotted as they happen.</span></li>
          <li><span className="ct-steps__body"><strong>You say yes or no.</strong> Each new panel waits for you, with a panic button always in reach.</span></li>
          <li><span className="ct-steps__body"><strong>It hits the overlay.</strong> One OBS browser source, in the Look you pick.</span></li>
        </ol>
        <div className="ct-glass__look"><LookPicker/></div>
      </div>
    </section>

    <section className="ct-versus" aria-labelledby="ct-versus-title">
      <h2 id="ct-versus-title" className="ct-display" data-reveal="up">Streamer <span aria-hidden="true">×</span><span className="ct-sr">and</span> Chat</h2>
      <div className="ct-versus__cols">
        <div className="ct-versus__col" data-reveal="left">
          <h3>You stay the editor</h3>
          <ul>
            <li>Approve, reject or rewrite any caption before it airs.</li>
            <li>Panic hide clears the overlay in one press.</li>
            <li>Anyone who types <code>!noink</code> is never drawn or quoted.</li>
          </ul>
        </div>
        <div className="ct-versus__col ct-versus__col--ink ct-on-ink" data-reveal="up" data-delay="120">
          <h3>Chat gets a say</h3>
          <ul>
            <li>Vote on the speech bubble with <code>!1</code>, <code>!2</code> or <code>!3</code>.</li>
            <li>Spend channel points to get inked in as a cameo.</li>
            <li>Raiders land on a “Previously on” so they’re never lost.</li>
          </ul>
        </div>
      </div>
    </section>

    <section className="ct-makes" id="ct-makes" aria-labelledby="ct-makes-title">
      <div className="ct-makes__head">
        <h2 id="ct-makes-title" className="ct-display" data-reveal="up">What it makes</h2>
        <p className="ct-makes__lede">Choose a Sample story. See the catch-up, then pick how to read the same panels: a paged comic book or an episodic manga series. Open the full reader when you’re ready.</p>
      </div>
      <SampleSets/>
    </section>

    </main>

    <footer className="ct-footer ct-on-ink">
      <div className="ct-footer__edge" aria-hidden="true"/>
      <div className="ct-footer__inner">
        <Logo/>
        <nav aria-label="Footer">
          <a href={href('/studio',{workspace:'sample'})}>Sample Studio</a>
          <a href={href('/studio',{workspace:'live'})}>Live Studio</a>
          <a href={href('/overlay',{workspace:'sample'})}>Sample overlay</a>
          <a href={href('/director',{workspace:'sample'})}>Sample director</a>
          <a href={href('/connect')}>Sign in</a>
        </nav>
        <p className="ct-footer__note">Everything on this page is Sample data. ComicToons is not made by or affiliated with Twitch.</p>
      </div>
    </footer>
  </div>;
}

function Cover({ issue, index, look }: { issue: IssueView; index: number; look: LookId }) {
  const lead = issue.panels[index % issue.panels.length]!;
  return <a className="ct-cover" href={href(`/book/${issue.id}`)} data-reveal="up" data-delay={String(160 + index * 90)}>
    <span className="ct-cover__art"><LookArt panel={lead} look={look}/></span>
    <span className="ct-cover__no">No. {index + 1}</span>
    <span className="ct-cover__title">{issue.title}</span>
    <span className="ct-cover__by"><span>@{issue.channel}</span><span className="ct-sample">Sample</span></span>
    <span className="ct-cover__read">Read full <Arrow/></span>
  </a>;
}

function Featured({ panels }: { panels: UiPanel[] }) {
  const [index, setIndex] = useState(0);
  const frozen = useRoute().params.get('freeze') === '1';
  const [paused, setPaused] = useState(() => reducedMotion() || frozen);
  const list = panels.length ? panels : [];
  useEffect(() => {
    if (paused || list.length < 2) return;
    const timer = setInterval(() => setIndex(value => (value + 1) % list.length), 3600);
    return () => clearInterval(timer);
  }, [paused, list.length]);
  if (!list.length) return null;
  return <figure className="ct-featured" data-reveal="up">
    <div className="ct-featured__stack">
      {list.map((panel, at) => <div key={panel.id} className="ct-featured__slide" data-on={at === index % list.length || undefined} aria-hidden={at !== index % list.length}>
        <Panel panel={panel} tags={false}/>
      </div>)}
    </div>
    <figcaption className="ct-featured__bar">
      <span><strong>Featured page</strong> · panel {index % list.length + 1} of {list.length} <Sample/></span>
      <span className="ct-row">
        <button type="button" className="ct-btn ct-btn--sm" aria-label="Previous panel" onClick={() => setIndex(value => (value - 1 + list.length) % list.length)}><Arrow dir="left"/></button>
        <button type="button" className="ct-btn ct-btn--sm" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? 'Play' : 'Pause'}</button>
        <button type="button" className="ct-btn ct-btn--sm" aria-label="Next panel" onClick={() => setIndex(value => (value + 1) % list.length)}><Arrow/></button>
      </span>
    </figcaption>
  </figure>;
}
