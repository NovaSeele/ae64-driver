// The wallpaper image, kept in this browser's IndexedDB (DESIGN J §3.8): db "ae64", store "wallpaper", key "current". Loaded
// on demand. Tests swap in the in-memory store (setWallpaperStore); wallpaper-store.test.ts drives this one on a small fake.
import type { Rgb } from '../color';

export interface ColourBox { lo: Rgb; hi: Rgb }
export interface WallRecord {
  v: 1;
  blob: Blob;
  name: string;
  type: string;
  size: number;
  w: number;
  h: number;
  /** min and max of each channel over every pixel of the first frame, at native resolution (wallpaperScan.ts). */
  box: ColourBox;
  savedAt: number;
}
export interface WallpaperStore {
  get(): Promise<WallRecord | null>;
  put(rec: WallRecord): Promise<void>;
  /** Resolves only once the delete is committed (transaction complete), so a reload right after cannot undo it. */
  remove(): Promise<void>;
}

const DB = 'ae64';
const STORE = 'wallpaper';
const KEY = 'current';

const createStore = (db: IDBDatabase): void => { if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE); };

/** Opens "ae64" at `version`, or at whatever version it has (none given). Blocked (another tab holds an older version open)
 *  is waited out: onsuccess follows once that connection closes. Our own connections close when another one upgrades. */
function openAt(version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version === undefined ? indexedDB.open(DB) : indexedDB.open(DB, version);
    req.onupgradeneeded = () => upgrade?.(req.result);
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
  });
}

/**
 * The database with the wallpaper store, or null when it has none (nothing was ever stored). Opened without a version, so a
 * database someone else made at v1 without our store (devtools, an extension) or a later build's higher version still opens.
 * `create`: a missing store is made by reopening one version up.
 */
async function openDb(create: boolean): Promise<IDBDatabase | null> {
  const db = await openAt(undefined, create ? createStore : undefined);
  if (db.objectStoreNames.contains(STORE)) return db;
  const v = db.version;
  db.close();
  if (!create) return null;
  return openAt(v + 1, createStore);
}

/** Runs one request in its own transaction on an open database (closed after); resolves with its result at complete. */
async function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error ?? req.error ?? new Error('indexedDB transaction failed'));
      tx.onabort = () => reject(tx.error ?? new Error('indexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

const isRecord = (v: unknown): v is WallRecord =>
  typeof v === 'object' && v !== null && (v as WallRecord).v === 1 && (v as WallRecord).blob instanceof Blob
  && Array.isArray((v as WallRecord).box?.lo) && Array.isArray((v as WallRecord).box?.hi);

export class IdbWallpaperStore implements WallpaperStore {
  async get(): Promise<WallRecord | null> {
    const db = await this.existing();
    if (!db) return null;
    const v = await run<unknown>(db, 'readonly', (s) => s.get(KEY));
    return isRecord(v) ? v : null;
  }
  async put(rec: WallRecord): Promise<void> {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    const db = await openDb(true);
    await run(db!, 'readwrite', (s) => s.put(rec, KEY));
  }
  /**
   * No IndexedDB, a database that does not open, or no wallpaper store: no image is stored, so there is nothing to remove
   * (resolves; a reset must not be locked by it). Rejects only when the delete itself fails: the image may still be there.
   */
  async remove(): Promise<void> {
    const db = await this.existing();
    if (!db) return;
    await run(db, 'readwrite', (s) => s.delete(KEY));
  }
  /** The database when it holds the wallpaper store; null when there is none or it cannot be opened. */
  private async existing(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    try { return await openDb(false); } catch { return null; }
  }
}

export class MemoryWallpaperStore implements WallpaperStore {
  rec: WallRecord | null = null;
  async get(): Promise<WallRecord | null> { return this.rec; }
  async put(rec: WallRecord): Promise<void> { this.rec = rec; }
  async remove(): Promise<void> { this.rec = null; }
}

let current: WallpaperStore = new IdbWallpaperStore();
export const getWallpaperStore = (): WallpaperStore => current;
/** Tests only. */
export function setWallpaperStore(s: WallpaperStore): void { current = s; }
