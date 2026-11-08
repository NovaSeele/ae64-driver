// Static Service Worker for AE64 Max Control.
// Contains NO build-specific content so bytes never change between releases.
// Updates are applied manually only when requested by the user.

const META_CACHE = 'ae64-meta';
const META_KEY = '/__ae64_version__';

async function getCurrentVersion() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(META_KEY);
    if (!res) return null;
    const data = await res.json();
    return data && data.version ? data.version : null;
  } catch {
    return null;
  }
}

async function setCurrentVersion(version) {
  const cache = await caches.open(META_CACHE);
  const res = new Response(JSON.stringify({ version }), {
    headers: { 'Content-Type': 'application/json' },
  });
  await cache.put(META_KEY, res);
}

/** Release files are fetched past the HTTP cache (a CDN may add a long browser TTL to index.html). */
function freshRequests(files) {
  return files.map((f) => new Request(normalizePath(f), { cache: 'no-cache' }));
}

function normalizePath(p) {
  if (p === './' || p === '.') return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const current = await getCurrentVersion();
      if (!current) {
        // First install: populate app cache from release.json
        const res = await fetch('/release.json', { cache: 'no-store' });
        if (res.ok) {
          const release = await res.json();
          if (release && release.version && Array.isArray(release.files)) {
            const appCache = await caches.open(`ae64-app-${release.version}`);
            await appCache.addAll(freshRequests(release.files));
            await setCurrentVersion(release.version);
          }
        }
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const current = await getCurrentVersion();
      const keepCache = current ? `ae64-app-${current}` : null;
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          if (k === META_CACHE) return Promise.resolve();
          if (keepCache && k === keepCache) return Promise.resolve();
          return caches.delete(k);
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // release.json and sw.js always go to network (no-store)
  if (url.pathname === '/release.json' || url.pathname === '/sw.js') {
    event.respondWith(fetch(request, { cache: 'no-store' }));
    return;
  }

  event.respondWith(
    (async () => {
      const current = await getCurrentVersion();
      if (!current) {
        return fetch(request);
      }

      const cache = await caches.open(`ae64-app-${current}`);

      // Navigations -> cached index.html of the current version
      if (request.mode === 'navigate') {
        const cachedIndex =
          (await cache.match('/index.html')) ||
          (await cache.match('/')) ||
          (await cache.match('./'));
        if (cachedIndex) return cachedIndex;
        return fetch(request);
      }

      // Other app files -> cache first, network fallback (store nothing new automatically)
      const cached = (await cache.match(request)) || (await cache.match(url.pathname));
      if (cached) return cached;

      return fetch(request);
    })()
  );
});

self.addEventListener('message', (event) => {
  const port = event.ports && event.ports[0];
  if (!port || !event.data || typeof event.data !== 'object') return;

  const { type } = event.data;

  if (type === 'check') {
    event.waitUntil(
      (async () => {
        try {
          const current = await getCurrentVersion();
          const res = await fetch('/release.json', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching release.json`);
          const release = await res.json();
          const latest = release.version;
          port.postMessage({
            ok: true,
            current,
            latest,
            builtAt: release.builtAt,
            available: Boolean(latest && latest !== current),
          });
        } catch (err) {
          port.postMessage({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })()
    );
  } else if (type === 'apply') {
    event.waitUntil(
      (async () => {
        let newCacheName = null;
        try {
          const current = await getCurrentVersion();
          const res = await fetch('/release.json', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching release.json`);
          const release = await res.json();
          const latest = release.version;
          newCacheName = `ae64-app-${latest}`;

          // All-or-nothing download
          const newCache = await caches.open(newCacheName);
          try {
            await newCache.addAll(freshRequests(release.files));
          } catch (err) {
            await caches.delete(newCacheName);
            throw err;
          }

          // Switch current version
          await setCurrentVersion(latest);

          // Delete old app cache
          if (current && current !== latest) {
            await caches.delete(`ae64-app-${current}`);
          }

          port.postMessage({ ok: true, version: latest });
        } catch (err) {
          if (newCacheName) {
            try {
              await caches.delete(newCacheName);
            } catch {}
          }
          port.postMessage({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })()
    );
  }
});
