import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// POLISH-1 (critique-themes4.md N2, N4, N6, N7 and critique-festival-ui-p1.md NTH2-NTH7). Static checks on
// the shipped CSS and markup; the e2e and shots cover the rendered result.
const read = (path: string) => readFileSync(new URL(`../apps/web/src/ui/${path}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (css: string, selector: string) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(match, `missing rule ${selector}`);
  return match[1];
};
const px = (body: string, prop: string) => Number(body.match(new RegExp(`${prop}:(\\d+)px`))?.[1] ?? 0);

test('N2: overlay lead caption, bubble, generated label and credit are readable on a 720p source', () => {
  const css = read('styles/overlay.css');
  // The stage is 1920 wide; a 1280×720 source shows it at 2/3, so 24px on the stage is 16px on screen.
  assert.ok(px(rule(css, '.ct-ov-lead .ct-caption'), 'font-size') >= 24);
  assert.ok(px(rule(css, '.ct-ov-lead .ct-bubble'), 'font-size') >= 26);
  assert.ok(px(rule(css, '.ct-ov-lead .ct-gen'), 'font-size') >= 16);
  assert.ok(px(rule(css, '.ct-ov-credit'), 'font') >= 22 || /font:700 (2[2-9]|3\d)px/.test(rule(css, '.ct-ov-credit')));
});

test('NTH7: the overlay poll bar is a solid teal fill with an ink edge', () => {
  const body = rule(read('styles/overlay.css'), '.ct-ov-poll li i');
  assert.match(body, /background:var\(--act\)/);
  assert.match(body, /border-right:3px solid var\(--ink\)/);
});

test('N4: the Connect headline and rows wrap inside the card', () => {
  const css = read('styles/connect.css');
  assert.match(rule(css, '.ct-connect__card'), /min-width:0/);
  assert.match(rule(css, '.ct-connect__card h1'), /overflow-wrap:anywhere/);
  assert.match(rule(css, '.ct-ready li'), /overflow-wrap:anywhere/);
  assert.match(css, /\.ct-connect__main\{grid-template-columns:minmax\(0,1fr\)/);
});

test('NTH6: the Connect wash scrolls with the page', () => {
  assert.doesNotMatch(rule(read('styles/connect.css'), '.ct-connect'), /fixed/);
});

test('N6 and NTH2: Panic is the loudest control in the bar and keeps an ink edge when pressed', () => {
  const css = read('styles/base.css');
  const panic = rule(css, '.ct-appbar .ct-btn--panic');
  assert.match(panic, /border:3px solid var\(--ink\)/);
  assert.match(panic, /box-shadow:4px 4px 0 var\(--ink\)/);
  assert.ok(px(panic, 'min-height') >= 48);
  assert.match(rule(css, '.ct-appbar .ct-btn--panic[aria-pressed=true]'), /border-color:var\(--ink\)/);
  assert.match(rule(css, '.ct-mobilebar .ct-btn--panic'), /box-shadow:3px 3px 0 var\(--ink\)/);
});

test('N7: studio tiles keep tags and status out of the art', () => {
  const studio = read('screens/Studio.tsx');
  assert.match(studio, /<li key=\{panel\.id\} className="ct-cell"[^>]*>\s*<Panel panel=\{panel\} tags=\{false\}\/>/);
  assert.match(studio, /<PanelTags panel=\{panel\} className="ct-cell__tags"\/>/);
  assert.match(read('components/Panel.tsx'), /export function PanelTags/);
});

test('NTH3: the revoked EventSub mark is an ink triangle', () => {
  assert.match(rule(read('styles/studio.css'), '.ct-evs[data-health=revoked] .ct-evs__mark'), /background:var\(--ink\);color:var\(--paper\)/);
});

test('NTH4: the loading cue animates opacity, not a flat background position', () => {
  const css = read('styles/base.css');
  assert.doesNotMatch(css, /@keyframes ct-tonepan\{to\{background-position/);
  assert.match(css, /@keyframes ct-tonepan\{50%\{opacity:/);
});

test('Connect page error heading follows the reported cause', () => {
  const connect = read('screens/Connect.tsx');
  assert.match(connect, /twitchErrorCopy\(twitch\.error\)\.heading/);
  assert.doesNotMatch(connect, /<strong>Twitch sign-in didn’t finish\.<\/strong>/);
});
