import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

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

  beforeEach(() => {
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
  });
});
