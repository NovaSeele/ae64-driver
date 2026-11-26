// DESIGN FST §10.2 M5 & M7, §10.6 tests 20, 21, 24 (step 3 subset) + mutants N8, N11:
// profileDiff & SwitchSim decimals display, NumberField describedby, low-value status lines (< 0.05 mm), and i18n.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { diffProfiles, topChanges } from '../src/data/profileDiff';
import { fmtMm } from '../src/data/keycapActuation';
import SwitchSim from '../src/components/live/SwitchSim.vue';
import NumberField from '../src/components/ui/NumberField.vue';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { vi as viDict, t } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';
import { setLocale } from '../src/i18n/locale';

const keyId = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!.id;
const Q = keyId('Q');
const W = keyId('W');

let w: VueWrapper | null = null;
const origRO = globalThis.ResizeObserver;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale('vi');
  setActivePinia(createPinia());
  if (!globalThis.ResizeObserver) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(async () => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  await useDeviceStore().disconnect();
  globalThis.ResizeObserver = origRO;
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLocale('vi');
});

describe('FST test 20: profileDiff 0.001 grouping and SwitchSim decimals display (M5, N11)', () => {
  it('profileDiff separates 0.001 and 0.002 into distinct groups and fmtMm formats 0.001 verbatim', () => {
    const base: Performance = {
      mode: 1, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3,
      pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500,
    };
    const a: Record<number, Performance> = { 0: base, 1: base, 2: base, 3: base };
    const b: Record<number, Performance> = {
      0: { ...base, rtFirstTouch: 0.001 },
      1: { ...base, rtFirstTouch: 0.001 },
      2: { ...base, rtFirstTouch: 0.002 },
      3: { ...base, rtFirstTouch: 0.002 },
    };
    const rows = diffProfiles(a, b, [0, 1, 2, 3]);
    expect(rows).toHaveLength(4);
    const groups = topChanges(rows, 5);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.b)).toEqual([0.001, 0.002]);
    expect(fmtMm(0.001, 3)).toBe('0.001');
  });

  it('SwitchSim shows "0.001" for a first actuation of 0.001 with decimals=3 (Max), and keeps 2 decimals with decimals=2 (Pro) (N11)', () => {
    const rtSettings = { mode: 1 as const, normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001, pressDeadStroke: 0.015, releaseDeadStroke: 0, range: 3.31 };

    // Max (decimals = 3)
    w = mount(SwitchSim, {
      props: { travel: 0, peak: 0, range: 3.31, decimals: 3, settings: rtSettings, resetAt: 0.025, reactuateAt: null, actuated: false, label: 'W' },
    });
    const maxTexts = w.findAll('.sim__marker text').map((el) => el.text());
    expect(maxTexts).toContain(`${t('live.mFirst')} 0.001`);
    expect(maxTexts).toContain(`${t('live.mReset')} 0.025`);
    expect(maxTexts).toContain(`${t('live.mDeadTop')} 0.015`);
    w.unmount();

    // Standard mode on Max
    w = mount(SwitchSim, {
      props: { travel: 0, peak: 0, range: 3.31, decimals: 3, settings: { ...rtSettings, mode: 0 }, resetAt: null, reactuateAt: null, actuated: false, label: 'W' },
    });
    expect(w.findAll('.sim__marker text').map((el) => el.text())).toContain(`${t('live.mActuation')} 0.001`);
    w.unmount();

    // Pro (decimals = 2): 2 decimals (e.g. 0.015 -> 0.02, 1.237 -> 1.24, 0.01 -> 0.01)
    w = mount(SwitchSim, {
      props: {
        travel: 0, peak: 0, range: 3.4, decimals: 2,
        settings: { ...rtSettings, rtFirstTouch: 1.237, pressDeadStroke: 0.01 },
        resetAt: null, reactuateAt: null, actuated: false, label: 'W',
      },
    });
    const proTexts = w.findAll('.sim__marker text').map((el) => el.text());
    expect(proTexts).toContain(`${t('live.mFirst')} 1.24`);
    expect(proTexts).toContain(`${t('live.mDeadTop')} 0.01`);
  });

  it('TestTab passes capDecimals(device.rtPrecision) to SwitchSim while measured readouts keep toFixed(2)', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load(true);
    perf.values = { ...perf.values, [W]: { ...perf.values[W], mode: 1, rtFirstTouch: 0.001, normalPress: 0.001 } };
    useSelectionStore().selectMany([W]);

    ({ w } = await mountPerformance('test', {}, { stubs: { KeyboardView: true, TravelGraph: true } }));
    await flushPromises();
    expect(w.findComponent(SwitchSim).props('decimals')).toBe(3);
    expect(w.findAll('.sim__marker text').map((el) => el.text())).toContain(`${t('live.mFirst')} 0.001`);
    // Measured readout hero stays 2 decimals ("0.00")
    expect(w.find('.readcard .hero .big').text()).toBe('0.00mm');

    // Pro (rtPrecision 0.01) -> decimals 2
    device.rtPrecision = 0.01;
    await flushPromises();
    expect(w.findComponent(SwitchSim).props('decimals')).toBe(2);
  });
});

describe('FST test 21: low-value status lines and aria-describedby (M7, N8)', () => {
  it('NumberField omits aria-describedby when absent and sets it when passed', async () => {
    w = mount(NumberField, { props: { modelValue: 1, min: 0.001, max: 3.31, label: 'Act' } });
    expect(w.find('input').element.hasAttribute('aria-describedby')).toBe(false);
    await w.setProps({ describedby: 'low-note-id' });
    expect(w.find('input').attributes('aria-describedby')).toBe('low-note-id');
    await w.setProps({ describedby: undefined });
    expect(w.find('input').element.hasAttribute('aria-describedby')).toBe(false);
  });

  it('Actuation and RT cards show lowAct / lowRt strictly below 0.05 mm, wire aria-describedby only while shown, and keep status wrappers rendered (N8)', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load(true);
    useSelectionStore().selectMany([W]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();

    const actCard = () => document.body.querySelector('.act')!.closest('.card')!;
    const rtCard = () => document.body.querySelector('.c-rt')!;
    const actInput = () => document.body.querySelector<HTMLInputElement>(`.act input[aria-label="${t('perf.actuation')}"]`)!;
    const actSlider = () => document.body.querySelector<HTMLElement>(`.act [role="slider"][aria-label="${t('perf.actuation')}"]`)!;
    const rtControls = () => [
      document.body.querySelector<HTMLInputElement>(`.c-rt input[aria-label="${t('perf.rtPress')}"]`)!,
      document.body.querySelector<HTMLElement>(`.c-rt [role="slider"][aria-label="${t('perf.rtPress')}"]`)!,
      document.body.querySelector<HTMLInputElement>(`.c-rt input[aria-label="${t('perf.rtRelease')}"]`)!,
      document.body.querySelector<HTMLElement>(`.c-rt [role="slider"][aria-label="${t('perf.rtRelease')}"]`)!,
    ];

    // Before crossing below 0.05: status wrappers ALREADY exist, empty, and no aria-describedby
    const actWrap = actCard().querySelector('[role="status"]');
    const rtWrap = rtCard().querySelector('[role="status"]');
    expect(actWrap).not.toBeNull();
    expect(rtWrap).not.toBeNull();
    expect(actWrap!.textContent?.trim()).toBe('');
    expect(rtWrap!.textContent?.trim()).toBe('');
    expect(actInput().hasAttribute('aria-describedby')).toBe(false);
    expect(actSlider().hasAttribute('aria-describedby')).toBe(false);
    for (const el of rtControls()) expect(el.hasAttribute('aria-describedby')).toBe(false);

    // Exactly 0.05 shows NOTHING (kills N8: <= 0.05)
    perf.values = {
      ...perf.values,
      [W]: { ...perf.values[W], rtFirstTouch: 0.05, normalPress: 0.05, rtPress: 0.05, rtRelease: 0.05 },
    };
    await flushPromises();
    expect(actWrap!.textContent?.trim()).toBe('');
    expect(rtWrap!.textContent?.trim()).toBe('');
    expect(actInput().hasAttribute('aria-describedby')).toBe(false);
    expect(actSlider().hasAttribute('aria-describedby')).toBe(false);
    for (const el of rtControls()) expect(el.hasAttribute('aria-describedby')).toBe(false);

    // Actuation 0.049 shows perf.lowAct and wires aria-describedby on actuation NumberField + TravelEditor slider
    perf.values = { ...perf.values, [W]: { ...perf.values[W], rtFirstTouch: 0.049, normalPress: 0.049 } };
    await flushPromises();
    const actNote = actWrap!.querySelector<HTMLElement>('.low-note')!;
    expect(actNote).not.toBeNull();
    expect(actNote.textContent).toBe(t('perf.lowAct'));
    expect(actNote.id).toBeTruthy();
    expect(actInput().getAttribute('aria-describedby')).toBe(actNote.id);
    expect(actSlider().getAttribute('aria-describedby')).toBe(actNote.id);

    // RT press 0.049 shows perf.lowRt and wires aria-describedby on all 4 RT controls
    perf.values = { ...perf.values, [W]: { ...perf.values[W], rtPress: 0.049, rtRelease: 0.3 } };
    await flushPromises();
    const rtNote = rtWrap!.querySelector<HTMLElement>('.low-note')!;
    expect(rtNote).not.toBeNull();
    expect(rtNote.textContent).toBe(t('perf.lowRt'));
    expect(rtNote.id).toBeTruthy();
    for (const el of rtControls()) expect(el.getAttribute('aria-describedby')).toBe(rtNote.id);

    // Mixed selection 0.001–1.0 shows perf.lowAct (low end of mixed range < 0.05)
    perf.values = {
      ...perf.values,
      [Q]: { ...perf.values[Q], rtFirstTouch: 1.0, normalPress: 1.0, rtPress: 0.3, rtRelease: 0.3 },
      [W]: { ...perf.values[W], rtFirstTouch: 0.001, normalPress: 0.001, rtPress: 0.3, rtRelease: 0.3 },
    };
    useSelectionStore().selectMany([Q, W]);
    await flushPromises();
    expect(actWrap!.querySelector('.low-note')?.textContent).toBe(t('perf.lowAct'));
    expect(rtWrap!.querySelector('.low-note')).toBeNull();
    for (const el of rtControls()) expect(el.hasAttribute('aria-describedby')).toBe(false);

    // Pro demo (rtPrecision 0.01): 0.04 shows lowAct, 0.05 hides it
    device.rtPrecision = 0.01;
    useSelectionStore().selectMany([W]);
    perf.values = { ...perf.values, [W]: { ...perf.values[W], rtFirstTouch: 0.04, normalPress: 0.04 } };
    await flushPromises();
    expect(actWrap!.querySelector('.low-note')?.textContent).toBe(t('perf.lowAct'));

    perf.values = { ...perf.values, [W]: { ...perf.values[W], rtFirstTouch: 0.05, normalPress: 0.05 } };
    await flushPromises();
    expect(actWrap!.querySelector('.low-note')).toBeNull();
    expect(actInput().hasAttribute('aria-describedby')).toBe(false);
    expect(actSlider().hasAttribute('aria-describedby')).toBe(false);
  });
});

describe('FST test 24: i18n keys of DESIGN §10.4 and perf.kept English plurals', () => {
  it('all five §10.4 keys exist in vi and en, and perf.kept pluralizes 1 key vs 2 keys in en', () => {
    expect(viDict['perf.lowAct']).toBe('Dưới 0.05 mm, phím có thể tự kích hoạt khi bàn rung hay chạm nhẹ.');
    expect(enDict['perf.lowAct']).toBe('Below 0.05 mm a key can fire from a light touch or a bump to the desk.');
    expect(viDict['perf.lowRt']).toBe('Dưới 0.05 mm, Rapid Trigger có thể tự nhấn / nhả vì rung nhẹ.');
    expect(enDict['perf.lowRt']).toBe('Below 0.05 mm Rapid Trigger can press and release on its own from small vibrations.');
    expect(viDict['perf.kept']).toBe('{field}: bàn phím lưu {got} mm thay vì {wanted} mm trên {n} phím. Có lẽ đó là mức nhỏ nhất nó nhận.');
    expect(enDict['perf.kept']).toBe('{field}: the keyboard stored {got} mm instead of {wanted} mm on {n|# key|# keys}. That is probably the lowest value it takes.');
    expect(viDict['perf.keptHide']).toBe('Ẩn thông báo');
    expect(enDict['perf.keptHide']).toBe('Hide this note');
    expect(viDict['diagnostics.vBelowMin']).toBe(
      'giá trị hành trình {field} = {value} ở phím {key} nhỏ hơn mức thấp nhất bàn phím này nhận ({min} mm)',
    );
    expect(enDict['diagnostics.vBelowMin']).toBe(
      'travel value {field} = {value} at key {key} is below the lowest value this keyboard takes ({min} mm)',
    );

    setLocale('en');
    expect(t('perf.kept', { field: 'Press sensitivity', got: '0.01', wanted: '0.001', n: 1 })).toBe(
      'Press sensitivity: the keyboard stored 0.01 mm instead of 0.001 mm on 1 key. That is probably the lowest value it takes.',
    );
    expect(t('perf.kept', { field: 'Press sensitivity', got: '0.01', wanted: '0.001', n: 2 })).toBe(
      'Press sensitivity: the keyboard stored 0.01 mm instead of 0.001 mm on 2 keys. That is probably the lowest value it takes.',
    );
  });
});
