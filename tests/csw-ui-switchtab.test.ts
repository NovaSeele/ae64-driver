// CSW step 4a UI tests: SwitchTab check strip (Test 12, M15), generic stale (Test 17),
// verify line (Test 19), keycap photo/travel toggle + sublabelAria (Test 20, M27, M28, M29).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { GENERIC_UID, SWITCH_CAPS_KEY } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { buildExport, parseImport } from '../src/data/appSettings';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { isProfilePoll } from './helpers/profilePoll';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;
const S = PHYSICAL_KEYS.find((k) => k.name === 'S')!;
const D = PHYSICAL_KEYS.find((k) => k.name === 'D')!;
const Q = PHYSICAL_KEYS.find((k) => k.name === 'Q')!;

let w: VueWrapper | null = null;
const body = () => document.body;
function spyExchange(mock: MockTransport) {
  const seen = vi.fn();
  const target = mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> };
  const orig = target.exchange.bind(mock);
  // Ignore the periodic active-profile read (02 03 01) sent by watchKeyboardProfile every PROFILE_POLL_MS.
  const spy = vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array) => {
    if (!isProfilePoll(f)) seen(f);
    return orig(f);
  });
  seen.mockRestore = () => spy.mockRestore();
  return seen;
}

async function setupTab(tab: 'switch' | 'travel' = 'switch') {
  const device = useDeviceStore();
  if (!device.connected) await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const m = await mountPerformance(tab);
  w = m.w;
  await flushPromises();
  return { device, mock, perf, router: m.router };
}

describe('SwitchTab check strip (DESIGN §19 Test 12 & Test 17 staleGeneric, kills M15)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    locale.value = 'vi';
    useToast().items.value = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows stale, staleGeneric, lostRowNamed, lostRow + lostWhy; "Áp dụng lại" opens picker with 0 HID (kills M15); "Quên" removes assignments with 0 HID; "Chọn switch" opens default tab', async () => {
    const { mock, perf } = await setupTab('switch');
    // Assign W to a user switch, A to generic, S to WS Flux
    const mine = {
      uid: 'u-aaaabbbbcccc' as const,
      name: 'My Custom',
      maker: 'Lab',
      travelUm: 3500,
      rangeUm: 3500,
      coefficient: 19850,
      curve: { kind: 'travel' as const },
      color: '',
      note: '',
    };
    perf.saveCustomSwitch(mine);
    const flux = READY_SWITCHES.find((r) => r.name === 'WS Flux')!;
    perf.applySwitch({ kind: 'custom', custom: { uid: mine.uid, name: mine.name, maker: mine.maker, rangeUm: 3500, coefficient: 19850 } }, [W.id], 'notReplaced');
    perf.applySwitch({ kind: 'custom', custom: perf.genericEntry }, [A.id], 'notReplaced');
    perf.applySwitch({ kind: 'custom', custom: { uid: flux.uid, name: flux.name, maker: flux.maker, rangeUm: flux.rangeUm, coefficient: flux.coefficient, curveFrom: { id: flux.curveFrom.id } } }, [S.id], 'notReplaced');
    await useSyncStore().flush();

    // Edit user switch (W becomes stale) and change generic declaration (A becomes staleGeneric) — 0 HID!
    const exBefore = spyExchange(mock);
    perf.saveCustomSwitch({ ...mine, travelUm: 3600, rangeUm: 3600, coefficient: 18750 });
    perf.setGenericRange(3800);
    expect(exBefore).not.toHaveBeenCalled();
    exBefore.mockRestore();

    // Wipe S (assigned lost) and D (unassigned lost) via mock axis
    const m = mock as unknown as { axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }> };
    for (const k of [S, D]) {
      const a = m.axis.get(`${k.row}:${k.col}`)!;
      a.axisV2Id = 0; a.axisRangeMax = 0; a.axisCoefficient = 0; a.calibrate = 0;
    }
    await perf.load(true);
    await flushPromises();

    const strip = w!.find('.swp__chk');
    expect(strip.exists()).toBe(true);
    expect(strip.attributes('role')).toBe('region');
    expect(strip.attributes('aria-label')).toBe(t('sw.checkTitle'));
    const txt = strip.text();
    expect(txt).toContain(t('sw.staleRow', { name: 'My Custom', keys: 'W', n: 1, um: 3500, coef: 19850, wum: 3600, wcoef: 18750 }));
    expect(txt).toContain(t('sw.staleGeneric', { name: t('csw.genericLabel', { mm: '3.80' }), keys: 'A', n: 1, um: 3400, wum: 3800 }));
    expect(txt).toContain(t('sw.lostRowNamed', { name: 'WS Flux', keys: 'S', n: 1 }));
    expect(txt).toContain(t('sw.lostRow', { n: 1, keys: 'D' }));
    expect(txt).toContain(t('sw.lostWhy'));

    // Click "Áp dụng lại" on My Custom -> selects W, opens picker on custom tab with My Custom chosen, 0 HID (kills M15)
    const ex = spyExchange(mock);
    const rows = w!.findAll('.swp__chk-row');
    await rows[0].findAll('button')[0].trigger('click');
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(useSelectionStore().ids).toEqual([W.id]);
    expect(body().querySelector('[role="dialog"]')).not.toBeNull();
    expect(body().querySelector('[role="tab"][data-id="custom"]')?.getAttribute('aria-selected')).toBe('true');
    expect(body().querySelector(`.sw-opt[data-uid="${mine.uid}"]`)?.getAttribute('aria-checked')).toBe('true');

    // Close dialog, click "Quên" on generic row -> 0 HID, assignment gone, toast sw.forgot
    body().querySelector<HTMLButtonElement>('.dlg__close')!.click();
    await flushPromises();
    await w!.findAll('.swp__chk-row')[1].findAll('button')[1].trigger('click');
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.assignments[A.id]).toBeUndefined();
    expect(useToast().items.value.at(-1)?.text).toBe(t('sw.forgot', { name: t('csw.generic'), n: 1 }));

    // Click "Chọn switch" on unassigned lost row -> selects D, opens picker on default tab, 0 HID
    const lostRow = w!.find('.swp__chk-row--lost');
    await lostRow.find('button').trigger('click');
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(useSelectionStore().ids).toEqual([D.id]);
    expect(body().querySelector('[role="dialog"]')).not.toBeNull();
    expect(body().querySelector('[role="tab"][data-id="custom"]')?.getAttribute('aria-selected')).toBe('false');
  });

  it('wipeAxis() marks all keys lost with unassigned lostRow and lost swatch; mixed stale keys show sw.staleRowMixed', async () => {
    const { mock, perf } = await setupTab('switch');
    // Assign W and A to the same user switch, then give W and A two different on-board triples -> sw.staleRowMixed
    const mine = {
      uid: 'u-222233334444' as const,
      name: 'Mixed Custom',
      maker: 'Lab',
      travelUm: 3500,
      rangeUm: 3500,
      coefficient: 19850,
      curve: { kind: 'travel' as const },
      color: '',
      note: '',
    };
    perf.saveCustomSwitch(mine);
    perf.applySwitch({ kind: 'custom', custom: { uid: mine.uid, name: mine.name, maker: mine.maker, rangeUm: 3500, coefficient: 19850 } }, [W.id, A.id], 'notReplaced');
    await useSyncStore().flush();
    const m = mock as unknown as { axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }> };
    m.axis.get(`${W.row}:${W.col}`)!.axisRangeMax = 3400;
    m.axis.get(`${A.row}:${A.col}`)!.axisRangeMax = 3600;
    await perf.load(true);
    await flushPromises();
    expect(w!.find('.swp__chk').text()).toContain(t('sw.staleRowMixed', { name: 'Mixed Custom', keys: 'W, A' }));

    mock.wipeAxis();
    await perf.load(true);
    await flushPromises();
    expect(w!.find('.swp__chk-row--lost').exists()).toBe(true);
    expect(w!.find('.swp__row .swatch--lost').exists()).toBe(true);
    expect(w!.find('.swp__row .swp__name').text()).toBe(t('csw.lost'));
  });
});

describe('SwitchTab post-Apply verify line (DESIGN §19 Test 19 Switch-tab part)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    locale.value = 'vi';
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows verifyAfterCal when watched keys need calibration, verifyLine when calibrated, verifyDone when passed, routes to ?tab=test&check=1, and ✕ clears with 0 HID', async () => {
    const { mock, perf, router } = await setupTab('switch');
    expect(w!.find('.swp__verify').exists()).toBe(false);

    const flux = READY_SWITCHES.find((r) => r.name === 'WS Flux')!;
    const choice = { kind: 'custom' as const, custom: { uid: flux.uid, name: flux.name, maker: flux.maker, rangeUm: flux.rangeUm, coefficient: flux.coefficient, curveFrom: { id: flux.curveFrom.id } } };

    // Apply answering "Đã thay" -> watched key W is in needsCal -> sw.verifyAfterCal
    perf.applySwitch(choice, [W.id], 'replaced');
    await useSyncStore().flush();
    await flushPromises();
    expect(w!.find('.swp__verify').exists()).toBe(true);
    expect(w!.find('.swp__verify').text()).toContain(t('sw.verifyAfterCal', { name: 'WS Flux', keys: 'W', mm: '3.50' }));

    // Clear recal mark -> sw.verifyLine (no "Sau khi hiệu chuẩn")
    perf.clearRecal([W.id]);
    await flushPromises();
    expect(w!.find('.swp__verify').text()).toContain(t('sw.verifyLine', { name: 'WS Flux', keys: 'W', mm: '3.50' }));

    // Clicking "Kiểm tra ngay" navigates to /performance?tab=test&check=1 with 0 switch writes
    // (TestTab consumes ?check=1 on mount and strips it from the URL, so verify both the push args and final tab).
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const pushSpy = vi.spyOn(router, 'push');
    await w!.find('.swp__verify .swp__recal-go').trigger('click');
    await flushPromises();
    expect(pushSpy).toHaveBeenCalledWith({ path: '/performance', query: { tab: 'test', check: '1' } });
    expect(router.currentRoute.value.path).toBe('/performance');
    expect(router.currentRoute.value.query.tab).toBe('test');
    expect(setPerf).not.toHaveBeenCalled();

    // Return to Switch tab, mark verify passed -> sw.verifyDone
    await router.push({ path: '/performance', query: { tab: 'switch' } });
    await flushPromises();
    perf.markVerifyPassed();
    await flushPromises();
    expect(w!.find('.swp__verify').classes()).toContain('swp__verify--ok');
    expect(w!.find('.swp__verify').text()).toContain(t('sw.verifyDone', { name: 'WS Flux', keys: 'W' }));

    // Clicking ✕ calls clearVerify with 0 HID
    const ex = spyExchange(mock);
    await w!.find('.swp__verify-x').trigger('click');
    await flushPromises();
    expect(perf.verify).toBeNull();
    expect(w!.find('.swp__verify').exists()).toBe(false);
    expect(ex).not.toHaveBeenCalled();
  });
});

describe('SwitchTab keycap photo/travel view & sublabelAria (DESIGN §19 Test 20; kills M27, M28, M29)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    locale.value = 'vi';
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to photo with travel in aria-label (kills M29), switches to travel with no photo (kills M28) and persists across reload & backup with 0 HID', async () => {
    const { mock, perf } = await setupTab('switch');
    const ex = spyExchange(mock);

    // Map card subtitle says shared by all 4 profiles (no profile name)
    expect(w!.find('.swp .card__sub').text()).toBe(t('swp.mapSub'));

    // Default view = photo: swatches present, no visual sublabel, legend = swp.shows
    const segBtns = () => w!.findAll('.card__actions .seg__opt');
    expect(segBtns().map((b) => b.text())).toEqual([t('swp.capPhoto'), t('swp.capTravel')]);
    expect(segBtns()[0].attributes('aria-checked')).toBe('true');
    expect(w!.findAll('.cap__extra .swatch')).toHaveLength(64);
    expect(w!.findAll('.cap__sub')).toHaveLength(0);
    expect(w!.find('.sb__shows .sr-only').text()).toBe(`${t('sel.shows')}: ${t('swp.shows')}`);
    // Both photo and travel legends measured in SelectionBar's ghost (showsAlt)
    expect(w!.findAll('.sb__ghost > .sb__shows')).toHaveLength(2);

    // Accessible name carries travel in photo view (kills M29)!
    const wCap = () => w!.find(`[data-key="${W.id}"]`);
    expect(wCap().attributes('aria-label')).toBe('W · 3.31 mm · UR Ice HE-Ex');

    // Switch to "Hành trình" view: 0 HID, no .cap__extra photo (kills M28), 2-decimal R in .cap__sub, legend = swp.showsTravel
    await segBtns()[1].trigger('click');
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(localStorage.getItem(SWITCH_CAPS_KEY)).toBe('travel');
    expect(w!.findAll('.cap__extra')).toHaveLength(0);
    expect(wCap().find('.cap__sub').text()).toBe('3.31');
    expect(wCap().attributes('aria-label')).toBe('W · 3.31 mm · UR Ice HE-Ex');
    expect(w!.find('.sb__shows .sr-only').text()).toBe(`${t('sel.shows')}: ${t('swp.showsTravel')}`);

    // Lost key shows '—' visually and csw.lost in aria-label (never '—')
    const m = mock as unknown as { axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }> };
    const qAxis = m.axis.get(`${Q.row}:${Q.col}`)!;
    qAxis.axisV2Id = 0; qAxis.axisRangeMax = 0; qAxis.axisCoefficient = 0; qAxis.calibrate = 0;
    await perf.load(true);
    await flushPromises();
    const qCap = w!.find(`[data-key="${Q.id}"]`);
    expect(qCap.find('.cap__sub').text()).toBe('—');
    expect(qCap.attributes('aria-label')).toContain(t('csw.lost'));
    expect(qCap.attributes('aria-label')).not.toContain('—');

    // Generic switch keycap shows "4.00" in travel view and "{legend} · 4.00 mm · Switch chung" in BOTH views
    perf.setGenericRange(4000);
    perf.applySwitch({ kind: 'custom', custom: perf.genericEntry }, [A.id], 'notReplaced');
    await useSyncStore().flush();
    await flushPromises();
    expect(perf.assignments[A.id]).toBe(GENERIC_UID);
    const aCap = () => w!.find(`[data-key="${A.id}"]`);
    expect(aCap().find('.cap__sub').text()).toBe('4.00');
    expect(aCap().attributes('aria-label')).toBe(`A · 4.00 mm · ${t('csw.generic')}`);
    // Back to photo view: photos return and accessible name keeps travel
    await w!.findAll('.card__actions .seg__opt')[0].trigger('click');
    await flushPromises();
    expect(w!.findAll('.cap__extra .swatch')).toHaveLength(64);
    expect(aCap().attributes('aria-label')).toBe(`A · 4.00 mm · ${t('csw.generic')}`);
    // Back to travel view for backup & reload assertions below
    await w!.findAll('.card__actions .seg__opt')[1].trigger('click');
    await flushPromises();

    // Settings backup round-trip preserves switchCaps
    const exp = buildExport();
    const parsed = parseImport(exp.json, exp.json.length);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.data[SWITCH_CAPS_KEY]).toBe('travel');

    // Reload (unmount & remount) restores 'travel' view
    w!.unmount();
    w = null;
    await setupTab('switch');
    expect(w!.findAll('.card__actions .seg__opt')[1].attributes('aria-checked')).toBe('true');
    expect(w!.findAll('.cap__extra')).toHaveLength(0);
    expect(w!.find(`[data-key="${W.id}"] .cap__sub`).text()).toBe('3.31');
  });

  it('Travel tab keycaps and accessible names do NOT show switch travel (kills M27)', async () => {
    localStorage.setItem(SWITCH_CAPS_KEY, 'travel');
    await setupTab('travel');
    const wCap = w!.find(`[data-key="${W.id}"]`);
    // Travel tab shows actuation (default 1.50 or 2.00 mm), NOT the 3.31 mm switch travel!
    expect(wCap.find('.cap__sub').text()).not.toBe('3.31');
    expect(wCap.attributes('aria-label')).not.toContain('3.31 mm');
    expect(wCap.attributes('aria-label')).not.toContain('UR Ice HE-Ex');
  });
});
