// DESIGN H §3.5, §3.6, §11 items 1–7, 12, 14: the app-settings key table, its rules, export / import / reset and the
// order before the page reloads. 0 HID: nothing here talks to the keyboard except the writes the tests start on purpose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  APP_SETTINGS, DERIVED_KEYS, NOT_EXPORTED, SESSION_KEYS, buildExport, exportFileName, groupsOf, isFlag01, pageReload, parseImport,
  resetKeys, storedSettings, useAppSettings,
} from '../src/data/appSettings';
import { APPCFG_DONE_KEY, takeAppcfgDone } from '../src/data/appcfgDone';
import { isThemeChoice, parseThemeChoice } from '../src/theme';
import { isLocale } from '../src/i18n/locale';
import { USER_PRESET_MAX, presetsValid, useUserPresetsStore } from '../src/stores/userPresets';
import { loadRecent, recentValid } from '../src/components/ui/recentColors';
import { asPerfTab, storedTab } from '../src/router';
import { isDemoSeed } from '../src/protocol/mock';
import { useDeviceStore } from '../src/stores/device';
import { useCalibrationStore } from '../src/stores/calibration';
import { useSettingsStore } from '../src/stores/settings';
import { useGamepadStore } from '../src/stores/gamepad';
import { useSyncStore } from '../src/stores/sync';
import { vi as viDict } from '../src/i18n/vi';
import { en } from '../src/i18n/en';
import { t } from '../src/i18n/vi';

const SRC = import.meta.glob('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const TABLE = APP_SETTINGS.map((s) => s.key);
const rule = (key: string) => APP_SETTINGS.find((s) => s.key === key)!.valid;

/** One preset as the app writes it. */
const preset = (id: string, name = 'FPS', o: Record<string, unknown> = {}) => ({
  id, name, mode: 1, continuous: false, actuation: 1.2, rtPress: 0.15, rtRelease: 0.15, deadTop: 0.1, deadBottom: 0.1, ...o,
});

/** Every key of the table with a value its reader takes as itself. */
const ALL: Record<string, string> = {
  'ae64.theme': 'ember',
  'ae64.locale': 'en',
  'ae64.perf.userPresets': JSON.stringify([preset('a1'), preset('b2', 'Gõ văn bản', { mode: 0 })]),
  'ae64.perfTab': 'calibration',
  'ae64.perf.depthShading': '1',
  'ae64.live.keyLock': '0',
  'ae64.live.colorByResult': '1',
  'ae64.calibration.showAdc': '1',
  'ae64.recentColors': JSON.stringify(['#73f0c0', '#FF0000']),
  'ae64.sidebarCollapsed': '1',
  'ae64.demoModel': 'pro-xinput',
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

describe('item 1: the key table is complete', () => {
  const literals = (src: string) => [...src.matchAll(/'(ae64\.[^']+)'/g)].map((m) => m[1]);

  it('every ae64.* string in src is in APP_SETTINGS, NOT_EXPORTED, DERIVED_KEYS or SESSION_KEYS (localStorage and sessionStorage)', () => {
    const registered = new Set<string>([...TABLE, ...NOT_EXPORTED, ...DERIVED_KEYS, ...SESSION_KEYS]);
    const found = new Set<string>();
    for (const [file, src] of Object.entries(SRC)) {
      for (const k of literals(src)) {
        found.add(k);
        expect(registered.has(k), `${k} in ${file}`).toBe(true);
      }
      // a file that uses sessionStorage keeps only session keys there (a new session key cannot slip by as a local one)
      if (src.includes('sessionStorage') && !file.endsWith('data/appSettings.ts')) {
        for (const k of literals(src)) expect((SESSION_KEYS as readonly string[]).includes(k), `${k} in ${file}`).toBe(true);
      }
    }
    // 13 in the table (J: ae64.accent, ae64.wallpaper) + ae64.lastDevice + ae64.accentVars + ae64.appcfg.done; ae64.switchTab
    // is gone (E)
    expect(found.size).toBe(16);
    expect(TABLE).toHaveLength(13);
    expect([...DERIVED_KEYS]).toEqual(['ae64.accentVars']);
    expect(TABLE).not.toContain('ae64.switchTab');
  });

  it('every registered key is used somewhere outside the table (no stale entry)', () => {
    const outside = Object.entries(SRC).filter(([f]) => !f.endsWith('data/appSettings.ts')).map(([, s]) => s).join('\n');
    for (const k of [...TABLE, ...NOT_EXPORTED, ...DERIVED_KEYS, ...SESSION_KEYS]) expect(outside.includes(`'${k}'`), k).toBe(true);
  });

  it('the groups keep the design order and all ten have a key (J: accent and wallpaper next to theme)', () => {
    expect(groupsOf(TABLE)).toEqual(['theme', 'accent', 'wallpaper', 'locale', 'presets', 'tabs', 'toggles', 'colors', 'sidebar', 'demo']);
  });
});

describe('item 2: the rule of each key is the one its reader uses', () => {
  it('theme: graphite, auto, seele yes; neon, constructor, toString, __proto__ no, and the reader reads those four as auto', () => {
    for (const v of ['graphite', 'auto', 'seele', 'seele-light', 'indigo-light']) expect(rule('ae64.theme')(v), v).toBe(true);
    for (const v of ['neon', 'constructor', 'toString', '__proto__', 'hasOwnProperty', '']) {
      expect(rule('ae64.theme')(v), v).toBe(false);
      expect(isThemeChoice(v)).toBe(false);
      expect(parseThemeChoice(v)).toBe('auto');
    }
    expect(parseThemeChoice('graphite')).toBe('graphite');
    expect(parseThemeChoice('auto')).toBe('auto');
    expect(parseThemeChoice('seele')).toBe('indigo'); // an old name reads as the theme it stands for
  });

  it('locale: vi / en, and the reader starts in the stored one', async () => {
    expect(['vi', 'en'].map(isLocale)).toEqual([true, true]);
    expect(['VI', 'fr', ''].map(rule('ae64.locale'))).toEqual([false, false, false]);
    localStorage.setItem('ae64.locale', 'en');
    vi.resetModules();
    const mod = await import('../src/i18n/locale');
    expect(mod.locale.value).toBe('en');
    mod.setLocale('vi');
  });

  it('presets: 2 good presets yes and the store reads them unchanged; actuation 9 yes (read as 9); 12, 7 presets, a repeated id, " FPS" no', () => {
    const v = rule('ae64.perf.userPresets');
    const two = [preset('a1'), preset('b2', 'Typing', { mode: 0 })];
    expect(v(JSON.stringify(two))).toBe(true);
    localStorage.setItem('ae64.perf.userPresets', JSON.stringify(two));
    setActivePinia(createPinia());
    expect(useUserPresetsStore().presets).toEqual(two);

    const nine = [preset('a1', 'Deep', { actuation: 9 })];
    expect(v(JSON.stringify(nine))).toBe(true);
    localStorage.setItem('ae64.perf.userPresets', JSON.stringify(nine));
    setActivePinia(createPinia());
    expect(useUserPresetsStore().presets[0].actuation).toBe(9);

    expect(v(JSON.stringify([preset('a1', 'Deep', { actuation: 12 })]))).toBe(false); // over the 10 mm ceiling: the reader would clamp
    expect(v(JSON.stringify(Array.from({ length: USER_PRESET_MAX + 1 }, (_, i) => preset(`p${i}`))))).toBe(false);
    // H-TEST-1: exactly the most the store keeps (6) passes
    expect(USER_PRESET_MAX).toBe(6);
    expect(presetsValid(JSON.stringify(Array.from({ length: USER_PRESET_MAX }, (_, i) => preset(`p${i}`))))).toBe(true);
    expect(v(JSON.stringify([preset('a1'), preset('a1', 'Other')]))).toBe(false);
    expect(v(JSON.stringify([preset('a1', ' FPS')]))).toBe(false); // the reader would trim it
    expect(v(JSON.stringify([{ ...preset('a1'), extra: 1 }]))).toBe(false);
    expect(v(JSON.stringify([preset('a1', 'FPS', { actuation: 1.2345 })]))).toBe(false); // the reader would round it
    expect(v(JSON.stringify({ a: 1 }))).toBe(false);
    expect(v('[')).toBe(false);
    expect(v('[]')).toBe(true);
  });

  it('presets the app saved itself (add, then persist) pass the rule', () => {
    const store = useUserPresetsStore();
    store.add('Mine', { mode: 1, continuous: true, actuation: 0.1234, rtPress: 0.0567, rtRelease: 3.9, deadTop: 0, deadBottom: 0.2 });
    store.add('Gõ', { mode: 0, continuous: false, actuation: 2, rtPress: 0.1, rtRelease: 0.1, deadTop: 0.1, deadBottom: 0.1 });
    const raw = localStorage.getItem('ae64.perf.userPresets')!;
    expect(presetsValid(raw)).toBe(true);
    const r = parseImport(buildExport().json, 100);
    expect(r.ok).toBe(true);
  });

  it('recent colours: ["#73f0c0"] yes and the picker reads it; a bare string, 13 colours, "red" no', () => {
    const v = rule('ae64.recentColors');
    expect(v('["#73f0c0"]')).toBe(true);
    expect(v('["#73F0C0"]')).toBe(true); // finish() writes the parent's colour as given
    localStorage.setItem('ae64.recentColors', '["#73f0c0","#FF0000"]');
    expect(loadRecent()).toEqual(['#73f0c0', '#FF0000']);
    expect(v('"#73f0c0"')).toBe(false);
    expect(v(JSON.stringify(Array.from({ length: 13 }, () => '#000000')))).toBe(false);
    // H-TEST-2: exactly the most the picker keeps (12) passes
    expect(recentValid(JSON.stringify(Array.from({ length: 12 }, (_, i) => `#0000${String(i).padStart(2, '0')}`)))).toBe(true);
    expect(v('["red"]')).toBe(false);
    expect(recentValid('[1]')).toBe(false);
  });

  it('switches: 0 / 1 yes, true / on / empty no (all five toggle keys and the sidebar use it)', () => {
    expect(['0', '1'].map(isFlag01)).toEqual([true, true]);
    expect(['true', 'on', '', '2'].map(isFlag01)).toEqual([false, false, false, false]);
    for (const k of ['ae64.perf.depthShading', 'ae64.live.keyLock', 'ae64.live.colorByResult', 'ae64.calibration.showAdc', 'ae64.sidebarCollapsed']) {
      expect(rule(k)('1') && rule(k)('0') && !rule(k)('true'), k).toBe(true);
    }
  });

  it('tab: a Performance tab yes and storedTab() reads it; "switchTab" values from E no', () => {
    const v = rule('ae64.perfTab');
    for (const tab of ['travel', 'advanced', 'switch', 'calibration', 'test']) expect(v(tab), tab).toBe(true);
    localStorage.setItem('ae64.perfTab', 'calibration');
    expect(storedTab()).toBe('calibration');
    expect(['Travel', 'live', ''].map(v)).toEqual([false, false, false]);
    expect(asPerfTab('live')).toBeNull();
  });

  it('demo model: pro-xinput yes and the demo starts with it; ultra no', async () => {
    expect(['max', 'pro', 'pro-xinput'].map(rule('ae64.demoModel'))).toEqual([true, true, true]);
    expect(isDemoSeed('ultra')).toBe(false);
    localStorage.setItem('ae64.demoModel', 'pro-xinput');
    const device = useDeviceStore();
    await device.connectDemo();
    expect(device.demoSeed).toBe('pro-xinput');
  });
});

describe('item 3: parseImport, in the order of §3.5', () => {
  const file = (data: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ app: 'ae64-control', version: '0.1.0', savedAt: '2026-11-13T04:35:00.000Z', data, ...extra });

  it('7 sample files give the right error and keys', () => {
    const good = file({ 'ae64.theme': 'graphite' });
    expect(parseImport(good, 2 * 1024 * 1024)).toEqual({ ok: false, error: 'errSize' });
    expect(parseImport('abc', 3)).toEqual({ ok: false, error: 'errJson' });
    expect(parseImport(JSON.stringify({ app: 'other', data: {} }), 30)).toEqual({ ok: false, error: 'errApp' });
    expect(parseImport(file({ 'ae64.theme': 'graphite', 'ae64.beta': '1' }), 100)).toEqual({ ok: false, error: 'errKeys', keys: 'ae64.beta' });
    expect(parseImport(file({ 'ae64.lastDevice': '{}' }), 100)).toEqual({ ok: false, error: 'errKeys', keys: 'ae64.lastDevice' });
    expect(parseImport(file({ 'ae64.theme': 'neon' }), 100)).toEqual({ ok: false, error: 'errValue', keys: 'ae64.theme' });
    expect(parseImport(file({}), 100)).toEqual({ ok: false, error: 'errEmpty' });
  });

  it('a file just under 1 MB is read; size wins over everything else', () => {
    expect(parseImport(file({ 'ae64.theme': 'graphite' }), 1_048_576).ok).toBe(true);
    expect(parseImport('abc', 1_048_577)).toEqual({ ok: false, error: 'errSize' });
  });

  it('the shape: an array, no data, data as an array or a string → errApp', () => {
    expect(parseImport('[]', 2).ok).toBe(false);
    expect(parseImport(JSON.stringify({ app: 'ae64-control' }), 20)).toEqual({ ok: false, error: 'errApp' });
    expect(parseImport(JSON.stringify({ app: 'ae64-control', data: [] }), 20)).toEqual({ ok: false, error: 'errApp' });
    expect(parseImport(JSON.stringify({ app: 'ae64-control', data: 'x' }), 20)).toEqual({ ok: false, error: 'errApp' });
  });

  it('prototype keys are unknown keys; unknown keys are checked before values; more than 3 keys end with …', () => {
    expect(parseImport('{"app":"ae64-control","data":{"__proto__":"x"}}', 50)).toEqual({ ok: false, error: 'errKeys', keys: '__proto__' });
    expect(parseImport(file({ constructor: 'x' }), 50)).toEqual({ ok: false, error: 'errKeys', keys: 'constructor' });
    expect(parseImport(file({ 'ae64.theme': 'neon', 'ae64.x': '1' }), 50)).toEqual({ ok: false, error: 'errKeys', keys: 'ae64.x' });
    expect(parseImport(file({ a: '1', b: '1', c: '1', d: '1' }), 50)).toEqual({ ok: false, error: 'errKeys', keys: 'a, b, c…' });
  });

  it('H-1: a key longer than 40 characters is shown as its first 39 + "…"; 40 and the real keys stay whole', () => {
    const long = `ae64.${'x'.repeat(400)}`;
    const r = parseImport(file({ [long]: '1' }), 500);
    expect(r).toEqual({ ok: false, error: 'errKeys', keys: `${long.slice(0, 39)}…` });
    expect(r.ok === false && [...r.keys!].length).toBe(40);
    const forty = `ae64.${'y'.repeat(35)}`;
    expect(forty).toHaveLength(40);
    expect(parseImport(file({ [forty]: '1' }), 100)).toEqual({ ok: false, error: 'errKeys', keys: forty });
    expect(parseImport(file({ [`${forty}z`]: '1' }), 100)).toEqual({ ok: false, error: 'errKeys', keys: `${forty.slice(0, 39)}…` });
    expect(parseImport(file({ 'ae64.live.colorByResult': 'x' }), 100)).toEqual({ ok: false, error: 'errValue', keys: 'ae64.live.colorByResult' });
    // 4 long keys: 3 cut keys, then "…"; a character outside the BMP is not split in half
    const four = Object.fromEntries(['a', 'b', 'c', 'd'].map((c) => [c.repeat(50), '1']));
    expect(parseImport(file(four), 500)).toEqual({ ok: false, error: 'errKeys', keys: ['a', 'b', 'c'].map((c) => `${c.repeat(39)}…`).join(', ') + '…' });
    const emoji = `${'e'.repeat(38)}😀😀😀`;
    expect(parseImport(file({ [emoji]: '1' }), 500)).toEqual({ ok: false, error: 'errKeys', keys: `${'e'.repeat(38)}😀…` });
  });

  it('a value that is not a string is a wrong value', () => {
    expect(parseImport(file({ 'ae64.sidebarCollapsed': 1 }), 50)).toEqual({ ok: false, error: 'errValue', keys: 'ae64.sidebarCollapsed' });
    expect(parseImport(file({ 'ae64.live.keyLock': 'true', 'ae64.locale': 'fr' }), 50)).toEqual({ ok: false, error: 'errValue', keys: 'ae64.live.keyLock, ae64.locale' });
  });

  it('a good file gives its data, time and version', () => {
    expect(parseImport(file({ 'ae64.theme': 'graphite' }), 100)).toEqual({
      ok: true, data: { 'ae64.theme': 'graphite' }, savedAt: '2026-11-13T04:35:00.000Z', version: '0.1.0',
    });
  });
});

describe('items 4, 5: export → import, reset (PLAN)', () => {
  it('export: the 11 keys, not ae64.lastDevice, not other.app, not an old ae64.* key; the file name has the local date', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 13, 23, 50));
    for (const [k, v] of Object.entries(ALL)) localStorage.setItem(k, v);
    localStorage.setItem('ae64.lastDevice', '{"vendorId":1}');
    localStorage.setItem('other.app', 'x');
    localStorage.setItem('ae64.switchTab', 'calibration');
    localStorage.setItem('ae64.oldThing', '1');
    const { json, file, n } = buildExport();
    expect(file).toBe('ae64-control-settings-20261113.json');
    expect(exportFileName(new Date(2026, 0, 5))).toBe('ae64-control-settings-20260105.json');
    expect(n).toBe(11);
    const body = JSON.parse(json);
    expect(body.app).toBe('ae64-control');
    expect(body.savedAt).toBe(new Date(2026, 10, 13, 23, 50).toISOString());
    expect(typeof body.version).toBe('string');
    expect(body.data).toEqual(ALL);
    expect(json).toContain('\n  "app"'); // indent 2
  });

  it('a stored value the app would not read as itself is not exported (the file always imports)', () => {
    localStorage.setItem('ae64.theme', 'neon');
    localStorage.setItem('ae64.locale', 'vi');
    expect(storedSettings()).toEqual({ 'ae64.locale': 'vi' });
    expect(parseImport(buildExport().json, 10).ok).toBe(true);
  });

  it('import that file into an empty browser: the 11 keys come back character for character, lastDevice untouched', async () => {
    for (const [k, v] of Object.entries(ALL)) localStorage.setItem(k, v);
    const { json } = buildExport();
    localStorage.clear();
    localStorage.setItem('ae64.lastDevice', 'kept');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    const r = parseImport(json, json.length);
    expect(r.ok).toBe(true);
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('import', (r as { data: Record<string, string> }).data);
    for (const [k, v] of Object.entries(ALL)) expect(localStorage.getItem(k), k).toBe(v);
    expect(localStorage.getItem('ae64.lastDevice')).toBe('kept');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('import');
  });

  it('import only replaces the keys in the file; the others stay', async () => {
    localStorage.setItem('ae64.theme', 'light');
    localStorage.setItem('ae64.sidebarCollapsed', '1');
    vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('import', { 'ae64.theme': 'ember' });
    expect(localStorage.getItem('ae64.theme')).toBe('ember');
    expect(localStorage.getItem('ae64.sidebarCollapsed')).toBe('1');
  });

  it('reset: every ae64.* key goes (ae64.oldThing, ae64.switchTab too); ae64.lastDevice and other.app stay', async () => {
    for (const [k, v] of Object.entries(ALL)) localStorage.setItem(k, v);
    localStorage.setItem('ae64.lastDevice', 'kept');
    localStorage.setItem('other.app', 'x');
    localStorage.setItem('ae64.oldThing', '1');
    localStorage.setItem('ae64.switchTab', 'switch');
    expect(resetKeys()).not.toContain('ae64.lastDevice');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    await useDeviceStore().connectDemo('max');
    await useAppSettings().applyAndReload('reset');
    const left = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).sort();
    expect(left).toEqual(['ae64.lastDevice', 'other.app']);
    expect(localStorage.getItem('ae64.lastDevice')).toBe('kept');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('reset');
  });
});

describe('item 6: the safe order (flush first, then write, then reload)', () => {
  async function ready() {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    return { device, sync: useSyncStore(), reload, app: useAppSettings() };
  }

  it('flush refuses → localStorage as it was, no reload, the error says errPending', async () => {
    localStorage.setItem('ae64.theme', 'light');
    const { sync, reload, app } = await ready();
    vi.spyOn(sync, 'flush').mockRejectedValue(new Error('held'));
    await expect(app.applyAndReload('import', { 'ae64.theme': 'ember' })).rejects.toThrow(t('appcfg.errPending', { msg: 'held' }));
    await expect(app.applyAndReload('reset')).rejects.toThrow(/held/);
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
  });

  it('nothing is written before flush() has finished', async () => {
    const { sync, app } = await ready();
    let seen: string | null = 'unset';
    vi.spyOn(sync, 'flush').mockImplementation(async () => { seen = localStorage.getItem('ae64.theme'); });
    await app.applyAndReload('import', { 'ae64.theme': 'ember' });
    expect(seen).toBeNull();
    expect(localStorage.getItem('ae64.theme')).toBe('ember');
  });

  it('a real held write: flush refuses while a write is queued and held', async () => {
    const { sync, reload, app } = await ready();
    const settings = useSettingsStore();
    await settings.load();
    const release = sync.hold();
    settings.setSystemMode(1);
    await expect(app.applyAndReload('reset')).rejects.toThrow(t('appcfg.errPending', { msg: t('sync.held') }));
    expect(reload).not.toHaveBeenCalled();
    release();
    await sync.flush();
  });

  it('setItem throws at the 2nd key → the 1st key gets its old value back, errWrite, no reload, no flag', async () => {
    localStorage.setItem('ae64.theme', 'light');
    const { reload, app } = await ready();
    const real = Storage.prototype.setItem;
    let n = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === localStorage && ++n === 2) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    await expect(app.applyAndReload('import', { 'ae64.theme': 'ember', 'ae64.locale': 'en' })).rejects.toThrow(t('appcfg.errWrite'));
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(localStorage.getItem('ae64.locale')).toBeNull();
    expect(reload).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
  });

  it('a key that did not exist is removed again when a later write fails', async () => {
    const { app } = await ready();
    const real = Storage.prototype.setItem;
    let n = 0;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (this === localStorage && ++n === 2) throw new DOMException('full', 'QuotaExceededError');
      return real.call(this, k, v);
    });
    await expect(app.applyAndReload('import', { 'ae64.theme': 'ember', 'ae64.locale': 'en' })).rejects.toThrow();
    expect(localStorage.getItem('ae64.theme')).toBeNull();
  });
});

describe('item 7: locked while the keyboard is busy (store level; the buttons are in settings-data-card)', () => {
  async function ready() {
    localStorage.setItem('ae64.theme', 'light');
    const device = useDeviceStore();
    await device.connectDemo('max');
    const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    return { device, reload, app: useAppSettings() };
  }
  const untouched = (reload: { mock: { calls: unknown[] } }) => {
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(reload.mock.calls).toHaveLength(0);
  };

  it('calibrating → busyCal', async () => {
    const { reload, app } = await ready();
    useCalibrationStore().phase = 'running';
    expect(app.busyReason.value).toBe(t('appcfg.busyCal'));
    await expect(app.applyAndReload('reset')).rejects.toThrow(t('appcfg.busyCal'));
    untouched(reload);
  });

  it('an exclusive write held open → busyWrite; ended → null again', async () => {
    const { device, reload, app } = await ready();
    let release!: () => void;
    const held = device.withTransport(() => new Promise<void>((ok) => { release = ok; }), { exclusive: true });
    expect(device.exclusiveActive).toBe(true);
    expect(app.busyNow()).toBe(t('appcfg.busyWrite'));
    await expect(app.applyAndReload('reset')).rejects.toThrow(t('appcfg.busyWrite'));
    untouched(reload);
    release();
    await held;
    expect(app.busyNow()).toBeNull();
    expect(app.busyReason.value).toBeNull();
  });

  it.each(['applying', 'reconnecting'] as const)('polling rate %s → busyWrite', async (state) => {
    const { reload, app } = await ready();
    useSettingsStore().pollingState = state;
    await expect(app.applyAndReload('import', { 'ae64.theme': 'ember' })).rejects.toThrow(t('appcfg.busyWrite'));
    untouched(reload);
    useSettingsStore().pollingState = 'idle';
    expect(app.busyNow()).toBeNull();
  });

  it('gamepad USB restart (usbBusy) → busyWrite', async () => {
    const { reload, app } = await ready();
    useGamepadStore().usbBusy = true;
    expect(app.busyNow()).toBe(t('appcfg.busyWrite'));
    await expect(app.applyAndReload('reset')).rejects.toThrow(t('appcfg.busyWrite'));
    untouched(reload);
  });

  it('an exclusive write that starts while flush() waits → busyWrite after flush, no reload', async () => {
    const { device, reload, app } = await ready();
    const sync = useSyncStore();
    let release!: () => void;
    let held: Promise<void> | null = null;
    vi.spyOn(sync, 'flush').mockImplementation(async () => {
      held = device.withTransport(() => new Promise<void>((ok) => { release = ok; }), { exclusive: true });
    });
    await expect(app.applyAndReload('reset')).rejects.toThrow(t('appcfg.busyWrite'));
    untouched(reload);
    release();
    await held;
  });

  it('calibration mode on the keyboard (calibrationLocked) is read fresh at the click', async () => {
    const { device, reload, app } = await ready();
    expect(app.busyReason.value).toBeNull();
    vi.spyOn(device, 'calibrationLocked').mockReturnValue(true);
    await expect(app.applyAndReload('reset')).rejects.toThrow(t('appcfg.busyCal'));
    untouched(reload);
  });
});

describe('item 12: the toast flag after a reload', () => {
  it('read once, then gone; a stray value is no toast', () => {
    sessionStorage.setItem(APPCFG_DONE_KEY, 'import');
    expect(takeAppcfgDone()).toBe('import');
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
    expect(takeAppcfgDone()).toBeNull();
    sessionStorage.setItem(APPCFG_DONE_KEY, 'x');
    expect(takeAppcfgDone()).toBeNull();
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
  });
});

describe('item 14: strings', () => {
  const H_KEY = /^(info|data|appcfg)\.|^sync\.savedHelp$/;
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

  it('every info.*, data.*, appcfg.* and sync.savedHelp key is in vi and en with the same {variables}', () => {
    const viKeys = Object.keys(viDict).filter((k) => H_KEY.test(k));
    const enKeys = Object.keys(en).filter((k) => H_KEY.test(k));
    expect(viKeys.sort()).toEqual(enKeys.sort());
    // 63 of H + data.c.accent, data.c.wallpaper and appcfg.errWallpaper of J
    expect(viKeys.length).toBe(66);
    for (const k of viKeys) {
      const v = (viDict as Record<string, string>)[k];
      const e = (en as Record<string, string>)[k];
      expect(v && e, k).toBeTruthy();
      expect(vars(v), k).toEqual(vars(e));
    }
    for (const g of groupsOf(TABLE)) expect(viKeys).toContain(`data.c.${g}`);
  });
});
