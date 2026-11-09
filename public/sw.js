// Static Service Worker for AE64 Max Control.
// Contains NO build-specific content so bytes never change between releases.
// Updates are applied manually only when requested by the user.

const META_CACHE = 'ae64-meta';
const META_KEY = '/__ae64_version__';

function parseVersion(v) {
  if (!v || typeof v !== 'string') return null;
  const trimmed = v.trim().replace(/^v/, '');
  const [coreAndPre, build] = trimmed.split('+');
  const [core, prerelease] = coreAndPre.split('-');
  const parts = core.split('.').map((p) => {
    const n = parseInt(p, 10);
    return isNaN(n) ? 0 : n;
  });
  return {
    major: parts[0] ?? 0,
    minor: parts[1] ?? 0,
    patch: parts[2] ?? 0,
    prerelease,
    build,
  };
}

function compareVersions(aStr, bStr) {
  if (aStr === bStr) return 0;
  const a = parseVersion(aStr);
  const b = parseVersion(bStr);
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;

  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;

  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease && a.prerelease !== b.prerelease) {
    return a.prerelease.localeCompare(b.prerelease);
  }

  if (!a.build && !b.build) return 0;
  if (a.build && !b.build) return 1;
  if (!a.build && b.build) return -1;

  const b1 = a.build;
  const b2 = b.build;
  if (b1 === b2) return 0;

  const norm1 = /^\d{12}$/.test(b1) ? `${b1}00` : b1;
  const norm2 = /^\d{12}$/.test(b2) ? `${b2}00` : b2;

  if (/^\d+$/.test(norm1) && /^\d+$/.test(norm2)) {
    if (norm1.length === norm2.length) {
      return norm1 > norm2 ? 1 : -1;
    }
    try {
      const diff = BigInt(norm1) - BigInt(norm2);
      return diff > 0n ? 1 : diff < 0n ? -1 : 0;
    } catch {}
  }

  return norm1.localeCompare(norm2);
}

function isNewerVersion(candidate, current) {
  if (!candidate) return false;
  if (!current) return true;
  return compareVersions(candidate, current) > 0;
}

async function getMeta() {
  try {
    const cache = await caches.open(META_CACHE);
    const res = await cache.match(META_KEY);
    if (!res) return { version: null, previous: null };
    const data = await res.json();
    return {
      version: data && data.version ? data.version : null,
      previous: data && data.previous ? data.previous : null,
    };
  } catch {
    return { version: null, previous: null };
  }
}

async function getCurrentVersion() {
  const meta = await getMeta();
  return meta.version;
}

async function setCurrentVersion(version, previous = null) {
  const cache = await caches.open(META_CACHE);
  const payload = { version };
  if (previous) payload.previous = previous;
  const res = new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
  await cache.put(META_KEY, res);
}

/** Release files are fetched past the HTTP cache (a CDN may add a long browser TTL to index.html). */
function freshRequests(files) {
  const base = (self.location && self.location.origin) ? self.location.origin : 'http://127.0.0.1';
  return files.map((f) => new Request(new URL(normalizePath(f), base).href, { cache: 'no-cache' }));
}

function normalizePath(p) {
  if (p === './' || p === '.') return '/';
  return p.startsWith('/') ? p : `/${p}`;
}

async function matchInCache(cache, request, url) {
  if (request.mode === 'navigate') {
    return (
      (await cache.match('/index.html')) ||
      (await cache.match('/')) ||
      (await cache.match('./'))
    );
  }
  return (await cache.match(request)) || (await cache.match(url.pathname));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const current = await getCurrentVersion();
      if (!current) {
        // First install: populate app cache from release.json
        const res = await fetch('/release.json', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to fetch release.json (HTTP ${res.status})`);
        }
        const release = await res.json();
        if (!release || !release.version || !Array.isArray(release.files)) {
          throw new Error('Invalid release.json manifest');
        }
        const appCache = await caches.open(`ae64-app-${release.version}`);
        await appCache.addAll(freshRequests(release.files));
        await setCurrentVersion(release.version);
      }
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const meta = await getMeta();
      const current = meta.version;
      let previous = meta.previous;

      const keys = await caches.keys();
      const appKeys = keys.filter((k) => k.startsWith('ae64-app-'));

      if (!previous && current) {
        const otherVersions = appKeys
          .map((k) => k.replace(/^ae64-app-/, ''))
          .filter((v) => v !== current);
        if (otherVersions.length > 0) {
          otherVersions.sort((a, b) => compareVersions(b, a));
          previous = otherVersions[0];
        }
      }

      const keep = new Set([META_CACHE]);
      if (current) keep.add(`ae64-app-${current}`);
      if (previous) keep.add(`ae64-app-${previous}`);

      await Promise.all(
        keys.map((k) => {
          if (keep.has(k)) return Promise.resolve();
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
      const keys = await caches.keys();
      const appKeys = keys.filter((k) => k.startsWith('ae64-app-'));

      // If no usable ae64-app cache exists at all (e.g. first visit before install): fall back to network
      if (appKeys.length === 0 && !current) {
        return fetch(request);
      }

      // 1. Try current cache first
      if (current && appKeys.includes(`ae64-app-${current}`)) {
        try {
          const cache = await caches.open(`ae64-app-${current}`);
          const match = await matchInCache(cache, request, url);
          if (match) return match;
        } catch {}
      }

      // 2. Cache miss: try caches.match across ALL ae64 caches before network
      if (request.mode !== 'navigate') {
        try {
          const directMatch = (await caches.match(request)) || (await caches.match(url.pathname));
          if (directMatch) return directMatch;
        } catch {}
      }

      // Check each other ae64 app cache individually
      for (const key of appKeys) {
        if (key === `ae64-app-${current}`) continue;
        try {
          const cache = await caches.open(key);
          const match = await matchInCache(cache, request, url);
          if (match) return match;
        } catch {}
      }

      // 3. Fall back to network
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
          const latest = release && release.version;
          const available = Boolean(latest && isNewerVersion(latest, current));
          port.postMessage({
            ok: true,
            current,
            latest,
            builtAt: release.builtAt,
            available,
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
        let newCacheCreated = false;
        try {
          const current = await getCurrentVersion();
          const offered = event.data && event.data.version;

          const res = await fetch('/release.json', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status} fetching release.json`);
          const release = await res.json();
          if (!release || !release.version || !Array.isArray(release.files)) {
            throw new Error('Invalid release.json manifest');
          }
          const latest = release.version;

          if (current && latest === current) {
            throw new Error(`Already running latest version ${current}`);
          }
          // Pages built before the offered version existed send a bare { type: 'apply' }: the user still pressed
          // Update, so they get the latest release (newer than theirs, checked below) instead of being stuck.
          if (offered && latest !== offered) {
            throw new Error(`Offered version ${offered} does not match latest ${latest}`);
          }
          if (current && !isNewerVersion(latest, current)) {
            throw new Error(`Latest version ${latest} is not newer than current ${current}`);
          }

          newCacheName = `ae64-app-${latest}`;

          // All-or-nothing download
          const newCache = await caches.open(newCacheName);
          newCacheCreated = true;
          await newCache.addAll(freshRequests(release.files));

          // Switch current version and record previous
          await setCurrentVersion(latest, current);

          // Prune caches: keep current + previous, prune older ones
          const keepCaches = new Set([META_CACHE, newCacheName]);
          if (current) {
            keepCaches.add(`ae64-app-${current}`);
          }
          const keys = await caches.keys();
          for (const k of keys) {
            if (k.startsWith('ae64-app-') && !keepCaches.has(k)) {
              try {
                await caches.delete(k);
              } catch {}
            }
          }

          port.postMessage({ ok: true, version: latest });
        } catch (err) {
          if (newCacheCreated && newCacheName) {
            try {
              const cur = await getCurrentVersion();
              if (!cur || newCacheName !== `ae64-app-${cur}`) {
                await caches.delete(newCacheName);
              }
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
