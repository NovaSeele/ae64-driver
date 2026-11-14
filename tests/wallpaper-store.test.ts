// Review J-1: the IndexedDB wallpaper store when the database "ae64" exists without our store (opened by devtools or an
// extension: an empty v1), is at a higher version, cannot be opened, is blocked, or the delete fails. jsdom has no
// IndexedDB: a minimal fake of the parts the store uses (open with and without a version, upgrade, one store, get / put /
// delete in a transaction that completes on a later task).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { IdbWallpaperStore, MemoryWallpaperStore, setWallpaperStore, type WallRecord } from '../src/data/wallpaperStore';
import { pageReload, useAppSettings } from '../src/data/appSettings';
import { APPCFG_DONE_KEY } from '../src/data/appcfgDone';
import { useDeviceStore } from '../src/stores/device';
import { t } from '../src/i18n/vi';

interface FakeDb { version: number; stores: Map<string, Map<string, unknown>> }
type FakeConn = ReturnType<FakeIdb['conn']>;
/**
 * The upgrade rule of real IndexedDB (review J-TEST-5): an open that raises the version first sends `versionchange` to every
 * other connection still open on that database; if any stays open, `blocked` fires and the upgrade WAITS until all of them
 * have closed. Every connection not yet closed is tracked (`openConns`).
 */
class FakeIdb {
  dbs = new Map<string, FakeDb>();
  opens: (number | undefined)[] = [];
  openConns = new Set<FakeConn>();
  failOpen = false;
  failDelete = false;
  /** ms a transaction takes before it completes (0: the next task). */
  txDelay = 0;
  blocked = 0;
  open(name: string, version?: number) {
    this.opens.push(version);
    const req: Record<string, unknown> & { result?: unknown; error?: unknown } = {};
    const fire = (k: string) => (req[k] as (() => void) | undefined)?.();
    const go = () => {
      if (this.failOpen) { req.error = new DOMException('open refused', 'UnknownError'); fire('onerror'); return; }
      let d = this.dbs.get(name);
      const fresh = !d;
      if (!d) { d = { version: 0, stores: new Map() }; this.dbs.set(name, d); }
      const db = d;
      if (version !== undefined && version < db.version) { req.error = new DOMException('lower version', 'VersionError'); fire('onerror'); return; }
      const target = version ?? (fresh ? 1 : db.version);
      const finish = () => {
        const conn = this.conn(db);
        req.result = conn;
        if (target > db.version) {
          db.version = target;
          conn.upgrading = true;
          fire('onupgradeneeded');
          conn.upgrading = false;
        }
        fire('onsuccess');
      };
      if (target <= db.version) { finish(); return; }
      const others = () => [...this.openConns].filter((c) => c.db === db);
      for (const c of others()) c.onversionchange?.();
      if (!others().length) { finish(); return; }
      this.blocked++;
      fire('onblocked');
      const waitAll = () => (others().length ? setTimeout(waitAll, 1) : finish());
      setTimeout(waitAll, 1);
    };
    setTimeout(go, 0);
    return req;
  }
  /** Another tab's connection: open until closed, ignores versionchange unless told. */
  hold(name: string, onVersionChange?: (c: FakeConn) => void): FakeConn {
    const c = this.conn(this.dbs.get(name)!);
    if (onVersionChange) c.onversionchange = () => onVersionChange(c);
    return c;
  }
  conn(d: FakeDb) {
    const self = this;
    const c = {
      db: d,
      upgrading: false,
      closed: false,
      onversionchange: null as null | (() => void),
      get version() { return d.version; },
      objectStoreNames: { contains: (n: string) => d.stores.has(n) },
      createObjectStore(n: string) {
        if (!c.upgrading) throw new DOMException('not in an upgrade', 'InvalidStateError');
        d.stores.set(n, new Map());
      },
      close() { c.closed = true; self.openConns.delete(c); },
      transaction(n: string) {
        if (c.closed) throw new DOMException('closed', 'InvalidStateError');
        const s = d.stores.get(n);
        if (!s) throw new DOMException(`no store ${n}`, 'NotFoundError');
        const tx: Record<string, unknown> & { error?: unknown } = {};
        const done = (apply: () => unknown, fails = false) => {
          const r: { result?: unknown } = {};
          setTimeout(() => {
            if (fails) { tx.error = new DOMException('delete failed', 'AbortError'); (tx.onerror as () => void)?.(); return; }
            r.result = apply();
            (tx.oncomplete as () => void)?.();
          }, self.txDelay);
          return r;
        };
        tx.objectStore = () => ({
          get: (k: string) => done(() => s.get(k)),
          put: (v: unknown, k: string) => done(() => { s.set(k, v); return k; }),
          delete: (k: string) => done(() => { s.delete(k); }, self.failDelete),
        });
        return tx;
      },
    };
    self.openConns.add(c);
    return c;
  }
}

const rec = (name = 'a.png'): WallRecord => ({
  v: 1, blob: new Blob(['img'], { type: 'image/png' }), name, type: 'image/png', size: 3, w: 2, h: 2,
  box: { lo: [0, 0, 0], hi: [255, 255, 255] }, savedAt: 1,
});
let idb: FakeIdb;

beforeEach(() => {
  idb = new FakeIdb();
  vi.stubGlobal('indexedDB', idb);
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  // every connection the store opened is closed again (a forgotten one would block the next upgrade, in this tab too)
  expect([...idb.openConns]).toEqual([]);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setWallpaperStore(new MemoryWallpaperStore());
  localStorage.clear();
  sessionStorage.clear();
});

describe('J-1: a database "ae64" made by someone else at v1 without the wallpaper store', () => {
  beforeEach(() => { idb.dbs.set('ae64', { version: 1, stores: new Map() }); });

  it('put creates the store one version up and stores; get reads it back (never blocked by its own connection)', { timeout: 1500 }, async () => {
    const s = new IdbWallpaperStore();
    await s.put(rec());
    expect(idb.blocked).toBe(0);
    expect(idb.dbs.get('ae64')!.version).toBe(2);
    expect(idb.dbs.get('ae64')!.stores.has('wallpaper')).toBe(true);
    expect((await s.get())?.name).toBe('a.png');
    expect(idb.opens).toEqual([undefined, 2, undefined]); // opened as it is, then v2 to create, then as it is
  });

  it('remove resolves (no image is stored) and changes nothing; get gives null', async () => {
    const s = new IdbWallpaperStore();
    await expect(s.remove()).resolves.toBeUndefined();
    await expect(s.get()).resolves.toBeNull();
    expect(idb.dbs.get('ae64')).toEqual({ version: 1, stores: new Map() });
  });

  it('reset: the keys go and the page reloads (no errWallpaper)', async () => {
    setWallpaperStore(new IdbWallpaperStore());
    localStorage.setItem('ae64.theme', 'ember');
    localStorage.setItem('ae64.accent', '#3a2bd1');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('reset');
    expect(localStorage.getItem('ae64.theme')).toBeNull();
    expect(localStorage.getItem('ae64.accent')).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('reset');
  });
});

describe('J-1: the other cases', () => {
  it('the delete itself fails → remove rejects, and a reset stops with errWallpaper (no keys removed, no reload)', async () => {
    const s = new IdbWallpaperStore();
    await s.put(rec());
    idb.failDelete = true;
    await expect(s.remove()).rejects.toThrow();
    setWallpaperStore(s);
    localStorage.setItem('ae64.theme', 'ember');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    await expect(useAppSettings().applyAndReload('reset')).rejects.toThrow(t('appcfg.errWallpaper'));
    expect(localStorage.getItem('ae64.theme')).toBe('ember');
    expect(reload).not.toHaveBeenCalled();
    idb.failDelete = false;
    await s.remove();
    await expect(s.get()).resolves.toBeNull();
  });

  it('a later build left the database at v5 (with the store): get / put / remove work, no VersionError', async () => {
    idb.dbs.set('ae64', { version: 5, stores: new Map([['wallpaper', new Map()]]) });
    const s = new IdbWallpaperStore();
    await s.put(rec('b.png'));
    expect((await s.get())?.name).toBe('b.png');
    await s.remove();
    await expect(s.get()).resolves.toBeNull();
    expect(idb.dbs.get('ae64')!.version).toBe(5);
    expect(idb.opens.every((v) => v === undefined)).toBe(true);
  });

  it('v5 without the store: put goes to v6', async () => {
    idb.dbs.set('ae64', { version: 5, stores: new Map() });
    await new IdbWallpaperStore().put(rec());
    expect(idb.dbs.get('ae64')!.version).toBe(6);
  });

  it('a fresh browser: put makes the store in the first open (v1), one open per call', async () => {
    const s = new IdbWallpaperStore();
    await s.put(rec());
    expect(idb.dbs.get('ae64')!.version).toBe(1);
    expect(idb.opens).toEqual([undefined]);
  });

  it('the database does not open: get gives null, remove resolves (a reset is not locked), put rejects (errStore)', async () => {
    idb.failOpen = true;
    const s = new IdbWallpaperStore();
    await expect(s.get()).resolves.toBeNull();
    await expect(s.remove()).resolves.toBeUndefined();
    await expect(s.put(rec())).rejects.toThrow();
  });

  it('blocked (another tab holds v1 open and ignores versionchange): waits, and finishes once that tab closes', async () => {
    idb.dbs.set('ae64', { version: 1, stores: new Map() });
    const other = idb.hold('ae64');
    let done = false;
    const p = new IdbWallpaperStore().put(rec()).then(() => { done = true; });
    await vi.waitFor(() => expect(idb.blocked).toBe(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false); // still waiting, not failed
    expect(idb.dbs.get('ae64')!.version).toBe(1);
    other.close();
    await p;
    expect(idb.dbs.get('ae64')!.stores.has('wallpaper')).toBe(true);
  });

  it('another tab that closes on versionchange does not block at all', async () => {
    idb.dbs.set('ae64', { version: 1, stores: new Map() });
    idb.hold('ae64', (c) => c.close());
    await new IdbWallpaperStore().put(rec());
    expect(idb.blocked).toBe(0);
    expect(idb.dbs.get('ae64')!.version).toBe(2);
  });

  it('our own connection closes when another tab upgrades (versionchange), so we never block it', async () => {
    idb.dbs.set('ae64', { version: 1, stores: new Map([['wallpaper', new Map()]]) });
    // our connection is open mid-transaction (it takes 200 ms) when another tab opens at v2
    idb.txDelay = 200;
    const s = new IdbWallpaperStore();
    const g = s.get();
    await vi.waitFor(() => expect(idb.openConns.size).toBe(1), { interval: 1 });
    const req = idb.open('ae64', 2) as unknown as Record<string, unknown>;
    let blocked = false;
    const opened = new Promise<void>((r) => { req.onsuccess = () => { (req.result as FakeConn).close(); r(); }; req.onblocked = () => { blocked = true; }; });
    await opened;
    expect(blocked).toBe(false);
    expect(idb.dbs.get('ae64')!.version).toBe(2);
    await expect(g).resolves.toBeNull(); // the transaction already running still completes
  });

  it('no IndexedDB at all: get null, remove resolves, put rejects', async () => {
    vi.stubGlobal('indexedDB', undefined);
    const s = new IdbWallpaperStore();
    await expect(s.get()).resolves.toBeNull();
    await expect(s.remove()).resolves.toBeUndefined();
    await expect(s.put(rec())).rejects.toThrow();
  });
});
