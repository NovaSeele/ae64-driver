// DESIGN FST §10.2 M1, M2, M4 & §10.6 tests 17–19 + mutants N2, N3, N6, N7:
// perfMinMm, 0.001 mm writes at frame level (demo Max + mocked Max transport), presets/import, and profile restore floor.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { BaseTransport, MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Bytes, Performance, PhysicalKey } from '../src/protocol';
import { encodePerformance } from '../src/protocol/codec';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { LIMITS, perfMinMm, usePerformanceStore } from '../src/stores/performance';
import { presetsValid, sanitizePreset, useUserPresetsStore } from '../src/stores/userPresets';
import { RestoreRefusedError, useDiagnosticsStore } from '../src/stores/diagnostics';
import { useSyncStore } from '../src/stores/sync';
import { actBadgeTitle, actSublabel, capDecimals } from '../src/data/keycapActuation';
import { diagnosticsVi } from '../src/i18n/diagnostics';
import { diagnosticsEn } from '../src/i18n/en/diagnostics';
import { t } from '../src/i18n/vi';
import { setLocale } from '../src/i18n/locale';

const keyByName = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const Q = keyByName('Q');
const W = keyByName('W');

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

async function flush() {
  await flushPromises();
  await useSyncStore().flush();
  await flushPromises();
}

function spyExchange(transport: BaseTransport) {
  const frames: number[][] = [];
  const target = transport as unknown as { exchange: (frame: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
  const orig = target.exchange.bind(transport);
  vi.spyOn(target, 'exchange').mockImplementation((frame: Uint8Array, timeoutMs?: number) => {
    frames.push(Array.from(frame));
    return orig(frame, timeoutMs);
  });
  return {
    frames,
    clear: () => { frames.length = 0; },
    perfWritesFor: (key: PhysicalKey) => frames.filter((f) => f[0] === 0x04 && f[1] === 0x02 && f[2] === key.row && f[3] === key.col),
    perfReadsFor: (key: PhysicalKey) => frames.filter((f) => f[0] === 0x04 && f[1] === 0x01 && f[2] === key.row && f[3] === key.col),
  };
}

async function seedBoardKey(mock: MockTransport, key: PhysicalKey, patch: Partial<Performance>) {
  const cur = await mock.getPerformance(key);
  const next: Performance = { ...cur, ...patch };
  const profiles = (mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number }).profiles;
  const active = (mock as unknown as { active: number }).active;
  profiles[active].perf.set(`${key.row}:${key.col}`, encodePerformance({ row: 0, col: 0 }, next).slice(4, 20));
}

/**
 * Minimal mocked Max transport (subclasses BaseTransport without touching src/protocol/mock.ts):
 * stores 04 02 frames verbatim (tying normalRelease = normalPress as firmware does) and echoes them on 04 01.
 */
class MockedMaxTransport extends BaseTransport {
  readonly kind = 'mock' as const;
  readonly productName = 'AE64-MAX (mocked test)';
  readonly productId = 0x0013;
  private open = true;
  private readonly perf = new Map<string, number[]>();
  private readonly inner = new MockTransport({ seed: 'max', latencyMs: 0 });

  get connected(): boolean { return this.open; }
  async close(): Promise<void> { this.open = false; await this.inner.close(); }

  protected async exchange(frame: Uint8Array): Promise<Bytes> {
    if (frame[0] === 0x04 && frame[1] === 0x02) {
      const k = `${frame[2]}:${frame[3]}`;
      const rec = Array.from(frame.slice(4, 20));
      rec[3] = rec[1];
      rec[4] = rec[2];
      this.perf.set(k, rec);
      return new Uint8Array(frame);
    }
    if (frame[0] === 0x04 && frame[1] === 0x01) {
      const k = `${frame[2]}:${frame[3]}`;
      const stored = this.perf.get(k);
      const reply = await (this.inner as unknown as { exchange: (f: Uint8Array) => Promise<Bytes> }).exchange(frame);
      if (!stored) return reply;
      const out = new Uint8Array(reply);
      out.set(stored, 4);
      return out;
    }
    return (this.inner as unknown as { exchange: (f: Uint8Array) => Promise<Bytes> }).exchange(frame);
  }
}

describe('FST M1/M2: perfMinMm and LIMITS', () => {
  it('follows board precision (Max 0.001, Pro 0.01, unreported/0 -> 0.001) and LIMITS has minMm only', () => {
    expect(perfMinMm(0.001)).toBe(0.001);
    expect(perfMinMm(0.01)).toBe(0.01);
    expect(perfMinMm(0)).toBe(0.001);
    expect(perfMinMm(NaN)).toBe(0.001);
    expect(perfMinMm(0.0004)).toBe(0.001);
    expect(LIMITS).toEqual({ minMm: 0.001, rtMax: 2.0, deadMax: 1.0 });
    expect('actuationMin' in LIMITS).toBe(false);
    expect('rtMin' in LIMITS).toBe(false);
  });
});

describe('FST test 17: writes of 0.001 at frame level (demo Max and mocked Max transport, N2)', () => {
  async function runScenario(useMockedTransport: boolean) {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    if (useMockedTransport) {
      await device.adoptFromFirmware(new MockedMaxTransport(), true);
    } else {
      await device.connectDemo('max');
    }
    const transport = device.transport as BaseTransport;
    const perf = usePerformanceStore();
    await perf.load(true);
    const sync = useSyncStore();
    const ex = spyExchange(transport);

    // 1) RT mode: set actuation 0.001, then RT press 0.001 and RT release 0.001
    perf.apply([Q.id], () => ({ mode: 1, normalPress: 0.001, rtFirstTouch: 0.001 }), 'act');
    await flush();
    expect(sync.state).toBe('saved');
    expect(ex.perfWritesFor(Q)).toHaveLength(1);
    expect(ex.perfReadsFor(Q)).toHaveLength(1);

    ex.clear();
    perf.apply([Q.id], () => ({ rtPress: 0.001, rtRelease: 0.001 }), 'rt');
    await flush();
    expect(sync.state).toBe('saved');
    expect(ex.perfWritesFor(Q)).toHaveLength(1);
    expect(ex.perfReadsFor(Q)).toHaveLength(1);
    // All 5 fields carry 1 µm (01 00)
    expect(ex.perfWritesFor(Q)[0].slice(5, 15)).toEqual([0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00, 0x01, 0x00]);
    expect(perf.values[Q.id]).toMatchObject({ mode: 1, normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001 });

    // Keycap display: sublabel "0.001" and RT tag title names 0.001 / 0.001
    const dec = capDecimals(device.rtPrecision);
    expect(actSublabel(perf.values[Q.id], dec)).toBe('0.001');
    expect(actBadgeTitle(perf.values[Q.id], dec)).toBe(t('perf.rtTagTitle', { press: '0.001', release: '0.001' }));

    // Also mount TravelTab with real KeyboardView to confirm the rendered keycap reads "0.001"
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    const cap = document.body.querySelector<HTMLElement>(`.kb__key[data-key="${Q.id}"]`)!;
    expect(cap.querySelector('.cap__sub')?.textContent).toBe('0.001');
    expect(cap.querySelector('.cap__badge')?.getAttribute('title')).toBe(t('perf.rtTagTitle', { press: '0.001', release: '0.001' }));
    w.unmount();
    w = null;

    // 2) Standard mode: set normalPress 0.001 on W
    ex.clear();
    perf.apply([W.id], () => ({ mode: 0, normalPress: 0.001, rtFirstTouch: 0.001 }), 'std');
    await flush();
    expect(sync.state).toBe('saved');
    expect(ex.perfWritesFor(W)).toHaveLength(1);
    expect(ex.perfReadsFor(W)).toHaveLength(1);
    expect(ex.perfWritesFor(W)[0][4]).toBe(0);
    expect(ex.perfWritesFor(W)[0].slice(5, 9)).toEqual([0x01, 0x00, 0x01, 0x00]);
    expect(perf.values[W.id]).toMatchObject({ mode: 0, normalPress: 0.001, normalRelease: 0.001 });
    expect(actSublabel(perf.values[W.id], dec)).toBe('0.001');

    await device.disconnect();
  }

  it('demo Max writes 1 µm frames, verifies with 1 write + 1 read, and displays 0.001 on keycap and RT tag', async () => {
    await runScenario(false);
  });

  it('mocked Max transport writes 1 µm frames, verifies with 1 write + 1 read, and displays 0.001 on keycap and RT tag', async () => {
    await runScenario(true);
  });
});

describe('FST test 18: presets and import (N6)', () => {
  const base = { id: 'p1', name: 'Ultra', mode: 1 as const, continuous: true, actuation: 0.001, rtPress: 0.001, rtRelease: 0.001, deadTop: 0, deadBottom: 0 };

  it('sanitizePreset keeps 0.001 and raises 0 / 0.0004 to 0.001; presetsValid refuses 0 / 0.0004 and accepts 0.001 / 0.05', () => {
    expect(sanitizePreset(base)).toMatchObject({ actuation: 0.001, rtPress: 0.001, rtRelease: 0.001 });
    expect(sanitizePreset({ ...base, actuation: 0, rtPress: 0, rtRelease: 0.0004 })).toMatchObject({
      actuation: 0.001, rtPress: 0.001, rtRelease: 0.001,
    });

    expect(presetsValid(JSON.stringify([base]))).toBe(true);
    expect(presetsValid(JSON.stringify([{ ...base, actuation: 0.05, rtPress: 0.05, rtRelease: 0.05 }]))).toBe(true);
    expect(presetsValid(JSON.stringify([{ ...base, actuation: 0 }]))).toBe(false);
    expect(presetsValid(JSON.stringify([{ ...base, rtPress: 0 }]))).toBe(false);
    expect(presetsValid(JSON.stringify([{ ...base, rtRelease: 0.0004 }]))).toBe(false);
    expect(presetsValid(JSON.stringify([{ ...base, actuation: 0.0004 }]))).toBe(false);
  });

  it('saving a preset from a key at 0.001 stores 0.001, and applying it on a Pro (0.01) writes 0.01', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load(true);
    perf.apply([Q.id], () => ({ mode: 1, normalPress: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001 }), 'setup');
    await flush();

    // Save from TravelTab with Q selected
    useSelectionStore().selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    const saveOpenBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.presets__save button')][0]!;
    saveOpenBtn.click();
    await flushPromises();
    const nameInput = document.body.querySelector<HTMLInputElement>('.save__input')!;
    nameInput.value = 'Min001';
    nameInput.dispatchEvent(new Event('input'));
    await flushPromises();
    document.body.querySelector<HTMLFormElement>('form.save')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flushPromises();

    const stored = useUserPresetsStore().presets.find((p) => p.name === 'Min001');
    expect(stored).toMatchObject({ actuation: 0.001, rtPress: 0.001, rtRelease: 0.001 });
    w.unmount();
    w = null;

    // Now connect Pro (rtPrecision 0.01) and apply the saved 0.001 preset (and a 0.005 preset) -> writes 0.01
    await device.connectDemo('pro');
    device.rtPrecision = 0.01;
    await perf.load(true);
    useSelectionStore().selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();

    const presetBtn = [...document.body.querySelectorAll<HTMLButtonElement>('.saved .preset')].find((b) => b.textContent?.includes('Min001'))!;
    presetBtn.click();
    await flush();
    expect(perf.values[Q.id]).toMatchObject({ normalPress: 0.01, normalRelease: 0.01, rtFirstTouch: 0.01, rtPress: 0.01, rtRelease: 0.01 });

    // Also test a 0.005 preset on Pro -> writes 0.01
    useUserPresetsStore().add('Mid005', { mode: 1, continuous: true, actuation: 0.005, rtPress: 0.005, rtRelease: 0.005, deadTop: 0.1, deadBottom: 0.1 });
    await flushPromises();
    const btn005 = [...document.body.querySelectorAll<HTMLButtonElement>('.saved .preset')].find((b) => b.textContent?.includes('Mid005'))!;
    btn005.click();
    await flush();
    expect(perf.values[Q.id]).toMatchObject({ normalPress: 0.01, rtFirstTouch: 0.01, rtPress: 0.01, rtRelease: 0.01 });
  });
});

describe('FST test 19: profile restore floor (M4(d), N7 both halves)', () => {
  it('has exact diagnostics.vBelowMin strings in vi and en', () => {
    expect(diagnosticsVi['diagnostics.vBelowMin']).toBe(
      'giá trị hành trình {field} = {value} ở phím {key} nhỏ hơn mức thấp nhất bàn phím này nhận ({min} mm)',
    );
    expect(diagnosticsEn['diagnostics.vBelowMin']).toBe(
      'travel value {field} = {value} at key {key} is below the lowest value this keyboard takes ({min} mm)',
    );
  });

  it('Max demo: accepts rtPress 0.001, refuses 0.0004 with vBelowMin, refuses normalPress 0.0004 in both modes, accepts unchanged Standard RT=0', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    // Seed W as Standard with RT fields = 0 (as a board never put in RT might report)
    await seedBoardKey(mock, W, { mode: 0, normalPress: 2.0, normalRelease: 2.0, rtFirstTouch: 0, rtPress: 0, rtRelease: 0 });
    const diag = useDiagnosticsStore();
    const base = await diag.generateBackup();

    // 1) File with rtPress 0.001 on Q -> accepted and written
    const ok001 = structuredClone(base);
    ok001.performance[Q.id] = { ...ok001.performance[Q.id], mode: 1, normalPress: 0.001, normalRelease: 0.001, rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001 };
    const diff001 = await diag.parseAndDiffBackup(JSON.stringify(ok001));
    expect(diff001.refused).toBeNull();
    expect(diff001.perfDiffCount).toBe(1);
    await diag.applyRestore(diff001);
    expect(usePerformanceStore().values[Q.id]).toMatchObject({ rtFirstTouch: 0.001, rtPress: 0.001, rtRelease: 0.001 });

    // 2) File with rtPress 0.0004 on Q -> refused with vBelowMin (kills N7 half 1)
    const badRt = structuredClone(base);
    badRt.performance[Q.id] = { ...badRt.performance[Q.id], mode: 1, rtPress: 0.0004 };
    const diffBadRt = await diag.parseAndDiffBackup(JSON.stringify(badRt));
    const expectedRtMsg = t('diagnostics.vRefused', { msg: t('diagnostics.vBelowMin', { field: 'rtPress', value: '0.0004', key: Q.name, min: '0.001' }) });
    expect(diffBadRt.refused).toBe(expectedRtMsg);
    await expect(diag.applyRestore(diffBadRt)).rejects.toThrow(RestoreRefusedError);

    // 3) normalPress 0.0004 refused in both RT (mode 1) and Standard (mode 0)
    for (const mode of [0, 1] as const) {
      const badNorm = structuredClone(base);
      badNorm.performance[Q.id] = { ...badNorm.performance[Q.id], mode, normalPress: 0.0004 };
      const d = await diag.parseAndDiffBackup(JSON.stringify(badNorm));
      const expected = t('diagnostics.vRefused', { msg: t('diagnostics.vBelowMin', { field: 'normalPress', value: '0.0004', key: Q.name, min: '0.001' }) });
      expect(d.refused, `mode ${mode}`).toBe(expected);
    }

    // 4) Standard key W whose file RT fields are 0 and equal to the keyboard's is accepted when normalPress changes
    const stdZero = structuredClone(base);
    stdZero.performance[W.id] = { ...stdZero.performance[W.id], mode: 0, normalPress: 1.5, normalRelease: 1.5, rtFirstTouch: 0, rtPress: 0, rtRelease: 0 };
    const diffStd = await diag.parseAndDiffBackup(JSON.stringify(stdZero));
    expect(diffStd.refused).toBeNull();
    await diag.applyRestore(diffStd);
    expect(usePerformanceStore().values[W.id]).toMatchObject({ mode: 0, normalPress: 1.5, rtPress: 0, rtRelease: 0 });
  });

  it('Pro demo (rtPrecision 0.01): refuses changed rtPress 0.005 with vBelowMin, accepts unchanged rtPress 0.005 (N7 both halves)', async () => {
    const device = useDeviceStore();
    await device.connectDemo('pro');
    device.rtPrecision = 0.01;
    const mock = device.transport as MockTransport;
    // Key W already holds off-grid 0.005 on the board
    await seedBoardKey(mock, W, { mode: 1, rtPress: 0.005, rtRelease: 0.005 });
    const diag = useDiagnosticsStore();
    const base = await diag.generateBackup();

    // Changed value 0.005 on Q (keyboard holds 0.8) -> refused with min = 0.01 (kills N3 + N7 half 1)
    const badPro = structuredClone(base);
    badPro.performance[Q.id] = { ...badPro.performance[Q.id], mode: 1, rtPress: 0.005 };
    const diffBad = await diag.parseAndDiffBackup(JSON.stringify(badPro));
    const expected = t('diagnostics.vRefused', { msg: t('diagnostics.vBelowMin', { field: 'rtPress', value: '0.005', key: Q.name, min: '0.01' }) });
    expect(diffBad.refused).toBe(expected);

    // Unchanged value 0.005 on W (keyboard already holds 0.005; only deadzone changes) -> accepted (kills N7 half 2)
    const unchangedPro = structuredClone(base);
    unchangedPro.performance[W.id] = { ...unchangedPro.performance[W.id], pressDeadStroke: 0.2 };
    const diffOk = await diag.parseAndDiffBackup(JSON.stringify(unchangedPro));
    expect(diffOk.refused).toBeNull();
    await diag.applyRestore(diffOk);
    expect(usePerformanceStore().values[W.id]).toMatchObject({ rtPress: 0.005, pressDeadStroke: 0.2 });
  });
});
