// MKB-V step 2a-2: Generic view-mode pages, shell, routes, S3 UI zero-writes, S9 per-page rules,
// and AE64 unchanged checks (DESIGN MKB §3.4, §7, §8.6–§8.8, §9.2, §11, §15).
// Kills M6 (disabled controls + 0 writes), M18 (no AE64 tables on gspoof), M20 (row-0 live travel),
// and M26 (displayName everywhere, never 'AE64' on gspoof / gmiss).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import { GenericMockTransport } from '../src/protocol';
import type { GenericMockName } from '../src/protocol';
import { checkFrame, isWriteCommand } from '../src/protocol/safety';
import { installPerfTabGuard, routes } from '../src/router';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useKeymapStore } from '../src/stores/keymap';
import { useSettingsStore } from '../src/stores/settings';
import { useLightingStore } from '../src/stores/lighting';
import { useLiveStore } from '../src/stores/live';
import { useAdvancedStore } from '../src/stores/advanced';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { useFirmwareStore } from '../src/stores/firmware';
import { useGamepadStore } from '../src/stores/gamepad';
import { clearTuningSnapshots } from '../src/stores/tuning';
import OverviewPage from '../src/pages/OverviewPage.vue';
import KeymapPage from '../src/pages/KeymapPage.vue';
import LightingPage from '../src/pages/LightingPage.vue';
import ProfilesPage from '../src/pages/ProfilesPage.vue';
import MacroPage from '../src/pages/MacroPage.vue';
import SettingsPage from '../src/pages/SettingsPage.vue';
import FirmwarePage from '../src/pages/FirmwarePage.vue';
import GamepadPage from '../src/pages/GamepadPage.vue';
import Sidebar from '../src/components/shell/Sidebar.vue';
import DeviceCard from '../src/components/shell/DeviceCard.vue';
import ProfileSelect from '../src/components/shell/ProfileSelect.vue';
import CopyInfo from '../src/components/settings/CopyInfo.vue';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import { isProfilePoll } from './helpers/profilePoll';

vi.setConfig({ testTimeout: 30000 });

let pinia: Pinia;
const mounted: VueWrapper[] = [];

function makeRouter(): Router {
  const r = createRouter({ history: createMemoryHistory(), routes });
  installPerfTabGuard(r);
  return r;
}

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;

async function settle<T>(promise: Promise<T>, stepMs = 50, maxSteps = 2000): Promise<T> {
  let done = false;
  let val!: T;
  let err: unknown;
  let failed = false;
  promise.then(
    (v) => { done = true; val = v; },
    (e) => { done = true; failed = true; err = e; },
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('settle: timed out');
  if (failed) throw err;
  return val;
}

async function advanceUntil(pred: () => boolean, stepMs = 50, maxSteps = 2000): Promise<void> {
  for (let i = 0; i < maxSteps && !pred(); i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!pred()) throw new Error('advanceUntil: condition not met');
}

function spyExchange(transport: GenericMockTransport) {
  const frames: Uint8Array[] = [];
  const target = transport as unknown as { exchange: (f: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
  const orig = target.exchange.bind(transport);
  vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array, timeoutMs?: number) => {
    frames.push(new Uint8Array(f));
    return orig(f, timeoutMs);
  });
  return frames;
}

function spyWriteAttempts(transport: GenericMockTransport): number[][] {
  const attempts: number[][] = [];
  const client = transport as unknown as {
    request: (payload: number[], timeoutMs?: number) => Promise<Uint8Array>;
    write: (payload: number[]) => Promise<Uint8Array>;
  };
  const origRequest = client.request.bind(transport);
  const origWrite = client.write.bind(transport);
  vi.spyOn(client, 'request').mockImplementation((payload: number[], timeoutMs?: number) => {
    if (isWriteCommand(payload)) attempts.push([...payload]);
    return origRequest(payload, timeoutMs);
  });
  vi.spyOn(client, 'write').mockImplementation((payload: number[]) => {
    if (isWriteCommand(payload)) attempts.push([...payload]);
    return origWrite(payload);
  });
  return attempts;
}

function withReplyOverride(
  transport: GenericMockTransport,
  override: (req: readonly number[]) => number[] | null | undefined,
): void {
  const host = transport as unknown as {
    spec: { overrideReply?: (req: readonly number[]) => number[] | null | undefined };
  };
  const prev = host.spec.overrideReply;
  host.spec = {
    ...host.spec,
    overrideReply: (req) => {
      const res = override(req);
      return res !== undefined ? res : prev?.(req);
    },
  };
}

function assertAllReadOnly(frames: Uint8Array[]): void {
  for (const f of frames) {
    checkFrame(Array.from(f), { readOnly: true, rows: 'generic' });
  }
}

async function connectGeneric(name: GenericMockName) {
  const device = useDeviceStore();
  await device.connectGenericMock(name, { latencyMs: 0 });
  expect(device.status, `connectGeneric(${name}) error=${device.error}`).toBe('connected');
  expect(device.support).toBe('generic');
  const transport = device.transport as GenericMockTransport;
  const frames = spyExchange(transport);
  return { device, transport, frames };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  clearTuningSnapshots();
  setLocale('vi');
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 1000 } }]); }
    unobserve() {}
    disconnect() {}
  });
});

afterEach(async () => {
  useLiveStore().stop();
  while (mounted.length) mounted.pop()!.unmount();
  await useDeviceStore().disconnect({ flush: false }).catch(() => undefined);
  await flushPromises();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('S3 UI: zero write commands across every generic page (kills M6)', () => {
  it('disables write controls and sends 0 write frames when interacting with every page on g60', async () => {
    const { device, transport, frames } = await connectGeneric('g60');
    const writeAttempts = spyWriteAttempts(transport);
    const router = makeRouter();
    const sync = useSyncStore();

    const mountWithRouter = async (comp: any, path: string) => {
      await router.push(path);
      await router.isReady();
      const w = mount(comp, { global: { plugins: [router, pinia] }, attachTo: document.body });
      mounted.push(w);
      await flushPromises();
      return w;
    };

    // 1. Travel tab: select first key so editor controls render, verify all write controls disabled
    useSelectionStore().select(0, 'replace');
    const perfW = await mountWithRouter(RouterView, '/performance?tab=travel');
    await vi.waitFor(() => expect(usePerformanceStore().loading).toBe(false), { timeout: 10000, interval: 5 });
    await flushPromises();
    const presets = perfW.findAll('.preset');
    expect(presets.length).toBeGreaterThan(0);
    for (const btn of presets) {
      expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    }
    const modeRadios = perfW.findAll('[role="radiogroup"] button[role="radio"]');
    expect(modeRadios.length).toBeGreaterThan(0);
    // Click every enabled button on TravelTab and flush sync
    for (const btn of perfW.findAll('button')) {
      if (!(btn.element as HTMLButtonElement).disabled) await btn.trigger('click');
    }
    await sync.flush();
    await flushPromises();
    perfW.unmount();
    mounted.pop();

    // 2. KeymapPage: select a key, verify fieldset, quick buttons and restore-default button are disabled
    useSelectionStore().select(0, 'replace');
    const kmW = await mountWithRouter(KeymapPage, '/keymap');
    await vi.waitFor(() => expect(useKeymapStore().loading).toBe(false), { timeout: 10000, interval: 5 });
    await flushPromises();
    const kmFieldset = kmW.find('fieldset.km-fieldset');
    expect(kmFieldset.exists()).toBe(true);
    expect((kmFieldset.element as HTMLFieldSetElement).disabled).toBe(true);
    const kmQuickBtns = kmW.findAll('fieldset.km-fieldset .km-quick button');
    expect(kmQuickBtns).toHaveLength(2);
    for (const btn of kmQuickBtns) {
      expect((btn.element as HTMLButtonElement).disabled).toBe(true);
    }
    const kmRestoreBtn = kmW.find('button.kaside__restore');
    expect(kmRestoreBtn.exists()).toBe(true);
    expect((kmRestoreBtn.element as HTMLButtonElement).disabled).toBe(true);
    for (const btn of kmW.findAll('button')) {
      if (!(btn.element as HTMLButtonElement).matches(':disabled')) await btn.trigger('click');
    }
    await sync.flush();
    await flushPromises();
    kmW.unmount();
    mounted.pop();

    // 3. LightingPage: verify all effect/palette/custom controls disabled
    const ltW = await mountWithRouter(LightingPage, '/lighting');
    await vi.waitFor(() => expect(useLightingStore().loading).toBe(false), { timeout: 10000, interval: 5 });
    await flushPromises();
    for (const btn of ltW.findAll('.effect-btn, .palette-swatch')) {
      expect((btn.element as HTMLButtonElement).matches(':disabled')).toBe(true);
    }
    for (const btn of ltW.findAll('button')) {
      if (!(btn.element as HTMLButtonElement).matches(':disabled')) await btn.trigger('click');
    }
    await sync.flush();
    await flushPromises();
    ltW.unmount();
    mounted.pop();

    // 4. ProfilesPage & ProfileSelect: all profile switch triggers disabled
    const profW = await mountWithRouter(ProfilesPage, '/profiles');
    await flushPromises();
    for (const btn of profW.findAll('button')) {
      if (btn.text().includes(t('pf.use'))) expect((btn.element as HTMLButtonElement).disabled).toBe(true);
      if (!(btn.element as HTMLButtonElement).disabled) await btn.trigger('click');
    }
    const psW = mount(ProfileSelect, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(psW);
    await flushPromises();
    expect((psW.find('button.ps__trigger').element as HTMLButtonElement).disabled).toBe(true);
    await psW.find('button.ps__trigger').trigger('click');
    await sync.flush();
    await flushPromises();
    profW.unmount();
    psW.unmount();
    mounted.splice(-2);

    // 5. SettingsPage: all device controls inside [data-setting] cards disabled; click any not disabled
    const setW = await mountWithRouter(SettingsPage, '/settings');
    await vi.waitFor(() => expect(useSettingsStore().loading).toBe(false), { timeout: 10000, interval: 5 });
    await flushPromises();
    const settingControls = setW.findAll('[data-setting] button[role="radio"], [data-setting] button[role="switch"]');
    expect(settingControls.length).toBeGreaterThan(0);
    for (const seg of settingControls) {
      expect((seg.element as HTMLButtonElement).disabled).toBe(true);
    }
    for (const btn of setW.findAll('[data-setting] button')) {
      if (!(btn.element as HTMLButtonElement).disabled) await btn.trigger('click');
    }
    await sync.flush();
    await flushPromises();
    setW.unmount();
    mounted.pop();

    // 6. OverviewPage, MacroPage, FirmwarePage
    const ovW = await mountWithRouter(OverviewPage, '/overview');
    const macW = await mountWithRouter(MacroPage, '/macro');
    const fwW = await mountWithRouter(FirmwarePage, '/firmware');
    await flushPromises();
    await sync.flush();
    await flushPromises();
    ovW.unmount();
    macW.unmount();
    fwW.unmount();
    mounted.splice(-3);

    expect(device.support).toBe('generic');
    expect(writeAttempts).toEqual([]);
    expect(frames.length).toBeGreaterThan(0);
    assertAllReadOnly(frames);
  });
});

describe('S9 Per-page rules (DESIGN MKB §9.2, §7, §8, §11)', () => {
  it('Overview & DeviceCard: displayName, features text (and "không trả lời"), no Calibration tile/shortcut, no demo picker', async () => {
    const { device } = await connectGeneric('g60');
    const router = makeRouter();
    await router.push('/overview');
    await router.isReady();

    const dc = mount(DeviceCard, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(dc);
    expect(dc.find('.dc__name').text()).toBe('Mock 60');
    expect(dc.find('[data-testid="device-card-generic-sub"]').text()).toBe(
      t('mkb.name.cardSub', { board: device.info!.boardIdHex.toUpperCase(), fw: device.info!.firmware }),
    );
    expect(dc.find('.seg').exists()).toBe(false);

    const ov = mount(OverviewPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(ov);
    await vi.waitFor(() => {
      expect(usePerformanceStore().loading).toBe(false);
      expect(useSettingsStore().loading).toBe(false);
    }, { timeout: 10000, interval: 5 });
    await flushPromises();

    expect(ov.find('.ovh__name').text()).toBe('Mock 60');
    expect(ov.find('[data-ov="calibration"]').exists()).toBe(false);
    expect(ov.find('.ovchk').exists()).toBe(false);
    expect(ov.find('[data-ov="features"]').exists()).toBe(true);
    expect(ov.find('[data-ov="features"]').text()).not.toContain(t('mkb.common.noAnswer'));
    expect(ov.find('a[href="/calibration"]').exists()).toBe(false);
    expect(ov.find('.kb').attributes('aria-label')).toBe(t('keyboard.label', { model: 'Mock 60' }));

    // When unknown.features is true, features line shows "không trả lời"
    device.unknown = { ...device.unknown, features: true };
    device.features = null;
    await flushPromises();
    expect(ov.find('[data-ov="features"]').text()).toContain(t('mkb.common.noAnswer'));
  });

  it('KeyboardView: shows unknown-size dashed cue + overlap warning on godd, and empty message on 0-key layout', async () => {
    const { device } = await connectGeneric('godd');
    const kb = mount(KeyboardView, {
      props: { keys: device.keys, legend: device.legend },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    mounted.push(kb);
    await flushPromises();

    // godd has unknown ratio codes 7, 8, 12 and row-2 overlap
    expect(kb.find('[data-testid="kb-overlap"]').text()).toBe(t('mkb.layout.overlap'));
    const flagged = kb.findAll('.cap--flag');
    expect(flagged.length).toBeGreaterThanOrEqual(3);
    const titles = kb.findAll('.kb__key').map((el) => el.attributes('title') ?? '');
    expect(titles.some((s) => s.includes(t('mkb.layout.unknownSize', { code: 7 })))).toBe(true);
    expect(titles.some((s) => s.includes(t('mkb.layout.unknownSize', { code: 8 })))).toBe(true);
    expect(titles.some((s) => s.includes(t('mkb.layout.unknownSize', { code: 12 })))).toBe(true);

    // 0-key layout shows mkb.layout.empty without crashing
    const emptyKb = mount(KeyboardView, {
      props: { keys: [], legend: () => '' },
      global: { plugins: [pinia] },
      attachTo: document.body,
    });
    mounted.push(emptyKb);
    expect(emptyKb.find('[data-testid="kb-empty"]').text()).toBe(t('mkb.layout.empty'));
  });

  it('Travel: g75 uses 3.5 mm range; gmiss hides fineStep and shows precision "không rõ"; godd shows 4.5 mm key', async () => {
    const router = makeRouter();

    // g75: 3.5 mm max travel, 0.001 precision
    await connectGeneric('g75');
    useSelectionStore().select(0, 'replace');
    await router.push('/performance?tab=travel');
    await router.isReady();
    const w75 = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w75);
    await vi.waitFor(() => {
      expect(usePerformanceStore().loading).toBe(false);
      expect(Object.keys(usePerformanceStore().values).length).toBeGreaterThan(0);
    }, { timeout: 10000, interval: 5 });
    await flushPromises();
    expect(w75.text()).toContain('3.5 mm');
    expect(w75.find('[data-testid="travel-precision-unknown"]').exists()).toBe(false);
    w75.unmount();
    mounted.pop();

    // gmiss: rtPrecision 0 / unknown -> no "Bước 0.001 mm" switch, shows "không rõ", 3 decimals
    await connectGeneric('gmiss');
    useSelectionStore().select(0, 'replace');
    const wMiss = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(wMiss);
    await vi.waitFor(() => {
      expect(usePerformanceStore().loading).toBe(false);
      expect(Object.keys(usePerformanceStore().values).length).toBeGreaterThan(0);
    }, { timeout: 10000, interval: 5 });
    await flushPromises();
    expect(wMiss.text()).not.toContain(t('perf.fineStep'));
    expect(wMiss.find('[data-testid="travel-precision-unknown"]').text()).toContain(t('mkb.common.unknown'));
    wMiss.unmount();
    mounted.pop();

    // godd: key 0 has axisRangeMax 4500 (4.5 mm)
    await connectGeneric('godd');
    useSelectionStore().select(0, 'replace');
    const wOdd = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(wOdd);
    await vi.waitFor(() => {
      expect(usePerformanceStore().loading).toBe(false);
      expect(Object.keys(usePerformanceStore().values).length).toBeGreaterThan(0);
    }, { timeout: 10000, interval: 5 });
    await flushPromises();
    expect(wOdd.text()).toContain('4.5 mm');
  });

  it('Switch: hides picker/catalog (even on gspoof board 0030000D, kills M18) and shows read-only switch summary', async () => {
    const router = makeRouter();
    await connectGeneric('g75');
    await router.push('/performance?tab=switch');
    await router.isReady();
    const w75 = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w75);
    await vi.waitFor(() => {
      expect(usePerformanceStore().loading).toBe(false);
      expect(w75.find('[data-testid="switch-generic-readonly"]').exists()).toBe(true);
    }, { timeout: 10000, interval: 10 });
    await flushPromises();

    expect(usePerformanceStore().catalog).toBeNull();
    expect(w75.find('.sw-picker').exists()).toBe(false);
    const ro = w75.find('[data-testid="switch-generic-readonly"]');
    expect(ro.text()).toContain('ID 0x3001');
    expect(ro.text()).toContain('3.50 mm');
    expect(ro.text()).toContain('20000');
    expect(ro.text()).toContain(t('mkb.switch.catalogAe64Only'));
    w75.unmount();
    mounted.pop();

    // gspoof reports AE64 Max board 0030000D — catalog must STILL be null (DESIGN §3.4 / §11)
    await connectGeneric('gspoof');
    expect(usePerformanceStore().catalog).toBeNull();
  });

  it('Advanced: read-only list only (no add/edit/delete), undecodable record shows "không rõ"', async () => {
    const router = makeRouter();
    await connectGeneric('g60');
    await router.push('/performance?tab=advanced');
    await router.isReady();
    const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    const adv = useAdvancedStore();
    await vi.waitFor(() => {
      expect(adv.loading).toBe(false);
      expect(w.find('.cols--single').exists()).toBe(true);
    }, { timeout: 10000, interval: 10 });
    // Inject an undecodable 06 01 record (type 'UNKNOWN') into shallowRef records
    adv.records = { ...adv.records, 0: { row: 1, col: 0, type: 'UNKNOWN', mode: 99, raw: new Array<number>(64).fill(0) } };
    await flushPromises();

    expect(w.find('.types').exists()).toBe(false);
    expect(w.find('.add').exists()).toBe(false);
    const item = w.find('.item');
    expect(item.exists()).toBe(true);
    expect(item.text()).toContain(t('mkb.common.unknown'));
    expect(item.findAll('button:not(:disabled)')).toHaveLength(0);
    expect(item.find('.item__del').exists()).toBe(false);
  });

  it('Calibration: absent from Performance tabs and redirects /calibration and /performance?tab=calibration to travel', async () => {
    await connectGeneric('g60');
    localStorage.setItem('ae64.perfTab', 'calibration');
    const router = makeRouter();

    await router.push('/calibration');
    expect(router.currentRoute.value.path).toBe('/performance');
    expect(router.currentRoute.value.query.tab).toBe('travel');

    await router.push('/performance?tab=calibration');
    expect(router.currentRoute.value.path).toBe('/performance');
    expect(router.currentRoute.value.query.tab).toBe('travel');

    await router.push('/performance');
    await router.isReady();
    expect(router.currentRoute.value.query.tab).toBe('travel');

    const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await flushPromises();
    expect(w.findAll('[role="tab"]').map((el) => el.attributes('data-id'))).not.toContain('calibration');
  });

  it('Profiles: disabled on generic; godd (count 6) and gmiss (no 02 03 01) show "không rõ"', async () => {
    const router = makeRouter();
    for (const mockName of ['godd', 'gmiss'] as const) {
      await connectGeneric(mockName);
      await router.push('/profiles');

      const ps = mount(ProfileSelect, { global: { plugins: [router, pinia] }, attachTo: document.body });
      mounted.push(ps);
      expect((ps.find('button.ps__trigger').element as HTMLButtonElement).disabled).toBe(true);
      expect(ps.text()).toContain(t('mkb.common.unknown'));

      const pp = mount(ProfilesPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
      mounted.push(pp);
      await flushPromises();
      expect(pp.find('[data-testid="profiles-unknown"]').exists()).toBe(true);
      expect(pp.find('[data-testid="profiles-unknown"]').text()).toContain(t('mkb.common.unknown'));

      ps.unmount();
      pp.unmount();
      mounted.splice(-2);
    }
  });

  it('Macro: shows only unsupported message and sends 0 07 xx / 02 0E frames', async () => {
    const { frames } = await connectGeneric('g60');
    const router = makeRouter();
    await router.push('/macro');
    await router.isReady();
    const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await flushPromises();

    expect(w.find('[data-testid="macro-unsupported"]').text()).toBe(t('mkb.page.macroUnsupported'));
    expect(frames.filter((f) => f[0] === 0x07 || (f[0] === 0x02 && f[1] === 0x0e))).toHaveLength(0);
  });

  it('Settings: shows answered device settings read-only, hides unanswered ones, shows unknown rtPrecision on gmiss', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.status).toBe('connected');
    const transport = device.transport as GenericMockTransport;
    const timeoutsBefore = transport.stats.timeouts;
    // Settings read order: 02 04 01 (ok) -> 02 05 00 (ok) -> 02 05 01 (miss 1) -> 02 0D 01 (miss 2)
    // -> 02 10 01 (ok, resets counter) -> 02 0E 00 (ok) -> 02 08 00 (ok). At most 2 real timeouts in a row.
    withReplyOverride(transport, ([f, op, a]) => {
      if ((f === 0x02 && op === 0x05 && a === 0x01) || (f === 0x02 && op === 0x0d && a === 0x01)) return null;
      return undefined;
    });

    const router = makeRouter();
    await router.push('/settings');
    await router.isReady();
    const w = mount(SettingsPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await advanceUntil(() => !useSettingsStore().loading && useSettingsStore().loaded);
    await flushPromises();

    const s = useSettingsStore();
    expect(device.status).toBe('connected');
    expect(transport.stats.timeouts - timeoutsBefore).toBe(2);
    expect(s.answered.systemMode).toBe(true);
    expect(s.answered.pollingRate).toBe(false);
    expect(s.answered.rgbSleep).toBe(false);
    expect(s.answered.shakeOptimization).toBe(true);
    expect(w.text()).toContain(t('settings.systemMode'));
    expect(w.text()).not.toContain(t('settings.pollingRate'));
    expect(w.text()).not.toContain(t('settings.rgbSleep'));
    expect(w.text()).toContain(t('settings.shakeOptimization'));
    expect(w.text()).toContain(t('mkb.common.unknown'));
  });

  it('Settings: 3 consecutive real timeouts while loading closes generic connection with error.protocolUnknown and sends no frame after the 3rd miss', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    // Use gmiss (no periodic profile poll) so only Settings reads run on the wire.
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.status).toBe('connected');
    const expectedName = device.displayName;
    const transport = device.transport as GenericMockTransport;
    const frames = spyExchange(transport);
    // Drop 02 05 00, 02 05 01, 02 0D 01 (3 consecutive reads after 02 04 01).
    withReplyOverride(transport, ([f, op, a]) => {
      if (
        (f === 0x02 && op === 0x05 && (a === 0x00 || a === 0x01))
        || (f === 0x02 && op === 0x0d && a === 0x01)
      ) return null;
      return undefined;
    });

    const router = makeRouter();
    await router.push('/settings');
    await router.isReady();
    const w = mount(SettingsPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await advanceUntil(() => !useSettingsStore().loading);
    await flushPromises();

    expect(device.status).toBe('error');
    expect(device.connected).toBe(false);
    expect(device.error).toBe(t('error.protocolUnknown', { name: expectedName }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(frames.map((f) => [f[0], f[1], f[2]])).toEqual([
      [0x02, 0x04, 0x01],
      [0x02, 0x05, 0x00],
      [0x02, 0x05, 0x01],
      [0x02, 0x0d, 0x01],
    ]);

    // Confirm no stray frames are sent after the 3rd miss.
    await vi.advanceTimersByTimeAsync(5000);
    await flushPromises();
    expect(frames).toHaveLength(4);
  });

  it('Key test & rows on g75: polls row 0 and sees row-0 key press (kills M20); keymap loads all 6 rows; selection selects 81 keys', async () => {
    const { device, transport, frames } = await connectGeneric('g75');
    expect(device.keys).toHaveLength(81);
    expect(device.rows).toEqual([0, 1, 2, 3, 4, 5]);

    // selection.all() covers all 81 keys
    const sel = useSelectionStore();
    sel.all();
    expect(sel.count).toBe(81);

    // Keymap loads layers 0..3 over all 6 rows including row 0
    await useKeymapStore().load(true);
    const kmRow0 = frames.filter((f) => f[0] === 0x03 && f[1] === 0x01 && f[3] === 0);
    expect(kmRow0.length).toBeGreaterThanOrEqual(4);

    // Live travel polls row 0 via device.rows (even without focusing row 0) and detects simulatePressPos(0, 0, 2.0)
    const row0Key = device.keys.find((k) => k.row === 0 && k.col === 0)!;
    const row1Key = device.keys.find((k) => k.row === 1 && k.col === 0)!;
    transport.simulatePressPos(0, 0, 2.0);
    const live = useLiveStore();
    live.focusId = row1Key.id;
    live.allKeys = true;
    live.start();
    await vi.waitFor(() => {
      expect(live.data.travel[row0Key.id]).toBeGreaterThan(1.5);
    }, { timeout: 2500, interval: 10 });
    live.stop();
    expect(frames.some((f) => f[0] === 0x04 && f[1] === 0x03 && f[3] === 0)).toBe(true);
  });

  it('Key test on g75: records travel and pressed state for key 80 beyond the 64-key buffer', async () => {
    const { device, transport } = await connectGeneric('g75');
    expect(device.keys).toHaveLength(81);
    const lastKey = device.keys[device.keys.length - 1];
    expect(lastKey.id).toBe(80);

    transport.simulatePressPos(lastKey.row, lastKey.col, 2.0);
    const live = useLiveStore();
    live.focusId = device.keys[0].id;
    live.allKeys = true;
    live.start();
    await vi.waitFor(() => {
      expect(live.data.travel[lastKey.id]).toBeGreaterThan(1.5);
      expect(live.data.status[lastKey.id]).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 10 });
    live.stop();

    expect(live.data.peakMm[lastKey.id]).toBeGreaterThan(1.5);
    expect(live.data.pressedIds.has(lastKey.id)).toBe(true);
  });

  it('Gamepad: hidden in Sidebar even on gspoofPro (0030000A), /gamepad redirects to /overview, 0 10 xx frames', async () => {
    const { frames } = await connectGeneric('gspoofPro');
    const router = makeRouter();
    await router.push('/overview');

    const sb = mount(Sidebar, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(sb);
    expect(sb.find('a[href="/gamepad"]').exists()).toBe(false);

    await router.push('/gamepad');
    expect(router.currentRoute.value.path).toBe('/overview');

    const gp = useGamepadStore();
    await gp.firmwareKind();
    await gp.load(true);
    const gpW = mount(GamepadPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(gpW);
    await flushPromises();

    expect(frames.filter((f) => f[0] === 0x10)).toHaveLength(0);
  });

  it('Firmware: shows only AE64-only message, 0 manifest fetch, deviceBoard null on gspoof (kills M18); disconnected unchanged', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not fetch on generic'));
    await connectGeneric('gspoof');
    const fw = useFirmwareStore();
    expect(fw.deviceBoard).toBeNull();

    const router = makeRouter();
    await router.push('/firmware');
    await router.isReady();
    const w = mount(FirmwarePage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await flushPromises();
    expect(w.find('[data-testid="firmware-generic-only"]').text()).toBe(t('mkb.page.firmwareOnlyAe64'));
    expect(w.findAll('button')).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();

    w.unmount();
    mounted.pop();

    // Disconnected: normal AE64 firmware page renders (not the generic-only message)
    await useDeviceStore().disconnect({ flush: false });
    const wDisc = mount(FirmwarePage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(wDisc);
    await flushPromises();
    expect(wDisc.find('[data-testid="firmware-generic-only"]').exists()).toBe(false);
  });

  it('Names & S7/S9: gspoof never shows "AE64" as keyboard name (kills M26); gmiss shows VID:PID fallback; gtwin enters view mode', async () => {
    const router = makeRouter();
    await router.push('/overview');

    // gspoof (board 0030000D, productName 'Mock Spoof')
    await connectGeneric('gspoof');
    const dcSpoof = mount(DeviceCard, { global: { plugins: [router, pinia] }, attachTo: document.body });
    const ciSpoof = mount(CopyInfo, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(dcSpoof, ciSpoof);
    expect(dcSpoof.find('.dc__name').text()).toBe('Mock Spoof');
    expect(dcSpoof.find('.dc__name').text()).not.toContain('AE64');

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await ciSpoof.find('button').trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('Keyboard: Mock Spoof');
    expect(copied).not.toContain('Keyboard: AE64');
    dcSpoof.unmount();
    ciSpoof.unmount();
    mounted.splice(-2);

    // gmiss (productName '', VID 1CA6, PID F004)
    await connectGeneric('gmiss');
    const dcMiss = mount(DeviceCard, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(dcMiss);
    expect(dcMiss.find('.dc__name').text()).toBe('Bàn phím 1CA6:F004');
    setLocale('en');
    await flushPromises();
    expect(dcMiss.find('.dc__name').text()).toBe('Keyboard 1CA6:F004');
    dcMiss.unmount();
    mounted.pop();

    // gtwin (S7: AE64 type=2/subType=3 on non-AE64 PID) -> generic view mode
    setLocale('vi');
    const { device: dTwin } = await connectGeneric('gtwin');
    expect(dTwin.support).toBe('generic');
    expect(dTwin.boardAllowed).toBe(false);
    expect(dTwin.displayName).toBe('Mock Twin');
  });

  it('AE64 unchanged: max still exposes Calibration, Switch catalog, Lighting ring and writable controls', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(device.support).toBe('ae64');
    expect(device.boardAllowed).toBe(true);
    expect(usePerformanceStore().catalog).not.toBeNull();
    expect(useFirmwareStore().deviceBoard).toBe(0x0030000d);

    const router = makeRouter();
    await router.push('/performance?tab=calibration');
    expect(router.currentRoute.value.query.tab).toBe('calibration');

    const lt = mount(LightingPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(lt);
    await vi.waitFor(() => expect(useLightingStore().loading).toBe(false), { timeout: 10000, interval: 5 });
    await flushPromises();
    expect(lt.find('.ring').exists()).toBe(true);
    expect(lt.find('.wb__live').exists()).toBe(true);
    useLightingStore().stopLivePolling();
    // Ensure we don't accidentally ignore non-profile frames
    expect(isProfilePoll(new Uint8Array([0x02, 0x03, 0x01]))).toBe(true);
  });
});
