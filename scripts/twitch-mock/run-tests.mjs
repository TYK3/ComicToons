// Runner for `npm run test:twitch`: the mock-Twitch harness self-tests and the
// live-checklist end-to-end tests (skipped as fixme until T2/T3 land).
// Files run serially on the configurable dedicated loopback ports.
import {spawnSync} from 'node:child_process';
import {mkdirSync, readdirSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
mkdirSync(join(root, 'artifacts', 'tmp'), {recursive: true});
const dir = join(root, 'tests', 'twitch');
const files = readdirSync(dir).filter(name => name.endsWith('.test.ts')).sort().map(name => join(dir, name));
if (!files.length) { console.error('No tests found in tests/twitch.'); process.exit(1); }
// HARNESS-PORT-1: every test process refuses the live app's 3001/4173 unless the port env names them.
const flags = ['--import', 'tsx', '--import', pathToFileURL(join(dir, 'port-guard.mjs')).href];
// Node 20 has WebSocket behind a flag; Node 22+ has it by default.
if (typeof globalThis.WebSocket === 'undefined') flags.push('--experimental-websocket');
const env = {...process.env};
// The gate reports unfinished checklist cases as skipped, regardless of outer opt-ins.
if(process.argv.includes('--gate')){delete env.COMICTOONS_TWITCH_E2E;delete env.PANELCAST_TWITCH_E2E;}
// No network art in tests, ever.
delete env.PANELCAST_ART_NETWORK;
delete env.COMICTOONS_ART_NETWORK;
const result = spawnSync(process.execPath, [...flags, '--test', '--test-concurrency=1', ...process.argv.slice(2).filter(arg=>arg!=='--gate'), ...files], {cwd: root, stdio: 'inherit', env});
process.exit(result.status ?? 1);
