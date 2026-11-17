// DESIGN OFU §3.3, §7.3, §8: the two requests (the list and a build's file) with a fake fetch: their options, the list's
// reply states, progress, the size cap, the SHA-256, cut / fallback / no network, and "Dừng tải". No network, no keyboard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { FILE_INIT, FW_LIST_TIMEOUT_MS, LIST_INIT, downloadBuild, fetchFwList, sha256Hex } from '../src/protocol/fwDownload';
import { parseFwList } from '../src/protocol/fwManifest';
import type { FwBuild } from '../src/protocol/fwManifest';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const TEXT = fs.readFileSync(path.resolve('public/firmware/manifest.json'), 'utf8');
const json = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, ...init });

/** A stream of `chunks`; `failAt`: the stream errors before that chunk; `hangAt`: it stops sending there. */
function stream(chunks: Uint8Array[], o: { failAt?: number; hangAt?: number } = {}): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i === o.failAt) { c.error(new TypeError('network error')); return; }
      if (i === o.hangAt) return new Promise(() => undefined);
      if (i >= chunks.length) { c.close(); return; }
      c.enqueue(chunks[i++]);
    },
  });
}
const split = (b: Uint8Array, n: number) => Array.from({ length: Math.ceil(b.length / n) }, (_, i) => b.slice(i * n, i * n + n));
function bytesOf(n: number, seed = 1): Uint8Array {
  const b = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) { x = (x * 1103515245 + 12345) >>> 0; b[i] = x >>> 24; }
  return b;
}
function buildOf(bytes: Uint8Array, o: Partial<FwBuild> = {}): FwBuild {
  return {
    board: 0x0030000d, name: 'AE64 Max App', version: '0.0.4.0', appVersion: '0.0.4.0', date: '2026-10-12', kind: 'official',
    file: 'x.bin', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), crc32: 0x12345678,
    url: 'https://hub.xsyd.top/storage/firmware/cos/202610/x.bin', fetch: true, notes: { vi: '', en: '' }, ...o,
  };
}

describe('OFU §8: the list request', () => {
  it('the fixed relative URL, no query, and the §8 options: no-cache, credentials omit, no referrer, redirect error', async () => {
    const f = vi.fn(async () => json(TEXT));
    const r = await fetchFwList({ fetch: f as unknown as typeof fetch });
    expect(r.kind).toBe('ok');
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/firmware/manifest.json');
    expect(url).not.toContain('?');
    expect(init).toMatchObject({ method: 'GET', cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
    expect(init.headers).toBeUndefined(); // nothing about the keyboard, no extra header
    expect(LIST_INIT).toEqual({ method: 'GET', cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error' });
  });

  it('200 text/html (the site\'s index.html fallback) → offline, not invalid (mutant 18); 404, 500, a redirect, a throw → offline', async () => {
    const as = (res: Response | Error) => fetchFwList({ fetch: (async () => { if (res instanceof Error) throw res; return res; }) as unknown as typeof fetch });
    expect((await as(new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }))).kind).toBe('offline');
    expect((await as(new Response(TEXT, { status: 200 }))).kind).toBe('offline'); // no content-type
    expect((await as(json(TEXT, { status: 404 }))).kind).toBe('offline');
    expect((await as(json(TEXT, { status: 500 }))).kind).toBe('offline');
    const moved = json(TEXT);
    Object.defineProperty(moved, 'redirected', { value: true });
    expect((await as(moved)).kind).toBe('offline');
    expect((await as(new TypeError('Failed to fetch'))).kind).toBe('offline');
  });

  it('JSON that fails §7.3 → invalid; over 64 KiB → invalid, reading stopped', async () => {
    const bad = JSON.stringify({ ...JSON.parse(TEXT), schema: 2 });
    expect(await fetchFwList({ fetch: (async () => json(bad)) as unknown as typeof fetch })).toMatchObject({ kind: 'invalid' });
    expect((await fetchFwList({ fetch: (async () => json('{nope')) as unknown as typeof fetch })).kind).toBe('invalid');
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({ pull(c) { pulled++; c.enqueue(new Uint8Array(16_384).fill(0x20)); } });
    const r = await fetchFwList({ fetch: (async () => new Response(big, { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch });
    expect(r.kind).toBe('invalid');
    expect(pulled).toBeLessThan(8);
  });

  it('10 s with no reply → offline', async () => {
    vi.useFakeTimers();
    const f = vi.fn((_u: string, init: RequestInit) => new Promise<Response>((_r, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))));
    const p = fetchFwList({ fetch: f as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(FW_LIST_TIMEOUT_MS - 1);
    let settled = false;
    void p.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect((await p).kind).toBe('offline');
  });
});

describe('OFU §3.3, §8: a build\'s file', () => {
  const file = bytesOf(10_000, 3);

  it('the list\'s url as it is, with the §8 options (no-store, credentials omit, no referrer, redirect error, cors); progress; ok', async () => {
    const f = vi.fn(async () => new Response(stream(split(file, 4096)), { status: 200 }));
    const seen: number[] = [];
    const b = buildOf(file);
    const r = await downloadBuild(b, { fetch: f as unknown as typeof fetch, onProgress: (d) => seen.push(d) });
    expect(r.kind).toBe('ok');
    if (r.kind !== 'ok') return;
    expect(r.bytes).toEqual(file);
    expect(r.sha256).toBe(b.sha256);
    expect(seen).toEqual([4096, 8192, 10_000]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(b.url);
    expect(init).toMatchObject({ method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' });
    expect(FILE_INIT).toEqual({ method: 'GET', cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' });
  });

  it('SHA-256 differs → mismatch (mutant 1); a size the list does not say → mismatch', async () => {
    const other = file.slice();
    other[5000] ^= 1;
    const r = await downloadBuild(buildOf(file), { fetch: (async () => new Response(stream([other]), { status: 200 })) as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: 'mismatch', sizeOk: true, shaOk: false });
    const short = await downloadBuild(buildOf(file), { fetch: (async () => new Response(stream([file.slice(0, 9_000)]), { status: 200 })) as unknown as typeof fetch });
    expect(short).toMatchObject({ kind: 'mismatch', sizeOk: false, shaOk: false });
  });

  it('more bytes than size → tooBig, stopped at once (mutant 2)', async () => {
    let pulled = 0;
    // ten 4 KiB chunks, then the end: 40 KiB for a 12 KiB build. Without the stop, the whole body is read and ends as a mismatch
    const endless = new ReadableStream<Uint8Array>({ pull(c) { pulled++; if (pulled > 10) c.close(); else c.enqueue(new Uint8Array(4096)); } });
    const r = await downloadBuild(buildOf(file), { fetch: (async () => new Response(endless, { status: 200 })) as unknown as typeof fetch });
    expect(r).toMatchObject({ kind: 'tooBig', done: 12_288 });
    expect(pulled).toBeLessThan(6);
  });

  it('an error after bytes → cut, no bytes kept (mutant 13)', async () => {
    const r = await downloadBuild(buildOf(file), { fetch: (async () => new Response(stream(split(file, 4096), { failAt: 1 }), { status: 200 })) as unknown as typeof fetch });
    expect(r).toEqual({ kind: 'cut', done: 4096 });
    expect('bytes' in r).toBe(false);
  });

  it('15 s with no new bytes → cut', async () => {
    vi.useFakeTimers();
    const p = downloadBuild(buildOf(file), { fetch: (async () => new Response(stream(split(file, 4096), { hangAt: 1 }), { status: 200 })) as unknown as typeof fetch });
    await vi.advanceTimersByTimeAsync(15_001);
    expect(await p).toEqual({ kind: 'cut', done: 4096 });
  });

  it('a TypeError with no response (CORS or network) → fallback; with navigator offline → noNet; HTTP 403, 404, a redirect → fallback', async () => {
    const thrower = (async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch;
    expect(await downloadBuild(buildOf(file), { fetch: thrower, online: () => true })).toEqual({ kind: 'fallback' });
    expect(await downloadBuild(buildOf(file), { fetch: thrower, online: () => false })).toEqual({ kind: 'noNet' });
    for (const status of [403, 404, 500]) {
      expect(await downloadBuild(buildOf(file), { fetch: (async () => new Response('no', { status })) as unknown as typeof fetch }), String(status)).toEqual({ kind: 'fallback' });
    }
    const moved = new Response(stream([file]), { status: 200 });
    Object.defineProperty(moved, 'redirected', { value: true });
    expect(await downloadBuild(buildOf(file), { fetch: (async () => moved) as unknown as typeof fetch })).toEqual({ kind: 'fallback' });
  });

  it('"Dừng tải" (the signal) aborts: cut, the request\'s own signal aborted, nothing kept', async () => {
    const ctl = new AbortController();
    let reqSignal: AbortSignal | undefined;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      reqSignal = init.signal!;
      return new Response(stream(split(file, 4096), { hangAt: 1 }), { status: 200 });
    });
    const p = downloadBuild(buildOf(file), { fetch: f as unknown as typeof fetch, signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    const r = await p;
    expect(r.kind).toBe('cut');
    expect(reqSignal?.aborted).toBe(true);
  });

  it('a url the allow-list refuses is never requested', async () => {
    const f = vi.fn();
    for (const url of ['https://ae64.novaseele.com/storage/firmware/x.bin', 'https://hub.xsyd.top/keyboard/x.bin', 'https://hub.xsyd.top/storage/firmware/x.bin?b=1']) {
      expect(await downloadBuild(buildOf(file, { url }), { fetch: f as unknown as typeof fetch })).toEqual({ kind: 'fallback' });
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('sha256Hex is the SHA-256 of the bytes (Web Crypto)', async () => {
    expect(await sha256Hex(file)).toBe(createHash('sha256').update(file).digest('hex'));
    expect(parseFwList(TEXT).ok).toBe(true);
  });
});
