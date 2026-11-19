import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DEFAULT_MANGA_THEME, MANGA_THEME_IDS, mangaThemes, resolveMangaTheme, mangaThemeStyles, lookStyles,
} from '../packages/core/src/index.ts';
import { LOOKS, resolveLook, showSampleAccountBadge } from '../apps/web/src/ui/data/adapter.ts';
import { RECIPE } from '../apps/web/src/ui/export.ts';
import { Studio } from '../apps/server/src/studio.ts';
import { chooseLook, recapSignature } from '../apps/server/src/recaps.ts';

const EXPECTED_IDS = ['festival', 'sunset', 'lagoon', 'blossom'];

test('THEMES4-IDS: exactly 4 theme ids, in order, festival first and the default', () => {
  assert.deepEqual(MANGA_THEME_IDS, EXPECTED_IDS);
  assert.deepEqual(mangaThemes.map((theme) => theme.id), EXPECTED_IDS);
  assert.equal(DEFAULT_MANGA_THEME, 'festival');
  assert.equal(EXPECTED_IDS[0], 'festival');
});

test('THEMES4-RESOLVE: legacy ids, junk and undefined all resolve to festival; real ids stay themselves', () => {
  for (const legacy of ['ink', 'noir', 'pop', undefined, 'sepia', '', 123, null, {}]) assert.equal(resolveMangaTheme(legacy), 'festival');
  for (const id of EXPECTED_IDS) assert.equal(resolveMangaTheme(id), id);
});

// WCAG 2.x relative luminance / contrast ratio, computed directly from the hex palette (no DOM, no canvas).
function channel(value: number): number { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
function rgb(hex: string): [number, number, number] { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function luminance(hex: string): number { const [r, g, b] = rgb(hex); return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b); }
function contrast(a: string, b: string): number { const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (l1 + 0.05) / (l2 + 0.05); }
function rgbDistance(a: string, b: string): number { const [ar, ag, ab] = rgb(a); const [br, bg, bb] = rgb(b); return Math.sqrt((ar - br) ** 2 + (ag - bg) ** 2 + (ab - bb) ** 2); }

test('THEMES4-CONTRAST: every palette clears 4.5:1 for balloon text on balloon fill, and ink on paper', () => {
  for (const theme of mangaThemes) {
    assert.ok(contrast(theme.palette.balloon.text, theme.palette.balloon.fill) >= 4.5, `${theme.id} balloon text/fill contrast`);
    assert.ok(contrast(theme.palette.ink, theme.palette.paper) >= 4.5, `${theme.id} ink/paper contrast`);
  }
});

test('THEMES4-DISTINCT: the 4 wash mid colours are clearly different from each other', () => {
  const mids = mangaThemes.map((theme) => theme.palette.wash.mid);
  for (let i = 0; i < mids.length; i += 1) for (let j = i + 1; j < mids.length; j += 1) assert.ok(rgbDistance(mids[i]!, mids[j]!) >= 40, `${mangaThemes[i]!.id} vs ${mangaThemes[j]!.id} wash mid`);
});

test('THEMES4-NO-DOTS: no radial-gradient or dot pattern in any generated CSS', () => {
  const sources: Record<string, string> = {
    lookStyles, mangaThemeStyles,
    'looks.css': readFileSync(new URL('../apps/web/src/ui/styles/looks.css', import.meta.url), 'utf8'),
  };
  for (const [name, css] of Object.entries(sources)) {
    assert.doesNotMatch(css, /radial-gradient/i, `${name} has no radial-gradient`);
    assert.doesNotMatch(css, /dots?\s*\(/i, `${name} has no dots() helper`);
    assert.doesNotMatch(css, /halftone/i, `${name} has no halftone`);
  }
});

test('THEMES4-LOOKS: the UI LOOKS list has exactly 4 entries, matching core', () => {
  assert.equal(LOOKS.length, 4);
  assert.deepEqual(LOOKS.map((look) => look.id), EXPECTED_IDS);
  for (const look of LOOKS) {
    const theme = mangaThemes.find((entry) => entry.id === look.id)!;
    assert.equal(look.name, theme.name);
    assert.equal(look.short, theme.short);
    assert.equal(look.blurb, theme.blurb);
    assert.equal(look.tone, 'colour');
  }
  for (const legacy of ['ink', 'noir', 'pop']) assert.equal(resolveLook(legacy), 'festival');
  assert.equal(resolveLook(undefined), 'festival');
});

test('THEMES4-RECIPE: export RECIPE has exactly the 4 theme ids as keys', () => {
  assert.deepEqual(Object.keys(RECIPE).sort(), [...EXPECTED_IDS].sort());
});

test('THEMES4-CHOOSELOOK: chooseLook maps legacy ids to festival, rejects junk, and no/legacy theme in state resolves to festival', () => {
  assert.equal(chooseLook({ mangaTheme: undefined }), 'festival');
  assert.equal(chooseLook({ mangaTheme: 'ink' }), 'festival');
  assert.equal(chooseLook({}, 'ink'), 'festival');
  assert.equal(chooseLook({}, 'noir'), 'festival');
  assert.equal(chooseLook({}, 'pop'), 'festival');
  assert.equal(chooseLook({}, 'sunset'), 'sunset');
  assert.throws(() => chooseLook({}, 'sepia'), /Unknown Look\./);
  // The signature a saved recap is keyed by also normalises a missing or legacy theme to festival.
  assert.equal(recapSignature({ mangaTheme: undefined } as Parameters<typeof recapSignature>[0]), recapSignature({ mangaTheme: 'festival' } as Parameters<typeof recapSignature>[0]));
  assert.equal(recapSignature({ mangaTheme: 'ink' } as Parameters<typeof recapSignature>[0]), recapSignature({ mangaTheme: 'festival' } as Parameters<typeof recapSignature>[0]));
});

test('THEMES4-SETTINGS: Studio.settings stores a legacy mangaTheme as festival', () => {
  const studio = new Studio();
  try {
    studio.settings({ mangaTheme: 'ink' });
    assert.equal(studio.state.mangaTheme, 'festival');
    studio.settings({ mangaTheme: 'sunset' });
    assert.equal(studio.state.mangaTheme, 'sunset');
  } finally { studio.close(); }
});

test('THEMES4-BADGE: showSampleAccountBadge is only true for a connected mock account', () => {
  assert.equal(showSampleAccountBadge('mock', { state: 'connected' }), true);
  assert.equal(showSampleAccountBadge('server', { state: 'connected' }), false);
  assert.equal(showSampleAccountBadge('mock', { state: 'signed-out' }), false);
  assert.equal(showSampleAccountBadge('server', { state: 'signed-out' }), false);
});
