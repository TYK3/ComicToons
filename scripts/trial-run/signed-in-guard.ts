/**
 * Preloaded with `node --import` before the ComicToons server starts under `trial-run --signed-in`.
 * Wraps the process's global fetch so every outbound request is checked against the hard allowlist
 * (signed-in-allowlist.ts) before it is sent. A write or any unlisted request throws instead of
 * reaching Twitch (or the fake); it never gets as far as opening a connection.
 */
import {checkAllowed} from './signed-in-allowlist.ts';

type Guarded = typeof fetch & {signedInGuardInstalled?: boolean};

export function installSignedInGuard(target: {fetch: typeof fetch} = globalThis): void {
  const current = target.fetch as Guarded;
  if (current.signedInGuardInstalled) return;
  const original = current;
  const guarded: Guarded = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input;
    const method = (init?.method ?? (input instanceof Request ? input.method : undefined) ?? 'GET').toUpperCase();
    const body = init?.body;
    checkAllowed({method, url: String(url), body});
    return original(input, init);
  }) as Guarded;
  guarded.signedInGuardInstalled = true;
  target.fetch = guarded;
}

installSignedInGuard();
