export const DIRECTOR_KEY_HEADER = 'x-comictoons-director-key';
const STORAGE_KEY = 'comictoons.directorKey';
const REQUIRED_EVENT = 'comictoons:director-key-required';
interface KeyStorageWindow {sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>}
interface TransportWindow extends KeyStorageWindow {
  location: {href: string};
  fetch: typeof fetch;
  dispatchEvent(event: Event): boolean;
  CustomEvent: typeof CustomEvent;
}
const memory = new WeakMap<KeyStorageWindow, string>();
const installed = new WeakSet<TransportWindow>();

export function getDirectorKey(win: KeyStorageWindow = window): string {
  try {
    const value = win.sessionStorage.getItem(STORAGE_KEY) ?? '';
    memory.set(win, value);
    return value;
  } catch {return memory.get(win) ?? '';}
}
export function setDirectorKey(value: string, win: KeyStorageWindow = window): void {
  const key = value.trim();
  memory.set(win, key);
  try {
    if (key) win.sessionStorage.setItem(STORAGE_KEY, key);
    else win.sessionStorage.removeItem(STORAGE_KEY);
  } catch {/* Memory is the fallback when tab storage is unavailable. */}
}
export function clearDirectorKey(win: KeyStorageWindow = window): void {
  memory.delete(win);
  try {win.sessionStorage.removeItem(STORAGE_KEY);} catch {/* The in-memory value is already cleared. */}
}

export function needsDirectorKey(method: string, url: string | URL, baseUrl = window.location.href): boolean {
  try {
    const target = new URL(url, baseUrl);
    if (target.origin !== new URL(baseUrl).origin || !target.pathname.startsWith('/api/')) return false;
    const verb = method.toUpperCase();
    return !['GET', 'HEAD', 'OPTIONS'].includes(verb)
      || (['GET', 'HEAD'].includes(verb) && target.pathname.replace(/\/$/, '') === '/api/participation/director');
  } catch {return false;}
}
function requestDetails(input: RequestInfo | URL, init?: RequestInit) {
  const request = typeof input !== 'string' && 'url' in input ? input : undefined;
  return {url: request?.url ?? String(input), method: init?.method ?? request?.method ?? 'GET', headers: init?.headers ?? request?.headers};
}
export function withDirectorKey(input: RequestInfo | URL, init?: RequestInit, win: TransportWindow = window): RequestInit {
  const result = {...init};
  const request = requestDetails(input, init);
  if (!needsDirectorKey(request.method, request.url, win.location.href)) return result;
  const headers = new Headers(request.headers);
  if (headers.has(DIRECTOR_KEY_HEADER)) return result;
  const key = getDirectorKey(win);
  if (key) {headers.set(DIRECTOR_KEY_HEADER, key); result.headers = headers;}
  return result;
}

/** Install before rendering so existing studio fetch calls share tab-scoped authorization. */
export function installDirectorKeyTransport(win: TransportWindow = window): void {
  if (installed.has(win)) return;
  const original = win.fetch.bind(win);
  win.fetch = async (input, init) => {
    const request = requestDetails(input, init);
    const response = await original(input, withDirectorKey(input, init, win));
    if (response.status === 401 && needsDirectorKey(request.method, request.url, win.location.href)
      && /^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get('content-type') ?? '')) {
      try {
        await response.clone().json();
        const path = new URL(request.url, win.location.href).pathname;
        win.dispatchEvent(new win.CustomEvent(REQUIRED_EVENT, {detail: {status: response.status, url: path}}));
      } catch {/* An unreadable error response must not break the original fetch result. */}
    }
    return response;
  };
  installed.add(win);
}

/** Subscribe without reading, rendering or persisting the stored credential. */
export function listenForDirectorKeyRequired(show:(message:string)=>void,focus:()=>void,
  target:Pick<Window,'addEventListener'|'removeEventListener'>=window):()=>void {
  const listener=(event:Event)=>{
    if((event as CustomEvent<{status?:number}>).detail?.status!==401)return;
    show('The studio needs the director key. Enter it below.');focus();
  };
  target.addEventListener(REQUIRED_EVENT,listener);
  return ()=>target.removeEventListener(REQUIRED_EVENT,listener);
}
