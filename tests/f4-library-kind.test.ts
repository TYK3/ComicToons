import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Studio } from '../apps/server/src/studio.ts';
import { LibraryProvider } from '../apps/server/src/pipeline/library.ts';
import { eventBus } from '../packages/core/src/index.ts';
import type { ComicPanel } from '../packages/core/src/index.ts';
import { buildSyntheticSession, createDirectAdapter } from '../scripts/s2-replay-core.ts';

const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/art/generated/manifest.json'), 'utf8')) as { file: string; tags: string[] }[];
const tagsOf = (asset?: string) => manifest.find((entry) => entry.file === asset)?.tags ?? [];
/** The moment kind behind each kind-specific SFX the writer letters, and the manifest tags
 * that suit it (verdict-s2 check 4's mapping). */
const KIND_BY_SFX: Record<string, { kind: string; tags: string[] }> = {
  'RAID!': { kind: 'raid', tags: ['raid', 'arrival', 'crowd'] },
  'HYPE!': { kind: 'hype', tags: ['hype train', 'speed', 'subscribers'] },
  'CHEER!': { kind: 'cheer', tags: ['donation', 'sparkle', 'celebration'] },
  'SURGE!': { kind: 'burst', tags: ['emotes', 'spam'] },
  'SPIKE!': { kind: 'spike', tags: ['chat', 'hype', 'reaction'] },
  'INK!': { kind: 'redemption', tags: ['sparkle', 'celebration', 'victory'] },
  'VOTE!': { kind: 'poll', tags: ['cliffhanger', 'tension', 'comeback'] },
};

/** Library-only replay of the S2 synthetic session: no art pipeline is injected and the art
 * network flag is not set, so every panel keeps its library pick and nothing is fetched. */
function replayLibraryOnly(): ComicPanel[] {
  const session = buildSyntheticSession();
  const direct = createDirectAdapter();
  let clockMs = 0;
  const studio = new Studio({ now: () => clockMs, adapterFactory: () => direct.adapter});
  try {
    studio.useSource('twitch', 'synthetic_channel');
    let busIndex = 0;
    for (const event of session.chatEvents) {
      clockMs = Math.round(event.t * 1000);
      while (busIndex < session.busEvents.length && session.busEvents[busIndex]!.t <= event.t) eventBus.emit('stream-event', session.busEvents[busIndex++]!);
      direct.push(event);
    }
    while (busIndex < session.busEvents.length) eventBus.emit('stream-event', session.busEvents[busIndex++]!);
    return [...studio.state.panels, ...studio.state.pendingPanels].sort((a, b) => a.at - b.at);
  } finally { studio.close(); }
}

test('F4-LIB-01: library-only replay: every moment kind gets library art tagged for that kind', () => {
  const panels = replayLibraryOnly();
  assert.equal(panels.length,19,'the complete synthetic replay yields exactly 19 panels');
  const kinds = panels.filter((panel) => panel.sfx && KIND_BY_SFX[panel.sfx]);
  const seen = new Set(kinds.map((panel) => panel.sfx));
  for (const sfx of ['RAID!', 'HYPE!', 'CHEER!', 'SURGE!', 'SPIKE!', 'INK!', 'VOTE!']) assert.ok(seen.has(sfx), `the replay drafts a ${sfx} panel`);
  const lines = kinds.map((panel) => `${panel.sfx} -> ${panel.provenance?.asset} [${tagsOf(panel.provenance?.asset).join(', ')}]`);
  for (const panel of kinds) {
    assert.equal(panel.provenance?.provider, 'library', `${panel.sfx} is library art in this replay`);
    const want = KIND_BY_SFX[panel.sfx!]!;
    const tags = tagsOf(panel.provenance?.asset);
    assert.ok(want.tags.some((tag) => tags.includes(tag)), `${panel.sfx} (${want.kind}) got ${panel.provenance?.asset} [${tags.join(', ')}]\n${lines.join('\n')}`);
  }
  assert.equal(kinds.find((panel) => panel.sfx === 'HYPE!')?.provenance?.asset, 'panel-06-hype-train.webp', 'verdict-s2 check 4: HYPE! gets the hype-train art');
});

test('F4-LIB-02: a kind may take its matching art one tier above the least-used level, so chat taking it first does not steal it', () => {
  const provider = new LibraryProvider();
  const pick = (kind?: string) => provider.pickLiveImage({ style: 'risograph', kind })!.asset;
  // The verdict's failing order: chat panels use up the round, one of them the hype-train art.
  const chat = Array.from({ length: 9 }, () => pick('chat'));
  assert.ok(chat.includes('panel-06-hype-train.webp'), chat.join(','));
  assert.equal(new Set(chat).size, 9, 'chat still cycles the pool without repeats');
  assert.equal(pick('hype'), 'panel-06-hype-train.webp', 'hype reuses its art one tier up instead of taking unrelated art');
  assert.equal(pick('raid'), 'panel-05-raid-arrives.webp');
  // Two tiers up is too far: another hype in this round takes the least-used asset rather than
  // a third use of 06, and the hype-train art comes back once the round moves on.
  assert.equal(pick('hype'), 'panel-11-speedrun-record.webp', 'the only asset still unused this round');
  assert.equal(pick('hype'), 'panel-04-funny-fail.webp','after the round advances, free unreserved art prevents widening');
});

test('F4-LIB-03: free unreserved art prevents a kind from widening one tier up',()=>{
  const provider=new LibraryProvider();
  const first=provider.pickLiveImage({style:'risograph',kind:'raid'})!;
  assert.equal(first.asset,'panel-05-raid-arrives.webp');
  const second=provider.pickLiveImage({style:'risograph',kind:'raid'})!;
  assert.notEqual(second.asset,first.asset,'do not reuse the kind asset while unreserved art is still free');
  assert.ok(second.asset);
  assert.equal((tagsOf(second.asset)).includes('raid'),false);
});

test('F4-LIB-04: hype also stays in the fresh tier while unreserved art is available',()=>{
  const provider=new LibraryProvider();
  assert.equal(provider.pickLiveImage({style:'risograph',kind:'hype'})!.asset,'panel-06-hype-train.webp');
  assert.equal(provider.pickLiveImage({style:'risograph',kind:'hype'})!.asset,'panel-04-funny-fail.webp','unreserved art is still free, so hype must not reuse its matching asset');
});

test('F4-LIB-05: once chat exhausts unreserved art a kind reclaims its tagged asset one tier up',()=>{
  const provider=new LibraryProvider();
  for(let i=0;i<6;i++)provider.pickLiveImage({style:'risograph',kind:'chat'});
  assert.equal(provider.pickLiveImage({style:'risograph',kind:'chat'})!.asset,'panel-06-hype-train.webp');
  assert.equal(provider.pickLiveImage({style:'risograph',kind:'hype'})!.asset,'panel-06-hype-train.webp');
});
