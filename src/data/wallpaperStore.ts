// The wallpaper image, kept in this browser's IndexedDB (DESIGN J §3.8): db "ae64", store "wallpaper", key "current". Loaded
// on demand. Tests swap in the in-memory store (setWallpaperStore), so no IndexedDB polyfill is needed.
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB.open failed'));
    req.onblocked = () => reject(new Error('indexedDB.open blocked'));
  });
}

/** Runs one request in its own transaction; resolves with its result at transaction complete. */
async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
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
    if (typeof indexedDB === 'undefined') return null;
    const v = await run<unknown>('readonly', (s) => s.get(KEY));
    return isRecord(v) ? v : null;
  }
  async put(rec: WallRecord): Promise<void> {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    await run('readwrite', (s) => s.put(rec, KEY));
  }
  async remove(): Promise<void> {
    // No IndexedDB at all: there is no stored image to remove.
    if (typeof indexedDB === 'undefined') return;
    await run('readwrite', (s) => s.delete(KEY));
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
