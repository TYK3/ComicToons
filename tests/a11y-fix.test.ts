import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

// A11Y-fix source guards for the rebuilt UI. The keyboard behaviour itself is checked in a11y-fix-keyboard.spec.ts.
const ui = join(import.meta.dirname, '..', 'apps', 'web', 'src', 'ui');
const read = (path: string) => readFileSync(join(ui, path), 'utf8');

test('#1 studio shortcuts are page-wide except typing targets, open dialogs, modifiers and repeat', () => {
  const studio = read('screens/Studio.tsx');
  assert.match(studio, /(?:document|window)\.addEventListener\(\s*['"]keydown['"]/, 'body and app-bar focus must reach the page shortcut handler');
  assert.doesNotMatch(studio, /className="ct-desk"[^>]*onKeyDown=\{onKey\}/, 'the review card must not be the shortcut scope');
  assert.match(studio, /input,\s*textarea,\s*select[^'"`]*contenteditable/i, 'typing targets include contenteditable');
  assert.match(studio, /dialog\[open\]|(?:editing|editOpen).*\|\|.*(?:ending|endOpen)|(?:ending|endOpen).*\|\|.*(?:editing|editOpen)/, 'open dialogs suppress page shortcuts');
  for (const guard of ['metaKey', 'ctrlKey', 'altKey', 'shiftKey', 'repeat']) assert.ok(studio.includes('event.' + guard), guard + ' stays ignored');
});

test('#7 the overlay stage label sits on a region', () => {
  // The overlay renders the shared ViewerStage: a labelled <section> is a region landmark.
  assert.match(read('screens/Overlay.tsx'), /<ViewerStage\/>/);
  assert.match(read('components/ViewerStage.tsx'), /<section className=\{`ct-viewer-stage[^`]*`\} aria-label=\{preview\?'Viewer preview':'Viewer output'\}/);
});

test('#11 the landing page has one main landmark and the footer is outside it', () => {
  const landing = read('screens/Landing.tsx');
  assert.equal(landing.match(/<main\b/g)?.length, 1);
  assert.ok(landing.indexOf('</main>') < landing.indexOf('<footer'));
});

test('S6 #10 grid columns follow the rule for every panel count from 1 to 40', async () => {
  // THEMES-4 r2: the rule moved from a per-count data-count list (which had no entry for 14+, so 14 panels got 4
  // columns) to data-cols={gridColumns(n)} with one CSS rule per column count. data-count stays on the grid.
  const { gridColumns } = await import('../apps/web/src/ui/gridColumns.ts');
  const css = read('styles/studio.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const expected = (count: number) => count <= 4 ? count : count % 4 === 0 || count % 4 === 3 ? 4 : 3;
  const columns = (cols: number) => {
    let found = 4;
    for (const [, selectors, body] of css.matchAll(/([^{}]*)\{grid-template-columns:([^}]*)\}/g)) {
      if (!selectors.split(',').some(selector => selector.trim() === `.ct-grid[data-cols="${cols}"]`)) continue;
      found = body.startsWith('minmax(0,720px)') ? 1 : Number(/repeat\((\d+)/.exec(body)?.[1]);
    }
    return found;
  };
  for (let count = 1; count <= 40; count++) assert.equal(columns(gridColumns(count)), expected(count), `count ${count}`);
  assert.match(read('screens/Studio.tsx'), /className="ct-grid" data-count=\{shown\.length\} data-cols=\{gridColumns\(shown\.length\)\}/);
});
