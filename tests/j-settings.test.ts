// DESIGN J §3.8, §11 tests 6 and 12: the accent and wallpaper keys in the app-settings table (export / import / reset), the
// wallpaper image removed by a reset before the reload, and 0 HID for everything on the Settings page that J adds.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { routes } from '../src/router';
import SettingsPage from '../src/pages/SettingsPage.vue';
import { MockTransport } from '../src/protocol';
import { APP_SETTINGS, DERIVED_KEYS, buildExport, pageReload, parseImport, storedSettings, useAppSettings } from '../src/data/appSettings';
import { APPCFG_DONE_KEY } from '../src/data/appcfgDone';
import { ACCENT_KEY, ACCENT_VARS_KEY } from '../src/accentCache';
import { setAccent } from '../src/accent';
import { WALLPAPER_KEY, WALL_DEFAULTS } from '../src/data/wallpaperPrefs';
import { MemoryWallpaperStore, setWallpaperStore, type ColourBox } from '../src/data/wallpaperStore';
import { resetWallpaperRuntime, wallEnv } from '../src/data/wallpaperRuntime';
import { wallState } from '../src/data/wallpaperState';
import { useDeviceStore } from '../src/stores/device';
import { useSettingsStore } from '../src/stores/settings';
import { setTheme } from '../src/theme';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

const rule = (key: string) => APP_SETTINGS.find((s) => s.key === key)!.valid;
const PREFS = JSON.stringify({ fit: 'cover', veil: 0.3, blur: 0, panel: 0.9 });
const DUSK: ColourBox = { lo: [4, 8, 23], hi: [89, 77, 129] };
let store: MemoryWallpaperStore;

beforeAll(() => {
  const st = document.createElement('style');
  st.textContent = readFileSync(resolve('src/styles/themes.css'), 'utf8');
  document.head.appendChild(st);
});
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
  setLocale('vi');
  setAccent(null);
  setTheme('graphite');
  localStorage.clear();
  store = new MemoryWallpaperStore();
  setWallpaperStore(store);
  wallState.prefs = { ...WALL_DEFAULTS };
});
afterEach(() => {
  resetWallpaperRuntime();
  vi.useRealTimers();
  vi.restoreAllMocks();
  setAccent(null);
  localStorage.clear();
  sessionStorage.clear();
});

describe('J test 6: the keys in the H table', () => {
  it('accent: #3a2bd1 yes; #3A2BD1X, red, #3A2BD1 (the app writes lower case), #fff no', () => {
    expect(rule(ACCENT_KEY)('#3a2bd1')).toBe(true);
    for (const v of ['#3A2BD1X', 'red', '#3A2BD1', '#fff', '', ' #3a2bd1']) expect(rule(ACCENT_KEY)(v), v).toBe(false);
  });

  it('wallpaper: the 4 keys as the app writes them yes; a missing key, panel 0.5, blur 7.5, fit stretch, an extra key no', () => {
    const ok = { fit: 'cover', veil: 0.3, blur: 0, panel: 0.9 };
    expect(rule(WALLPAPER_KEY)(JSON.stringify(ok))).toBe(true);
    expect(rule(WALLPAPER_KEY)(JSON.stringify({ fit: 'tile', veil: 1, blur: 20, panel: 0.75 }))).toBe(true);
    const bad = [
      { fit: 'cover', veil: 0.3, blur: 0 },
      { ...ok, panel: 0.5 },
      { ...ok, blur: 7.5 },
      { ...ok, fit: 'stretch' },
      { ...ok, extra: 1 },
      { ...ok, veil: 1.2 },
    ];
    for (const b of bad) expect(rule(WALLPAPER_KEY)(JSON.stringify(b)), JSON.stringify(b)).toBe(false);
    expect(rule(WALLPAPER_KEY)('{nope')).toBe(false);
    expect(rule(WALLPAPER_KEY)('[]')).toBe(false);
  });

  it('accentVars is derived: not exported, and a file carrying it is refused as an unknown key', () => {
    expect(DERIVED_KEYS).toContain(ACCENT_VARS_KEY);
    setAccent('#3a2bd1');
    localStorage.setItem(WALLPAPER_KEY, PREFS);
    expect(localStorage.getItem(ACCENT_VARS_KEY)).not.toBeNull();
    const { json } = buildExport();
    const data = JSON.parse(json).data;
    expect(data).toEqual({ [ACCENT_KEY]: '#3a2bd1', [WALLPAPER_KEY]: PREFS });
    expect(Object.keys(storedSettings())).not.toContain(ACCENT_VARS_KEY);
    const withVars = JSON.stringify({ ...JSON.parse(json), data: { ...data, [ACCENT_VARS_KEY]: localStorage.getItem(ACCENT_VARS_KEY) } });
    const r = parseImport(withVars, withVars.length);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toBe('errKeys');
  });

  it('import removes the old cache (the next start rebuilds it for the imported colour); the image is not touched', async () => {
    setAccent('#4da3ff');
    const remove = vi.spyOn(store, 'remove');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('import', { [ACCENT_KEY]: '#3a2bd1' });
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#3a2bd1');
    expect(localStorage.getItem(ACCENT_VARS_KEY)).toBeNull();
    expect(remove).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('import fails at a write: the cache comes back too', async () => {
    setAccent('#4da3ff');
    const cache = localStorage.getItem(ACCENT_VARS_KEY);
    vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    const real = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === 'ae64.locale') throw new Error('quota');
      return real.call(this, k, v);
    });
    await expect(useAppSettings().applyAndReload('import', { [ACCENT_KEY]: '#3a2bd1', 'ae64.locale': 'en' })).rejects.toThrow();
    vi.mocked(Storage.prototype.setItem).mockRestore();
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#4da3ff');
    expect(localStorage.getItem(ACCENT_VARS_KEY)).toBe(cache);
  });

  it('reset: the image is removed (awaited) before the keys go and the page reloads', async () => {
    setAccent('#3a2bd1');
    localStorage.setItem(WALLPAPER_KEY, PREFS);
    store.rec = { v: 1, blob: new Blob(['x']), name: 'a.png', type: 'image/png', size: 1, w: 1, h: 1, box: DUSK, savedAt: 0 };
    const order: string[] = [];
    const real = store.remove.bind(store);
    vi.spyOn(store, 'remove').mockImplementation(async () => { await new Promise((r) => setTimeout(r, 5)); await real(); order.push('remove'); });
    vi.spyOn(pageReload, 'reload').mockImplementation(() => { order.push(`reload ${localStorage.getItem(ACCENT_KEY)}`); });
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('reset');
    expect(order).toEqual(['remove', 'reload null']);
    expect(store.rec).toBeNull();
    for (const k of [ACCENT_KEY, ACCENT_VARS_KEY, WALLPAPER_KEY]) expect(localStorage.getItem(k), k).toBeNull();
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('reset');
  });

  it('reset: a delete that never ends → 0 reloads and localStorage as it was', async () => {
    setAccent('#3a2bd1');
    localStorage.setItem(WALLPAPER_KEY, PREFS);
    vi.spyOn(store, 'remove').mockImplementation(() => new Promise<void>(() => undefined));
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    const snap = { ...localStorage };
    void useAppSettings().applyAndReload('reset');
    await new Promise((r) => setTimeout(r, 30));
    await flushPromises();
    expect(reload).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(snap);
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
  });

  it('reset: the delete fails → errWallpaper, nothing removed, no flag, 0 reloads', async () => {
    setAccent('#3a2bd1');
    vi.spyOn(store, 'remove').mockRejectedValue(new Error('blocked'));
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    const snap = { ...localStorage };
    await expect(useAppSettings().applyAndReload('reset')).rejects.toThrow(t('appcfg.errWallpaper'));
    expect(reload).not.toHaveBeenCalled();
    expect({ ...localStorage }).toEqual(snap);
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
  });
});

describe('J test 12: 0 HID for the accent and the wallpaper on the Settings page', () => {
  async function page(model: 'max' | 'pro') {
    vi.spyOn(wallEnv, 'imageSize').mockResolvedValue({ w: 1600, h: 900 });
    vi.spyOn(wallEnv, 'createBitmap').mockImplementation(async () => ({ width: 1600, height: 900, close() {} }) as unknown as ImageBitmap);
    vi.spyOn(wallEnv, 'scan').mockResolvedValue(DUSK);
    vi.spyOn(wallEnv, 'decode').mockResolvedValue(undefined);
    let n = 0;
    vi.spyOn(wallEnv, 'createUrl').mockImplementation(() => `blob:t${++n}`);
    vi.spyOn(wallEnv, 'revokeUrl').mockImplementation(() => undefined);
    vi.spyOn(wallEnv, 'reduceQuery').mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const device = useDeviceStore();
    await device.connectDemo(model);
    const mock = device.transport as MockTransport;
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/settings');
    const w: VueWrapper = mount(SettingsPage, { global: { plugins: [router] }, attachTo: document.body });
    await vi.waitFor(() => expect(useSettingsStore().loaded).toBe(true));
    await flushPromises();
    const out: string[] = [];
    mock.onPacket((e) => { if (e.dir === 'out' && !(e.bytes[0] === 4 && e.bytes[1] === 3)) out.push([...e.bytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')); });
    return { w, out };
  }
  const png = () => new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0)])], 'dusk.png', { type: 'image/png' });
  async function choose(w: VueWrapper) {
    const input = w.get<HTMLInputElement>('.wp-card input[type="file"]');
    Object.defineProperty(input.element, 'files', { value: [png()], configurable: true });
    await input.trigger('change');
    await vi.waitFor(() => expect(wallState.url).not.toBeNull());
    await flushPromises();
  }

  for (const model of ['max', 'pro'] as const) {
    it(`${model}: accent swatch, Custom… open / commit / close, image choose / change / fit / three sliders / remove`, async () => {
      const { w, out } = await page(model);
      const radios = () => w.findAll('.acc [role="radio"]');
      expect(radios()).toHaveLength(7);
      await radios()[2].trigger('click');
      await radios()[0].trigger('click');
      await radios()[6].trigger('click');
      await nextTick();
      const hex = document.body.querySelector<HTMLInputElement>('.pop .cp__field--hex input')!;
      hex.value = '#3a2bd1';
      hex.dispatchEvent(new Event('input'));
      hex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      document.body.querySelector('.pop')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await nextTick();
      expect(localStorage.getItem(ACCENT_KEY)).toBe('#3a2bd1');

      await choose(w);
      expect(w.find('.wp').exists()).toBe(true);
      await choose(w); // Change
      await w.findAll('.wp [role="radio"]')[1].trigger('click'); // fit: contain
      expect(wallState.prefs.fit).toBe('contain');
      for (const s of w.findAll('.wp [role="slider"]')) {
        await s.trigger('keydown', { key: 'ArrowRight' });
        await s.trigger('keydown', { key: 'End' });
      }
      expect(JSON.parse(localStorage.getItem(WALLPAPER_KEY)!)).toMatchObject({ fit: 'contain', veil: 1, blur: 20, panel: 1 });
      const removeBtn = w.findAll('.wp__btns button').find((b) => b.text() === t('wall.remove'))!;
      await removeBtn.trigger('click');
      await flushPromises();
      expect(store.rec).toBeNull();
      expect(wallState.url).toBeNull();
      await radios()[0].trigger('click');
      await flushPromises();
      expect(out).toEqual([]);
      w.unmount();
    });
  }
});
