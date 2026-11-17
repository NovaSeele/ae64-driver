import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../src/App.vue';
import SidebarFooter from '../src/components/shell/SidebarFooter.vue';
import { announceVersion, installChunkGuard, isChunkLoadError, useUpdateStore } from '../src/update';
import { t as tr } from '../src/i18n/vi';

class MockCache {
  map = new Map<string, Response>();

  async match(req: any): Promise<Response | undefined> {
    const urlStr = typeof req === 'string' ? req : req.url;
    const pathname = new URL(urlStr, 'http://127.0.0.1:5173').pathname;
    const res = this.map.get(pathname) || this.map.get(urlStr);
    if (!res) {
      for (const [k, v] of this.map.entries()) {
        if (k === pathname || k === `/${pathname}` || `/${k}` === pathname) return v.clone();
      }
      return undefined;
    }
    return res.clone();
  }

  async put(req: any, res: Response): Promise<void> {
    const urlStr = typeof req === 'string' ? req : req.url;
    const pathname = new URL(urlStr, 'http://127.0.0.1:5173').pathname;
    this.map.set(pathname, res.clone());
    this.map.set(urlStr, res.clone());
  }

  async addAll(requests: Request[]): Promise<void> {
    for (const req of requests) {
      const res = await (globalThis.fetch as any)(req);
      if (!res.ok) throw new Error(`Fetch failed for ${req.url}: ${res.status}`);
      await this.put(req, res);
    }
  }

  async delete(req: any): Promise<boolean> {
    const urlStr = typeof req === 'string' ? req : req.url;
    const pathname = new URL(urlStr, 'http://127.0.0.1:5173').pathname;
    const d1 = this.map.delete(pathname);
    const d2 = this.map.delete(urlStr);
    return d1 || d2;
  }
}

class MockCacheStorage {
  caches = new Map<string, MockCache>();

  async open(name: string): Promise<MockCache> {
    let c = this.caches.get(name);
    if (!c) {
      c = new MockCache();
      this.caches.set(name, c);
    }
    return c;
  }

  async keys(): Promise<string[]> {
    return Array.from(this.caches.keys());
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }

  async match(req: any): Promise<Response | undefined> {
    for (const c of this.caches.values()) {
      const hit = await c.match(req);
      if (hit) return hit;
    }
    return undefined;
  }
}

describe('Service Worker (public/sw.js)', () => {
  const swCode = fs.readFileSync(path.resolve('public/sw.js'), 'utf8');

  let mockCaches: MockCacheStorage;
  let listeners: Record<string, ((event: any) => void)[]>;
  let selfObj: any;
  /** The ids of the windows the worker sees as open (clients.matchAll). */
  let openWindows: string[];

  beforeEach(() => {
    openWindows = [];
    mockCaches = new MockCacheStorage();
    listeners = {
      install: [],
      activate: [],
      fetch: [],
      message: [],
    };

    selfObj = {
      location: new URL('http://127.0.0.1:5173/sw.js'),
      caches: mockCaches,
      addEventListener: (type: string, fn: (event: any) => void) => {
        if (!listeners[type]) listeners[type] = [];
        listeners[type].push(fn);
      },
      skipWaiting: vi.fn().mockResolvedValue(undefined),
      clients: {
        claim: vi.fn().mockResolvedValue(undefined),
        matchAll: vi.fn(async () => openWindows.map((id) => ({ id }))),
      },
    };

    // Run sw.js inside a function binding self and caches
    const runSw = new Function('self', 'caches', swCode);
    runSw(selfObj, mockCaches);
  });

  async function triggerInstall(): Promise<void> {
    let promise: Promise<void> | null = null;
    const event = {
      waitUntil: (p: Promise<void>) => {
        promise = p;
      },
    };
    for (const fn of listeners.install) fn(event);
    if (promise) await promise;
  }

  async function triggerMessage(data: any): Promise<any> {
    return new Promise((resolve) => {
      let promise: Promise<void> | null = null;
      const port = {
        postMessage: (reply: any) => {
          resolve(reply);
        },
      };
      const event = {
        data,
        ports: [port],
        waitUntil: (p: Promise<void>) => {
          promise = p;
        },
      };
      for (const fn of listeners.message) fn(event);
      if (promise) {
        (promise as Promise<void>).catch(() => undefined);
      }
    });
  }

  /** A page says which release it runs (no port, no reply). */
  async function hello(id: string, version: string): Promise<void> {
    let promise: Promise<void> | null = null;
    const event = { data: { type: 'hello', version }, ports: [], source: { id }, waitUntil: (p: Promise<void>) => { promise = p; } };
    for (const fn of listeners.message) fn(event);
    if (promise) await promise;
  }

  async function triggerActivate(): Promise<void> {
    let promise: Promise<void> | null = null;
    for (const fn of listeners.activate) fn({ waitUntil: (p: Promise<void>) => { promise = p; } });
    if (promise) await promise;
  }

  /** release.json of `version` with `files`; each file's body from `bodies` (or 'x'). */
  function serve(version: string, files: string[], bodies: Record<string, string> = {}) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (req: any) => {
      const url = typeof req === 'string' ? req : req.url;
      const p = new URL(url, 'http://127.0.0.1:5173').pathname;
      if (p === '/release.json') return { ok: true, status: 200, json: async () => ({ version, files }) };
      return new Response(bodies[p] ?? 'x', { status: 200 });
    }));
  }

  async function triggerFetch(request: Request): Promise<Response> {
    let promise: Promise<Response> | null = null;
    const event = {
      request,
      respondWith: (p: Promise<Response>) => {
        promise = p;
      },
    };
    for (const fn of listeners.fetch) fn(event);
    if (!promise) {
      return (globalThis.fetch as any)(request);
    }
    return promise;
  }

  describe('install', () => {
    it('install with bad release.json throws', async () => {
      // Mock fetch returning 500 error for /release.json
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      }));

      await expect(triggerInstall()).rejects.toThrow();
    });

    it('install with invalid manifest (missing files) throws', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.1.0' }), // missing files array
      }));

      await expect(triggerInstall()).rejects.toThrow();
    });

    it('install with valid release.json caches all files and sets version', async () => {
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (req: any) => {
        const url = typeof req === 'string' ? req : req.url;
        if (url.includes('/release.json')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              version: '0.1.0+20261109002016',
              files: ['./', 'index.html', 'assets/index.js'],
            }),
          };
        }
        return new Response(`content of ${url}`, { status: 200 });
      }));

      await triggerInstall();

      const appCache = await mockCaches.open('ae64-app-0.1.0+20261109002016');
      const indexMatch = await appCache.match('/index.html');
      expect(indexMatch).toBeDefined();

      const metaCache = await mockCaches.open('ae64-meta');
      const metaMatch = await metaCache.match('/__ae64_version__');
      expect(metaMatch).toBeDefined();
      const meta = await metaMatch!.json();
      expect(meta.version).toBe('0.1.0+20261109002016');
    });

    it('fetches unhashed files past the HTTP cache, hashed assets from it', async () => {
      const seen = new Map<string, RequestCache>();
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (req: any) => {
        const url = typeof req === 'string' ? req : req.url;
        if (url.includes('/release.json')) {
          return { ok: true, status: 200, json: async () => ({ version: '0.1.0+20261109002016', files: ['./', 'index.html', 'manifest.webmanifest', 'favicon.svg', 'assets/index-abc.js', 'assets/inter-latin-wght-normal-x.woff2'] }) };
        }
        seen.set(new URL(url).pathname, (req as Request).cache);
        return new Response('x', { status: 200 });
      }));

      await triggerInstall();

      for (const p of ['/', '/index.html', '/manifest.webmanifest', '/favicon.svg']) expect(seen.get(p)).toBe('no-cache');
      for (const p of ['/assets/index-abc.js', '/assets/inter-latin-wght-normal-x.woff2']) expect(seen.get(p)).toBe('default');
    });
  });

  describe('check', () => {
    it('returns available: true when server has newer version', async () => {
      // Setup current version
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0' })));

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.2.0', builtAt: '2026-11-09T00:00:00Z' }),
      }));

      const reply = await triggerMessage({ type: 'check' });
      expect(reply.ok).toBe(true);
      expect(reply.available).toBe(true);
      expect(reply.latest).toBe('0.2.0');
    });

    it('returns available: false on downgrade or equal version', async () => {
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put(
        '/__ae64_version__',
        new Response(JSON.stringify({ version: '0.2.0+20261109002016' }))
      );

      // Server has older version
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.1.0+202611082200', builtAt: '2026-11-08T22:00:00Z' }),
      }));

      const reply = await triggerMessage({ type: 'check' });
      expect(reply.ok).toBe(true);
      expect(reply.available).toBe(false);
    });
  });

  describe('apply', () => {
    it('apply with latest == current aborts and keeps current cache', async () => {
      // Setup current cache and meta
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0' })));

      const appCache = await mockCaches.open('ae64-app-0.1.0');
      await appCache.put('/index.html', new Response('<html>current</html>'));

      // Server returns same version 0.1.0
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.1.0', files: ['/index.html'] }),
      }));

      const reply = await triggerMessage({ type: 'apply', version: '0.1.0' });

      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/already running/i);

      // Verify current cache is untouched
      const stillHasApp = await mockCaches.caches.has('ae64-app-0.1.0');
      expect(stillHasApp).toBe(true);
      const match = await appCache.match('/index.html');
      expect(await match?.text()).toBe('<html>current</html>');
    });

    it('apply with offered != latest aborts and keeps current cache', async () => {
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0' })));

      const appCache = await mockCaches.open('ae64-app-0.1.0');
      await appCache.put('/index.html', new Response('<html>current</html>'));

      // Server returns 0.3.0 while offered was 0.2.0
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.3.0', files: ['/index.html'] }),
      }));

      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });

      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/does not match latest/i);

      // Verify current cache is untouched
      const match = await appCache.match('/index.html');
      expect(await match?.text()).toBe('<html>current</html>');
    });

    it('apply from an old page (no offered version) updates to the latest newer release', async () => {
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0+202611081700' })));
      const appCache = await mockCaches.open('ae64-app-0.1.0+202611081700');
      await appCache.put('/index.html', new Response('<html>old</html>'));
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async () => ({
        ok: true,
        clone() { return this; },
        json: async () => ({ version: '0.1.0+20261108201715', files: ['/index.html'] }),
        text: async () => '<html>new</html>',
      })));

      const reply = await triggerMessage({ type: 'apply' });

      expect(reply.ok).toBe(true);
      const meta = await (await metaCache.match('/__ae64_version__'))!.json();
      expect(meta.version).toBe('0.1.0+20261108201715');
    });

    it('apply addAll failure keeps current cache and deletes only new cache', async () => {
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0' })));

      const appCache = await mockCaches.open('ae64-app-0.1.0');
      await appCache.put('/index.html', new Response('<html>current</html>'));

      // Server returns 0.2.0, but addAll fails
      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (req: any) => {
        const url = typeof req === 'string' ? req : req.url;
        if (url.includes('/release.json')) {
          return {
            ok: true,
            json: async () => ({ version: '0.2.0', files: ['/assets/missing.js'] }),
          };
        }
        // assets fetch fails
        return { ok: false, status: 404 };
      }));

      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });

      expect(reply.ok).toBe(false);

      // Current cache must be intact
      expect(mockCaches.caches.has('ae64-app-0.1.0')).toBe(true);
      const match = await appCache.match('/index.html');
      expect(await match?.text()).toBe('<html>current</html>');

      // The failed new cache must be deleted
      expect(mockCaches.caches.has('ae64-app-0.2.0')).toBe(false);
    });

    it('successful apply keeps current + one previous and prunes older ones', async () => {
      // 3 existing versions: 0.0.8 (oldest), 0.0.9 (previous), 0.1.0 (current)
      const oldCache = await mockCaches.open('ae64-app-0.0.8');
      await oldCache.put('/chunk-old.js', new Response('0.0.8'));

      const prevCache = await mockCaches.open('ae64-app-0.0.9');
      await prevCache.put('/chunk-prev.js', new Response('0.0.9'));

      const curCache = await mockCaches.open('ae64-app-0.1.0');
      await curCache.put('/index.html', new Response('0.1.0'));

      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put(
        '/__ae64_version__',
        new Response(JSON.stringify({ version: '0.1.0', previous: '0.0.9' }))
      );

      vi.stubGlobal('fetch', vi.fn().mockImplementation(async (req: any) => {
        const url = typeof req === 'string' ? req : req.url;
        if (url.includes('/release.json')) {
          return {
            ok: true,
            json: async () => ({ version: '0.2.0', files: ['/index.html'] }),
          };
        }
        return new Response('0.2.0 index', { status: 200 });
      }));

      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });
      expect(reply.ok).toBe(true);
      expect(reply.version).toBe('0.2.0');

      // New cache exists
      expect(mockCaches.caches.has('ae64-app-0.2.0')).toBe(true);
      // Previous version (0.1.0) is kept
      expect(mockCaches.caches.has('ae64-app-0.1.0')).toBe(true);
      // Older cache (0.0.8) is pruned
      expect(mockCaches.caches.has('ae64-app-0.0.8')).toBe(false);
    });
  });

  describe('WX7 4a: the release an open window runs keeps its cache', () => {
    async function setup() {
      for (const v of ['0.0.8', '0.0.9', '0.1.0']) await (await mockCaches.open(`ae64-app-${v}`)).put('/index.html', new Response(v));
      await (await mockCaches.open('ae64-meta')).put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0', previous: '0.0.9' })));
    }
    const windowsMap = async () => (await (await mockCaches.open('ae64-meta')).match('/__ae64_windows__'))!.json();

    it('a window on the previous-but-one release keeps its cache through an apply; it goes once that window closed', async () => {
      await setup();
      openWindows = ['A', 'B'];
      await hello('A', '0.0.8');
      await hello('B', '0.1.0');
      serve('0.2.0', ['index.html']);
      expect((await triggerMessage({ type: 'apply', version: '0.2.0' })).ok).toBe(true);
      expect([...mockCaches.caches.keys()].filter((k) => k.startsWith('ae64-app-')).sort())
        .toEqual(['ae64-app-0.0.8', 'ae64-app-0.1.0', 'ae64-app-0.2.0']); // 0.0.9: no window runs it
      // window A still loads its own lazy chunk
      await (await mockCaches.open('ae64-app-0.0.8')).put('/assets/old-page.js', new Response('old page'));
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('gone', { status: 404 })));
      expect(await (await triggerFetch(new Request('http://127.0.0.1:5173/assets/old-page.js'))).text()).toBe('old page');
      // A closes; the next apply prunes 0.0.8 (and forgets A)
      openWindows = ['B'];
      serve('0.3.0', ['index.html']);
      expect((await triggerMessage({ type: 'apply', version: '0.3.0' })).ok).toBe(true);
      expect(mockCaches.caches.has('ae64-app-0.0.8')).toBe(false);
      expect(await windowsMap()).toEqual({ B: '0.1.0' });
      expect(mockCaches.caches.has('ae64-app-0.1.0')).toBe(true); // B's
    });

    it('activate keeps the caches of open windows too', async () => {
      await setup();
      openWindows = ['A'];
      await hello('A', '0.0.8');
      await triggerActivate();
      expect(mockCaches.caches.has('ae64-app-0.0.8')).toBe(true);
      openWindows = [];
      await triggerActivate();
      expect(mockCaches.caches.has('ae64-app-0.0.8')).toBe(false);
      expect(mockCaches.caches.has('ae64-app-0.0.9')).toBe(true); // previous
    });

    it('hello messages from two windows at once are both kept', async () => {
      openWindows = ['A', 'B'];
      await Promise.all([hello('A', '0.0.8'), hello('B', '0.0.9')]);
      expect(await windowsMap()).toEqual({ A: '0.0.8', B: '0.0.9' });
    });
  });

  describe('WX7 4b: the new index.html is checked against the release before the switch', () => {
    async function current() {
      await (await mockCaches.open('ae64-app-0.1.0')).put('/index.html', new Response('<html>current</html>'));
      await (await mockCaches.open('ae64-meta')).put('/__ae64_version__', new Response(JSON.stringify({ version: '0.1.0', previous: '0.0.9' })));
    }
    async function meta() {
      return (await (await mockCaches.open('ae64-meta')).match('/__ae64_version__'))!.json();
    }
    const page = (js: string, css = '/assets/index-new.css', pre = '/assets/vue-new.js') =>
      `<!doctype html><html><head><script type="module" crossorigin src="${js}"></script>` +
      `<link rel="modulepreload" crossorigin href="${pre}"><link rel="stylesheet" crossorigin href="${css}"></head><body></body></html>`;
    const FILES = ['./', 'index.html', 'assets/index-new.js', 'assets/index-new.css', 'assets/vue-new.js'];

    it('an index.html that loads a script not in the release fails the apply; the current cache and version stay', async () => {
      await current();
      serve('0.2.0', FILES, { '/index.html': page('/assets/index-old.js') });
      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/index-old\.js/);
      expect(mockCaches.caches.has('ae64-app-0.2.0')).toBe(false);
      expect((await meta()).version).toBe('0.1.0');
      expect(await (await (await mockCaches.open('ae64-app-0.1.0')).match('/index.html'))!.text()).toBe('<html>current</html>');
    });

    it('the stylesheet and the modulepreload are checked too', async () => {
      await current();
      serve('0.2.0', FILES, { '/index.html': page('/assets/index-new.js', '/assets/index-old.css') });
      expect((await triggerMessage({ type: 'apply', version: '0.2.0' })).ok).toBe(false);
      serve('0.2.0', FILES, { '/index.html': page('/assets/index-new.js', '/assets/index-new.css', '/assets/vue-old.js') });
      expect((await triggerMessage({ type: 'apply', version: '0.2.0' })).ok).toBe(false);
      expect((await meta()).version).toBe('0.1.0');
    });

    it('a listed file the cache does not hold fails it as well', async () => {
      await current();
      serve('0.2.0', FILES, { '/index.html': page('/assets/index-new.js') });
      const realOpen = mockCaches.open.bind(mockCaches);
      vi.spyOn(mockCaches, 'open').mockImplementation(async (name: string) => {
        const c = await realOpen(name);
        if (name === 'ae64-app-0.2.0') {
          const put = MockCache.prototype.put.bind(c);
          c.put = async (req: any, res: Response) => { if (!String(req.url ?? req).endsWith('/assets/vue-new.js')) await put(req, res); };
        }
        return c;
      });
      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/vue-new\.js/);
      expect((await meta()).version).toBe('0.1.0');
    });

    it('a file left in a stale cache of the same name does not pass: it must be in the release list', async () => {
      await current();
      // an earlier attempt left ae64-app-0.2.0 behind with a file the release does not list
      await (await mockCaches.open('ae64-app-0.2.0')).put('/assets/index-old.js', new Response('old'));
      serve('0.2.0', FILES, { '/index.html': page('/assets/index-old.js') });
      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/release list/);
      expect((await meta()).version).toBe('0.1.0');
    });

    it('a release without index.html is refused', async () => {
      await current();
      serve('0.2.0', ['./', 'assets/index-new.js'], { '/': page('/assets/index-new.js') });
      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });
      expect(reply.ok).toBe(false);
      expect(reply.error).toMatch(/no index\.html/);
      expect((await meta()).version).toBe('0.1.0');
      expect(mockCaches.caches.has('ae64-app-0.2.0')).toBe(false);
    });

    it('an index.html that matches its release applies (relative ./assets paths too)', async () => {
      await current();
      serve('0.2.0', FILES, { '/index.html': page('./assets/index-new.js') });
      const reply = await triggerMessage({ type: 'apply', version: '0.2.0' });
      expect(reply.ok).toBe(true);
      expect((await meta()).version).toBe('0.2.0');
    });

    it('a first install with a mismatched index.html fails and leaves no cache or version', async () => {
      serve('0.2.0', FILES, { '/index.html': page('/assets/index-old.js') });
      await expect(triggerInstall()).rejects.toThrow(/index-old\.js/);
      expect(mockCaches.caches.has('ae64-app-0.2.0')).toBe(false);
      expect(await (await mockCaches.open('ae64-meta')).match('/__ae64_version__')).toBeUndefined();
    });
  });

  describe('fetch handler', () => {
    it('cache miss falls back to other ae64 caches', async () => {
      // Current cache 0.2.0
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put(
        '/__ae64_version__',
        new Response(JSON.stringify({ version: '0.2.0', previous: '0.1.0' }))
      );

      const cacheNew = await mockCaches.open('ae64-app-0.2.0');
      await cacheNew.put('/assets/new-chunk.js', new Response('new content'));

      // Previous cache 0.1.0 has the lazy chunk an older tab wants
      const cacheOld = await mockCaches.open('ae64-app-0.1.0');
      await cacheOld.put('/assets/old-chunk.js', new Response('lazy old chunk body'));

      // Network returns 404
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not found', { status: 404 })));

      const req = new Request('http://127.0.0.1:5173/assets/old-chunk.js');
      const res = await triggerFetch(req);

      expect(res).toBeDefined();
      expect(await res.text()).toBe('lazy old chunk body');
    });

    it('falls back to network when asset is not in any cache', async () => {
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.2.0' })));

      const cacheNew = await mockCaches.open('ae64-app-0.2.0');
      await cacheNew.put('/assets/known.js', new Response('known'));

      const networkFetch = vi.fn().mockResolvedValue(new Response('from network', { status: 200 }));
      vi.stubGlobal('fetch', networkFetch);

      const req = new Request('http://127.0.0.1:5173/assets/unknown.js');
      const res = await triggerFetch(req);

      expect(networkFetch).toHaveBeenCalled();
      expect(await res.text()).toBe('from network');
    });

    it('first visit with no caches falls back to network', async () => {
      // No meta, no caches
      const networkFetch = vi.fn().mockResolvedValue(new Response('first visit html', { status: 200 }));
      vi.stubGlobal('fetch', networkFetch);

      const req = new Request('http://127.0.0.1:5173/index.html');
      const res = await triggerFetch(req);

      expect(networkFetch).toHaveBeenCalled();
      expect(await res.text()).toBe('first visit html');
    });

    it('OFU §8: /firmware/manifest.json goes to the network with no-store and is put in no cache, even when a cache holds it', async () => {
      const metaCache = await mockCaches.open('ae64-meta');
      await metaCache.put('/__ae64_version__', new Response(JSON.stringify({ version: '0.2.0' })));
      const app = await mockCaches.open('ae64-app-0.2.0');
      await app.put('/firmware/manifest.json', new Response('{"stale":true}'));
      const networkFetch = vi.fn().mockResolvedValue(new Response('{"schema":1}', { status: 200, headers: { 'content-type': 'application/json' } }));
      vi.stubGlobal('fetch', networkFetch);
      const before = new Map([...mockCaches.caches].map(([k, c]) => [k, c.map.size]));
      const res = await triggerFetch(new Request('http://127.0.0.1:5173/firmware/manifest.json'));
      expect(await res.text()).toBe('{"schema":1}');
      expect(networkFetch).toHaveBeenCalledTimes(1);
      expect(networkFetch.mock.calls[0][1]).toEqual({ cache: 'no-store', referrerPolicy: 'no-referrer' });
      expect(new Map([...mockCaches.caches].map(([k, c]) => [k, c.map.size]))).toEqual(before);
      // and any other path under /firmware/ the same way
      await triggerFetch(new Request('http://127.0.0.1:5173/firmware/other.json'));
      expect(networkFetch.mock.calls[1][1]).toEqual({ cache: 'no-store', referrerPolicy: 'no-referrer' });
    });

    it('OFU §8: a cross-origin request (a firmware file on hub.xsyd.top) is left to the browser', async () => {
      let answered = false;
      for (const fn of listeners.fetch) fn({ request: new Request('https://hub.xsyd.top/storage/firmware/x.bin'), respondWith: () => { answered = true; } });
      expect(answered).toBe(false);
    });
  });
});

// WX7 4a, the page side: a lazy chunk that fails to load shows "a newer version is installed" with a reload button, and the
// page never reloads by itself; a page tells the worker which release it runs.
describe('WX7 4a: the page after a chunk fails to load', () => {
  let restore: (() => void) | null = null;
  let reload: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { value: { ...orig, reload }, writable: true, configurable: true });
    restore = () => Object.defineProperty(window, 'location', { value: orig, writable: true, configurable: true });
  });
  afterEach(() => {
    restore?.();
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  const failing = () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: https://ae64.novaseele.com/assets/KeymapPage-old.js'));

  it('a route whose chunk is gone: the note and its button show, the page stays and does not reload', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [
      { path: '/', component: { template: '<p class="pg">overview</p>' } },
      { path: '/keymap', component: failing },
    ] });
    const update = useUpdateStore();
    const off = installChunkGuard(router, () => update.noteChunkFailed());
    await router.push('/');
    const w = mount(App, { global: { plugins: [router], stubs: { Sidebar: true, TopBar: true, ConnectScreen: true } }, attachTo: document.body });
    await flushPromises();
    expect(w.find('[data-test="chunk-failed"]').exists()).toBe(false);
    await router.push('/keymap').catch(() => undefined);
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/'); // the navigation failed, the page stayed
    const note = w.find('[data-test="chunk-failed"]');
    expect(note.exists()).toBe(true);
    expect(note.attributes('role')).toBe('alert');
    expect(note.text()).toContain(tr('update.chunkFailed'));
    expect(note.find('button').text()).toBe(tr('update.reloadNow'));
    await new Promise((r) => setTimeout(r, 50));
    expect(reload).not.toHaveBeenCalled(); // never by itself
    await note.find('button').trigger('click'); // the user presses it
    await flushPromises();
    expect(reload).toHaveBeenCalledTimes(1);
    w.unmount();
    off();
  });

  it('vite:preloadError notes it too (and leaves the event alone); other router errors do not', async () => {
    const update = useUpdateStore();
    const handlers: ((e: unknown) => void)[] = [];
    const off = installChunkGuard({ onError: (h: (e: unknown) => void) => { handlers.push(h); return () => undefined; } } as never, () => update.noteChunkFailed());
    handlers[0](new Error('a guard threw'));
    expect(update.chunkFailed).toBe(false);
    const e = new Event('vite:preloadError', { cancelable: true });
    window.dispatchEvent(e);
    expect(update.chunkFailed).toBe(true);
    expect(e.defaultPrevented).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    off();
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true); // Safari
    expect(isChunkLoadError(new TypeError('error loading dynamically imported module: x'))).toBe(true); // Firefox
    expect(isChunkLoadError(new Error('Unable to preload CSS for /assets/a.css'))).toBe(true);
    expect(isChunkLoadError(new Error('Navigation cancelled'))).toBe(false);
  });

  it('a page tells the worker its release, now and when a worker takes control', () => {
    const listeners: Record<string, () => void> = {};
    const sw = { controller: { postMessage: vi.fn() }, addEventListener: (t: string, f: () => void) => { listeners[t] = f; } };
    announceVersion(sw as never, '0.1.0+20261115');
    expect(sw.controller.postMessage).toHaveBeenCalledWith({ type: 'hello', version: '0.1.0+20261115' });
    listeners.controllerchange();
    expect(sw.controller.postMessage).toHaveBeenCalledTimes(2);
  });
});

// WX7 4b, the page side: the worker refused the new release (its index.html did not match): the page says the update
// failed, keeps running, and does not reload.
describe('WX7 4b: the page after a refused update', () => {
  it('"Cập nhật thất bại" with the reason, the version unchanged, no reload', async () => {
    setActivePinia(createPinia());
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { value: { ...orig, reload }, writable: true, configurable: true });
    const why = 'index.html of the new release needs /assets/index-old.js, which its release list does not have';
    const controller = { postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => { if (msg.type === 'apply') ports[0].postMessage({ ok: false, error: why }); }) };
    Object.defineProperty(navigator, 'serviceWorker', { value: { controller, ready: Promise.resolve({}) }, configurable: true });
    try {
      const update = useUpdateStore();
      update.availableInfo = { version: '0.2.0', builtAt: '' };
      update.state = 'available';
      await update.apply();
      expect(update.state).toBe('error');
      expect(update.applyFailed).toBe(true);
      expect(reload).not.toHaveBeenCalled();
      const w = mount(SidebarFooter, { attachTo: document.body });
      await w.find('.side-foot__btn').trigger('click');
      await flushPromises();
      expect(document.body.textContent).toContain(tr('update.applyFailed', { error: why }));
      expect(document.body.textContent).not.toContain(tr('update.failed', { error: why }));
      // a check afterwards is a check again
      update.state = 'error';
      update.applyFailed = false;
      await flushPromises();
      expect(document.body.textContent).toContain(tr('update.failed', { error: why }));
      w.unmount();
    } finally {
      Reflect.deleteProperty(navigator, 'serviceWorker');
      Object.defineProperty(window, 'location', { value: orig, writable: true, configurable: true });
      document.body.innerHTML = '';
    }
  });
});
