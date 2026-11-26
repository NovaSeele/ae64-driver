// DESIGN FST §7 tests 3–13 + mutants F1–F8: the 0.001 mm step switch on Performance › Travel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { DemoSeed } from '../src/protocol/mock';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { buildExport, pageReload, parseImport, useAppSettings } from '../src/data/appSettings';
import { vi as viDict, t } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';
import { setLocale } from '../src/i18n/locale';

const SRC = import.meta.glob('../src/**/*.{ts,vue}', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
const FINE_STEP_KEY = 'ae64.perf.fineStep';
const keyId = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!.id;
const W = keyId('W');
const A = keyId('A');

let w: VueWrapper | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale('vi');
  setActivePinia(createPinia());
});

afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLocale('vi');
});

async function setup(opts: { seed?: DemoSeed; select?: number[]; rtPrecision?: number } = {}) {
  const device = useDeviceStore();
  await device.connectDemo(opts.seed ?? 'max');
  if (opts.rtPrecision !== undefined) device.rtPrecision = opts.rtPrecision;
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  // Select a single RT key (W) by default: mode 1, rtFirstTouch 1.0, rtPress 0.8, rtRelease 0.3 (unlinked), deadTop/Bottom 0.1.
  useSelectionStore().selectMany(opts.select ?? [W]);
  ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
  await flushPromises();
  return { device, mock, perf, history: useHistoryStore(), sync: useSyncStore() };
}

async function flush() {
  await flushPromises();
  await useSyncStore().flush();
  await flushPromises();
}

/** Count frames passing through transport.exchange. */
function spyExchange(mock: MockTransport) {
  const frames: number[][] = [];
  const target = mock as unknown as { exchange: (frame: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
  const orig = target.exchange.bind(mock);
  const spy = vi.spyOn(target, 'exchange').mockImplementation((frame: Uint8Array, timeoutMs?: number) => {
    frames.push(Array.from(frame));
    return orig(frame, timeoutMs);
  });
  return { frames, spy, clear: () => { frames.length = 0; } };
}

// DOM helpers for the .fst row and all 10 Travel controls
const fstRow = () => document.body.querySelector<HTMLElement>('.fst');
const fstSwitch = () => document.body.querySelector<HTMLButtonElement>('.fst [role="switch"]');
const fstDesc = () => document.body.querySelector<HTMLElement>('.fst__desc');
const nfInput = (label: string) => document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
const nfPlus = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('ui.increase')} ${label}"]`)!;
const nfMinus = (label: string) => document.body.querySelector<HTMLButtonElement>(`button[aria-label="${t('ui.decrease')} ${label}"]`)!;
const sliderThumb = (label: string) => document.body.querySelector<HTMLElement>(`[role="slider"][aria-label="${label}"]`)!;
const sliderTrack = (label: string) => sliderThumb(label).closest<HTMLElement>('.sl')!;

async function clickBtn(btn: HTMLButtonElement, shiftKey = false) {
  btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  await flushPromises();
}
async function pressKey(el: HTMLElement, key: string, shiftKey = false) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true }));
  await flushPromises();
}
function mockRect(track: HTMLElement, rect: Partial<DOMRect>) {
  const full: DOMRect = {
    left: 0, top: 0, width: 300, height: 20, right: 300, bottom: 20, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  };
  track.getBoundingClientRect = () => full;
  track.setPointerCapture = () => undefined;
}
async function clickTrack(track: HTMLElement, clientX: number, clientY = 10, shiftKey = false) {
  track.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX, clientY, shiftKey }));
  track.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX, clientY, shiftKey }));
  await flushPromises();
}

const LABELS = () => ({
  act: t('perf.actuation'),
  rtPress: t('perf.rtPress'),
  rtRelease: t('perf.rtRelease'),
  deadTop: t('perf.deadTop'),
  deadBottom: t('perf.deadBottom'),
});

/** Exercise all 10 controls (5 NumberFields + 5 Sliders) with one + and one − step and return each delta. */
async function stepAllControls(perf: ReturnType<typeof usePerformanceStore>, k: number, shiftKey = false) {
  const L = LABELS();
  const res: Record<string, number[]> = {};
  const check = async (name: string, field: 'rtFirstTouch' | 'rtPress' | 'rtRelease' | 'pressDeadStroke' | 'releaseDeadStroke', up: () => Promise<void>, down: () => Promise<void>) => {
    const start = perf.values[k][field];
    await up();
    const dUp = Number((perf.values[k][field] - start).toFixed(4));
    await down();
    const dDown = Number((perf.values[k][field] - start).toFixed(4));
    res[name] = [dUp, dDown];
  };

  await check('act.btn', 'rtFirstTouch', () => clickBtn(nfPlus(L.act), shiftKey), () => clickBtn(nfMinus(L.act), shiftKey));
  await check('act.key', 'rtFirstTouch', () => pressKey(nfInput(L.act), 'ArrowUp', shiftKey), () => pressKey(nfInput(L.act), 'ArrowDown', shiftKey));
  // Vertical slider: ArrowDown increases, ArrowUp decreases
  await check('act.slider', 'rtFirstTouch', () => pressKey(sliderThumb(L.act), 'ArrowDown', shiftKey), () => pressKey(sliderThumb(L.act), 'ArrowUp', shiftKey));

  await check('rtPress.btn', 'rtPress', () => clickBtn(nfPlus(L.rtPress), shiftKey), () => clickBtn(nfMinus(L.rtPress), shiftKey));
  await check('rtPress.key', 'rtPress', () => pressKey(nfInput(L.rtPress), 'ArrowUp', shiftKey), () => pressKey(nfInput(L.rtPress), 'ArrowDown', shiftKey));
  await check('rtPress.slider', 'rtPress', () => pressKey(sliderThumb(L.rtPress), 'ArrowRight', shiftKey), () => pressKey(sliderThumb(L.rtPress), 'ArrowLeft', shiftKey));

  await check('rtRelease.btn', 'rtRelease', () => clickBtn(nfPlus(L.rtRelease), shiftKey), () => clickBtn(nfMinus(L.rtRelease), shiftKey));
  await check('rtRelease.key', 'rtRelease', () => pressKey(nfInput(L.rtRelease), 'ArrowUp', shiftKey), () => pressKey(nfInput(L.rtRelease), 'ArrowDown', shiftKey));
  await check('rtRelease.slider', 'rtRelease', () => pressKey(sliderThumb(L.rtRelease), 'ArrowRight', shiftKey), () => pressKey(sliderThumb(L.rtRelease), 'ArrowLeft', shiftKey));

  await check('deadTop.btn', 'pressDeadStroke', () => clickBtn(nfPlus(L.deadTop), shiftKey), () => clickBtn(nfMinus(L.deadTop), shiftKey));
  await check('deadTop.key', 'pressDeadStroke', () => pressKey(nfInput(L.deadTop), 'ArrowUp', shiftKey), () => pressKey(nfInput(L.deadTop), 'ArrowDown', shiftKey));
  await check('deadTop.slider', 'pressDeadStroke', () => pressKey(sliderThumb(L.deadTop), 'ArrowRight', shiftKey), () => pressKey(sliderThumb(L.deadTop), 'ArrowLeft', shiftKey));

  await check('deadBottom.btn', 'releaseDeadStroke', () => clickBtn(nfPlus(L.deadBottom), shiftKey), () => clickBtn(nfMinus(L.deadBottom), shiftKey));
  await check('deadBottom.key', 'releaseDeadStroke', () => pressKey(nfInput(L.deadBottom), 'ArrowUp', shiftKey), () => pressKey(nfInput(L.deadBottom), 'ArrowDown', shiftKey));
  await check('deadBottom.slider', 'releaseDeadStroke', () => pressKey(sliderThumb(L.deadBottom), 'ArrowRight', shiftKey), () => pressKey(sliderThumb(L.deadBottom), 'ArrowLeft', shiftKey));

  return res;
}

describe('FST test 3: default on (Max demo, no stored key)', () => {
  it('shows the .fst row checked with fineStepOn, moves 0.001 mm on all controls, and track clicks snap to 0.001', async () => {
    const { device, perf } = await setup();
    const editors = document.body.querySelector('.editors')!;
    expect(editors.firstElementChild).toBe(fstRow());
    const sw = fstSwitch()!;
    const desc = fstDesc()!;
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('aria-label')).toBe(t('perf.fineStep'));
    expect(sw.getAttribute('aria-describedby')).toBe(desc.id);
    expect(desc.id).toBeTruthy();
    expect(desc.textContent).toBe(t('perf.fineStepOn'));
    expect(desc.getAttribute('aria-live')).toBeNull();
    expect(fstRow()!.querySelector('.info .sr-only')?.textContent).toBe(t('perf.fineStepTip'));
    // Switch stays enabled in read-only mode (preference of this computer, writes nothing)
    device.boardAllowed = false;
    await nextTick();
    expect(sw.disabled).toBe(false);
    device.boardAllowed = true;
    await nextTick();

    const deltas = await stepAllControls(perf, W, false);
    for (const [name, pair] of Object.entries(deltas)) {
      expect(pair, name).toEqual([0.001, 0]);
    }

    // Track click on RT press slider lands on the 0.001 grid (non-0.01 value)
    const track = sliderTrack(LABELS().rtPress);
    mockRect(track, { width: 1990, height: 20 }); // min 0.01, max 2.00 -> 1 px = 0.001 mm
    await clickTrack(track, 1227, 10); // 0.01 + 1.227 = 1.237
    expect(perf.values[W].rtPress).toBe(1.237);

    // Track click on vertical actuation slider lands on the 0.001 grid
    const actTrack = sliderTrack(LABELS().act);
    mockRect(actTrack, { width: 20, height: 3210 }); // min 0.1, max 3.31 -> 1 px = 0.001 mm
    await clickTrack(actTrack, 10, 1137); // 0.1 + 1.137 = 1.237
    expect(perf.values[W].rtFirstTouch).toBe(1.237);
  });
});

describe('FST test 4: off, persistence, and storage error resilience (F4)', () => {
  it('toggling off steps 0.01 on all controls, updates the line, saves "0", and persists across remount', async () => {
    const { perf } = await setup();
    await clickBtn(fstSwitch()!);
    expect(fstSwitch()!.getAttribute('aria-checked')).toBe('false');
    expect(fstDesc()!.textContent).toBe(t('perf.fineStepOff'));
    expect(localStorage.getItem(FINE_STEP_KEY)).toBe('0');

    const deltas = await stepAllControls(perf, W, false);
    for (const [name, pair] of Object.entries(deltas)) {
      expect(pair, name).toEqual([0.01, 0]);
    }

    // Remount keeps it off
    w!.unmount();
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    expect(fstSwitch()!.getAttribute('aria-checked')).toBe('false');
    expect(fstDesc()!.textContent).toBe(t('perf.fineStepOff'));
    await clickBtn(nfPlus(LABELS().rtPress));
    expect(perf.values[W].rtPress).toBe(0.81);
  });

  it('a throwing getItem defaults to on, and a throwing setItem does not break toggling', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    const { perf } = await setup();
    expect(fstSwitch()!.getAttribute('aria-checked')).toBe('true');
    expect(fstDesc()!.textContent).toBe(t('perf.fineStepOn'));

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
    await clickBtn(fstSwitch()!);
    expect(fstSwitch()!.getAttribute('aria-checked')).toBe('false');
    expect(fstDesc()!.textContent).toBe(t('perf.fineStepOff'));
    await clickBtn(nfPlus(LABELS().rtPress));
    expect(perf.values[W].rtPress).toBe(0.81);
  });
});

describe('FST test 5: Shift is ignored on all controls, both on and off (F1, F2)', () => {
  it('Shift + click, Shift + arrow, and Shift-drag match plain actions when on and when off', async () => {
    const { perf } = await setup();
    for (const mode of ['on', 'off'] as const) {
      if (mode === 'off') {
        await clickBtn(fstSwitch()!);
        // Reset back onto the 0.01 grid after the 'on' drag (which landed on 1.237)
        perf.values = {
          ...perf.values,
          [W]: { ...perf.values[W], rtFirstTouch: 1.0, normalPress: 1.0, rtPress: 0.8 },
        };
        await flushPromises();
      }
      const expectedStep = mode === 'on' ? 0.001 : 0.01;

      const shiftDeltas = await stepAllControls(perf, W, true);
      for (const [name, pair] of Object.entries(shiftDeltas)) {
        expect(pair, `${mode} Shift ${name}`).toEqual([expectedStep, 0]);
      }

      // Shift-drag on horizontal RT press slider and vertical actuation slider
      const rtTrack = sliderTrack(LABELS().rtPress);
      mockRect(rtTrack, { width: 1990, height: 20 });
      await clickTrack(rtTrack, 1227, 10, false);
      const plainRt = perf.values[W].rtPress;
      await clickTrack(rtTrack, 500, 10, false);
      await clickTrack(rtTrack, 1227, 10, true);
      expect(perf.values[W].rtPress, `${mode} RT Shift-drag`).toBe(plainRt);
      expect(plainRt).toBe(mode === 'on' ? 1.237 : 1.24);

      const actTrack = sliderTrack(LABELS().act);
      mockRect(actTrack, { width: 20, height: 3210 });
      await clickTrack(actTrack, 10, 1137, false);
      const plainAct = perf.values[W].rtFirstTouch;
      await clickTrack(actTrack, 10, 500, false);
      await clickTrack(actTrack, 10, 1137, true);
      expect(perf.values[W].rtFirstTouch, `${mode} Act Shift-drag`).toBe(plainAct);
      expect(plainAct).toBe(mode === 'on' ? 1.237 : 1.24);
    }
  });
});

describe('FST test 6: mixed selection relative steps (F2)', () => {
  it('steps each key by 0.001 (on) / 0.01 (off) from its own value, and PageUp moves +0.1 on each', async () => {
    const { perf } = await setup({ select: [W, A] });
    const resetMixed = async () => {
      perf.values = {
        ...perf.values,
        [W]: { ...perf.values[W], rtPress: 0.3, rtFirstTouch: 1.0, normalPress: 1.0, pressDeadStroke: 0.1 },
        [A]: { ...perf.values[A], rtPress: 0.4, rtFirstTouch: 1.5, normalPress: 1.5, pressDeadStroke: 0.2 },
      };
      await flushPromises();
    };

    // On (0.001)
    await resetMixed();
    await clickBtn(nfPlus(LABELS().rtPress));
    expect([perf.values[W].rtPress, perf.values[A].rtPress]).toEqual([0.301, 0.401]);

    await resetMixed();
    await pressKey(sliderThumb(LABELS().rtPress), 'ArrowRight');
    expect([perf.values[W].rtPress, perf.values[A].rtPress]).toEqual([0.301, 0.401]);

    await resetMixed();
    await pressKey(sliderThumb(LABELS().rtPress), 'PageUp');
    expect([perf.values[W].rtPress, perf.values[A].rtPress]).toEqual([0.4, 0.5]);

    await resetMixed();
    await pressKey(sliderThumb(LABELS().act), 'ArrowDown');
    expect([perf.values[W].rtFirstTouch, perf.values[A].rtFirstTouch]).toEqual([1.001, 1.501]);

    await resetMixed();
    await pressKey(sliderThumb(LABELS().deadTop), 'ArrowRight');
    expect([perf.values[W].pressDeadStroke, perf.values[A].pressDeadStroke]).toEqual([0.101, 0.201]);

    // Off (0.01)
    await clickBtn(fstSwitch()!);
    await resetMixed();
    await clickBtn(nfPlus(LABELS().rtPress));
    expect([perf.values[W].rtPress, perf.values[A].rtPress]).toEqual([0.31, 0.41]);

    await resetMixed();
    await pressKey(sliderThumb(LABELS().rtPress), 'ArrowRight');
    expect([perf.values[W].rtPress, perf.values[A].rtPress]).toEqual([0.31, 0.41]);

    await resetMixed();
    await pressKey(sliderThumb(LABELS().rtPress), 'PageUp');
    expect([perf.values[W].rtPress, perf.values[A].rtPress]).toEqual([0.4, 0.5]);
  });
});

describe('FST test 7: PageUp / PageDown always ±0.1 on every slider, Home / End unchanged (F5)', () => {
  it('moves ±0.1 on all 5 sliders both on and off, and Home / End jump to min / max', async () => {
    const { perf } = await setup();
    const L = LABELS();
    const sliders: { label: string; field: 'rtFirstTouch' | 'rtPress' | 'rtRelease' | 'pressDeadStroke' | 'releaseDeadStroke'; min: number; max: number }[] = [
      { label: L.act, field: 'rtFirstTouch', min: 0.1, max: 3.31 },
      { label: L.rtPress, field: 'rtPress', min: 0.01, max: 2.0 },
      { label: L.rtRelease, field: 'rtRelease', min: 0.01, max: 2.0 },
      { label: L.deadTop, field: 'pressDeadStroke', min: 0, max: 1.0 },
      { label: L.deadBottom, field: 'releaseDeadStroke', min: 0, max: 1.0 },
    ];

    for (const mode of ['on', 'off'] as const) {
      if (mode === 'off') await clickBtn(fstSwitch()!);
      for (const s of sliders) {
        const start = perf.values[W][s.field];
        await pressKey(sliderThumb(s.label), 'PageUp');
        expect(perf.values[W][s.field], `${mode} PageUp ${s.label}`).toBe(Number((start + 0.1).toFixed(3)));
        await pressKey(sliderThumb(s.label), 'PageDown');
        expect(perf.values[W][s.field], `${mode} PageDown ${s.label}`).toBe(start);
      }
    }

    // Home / End unchanged
    for (const s of sliders) {
      await pressKey(sliderThumb(s.label), 'Home');
      expect(perf.values[W][s.field], `Home ${s.label}`).toBe(s.min);
      await pressKey(sliderThumb(s.label), 'End');
      expect(perf.values[W][s.field], `End ${s.label}`).toBe(s.max);
    }
  });
});

describe('FST test 8: Pro (0.01 mm precision) hides the row, steps 0.01, leaves stored value untouched (F3)', () => {
  it('shows no .fst row, keeps 0.01 steps even with "1" stored, writes only 0.01-grid values, never rewrites localStorage', async () => {
    localStorage.setItem(FINE_STEP_KEY, '1');
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem');
    // MockTransport seed 'pro' currently replies 0.001 to 02:0c:00; set rtPrecision = 0.01 for a 0.01-mm Pro board (as overview-page.test.ts:157 does).
    const { mock, perf } = await setup({ seed: 'pro', rtPrecision: 0.01 });

    expect(fstRow()).toBeNull();
    const deltas = await stepAllControls(perf, W, false);
    for (const [name, pair] of Object.entries(deltas)) {
      expect(pair, `Pro ${name}`).toEqual([0.01, 0]);
    }
    // Shift also stays 0.01 on Pro
    const shiftDeltas = await stepAllControls(perf, W, true);
    for (const [name, pair] of Object.entries(shiftDeltas)) {
      expect(pair, `Pro Shift ${name}`).toEqual([0.01, 0]);
    }

    // 20 mixed steps: buttons, arrows, drags, PageUp
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const L = LABELS();
    const rtTrack = sliderTrack(L.rtPress);
    mockRect(rtTrack, { width: 1990, height: 20 });
    for (let i = 0; i < 5; i++) await clickBtn(nfPlus(L.act));
    for (let i = 0; i < 5; i++) await pressKey(sliderThumb(L.rtPress), 'ArrowRight', i % 2 === 1);
    for (let i = 0; i < 5; i++) await clickTrack(rtTrack, 400 + i * 37, 10, i % 2 === 1);
    for (let i = 0; i < 5; i++) await pressKey(nfInput(L.deadTop), 'ArrowUp');
    await flush();

    expect(setPerf).toHaveBeenCalled();
    for (const [, p] of setPerf.mock.calls) {
      for (const v of [p.normalPress, p.rtFirstTouch, p.rtPress, p.rtRelease, p.pressDeadStroke, p.releaseDeadStroke]) {
        expect(Math.abs(v * 100 - Math.round(v * 100)), `off 0.01 grid: ${v}`).toBeLessThan(1e-6);
      }
    }

    expect(localStorage.getItem(FINE_STEP_KEY)).toBe('1');
    expect(setItemSpy.mock.calls.filter(([k]) => k === FINE_STEP_KEY)).toHaveLength(0);
  });
});

describe('FST test 9: limits and N-WX5-1 at 0.001 mm', () => {
  it('holds min/max bounds with 0 writes when already at a bound, and obeys N-WX5-1 for out-of-range values', async () => {
    const { mock, perf } = await setup();
    const L = LABELS();
    const ex = spyExchange(mock);

    const setVal = async (patch: Partial<typeof perf.values[number]>) => {
      perf.values = { ...perf.values, [W]: { ...perf.values[W], ...patch } };
      await flushPromises();
      ex.clear();
    };

    // RT press at 0.010, − -> stays 0.010, 0 HID
    await setVal({ rtPress: 0.01 });
    await clickBtn(nfMinus(L.rtPress));
    await flush();
    expect(perf.values[W].rtPress).toBe(0.01);
    expect(ex.frames).toHaveLength(0);

    // Deadzone top at 0.000, − -> stays 0.000, 0 HID
    await setVal({ pressDeadStroke: 0 });
    await clickBtn(nfMinus(L.deadTop));
    await flush();
    expect(perf.values[W].pressDeadStroke).toBe(0);
    expect(ex.frames).toHaveLength(0);

    // Actuation at 0.100, − -> stays 0.100, 0 HID
    await setVal({ rtFirstTouch: 0.1, normalPress: 0.1 });
    await clickBtn(nfMinus(L.act));
    await flush();
    expect(perf.values[W].rtFirstTouch).toBe(0.1);
    expect(ex.frames).toHaveLength(0);

    // Actuation at key's travel (3.310), + -> stays 3.310, 0 HID
    await setVal({ rtFirstTouch: 3.31, normalPress: 3.31 });
    await clickBtn(nfPlus(L.act));
    await flush();
    expect(perf.values[W].rtFirstTouch).toBe(3.31);
    expect(ex.frames).toHaveLength(0);

    // N-WX5-1: out-of-range below min (RT press 0.005 < 0.01)
    await setVal({ rtPress: 0.005 });
    await clickBtn(nfMinus(L.rtPress));
    await flush();
    expect(perf.values[W].rtPress).toBe(0.005);
    expect(ex.frames).toHaveLength(0);
    // Step toward range lands on min (0.01)
    await clickBtn(nfPlus(L.rtPress));
    await flush();
    expect(perf.values[W].rtPress).toBe(0.01);
    expect(ex.frames.length).toBeGreaterThan(0);

    // N-WX5-1: out-of-range above max (actuation 3.50 > 3.31)
    await setVal({ rtFirstTouch: 3.5, normalPress: 3.5 });
    await clickBtn(nfPlus(L.act));
    await flush();
    expect(perf.values[W].rtFirstTouch).toBe(3.5);
    expect(ex.frames).toHaveLength(0);
    // Step toward range lands on max (3.31)
    await clickBtn(nfMinus(L.act));
    await flush();
    expect(perf.values[W].rtFirstTouch).toBe(3.31);
    expect(ex.frames.length).toBeGreaterThan(0);
  });
});

describe('FST test 10: HID writes and history coalescing (F7, F8)', () => {
  it('toggling the switch sends 0 HID frames and adds 0 history entries', async () => {
    const { mock, history } = await setup();
    const ex = spyExchange(mock);
    await clickBtn(fstSwitch()!);
    await clickBtn(fstSwitch()!);
    await flush();
    expect(ex.frames).toHaveLength(0);
    expect(history.canUndo).toBe(false);
  });

  it('30 held ArrowUp presses (30 ms apart) and a 60-move drag make 1 history entry and identical frames at 0.001 vs 0.01', async () => {
    async function runHeldAndDrag(fineOn: boolean) {
      vi.useRealTimers();
      w?.unmount();
      w = null;
      document.body.innerHTML = '';
      localStorage.clear();
      localStorage.setItem(FINE_STEP_KEY, fineOn ? '1' : '0');
      setActivePinia(createPinia());

      const device = useDeviceStore();
      await device.connectDemo('max');
      const mock = device.transport as MockTransport;
      const perf = usePerformanceStore();
      await perf.load();
      useSelectionStore().selectMany([W]);
      ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
      await flushPromises();

      vi.useFakeTimers();
      const history = useHistoryStore();
      const sync = useSyncStore();
      const ex = spyExchange(mock);
      const L = LABELS();

      const flushFake = async () => {
        const p = sync.flush();
        await vi.advanceTimersByTimeAsync(100);
        await p;
        await flushPromises();
      };

      // 1) 30 held ArrowUp presses 30 ms apart on RT press NumberField
      const startRt = perf.values[W].rtPress;
      const input = nfInput(L.rtPress);
      for (let i = 0; i < 30; i++) {
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
        await flushPromises();
        if (i < 29) await vi.advanceTimersByTimeAsync(30);
      }
      await flushFake();

      const isProfilePoll = (f: number[]) => f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x01;
      const tag = (f: number[]) => `${f[0].toString(16).padStart(2, '0')} ${f[1].toString(16).padStart(2, '0')}`;
      const heldFrames = ex.frames.filter((f) => !isProfilePoll(f)).map(tag);
      const heldExpectedEnd = Number((startRt + 30 * (fineOn ? 0.001 : 0.01)).toFixed(3));
      expect(perf.values[W].rtPress).toBe(heldExpectedEnd);
      // One history entry: one undo returns to startRt and empties the stack
      history.undo();
      await flushFake();
      expect(perf.values[W].rtPress).toBe(startRt);
      expect(history.canUndo).toBe(false);

      // Wait > 800 ms so the next gesture cannot coalesce with anything prior, and clear frame log
      await vi.advanceTimersByTimeAsync(1000);
      ex.clear();

      // 2) 300 px drag over 60 pointer moves on RT press slider
      const track = sliderTrack(L.rtPress);
      mockRect(track, { width: 300, height: 20 });
      track.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 0, clientY: 10 }));
      await flushPromises();
      for (let i = 1; i <= 60; i++) {
        track.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, cancelable: true, button: 0, clientX: i * 5, clientY: 10 }));
        await flushPromises();
        await vi.advanceTimersByTimeAsync(5);
      }
      track.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 300, clientY: 10 }));
      await flushPromises();
      await flushFake();

      const dragFrames = ex.frames.filter((f) => !isProfilePoll(f)).map(tag);
      // One history entry: one undo returns to startRt and empties the stack
      history.undo();
      await flushFake();
      expect(perf.values[W].rtPress).toBe(startRt);
      expect(history.canUndo).toBe(false);

      vi.useRealTimers();
      return { heldFrames, dragFrames };
    }

    const fine = await runHeldAndDrag(true);
    const coarse = await runHeldAndDrag(false);

    // Expect one 04 02 write + one 02 02 commit + one 04 01 read-back for the single selected key
    expect(fine.heldFrames).toEqual(['04 02', '02 02', '04 01']);
    expect(fine.heldFrames).toEqual(coarse.heldFrames);
    expect(fine.dragFrames).toEqual(['04 02', '02 02', '04 01']);
    expect(fine.dragFrames).toEqual(coarse.dragFrames);
  }, 15_000);
});

describe('FST test 11: slider aria-valuetext formatting (F6)', () => {
  it('formats actuation, RT, and deadzone sliders with 3 decimals when needed on Max, and 2 decimals on Pro', async () => {
    const { device, perf } = await setup();
    const L = LABELS();

    perf.values = {
      ...perf.values,
      [W]: { ...perf.values[W], rtFirstTouch: 1.237, normalPress: 1.237, rtPress: 0.015, rtRelease: 0.3, pressDeadStroke: 0.015, releaseDeadStroke: 0.3 },
    };
    await flushPromises();

    expect(sliderThumb(L.act).getAttribute('aria-valuetext')).toBe('1.237 mm');
    expect(sliderThumb(L.rtPress).getAttribute('aria-valuetext')).toBe('0.015 mm');
    expect(sliderThumb(L.rtRelease).getAttribute('aria-valuetext')).toBe('0.30 mm');
    expect(sliderThumb(L.deadTop).getAttribute('aria-valuetext')).toBe('0.015 mm');
    expect(sliderThumb(L.deadBottom).getAttribute('aria-valuetext')).toBe('0.30 mm');

    perf.values = { ...perf.values, [W]: { ...perf.values[W], rtFirstTouch: 1.0, normalPress: 1.0 } };
    await flushPromises();
    expect(sliderThumb(L.act).getAttribute('aria-valuetext')).toBe('1.00 mm');

    // Pro (2 decimals)
    device.rtPrecision = 0.01;
    perf.values = { ...perf.values, [W]: { ...perf.values[W], rtFirstTouch: 1.237, normalPress: 1.237 } };
    await flushPromises();
    expect(sliderThumb(L.act).getAttribute('aria-valuetext')).toBe('1.24 mm');
    expect(sliderThumb(L.rtPress).getAttribute('aria-valuetext')).toBe('0.01 mm');
    expect(sliderThumb(L.rtRelease).getAttribute('aria-valuetext')).toBe('0.30 mm');
  });
});

describe('FST test 12: appSettings export / import / reset / validation', () => {
  it('exports ae64.perf.fineStep when set, imports "0" to turn off, reset removes it back to on, and refuses "2"', async () => {
    await setup();
    // Toggle off so '0' is stored
    await clickBtn(fstSwitch()!);
    expect(localStorage.getItem(FINE_STEP_KEY)).toBe('0');

    const exp = buildExport();
    const parsed = JSON.parse(exp.json);
    expect(parsed.data[FINE_STEP_KEY]).toBe('0');

    // Refuses '2'
    const badJson = JSON.stringify({ app: 'ae64-control', version: '0.3.0', savedAt: '2026-11-27T00:00:00.000Z', data: { [FINE_STEP_KEY]: '2' } });
    expect(parseImport(badJson, badJson.length)).toEqual({ ok: false, error: 'errValue', keys: FINE_STEP_KEY });

    // Import '0' into clean storage turns it off
    localStorage.clear();
    vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    const imp = parseImport(exp.json, exp.json.length);
    expect(imp.ok).toBe(true);
    await useAppSettings().applyAndReload('import', (imp as { data: Record<string, string> }).data);
    expect(localStorage.getItem(FINE_STEP_KEY)).toBe('0');

    w!.unmount();
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    expect(fstSwitch()!.getAttribute('aria-checked')).toBe('false');

    // Reset removes the key -> back to default on
    await useAppSettings().applyAndReload('reset');
    expect(localStorage.getItem(FINE_STEP_KEY)).toBeNull();

    w!.unmount();
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    expect(fstSwitch()!.getAttribute('aria-checked')).toBe('true');
  });
});

describe('FST test 13: i18n keys and removal of perf.fineHint', () => {
  it('both vi and en have the four new keys with DESIGN §6 texts; perf.fineHint is removed everywhere', () => {
    const expectedVi = {
      'perf.fineStep': 'Bước 0.001 mm',
      'perf.fineStepOn': '− / +, phím mũi tên và các thanh kéo bên dưới chỉnh từng 0.001 mm.',
      'perf.fineStepOff': '− / +, phím mũi tên và các thanh kéo bên dưới chỉnh từng 0.01 mm.',
      'perf.fineStepTip': 'Shift không còn đổi bước. Trên thanh kéo, PageUp / PageDown luôn chỉnh 0.1 mm. Gõ thẳng vào ô để đặt giá trị bất kỳ.',
    };
    const expectedEn = {
      'perf.fineStep': '0.001 mm steps',
      'perf.fineStepOn': '− / +, the arrow keys and the sliders below move 0.001 mm at a time.',
      'perf.fineStepOff': '− / +, the arrow keys and the sliders below move 0.01 mm at a time.',
      'perf.fineStepTip': 'Shift no longer changes the step. On a slider, PageUp / PageDown always move 0.1 mm. Type in a box to set any value.',
    };

    for (const [k, v] of Object.entries(expectedVi)) expect((viDict as Record<string, string>)[k], `vi ${k}`).toBe(v);
    for (const [k, v] of Object.entries(expectedEn)) expect((enDict as Record<string, string>)[k], `en ${k}`).toBe(v);

    expect('perf.fineHint' in viDict).toBe(false);
    expect('perf.fineHint' in enDict).toBe(false);

    for (const [file, src] of Object.entries(SRC)) {
      expect(src.includes('fineHint'), `unexpected fineHint in ${file}`).toBe(false);
    }
  });
});
