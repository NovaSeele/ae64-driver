// DESIGN J §3.4, §3.5, §3.7, §11 tests 8–11 and 13, and the Slider `floor` (§3.4): the file check, reduced motion, the
// floors against the user's values, the blob URLs, and the --panel token. The browser APIs jsdom lacks (Worker,
// createImageBitmap, image decoding) are stubbed through wallEnv; the theme tokens are the real themes.css.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Slider from '../src/components/ui/Slider.vue';
import { setTheme } from '../src/theme';
import { MemoryWallpaperStore, setWallpaperStore, type ColourBox, type WallRecord } from '../src/data/wallpaperStore';
import { bootWallpaper, chooseFile, removeWallpaper, resetWallpaperRuntime, setWallPrefs, sniffType, wallEnv, MAX_BYTES } from '../src/data/wallpaperRuntime';
import { panelApplied, veilApplied, wallState } from '../src/data/wallpaperState';
import { parseWallPrefs, readWallPrefs, wallpaperPrefsValid, WALL_DEFAULTS, WALLPAPER_KEY } from '../src/data/wallpaperPrefs';

const THEMES_CSS = readFileSync(resolve('src/styles/themes.css'), 'utf8');
const DUSK: ColourBox = { lo: [4, 8, 23], hi: [89, 77, 129] };

const HEAD: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/gif': [...'GIF89a'].map((c) => c.charCodeAt(0)),
  'image/webp': [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8 '].map((c) => c.charCodeAt(0))),
  'image/avif': [0, 0, 0, 0x20].concat([...'ftypavif'].map((c) => c.charCodeAt(0))),
};
function file(bytesOf: string, mime: string, name = 'x', size?: number): File {
  const body = HEAD[bytesOf] ?? [...bytesOf].map((c) => c.charCodeAt(0));
  const f = new File([new Uint8Array([...body, ...new Array(32).fill(0)])], name, { type: mime });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  return f;
}

let store: MemoryWallpaperStore;
let urlN = 0;
let urlOf: Map<string, Blob>;
let size = { w: 1600, h: 900 };
let box: ColourBox = DUSK;
let reduce: { matches: boolean; listeners: ((e: { matches: boolean }) => void)[] };

beforeAll(() => {
  const st = document.createElement('style');
  st.textContent = THEMES_CSS;
  document.head.appendChild(st);
});
beforeEach(() => {
  localStorage.clear();
  setTheme('graphite');
  store = new MemoryWallpaperStore();
  setWallpaperStore(store);
  urlN = 0;
  urlOf = new Map();
  size = { w: 1600, h: 900 };
  box = DUSK;
  reduce = { matches: false, listeners: [] };
  vi.spyOn(wallEnv, 'imageSize').mockImplementation(async () => size);
  vi.spyOn(wallEnv, 'createBitmap').mockImplementation(async () => ({ width: size.w, height: size.h, close() {} }) as unknown as ImageBitmap);
  vi.spyOn(wallEnv, 'scan').mockImplementation(async () => box);
  vi.spyOn(wallEnv, 'decode').mockResolvedValue(undefined);
  vi.spyOn(wallEnv, 'firstFrame').mockImplementation(async () => new Blob(['frame'], { type: 'image/png' }));
  vi.spyOn(wallEnv, 'createUrl').mockImplementation((b: Blob) => { const u = `blob:u${++urlN}`; urlOf.set(u, b); return u; });
  vi.spyOn(wallEnv, 'revokeUrl').mockImplementation(() => undefined);
  vi.spyOn(wallEnv, 'reduceQuery').mockImplementation(() => ({
    get matches() { return reduce.matches; },
    addEventListener: (_: string, fn: (e: { matches: boolean }) => void) => reduce.listeners.push(fn),
    removeEventListener: () => undefined,
  }) as unknown as MediaQueryList);
  wallState.prefs = { ...WALL_DEFAULTS };
});
afterEach(() => {
  resetWallpaperRuntime();
  vi.restoreAllMocks();
  localStorage.clear();
  setTheme('graphite');
});

async function boot() { await bootWallpaper(); }

describe('J test 8: the file check', () => {
  it('the five types are taken, by their first bytes; the type stored is the one the bytes say', async () => {
    await boot();
    for (const mime of Object.keys(HEAD)) {
      expect(await chooseFile(file(mime, mime, `a.${mime.slice(6)}`)), mime).toBeNull();
      expect(store.rec!.type).toBe(mime);
    }
    expect(sniffType(new Uint8Array(HEAD['image/avif']))).toBe('image/avif');
    expect(sniffType(new Uint8Array([0, 0, 0, 0x20, ...[...'ftypavis'].map((c) => c.charCodeAt(0))]))).toBe('image/avif');
  });

  it('a .png whose bytes are a JPEG is taken (by the bytes); a .png whose bytes are text is errType', async () => {
    await boot();
    expect(await chooseFile(file('image/jpeg', 'image/png', 'photo.png'))).toBeNull();
    expect(store.rec!.type).toBe('image/jpeg');
    expect(await chooseFile(file('hello, this is text', 'image/png', 'notes.png'))).toBe('errType');
    expect(await chooseFile(file('image/png', 'text/plain', 'a.png'))).toBe('errType');
  });

  it('20 MB + 1 byte is errSize; exactly 20 MB is taken', async () => {
    await boot();
    expect(await chooseFile(file('image/png', 'image/png', 'big.png', MAX_BYTES + 1))).toBe('errSize');
    expect(await chooseFile(file('image/png', 'image/png', 'ok.png', MAX_BYTES))).toBeNull();
  });

  it('PNG 8001 × 5000 (40 005 000 pixels) is errPixels and never decoded; 8000 × 5000 is taken', async () => {
    await boot();
    size = { w: 8001, h: 5000 };
    expect(await chooseFile(file('image/png', 'image/png'))).toBe('errPixels');
    expect(wallEnv.createBitmap).toHaveBeenCalledTimes(0);
    size = { w: 8000, h: 5000 };
    expect(await chooseFile(file('image/png', 'image/png'))).toBeNull();
    expect(wallEnv.createBitmap).toHaveBeenCalledTimes(1);
  });

  it('createImageBitmap throws: errDecode, the wallpaper shown stays', async () => {
    await boot();
    expect(await chooseFile(file('image/png', 'image/png', 'first.png'))).toBeNull();
    const shown = wallState.url;
    vi.mocked(wallEnv.createBitmap).mockRejectedValueOnce(new Error('bad'));
    expect(await chooseFile(file('image/png', 'image/png', 'second.png'))).toBe('errDecode');
    expect(wallState.url).toBe(shown);
    expect(wallState.meta!.name).toBe('first.png');
    expect(store.rec!.name).toBe('first.png');
    // an <img> that cannot load, or 0 × 0, is errDecode too
    vi.mocked(wallEnv.imageSize).mockRejectedValueOnce(new Error('load'));
    expect(await chooseFile(file('image/png', 'image/png'))).toBe('errDecode');
    size = { w: 0, h: 0 };
    expect(await chooseFile(file('image/png', 'image/png'))).toBe('errDecode');
  });

  it('the store refuses: errStore, the wallpaper shown stays', async () => {
    await boot();
    expect(await chooseFile(file('image/png', 'image/png', 'first.png'))).toBeNull();
    const shown = wallState.url;
    vi.spyOn(store, 'put').mockRejectedValueOnce(new Error('QuotaExceededError'));
    expect(await chooseFile(file('image/png', 'image/png', 'second.png'))).toBe('errStore');
    expect(wallState.url).toBe(shown);
    expect(wallState.meta!.name).toBe('first.png');
  });

  it('review J-TEST-4: stored but cannot be shown → errDecode; the store gets the previous record back, the image and data-wall stay', async () => {
    await boot();
    expect(await chooseFile(file('image/png', 'image/png', 'first.png'))).toBeNull();
    const before = store.rec;
    const shown = wallState.url;
    const put = vi.spyOn(store, 'put');
    vi.mocked(wallEnv.decode).mockRejectedValueOnce(new Error('EncodingError'));
    expect(await chooseFile(file('image/png', 'image/png', 'second.png'))).toBe('errDecode');
    expect(put).toHaveBeenCalledTimes(2); // the new one, then the previous one back
    expect(store.rec).toBe(before);
    expect(store.rec!.name).toBe('first.png');
    expect(wallState.url).toBe(shown);
    expect(wallState.meta!.name).toBe('first.png');
    expect(document.documentElement.hasAttribute('data-wall')).toBe(true);
  });

  it('review J-TEST-4: the same with no previous image → errDecode, the store is empty again, nothing shown, no data-wall', async () => {
    await boot();
    const remove = vi.spyOn(store, 'remove');
    vi.mocked(wallEnv.decode).mockRejectedValueOnce(new Error('EncodingError'));
    expect(await chooseFile(file('image/png', 'image/png', 'only.png'))).toBe('errDecode');
    expect(remove).toHaveBeenCalledTimes(1);
    expect(store.rec).toBeNull();
    expect(wallState.url).toBeNull();
    expect(wallState.meta).toBeNull();
    expect(document.documentElement.hasAttribute('data-wall')).toBe(false);
  });

  it('data-wall and --panel-pct are set on <html> only once the image is decoded', async () => {
    await boot();
    let done!: () => void;
    vi.mocked(wallEnv.decode).mockImplementationOnce(() => new Promise<void>((r) => { done = r; }));
    const p = chooseFile(file('image/png', 'image/png'));
    await vi.waitFor(() => expect(done).toBeTypeOf('function'));
    expect(document.documentElement.hasAttribute('data-wall')).toBe(false);
    expect(wallState.url).toBeNull();
    done();
    expect(await p).toBeNull();
    expect(document.documentElement.hasAttribute('data-wall')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--panel-pct')).toBe('90%');
    await removeWallpaper();
    expect(document.documentElement.hasAttribute('data-wall')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--panel-pct')).toBe('');
  });

  it('a stored image shows at start-up (boot reads the store)', async () => {
    const rec: WallRecord = { v: 1, blob: new Blob(['x'], { type: 'image/png' }), name: 'kept.png', type: 'image/png', size: 1, w: 10, h: 10, box: DUSK, savedAt: 1 };
    store.rec = rec;
    await boot();
    expect(wallState.meta!.name).toBe('kept.png');
    expect(urlOf.get(wallState.url!)).toBe(rec.blob);
  });
});

describe('J test 9: reduced motion', () => {
  it('reduce: a GIF shows its first frame (another URL) and says so; a PNG shows as it is; no-preference while open: the GIF moves', async () => {
    reduce.matches = true;
    await boot();
    const gif = file('image/gif', 'image/gif', 'neon-loop.gif');
    expect(await chooseFile(gif)).toBeNull();
    expect(wallState.meta!.animated).toBe(true);
    expect(wallState.reducedMotion).toBe(true);
    expect(urlOf.get(wallState.url!)).not.toBe(store.rec!.blob);
    expect(wallEnv.firstFrame).toHaveBeenCalledTimes(1);

    const png = file('image/png', 'image/png', 'still.png');
    expect(await chooseFile(png)).toBeNull();
    expect(wallState.meta!.animated).toBe(false);
    expect(urlOf.get(wallState.url!)).toBe(store.rec!.blob);

    expect(await chooseFile(file('image/gif', 'image/gif', 'neon-loop.gif'))).toBeNull();
    const still = wallState.url;
    reduce.matches = false;
    for (const fn of reduce.listeners) fn({ matches: false });
    await vi.waitFor(() => expect(wallState.url).not.toBe(still));
    expect(wallState.reducedMotion).toBe(false);
    expect(urlOf.get(wallState.url!)).toBe(store.rec!.blob);
  });
});

describe('J test 10: the floor and the user value', () => {
  it('user 0.3, floor 0.48 (dusk on Graphite): applies 0.48, the key keeps 0.3; on Nord (floor 0.06): applies 0.3', async () => {
    await boot();
    setWallPrefs({ veil: 0.3 }, true);
    expect(await chooseFile(file('image/png', 'image/png'))).toBeNull();
    expect(wallState.floor.veil).toBe(0.48);
    expect(veilApplied.value).toBe(0.48);
    expect(JSON.parse(localStorage.getItem(WALLPAPER_KEY)!).veil).toBe(0.3);
    setTheme('nord');
    await nextTick();
    expect(wallState.floor.veil).toBe(0.06);
    expect(veilApplied.value).toBe(0.3);
    // and Light (97 %) with the Graphite hint (48 %, at least 20 points lower)
    setTheme('light');
    await nextTick();
    expect(veilApplied.value).toBe(0.97);
    expect(wallState.hint).toMatchObject({ kind: 'dark', veil: 48 });
  });

  it('a panel of 0.5 in the key (edited by hand) applies 0.75; the import rule refuses it', () => {
    localStorage.setItem(WALLPAPER_KEY, JSON.stringify({ fit: 'cover', veil: 0.3, blur: 0, panel: 0.5 }));
    wallState.prefs = readWallPrefs();
    expect(wallState.prefs.panel).toBe(0.75);
    expect(panelApplied.value).toBe(0.75);
    // and whatever puts a lower value in the state, the applied panel never goes under 0.75
    wallState.prefs = { ...wallState.prefs, panel: 0.5 };
    wallState.floor = { veil: 0, panel: 0 };
    expect(panelApplied.value).toBe(0.75);
    expect(wallpaperPrefsValid(localStorage.getItem(WALLPAPER_KEY)!)).toBe(false);
    expect(parseWallPrefs('{"fit":"stretch","veil":2,"blur":7.5,"panel":0.9}')).toEqual({ fit: 'cover', veil: 1, blur: 8, panel: 0.9 });
    expect(parseWallPrefs('nope')).toEqual(WALL_DEFAULTS);
  });

  it('no hint when the other side is less than 20 points lower ("paper" on Graphite 86 %, Light 71 %)', async () => {
    box = { lo: [203, 214, 196], hi: [252, 242, 241] };
    await boot();
    expect(await chooseFile(file('image/png', 'image/png'))).toBeNull();
    expect(wallState.floor.veil).toBe(0.86);
    expect(wallState.hint).toBeNull();
    // a light grey box [215..255]: Graphite 87 %, Light 66 % -> the "bright" hint
    box = { lo: [215, 215, 215], hi: [255, 255, 255] };
    expect(await chooseFile(file('image/png', 'image/png'))).toBeNull();
    expect(wallState.hint).toMatchObject({ kind: 'bright', veil: 66 });
  });
});

describe('J test 11: blob URLs', () => {
  it('change the image twice, then remove it: revokeObjectURL 3 times, each with the URL it replaced', async () => {
    await boot();
    expect(await chooseFile(file('image/png', 'image/png', 'a.png'))).toBeNull();
    const a = wallState.url;
    expect(await chooseFile(file('image/png', 'image/png', 'b.png'))).toBeNull();
    const b = wallState.url;
    expect(await chooseFile(file('image/png', 'image/png', 'c.png'))).toBeNull();
    const c = wallState.url;
    await removeWallpaper();
    expect(vi.mocked(wallEnv.revokeUrl).mock.calls.map((x) => x[0])).toEqual([a, b, c]);
    expect(wallState.url).toBeNull();
    expect(store.rec).toBeNull();
    // the way it showed stays for the next image
    expect(wallState.prefs).toEqual(WALL_DEFAULTS);
  });
});

describe('J test 13: --panel', () => {
  it('themes.css: --panel is --bg-2 without an image, --bg-2 at --panel-pct with one; Card and the page panels use it', () => {
    expect(THEMES_CSS).toMatch(/:root,\s*\[data-theme\]\s*\{[^}]*--panel: var\(--bg-2\);/);
    expect(THEMES_CSS).toMatch(/:root\[data-wall\]\s*\{\s*--panel: color-mix\(in srgb, var\(--bg-2\) var\(--panel-pct, 90%\), transparent\);\s*\}/);
    const card = readFileSync(resolve('src/components/ui/Card.vue'), 'utf8');
    expect(card).toMatch(/\.card \{[^}]*background: var\(--panel\);/);
    // no image: every theme's --panel is its own --bg-2, the colour cards had before J; with one: --bg-2 at --panel-pct
    const root = document.documentElement;
    for (const id of ['graphite', 'light', 'indigo', 'indigo-light', 'gold', 'ember', 'aurora', 'mint', 'nord', 'dracula', 'rose']) {
      setTheme(id as never);
      const cs = getComputedStyle(root);
      const bg2 = cs.getPropertyValue('--bg-2').trim();
      expect(bg2, id).toMatch(/^#[0-9a-f]{6}$/);
      expect(cs.getPropertyValue('--panel').trim(), id).toBe(bg2);
      root.setAttribute('data-wall', '');
      expect(getComputedStyle(root).getPropertyValue('--panel').trim(), id).toBe(`color-mix(in srgb, ${bg2} 90%, transparent)`);
      root.style.setProperty('--panel-pct', '80%');
      expect(getComputedStyle(root).getPropertyValue('--panel').trim(), id).toBe(`color-mix(in srgb, ${bg2} 80%, transparent)`);
      root.style.removeProperty('--panel-pct');
      root.removeAttribute('data-wall');
    }
  });
});

describe('Slider floor (DESIGN J §3.4)', () => {
  function slider(props: Record<string, unknown>) {
    return mount(Slider, { props: { modelValue: 50, min: 0, max: 100, step: 1, label: 'veil', ...props }, attachTo: document.body });
  }
  it('every decreasing key stops at the floor; aria-valuemin is the floor', async () => {
    const w = slider({ modelValue: 50, floor: 48 });
    const th = w.get('[role="slider"]');
    expect(th.attributes('aria-valuemin')).toBe('48');
    for (const key of ['ArrowLeft', 'ArrowDown', 'PageDown', 'Home']) {
      await w.setProps({ modelValue: 49 });
      await th.trigger('keydown', { key });
      const ev = w.emitted('update:modelValue')!;
      expect(ev[ev.length - 1][0], key).toBe(48);
      const cm = w.emitted('commit')!;
      expect(cm[cm.length - 1][0], key).toBe(48);
    }
    w.unmount();
  });
  it('a click or drag on the track below the floor gives the floor', async () => {
    const w = slider({ modelValue: 60, floor: 48 });
    const el = w.element as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20, x: 0, y: 0, toJSON() {} });
    el.setPointerCapture = () => undefined;
    const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    const ptr = (type: string, x: number) => el.dispatchEvent(new Ctor(type, { clientX: x, clientY: 10, button: 0, bubbles: true }));
    ptr('pointerdown', 10); // 5 %
    ptr('pointermove', 0); // 0 %
    ptr('pointerup', 20); // 10 %
    await nextTick();
    // the prop is not fed back here, so each step emits; every value is the floor (5 %, 0 %, 10 % of the track)
    expect(w.emitted('update:modelValue')!.map((e) => e[0])).toEqual([48, 48, 48]);
    expect(w.emitted('commit')![0][0]).toBe(48);
    w.unmount();
  });
  it('without a floor: aria-valuemin is min and Home goes to min (as before)', async () => {
    const w = slider({ modelValue: 50 });
    const th = w.get('[role="slider"]');
    expect(th.attributes('aria-valuemin')).toBe('0');
    await th.trigger('keydown', { key: 'Home' });
    expect(w.emitted('update:modelValue')![0][0]).toBe(0);
    w.unmount();
  });
});
