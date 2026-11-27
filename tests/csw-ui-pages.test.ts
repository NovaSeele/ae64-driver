// CSW step 4b UI tests: DESIGN §19 tests 11 (CalibrationView + needsCal across Travel/Overview), 12 (Overview check card),
// 13 (Switch tab scope 'board' + Travel tab deep-values note & fix), and 19 (HealthCheck watch + TestTab ?check=1 + 0 HID).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import CalibrationView from '../src/components/calibration/CalibrationView.vue';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance, PhysicalKey } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import { readyToCustomLike, userToCustomLike } from '../src/data/customSwitch';
import type { CustomLike, CustomSwitch } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { installPerfTabGuard, routes } from '../src/router';
import { mountAt, mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useCalibrationStore } from '../src/stores/calibration';
import { useLiveStore } from '../src/stores/live';
import { useSelectionStore } from '../src/stores/selection';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { useToast } from '../src/components/ui/toast';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

vi.mock('../src/components/live/demoPress', async (orig) => ({ ...(await orig<object>()), attachDemoPress: () => () => {} }));
vi.setConfig({ testTimeout: 30000 });

const key = (name: string): PhysicalKey => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const A = key('A');
const S = key('S');
const D = key('D');
const Q = key('Q');
const E = key('E');

const FLUX: CustomLike = readyToCustomLike(READY_SWITCHES.find((s) => s.uid === 'r-wuque-ws-flux-clacky')!); // 3500 / 17536
const USER_SW: CustomSwitch = {
  uid: 'u-0000000000aa',
  name: 'My Custom',
  maker: 'Lab',
  travelUm: 3500,
  rangeUm: 3500,
  coefficient: 19000,
  curve: { kind: 'manual' },
  color: '#4f8ef7',
  note: '',
};

const until = async (cond: () => boolean, ms = 10_000, what?: () => string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout${what ? `: ${what()}` : ''}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
const settle = async () => { for (let i = 0; i < 6; i++) await flushPromises(); };
const spyExchange = (mock: MockTransport) => vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<Uint8Array> }, 'exchange');
const cmdOf = (f: Uint8Array) => `${f[0].toString(16).padStart(2, '0')} ${f[1].toString(16).padStart(2, '0')}`;
// Ignore the periodic active-profile read (02 03 01) sent by watchKeyboardProfile every PROFILE_POLL_MS.
const cmdsOf = (spy: ReturnType<typeof spyExchange>) => spy.mock.calls
  .filter(([f]) => !(f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x01))
  .map(([f]) => cmdOf(f));

function setProfilePerfBytes(mock: MockTransport, profile: number, k: PhysicalKey, byteOffset: number, valueUm: number) {
  const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[] };
  const rec = m.profiles[profile].perf.get(`${k.row}:${k.col}`)!;
  rec[byteOffset] = valueUm & 0xff;
  rec[byteOffset + 1] = valueUm >>> 8;
}
function setAxis(mock: MockTransport, k: PhysicalKey, ax: { axisV2Id?: number; axisRangeMax?: number; axisCoefficient?: number; calibrate?: number }) {
  const m = mock as unknown as { axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }> };
  const cur = m.axis.get(`${k.row}:${k.col}`)!;
  if (ax.axisV2Id !== undefined) cur.axisV2Id = ax.axisV2Id;
  if (ax.axisRangeMax !== undefined) cur.axisRangeMax = ax.axisRangeMax;
  if (ax.axisCoefficient !== undefined) cur.axisCoefficient = ax.axisCoefficient;
  if (ax.calibrate !== undefined) cur.calibrate = ax.calibrate;
}

let pinia: Pinia;
const mounted: VueWrapper[] = [];

function cleanupWrappers() {
  while (mounted.length) mounted.pop()!.unmount();
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  clearTuningSnapshots();
  localStorage.clear();
  locale.value = 'vi';
  useToast().items.value = [];
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  const cal = useCalibrationStore(pinia);
  if (cal.phase === 'running') await cal.cancel();
  useLiveStore(pinia).stop();
  cleanupWrappers();
  await until(() => cal.phase === 'idle' && !usePerformanceStore(pinia).loading);
  await useDeviceStore(pinia).disconnect({ flush: false });
  document.body.innerHTML = '';
  localStorage.clear();
  locale.value = 'vi';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ===================================================================================================
// DESIGN §19 Test 11: Calibration tab shows app-listed keys red with chipSwitch; needsCal everywhere
// ===================================================================================================
describe('CSW Test 11 (UI): CalibrationView recal list + chipSwitch, and needsCal on Travel & Overview', () => {
  async function openCal() {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/cal', component: CalibrationView },
        { path: '/performance', component: { template: '<i />' } },
      ],
    });
    await router.push('/cal');
    const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    const cal = useCalibrationStore(pinia);
    await until(() => cal.loaded && usePerformanceStore(pinia).loadedProfile !== null);
    await flushPromises();
    return { w, router, cal };
  }

  const bodyButton = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === label).pop();

  it('app-listed key glows red, counts in CalStats/progress/warn, gets chipSwitch (vs chipUncal for board status 0), and clears only on save (0 extra HID)', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore(pinia);
    const sync = useSyncStore(pinia);
    await perf.load();

    // Mark W and A via swapped custom apply (board calibrate stays 1); set S board calibrate = 0 (not in recalKeys)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'replaced');
    await sync.flush();
    setAxis(mock, S, { calibrate: 0 });
    await perf.load(true);
    expect(perf.recalKeys).toEqual([W.id, A.id].sort((a, b) => a - b));
    expect(perf.uncalibrated).toEqual([S.id]);

    const ex = spyExchange(mock);
    const { w, cal } = await openCal();
    // Only calibration's own 04 03 reads (no writes)
    expect(cmdsOf(ex).filter((c) => c !== '04 03')).toEqual([]);

    // Board reports status 1 for W & A, 0 for S
    expect(cal.frame.status[W.id]).toBe(1);
    expect(cal.frame.status[A.id]).toBe(1);
    expect(cal.frame.status[S.id]).toBe(0);

    // W, A and S all glow red (--danger) and read "Chưa hiệu chuẩn"
    for (const k of [W, A, S]) {
      const cap = w.find(`[data-key="${k.id}"]`);
      expect(cap.find('.cap').classes(), k.name).toContain('cap--glow');
      expect(cap.find('.cap').attributes('style'), k.name).toContain('--led: var(--danger)');
      expect(cap.attributes('aria-label'), k.name).toContain(t('calibration.legendNone'));
    }
    expect(w.find(`[data-key="${D.id}"] .cap`).attributes('style')).toContain('--led: var(--info)');

    // CalStats, top warning and progress all go through shown(id) → 3 uncalibrated, 61/64 calibrated
    const statValues = () => w.findAll('.cs dd').map((d) => (d.classes('is-none') ? d.find('[aria-hidden="true"]').text() : d.text()));
    expect(statValues()).toEqual(['—', '—', '—', '3']);
    expect(w.find('.ses__state .warn').text()).toBe(t('calibration.uncalibrated', { n: 3 }));
    expect(w.find('.ses__stats .sub').text()).toBe(t('calibration.progress', { n: 61 }));

    // Chips: W & A get chipSwitch; S gets chipUncal
    const chips = w.findAll('.chip--uncal');
    expect(chips).toHaveLength(3);
    const chipFor = (id: number) => w.find(`.chip--uncal[data-rid="${id}"]`);
    expect(chipFor(W.id).text()).toBe(t('calibration.chipSwitch', { key: 'W' }));
    expect(chipFor(A.id).text()).toBe(t('calibration.chipSwitch', { key: 'A' }));
    expect(chipFor(S.id).text()).toBe(t('calibration.chipUncal', { key: 'S' }));
    expect(chipFor(W.id).attributes('aria-label')).toBe(`${t('calibration.chipSwitch', { key: 'W' })}. ${t('calibration.markHint')}`);

    // English locale check
    locale.value = 'en';
    await nextTick();
    expect(chipFor(W.id).text()).toBe(t('calibration.chipSwitch', { key: 'W' }));
    expect(chipFor(W.id).text()).toContain('switch swapped, needs recalibrating');
    locale.value = 'vi';
    await nextTick();

    // Start calibration session: press W to bottom (status 2 → green, uncal drops 3 → 2), then Cancel → W stays red with chipSwitch
    const actionBtn = (label: string) => w.findAll('.ses__top .actions button').find((b) => b.text() === label)!;
    await actionBtn(t('calibration.start')).trigger('click');
    await flushPromises();
    bodyButton(t('calibration.start'))!.click();
    await until(() => cal.phase === 'running');
    await flushPromises();

    mock.simulatePress(W.id, 3.5);
    await until(() => cal.frame.status[W.id] === 2);
    mock.simulatePress(W.id, 0);
    await until(() => cal.frame.route[W.id] === 0);
    await flushPromises();

    expect(w.find(`[data-key="${W.id}"] .cap`).attributes('style')).toContain('--led: var(--ok)');
    expect(statValues()[3]).toBe('2'); // A and S still uncal

    // Finish asks because A (recal list) and S (board 0) are still uncalibrated (shownUncalCount === 2)
    await actionBtn(t('calibration.finish')).trigger('click');
    await flushPromises();
    expect(document.body.querySelector('.dlg .dlg-body')?.textContent).toBe(
      t('calibration.finishBody', { list: t('calibration.finishUncal', { n: 2 }) }),
    );
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();

    // Cancel clears nothing: W returns to red with chipSwitch
    await actionBtn(t('calibration.cancel')).trigger('click');
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(perf.recalKeys).toEqual([W.id, A.id].sort((a, b) => a - b));
    expect(w.find(`[data-key="${W.id}"] .cap`).attributes('style')).toContain('--led: var(--danger)');
    expect(chipFor(W.id).text()).toBe(t('calibration.chipSwitch', { key: 'W' }));

    // New session: calibrate W and Save anyway → W clears from recalKeys (turns green from lastSaved); A stays red with chipSwitch
    await actionBtn(t('calibration.start')).trigger('click');
    await flushPromises();
    bodyButton(t('calibration.start'))!.click();
    await until(() => cal.phase === 'running');
    await flushPromises();

    mock.simulatePress(W.id, 3.5);
    await until(() => cal.frame.status[W.id] === 2);
    mock.simulatePress(W.id, 0);
    await until(() => cal.frame.route[W.id] === 0);
    await flushPromises();

    await actionBtn(t('calibration.finish')).trigger('click');
    await flushPromises();
    bodyButton(t('calibration.saveAnyway'))!.click();
    await until(() => cal.phase === 'idle' && !perf.loading);
    await flushPromises();

    expect(perf.recalKeys).toEqual([A.id]);
    expect(w.find(`[data-key="${W.id}"] .cap`).attributes('style')).toContain('--led: var(--ok)');
    expect(w.find(`.chip--uncal[data-rid="${W.id}"]`).exists()).toBe(false);
    expect(chipFor(A.id).text()).toBe(t('calibration.chipSwitch', { key: 'A' }));
    expect(statValues()[3]).toBe('2'); // A + S
  });

  it('Travel tab and Overview page use perf.needsCal (app-listed key with board calibrate 1 is flagged and counted)', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const perf = usePerformanceStore(pinia);
    const sync = useSyncStore(pinia);
    await perf.load();

    // Apply custom switch with 'replaced': board calibrate stays 1, perf.uncalibrated is [], perf.needsCal is [W, A]
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'replaced');
    await sync.flush();
    expect(perf.uncalibrated).toEqual([]);
    expect(perf.needsCal).toEqual([W.id, A.id].sort((a, b) => a - b));

    // Travel tab flags W & A and shows the flag legend item across metrics
    const tr = await mountPerformance('travel', {}, { plugins: [pinia] });
    mounted.push(tr.w);
    await until(() => !perf.loading);
    await settle();

    expect(tr.w.find(`[data-key="${W.id}"] .cap`).classes()).toContain('cap--flag');
    expect(tr.w.find(`[data-key="${W.id}"]`).attributes('aria-label')).toContain(t('kb.uncalibrated'));
    expect(tr.w.find(`[data-key="${D.id}"] .cap`).classes()).not.toContain('cap--flag');
    expect(tr.w.find('.sb__shows .sr-only').text()).toContain(t('sel.flagged'));
    // Switch to RT metric chip: flag legend still present
    const chips = tr.w.findAll('.chips[role="radiogroup"] .chip');
    await chips[1].trigger('click');
    await nextTick();
    expect(tr.w.find('.sb__shows .sr-only').text()).toContain(t('sel.flagged'));

    cleanupWrappers();

    // Overview page Calibration tile and keyboard flags use perf.needsCal
    const router = createRouter({ history: createMemoryHistory(), routes });
    installPerfTabGuard(router);
    await router.push('/overview');
    const ov = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(ov);
    await until(() => !perf.loading && !useSettingsStore(pinia).loading);
    await settle();

    const calTile = ov.findAll('.ovs > li')[3];
    expect(calTile.find('.ovs__state--warn').exists()).toBe(true);
    expect(calTile.find('.ovs__value').text()).toBe(t('ov.calMissing', { n: 2 }));
    expect(calTile.find('.ovs__sub').text()).toBe(t('ov.calMissingSub', { keys: 'W, A' }));
    expect(ov.find(`.ovk [data-key="${W.id}"] .cap`).classes()).toContain('cap--flag');
    expect(ov.find(`.ovk [data-key="${D.id}"] .cap`).classes()).not.toContain('cap--flag');
    expect(ov.find('.ovk__shows .sr-only').text()).toContain(t('sel.flagged'));
  });
});

// ===================================================================================================
// DESIGN §19 Test 12: Overview check card shows on stale/lost keys and links to /performance?tab=switch
// ===================================================================================================
describe('CSW Test 12 (UI): Overview switch check card (read-only, 0 write HID)', () => {
  async function mountOverview() {
    const router = createRouter({ history: createMemoryHistory(), routes });
    installPerfTabGuard(router);
    await router.push('/overview');
    const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await until(() => !usePerformanceStore(pinia).loading && !useSettingsStore(pinia).loading);
    await settle();
    return { w, router };
  }

  it('hidden when clean; shows stale, lost, or both above the tiles; links to /performance?tab=switch; 0 write HID', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore(pinia);
    const sync = useSyncStore(pinia);
    await perf.load();

    const { w, router } = await mountOverview();
    expect(w.find('.ovchk').exists()).toBe(false);

    // Create & apply user switch on W and A, then edit its R/c (0 HID) → 2 stale keys
    perf.saveCustomSwitch(USER_SW);
    perf.applySwitch({ kind: 'custom', custom: userToCustomLike(USER_SW) }, [W.id, A.id], 'notReplaced');
    await sync.flush();

    const ex = spyExchange(mock);
    perf.saveCustomSwitch({ ...USER_SW, rangeUm: 3600, travelUm: 3600, coefficient: 18750 });
    await nextTick();
    expect(cmdsOf(ex)).toEqual([]); // 0 HID!

    // Card sits right before ul.ovs (above the tiles)
    const card = w.find('.ovchk');
    expect(card.exists()).toBe(true);
    expect(card.element.nextElementSibling).toBe(w.find('ul.ovs').element);
    expect(card.find('.ovchk__title').text()).toBe(t('ov.swCheck', { n: 2 }));
    expect(card.find('.ovchk__line--lost').exists()).toBe(false);
    expect(card.text()).toContain(t('ov.swCheckStale', { n: 2 }));

    // Also make S lost (R = 0): both lines show, total = 3 (1 lost + 2 stale)
    setAxis(mock, S, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 });
    await perf.load(true);
    await nextTick();
    expect(w.find('.ovchk__title').text()).toBe(t('ov.swCheck', { n: 3 }));
    expect(w.find('.ovchk__line--lost').text()).toBe(t('ov.swCheckLost', { n: 1 }));
    expect(w.findAll('.ovchk__line')[1].text()).toBe(t('ov.swCheckStale', { n: 2 }));

    // English singular/plural check
    locale.value = 'en';
    await nextTick();
    expect(w.find('.ovchk__title').text()).toBe('Switch values to check on 3 keys');
    expect(w.find('.ovchk__line--lost').text()).toBe('1 key has lost its switch values and does not work.');
    expect(w.findAll('.ovchk__line')[1].text()).toBe('2 keys no longer match the custom switch named on them.');
    locale.value = 'vi';
    await nextTick();

    // Clicking button navigates to /performance?tab=switch with 0 write HID
    ex.mockClear();
    const go = w.find('.ovchk__go');
    expect(go.text()).toBe(t('ov.swCheckGo'));
    expect(go.attributes('href')).toBe('/performance?tab=switch');
    await go.trigger('click');
    await settle();
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=switch');
    expect(cmdsOf(ex).filter((c) => c === '04 02' || c === '02 02')).toEqual([]);

    // wipeAxis() → 64 lost keys, 0 stale → only lost line shows
    cleanupWrappers();
    mock.wipeAxis();
    await perf.load(true);
    const { w: w2 } = await mountOverview();
    expect(w2.find('.ovchk__title').text()).toBe(t('ov.swCheck', { n: 64 }));
    expect(w2.find('.ovchk__line--lost').text()).toBe(t('ov.swCheckLost', { n: 64 }));
    expect(w2.findAll('.ovchk__line')).toHaveLength(1);
  });
});

// ===================================================================================================
// DESIGN §19 Test 13: Switch tab scope is 'board'; Travel tab deep-values note & fix
// ===================================================================================================
describe('CSW Test 13 (UI): Switch tab scope = board, and Travel tab deep-values note & fix', () => {
  it('Switch tab scope chip reads "Áp dụng cho cả bàn phím" with keyboard icon (no profile number)', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const { w } = await mountAt('/performance?tab=switch', { plugins: [pinia] });
    mounted.push(w);
    await until(() => !usePerformanceStore(pinia).loading);
    await settle();

    const scope = w.find('.ph__scope');
    expect(scope.text()).toBe(t('ptab.scopeBoard'));
    expect(scope.find('.ph__n').exists()).toBe(false);
    expect(scope.find('svg').exists()).toBe(true);
    const swTab = w.find('[role="tab"][data-id="switch"]');
    const descId = swTab.attributes('aria-describedby')!;
    expect(document.getElementById(descId)!.textContent).toBe(`${t('swp.tabSwitchSub')}. ${t('ptab.scopeBoard')}.`);

    // English check
    locale.value = 'en';
    await nextTick();
    expect(scope.text()).toBe('Applies to the whole keyboard');
  });

  it('Travel tab deep-values note shows on deep profile (0 HID until pressed), truncates > 8 keys with "+n", and fix writes only deep 04 02 frames', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore(pinia);
    const sync = useSyncStore(pinia);
    const history = useHistoryStore(pinia);
    await perf.load();

    // Put 4.0 mm switch (White 4416, R 4015) on W & A; seed deep values in profile 1 (FPS):
    // W: actuation 3.90 mm; A: pressDeadStroke 3.60 mm
    const white = findSwitch(perf.catalog, 4416)!;
    perf.applySwitch({ kind: 'catalog', entry: white }, [W.id, A.id]);
    await sync.flush();
    setProfilePerfBytes(mock, 1, W, 1, 3900);
    setProfilePerfBytes(mock, 1, W, 3, 3900);
    setProfilePerfBytes(mock, 1, A, 11, 3600);

    // Switch W & A to generic 3.40 mm on profile 0, then open profile 1 in Travel tab
    perf.applySwitch({ kind: 'custom', custom: perf.genericEntry }, [W.id, A.id], 'notReplaced');
    await sync.flush();
    await device.switchProfile(1);

    const ex = spyExchange(mock);
    const { w } = await mountPerformance('travel', {}, { plugins: [pinia] });
    mounted.push(w);
    await until(() => !perf.loading);
    await settle();

    // Nothing written yet on load (0 × 04 02)
    expect(cmdsOf(ex).filter((c) => c === '04 02')).toEqual([]);
    const note = w.find('.deep-note');
    expect(note.exists()).toBe(true);
    expect(note.find('.deep-note__text').text()).toBe(t('perf.deepNote', { n: 2, keys: 'W, A' }));
    const btn = note.find('button');
    expect(btn.text()).toBe(t('perf.deepFix'));
    expect(btn.classes()).toEqual(expect.arrayContaining(['btn', 'btn--secondary', 'btn--sm']));

    // Read-only board disables the button and writes nothing
    device.boardAllowed = false;
    await nextTick();
    expect(btn.attributes('disabled')).toBeDefined();
    await btn.trigger('click');
    await sync.flush();
    expect(cmdsOf(ex).filter((c) => c === '04 02')).toEqual([]);
    device.boardAllowed = true;
    await nextTick();

    // Press the fix button → writes ONLY 2 × 04 02 (+ 1 commit + 2 × 04 01), lowers W to 3.40 and A deadzone to 1.00
    ex.mockClear();
    await btn.trigger('click');
    await sync.flush();
    await nextTick();

    const cmds = cmdsOf(ex);
    expect(cmds.filter((c) => c === '04 02')).toHaveLength(2);
    expect(cmds.filter((c) => c === '02 02')).toHaveLength(1);
    expect(cmds.filter((c) => c === '04 01')).toHaveLength(2);
    expect(w.find('.deep-note').exists()).toBe(false);
    expect(perf.values[W.id].normalPress).toBe(3.4);
    expect(perf.values[A.id].pressDeadStroke).toBe(1.0);
    expect(perf.values[W.id].axisRangeMax).toBe(3400);
    expect(history.canUndo).toBe(true);

    // > 8 deep keys: first 8 legends in board order then "+2"
    const ten = PHYSICAL_KEYS.slice(0, 10);
    const next: Record<number, Performance> = { ...perf.values };
    for (const k of ten) next[k.id] = { ...next[k.id], normalPress: 3.9, normalRelease: 3.9 };
    perf.values = next;
    await nextTick();
    const first8 = ten.slice(0, 8).map((k) => device.legend(k)).join(', ');
    expect(w.find('.deep-note__text').text()).toBe(t('perf.deepNote', { n: 10, keys: `${first8} +2` }));
  });
});

// ===================================================================================================
// DESIGN §19 Test 19 (UI): HealthCheck watch cells, passed once, ✕ clear, ?check=1 allKeys, 0 HID
// ===================================================================================================
describe('CSW Test 19 (UI): HealthCheck watch cells, passed, live-region announcements, ?check=1 allKeys, 0 HID', () => {
  let frames: FrameRequestCallback[] = [];
  let clock = 1000;

  function route(live: ReturnType<typeof useLiveStore>, k: PhysicalKey, mm: number, now: number) {
    const vals = new Array(16).fill(0);
    vals[k.col] = Math.round(mm * 1000);
    live.ingest('route', k.row, vals, now);
  }
  function status(live: ReturnType<typeof useLiveStore>, k: PhysicalKey, st: number, now: number) {
    const vals = new Array(16).fill(0);
    vals[k.col] = st;
    live.ingest('keyStatus', k.row, vals, now);
  }
  async function tickFrame(stepMs = 100) {
    clock += stepMs;
    frames.find((f) => f.name === 'frame')!(clock);
    await flushPromises();
  }

  beforeEach(() => {
    frames = [];
    clock = 1000;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });

  it('watch cells follow none/full/short/stuck from mocked peaks, announce changes, flip passed once, survive restart, clear on ✕, and send 0 extra HID', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore(pinia);
    const sync = useSyncStore(pinia);
    await perf.load();

    // Verified custom Apply on W, A, S (out-of-order input [S, W, A] → watch cells stay in board order: W, A, S)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [S.id, W.id, A.id], 'notReplaced');
    await sync.flush();
    expect(perf.verify).toMatchObject({ name: FLUX.name, rangeUm: 3500, passed: false });

    const ex = spyExchange(mock);
    const { w } = await mountPerformance('test', {}, { plugins: [pinia] });
    mounted.push(w);
    await flushPromises();
    const live = useLiveStore(pinia);
    live.stop(); // drive peaks deterministically via live.ingest

    await tickFrame();

    // Watch block renders between .hc__stats and .hc__empty/.hc__attn
    const watchEl = w.find('.hc__watch');
    expect(watchEl.exists()).toBe(true);
    expect(watchEl.element.previousElementSibling).toBe(w.find('.hc__stats').element);
    expect(watchEl.find('.hc__watch-title').text()).toBe(t('live.watchTitle', { name: FLUX.name, mm: '3.50' }));

    // Cells are <ul><li> (not buttons), in board order W, A, S
    const cells = () => w.findAll('.hc__watch-cells > li');
    expect(cells()).toHaveLength(3);
    expect(w.findAll('.hc__watch-cells button')).toHaveLength(0);
    expect(cells().map((c) => c.find('b').text())).toEqual(['W', 'A', 'S']);
    expect(cells().map((c) => c.classes())).toEqual([
      ['hc__watch-cell', 'is-none'],
      ['hc__watch-cell', 'is-none'],
      ['hc__watch-cell', 'is-none'],
    ]);
    expect(cells()[0].find('.sr-only').text()).toBe(t('live.watchCellNone', { key: 'W' }));
    // Nothing under cells while unpressed
    expect(watchEl.find('.hc__ok').exists()).toBe(false);
    expect(watchEl.find('.hc__note--warn').exists()).toBe(false);
    expect(perf.verify?.passed).toBe(false);

    // 1. W full (3.48 mm of 3.50 = 99.4%), A short (3.12 mm of 3.50 = 89.1%), S none → watchBad
    route(live, W, 3.48, 10);
    route(live, W, 0, 20);
    route(live, A, 3.12, 30);
    route(live, A, 0, 40);
    await tickFrame(1600); // triggers card refresh + live-region announcement

    expect(cells()[0].classes()).toContain('is-full');
    expect(cells()[0].find('span[aria-hidden="true"]').text()).toBe('3.48 mm');
    expect(cells()[0].find('.sr-only').text()).toBe(t('live.watchCellFull', { key: 'W', mm: '3.48' }));
    expect(cells()[1].classes()).toContain('is-short');
    expect(cells()[1].find('span[aria-hidden="true"]').text()).toBe('3.12 / 3.50 mm');
    expect(cells()[1].find('.sr-only').text()).toBe(t('live.watchCellShort', { key: 'A', mm: '3.12', range: '3.50' }));
    expect(cells()[2].classes()).toContain('is-none');
    expect(watchEl.find('.hc__note--warn').text()).toBe(t('live.watchBad'));
    expect(watchEl.find('.hc__ok').exists()).toBe(false);
    expect(perf.verify?.passed).toBe(false);
    // Live region announced W full and A short
    expect(w.find('.hc__live').text()).toContain(t('live.watchCellFull', { key: 'W', mm: '3.48' }));
    expect(w.find('.hc__live').text()).toContain(t('live.watchCellShort', { key: 'A', mm: '3.12', range: '3.50' }));

    // 2. A and S reach full (3.50 mm), but W becomes stuck at 0.42 mm → stuck shows restOffMm (0.42), watchBad, passed stays false
    route(live, A, 3.50, 100);
    route(live, A, 0, 110);
    route(live, S, 3.50, 120);
    route(live, S, 0, 130);
    route(live, W, 3.50, 200);
    status(live, W, 1, 201);
    status(live, W, 0, 202);
    route(live, W, 0.42, 210);
    route(live, W, 0.42, 1100); // > 800 ms stuck
    await tickFrame(1600);

    expect(cells()[0].classes()).toContain('is-stuck');
    expect(cells()[0].find('span[aria-hidden="true"]').text()).toBe(t('live.watchStuck', { mm: '0.42' }));
    expect(cells()[0].find('.sr-only').text()).toBe(t('live.watchCellStuck', { key: 'W', mm: '0.42' }));
    expect(cells()[1].classes()).toContain('is-full');
    expect(cells()[2].classes()).toContain('is-full');
    expect(watchEl.find('.hc__note--warn').text()).toBe(t('live.watchBad'));
    expect(perf.verify?.passed).toBe(false);

    // 3. W returns to 0 → all 3 full and none stuck → watchOk + perf.verify.passed turns true ONCE
    const markSpy = vi.spyOn(perf, 'markVerifyPassed');
    route(live, W, 0, 1200);
    await tickFrame(1600);

    expect(cells().every((c) => c.classes().includes('is-full'))).toBe(true);
    expect(watchEl.find('.hc__ok').text()).toBe(t('live.watchOk', { n: 3 }));
    expect(watchEl.find('.hc__note--warn').exists()).toBe(false);
    expect(perf.verify?.passed).toBe(true);
    expect(markSpy).toHaveBeenCalledTimes(1);
    expect(w.find('.hc__live').text()).toContain(t('live.watchOk', { n: 3 }));

    // 4. "Bắt đầu lại" restarts peaks, keeps the watch, and passed stays true (never turns back)
    await w.find('.hc .card__actions button').trigger('click');
    await tickFrame(1600);
    expect(w.find('.hc__watch').exists()).toBe(true);
    expect(cells().every((c) => c.classes().includes('is-none'))).toBe(true);
    expect(perf.verify?.passed).toBe(true);
    expect(markSpy).toHaveBeenCalledTimes(1);

    // 5. ✕ ("Bỏ theo dõi") clears perf.verify and hides the watch
    const closeBtn = w.find('.hc__watch-close');
    expect(closeBtn.attributes('aria-label')).toBe(t('live.watchClose'));
    await closeBtn.trigger('click');
    await nextTick();
    expect(perf.verify).toBeNull();
    expect(w.find('.hc__watch').exists()).toBe(false);

    // 0 HID beyond key check's own 04 03 reads
    expect(cmdsOf(ex).filter((c) => c !== '04 03')).toEqual([]);
  });

  it('?tab=test&check=1 turns live.allKeys back on even while a key is pinned, and renders unsafe custom switch names as text (no HTML)', async () => {
    const device = useDeviceStore(pinia);
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore(pinia);
    await perf.load();
    const live = useLiveStore(pinia);

    // Pin Q and turn allKeys off beforehand, plus set a watch with an HTML-like name
    useSelectionStore(pinia).select(Q.id);
    live.allKeys = false;
    const xssName = '<img src=x onerror=alert(1)>';
    perf.verify = {
      board: device.info!.serialHex,
      keys: [E.id],
      name: xssName,
      rangeUm: 3500,
      passed: false,
    };

    const ex = spyExchange(mock);
    const { w } = await mountPerformance('test', { check: '1' }, { plugins: [pinia] });
    mounted.push(w);
    await flushPromises();
    live.stop();

    // allKeys was forced on by ?check=1, so no partial-key warning even though Q is pinned
    expect(live.follow).toBe(false);
    expect(live.allKeys).toBe(true);
    expect(w.find('.hc__note--warn').exists()).toBe(false);

    // Custom name rendered as literal text, never HTML
    expect(w.find('.hc__watch-title').text()).toContain(xssName);
    expect(w.find('.hc__watch img').exists()).toBe(false);

    // Verify watch hidden if perf.verify belongs to another board
    perf.verify = { ...perf.verify!, board: 'ffffffffffffffffffffffff' };
    await nextTick();
    expect(w.find('.hc__watch').exists()).toBe(false);

    // 0 HID beyond 04 03 reads
    expect(cmdsOf(ex).filter((c) => c !== '04 03')).toEqual([]);
  });
});
