// The wallpaper at run time (DESIGN J §3.4–§3.7): checking a chosen file, measuring its colour box in a Worker, storing it,
// showing it (first frame under reduced motion), and the floors of the guard on the theme open now. Loaded on demand.
// Nothing here talks to the keyboard.
import { watch } from 'vue';
import { resolvedTheme, type ThemeId } from '../theme';
import { accentState, accentVarsFor } from '../accentCache';
import { t, type MessageKey } from '../i18n/vi';
import { getWallpaperStore, type ColourBox, type WallRecord } from './wallpaperStore';
import { readGuardTokens, wallFloors } from './wallpaperGuard';
import { panelApplied, wallState, type WallMeta } from './wallpaperState';
import { PANEL_MIN, writeWallPrefs, type WallPrefs } from './wallpaperPrefs';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_PIXELS = 40_000_000;
export type WallError = 'errType' | 'errSize' | 'errPixels' | 'errDecode' | 'errStore';
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/avif', 'image/gif'] as const;
/** At least this many points lower on the other side (Graphite ↔ Light) to suggest it (§3.6). */
export const HINT_GAP = 0.2;

/** The browser APIs the runtime uses, replaceable in tests (jsdom has no Worker, createImageBitmap or image decoding). */
export const wallEnv = {
  /** naturalWidth × naturalHeight through an <img> (waits for load, never decode()). */
  imageSize(blob: Blob): Promise<{ w: number; h: number }> {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve({ w: img.naturalWidth, h: img.naturalHeight }); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('load')); };
      img.src = url;
    });
  },
  createBitmap: (blob: Blob): Promise<ImageBitmap> => createImageBitmap(blob),
  /** The colour box, in a Worker (the bitmap is transferred and closed there). */
  scan(bitmap: ImageBitmap): Promise<ColourBox> {
    return new Promise((resolve, reject) => {
      const w = new Worker(new URL('./wallpaperScan.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<{ box?: ColourBox; error?: string }>) => {
        w.terminate();
        if (e.data.box) resolve(e.data.box);
        else reject(new Error(e.data.error ?? 'scan'));
      };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'worker')); };
      w.postMessage({ bitmap }, [bitmap]);
    });
  },
  /** GIF always; WebP / AVIF when ImageDecoder says the selected track is animated. */
  async isAnimated(blob: Blob, type: string): Promise<boolean> {
    if (type === 'image/gif') return true;
    if (type !== 'image/webp' && type !== 'image/avif') return false;
    const ID = (globalThis as unknown as { ImageDecoder?: new (o: { data: ReadableStream; type: string }) => { tracks: { ready: Promise<void>; selectedTrack: { animated: boolean } | null }; close(): void } }).ImageDecoder;
    if (!ID) return false;
    try {
      const d = new ID({ data: blob.stream(), type });
      await d.tracks.ready;
      const a = !!d.tracks.selectedTrack?.animated;
      d.close();
      return a;
    } catch {
      return false;
    }
  },
  /** The first frame as a PNG (createImageBitmap gives the first frame of an animated image). */
  async firstFrame(blob: Blob): Promise<Blob> {
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width;
    cv.height = bmp.height;
    cv.getContext('2d')!.drawImage(bmp, 0, 0);
    bmp.close();
    return new Promise((resolve, reject) => cv.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
  },
  /** Waits until the URL is decoded, so nothing changes shade before the image can show. */
  async decode(url: string): Promise<void> {
    const img = new Image();
    img.src = url;
    await img.decode();
  },
  reduceQuery: (): MediaQueryList | null =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null,
  createUrl: (b: Blob): string => URL.createObjectURL(b),
  revokeUrl: (u: string): void => URL.revokeObjectURL(u),
};

// ---- the file check (§3.4) ----

async function readHead(blob: Blob): Promise<Uint8Array> {
  const part = blob.slice(0, 16);
  if (typeof part.arrayBuffer === 'function') return new Uint8Array(await part.arrayBuffer());
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(new Uint8Array(fr.result as ArrayBuffer));
    fr.onerror = () => reject(fr.error);
    fr.readAsArrayBuffer(part);
  });
}
const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.slice(from, to));
/** The type the first bytes say, or null: PNG, JPEG, GIF, WebP (RIFF….WEBP), AVIF (ftyp + avif / avis). */
export function sniffType(b: Uint8Array): (typeof TYPES)[number] | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (ascii(b, 0, 4) === 'GIF8') return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP') return 'image/webp';
  if (ascii(b, 4, 8) === 'ftyp' && ['avif', 'avis'].includes(ascii(b, 8, 12))) return 'image/avif';
  return null;
}

// ---- showing it ----

let rec: WallRecord | null = null;
/** URLs made for the record shown now: the image, and its first frame when one was needed. */
let urls: string[] = [];
let gen = 0;

function setRootWall(on: boolean): void {
  const root = document.documentElement;
  if (on) {
    root.setAttribute('data-wall', '');
    root.style.setProperty('--panel-pct', `${Math.round(panelApplied.value * 100)}%`);
  } else {
    root.removeAttribute('data-wall');
    root.style.removeProperty('--panel-pct');
  }
}
function dropUrls(): void {
  for (const u of urls) wallEnv.revokeUrl(u);
  urls = [];
}

/** Shows `r` (or nothing); the old URLs are revoked once the new image is decoded. */
async function show(r: WallRecord | null): Promise<void> {
  const my = ++gen;
  if (!r) {
    rec = null;
    dropUrls();
    wallState.url = null;
    wallState.meta = null;
    wallState.hint = null;
    wallState.floor = { veil: 0, panel: PANEL_MIN };
    setRootWall(false);
    return;
  }
  const animated = await wallEnv.isAnimated(r.blob, r.type);
  const still = animated && wallState.reducedMotion;
  const made: string[] = [];
  let url: string;
  try {
    if (still) {
      url = wallEnv.createUrl(await wallEnv.firstFrame(r.blob));
    } else {
      url = wallEnv.createUrl(r.blob);
    }
    made.push(url);
    await wallEnv.decode(url);
  } catch (e) {
    for (const u of made) wallEnv.revokeUrl(u);
    throw e;
  }
  if (my !== gen) { for (const u of made) wallEnv.revokeUrl(u); return; }
  dropUrls();
  urls = made;
  rec = r;
  const meta: WallMeta = { name: r.name, type: r.type, size: r.size, w: r.w, h: r.h, animated };
  wallState.meta = meta;
  updateFloors();
  wallState.url = url;
  setRootWall(true);
}

// ---- the floors (§3.6): recomputed on a new image, a theme change (Auto too) and an accent change; not on a slider ----

/** The default theme of the other side: Graphite for a light theme, Light for a dark one. */
const otherSide = (light: boolean): ThemeId => (light ? 'graphite' : 'light');
const themeKey = (id: string) => id.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());

function otherTokens(id: ThemeId) {
  const el = document.createElement('div');
  el.setAttribute('data-theme', id);
  el.setAttribute('aria-hidden', 'true');
  el.style.display = 'none';
  document.body.appendChild(el);
  try {
    const acc = accentVarsFor(id)?.['--acc'];
    return readGuardTokens(el, acc ? { '--acc': acc } : {});
  } finally {
    el.remove();
  }
}

export function updateFloors(): void {
  if (!rec || typeof document === 'undefined') return;
  const tk = readGuardTokens();
  const f = wallFloors(rec.box, tk);
  wallState.floor = { veil: f.overlay, panel: f.panel };
  const light = getComputedStyle(document.documentElement).colorScheme.includes('light');
  const other = otherSide(light);
  const o = wallFloors(rec.box, otherTokens(other));
  wallState.hint = o.overlay <= f.overlay - HINT_GAP + 1e-9
    ? { kind: other === 'light' ? 'bright' : 'dark', theme: t(`theme.${themeKey(other)}` as MessageKey), veil: Math.round(o.overlay * 100) }
    : null;
  if (wallState.url) setRootWall(true);
}

// ---- what the settings card calls ----

/** Checks, measures, stores and shows a chosen file. The wallpaper shown stays as it was on any error. */
export async function chooseFile(file: Blob & { name?: string }): Promise<WallError | null> {
  const head = await readHead(file).catch(() => new Uint8Array());
  const sniffed = sniffType(head);
  if (!(TYPES as readonly string[]).includes(file.type) || !sniffed) return 'errType';
  if (file.size > MAX_BYTES) return 'errSize';
  let size: { w: number; h: number };
  try { size = await wallEnv.imageSize(file); } catch { return 'errDecode'; }
  if (!size.w || !size.h) return 'errDecode';
  if (size.w * size.h > MAX_PIXELS) return 'errPixels';
  let box: ColourBox;
  try {
    const bmp = await wallEnv.createBitmap(file);
    box = await wallEnv.scan(bmp);
  } catch {
    return 'errDecode';
  }
  const r: WallRecord = {
    v: 1, blob: file, name: file.name ?? '', type: sniffed, size: file.size, w: size.w, h: size.h, box, savedAt: Date.now(),
  };
  const prev = rec;
  try { await getWallpaperStore().put(r); } catch { return 'errStore'; }
  try {
    await show(r);
  } catch {
    // Stored but cannot show: put the old one back, so the next start shows what shows now.
    await (prev ? getWallpaperStore().put(prev) : getWallpaperStore().remove()).catch(() => { /* nothing more to do */ });
    return 'errDecode';
  }
  return null;
}

/** Removes the stored image; the way it shows (ae64.wallpaper) is kept for the next one. */
export async function removeWallpaper(): Promise<void> {
  await getWallpaperStore().remove();
  await show(null);
}

/** A slider or the fit: applied now; stored when `store` (a slider's commit, a fit pick). */
export function setWallPrefs(p: Partial<WallPrefs>, store: boolean): void {
  wallState.prefs = { ...wallState.prefs, ...p };
  if (store) writeWallPrefs(wallState.prefs);
}

// ---- start ----

let booted: Promise<void> | null = null;
let stopWatch: (() => void) | null = null;
let mql: MediaQueryList | null = null;
const onReduce = (e: MediaQueryListEvent) => {
  wallState.reducedMotion = e.matches;
  // Switch between the first frame and the moving image right away; only an animated image changes.
  if (rec && wallState.meta?.animated) void show(rec).catch(() => { /* keep what shows */ });
};

/** Once: the watchers, the reduced-motion listener, and the stored image if there is one. */
export function bootWallpaper(): Promise<void> {
  if (!booted) {
    mql = wallEnv.reduceQuery();
    wallState.reducedMotion = !!mql?.matches;
    mql?.addEventListener?.('change', onReduce);
    const w1 = watch([resolvedTheme, accentState], () => updateFloors());
    const w2 = watch(panelApplied, () => { if (wallState.url) setRootWall(true); });
    stopWatch = () => { w1(); w2(); };
    booted = getWallpaperStore().get().then((r) => (r ? show(r) : undefined)).catch(() => { /* no wallpaper */ });
  }
  return booted;
}

/** Tests only: back to the state before boot. */
export function resetWallpaperRuntime(): void {
  stopWatch?.();
  stopWatch = null;
  mql?.removeEventListener?.('change', onReduce);
  mql = null;
  booted = null;
  gen++;
  rec = null;
  dropUrls();
  wallState.url = null;
  wallState.meta = null;
  wallState.hint = null;
  wallState.floor = { veil: 0, panel: PANEL_MIN };
  if (typeof document !== 'undefined') setRootWall(false);
}
