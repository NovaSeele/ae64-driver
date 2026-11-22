// CSW step 3: keySwitch identity (Test 5, kills M12), planSwitch counts (Test 6), stale/lost detection,
// generic declaration 0-HID (kills M19), custom CRUD & forget 0-HID.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import {
  GENERIC_UID, readyToCustomLike, setAssignments, userToCustomLike,
} from '../src/data/customSwitch';
import type { CustomLike, CustomSwitch } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { customSwitchName, usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const A = key('A');
const S = key('S');
const D = key('D');
const Q = key('Q');

// WS Flux: 3500 µm / 17536 (= Skyline V3 13472; shared by 13 ready-made entries)
const FLUX_READY = READY_SWITCHES.find((s) => s.uid === 'r-wuque-ws-flux-clacky')!;
const FLUX: CustomLike = readyToCustomLike(FLUX_READY);
// Unique R/c user switch (no ready-made entry has 3456 / 19123)
const UNIQUE_USER: CustomSwitch = {
  uid: 'u-000000000001',
  name: 'Unique Custom',
  maker: 'Custom Lab',
  travelUm: 3456,
  rangeUm: 3456,
  coefficient: 19123,
  curve: { kind: 'manual' },
  color: '#4f8ef7',
  note: '',
};
const DUP_USER: CustomSwitch = {
  uid: 'u-000000000002',
  name: 'Second Same',
  maker: 'Custom Lab',
  travelUm: 3456,
  rangeUm: 3456,
  coefficient: 19123,
  curve: { kind: 'manual' },
  color: '',
  note: '',
};

function spyExchange(mock: MockTransport) {
  return vi.spyOn(mock as unknown as { exchange: (frame: Uint8Array) => Promise<Uint8Array> }, 'exchange');
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

describe('CSW Test 5: keySwitch identity in §9.2 exact order', () => {
  it('resolves all five kinds in §9.2 order, never by id alone (kills M12)', async () => {
    const { device, perf } = await setup();
    const serial = device.info!.serialHex;
    const jade = findSwitch(perf.catalog, 4112)!; // 3430 / 22800
    const skyline = findSwitch(perf.catalog, 13472)!; // 3500 / 17536
    perf.saveCustomSwitch(UNIQUE_USER);

    const setVal = (id: number, patch: Partial<Performance>) => {
      perf.values = { ...perf.values, [id]: { ...perf.values[id], ...patch } };
    };

    // Unloaded key → undefined
    expect(perf.keySwitch(999)).toBeUndefined();

    // 1. R < 1000 → lost (even with an assignment, and at R = 999 or 0)
    setAssignments(serial, [W.id, A.id], FLUX.uid);
    perf.reloadCustomSwitches();
    setVal(W.id, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 });
    setVal(A.id, { axisV2Id: 12432, axisRangeMax: 999, axisCoefficient: 20500 });
    expect(perf.keySwitch(W.id)).toEqual({ kind: 'lost', triple: { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 } });
    expect(perf.keySwitch(A.id)).toEqual({ kind: 'lost', triple: { axisV2Id: 12432, axisRangeMax: 999, axisCoefficient: 20500 } });

    // 2. Exact list triple WITH matching assignment → custom (assigned: true) — step 2 beats step 3!
    setAssignments(serial, [W.id], FLUX.uid);
    perf.reloadCustomSwitches();
    setVal(W.id, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient });
    const ksAssigned = perf.keySwitch(W.id);
    expect(ksAssigned?.kind).toBe('custom');
    if (ksAssigned?.kind === 'custom') {
      expect(ksAssigned.custom.uid).toBe(FLUX.uid);
      expect(ksAssigned.assigned).toBe(true);
    }

    // Assignment that no longer matches R or c falls through step 2 → step 3 (catalog)
    setVal(W.id, { axisV2Id: jade.id, axisRangeMax: jade.rangeMax, axisCoefficient: jade.coefficient });
    expect(perf.keySwitch(W.id)).toEqual({ kind: 'catalog', entry: jade });

    // 3. M12 killer: catalog id with modified R OR modified c MUST NOT resolve as 'catalog'
    perf.forgetKeys([W.id, A.id, S.id]);
    // Jade id (4112) with Flux's R/c (3500/17536, shared by 13 ready-made entries) → unnamed, NEVER Jade!
    setVal(W.id, { axisV2Id: jade.id, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(perf.keySwitch(W.id)).toEqual({
      kind: 'unnamed',
      triple: { axisV2Id: jade.id, axisRangeMax: 3500, axisCoefficient: 17536 },
    });
    // Jade id (4112) with R differing by 1 µm → unnamed, NEVER catalog
    setVal(A.id, { axisV2Id: jade.id, axisRangeMax: jade.rangeMax + 1, axisCoefficient: jade.coefficient });
    expect(perf.keySwitch(A.id)?.kind).toBe('unnamed');
    // Jade id (4112) with c differing by 1 → unnamed, NEVER catalog
    setVal(S.id, { axisV2Id: jade.id, axisRangeMax: jade.rangeMax, axisCoefficient: jade.coefficient + 1 });
    expect(perf.keySwitch(S.id)?.kind).toBe('unnamed');

    // 4a. R & c in bounds, unique match (ready-made or yours), no assignment → custom (assigned: false)
    setVal(D.id, { axisV2Id: jade.id, axisRangeMax: 3456, axisCoefficient: 19123 });
    const ksUnique = perf.keySwitch(D.id);
    expect(ksUnique).toEqual({
      kind: 'custom',
      custom: userToCustomLike(UNIQUE_USER),
      triple: { axisV2Id: jade.id, axisRangeMax: 3456, axisCoefficient: 19123 },
      assigned: false,
    });

    // 4b. Second entry with the same R/c → no longer unique → unnamed without an assignment
    perf.saveCustomSwitch(DUP_USER);
    expect(perf.keySwitch(D.id)).toEqual({
      kind: 'unnamed',
      triple: { axisV2Id: jade.id, axisRangeMax: 3456, axisCoefficient: 19123 },
    });

    // Generic switch does NOT participate in step 4 (unassigned 3400/20550 is unnamed, not generic)
    setVal(Q.id, { axisV2Id: jade.id, axisRangeMax: 3400, axisCoefficient: 20550 });
    expect(perf.keySwitch(Q.id)?.kind).toBe('unnamed');
    // With an assignment to generic, step 2 matches it as custom (assigned: true)
    setAssignments(serial, [Q.id], GENERIC_UID);
    perf.reloadCustomSwitches();
    const ksGen = perf.keySwitch(Q.id);
    expect(ksGen?.kind).toBe('custom');
    if (ksGen?.kind === 'custom') {
      expect(ksGen.custom.uid).toBe(GENERIC_UID);
      expect(ksGen.assigned).toBe(true);
      expect(customSwitchName(ksGen.custom)).toBe('Switch chung · 3.40 mm');
    }

    // 5. Out-of-bounds R or c (with R >= 1000) → unknown
    setVal(W.id, { axisV2Id: 99999, axisRangeMax: 4500, axisCoefficient: 20000 });
    expect(perf.keySwitch(W.id)).toEqual({
      kind: 'unknown',
      triple: { axisV2Id: 99999, axisRangeMax: 4500, axisCoefficient: 20000 },
    });
    setVal(A.id, { axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 9000 });
    expect(perf.keySwitch(A.id)?.kind).toBe('unknown');
  });

  it('on a board with an unreadable serial, assignments are ignored and identity falls back to step 4', async () => {
    const { device, perf } = await setup();
    perf.saveCustomSwitch(UNIQUE_USER);
    device.info = { ...device.info!, serialHex: '000000000000000000000000' };
    expect(perf.assignments).toEqual({});
    perf.values = {
      ...perf.values,
      [W.id]: { ...perf.values[W.id], axisV2Id: 12432, axisRangeMax: 3456, axisCoefficient: 19123 },
    };
    const ks = perf.keySwitch(W.id);
    expect(ks?.kind).toBe('custom');
    if (ks?.kind === 'custom') expect(ks.assigned).toBe(false);
  });
});

describe('CSW Test 6: planSwitch counts on mixed selections (custom and listed) with 0 HID', () => {
  it('computes write, idNew, idKept, rename, deeper, clamped, fallbackId for custom choice and sends 0 HID', async () => {
    const { device, mock, perf } = await setup();
    const white = findSwitch(perf.catalog, 4416)!; // 4015 / 13300
    const skyline = findSwitch(perf.catalog, 13472)!; // 3500 / 17536

    // Prepare 5 keys in distinct states:
    // W: lost (0/0/0) → write, idNew (fallback Skyline V3 13472)
    // A: UR Ice (12432/3310/20500) → write, idKept (3500 > 3310, not deeper)
    // S: White (4416/4015/13300), normalPress 3.9 → write, idKept, deeper (3500 < 4015), clamped
    // D: Skyline V3 (13472/3500/17536), no assignment → rename only (shown name changes to WS Flux)
    // Q: Skyline V3 (13472/3500/17536), already assigned WS Flux → noop
    setAxis(mock, W, { axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 });
    setAxis(mock, S, { axisV2Id: white.id, axisRangeMax: white.rangeMax, axisCoefficient: white.coefficient, calibrate: 1 });
    setAxis(mock, D, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient, calibrate: 1 });
    setAxis(mock, Q, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient, calibrate: 1 });
    setAssignments(device.info!.serialHex, [Q.id], FLUX.uid);
    await perf.load(true);
    perf.values = { ...perf.values, [S.id]: { ...perf.values[S.id], mode: 0, normalPress: 3.9, normalRelease: 3.9 } };

    const ex = spyExchange(mock);
    const plan = perf.planSwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id, S.id, D.id, Q.id]);

    expect(ex).not.toHaveBeenCalled();
    expect(plan.write).toBe(3);
    expect(plan.keys).toEqual([W.id, A.id, S.id]);
    expect(plan.idNew).toBe(1);
    expect(plan.idKept).toBe(2);
    expect(plan.rename).toBe(1);
    expect(plan.renameKeys).toEqual([D.id]);
    expect(plan.deeper).toBe(true);
    expect(plan.limitMm).toBe(3.5);
    expect(plan.fallbackId).toBe(13472);
    expect(plan.clamped.map((c) => `${c.id}:${c.field}:${c.to}`)).toEqual([
      `${S.id}:normalPress:3.5`,
      `${S.id}:normalRelease:3.5`,
    ]);

    // Without S (no lower R), deeper is false
    const planNoDeeper = perf.planSwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id, D.id, Q.id]);
    expect(planNoDeeper.deeper).toBe(false);
    expect(planNoDeeper.write).toBe(2);
    expect(planNoDeeper.idNew).toBe(1);
    expect(planNoDeeper.idKept).toBe(1);
    expect(planNoDeeper.rename).toBe(1);
  });

  it('computes write, idNew, idKept, rename, deeper for a listed choice on a mixed selection', async () => {
    const { mock, perf } = await setup();
    const jadePro = findSwitch(perf.catalog, 4128)!; // 3390 / 20000

    // W: UR Ice (12432/3310/20500) → write, idNew (12432 → 4128)
    // A: Jade Pro id (4128) with custom R/c (3500/17536) → write, idKept (4128 stays), deeper (3390 < 3500)
    // S: already Jade Pro (4128/3390/20000) → noop
    setAxis(mock, A, { axisV2Id: jadePro.id, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 1 });
    setAxis(mock, S, { axisV2Id: jadePro.id, axisRangeMax: jadePro.rangeMax, axisCoefficient: jadePro.coefficient, calibrate: 1 });
    await perf.load(true);

    const ex = spyExchange(mock);
    const plan = perf.planSwitch({ kind: 'catalog', entry: jadePro }, [W.id, A.id, S.id]);

    expect(ex).not.toHaveBeenCalled();
    expect(plan.write).toBe(2);
    expect(plan.keys).toEqual([W.id, A.id]);
    expect(plan.idNew).toBe(1);
    expect(plan.idKept).toBe(1);
    expect(plan.rename).toBe(0);
    expect(plan.deeper).toBe(true);
    expect(plan.limitMm).toBe(3.39);
  });
});

describe('Stale/lost detection, generic declaration 0-HID (kills M19), CRUD and forget 0-HID', () => {
  it('saving the generic declaration writes 0 HID and marks keys carrying it as stale (kills M19)', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();

    // Apply generic switch (default 3400 / 20550) to W and A
    const gStart = perf.genericEntry;
    expect(gStart).toMatchObject({ uid: GENERIC_UID, rangeUm: 3400, coefficient: 20550 });
    const res = perf.applySwitch({ kind: 'custom', custom: gStart }, [W.id, A.id], 'notReplaced');
    expect(res.status).toBe('applied');
    await sync.flush();

    expect(perf.staleKeys).toEqual([]);
    expect(perf.lostKeys).toEqual([]);
    expect(perf.keySwitch(W.id)?.kind).toBe('custom');

    const ex = spyExchange(mock);
    const enqueue = vi.spyOn(sync, 'enqueue');

    // Change generic declaration from 3.40 mm to 4.00 mm: MUST send 0 HID and NOT rewrite keys!
    perf.setGenericRange(4000);
    await sync.flush();

    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.genericEntry).toMatchObject({ uid: GENERIC_UID, rangeUm: 4000, coefficient: 15100 });
    // Keys on the board still carry 3400 / 20550
    expect(await mock.getPerformance(W)).toMatchObject({ axisRangeMax: 3400, axisCoefficient: 20550 });
    expect(await mock.getPerformance(A)).toMatchObject({ axisRangeMax: 3400, axisCoefficient: 20550 });
    // Both keys show up in staleKeys as generic
    expect(perf.staleKeys.map((x) => ({ id: x.id, uid: x.uid, isGeneric: x.isGeneric, actualR: x.actual.axisRangeMax, expectedR: x.expected.rangeUm, expectedC: x.expected.coefficient }))).toEqual([
      { id: W.id, uid: GENERIC_UID, isGeneric: true, actualR: 3400, expectedR: 4000, expectedC: 15100 },
      { id: A.id, uid: GENERIC_UID, isGeneric: true, actualR: 3400, expectedR: 4000, expectedC: 15100 },
    ]);
    expect(perf.lostKeys).toEqual([]);
  });

  it('detects lost keys from wipeAxis() and stale keys from editing a user switch; forgetKeys and deleteCustomSwitch send 0 HID', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();

    // Save and apply a user switch to W
    expect(perf.saveCustomSwitch(UNIQUE_USER)).toBe(true);
    perf.applySwitch({ kind: 'custom', custom: userToCustomLike(UNIQUE_USER) }, [W.id], 'notReplaced');
    await sync.flush();
    expect(perf.staleKeys).toEqual([]);

    const ex = spyExchange(mock);
    const enqueue = vi.spyOn(sync, 'enqueue');
    const histBefore = history.undoLabel;

    // Edit user switch R/c: 0 HID, W becomes stale
    perf.saveCustomSwitch({ ...UNIQUE_USER, rangeUm: 3600, travelUm: 3600, coefficient: 18750 });
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.staleKeys).toHaveLength(1);
    expect(perf.staleKeys[0]).toMatchObject({
      id: W.id,
      uid: UNIQUE_USER.uid,
      isGeneric: false,
      actual: { axisRangeMax: 3456, axisCoefficient: 19123 },
      expected: { rangeUm: 3600, coefficient: 18750 },
    });

    // Forget ("Quên") W: 0 HID, not on undo stack, clears stale row
    perf.forgetKeys([W.id]);
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(history.undoLabel).toBe(histBefore);
    expect(perf.staleKeys).toEqual([]);
    expect(perf.assignments[W.id]).toBeUndefined();

    // Re-assign W via apply, then delete user switch: 0 HID, removes assignment
    perf.applySwitch({ kind: 'custom', custom: userToCustomLike({ ...UNIQUE_USER, rangeUm: 3600, travelUm: 3600, coefficient: 18750 }) }, [W.id], 'notReplaced');
    await sync.flush();
    ex.mockClear();
    enqueue.mockClear();
    perf.deleteCustomSwitch(UNIQUE_USER.uid);
    expect(ex).not.toHaveBeenCalled();
    expect(enqueue).not.toHaveBeenCalled();
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(perf.customSwitches).toEqual([]);

    // Assign A to FLUX, then wipeAxis() → all 64 keys in lostKeys, none in staleKeys; A carries FLUX, others carry null
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [A.id], 'notReplaced');
    await sync.flush();
    mock.wipeAxis();
    await perf.load(true);
    expect(perf.staleKeys).toEqual([]);
    expect(perf.lostKeys).toHaveLength(64);
    const lostA = perf.lostKeys.find((x) => x.id === A.id)!;
    const lostW = perf.lostKeys.find((x) => x.id === W.id)!;
    expect(lostA.uid).toBe(FLUX.uid);
    expect(lostA.custom?.uid).toBe(FLUX.uid);
    expect(lostW.uid).toBeNull();
    expect(lostW.custom).toBeNull();

    // Forgetting A removes its name from lostA, but A stays in lostKeys (0 HID)
    ex.mockClear();
    perf.forgetKeys([A.id]);
    expect(ex).not.toHaveBeenCalled();
    expect(perf.lostKeys.find((x) => x.id === A.id)?.uid).toBeNull();
  });
});
