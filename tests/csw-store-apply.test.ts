// CSW step 3: Apply + swap question (Test 7, kills M10 & M11), Verify all 3 fields (Test 8, kills M7),
// Undo/Redo + lost-key undo (Test 9, kills M8 & M18), Rename only (Test 10, kills M14).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import { readyToCustomLike, setAssignments } from '../src/data/customSwitch';
import type { CustomLike } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const A = key('A');
const S = key('S');
const D = key('D');

const UR = { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 };
const FLUX_READY = READY_SWITCHES.find((s) => s.uid === 'r-wuque-ws-flux-clacky')!;
const FLUX: CustomLike = readyToCustomLike(FLUX_READY); // 3500 / 17536, curveFrom Skyline V3 (13472)
// Another ready-made entry with the exact same 3500 / 17536 (for rename-only tests)
const FLUX_TWIN_READY = READY_SWITCHES.find((s) => s.uid !== FLUX_READY.uid && s.rangeUm === 3500 && s.coefficient === 17536)!;
const FLUX_TWIN: CustomLike = readyToCustomLike(FLUX_TWIN_READY);

function spyExchange(mock: MockTransport) {
  return vi.spyOn(mock as unknown as { exchange: (frame: Uint8Array) => Promise<Uint8Array> }, 'exchange');
}

function cmdOf(frame: Uint8Array): string {
  return `${frame[0].toString(16).padStart(2, '0')} ${frame[1].toString(16).padStart(2, '0')}`;
}

function setAxis(mock: MockTransport, k: typeof W, ax: { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate?: number }) {
  const m = mock as unknown as { axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }> };
  const cur = m.axis.get(`${k.row}:${k.col}`)!;
  cur.axisV2Id = ax.axisV2Id;
  cur.axisRangeMax = ax.axisRangeMax;
  cur.axisCoefficient = ax.axisCoefficient;
  if (ax.calibrate !== undefined) cur.calibrate = ax.calibrate;
}

async function setup() {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  return { device, mock, perf };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  locale.value = 'vi';
});

afterEach(async () => {
  await useDeviceStore().disconnect({ flush: false });
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('CSW Test 7: Apply + swap question flow (kills M10, M11)', () => {
  it('idKept > 0 returns "question" with 0 HID; "back" writes nothing; "replaced" adds to recal list after verify; "notReplaced" adds nothing (kills M10 and M11)', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();
    const ex = spyExchange(mock);
    const enqueue = vi.spyOn(sync, 'enqueue');

    // First call without answer when idKept > 0: MUST return question and send 0 HID (kills M11)
    const q = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id]);
    expect(q.status).toBe('question');
    if (q.status === 'question') {
      expect(q.plan.idKept).toBe(2);
      expect(q.plan.write).toBe(2);
    }
    await sync.flush();
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(false);
    expect(perf.recalKeys).toEqual([]);
    expect(perf.assignments).toEqual({});

    // "back" writes nothing (0 HID)
    const back = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'back');
    expect(back).toEqual({ status: 'cancelled' });
    await sync.flush();
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(false);

    // "replaced": writes W×04 02 + commit + W×04 01, keeps id (board calibrate stays 1), adds to recal list AFTER verify (kills M10)
    const rep = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'replaced');
    expect(rep).toMatchObject({ status: 'applied', written: 2, renamed: 0, marked: true, idNew: 0, name: FLUX.name });
    // Before flush/verify: recalKeys and assignments are NOT set yet
    expect(perf.recalKeys).toEqual([]);
    expect(perf.assignments).toEqual({});

    await sync.flush();
    const cmds = ex.mock.calls.map(([f]) => cmdOf(f));
    expect(cmds.filter((c) => c === '04 02')).toHaveLength(2);
    expect(cmds.filter((c) => c === '02 02')).toHaveLength(1);
    expect(cmds.filter((c) => c === '04 01')).toHaveLength(2);
    // Board kept id 12432 and calibrate = 1
    expect(await mock.getPerformance(W)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 1 });
    expect(await mock.getPerformance(A)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 1 });
    expect(perf.uncalibrated).toEqual([]);
    expect(perf.recalKeys).toEqual([W.id, A.id].sort((a, b) => a - b));
    expect(perf.needsCal).toEqual([W.id, A.id].sort((a, b) => a - b));
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.assignments[A.id]).toBe(FLUX.uid);

    // "notReplaced" on S and D: writes, sets assignment, adds NOTHING to recal list (kills M10)
    ex.mockClear();
    const noRep = perf.applySwitch({ kind: 'custom', custom: FLUX }, [S.id, D.id], 'notReplaced');
    expect(noRep).toMatchObject({ status: 'applied', written: 2, marked: false });
    await sync.flush();
    expect(await mock.getPerformance(S)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 1 });
    expect(perf.assignments[S.id]).toBe(FLUX.uid);
    expect(perf.assignments[D.id]).toBe(FLUX.uid);
    // Recal list still holds ONLY W and A (not S or D)
    expect(perf.recalKeys).toEqual([W.id, A.id].sort((a, b) => a - b));
  });

  it('listed switch with idKept > 0 also asks the swap question; idKept === 0 skips the question (kills M11)', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const ur = findSwitch(perf.catalog, 12432)!;
    const apollo = findSwitch(perf.catalog, 4208)!;

    // Listed switch changing id (idKept === 0, idNew === 1): no question!
    const direct = perf.applySwitch({ kind: 'catalog', entry: apollo }, [A.id]);
    expect(direct.status).toBe('applied');
    await sync.flush();
    expect((await mock.getPerformance(A)).calibrate).toBe(0);
    expect(perf.uncalibrated).toEqual([A.id]);
    expect(perf.recalKeys).toEqual([]);

    // Custom switch on W keeping UR id 12432, then switching W back to listed UR Ice (same id, R/c differ → idKept = 1)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'notReplaced');
    await sync.flush();
    const ex = spyExchange(mock);
    const q = perf.applySwitch({ kind: 'catalog', entry: ur }, [W.id]);
    expect(q.status).toBe('question');
    expect(ex).not.toHaveBeenCalled();

    // Custom switch on a lost key (id 0 → fallbackId 13472, idKept === 0): no question!
    setAxis(mock, S, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 });
    await perf.load(true);
    const lostApply = perf.applySwitch({ kind: 'custom', custom: FLUX }, [S.id]);
    expect(lostApply.status).toBe('applied');
    await sync.flush();
    expect(await mock.getPerformance(S)).toMatchObject({ axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 0 });
    expect(perf.assignments[S.id]).toBe(FLUX.uid);
  });
});

describe('CSW Test 8: Verify compares all three fields (kills M7)', () => {
  it.each([
    ['axisV2Id differs only', { axisV2Id: 4112, axisRangeMax: 3500, axisCoefficient: 17536 }],
    ['axisRangeMax differs only', { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 17536 }],
    ['axisCoefficient differs only', { axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 20500 }],
  ])('read-back where %s → switchNotices, no assignment, no recal entry, no perf.verify (kills M7)', async (_label, returnedTriple) => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const realGet = mock.getPerformance.bind(mock);
    let writes = 0;
    vi.spyOn(mock, 'setPerformance').mockImplementation(async () => { writes++; });
    vi.spyOn(mock, 'getPerformance').mockImplementation(async (pos) => ({ ...(await realGet(pos)), ...returnedTriple }));

    const res = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'replaced');
    expect(res.status).toBe('applied');
    await sync.flush();

    expect(writes).toBe(1); // no retry loop
    expect(perf.switchNotices).toEqual([
      {
        id: W.id,
        wanted: { axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 },
        got: returnedTriple,
      },
    ]);
    expect(perf.values[W.id]).toMatchObject(returnedTriple);
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(perf.recalKeys).toEqual([]);
    expect(perf.verify).toBeNull();
  });

  it('partial batch: only the key whose read-back matches all 3 fields gets assignment, recal and perf.verify', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const realSet = mock.setPerformance.bind(mock);
    const realGet = mock.getPerformance.bind(mock);
    // Simulate firmware silently refusing only A's coefficient while accepting W completely
    vi.spyOn(mock, 'setPerformance').mockImplementation(async (pos, p) => {
      if (pos.row === A.row && pos.col === A.col) return;
      return realSet(pos, p);
    });
    vi.spyOn(mock, 'getPerformance').mockImplementation(async (pos) => {
      const r = await realGet(pos);
      if (pos.row === A.row && pos.col === A.col) return { ...r, axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 20500 };
      return r;
    });

    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'replaced');
    await sync.flush();

    expect(perf.switchNotices).toHaveLength(1);
    expect(perf.switchNotices[0].id).toBe(A.id);
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.assignments[A.id]).toBeUndefined();
    expect(perf.recalKeys).toEqual([W.id]);
    expect(perf.verify?.keys).toEqual([W.id]);
  });
});

describe('CSW Test 9: Undo and Redo (kills M8, M18)', () => {
  it('restores old triple and old assignment on Undo, reapplies on Redo, and never changes the recal list (kills M8)', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();

    // 1. Apply FLUX to W with "replaced" → recalKeys gets W
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'replaced');
    await sync.flush();
    expect(await mock.getPerformance(W)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.recalKeys).toEqual([W.id]);

    // 2. Undo → old triple (UR Ice) and old assignment (none) restored; recalKeys UNTOUCHED (kills M8)
    history.undo();
    await sync.flush();
    expect(await mock.getPerformance(W)).toMatchObject(UR);
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(perf.keySwitch(W.id)?.kind).toBe('catalog');
    expect(perf.recalKeys).toEqual([W.id]);

    // 3. Redo → FLUX triple and assignment restored; recalKeys STILL [W.id]
    history.redo();
    await sync.flush();
    expect(await mock.getPerformance(W)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.recalKeys).toEqual([W.id]);

    // 4. Listed switch (Apollo) overwrites FLUX, then Undo restores FLUX triple and FLUX assignment
    const apollo = findSwitch(perf.catalog, 4208)!;
    perf.applySwitch({ kind: 'catalog', entry: apollo }, [W.id]);
    await sync.flush();
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(perf.keySwitch(W.id)).toEqual({ kind: 'catalog', entry: apollo });

    history.undo();
    await sync.flush();
    expect(await mock.getPerformance(W)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.recalKeys).toEqual([W.id]);
  });

  it('on a lost key, Undo keeps the current triple, restores the edit fields and old assignment, and NEVER writes back 0/0/0 (kills M18)', async () => {
    const { device, mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();

    // W is lost (0/0/0) with a pre-existing assignment to FLUX_TWIN; A is normal UR Ice
    setAxis(mock, W, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 });
    setAssignments(device.info!.serialHex, [W.id], FLUX_TWIN.uid);
    await perf.load(true);
    const wEditBefore = {
      mode: perf.values[W.id].mode,
      normalPress: perf.values[W.id].normalPress,
      rtFirstTouch: perf.values[W.id].rtFirstTouch,
    };

    // Apply FLUX to both W (lost → fallbackId 13472) and A (kept id 12432)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'notReplaced');
    await sync.flush();
    expect(await mock.getPerformance(W)).toMatchObject({ axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(await mock.getPerformance(A)).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.assignments[A.id]).toBe(FLUX.uid);

    const setPerf = vi.spyOn(mock, 'setPerformance');

    // Undo: MUST NOT write 0/0/0 for W (kills M18); A returns to UR Ice; W keeps 13472/3500/17536 and restores edit + FLUX_TWIN assignment
    history.undo();
    await sync.flush();

    expect(sync.state).toBe('saved');
    // No write ever carried R < 1000 or c < 4096
    for (const [, written] of setPerf.mock.calls) {
      expect(written.axisRangeMax).toBeGreaterThanOrEqual(1000);
      expect(written.axisCoefficient).toBeGreaterThanOrEqual(4096);
    }
    const wAfterUndo = await mock.getPerformance(W);
    expect(wAfterUndo).toMatchObject({
      axisV2Id: 13472,
      axisRangeMax: 3500,
      axisCoefficient: 17536,
      ...wEditBefore,
    });
    expect(perf.assignments[W.id]).toBe(FLUX_TWIN.uid);
    expect(await mock.getPerformance(A)).toMatchObject(UR);
    expect(perf.assignments[A.id]).toBeUndefined();
  });

  it('on a lost key whose edit field changed, Undo writes the restored edit while keeping the current triple (kills M18)', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();

    setAxis(mock, W, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 });
    await perf.load(true);
    // Apply FLUX to lost W (keeps normalPress 2.0)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id]);
    await sync.flush();
    // Simulate a state where current edit differs in an in-range value (normalPress 1.5) while keeping the valid triple
    perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], normalPress: 1.5, normalRelease: 1.5 } };
    const setPerf = vi.spyOn(mock, 'setPerformance');

    history.undo();
    await sync.flush();

    expect(sync.state).toBe('saved');
    expect(setPerf).toHaveBeenCalledTimes(1);
    expect(setPerf.mock.calls[0][1]).toMatchObject({
      axisV2Id: 13472,
      axisRangeMax: 3500,
      axisCoefficient: 17536,
      normalPress: 2.0,
      normalRelease: 2.0,
    });
    expect(perf.assignments[W.id]).toBeUndefined();
  });
});

describe('CSW Test 10: Rename only (0 HID, 0 sync jobs, kills M14)', () => {
  it('swaps assignment with 0 HID frames, 0 sync jobs, one history entry, and Undo/Redo swap back with 0 HID (kills M14)', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();
    const skyline = findSwitch(perf.catalog, 13472)!; // 3500 / 17536 = same R & c as FLUX and FLUX_TWIN

    // Put Skyline V3 on W and A
    setAxis(mock, W, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient, calibrate: 1 });
    setAxis(mock, A, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient, calibrate: 1 });
    await perf.load(true);

    const ex = spyExchange(mock);
    const enqueue = vi.spyOn(sync, 'enqueue');

    // Plan rename-only: catalog Skyline V3 → custom WS Flux (same R/c, valid id)
    const plan = perf.planSwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id]);
    expect(plan.write).toBe(0);
    expect(plan.idKept).toBe(0);
    expect(plan.idNew).toBe(0);
    expect(plan.rename).toBe(2);
    expect(plan.renameKeys).toEqual([W.id, A.id]);

    // Apply without answer (no swap question!): 0 HID, 0 sync jobs (kills M14)
    const res = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id]);
    expect(res).toEqual({ status: 'renamed', renamed: 2, name: FLUX.name });
    await sync.flush();
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.assignments[A.id]).toBe(FLUX.uid);
    expect(perf.keySwitch(W.id)?.kind).toBe('custom');
    expect(history.canUndo).toBe(true);

    // Rename again to FLUX_TWIN (same R/c): still 0 HID, 0 sync jobs
    const res2 = perf.applySwitch({ kind: 'custom', custom: FLUX_TWIN }, [W.id, A.id]);
    expect(res2).toEqual({ status: 'renamed', renamed: 2, name: FLUX_TWIN.name });
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.assignments[W.id]).toBe(FLUX_TWIN.uid);

    // Undo swaps back to FLUX with 0 HID and 0 sync jobs
    history.undo();
    await sync.flush();
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.assignments[A.id]).toBe(FLUX.uid);

    // Second Undo swaps back to no assignment (catalog Skyline V3) with 0 HID
    history.undo();
    await sync.flush();
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(perf.keySwitch(W.id)).toEqual({ kind: 'catalog', entry: skyline });

    // Redo restores FLUX with 0 HID
    history.redo();
    await sync.flush();
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
  });

  it('mixed write + rename sends HID only for the written keys and undoes both in one step', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();
    const skyline = findSwitch(perf.catalog, 13472)!;

    // W is UR Ice (needs write); A is Skyline V3 (rename only)
    setAxis(mock, A, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient, calibrate: 1 });
    await perf.load(true);

    const ex = spyExchange(mock);
    const res = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'notReplaced');
    expect(res).toMatchObject({ status: 'applied', written: 1, renamed: 1 });
    await sync.flush();

    const cmds = ex.mock.calls.map(([f]) => cmdOf(f));
    expect(cmds.filter((c) => c === '04 02')).toHaveLength(1); // ONLY W written, not A
    expect(cmds.filter((c) => c === '04 01')).toHaveLength(1);
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    expect(perf.assignments[A.id]).toBe(FLUX.uid);

    // Single Undo writes back only W and clears both assignments
    ex.mockClear();
    history.undo();
    await sync.flush();
    expect(ex.mock.calls.map(([f]) => cmdOf(f)).filter((c) => c === '04 02')).toHaveLength(1);
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(perf.assignments[A.id]).toBeUndefined();
    expect(await mock.getPerformance(W)).toMatchObject(UR);
  });
});
