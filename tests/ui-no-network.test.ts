import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import test from 'node:test';

// The rebuilt front end (apps/web/src/ui) uses a single server adapter. The server adapter,
// data/server.ts, is the ONE file allowed to touch the network, and it is excluded here by exact
// path. Everything else in src/ui (data/directorKey.ts included) is still checked.
const root = join(import.meta.dirname, '..', 'apps', 'web', 'src', 'ui');
const NETWORK_ALLOWED = new Set([join(root, 'data', 'server.ts')]);
// The public-channel watch feature (read-only /api/watch calls) and the single full-page navigation to the live
// workspace are the only other places allowed to touch fetch or location. Each is checked below to stay that narrow.
const WATCH_FILES = ['data/watch.tsx', 'screens/Viewer.tsx', 'components/PublicChannelPicker.tsx'].map((path) => join(root, ...path.split('/')));
const files = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? files(path) : [path];
});
const sources = files(root).filter((path) => /\.(tsx?|css)$/.test(path));
const read = (path: string) => readFileSync(path, 'utf8');
const hits = (pattern: RegExp, among = sources) => among.flatMap((path) => read(path).split('\n')
  .map((line, index) => ({ line, at: `${relative(root, path).split(sep).join('/')}:${index + 1}` }))
  .filter(({ line }) => pattern.test(line)).map(({ at, line }) => `${at}  ${line.trim()}`));

test('src/ui makes no network calls: no fetch, EventSource, WebSocket, XMLHttpRequest or sendBeacon', () => {
  assert.ok(sources.length > 10, 'src/ui sources found');
  assert.ok(NETWORK_ALLOWED.size === 1 && [...NETWORK_ALLOWED].every((path) => existsSync(path)), 'data/server.ts exists');
  assert.ok(WATCH_FILES.every((path) => existsSync(path)), 'watch feature files exist');
  const checked = sources.filter((path) => !NETWORK_ALLOWED.has(path) && !WATCH_FILES.includes(path));
  assert.equal(checked.length, sources.length - 1 - WATCH_FILES.length);
  // The watch files may not use any other transport, and their fetch calls only target /api/watch.
  assert.deepEqual(hits(/\bEventSource\b|\bWebSocket\b|\bXMLHttpRequest\b|\bsendBeacon\b/, WATCH_FILES), []);
  assert.deepEqual(hits(/\bfetch\s*\(/, WATCH_FILES).filter((hit) => !/fetch\(['`]\/api\/watch/.test(hit)), []);
  assert.deepEqual(hits(/\blocation\.assign\s*\(/, WATCH_FILES).filter((hit) => !/^components\/PublicChannelPicker\.tsx/.test(hit)), []);
  // Any mention of fetch at all (fetch(, globalThis.fetch.call, const f = fetch), not just a call.
  assert.deepEqual(hits(/\bfetch\b|\bEventSource\b|\bWebSocket\b|\bXMLHttpRequest\b|\bsendBeacon\b|\blocation\.assign\s*\(/, checked), []);
});

// Computed or indirect access to the globals, e.g. globalThis['fe' + 'tch'], window["WebSocket"], Reflect.get(self, x),
// (0, eval)('fetch'), new Function(...). Any bracket access on a global object is refused outside data/server.ts.
const GLOBALS = String.raw`(?:globalThis|window|self|top|parent|frames|document\s*\.\s*defaultView)`;
const INDIRECT = new RegExp(String.raw`\b${GLOBALS}\s*(?:\?\.)?\s*\[|\bReflect\s*\.\s*(?:get|apply|construct)\s*\(\s*${GLOBALS}\b|\bObject\s*\.\s*getOwnPropertyDescriptor\s*\(\s*${GLOBALS}\b|\beval\s*\)?\s*\(|\bnew\s+Function\s*\(|\bimport\s*\(\s*[^'"\s]`);

test('src/ui has no computed or indirect access to fetch, EventSource or WebSocket', () => {
  // Positive controls: the pattern must catch the known tricks, or this test proves nothing.
  for (const trick of ["globalThis['fe' + 'tch']('/x')", 'window["EventSource"]', 'self?.[name]', "Reflect.get(globalThis, 'WebSocket')", "(0, eval)('fetch')", "new Function('return fetch')", 'import(url)', 'document.defaultView[key]'])
    assert.ok(INDIRECT.test(trick), `pattern misses: ${trick}`);
  for (const fine of ["window.addEventListener('keydown', onKey)", 'globalThis.matchMedia?.(query)', "import('./lazy')"]) assert.ok(!INDIRECT.test(fine), `false positive: ${fine}`);
  const checked = sources.filter((path) => !NETWORK_ALLOWED.has(path) && /\.tsx?$/.test(path));
  assert.deepEqual(hits(INDIRECT, checked), []);
});

test('apps/web/ui.html loads only same-origin scripts and links', () => {
  const html = readFileSync(join(root, '..', '..', 'ui.html'), 'utf8');
  const tags = html.match(/<(?:script|link|base|iframe|img|meta[^>]+http-equiv)\b[^>]*>/gi) ?? [];
  assert.ok(tags.some((tag) => /^<script\b/i.test(tag)), 'ui.html has its module script');
  for (const tag of tags) {
    assert.ok(!/^<(?:base|iframe)\b/i.test(tag) && !/http-equiv\s*=\s*["']?refresh/i.test(tag), `not allowed in ui.html: ${tag}`);
    for (const [, url] of tag.matchAll(/\b(?:src|href|srcset|content)\s*=\s*["']([^"']*)["']/gi)) {
      if (/^<meta\b/i.test(tag) && !/url=/i.test(url!)) continue;
      assert.ok(!/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url!.trim()) && !/url=\s*(?:[a-z]+:|\/\/)/i.test(url!), `off-origin URL in ui.html: ${tag}`);
    }
  }
});

test('no screen or component imports data/server.ts: only main.tsx may choose the adapter', () => {
  const importers = sources.filter((path) => path.endsWith('.ts') || path.endsWith('.tsx'))
    .filter((path) => /from\s+['"][^'"]*\/server(\.ts)?['"]|import\(\s*['"][^'"]*\/server(\.ts)?['"]/.test(read(path)))
    .map((path) => relative(root, path).split(sep).join('/'));
  assert.ok(importers.every((path) => path === 'main.tsx'), importers.join(', '));
  for (const dir of ['screens', 'components']) assert.ok(!importers.some((path) => path.startsWith(`${dir}/`)), dir);
});

test('src/ui loads nothing from a CDN: fonts are self-hosted with their licence', () => {
  assert.deepEqual(hits(/@import\s+url\(\s*['"]?https?:|url\(\s*['"]?https?:|<script[^>]+src=["']https?:/), []);
  const fonts = join(root, 'fonts');
  for (const font of ['bangers-400-latin.woff2', 'comic-neue-400-latin.woff2', 'comic-neue-700-latin.woff2', 'space-grotesk-var-latin.woff2']) assert.ok(existsSync(join(fonts, font)), font);
  // One licence per family, the upstream text from github.com/google/fonts (ofl/<family>/OFL.txt), LF line endings.
  // Whitespace-normalised: CRLF to LF and trailing spaces stripped; wording unchanged (see report-ui1.md).
  const licences: Record<string, string> = {
    'OFL-bangers.txt': '01f0dea3bc499f7fcc471577fe3a8d7df6e74e6b456d2228b767a239740811ae',
    'OFL-comic-neue.txt': 'dab6444770eae001bddf7501a2b3b90c93d44d47faf45369c814a5ad61b524d2',
    'OFL-space-grotesk.txt': '18a4de52385f6b988782639d5d0cc1326e5a8c2de9a7f01d7b20d9aedcc60943',
  };
  for (const [file, sha] of Object.entries(licences)) {
    assert.match(read(join(fonts, file)), /SIL OPEN FONT LICENSE Version 1\.1/, file);
    assert.equal(createHash('sha256').update(readFileSync(join(fonts, file))).digest('hex'), sha, file);
  }
});

test('Twitch purple appears only on the Connect with Twitch button', () => {
  assert.deepEqual(hits(/#9146ff/i).map((hit) => hit.split('  ')[0]!.split(':')[0]), ['styles/base.css']);
  const uses = hits(/var\(--twitch\)/).map((hit) => hit.split('  ')[1]);
  assert.ok(uses.length > 0 && uses.every((line) => /^\.ct-btn--twitch\{/.test(line!)), uses.join('\n'));
});

test('every img in src/ui declares width and height', () => {
  const imgs = sources.filter((path) => path.endsWith('.tsx')).flatMap((path) => (read(path).match(/<img\b(?:=>|[^>])*>/g) ?? []).map((tag) => ({ tag, path: relative(root, path).split(sep).join('/') })));
  assert.ok(imgs.length > 0);
  for (const { tag, path } of imgs) assert.ok(/\swidth=/.test(tag) && /\sheight=/.test(tag), `${path}: ${tag}`);
});


test('UI entry point selects the server adapter and Vite builds both HTML entry points',async()=>{
  const main=read(join(root,'main.tsx'));
  assert.match(main,/import\s*\{\s*ServerAdapter\s*\}\s*from\s*['"]\.\/data\/server['"]/);
  assert.match(main,/new ServerAdapter\(\)/);
  assert.doesNotMatch(main,/new MockAdapter\(/);
  const {default:config}=await import('../apps/web/vite.config.ts');
  const input=config.build?.rollupOptions?.input;
  assert.ok(input&&typeof input==='object'&&!Array.isArray(input));
  const slash = (value: string) => value.split(sep).join('/');
  assert.ok(slash(input.main).endsWith('/apps/web/index.html'));
  assert.ok(slash(input.ui).endsWith('/apps/web/ui.html'));
  assert.ok(slash(input.classic).endsWith('/apps/web/classic.html'));
});

test('default HTML serves the new UI and classic pathname routes retain the old entry',async()=>{
  const {classicEntryUrl}=await import('../apps/web/entries.ts');
  const web=join(root,'..','..');
  assert.match(read(join(web,'index.html')),/src="\/src\/ui\/main.tsx"/);
  assert.match(read(join(web,'classic.html')),/src="\/src\/main.tsx"/);
  for(const path of ['/classic','/studio','/dashboard','/overlay','/connect','/book/example','/recap/example'])
    assert.equal(classicEntryUrl(path),'/classic.html');
  assert.equal(classicEntryUrl('/overlay?x=1'),'/classic.html?x=1');
  for(const path of ['/','/ui.html','/api/state','/auth/twitch/login','/art/x.png','/assets/app.js'])
    assert.equal(classicEntryUrl(path),undefined);
});

test('item 10: Ink me shows the server error and chatFallback verbatim, with no stand-in text', () => {
  const card = read(join(root, 'screens', 'studio', 'Participation.tsx'));
  assert.doesNotMatch(card, /sentence\(|AFFILIATE_TEXT|FALLBACK_TEXT/);
  assert.match(card, /\{reward\.chatFallback\}/);
});

test('Series reads GET /api/series/:id through getSeries and shows no invented date or channel', () => {
  const readers = read(join(root, 'screens', 'Readers.tsx'));
  const series = readers.slice(readers.indexOf('export function Series'), readers.indexOf('export function Reader'));
  assert.match(series, /adapter\.getSeries\(/);
  assert.doesNotMatch(series, /listIssues|getIssue|\.channel|\.date/);
  assert.match(read(join(root, 'data', 'server.ts')), /\/api\/series\//);
  assert.doesNotMatch(read(join(root, 'data', 'mock.ts')), /date: '/);
});

test('W4: Try again re-checks the sign-in; only Connect with Twitch starts one', () => {
  const connect = read(join(root, 'components', 'TwitchConnect.tsx'));
  const tryAgain = connect.slice(connect.indexOf('export function TryAgain'), connect.indexOf('export function TwitchErrorBanner'));
  assert.match(tryAgain, /adapter\.checkTwitch\(\)/);
  assert.doesNotMatch(tryAgain, /connectTwitch|ct-btn--twitch|ct-btn--ink/);
  // screens/Issues.tsx retries loading the issue list; it is not a sign-in action.
  assert.deepEqual(hits(/Try again<\/button>/).filter((hit) => !hit.startsWith('screens/Issues.tsx:')), []);
});

test('UI3: states announce politely; nothing in src/ui interrupts with role="alert"', () => {
  // Form and load-error messages in these files are announced as alerts on purpose; the rest of src/ui stays polite.
  const ALERT_OK = /^(?:components\/(?:GeneratorSettings|PublicChannelPicker|RoleChoice)\.tsx|screens\/(?:Audience|StoryFlow|Studio|Viewer)\.tsx|styles\/studio\.css):/;
  assert.deepEqual(hits(/role=["{']alert/).filter((hit) => !ALERT_OK.test(hit)), []);
  const state = read(join(root, 'components', 'ScreenState.tsx'));
  assert.match(state, /role="status" aria-live="polite"/);
  assert.doesNotMatch(state, /assertive/);
});

test('UI3: every screen has loading, empty and error states driven by the adapter', () => {
  const screens = ['Landing', 'Connect', 'Studio', 'Director', 'Readers', 'Output'];
  for (const name of screens) {
    const source = read(join(root, 'screens', `${name}.tsx`));
    for (const kind of ['loading', 'error']) assert.match(source, new RegExp(`kind="${kind}"|phase === '${kind}'|<Loading |<Failed |role="status" aria-live="polite">Loading|issues[.]${kind}`), `${name}: ${kind}`);
    assert.match(source, /kind="empty"|phase === 'empty'/, `${name}: empty`);
  }
  const readers = read(join(root, 'screens', 'Readers.tsx'));
  for (const screen of ['Recap', 'Book', 'Series', 'Reader', 'CatchUp']) {
    const start = readers.indexOf(`export function ${screen}(`);
    const body = readers.slice(start, readers.indexOf('\nexport function', start + 1) >>> 0 || undefined);
    assert.match(body, /<Failed [^>]*onRetry=/, `${screen}: error has Try again`);
    assert.match(body, /<Loading |role="status" aria-live="polite">Loading/, `${screen}: loading`);
    assert.match(body, /panels\.length|episode \?|!episode/, `${screen}: empty`);
  }
  const mock = read(join(root, 'data', 'mock.ts'));
  assert.match(mock, /MOCK_STATES = \['live', 'loading', 'offline', 'error', 'empty', 'lost'\]/);
  assert.match(mock, /private blank\(\)/);
});

test('UI3: the overlay draws nothing on stream for loading, empty or error', () => {
  const overlay = read(join(root, 'screens', 'Overlay.tsx'));
  // The overlay is the shared ViewerStage: it renders nothing for loading, empty or error, and only the preview
  // chrome (hidden in the clean OBS output) shows a waiting note.
  assert.match(overlay, /<ViewerStage\/>/);
  assert.match(overlay, /\{!clean&&\(!ui\.studio\.panels\.length\|\|ui\.studio\.hidden\)&&<p className="ct-overlay-status">/);
  assert.doesNotMatch(overlay, /ScreenState|ct-state[^_]|ct-banner|role="alert"/);
  const css = read(join(root, 'styles', 'overlay.css'));
  assert.doesNotMatch(css.slice(css.indexOf('/* UI3')).replace(/\/\*[^]*?\*\//g, ''), /#(?:f00|ff0000)\b|\bred\b/i);
});
