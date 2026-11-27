// DESIGN FST §10.2 M8, §10.3 & §10.6 tests 22–23 + mutants N9, N10:
// narrow floor-raise acceptance in performance.ts jobFor().verify, perf.keptNotices lifecycle & UI,
// newer-edit preservation (N10), and mismatch rejection for ignored/high/deadzone writes (N9).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { BaseTransport, MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Bytes, PhysicalKey } from '../src/protocol';
import { le16, read16 } from '../src/protocol/codec';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { useSyncStore } from '../src/stores/sync';
import { t } from '../src/i18n/vi';
import { setLocale } from '../src/i18n/locale';

const keyByName = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const Q = keyByName('Q');
const W = keyByName('W');

type BoardMode = 'clampRt01' | 'clampAll01' | 'ignore' | 'store02' | 'alsoDeadzone' | 'lower';

/**
 * Test-only mocked Max transport simulating boards that alter or ignore 04 02 writes on read-back.
 * Wraps MockTransport without modifying src/protocol/mock.ts.
 */
class KeptTestTransport extends BaseTransport {
  readonly kind = 'mock' as const;
  readonly productName = 'AE64-MAX (kept test)';
  readonly productId = 0x0013;
  private open = true;
  private readonly inner = new MockTransport({ seed: 'max', latencyMs: 0 });
  readonly frames: number[][] = [];
  mode: BoardMode;
  /** Optional gate held before answering the next 04 01 read-back for a key (used for N10). */
  holdNextRead: ((keyPos: string) => Promise<void>) | null = null;

  constructor(mode: BoardMode) {
    super();
    this.mode = mode;
  }

  get connected(): boolean { return this.open; }
  async close(): Promise<void> { this.open = false; await this.inner.close(); }

  private innerExchange(frame: Uint8Array): Promise<Bytes> {
    return (this.inner as unknown as { exchange: (f: Uint8Array) => Promise<Bytes> }).exchange(frame);
  }

  protected async exchange(frame: Uint8Array): Promise<Bytes> {
    this.frames.push(Array.from(frame));
    if (frame[0] === 0x04 && frame[1] === 0x02) {
      if (this.mode === 'ignore') {
        // Acknowledge frame without updating stored values
        return new Uint8Array(frame);
      }
      const mod = new Uint8Array(frame);
      const setU16 = (off: number, um: number) => {
        const [lo, hi] = le16(um);
        mod[off] = lo;
        mod[off + 1] = hi;
      };
      if (this.mode === 'clampRt01') {
        for (const off of [11, 13]) {
          const um = read16(mod, off);
          if (um < 10) setU16(off, 10);
        }
      } else if (this.mode === 'clampAll01') {
        for (const off of [5, 7, 9, 11, 13]) {
          const um = read16(mod, off);
          if (um < 10) setU16(off, 10);
        }
      } else if (this.mode === 'store02') {
        if (read16(mod, 11) < 10) setU16(11, 200); // 0.2 mm (above 0.1 ceiling)
      } else if (this.mode === 'alsoDeadzone') {
        if (read16(mod, 11) < 10) setU16(11, 10);
        setU16(15, read16(mod, 15) + 100); // deadzone changes too
      } else if (this.mode === 'lower') {
        if (read16(mod, 11) > 10) setU16(11, 10); // lower than written
      }
      return this.innerExchange(mod);
    }
    if (frame[0] === 0x04 && frame[1] === 0x01 && this.holdNextRead) {
      const k = `${frame[2]}:${frame[3]}`;
      const gate = this.holdNextRead;
      this.holdNextRead = null;
      await gate(k);
    }
    return this.innerExchange(frame);
  }

  writesFor(key: PhysicalKey) {
    return this.frames.filter((f) => f[0] === 0x04 && f[1] === 0x02 && f[2] === key.row && f[3] === key.col);
  }
  readsFor(key: PhysicalKey) {
    return this.frames.filter((f) => f[0] === 0x04 && f[1] === 0x01 && f[2] === key.row && f[3] === key.col);
  }
  clearFrames() { this.frames.length = 0; }
}

let w: VueWrapper | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setLocale('vi');
  setActivePinia(createPinia());
});

afterEach(async () => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  await useDeviceStore().disconnect();
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

async function boot(mode: BoardMode) {
  const device = useDeviceStore();
  const transport = new KeptTestTransport(mode);
  await device.adoptFromFirmware(transport, true);
  const perf = usePerformanceStore();
  await perf.load(true);
  transport.clearFrames();
  return { device, transport, perf, sync: useSyncStore(), sel: useSelectionStore() };
}

describe('FST test 22: M8 accepted floor raise, perf.kept line, clearing, and newer-edit win (N10)', () => {
  it('stores max(v, 0.01) with 1 write + 1 read, no retry/error, shows perf.kept line, merges keys, and clears on × / exact write / load / profile change', async () => {
    const { device, transport, perf, sync, sel } = await boot('clampRt01');
    sel.selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();
    transport.clearFrames();

    // Before any notice: role="status" exists inside .kept and is empty
    const keptWrap = () => document.body.querySelector<HTMLElement>('.kept');
    const statusNode = () => document.body.querySelector<HTMLElement>('.kept [role="status"]');
    const closeBtnEl = () => document.body.querySelector<HTMLButtonElement>(`.kept button[aria-label="${t('perf.keptHide')}"]`);
    const statusEl = statusNode();
    expect(statusEl).not.toBeNull();
    expect(statusEl!.textContent).toBe('');

    // Write rtPress = 0.001 on Q -> board stores 0.01: 1 write, 1 read, no retry, saved
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();

    expect(sync.state).toBe('saved');
    expect(sync.lastError).toBeNull();
    expect(transport.writesFor(Q)).toHaveLength(1);
    expect(transport.readsFor(Q)).toHaveLength(1);
    expect(perf.values[Q.id].rtPress).toBe(0.01);
    expect(perf.keptNotices).toEqual([{ field: 'rtPress', wanted: 0.001, got: 0.01, ids: [Q.id] }]);

    // Same role="status" DOM node now holds the notice text
    expect(statusNode()).toBe(statusEl);
    expect(statusEl!.textContent).toBe(t('perf.kept', { field: t('perf.rtPress'), got: '0.01', wanted: '0.001', n: 1 }));

    // Same wanted/got on W merges W into ids (2 keys)
    perf.apply([W.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();
    expect(perf.keptNotices).toEqual([{ field: 'rtPress', wanted: 0.001, got: 0.01, ids: [Q.id, W.id].sort((a, b) => a - b) }]);
    expect(statusEl!.textContent).toContain(t('perf.kept', { field: t('perf.rtPress'), got: '0.01', wanted: '0.001', n: 2 }));

    // Clicking × button clears the notice while keeping the status element
    closeBtnEl()!.click();
    await flushPromises();
    expect(perf.keptNotices).toEqual([]);
    expect(closeBtnEl()).toBeNull();
    expect(statusEl!.textContent).toBe('');
    expect(keptWrap()!.classList.contains('kept--empty')).toBe(true);

    // Re-trigger on Q and W, then an exact write on Q clears only Q; exact write on W clears the entry
    perf.apply([Q.id, W.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();
    expect(perf.keptNotices[0].ids).toHaveLength(2);

    perf.apply([Q.id], () => ({ rtPress: 0.3 }), 'rt');
    await flush();
    expect(perf.keptNotices).toEqual([{ field: 'rtPress', wanted: 0.001, got: 0.01, ids: [W.id] }]);

    perf.apply([W.id], () => ({ rtPress: 0.3 }), 'rt');
    await flush();
    expect(perf.keptNotices).toEqual([]);

    // Notice also shows on Pro (decimals === 2, where .fst row is hidden) and clears on load() and profile change
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();
    device.rtPrecision = 0.01;
    await flushPromises();
    expect(document.body.querySelector('.fst')).toBeNull();
    expect(statusEl!.textContent).not.toBe('');
    expect(closeBtnEl()).not.toBeNull();

    await perf.load(true);
    expect(perf.keptNotices).toEqual([]);

    device.rtPrecision = 0.001;
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();
    expect(perf.keptNotices).toHaveLength(1);
    await device.switchProfile(1);
    expect(perf.keptNotices).toEqual([]);
  });

  it('a newer edit queued before the read-back finishes is NOT overwritten by the raised read value (N10)', async () => {
    const { transport, perf, sync } = await boot('clampRt01');

    let releaseRead!: () => void;
    let readStarted!: () => void;
    const readInFlight = new Promise<void>((resolve) => { readStarted = resolve; });
    transport.holdNextRead = () => {
      readStarted();
      return new Promise<void>((resolve) => { releaseRead = resolve; });
    };

    // First edit: write 0.001 (mock clamps to 0.01)
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'first');
    const firstFlush = sync.flush();
    await readInFlight;

    // While 04 01 read-back is still in flight, queue a newer edit (0.25)
    perf.apply([Q.id], () => ({ rtPress: 0.25 }), 'newer');
    expect(perf.values[Q.id].rtPress).toBe(0.25);

    // Release the first read-back (which returns 0.01)
    releaseRead();
    await firstFlush;
    await flushPromises();

    // Shown value must STILL be 0.25 (never reverted to 0.01 by the older read-back!)
    expect(perf.values[Q.id].rtPress).toBe(0.25);

    // Flushing the newer edit saves 0.25 and clears Q's rtPress kept notice
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id].rtPress).toBe(0.25);
    expect(perf.keptNotices).toEqual([]);
  });

  it('maps normalPress / normalRelease / rtFirstTouch raises to a single "act" notice', async () => {
    const { perf, sync } = await boot('clampAll01');
    perf.apply([Q.id], () => ({ normalPress: 0.001, rtFirstTouch: 0.001 }), 'act');
    await flush();
    expect(sync.state).toBe('saved');
    expect(perf.values[Q.id]).toMatchObject({ normalPress: 0.01, normalRelease: 0.01, rtFirstTouch: 0.01 });
    expect(perf.keptNotices).toEqual([{ field: 'act', wanted: 0.001, got: 0.01, ids: [Q.id] }]);
  });
});

describe('FST test 23: M8 rejects non-floor mismatches as "Not saved" (N9)', () => {
  it('mock ignores write (reads back old 0.30) -> Not saved, 0 keptNotices, reverts to 0.30', async () => {
    const { transport, perf, sync } = await boot('ignore');
    // Seed Q to 0.30 first using a normal write
    transport.mode = 'clampRt01';
    perf.apply([Q.id], () => ({ rtPress: 0.3 }), 'seed');
    await flush();
    transport.mode = 'ignore';

    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    // Attempt 1 rejects with sync error ("Not saved"), no keptNotices
    await expect(sync.flush()).rejects.toThrow();
    expect(sync.state).toBe('error');
    expect(perf.keptNotices).toEqual([]);
    // Exhaust remaining retries so the job drops and onDrop reverts to 0.30
    for (let i = 0; i < 2; i++) await sync.flush().catch(() => undefined);
    await flushPromises();

    expect(sync.lastProblem).toBeTruthy();
    expect(perf.keptNotices).toEqual([]);
    expect(perf.values[Q.id].rtPress).toBe(0.3);
  });

  it('mock stores 0.2 for 0.001 (above 0.1 ceiling) -> Not saved, 0 keptNotices', async () => {
    const { perf, sync } = await boot('store02');
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await expect(sync.flush()).rejects.toThrow();
    await flushPromises();

    expect(sync.state).toBe('error');
    expect(perf.keptNotices).toEqual([]);
  });

  it('mock clamps rtPress to 0.01 AND changes a deadzone -> Not saved, 0 keptNotices', async () => {
    const { perf, sync } = await boot('alsoDeadzone');
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await expect(sync.flush()).rejects.toThrow();
    await flushPromises();

    expect(sync.state).toBe('error');
    expect(perf.keptNotices).toEqual([]);
  });

  it('mock stores lower than written (0.01 for 0.05) -> Not saved, 0 keptNotices', async () => {
    const { perf, sync } = await boot('lower');
    perf.apply([Q.id], () => ({ rtPress: 0.05 }), 'rt');
    await expect(sync.flush()).rejects.toThrow();
    await flushPromises();

    expect(sync.state).toBe('error');
    expect(perf.keptNotices).toEqual([]);
  });
});

describe('FST test 25: .kept live region stability, × outside status, empty class, and focus handoff (N12)', () => {
  it('keeps role="status" always mounted, × outside it, .kept--empty when clear, and hands focus on after × (Max and Pro)', async () => {
    const { device, perf, sel } = await boot('clampRt01');
    sel.selectMany([Q.id]);
    ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
    await flushPromises();

    const kept = document.body.querySelector<HTMLElement>('.kept')!;
    const statusEl = kept.querySelector<HTMLElement>('[role="status"]')!;
    expect(kept).not.toBeNull();
    expect(statusEl).not.toBeNull();
    expect(statusEl.textContent).toBe('');
    expect(kept.classList.contains('kept--empty')).toBe(true);

    // Trigger a kept notice on Max
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();

    expect(kept.classList.contains('kept--empty')).toBe(false);
    expect(statusEl.textContent).toBe(t('perf.kept', { field: t('perf.rtPress'), got: '0.01', wanted: '0.001', n: 1 }));
    const closeBtn = kept.querySelector<HTMLButtonElement>(`button[aria-label="${t('perf.keptHide')}"]`)!;
    expect(closeBtn).not.toBeNull();
    expect(statusEl.contains(closeBtn)).toBe(false);

    // Focus × and activate with keyboard (Enter + click) -> focus moves to FST switch on Max
    closeBtn.focus();
    expect(document.activeElement).toBe(closeBtn);
    closeBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    closeBtn.click();
    await flushPromises();

    expect(perf.keptNotices).toEqual([]);
    expect(kept.classList.contains('kept--empty')).toBe(true);
    const fstSwitch = document.body.querySelector<HTMLElement>('.fst [role="switch"]');
    expect(fstSwitch).not.toBeNull();
    expect(document.activeElement).toBe(fstSwitch);
    expect(document.activeElement).not.toBe(document.body);

    // Pro (rtPrecision = 0.01, no .fst row): focus moves to a control inside .grid, never body
    perf.apply([Q.id], () => ({ rtPress: 0.001 }), 'rt');
    await flush();
    device.rtPrecision = 0.01;
    await flushPromises();
    expect(document.body.querySelector('.fst')).toBeNull();
    const proCloseBtn = kept.querySelector<HTMLButtonElement>(`button[aria-label="${t('perf.keptHide')}"]`)!;
    proCloseBtn.focus();
    expect(document.activeElement).toBe(proCloseBtn);
    proCloseBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    proCloseBtn.click();
    await flushPromises();

    const grid = document.body.querySelector<HTMLElement>('.grid')!;
    expect(document.activeElement).not.toBe(document.body);
    expect(grid.contains(document.activeElement)).toBe(true);
  });
});
