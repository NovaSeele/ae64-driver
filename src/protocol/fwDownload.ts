// The two requests of the online update (DESIGN OFU §3.3, §8): the list (`/firmware/manifest.json`, our own origin) and a
// build's file (its `url` on the maker's file server). Nothing else is ever requested: no maker API, no key, no keyboard data,
// no query string, no cookies, no referrer. The file stays in memory. Neither sends anything to a keyboard.
import { FW_LIST_MAX_BYTES, FW_LIST_URL, allowedFileUrl, parseFwList } from './fwManifest';
import type { FwBuild, FwList } from './fwManifest';

type Fetch = typeof fetch;

/**
 * Whether this build downloads a file itself (DESIGN OFU v1.5 §8), one constant per build. On in both from r134: the desktop
 * app's CSP and the site's nginx CSP both allow https://hub.xsyd.top/storage/firmware/ (the site's with the owner's OK of
 * 2026-11-17). Kept as a switch: off, the page shows the maker's link and the picker from the start, and never fetches a file.
 * Turn it off for a build whose CSP does not allow that path.
 */
export const FW_DIRECT: boolean = true;
/** The desktop app: its list is built in (its own list line, no "Kiểm tra lại": DESIGN OFU §7.1). */
export const FW_DESKTOP: boolean = typeof __DESKTOP__ !== 'undefined' && __DESKTOP__;

/** The list: 10 s at most. */
export const FW_LIST_TIMEOUT_MS = 10_000;
/** A download fails after this long with no new bytes. */
export const FW_STALL_MS = 15_000;

/** The `fetch` options of the list (§8). */
export const LIST_INIT: RequestInit = Object.freeze({
  method: 'GET', cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
}) as RequestInit;
/** The `fetch` options of a firmware file (§8). */
export const FILE_INIT: RequestInit = Object.freeze({
  method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors',
}) as RequestInit;

export type FwListResult = { kind: 'ok'; list: FwList } | { kind: 'offline' } | { kind: 'invalid'; why: string };

const jsonType = (ct: string | null): boolean => (ct ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

/**
 * Fetches and checks the list. No reply, a timeout, a status other than 200, a redirect or a type other than
 * `application/json` (the site's index.html fallback answers 200 text/html) → `offline`; JSON that fails §7.3 → `invalid`.
 */
export async function fetchFwList(opts: { fetch?: Fetch; signal?: AbortSignal; timeoutMs?: number } = {}): Promise<FwListResult> {
  const f = opts.fetch ?? globalThis.fetch;
  if (typeof f !== 'function') return { kind: 'offline' };
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  opts.signal?.addEventListener('abort', stop);
  const timer = setTimeout(stop, opts.timeoutMs ?? FW_LIST_TIMEOUT_MS);
  try {
    const res = await f(FW_LIST_URL, { ...LIST_INIT, signal: ctl.signal });
    if (res.status !== 200 || res.redirected || !jsonType(res.headers.get('content-type'))) return { kind: 'offline' };
    const text = await readText(res, FW_LIST_MAX_BYTES);
    if (text === null) return { kind: 'invalid', why: 'too long' };
    const parsed = parseFwList(text);
    return parsed.ok ? { kind: 'ok', list: parsed.list } : { kind: 'invalid', why: parsed.why };
  } catch {
    return { kind: 'offline' };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}

/** The body as text, or null when it is longer than `max` bytes (reading stops there). */
async function readText(res: Response, max: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) {
    const t = await res.text();
    return new TextEncoder().encode(t).length > max ? null : t;
  }
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(join(parts, n));
}

function join(parts: Uint8Array[], n: number): Uint8Array {
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** SHA-256 of `bytes`, 64 lower-case hex digits (Web Crypto). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes.slice()));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * How a download ended (§3.3):
 * - `ok`: every byte, size and SHA-256 as the list says;
 * - `mismatch`: the stream ended, but the size or the SHA-256 differs (the bytes are only for the check lines, never written);
 * - `cut`: it failed, stalled or was stopped after the response came (partial bytes dropped);
 * - `tooBig`: more bytes than the list says (stopped at once);
 * - `fallback`: no response (a CORS refusal or a network failure: the browser does not say which), an HTTP error or a redirect;
 * - `noNet`: no response while the browser says it is offline.
 */
export type FwDownloadResult =
  | { kind: 'ok'; bytes: Uint8Array; sha256: string }
  | { kind: 'mismatch'; bytes: Uint8Array; sha256: string; sizeOk: boolean; shaOk: boolean }
  | { kind: 'cut'; done: number }
  | { kind: 'tooBig'; done: number }
  | { kind: 'fallback' }
  | { kind: 'noNet' };

export interface FwDownloadOpts {
  fetch?: Fetch;
  /** Aborts the download ("Dừng tải", leaving the page, another source). */
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  stallMs?: number;
  online?: () => boolean;
}

/** Downloads a listed build's file with the §8 options. Only a `url` the list check allows is ever requested. */
export async function downloadBuild(b: FwBuild, opts: FwDownloadOpts = {}): Promise<FwDownloadResult> {
  const f = opts.fetch ?? globalThis.fetch;
  const online = opts.online ?? (() => typeof navigator === 'undefined' || navigator.onLine !== false);
  const noResponse = (): FwDownloadResult => (online() ? { kind: 'fallback' } : { kind: 'noNet' });
  if (!allowedFileUrl(b.url) || typeof f !== 'function') return { kind: 'fallback' };
  const ctl = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  // a stall or "Dừng tải" aborts the request and cancels the body: a pending read ends at once (not only when the browser
  // errors the aborted body)
  const stop = () => {
    ctl.abort();
    void reader?.cancel().catch(() => undefined);
  };
  if (opts.signal?.aborted) return { kind: 'cut', done: 0 };
  opts.signal?.addEventListener('abort', stop);
  const stallMs = opts.stallMs ?? FW_STALL_MS;
  let timer = setTimeout(stop, stallMs);
  const fresh = () => {
    clearTimeout(timer);
    timer = setTimeout(stop, stallMs);
  };
  let done = 0;
  try {
    let res: Response;
    try {
      res = await f(b.url, { ...FILE_INIT, signal: ctl.signal });
    } catch {
      return opts.signal?.aborted ? { kind: 'cut', done: 0 } : noResponse();
    }
    if (!res.ok || res.status !== 200 || res.redirected || res.type === 'opaqueredirect') {
      void res.body?.cancel().catch(() => undefined);
      return { kind: 'fallback' };
    }
    fresh();
    reader = res.body?.getReader();
    const parts: Uint8Array[] = [];
    if (reader) {
      try {
        for (;;) {
          const { done: end, value } = await reader.read();
          if (end || ctl.signal.aborted) break;
          fresh();
          done += value.length;
          if (done > b.size) {
            void reader.cancel().catch(() => undefined);
            return { kind: 'tooBig', done };
          }
          parts.push(value);
          opts.onProgress?.(done, b.size);
        }
      } catch {
        return { kind: 'cut', done };
      }
    } else {
      const all = new Uint8Array(await res.arrayBuffer());
      done = all.length;
      if (done > b.size) return { kind: 'tooBig', done };
      parts.push(all);
      opts.onProgress?.(done, b.size);
    }
    if (ctl.signal.aborted) return { kind: 'cut', done };
    const bytes = join(parts, done);
    const sha256 = await sha256Hex(bytes);
    const sizeOk = bytes.length === b.size;
    const shaOk = sha256 === b.sha256;
    return sizeOk && shaOk ? { kind: 'ok', bytes, sha256 } : { kind: 'mismatch', bytes, sha256, sizeOk, shaOk };
  } catch {
    return { kind: 'cut', done };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}
