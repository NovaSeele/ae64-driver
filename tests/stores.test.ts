import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS, SAVE_GROUP } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore, SYNC_DEBOUNCE_MS } from '../src/stores/sync';
import { useSelectionStore } from '../src/stores/selection';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import type { SaveGroup } from '../src/protocol';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

async function connectMock(): Promise<MockTransport> {
  const device = useDeviceStore();
  await device.connectDemo();
  return device.transport as MockTransport;
}

describe('sync store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('coalesces jobs by key, debounces, commits once per group, then verifies', async () => {
    const mock = await connectMock();
    const sync = useSyncStore();
    const commit = vi.spyOn(mock, 'commit');
    const calls: string[] = [];
    vi.useFakeTimers();

    const job = (key: string, group: SaveGroup, tag: string) => ({
      key, group, label: tag,
      write: async () => { calls.push(`w:${tag}`); },
      verify: async () => { calls.push(`v:${tag}`); return true; },
    });
    sync.enqueue(job('perf:1', SAVE_GROUP.PERFORMANCE, 'a1'));
    sync.enqueue(job('perf:1', SAVE_GROUP.PERFORMANCE, 'a2')); // replaces a1
    sync.enqueue(job('perf:2', SAVE_GROUP.PERFORMANCE, 'b'));
    sync.enqueue(job('light', SAVE_GROUP.LIGHTING, 'c'));
    expect(sync.state).toBe('pending');

    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS - 50);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);

    expect(calls).toEqual(['w:a2', 'w:b', 'w:c', 'v:a2', 'v:b', 'v:c']);
    expect(commit.mock.calls.map((c) => c[0])).toEqual([SAVE_GROUP.PERFORMANCE, SAVE_GROUP.LIGHTING]);
    expect(sync.state).toBe('saved');
  });

  it('debounce restarts on every enqueue', async () => {
    await connectMock();
    const sync = useSyncStore();
    const write = vi.fn(async () => undefined);
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) {
      sync.enqueue({ key: 'k', group: SAVE_GROUP.PERFORMANCE, label: 'k', write });
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(write).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('reports verify failures as error and retries the failed jobs', async () => {
    await connectMock();
    const sync = useSyncStore();
    let ok = false;
    const write = vi.fn(async () => undefined);
    sync.enqueue({ key: 'x', group: SAVE_GROUP.MACRO, label: 'Macro 1', write, verify: async () => ok });
    await expect(sync.flush()).rejects.toThrow(/Macro 1/);
    expect(sync.state).toBe('error');
    expect(sync.lastError).toMatch(/Macro 1/);
    ok = true;
    await sync.retry();
    expect(write).toHaveBeenCalledTimes(2);
    expect(sync.state).toBe('saved');
  });

  it('performance edits write, commit group 2, verify and preserve axis fields', async () => {
    const mock = await connectMock();
    const perf = usePerformanceStore();
    await perf.load();
    expect(Object.keys(perf.values)).toHaveLength(64);
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const commit = vi.spyOn(mock, 'commit');

    perf.apply([W.id, A.id], () => ({ rtPress: 0.25, rtRelease: 0.25 }), 'RT');
    expect(perf.values[W.id].rtPress).toBe(0.25);
    await useSyncStore().flush();

    expect(setPerf).toHaveBeenCalledTimes(2);
    expect(setPerf.mock.calls[0][1]).toMatchObject({ rtPress: 0.25, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500, calibrate: 1 });
    expect(commit.mock.calls.map((c) => c[0])).toEqual([SAVE_GROUP.PERFORMANCE]);
    expect((await mock.getPerformance(W)).rtPress).toBe(0.25);
    expect(useSyncStore().state).toBe('saved');

    // Undo re-applies the previous values through the same path.
    useHistoryStore().undo();
    await useSyncStore().flush();
    expect((await mock.getPerformance(W)).rtPress).toBe(0.8);
    useHistoryStore().redo();
    await useSyncStore().flush();
    expect((await mock.getPerformance(A)).rtRelease).toBe(0.25);
  });

  it('clamps values to the key range and rounds to RT precision', async () => {
    await connectMock();
    const perf = usePerformanceStore();
    await perf.load();
    perf.apply([W.id], () => ({ rtFirstTouch: 9, rtPress: 0.12345 }), 'x');
    expect(perf.values[W.id].rtFirstTouch).toBe(3.31);
    expect(perf.values[W.id].rtPress).toBe(0.123);
    await useSyncStore().flush();
  });
});

describe('history store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('undo/redo and coalescing', () => {
    const h = useHistoryStore();
    let v = 0;
    const set = (to: number, from: number, coalesce?: string) => { v = to; h.push({ label: 'v', undo: () => { v = from; }, redo: () => { v = to; }, coalesce }); };
    set(1, 0, 'drag');
    set(2, 1, 'drag');
    set(3, 2, 'drag');
    expect(h.canUndo).toBe(true);
    h.undo();
    expect(v).toBe(0); // whole gesture undone at once
    expect(h.canRedo).toBe(true);
    h.redo();
    expect(v).toBe(3);
    set(4, 3);
    expect(h.canRedo).toBe(false);
  });

  it('keyboard shortcuts Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z', () => {
    const h = useHistoryStore();
    let v = 1;
    h.push({ label: 'v', undo: () => { v = 0; }, redo: () => { v = 1; } });
    const remove = h.installShortcuts(window);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    expect(v).toBe(0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true }));
    expect(v).toBe(1);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', ctrlKey: true, shiftKey: true }));
    expect(v).toBe(1);
    remove();
  });
});

describe('selection store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('replace / toggle / range', () => {
    const s = useSelectionStore();
    s.select(5);
    expect(s.ids).toEqual([5]);
    s.select(7, 'toggle');
    expect(s.ids).toEqual([5, 7]);
    s.select(5, 'toggle');
    expect(s.ids).toEqual([7]);
    s.select(10, 'range'); // from focused 5 (last clicked) .. 10, added
    expect(s.ids).toEqual([5, 6, 7, 8, 9, 10]);
    expect(s.focused).toBe(10);
  });

  it('selectMany, all, invert, wasd, clear', () => {
    const s = useSelectionStore();
    s.selectMany([1, 2, 3]);
    s.selectMany([3, 4], 'toggle');
    expect(s.ids).toEqual([1, 2, 4]);
    s.selectMany([10, 11], 'range');
    expect(s.ids).toEqual([1, 2, 4, 10, 11]);
    s.all();
    expect(s.count).toBe(64);
    s.selectMany([0, 1]);
    s.invert();
    expect(s.count).toBe(62);
    expect(s.selected.has(0)).toBe(false);
    s.wasd();
    expect(s.ids.map((id) => PHYSICAL_KEYS[id].name).sort()).toEqual(['A', 'D', 'S', 'W']);
    s.clear();
    expect(s.count).toBe(0);
  });
});
