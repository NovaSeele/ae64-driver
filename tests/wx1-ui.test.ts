// WX1 on the pages: U-09 (the Advanced tab's delete dialog over a profile switch), the Macro page's "Assigned" line after
// a switch, and the sidebar profile list while another exclusive job runs (W-09). Demo keyboard only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { mountPerformance } from './mountPerformance';
import type { MockTransport } from '../src/protocol';
import ProfileSelect from '../src/components/shell/ProfileSelect.vue';
import MacroPage from '../src/pages/MacroPage.vue';
import DiagnosticsPage from '../src/pages/DiagnosticsPage.vue';
import { routes } from '../src/router';
import { useDeviceStore } from '../src/stores/device';
import { useAdvancedStore } from '../src/stores/advanced';
import type { DksAssignment } from '../src/stores/advanced';
import { useKeymapStore } from '../src/stores/keymap';
import { useMacroStore } from '../src/stores/macro';
import { useSyncStore } from '../src/stores/sync';
import { useCalibrationStore } from '../src/stores/calibration';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { useToast } from '../src/components/ui/toast';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

let w: VueWrapper | null = null;
beforeEach(() => {
  locale.value = 'vi';
  useToast().items.value = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 }, borderBoxSize: [{ inlineSize: 900, blockSize: 300 }] }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useToast().items.value = [];
});
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await flushPromises(); };
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('U-09: the delete dialog of an assignment, the profile changes under it', () => {
  it('the dialog closes with the switch, and nothing of the other profile is deleted', async () => {
    setActivePinia(createPinia());
    clearTuningSnapshots();
    const device = useDeviceStore();
    await device.connectDemo('max');
    const adv = useAdvancedStore();
    const sync = useSyncStore();
    const mock = device.transport as MockTransport;
    await adv.load();
    const key = device.keys.find((k) => k.name === 'G')!;
    const p0: DksAssignment = { type: 'DKS', keys: [key.id], keycodes: [0x04, 0x05, 0, 0], travels: [0xff, 0xff, 0, 0], dbs: [1.0, 2.0] };
    const p1: DksAssignment = { type: 'DKS', keys: [key.id], keycodes: [0x06, 0x07, 0, 0], travels: [0xff, 0xff, 0, 0], dbs: [1.2, 2.2] };
    const old0 = adv.byKey.get(key.id);
    if (old0) await adv.remove(old0);
    await adv.save(p0);
    await device.switchProfile(1);
    await adv.load(true);
    const old1 = adv.byKey.get(key.id);
    if (old1) await adv.remove(old1);
    await adv.save(p1);
    await sync.flush();
    ({ w } = await mountPerformance('advanced'));
    await settle(5);
    const row = w.findAll('.item').find((r) => r.attributes('data-item') === `DKS:${key.id}`)!;
    await row.findAll('button').at(-1)!.trigger('click');
    await flushPromises();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await device.switchProfile(0);
    await until(() => !adv.loading && adv.loadedProfile === 0);
    await settle(5);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const clear = vi.spyOn(mock, 'clearAdvanced');
    await sync.flush().catch(() => undefined);
    expect(clear).not.toHaveBeenCalled();
    expect((await mock.getAdvanced(key)).type).toBe('DKS');
  });

  it('remove() refuses an assignment the active profile no longer has exactly', async () => {
    setActivePinia(createPinia());
    clearTuningSnapshots();
    const device = useDeviceStore();
    await device.connectDemo('max');
    const adv = useAdvancedStore();
    const mock = device.transport as MockTransport;
    await adv.load();
    const key = device.keys.find((k) => k.name === 'G')!;
    const p0: DksAssignment = { type: 'DKS', keys: [key.id], keycodes: [0x04, 0x05, 0, 0], travels: [0xff, 0xff, 0, 0], dbs: [1.0, 2.0] };
    const old0 = adv.byKey.get(key.id);
    if (old0) await adv.remove(old0);
    await adv.save(p0);
    const shown = adv.byKey.get(key.id)!;
    const stale = { ...shown, keycodes: [0x06, 0x07, 0, 0] } as typeof shown; // what a dialog of another profile named
    const clear = vi.spyOn(mock, 'clearAdvanced');
    await expect(adv.remove(stale)).rejects.toThrow(tr('advanced.changedMeanwhile'));
    expect(clear).not.toHaveBeenCalled();
    expect(adv.byKey.get(key.id)).toBeTruthy();
    await adv.remove(shown); // the real one still goes
    expect(adv.byKey.get(key.id)).toBeUndefined();
  });
});

describe('Macro "Assigned": the active profile\'s Fn layers after a switch on the Macro page', () => {
  it('G turned round: profile 1\'s line does not show profile 0\'s Fn1 key', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const macro = useMacroStore(pinia);
    const keymap = useKeymapStore(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/macro', component: MacroPage }, { path: '/keymap', component: { template: '<i />' } }] });
    await router.push('/macro');
    w = mount({ template: '<RouterView />' }, { global: { plugins: [router, pinia] }, attachTo: document.body });
    await until(() => macro.loaded && !macro.loading && macro.slots.length === 16 && keymap.loadedProfile === 0 && !keymap.loading);
    await flushPromises();
    keymap.activeLayer = 1;
    keymap.applyKeycode([5], 0xf500); // Macro 1 on Fn1 of key 5, profile 1 (index 0)
    keymap.activeLayer = 0;
    await useSyncStore(pinia).flush();
    await flushPromises();
    expect(w.find('.head__hint:last-of-type').text()).toContain('Fn1:');
    await device.switchProfile(1);
    await until(() => keymap.loadedProfile === 1 && !keymap.loading);
    await flushPromises();
    expect(w.find('.head__hint:last-of-type').text()).not.toContain('Fn1:');
    await device.switchProfile(0);
    await until(() => keymap.loadedProfile === 0 && !keymap.loading);
    await flushPromises();
    expect(w.find('.head__hint:last-of-type').text()).toContain('Fn1:');
  });

  it('WX1-TEST-11 (M1): the Macro page drops its profile listener when it unmounts (no keymap read on a later switch)', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const macro = useMacroStore(pinia);
    const keymap = useKeymapStore(pinia);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/macro', component: MacroPage }, { path: '/keymap', component: { template: '<i />' } }] });
    await router.push('/macro');
    w = mount({ template: '<RouterView />' }, { global: { plugins: [router, pinia] }, attachTo: document.body });
    await until(() => macro.loaded && !macro.loading && keymap.loadedProfile === 0 && !keymap.loading);
    w.unmount();
    w = null;
    const mock = device.transport as MockTransport;
    const rows = vi.spyOn(mock, 'getKeymapRow');
    await device.switchProfile(1);
    await new Promise((r) => setTimeout(r, 300)); // a listener's reload would be well into layers 1-3 by now
    await until(() => !keymap.loading);
    expect(rows.mock.calls.filter(([layer]) => layer !== 0)).toEqual([]); // layer 0 is the switch's own read
    expect(keymap.loadedProfile).toBe(0);
  });
});

describe('W-09: the sidebar profile list while another exclusive job runs', () => {
  it('other profiles look off with the reason; a click is refused with a toast; back to normal after', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('max');
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    w = mount(ProfileSelect, { global: { plugins: [router] }, attachTo: document.body });
    const release = device.holdExclusive();
    await w.get('.ps__trigger').trigger('click');
    let rows = w.findAll('[role="option"]');
    expect(rows[0].classes()).not.toContain('ps__item--off'); // the active one
    expect(rows[2].classes()).toContain('ps__item--off');
    expect(rows[2].attributes('aria-disabled')).toBe('true');
    expect(rows[2].attributes('title')).toBe(tr('device.busy'));
    await rows[2].trigger('click');
    await settle();
    expect(device.activeProfile).toBe(0);
    expect(useToast().items.value.map((x) => x.text)).toContain(tr('device.busy'));
    release();
    await flushPromises();
    // (a click right after the pick would be swallowed as the second half of a double-click: open from the keyboard)
    if (!w.find('.ps__pop').exists()) await w.get('.ps__trigger').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    rows = w.findAll('[role="option"]');
    expect(rows[2].classes()).not.toContain('ps__item--off');
  });

  it('WX1-TEST-11 (S1): while calibrating, the lock tooltip is the calibration text', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('max');
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    w = mount(ProfileSelect, { global: { plugins: [router] }, attachTo: document.body });
    useCalibrationStore().phase = 'running';
    await flushPromises();
    await w.get('.ps__trigger').trigger('click');
    const rows = w.findAll('[role="option"]');
    expect(rows[2].classes()).toContain('ps__item--off');
    expect(rows[2].attributes('title')).toBe(tr('device.calibrating'));
    useCalibrationStore().phase = 'idle';
  });

  it('the write queue\'s own batch does not lock the list', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('max');
    const sync = useSyncStore();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    w = mount(ProfileSelect, { global: { plugins: [router] }, attachTo: document.body });
    let finish: (() => void) | null = null;
    sync.enqueue({ key: 'slow', label: 'slow', write: () => new Promise<void>((r) => { finish = r; }) });
    const flushing = sync.flush();
    await until(() => finish !== null);
    expect(device.exclusiveActive).toBe(true);
    await w.get('.ps__trigger').trigger('click');
    expect(w.findAll('[role="option"]')[2].classes()).not.toContain('ps__item--off');
    finish!();
    await flushing;
  });
});

describe('N-WX1-1: the packet log names each poll row', () => {
  it('a run of active-profile reads is not called live-travel packets', async () => {
    // Pause watchKeyboardProfile's PROFILE_POLL_MS interval so only the 3 explicit reads (6 packets) land in the log.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    for (let i = 0; i < 3; i++) await mock.getActiveProfile(); // 6 packets
    for (let i = 0; i < 2; i++) await mock.getAxisData('route', 1); // 4 packets
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/diagnostics');
    w = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    const lines = w.findAll('.diag-log-line__hex').map((x) => x.text());
    expect(lines.slice(0, 2)).toEqual([tr('diagnostics.travelPackets', { n: 4 }), tr('diagnostics.profilePackets', { n: 6 })]);
  });
});
