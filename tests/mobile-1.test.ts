import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// MOBILE-1 (390px and 768px pass, plus the verdict-polish-1.md N6 nits). Static checks on the shipped CSS;
// the rendered audit is in report-mobile-1.md.
const read = (path: string) => readFileSync(new URL(`../apps/web/src/ui/${path}`, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

test('N6 nit 1: the phone bar does not drop Panic\'s shadow', () => {
  const studio = read('styles/studio.css');
  assert.doesNotMatch(studio, /\.ct-mobilebar \.ct-btn\{[^}]*box-shadow:none/);
  assert.match(studio, /\.ct-mobilebar \.ct-btn:not\(\.ct-btn--panic\)\{box-shadow:none\}/);
  assert.match(read('styles/base.css'), /\.ct-mobilebar \.ct-btn--panic\{[^}]*box-shadow:3px 3px 0 var\(--ink\)/);
});

test('N6 nit 2: Approve on the phone bar is calmer than coral Panic', () => {
  const body = read('styles/base.css').match(/\.ct-mobilebar \.ct-btn:nth-child\(2\)\{([^}]*)\}/)?.[1] ?? '';
  assert.match(body, /background:transparent/);
  assert.match(body, /border-color:var\(--ink\)/);
  assert.doesNotMatch(body, /var\(--primary\)|var\(--hi\)|var\(--fest-amber\)/);
});

test('the ink toast gives its Undo a paper focus ring', () => {
  assert.match(read('styles/base.css'), /\.ct-toast :focus-visible\{outline-color:var\(--paper\)\}/);
});
