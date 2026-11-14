// DESIGN H §3.3, §3.4, §3.6, §3.7, §11 items 6, 7, 8, 13: the "Where your data lives" card on the Settings page, its two
// dialogs, the busy lock, the read-only profile names, and the Diagnostics link. Every case counts HID commands: 0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter, type Router } from 'vue-router';
import { routes } from '../src/router';
import SettingsPage from '../src/pages/SettingsPage.vue';
import DiagnosticsPage from '../src/pages/DiagnosticsPage.vue';
import { MockTransport } from '../src/protocol';
import { pageReload } from '../src/data/appSettings';
import { APPCFG_DONE_KEY } from '../src/data/appcfgDone';
import { useDeviceStore } from '../src/stores/device';
import { useSettingsStore } from '../src/stores/settings';
import { useCalibrationStore } from '../src/stores/calibration';
import { useGamepadStore } from '../src/stores/gamepad';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { setTheme } from '../src/theme';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

let wrapper: VueWrapper | null = null;
const preset = (id: string, name: string) => ({
  id, name, mode: 1, continuous: false, actuation: 1.2, rtPress: 0.15, rtRelease: 0.15, deadTop: 0.1, deadBottom: 0.1,
});
const THREE = JSON.stringify([preset('a', 'FPS'), preset('b', 'Typing'), preset('c', 'Deep')]);

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setActivePinia(createPinia());
  setLocale('vi');
  localStorage.clear(); // setLocale wrote ae64.locale
  URL.createObjectURL = vi.fn(() => 'blob:ae64');
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

async function page(opts: { model?: 'max' | 'pro'; before?: () => void } = {}) {
  const device = useDeviceStore();
  await device.connectDemo(opts.model ?? 'max');
  localStorage.removeItem('ae64.demoModel'); // the demo remembers its model: start from an empty browser
  opts.before?.();
  const mock = device.transport as MockTransport;
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/settings');
  wrapper = mount(SettingsPage, { global: { plugins: [router] }, attachTo: document.body });
  await vi.waitFor(() => expect(useSettingsStore().loaded).toBe(true));
  await flushPromises();
  const out: string[] = [];
  mock.onPacket((e) => { if (e.dir === 'out' && !(e.bytes[0] === 4 && e.bytes[1] === 3)) out.push([...e.bytes.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ')); });
  const reload = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
  const w = wrapper;
  const card = () => w.get('.dl-card');
  const btn = (label: string) => card().findAll('.dl__actions button').find((b) => b.text() === label)!;
  return {
    device, mock, router, out, reload, w, card,
    exportBtn: () => btn(t('appcfg.export')),
    importBtn: () => btn(t('appcfg.import')),
    resetBtn: () => btn(t('appcfg.reset')),
    input: () => card().get<HTMLInputElement>('input[type="file"]'),
    err: () => card().find('.dl__err'),
    lock: () => card().find('.dl__lock'),
  };
}
type Page = Awaited<ReturnType<typeof page>>;

const dlg = () => document.body.querySelector<HTMLElement>('.dlg__panel');
const dlgButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.dlg__foot button')].find((b) => b.textContent!.trim() === label)!;
const settle = async () => { await flushPromises(); await new Promise((r) => setTimeout(r, 5)); await flushPromises(); };

async function choose(p: Page, text: string, size?: number) {
  const f = new File([text], 'ae64-control-settings-20261113.json', { type: 'application/json' });
  if (size !== undefined) Object.defineProperty(f, 'size', { value: size });
  const el = p.input().element;
  Object.defineProperty(el, 'files', { value: [f], configurable: true });
  await p.input().trigger('change');
  await settle();
}
const fileOf = (data: Record<string, string>) => JSON.stringify({ app: 'ae64-control', version: '0.1.0+20261110', savedAt: new Date(2026, 10, 10, 21, 14).toISOString(), data });

describe('the card', () => {
  it('last cell of the grid, full row; 11 items on the keyboard, 10 groups on this computer; the promise; the Diagnostics link', async () => {
    const p = await page();
    const grid = p.w.get('.settings-grid');
    expect(grid.element.lastElementChild).toBe(p.card().element);
    const [k, c] = p.card().findAll('.dl__col');
    expect(k.attributes('aria-labelledby')).toBe('dl-k');
    expect(p.card().attributes('aria-labelledby')).toBe('dl-title');
    expect(p.card().get('#dl-title').text()).toBe(t('data.title'));
    expect(k.findAll('.dl__list li').map((li) => li.text())).toEqual([
      'data.k.travel', 'data.k.switch', 'data.k.calibration', 'data.k.advanced', 'data.k.keymap', 'data.k.macro', 'data.k.lighting',
      'data.k.profiles', 'data.k.system', 'data.k.sleep', 'data.k.gamepad',
    ].map((x) => t(x as never)));
    expect(c.findAll('.dl__list li').map((li) => li.text())).toEqual(
      ['theme', 'accent', 'wallpaper', 'locale', 'presets', 'tabs', 'toggles', 'colors', 'sidebar', 'demo'].map((g) => t(`data.c.${g}` as never)),
    );
    expect(k.get('.dl__promise').text()).toBe(t('sync.savedHelp'));
    expect(k.get('a.dl__link').attributes('href')).toBe('/diagnostics?focus=backup');
    expect(c.get('.dl__note').text()).toBe(t('appcfg.note'));
    // Tab order in the card: link → Export → Import → Reset
    const focusables = [...p.card().element.querySelectorAll<HTMLElement>('a[href], button')].map((e) => e.textContent!.trim());
    expect(focusables).toEqual([t('data.keyboardBackup'), t('appcfg.export'), t('appcfg.import'), t('appcfg.reset')]);
    expect(p.out).toEqual([]);
  });

  it('still shown under the error card when the settings could not be read', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('max');
    vi.spyOn(device.transport as MockTransport, 'getSystemMode').mockRejectedValue(new Error('usb'));
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/settings');
    wrapper = mount(SettingsPage, { global: { plugins: [router] }, attachTo: document.body });
    await vi.waitFor(() => expect(useSettingsStore().loadError).toBeTruthy());
    await flushPromises();
    expect(wrapper.find('.dl-card').exists()).toBe(true);
  });
});

describe('Export', () => {
  it('off with a reason while nothing is stored; a theme picked on the same page turns it on without a reload', async () => {
    const p = await page();
    expect(p.exportBtn().attributes('disabled')).toBeDefined();
    expect(p.exportBtn().attributes('title')).toBe(t('appcfg.nothing'));
    expect(p.importBtn().attributes('disabled')).toBeUndefined();
    setTheme('ember');
    await settle();
    expect(p.exportBtn().attributes('disabled')).toBeUndefined();
    expect(p.exportBtn().attributes('title')).toBeUndefined();
    setTheme('auto');
    localStorage.clear();
    window.dispatchEvent(new StorageEvent('storage', { key: null }));
    await settle();
    expect(p.exportBtn().attributes('disabled')).toBeDefined();
    localStorage.setItem('ae64.sidebarCollapsed', '1'); // the sidebar's own write: seen when the pointer comes to the card
    await p.card().trigger('pointerenter');
    expect(p.exportBtn().attributes('disabled')).toBeUndefined();
    expect(p.out).toEqual([]);
  });

  it('downloads the file and says how many settings went into which file; 0 HID', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2030, 0, 2, 9, 0));
    const p = await page({ before: () => { localStorage.setItem('ae64.theme', 'ember'); localStorage.setItem('ae64.perfTab', 'switch'); } });
    let name = '';
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { name = this.download; });
    await p.exportBtn().trigger('click');
    expect(name).toBe('ae64-control-settings-20300102.json');
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    const blob = (URL.createObjectURL as ReturnType<typeof vi.fn>).mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text()).data).toEqual({ 'ae64.theme': 'ember', 'ae64.perfTab': 'switch' });
    expect(useToast().items.value.map((x) => x.text)).toContain(t('appcfg.exported', { n: 2, file: 'ae64-control-settings-20300102.json' }));
    expect(p.out).toEqual([]);
  });

  it('H-TEST-3: nothing stored, then the language changed (no pointer, focus or storage event): Export turns on', async () => {
    const p = await page();
    expect(p.exportBtn().attributes('disabled')).toBeDefined();
    setLocale('en'); // writes ae64.locale
    await nextTick();
    await nextTick();
    expect(localStorage.getItem('ae64.locale')).toBe('en');
    expect(p.exportBtn().attributes('disabled')).toBeUndefined();
    setLocale('vi');
  });

  it('H-TEST-5: storage emptied behind its back (no event): Export downloads nothing, no toast, and turns off', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.theme', 'ember') });
    expect(p.exportBtn().attributes('disabled')).toBeUndefined();
    useToast().items.value.splice(0);
    localStorage.clear();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    await p.exportBtn().trigger('click');
    await nextTick();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(useToast().items.value).toHaveLength(0);
    expect(p.exportBtn().attributes('disabled')).toBeDefined();
    expect(p.out).toEqual([]);
  });
});

describe('Import', () => {
  it('H-TEST-4: the file input is emptied after each pick (the same file chosen again runs again)', async () => {
    const p = await page();
    const set = vi.fn();
    Object.defineProperty(p.input().element, 'value', { set, get: () => '', configurable: true });
    await choose(p, 'not json');
    expect(set).toHaveBeenCalledWith('');
    expect(p.err().text()).toBe(t('appcfg.errJson'));
  });

  it('a wrong file: the error under the buttons, no dialog, nothing written; a button press clears it', async () => {
    const p = await page();
    await choose(p, fileOf({ 'ae64.layout.v2': '1', 'ae64.beta': '1' }));
    expect(dlg()).toBeNull();
    expect(p.err().attributes('role')).toBe('alert');
    expect(p.err().text()).toBe(t('appcfg.errKeys', { keys: 'ae64.layout.v2, ae64.beta' }));
    await choose(p, '{"app":"ae64-control","data":{"ae64.theme":"neon"}}');
    expect(p.err().text()).toBe(t('appcfg.errValue', { keys: 'ae64.theme' }));
    await choose(p, 'not json');
    expect(p.err().text()).toBe(t('appcfg.errJson'));
    await p.resetBtn().trigger('click');
    expect(p.err().exists()).toBe(false);
    expect(localStorage.length).toBe(0);
    expect(p.out).toEqual([]);
  });

  it('a 2 MB file is refused for its size, without reading it', async () => {
    const p = await page();
    const text = vi.spyOn(File.prototype, 'text');
    await choose(p, fileOf({ 'ae64.theme': 'graphite' }), 2 * 1024 * 1024);
    expect(p.err().text()).toBe(t('appcfg.errSize'));
    expect(text).not.toHaveBeenCalled();
    expect(dlg()).toBeNull();
  });

  it('a good file: the dialog says when, from which build, which groups; 3 → 2 presets warning; focus on "Import and reload"', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.perf.userPresets', THREE) });
    await choose(p, fileOf({ 'ae64.theme': 'ember', 'ae64.locale': 'en', 'ae64.perf.userPresets': JSON.stringify([preset('x', 'A'), preset('y', 'B')]), 'ae64.live.keyLock': '1', 'ae64.demoModel': 'pro' }));
    const d = dlg()!;
    expect(d.querySelector('.dlg__title')!.textContent).toBe(t('appcfg.importTitle'));
    expect(d.querySelector('.ac__body p')!.textContent).toBe(t('appcfg.importBody', { time: '2026-11-10 21:14', version: '0.1.0+20261110' }));
    expect([...d.querySelectorAll('.ac__list li')].map((li) => li.textContent)).toEqual(
      ['theme', 'locale', 'presets', 'toggles', 'demo'].map((g) => t(`data.c.${g}` as never)),
    );
    const warn = d.querySelector('.ac__warn')!.textContent!;
    expect(warn).toBe(t('appcfg.importPresets', { n: 3, m: 2 }));
    expect(warn).toContain('3');
    expect(warn).toContain('2');
    expect(d.querySelector('.ac__safe')!.textContent).toBe(t('appcfg.keyboardSafe'));
    expect(document.activeElement).toBe(dlgButton(t('appcfg.importConfirm')));
    expect(p.out).toEqual([]);
  });

  it('no presets warning when this computer has none', async () => {
    const p = await page();
    await choose(p, fileOf({ 'ae64.perf.userPresets': JSON.stringify([preset('x', 'A')]) }));
    expect(dlg()!.querySelector('.ac__list')!.textContent).toBe(t('data.c.presets'));
    expect(dlg()!.querySelector('.ac__warn')).toBeNull();
  });

  it('no presets warning when the file has no presets (the 3 here stay)', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.perf.userPresets', THREE) });
    await choose(p, fileOf({ 'ae64.theme': 'ember' }));
    expect(dlg()!.querySelector('.ac__warn')).toBeNull();
  });

  it('Cancel writes nothing; the same file chosen again opens the dialog again; Import writes, sets the flag and reloads; 0 HID', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.theme', 'light') });
    const text = fileOf({ 'ae64.theme': 'ember', 'ae64.sidebarCollapsed': '1' });
    await choose(p, text);
    dlgButton(t('appcfg.cancel')).click();
    await settle();
    expect(dlg()).toBeNull();
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(p.input().element.value).toBe('');
    await choose(p, text);
    expect(dlg()).not.toBeNull();
    dlgButton(t('appcfg.importConfirm')).click();
    await settle();
    expect(localStorage.getItem('ae64.theme')).toBe('ember');
    expect(localStorage.getItem('ae64.sidebarCollapsed')).toBe('1');
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('import');
    expect(p.reload).toHaveBeenCalledTimes(1);
    expect(p.out).toEqual([]);
  });

  it('flush refuses: the dialog closes, the error says errPending, nothing written, no reload', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.theme', 'light') });
    vi.spyOn(useSyncStore(), 'flush').mockRejectedValue(new Error('held'));
    await choose(p, fileOf({ 'ae64.theme': 'ember' }));
    dlgButton(t('appcfg.importConfirm')).click();
    await settle();
    expect(dlg()).toBeNull();
    expect(p.err().text()).toBe(t('appcfg.errPending', { msg: 'held' }));
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(p.reload).not.toHaveBeenCalled();
  });
});

describe('Reset', () => {
  it('3 presets: the warning says 3; focus on Cancel; Cancel keeps everything; 0 HID', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.perf.userPresets', THREE) });
    await p.resetBtn().trigger('click');
    await settle();
    const d = dlg()!;
    expect(d.querySelector('.dlg__title')!.textContent).toBe(t('appcfg.resetTitle'));
    expect(d.querySelector('.ac__warn')!.textContent).toBe(t('appcfg.resetPresets', { n: 3 }));
    expect(document.activeElement).toBe(dlgButton(t('appcfg.cancel')));
    dlgButton(t('appcfg.cancel')).click();
    await settle();
    expect(localStorage.getItem('ae64.perf.userPresets')).toBe(THREE);
    expect(p.out).toEqual([]);
  });

  it('no presets: no warning; "Reset and reload" clears ae64.* but ae64.lastDevice, flags reset, reloads; 0 HID', async () => {
    const p = await page({ before: () => { localStorage.setItem('ae64.theme', 'light'); localStorage.setItem('ae64.lastDevice', 'kept'); localStorage.setItem('ae64.old', '1'); } });
    await p.resetBtn().trigger('click');
    await settle();
    expect(dlg()!.querySelector('.ac__warn')).toBeNull();
    dlgButton(t('appcfg.resetConfirm')).click();
    await settle();
    expect(localStorage.getItem('ae64.theme')).toBeNull();
    expect(localStorage.getItem('ae64.old')).toBeNull();
    expect(localStorage.getItem('ae64.lastDevice')).toBe('kept');
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('reset');
    expect(p.reload).toHaveBeenCalledTimes(1);
    expect(p.out).toEqual([]);
  });
});

describe('H-1: a very long unknown key', () => {
  it('the error shows it cut to 40 characters, never the whole key', async () => {
    const p = await page();
    const long = `ae64.${'x'.repeat(400)}`;
    await choose(p, fileOf({ [long]: '1' }));
    const text = p.err().text();
    expect(text).not.toContain('x'.repeat(41));
    expect(text).toBe(t('appcfg.errKeys', { keys: `${long.slice(0, 39)}…` }));
    expect(dlg()).toBeNull();
    expect(p.out).toEqual([]);
  });
});

describe('H-2: the dialog cannot be closed while the confirm waits for the keyboard writes', () => {
  /** sync.flush() held until release() or fail(). */
  function holdFlush() {
    let release!: () => void;
    let fail!: (e: Error) => void;
    vi.spyOn(useSyncStore(), 'flush').mockImplementation(() => new Promise<void>((ok, no) => { release = ok; fail = no; }));
    return { release: () => release(), fail: (e: Error) => fail(e) };
  }
  /** × and Esc on the panel, Cancel disabled: the dialog stays open; focus stays in it. */
  async function triesToClose() {
    const cancel = dlgButton(t('appcfg.cancel'));
    expect(cancel.disabled).toBe(true);
    cancel.click();
    await settle();
    expect(dlg()).not.toBeNull();
    dlg()!.querySelector<HTMLButtonElement>('.dlg__close')!.click();
    await settle();
    expect(dlg()).not.toBeNull();
    dlg()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(dlg()).not.toBeNull();
    expect(dlg()!.contains(document.activeElement)).toBe(true);
  }

  it('import: Cancel off, × and Esc ignored while flush waits; released → the file is written and the page reloads once', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.theme', 'light') });
    const flush = holdFlush();
    await choose(p, fileOf({ 'ae64.theme': 'ember' }));
    dlgButton(t('appcfg.importConfirm')).click();
    await settle();
    await triesToClose();
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(p.reload).not.toHaveBeenCalled();
    flush.release();
    await settle();
    expect(localStorage.getItem('ae64.theme')).toBe('ember');
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('import');
    expect(p.reload).toHaveBeenCalledTimes(1);
    expect(p.out).toEqual([]);
  });

  it('reset: Cancel off, × and Esc ignored while flush waits; released → cleared and the page reloads once', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.perf.userPresets', THREE) });
    const flush = holdFlush();
    await p.resetBtn().trigger('click');
    await settle();
    dlgButton(t('appcfg.resetConfirm')).click();
    await settle();
    await triesToClose();
    expect(localStorage.getItem('ae64.perf.userPresets')).toBe(THREE);
    expect(p.reload).not.toHaveBeenCalled();
    flush.release();
    await settle();
    expect(localStorage.getItem('ae64.perf.userPresets')).toBeNull();
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBe('reset');
    expect(p.reload).toHaveBeenCalledTimes(1);
    expect(p.out).toEqual([]);
  });

  it.each(['import', 'reset'] as const)('%s: flush refuses after waiting → the dialog closes, errPending, nothing written, no reload', async (kind) => {
    const p = await page({ before: () => { localStorage.setItem('ae64.theme', 'light'); localStorage.setItem('ae64.perf.userPresets', THREE); } });
    const flush = holdFlush();
    if (kind === 'import') await choose(p, fileOf({ 'ae64.theme': 'ember' }));
    else { await p.resetBtn().trigger('click'); await settle(); }
    dlgButton(t(kind === 'import' ? 'appcfg.importConfirm' : 'appcfg.resetConfirm')).click();
    await settle();
    expect(dlg()).not.toBeNull();
    flush.fail(new Error('held'));
    await settle();
    expect(dlg()).toBeNull();
    expect(p.err().text()).toBe(t('appcfg.errPending', { msg: 'held' }));
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(localStorage.getItem('ae64.perf.userPresets')).toBe(THREE);
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
    expect(p.reload).not.toHaveBeenCalled();
    expect(p.out).toEqual([]);
  });

  it('before confirming, × and Esc still close (and Cancel is on)', async () => {
    const p = await page();
    await p.resetBtn().trigger('click');
    await settle();
    expect(dlgButton(t('appcfg.cancel')).disabled).toBe(false);
    dlg()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(dlg()).toBeNull();
    await p.resetBtn().trigger('click');
    await settle();
    dlg()!.querySelector<HTMLButtonElement>('.dlg__close')!.click();
    await settle();
    expect(dlg()).toBeNull();
  });
});

describe('item 7: locked while the keyboard is busy', () => {
  const locked = (p: Page, reason: string) => {
    expect(p.importBtn().attributes('disabled')).toBeDefined();
    expect(p.resetBtn().attributes('disabled')).toBeDefined();
    expect(p.lock().text()).toBe(reason);
    expect(p.lock().attributes('role')).toBe('status');
  };
  const free = (p: Page) => {
    expect(p.importBtn().attributes('disabled')).toBeUndefined();
    expect(p.resetBtn().attributes('disabled')).toBeUndefined();
    expect(p.lock().exists()).toBe(false);
  };

  it('calibrating: Import and Reset off with busyCal, Export still on', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.theme', 'light') });
    free(p);
    useCalibrationStore().phase = 'running';
    await settle();
    locked(p, t('appcfg.busyCal'));
    expect(p.exportBtn().attributes('disabled')).toBeUndefined();
    useCalibrationStore().phase = 'idle';
    await settle();
    free(p);
  });

  it('an exclusive write held open: busyWrite; when it ends the buttons come back', async () => {
    const p = await page();
    let release!: () => void;
    const held = p.device.withTransport(() => new Promise<void>((ok) => { release = ok; }), { exclusive: true });
    await settle();
    locked(p, t('appcfg.busyWrite'));
    release();
    await held;
    await settle();
    free(p);
  });

  it.each(['applying', 'reconnecting'] as const)('polling rate %s: busyWrite', async (state) => {
    const p = await page();
    useSettingsStore().pollingState = state;
    await settle();
    locked(p, t('appcfg.busyWrite'));
    useSettingsStore().pollingState = 'idle';
    await settle();
    free(p);
  });

  it('gamepad USB restart: busyWrite', async () => {
    const p = await page();
    useGamepadStore().usbBusy = true;
    await settle();
    locked(p, t('appcfg.busyWrite'));
  });

  it('a dialog opened before the keyboard got busy: confirming shows the reason in the error line, no reload', async () => {
    const p = await page({ before: () => localStorage.setItem('ae64.theme', 'light') });
    await p.resetBtn().trigger('click');
    await settle();
    useSettingsStore().pollingState = 'reconnecting';
    await settle();
    dlgButton(t('appcfg.resetConfirm')).click();
    await settle();
    expect(dlg()).toBeNull();
    expect(p.err().text()).toBe(t('appcfg.busyWrite'));
    expect(localStorage.getItem('ae64.theme')).toBe('light');
    expect(p.reload).not.toHaveBeenCalled();
  });
});

describe('§3.7: profile names in Settings, read only', () => {
  it('the 4 names exactly as stored (a Pro name keeps its trailing space), the active one marked; no input', async () => {
    const p = await page({ model: 'pro' });
    const card = p.w.findAll('.card').find((c) => c.find('.card__title').text() === t('settings.profileNames'))!;
    const rows = card.findAll('.pn__row');
    expect(rows.map((r) => r.get('.pn__name').element.textContent)).toEqual(p.device.profileNames);
    expect(rows[1].get('.pn__name').element.textContent).toBe('配置二 ');
    expect(rows[1].get('.pn__name').attributes('title')).toBe('配置二 ');
    expect(card.get('.pn').attributes('aria-label')).toBe(t('settings.profileNames'));
    const on = rows.filter((r) => r.classes('pn__row--on'));
    expect(on).toHaveLength(1);
    expect(rows.indexOf(on[0])).toBe(p.device.activeProfile);
    expect(on[0].get('.pn__on').text()).toBe(t('pf.active'));
    expect(card.findAll('input')).toHaveLength(0);
    expect(card.get('.card__actions a').attributes('href')).toBe('/profiles');
  });
});

describe('the Diagnostics link (§3.3)', () => {
  async function diag(query: Record<string, string>) {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const router: Router = createRouter({ history: createMemoryHistory(), routes });
    await router.push({ path: '/diagnostics', query });
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    wrapper = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
    await settle();
    return { router, scroll };
  }

  it('?focus=backup: the Backup card scrolls to the top, its title has the focus, the query is gone', async () => {
    const { router, scroll } = await diag({ focus: 'backup', keep: '1' });
    const title = document.getElementById('diag-backup-title')!;
    expect(title.textContent).toBe(t('diagnostics.backupTitle'));
    expect(title.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(title);
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0]).toBe(title.closest('.card'));
    expect(scroll.mock.calls[0][0]).toMatchObject({ block: 'start' });
    expect(router.currentRoute.value.query).toEqual({ keep: '1' });
  });

  it.each([[true, 'auto'], [false, 'smooth']] as const)('H-TEST-7: reduced motion %s → the scroll is %s', async (reduce, behavior) => {
    const had = Object.prototype.hasOwnProperty.call(window, 'matchMedia');
    const old = window.matchMedia;
    window.matchMedia = vi.fn((q: string) => ({
      matches: q === '(prefers-reduced-motion: reduce)' ? reduce : false, media: q, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const { scroll } = await diag({ focus: 'backup' });
      expect(window.matchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
      expect(scroll).toHaveBeenCalledTimes(1);
      expect(scroll.mock.calls[0][0]).toEqual({ block: 'start', behavior });
    } finally {
      if (had) window.matchMedia = old;
      else delete (window as unknown as Record<string, unknown>).matchMedia;
    }
  });

  it('without the query nothing moves', async () => {
    const { scroll } = await diag({});
    expect(scroll).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(document.getElementById('diag-backup-title'));
  });
});
