// DESIGN FST §10.2 M3 / §10.6 tests 14–15 + review/FST-R0-clamp.md + mutants N1, N4, N5:
// perf.apply() clamps and rounds ONLY the keys present in patch; unedited fields keep the board's values
// verbatim (even below LIMITS, above rtMax, or off the Pro's 0.01 grid). Mode changes raise only fields
// put into use that are below the floor, and never lower or round them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { encodePerformance } from '../src/protocol/codec';
import type { DemoSeed } from '../src/protocol/mock';
import type { Performance, PhysicalKey } from '../src/protocol';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { LIMITS, usePerformanceStore } from '../src/stores/performance';
import { useUserPresetsStore } from '../src/stores/userPresets';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { t } from '../src/i18n/vi';
import { setLocale } from '../src/i18n/locale';

const keyByName = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const Q = keyByName('Q');
const W = keyByName('W');
const A = keyByName('A');

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
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setLocale('vi');
});

/** Seed a key's raw performance record directly inside MockTransport's active profile before perf.load(true). */
async function seedBoardKey(mock: MockTransport, key: PhysicalKey, patch: Partial<Performance>) {
  const cur = await mock.getPerformance(key);
  const next: Performance = { ...cur, ...patch };
  const profiles = (mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number }).profiles;
  const active = (mock as unknown as { active: number }).active;
  profiles[active].perf.set(`${key.row}:${key.col}`, encodePerformance({ row: 0, col: 0 }, next).slice(4, 20));
}

function spyExchange(mock: MockTransport) {
  const frames: number[][] = [];
  const target = mock as unknown as { exchange: (frame: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
  const orig = target.exchange.bind(mock);
  vi.spyOn(target, 'exchange').mockImplementation((frame: Uint8Array, timeoutMs?: number) => {
    frames.push(Array.from(frame));
    return orig(frame, timeoutMs);
  });
  return {
    frames,
    clear: () => { frames.length = 0; },
    perfWritesFor: (key: PhysicalKey) => frames.filter((f) => f[0] === 0x04 && f[1] === 0x02 && f[2] === key.row && f[3] === key.col),
  };
}

async function flush() {
  await flushPromises();
  await useSyncStore().flush();
  await flushPromises();
}

async function bootBoard(opts: { seed?: DemoSeed; rtPrecision?: number; seeds?: { key: PhysicalKey; patch: Partial<Performance> }[] } = {}) {
  const device = useDeviceStore();
  await device.connectDemo(opts.seed ?? 'max');
  if (opts.rtPrecision !== undefined) device.rtPrecision = opts.rtPrecision;
  const mock = device.transport as MockTransport;
  for (const s of opts.seeds ?? []) await seedBoardKey(mock, s.key, s.patch);
  const perf = usePerformanceStore();
  await perf.load(true);
  return { device, mock, perf, sync: useSyncStore(), history: useHistoryStore(), sel: useSelectionStore() };
}

const FIVE_001: Partial<Performance> = {
  mode: 1,
  normalPress: 0.001,
  normalRelease: 0.001,
  rtFirstTouch: 0.001,
  rtPress: 0.001,
  rtRelease: 0.001,
  pressDeadStroke: 0.1,
  releaseDeadStroke: 0.1,
};

describe('FST test 14: FST-R0 — unedited fields stay verbatim at frame level (N1, N5)', () => {
  it('single key at 0.001/0.001/0.001: deadzone edit writes 01 00 in bytes 5..14 and c8 00 at 15..16, and undo keeps 01 00', async () => {
    const { mock, perf, sync, history } = await bootBoard({ seeds: [{ key: Q, patch: FIVE_001 }] });
    const ex = spyExchange(mock);

    const n = perf.apply([Q.id], () => ({ pressDeadStroke: 0.2 }), 'deadzone');
    expect(n).toBe(1);
    await flush();

    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({
      mode: 1, normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001,
      pressDeadStroke: 0.2, releaseDeadStroke: 0.1,
    });
    const writes = ex.perfWritesFor(Q);
    expect(writes).toHaveLength(1);
    expect(writes[0].slice(5, 15)).toEqual([0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]);
    expect(writes[0].slice(15, 17)).toEqual([0xc8, 0x00]);

    // Undo restores deadzone (0.1 = 64 00) while keeping the five fields at 0.001 (01 00)
    ex.clear();
    history.undo();
    await flush();
    const undoWrites = ex.perfWritesFor(Q);
    expect(undoWrites).toHaveLength(1);
    expect(undoWrites[0].slice(5, 15)).toEqual([0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]);
    expect(undoWrites[0].slice(15, 17)).toEqual([0x64, 0x00]);
  });

  it('all 64 keys with no selection: editing top deadzone on TravelTab keeps Q and W at 0.001 (01 00 in 04 02 frames)', async () => {
    const { mock, perf, sync, sel } = await bootBoard({
      seeds: [
        { key: Q, patch: FIVE_001 },
        { key: W, patch: FIVE_001 },
      ],
    });
    sel.clear();
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    const ex = spyExchange(mock);

    const deadInput = document.body.querySelector<HTMLInputElement>(`.c-dead input[aria-label="${t('perf.deadTop')}"]`)!;
    deadInput.value = '0.2';
    deadInput.dispatchEvent(new Event('input'));
    deadInput.dispatchEvent(new Event('blur'));
    await flush();

    expect(sync.state).toBe('saved');
    // Every key whose deadzone changed got written; Q and W kept 0.001 in all 5 fields
    const allWrites = ex.frames.filter((f) => f[0] === 0x04 && f[1] === 0x02);
    expect(allWrites.length).toBeGreaterThanOrEqual(63); // Space already starts at 0.2
    for (const k of [Q, W]) {
      expect(perf.values[k.id]).toMatchObject({
        normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001, pressDeadStroke: 0.2,
      });
      const kw = ex.perfWritesFor(k);
      expect(kw).toHaveLength(1);
      expect(kw[0].slice(5, 15)).toEqual([0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]);
      expect(kw[0].slice(15, 17)).toEqual([0xc8, 0x00]);
    }
  });

  it('user preset in Standard mode (does not set RT fields): leaves Q rtPress and rtRelease at 0.001 (01 00)', async () => {
    const { mock, perf, sync, sel } = await bootBoard({ seeds: [{ key: Q, patch: FIVE_001 }] });
    const presets = useUserPresetsStore();
    presets.add('Std', { mode: 0, continuous: false, actuation: 2.0, rtPress: 0.5, rtRelease: 0.5, deadTop: 0.2, deadBottom: 0.2 });
    sel.selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    const ex = spyExchange(mock);

    const btn = [...document.body.querySelectorAll<HTMLButtonElement>('.saved .preset')].find((b) => b.textContent?.includes('Std'))!;
    btn.click();
    await flush();

    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({
      mode: 0, normalPress: 2.0, normalRelease: 2.0, rtFirstTouch: 2.0, rtPress: 0.001, rtRelease: 0.001, pressDeadStroke: 0.2, releaseDeadStroke: 0.2,
    });
    const kw = ex.perfWritesFor(Q);
    expect(kw).toHaveLength(1);
    expect(kw[0][4]).toBe(0);
    expect(kw[0].slice(11, 15)).toEqual([0x01, 0x00, 0x01, 0x00]); // rtPress, rtRelease untouched
    expect(kw[0].slice(15, 17)).toEqual([0xc8, 0x00]);
  });

  it('Continuous RT switch on / off keeps all five 0.001 fields (01 00) on Q', async () => {
    const { mock, perf, sync, sel } = await bootBoard({ seeds: [{ key: Q, patch: FIVE_001 }] });
    sel.selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    const ex = spyExchange(mock);

    const contSwitch = document.body.querySelector<HTMLButtonElement>('.c-mode .continuous [role="switch"]')!;
    // Continuous ON (mode 1) -> OFF (mode 2)
    contSwitch.click();
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({ mode: 2, normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001 });
    expect(ex.perfWritesFor(Q)).toHaveLength(1);
    expect(ex.perfWritesFor(Q)[0][4]).toBe(2);
    expect(ex.perfWritesFor(Q)[0].slice(5, 15)).toEqual([0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]);

    // Continuous OFF (mode 2) -> ON (mode 1)
    ex.clear();
    contSwitch.click();
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({ mode: 1, normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001 });
    expect(ex.perfWritesFor(Q)).toHaveLength(1);
    expect(ex.perfWritesFor(Q)[0][4]).toBe(1);
    expect(ex.perfWritesFor(Q)[0].slice(5, 15)).toEqual([0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]);
  });

  it('a key holding rtPress 2.5 (above rtMax) keeps 2.5 after a deadzone edit, while explicitly editing rtPress clamps it to rtMax', async () => {
    const { mock, perf, sync } = await bootBoard({
      seeds: [{ key: Q, patch: { mode: 1, rtPress: 2.5, rtRelease: 2.4, pressDeadStroke: 0.1 } }],
    });
    const ex = spyExchange(mock);

    perf.apply([Q.id], () => ({ pressDeadStroke: 0.2 }), 'deadzone');
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id].rtPress).toBe(2.5);
    expect(perf.values[Q.id].rtRelease).toBe(2.4);
    expect(perf.values[Q.id].pressDeadStroke).toBe(0.2);
    const kw = ex.perfWritesFor(Q);
    expect(kw).toHaveLength(1);
    expect(kw[0].slice(11, 13)).toEqual([0xc4, 0x09]); // 2500 µm

    // Key-presence rule: passing rtPress explicitly (even with the same value 2.5) DOES clamp it to rtMax (2.0)
    perf.apply([Q.id], () => ({ rtPress: 2.5 }), 'explicit');
    await flush();
    expect(perf.values[Q.id].rtPress).toBe(LIMITS.rtMax);
    expect(perf.values[Q.id].rtRelease).toBe(2.4);
  });

  it('Pro demo (rtPrecision 0.01): an off-grid 0.005 is kept (not rounded) after a deadzone edit, while edited fields are rounded (N5)', async () => {
    const FIVE_005: Partial<Performance> = {
      mode: 1,
      normalPress: 0.005,
      normalRelease: 0.005,
      rtFirstTouch: 0.005,
      rtPress: 0.005,
      rtRelease: 0.005,
      pressDeadStroke: 0.1,
      releaseDeadStroke: 0.1,
    };
    const { mock, perf, sync } = await bootBoard({
      seed: 'pro',
      rtPrecision: 0.01,
      seeds: [{ key: Q, patch: FIVE_005 }],
    });
    const ex = spyExchange(mock);

    perf.apply([Q.id], () => ({ pressDeadStroke: 0.2, releaseDeadStroke: 0.123 }), 'deadzone');
    await flush();

    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({
      normalPress: 0.005, normalRelease: 0.005, rtFirstTouch: 0.005, rtPress: 0.005, rtRelease: 0.005,
      pressDeadStroke: 0.2, releaseDeadStroke: 0.12,
    });
    const kw = ex.perfWritesFor(Q);
    expect(kw).toHaveLength(1);
    expect(kw[0].slice(5, 15)).toEqual([0x05, 0x00, 0x05, 0x00, 0x05, 0x00, 0x05, 0x00, 0x05, 0x00]);
    expect(kw[0].slice(15, 19)).toEqual([0xc8, 0x00, 0x78, 0x00]); // 200 µm, 120 µm
  });
});

describe('FST test 15: mode change M3 — raises below-floor in-use fields, never lowers above-max (N4)', () => {
  it('Standard -> RT on a key with rtPress / rtRelease / rtFirstTouch = 0 raises them to the floor and the guard accepts', async () => {
    const { mock, perf, sync } = await bootBoard({
      seeds: [{ key: Q, patch: { mode: 0, normalPress: 2.0, normalRelease: 2.0, rtFirstTouch: 0, rtPress: 0, rtRelease: 0 } }],
    });
    const ex = spyExchange(mock);

    const n = perf.apply([Q.id], () => ({ mode: 1 }), 'mode');
    expect(n).toBe(1);
    await flush();

    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({
      mode: 1,
      normalPress: 2.0,
      normalRelease: 2.0,
      rtFirstTouch: LIMITS.actuationMin,
      rtPress: LIMITS.rtMin,
      rtRelease: LIMITS.rtMin,
    });
    expect(ex.perfWritesFor(Q)).toHaveLength(1);
  });

  it('Standard -> RT on a key with rtPress 2.5 (above rtMax) keeps 2.5 and the guard accepts (N4)', async () => {
    const { mock, perf, sync, sel } = await bootBoard({
      seeds: [{ key: Q, patch: { mode: 0, normalPress: 2.0, normalRelease: 2.0, rtFirstTouch: 2.0, rtPress: 2.5, rtRelease: 2.4 } }],
    });
    sel.selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    const ex = spyExchange(mock);

    const rtBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.trim() === t('perf.modeRt'))!;
    rtBtn.click();
    await flush();

    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({
      mode: 1,
      normalPress: 2.0,
      normalRelease: 2.0,
      rtFirstTouch: 2.0,
      rtPress: 2.5,
      rtRelease: 2.4,
    });
    const kw = ex.perfWritesFor(Q);
    expect(kw).toHaveLength(1);
    expect(kw[0][4]).toBe(1);
    expect(kw[0].slice(11, 15)).toEqual([0xc4, 0x09, 0x60, 0x09]); // 2500 µm, 2400 µm
  });

  it('RT -> Standard carries actuation as today (UI), and direct mode 0 raises normalPress 0 to floor with SYNC-REL-1', async () => {
    const { mock, perf, sync, sel } = await bootBoard({
      seeds: [
        { key: Q, patch: { mode: 1, normalPress: 2.0, normalRelease: 2.0, rtFirstTouch: 1.0, rtPress: 0.8, rtRelease: 0.3 } },
        { key: A, patch: { mode: 1, normalPress: 0, normalRelease: 0, rtFirstTouch: 1.0, rtPress: 0.3, rtRelease: 0.3 } },
      ],
    });
    sel.selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    const ex = spyExchange(mock);

    // UI RT -> Standard carries rtFirstTouch (1.0) into normalPress & normalRelease
    const stdBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.trim() === t('perf.modeStandard'))!;
    stdBtn.click();
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({ mode: 0, normalPress: 1.0, normalRelease: 1.0, rtFirstTouch: 1.0, rtPress: 0.8, rtRelease: 0.3 });
    expect(ex.perfWritesFor(Q)).toHaveLength(1);

    // Direct mode 0 on key A whose normalPress is 0 raises normalPress & normalRelease to LIMITS.actuationMin
    ex.clear();
    perf.apply([A.id], () => ({ mode: 0 }), 'mode');
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[A.id]).toMatchObject({ mode: 0, normalPress: LIMITS.actuationMin, normalRelease: LIMITS.actuationMin, rtFirstTouch: 1.0, rtPress: 0.3, rtRelease: 0.3 });
    expect(ex.perfWritesFor(A)).toHaveLength(1);
  });
});
