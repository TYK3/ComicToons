/**
 * Director key: the ONE place every write in server.ts gets its auth header from.
 *
 * header `x-comictoons-director-key`, kept only in sessionStorage under `comictoons.directorKey`
 * with an in-memory fallback, never in a URL, never logged, never rendered back. On a guarded
 * route's 401 the client dispatches `comictoons:director-key-required` with detail
 * `{status: 401, url: <path only>}`; nothing retries the write automatically.
 *
 * TODO: after the rebase onto HEAD, replace this file's internals with the header helper
 * and sessionStorage key from apps/web/src/lib/director-key.ts (200c07c), and keep this module's
 * exports so server.ts does not change. That transport is installed in main.tsx; this one is not.
 *
 * No network here: this module only reads storage and dispatches a window event.
 */
export const DIRECTOR_KEY_HEADER = 'x-comictoons-director-key';
export const DIRECTOR_KEY_STORAGE = 'comictoons.directorKey';
export const DIRECTOR_KEY_REQUIRED = 'comictoons:director-key-required';

let memory = '';

function stored(): string {
  try { return sessionStorage.getItem(DIRECTOR_KEY_STORAGE) ?? memory; } catch { return memory; }
}

/** Headers for a write. Read at request time; empty when no key is saved (loopback-only writes still work). */
export function directorHeaders(): Record<string, string> {
  const key = stored().trim();
  return key ? { [DIRECTOR_KEY_HEADER]: key } : {};
}

export function saveDirectorKey(key: string) {
  memory = key;
  try { sessionStorage.setItem(DIRECTOR_KEY_STORAGE, key); } catch { /* memory fallback only */ }
}

export function forgetDirectorKey() {
  memory = '';
  try { sessionStorage.removeItem(DIRECTOR_KEY_STORAGE); } catch { /* nothing stored */ }
}

/** Call with a write's response status and same-origin path. Only a 401 is announced, and only the path, never the key. */
export function noteDirectorResponse(status: number, path: string) {
  if (status !== 401 || typeof window === 'undefined') return;
  const url = path.split('?')[0]!;
  window.dispatchEvent(new CustomEvent(DIRECTOR_KEY_REQUIRED, { detail: { status: 401, url } }));
}
