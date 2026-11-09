import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;
const UR = { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 };
const APOLLO = { axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 };

async function setup() {
  const device = useDeviceStore();
  await device.connectDemo();
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  return { mock, perf };
}

describe('switch selector store', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('applies a switch, clamps long travel and undoes it; nothing is written before apply', async () => {
    const { mock, perf } = await setup();
    expect(perf.catalog).not.toBeNull();
    expect(perf.switchOf(W.id)?.name).toBe('UR冰磁轴');
    const apollo = findSwitch(perf.catalog, 4208)!;

    // Give W values above 3.13 mm; A stays below.
    perf.apply([W.id], () => ({ normalPress: 3.3, normalRelease: 3.25, mode: 0 }), 'long');
    await useSyncStore().flush();
    const wBefore = await mock.getPerformance(W);
    const aBefore = await mock.getPerformance(A);
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const commit = vi.spyOn(mock, 'commit');

    const plan = perf.planSwitch([W.id, A.id], apollo);
    expect(plan.keys).toEqual([W.id, A.id]);
    expect(plan.limitMm).toBe(3.13);
    expect(plan.clamped.map((c) => `${c.id}:${c.field}:${c.from}->${c.to}`)).toEqual([
      `${W.id}:normalPress:3.3->3.13`, `${W.id}:normalRelease:3.25->3.13`,
    ]);
    expect(setPerf).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    perf.applySwitch([W.id, A.id], apollo);
    expect(setPerf).not.toHaveBeenCalled(); // debounced: nothing is sent until the queue runs
    await useSyncStore().flush();
    expect(setPerf).toHaveBeenCalledTimes(2);

    const w = await mock.getPerformance(W);
    const a = await mock.getPerformance(A);
    expect(w).toMatchObject({ ...APOLLO, normalPress: 3.13, normalRelease: 3.13 });
    expect({ ...w, ...UR, normalPress: 0, normalRelease: 0 }).toEqual({ ...wBefore, normalPress: 0, normalRelease: 0 });
    expect(a).toMatchObject(APOLLO);
    expect({ ...a, ...UR }).toEqual(aBefore);
    expect(perf.switchNotices).toEqual([]);
    expect(perf.switchOf(W.id)?.name).toBe('阿波罗轴');

    useHistoryStore().undo();
    await useSyncStore().flush();
    expect(await mock.getPerformance(W)).toEqual(wBefore);
    expect(await mock.getPerformance(A)).toEqual(aBefore);

    useHistoryStore().redo();
    await useSyncStore().flush();
    expect(await mock.getPerformance(W)).toMatchObject({ ...APOLLO, normalPress: 3.13 });
  });

  it('skips keys that already have the switch', async () => {
    const { perf } = await setup();
    const ur = findSwitch(perf.catalog, 12432)!;
    const before = useHistoryStore().undoLabel;
    perf.applySwitch([W.id], ur);
    expect(useHistoryStore().undoLabel).toBe(before);
    expect(perf.planSwitch([W.id], ur).keys).toEqual([]);
  });

  it('a normal edit after a switch writes the triple the device reported', async () => {
    const { mock, perf } = await setup();
    const setPerf = vi.spyOn(mock, 'setPerformance');
    perf.applySwitch([W.id], findSwitch(perf.catalog, 4208)!);
    await useSyncStore().flush();
    setPerf.mockClear();

    perf.apply([W.id], () => ({ rtPress: 0.4 }), 'RT');
    await useSyncStore().flush();
    expect(setPerf).toHaveBeenCalledTimes(1);
    expect(setPerf.mock.calls[0][1]).toMatchObject({ ...APOLLO, rtPress: 0.4 });
  });

  it('undo while the switch write is in flight still restores the old triple', async () => {
    const { mock, perf } = await setup();
    const wBefore = await mock.getPerformance(W);
    const real = mock.setPerformance.bind(mock);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let entered!: () => void;
    const inFlight = new Promise<void>((r) => { entered = r; });
    let calls = 0;
    vi.spyOn(mock, 'setPerformance').mockImplementation(async (pos, p) => {
      if (++calls === 1) { entered(); await gate; }
      await real(pos, p);
    });

    perf.applySwitch([W.id], findSwitch(perf.catalog, 4208)!);
    const running = useSyncStore().flush();
    await inFlight; // the switch write is in flight, its verify has not run
    useHistoryStore().undo();
    release();
    await running.catch(() => undefined);
    await useSyncStore().flush();

    expect(await mock.getPerformance(W)).toEqual(wBefore);
    expect(perf.values[W.id]).toMatchObject(UR);
    expect(perf.values[W.id]).toEqual(await mock.getPerformance(W));
  });

  it('reports a notice and shows the read triple when the firmware normalises it', async () => {
    const { mock, perf } = await setup();
    const real = mock.getPerformance.bind(mock);
    const odd = { ...APOLLO, axisCoefficient: 24400 };
    let writes = 0;
    vi.spyOn(mock, 'setPerformance').mockImplementation(async () => { writes++; });
    vi.spyOn(mock, 'getPerformance').mockImplementation(async (pos) => ({ ...(await real(pos)), ...odd }));
    perf.applySwitch([W.id], findSwitch(perf.catalog, 4208)!);
    await useSyncStore().flush();
    expect(writes).toBe(1); // no retry loop
    expect(perf.switchNotices).toEqual([{ id: W.id, wanted: APOLLO, got: odd }]);
    expect(perf.values[W.id]).toMatchObject(odd);
    perf.applySwitch([A.id], findSwitch(perf.catalog, 4208)!);
    expect(perf.switchNotices).toEqual([]);
  });
});

describe('write guard memory', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('keeps the first read of a key, so its original triple stays restorable after many reads', async () => {
    const { mock, perf } = await setup();
    const apollo = findSwitch(perf.catalog, 4208)!;
    perf.applySwitch([W.id], apollo);
    await useSyncStore().flush();
    for (let i = 0; i < 12; i++) await mock.getPerformance(W);
    const seen = (mock as unknown as { perfSeen: Map<string, { axisV2Id: number }[]> }).perfSeen.get(`${W.row}:${W.col}`)!;
    expect(seen).toHaveLength(8);
    expect(seen[0].axisV2Id).toBe(UR.axisV2Id);
    expect(seen[seen.length - 1].axisV2Id).toBe(APOLLO.axisV2Id);
  });
});
