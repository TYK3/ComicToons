/**
 * LANDING-2: the Sample sets on the landing page, one per fixture, each a complete set (Catch-up, comic book, manga series).
 *
 * The shape follows the apps/web/public/samples/manifest.json contract (SAMPLE-SETS-1):
 * {fixtures:[{id,title,theme,catchup:{…},comicBook:{cover,pages[]},manga:{volumes:[{title,pages[]}]}}]}.
 * That manifest has not landed yet, so the sets are STUBBED from the existing fixtures: the Sample issue and series the
 * adapter already serves for each fixture (data/mock.ts, built with the real buildSeries), plus the raid line read from
 * the fixture's own raid event. Nothing here touches the network (tests/ui-no-network.test.ts).
 *
 * The switch to the manifest is ONE line: `loadSampleSets` at the bottom. Point it at a reader of the manifest.
 */
import type { CatchupView, ComicToonsAdapter, LookId, UiPanel } from '../../data/adapter';
import { toPages } from '../../components/ComicPage';
import tabletopNight from '../../../../../../fixtures/tabletop-night.json';
import speedrunFail from '../../../../../../fixtures/speedrun-fail.json';
import irlCooking from '../../../../../../fixtures/irl-cooking.json';

export const SAMPLE_FIXTURES = ['tabletop-night', 'speedrun-fail', 'irl-cooking'] as const;
export type SampleFixtureId = typeof SAMPLE_FIXTURES[number];

export interface SampleVolume { number: number; title: string; chapter: string; highlight: UiPanel; pages: UiPanel[][] }
export interface SampleSet {
  /** The reader id (`sample-<fixture>`), so the full Book and Series screens open the same issue. */
  id: string;
  fixtureId: SampleFixtureId;
  title: string;
  streamTitle: string;
  channel: string;
  catchup: CatchupView;
  comicBook: { cover: UiPanel; pages: UiPanel[][] };
  manga: { volumes: SampleVolume[] };
  /** Always true: every set on the landing page is Sample data and is labelled so. */
  sample: true;
}

interface FixtureEvent { type: string; from?: string; viewers?: number }
const FIXTURES: Record<SampleFixtureId, { events: FixtureEvent[] }> = { 'tabletop-night': tabletopNight, 'speedrun-fail': speedrunFail, 'irl-cooking': irlCooking };

/** The raid line comes from the fixture's raid event (made-up names), never invented here. */
export function raidLine(fixtureId: SampleFixtureId): string | undefined {
  const raid = FIXTURES[fixtureId].events.find(event => event.type === 'raid' && event.from);
  return raid ? `${raid.from} raided with ${raid.viewers ?? 'some'} viewers. Here’s what they missed.` : undefined;
}

/** Catch-up shows the last three approved panels, the way GET /api/catchup trims to the time window. */
const CATCHUP_PANELS = 3;

async function fromFixtures(adapter: ComicToonsAdapter, look: LookId): Promise<SampleSet[]> {
  const sets = await Promise.all(SAMPLE_FIXTURES.map(async (fixtureId): Promise<SampleSet | undefined> => {
    const id = `sample-${fixtureId}`;
    const [issue, series] = await Promise.all([adapter.getIssue(id, look), adapter.getSeries(id, look)]);
    if (!issue.panels.length) return undefined;
    const cover = issue.panels.find(panel => panel.sfx) ?? issue.panels[0]!;
    return {
      id, fixtureId, title: issue.title, streamTitle: issue.streamTitle, channel: issue.channel, sample: true,
      catchup: { channel: issue.channel, minutes: 15, panels: issue.panels.slice(-CATCHUP_PANELS), raidLine: raidLine(fixtureId), sample: true },
      comicBook: { cover, pages: toPages(issue.panels) },
      manga: { volumes: series.episodes.map(episode => ({ number: episode.number, title: episode.title, chapter: episode.chapter, highlight: episode.highlight, pages: toPages(episode.panels) })) },
    };
  }));
  return sets.filter((set): set is SampleSet => Boolean(set));
}

/** The one switch: today the fixture stub; when manifest.json lands, a manifest reader with the same SampleSet[] result. */
export const loadSampleSets: (adapter: ComicToonsAdapter, look: LookId) => Promise<SampleSet[]> = fromFixtures;
