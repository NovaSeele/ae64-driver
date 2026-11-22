// CSW step 3: Recal list & calibration store (Test 11, kills M8 & M9), Profiles & Travel deep fix (Test 13 store half),
// and Check after Apply / perf.verify (Test 19 store half, kills M25 & M26).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import { readyToCustomLike } from '../src/data/customSwitch';
import type { CustomLike } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { DIFF_FIELDS, diffProfiles } from '../src/data/profileDiff';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { useCalibrationStore } from '../src/stores/calibration';
import { usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const A = key('A');
const S = key('S');
const D = key('D');

const FLUX_READY = READY_SWITCHES.find((s) => s.uid === 'r-wuque-ws-flux-clacky')!;
const FLUX: CustomLike = readyToCustomLike(FLUX_READY); // 3500 / 17536

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

function spyExchange(mock: MockTransport) {
  return vi.spyOn(mock as unknown as { exchange: (frame: Uint8Array) => Promise<Uint8Array> }, 'exchange');
}

function cmdOf(frame: Uint8Array): string {
  return `${frame[0].toString(16).padStart(2, '0')} ${frame[1].toString(16).padStart(2, '0')}`;
}

function setAxis(mock: MockTransport, k: typeof W, ax: { axisV2Id?: number; axisRangeMax?: number; axisCoefficient?: number; calibrate?: number }) {
  const m = mock as unknown as { axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }> };
  const cur = m.axis.get(`${k.row}:${k.col}`)!;
  if (ax.axisV2Id !== undefined) cur.axisV2Id = ax.axisV2Id;
  if (ax.axisRangeMax !== undefined) cur.axisRangeMax = ax.axisRangeMax;
  if (ax.axisCoefficient !== undefined) cur.axisCoefficient = ax.axisCoefficient;
  if (ax.calibrate !== undefined) cur.calibrate = ax.calibrate;
}

function setProfilePerfBytes(mock: MockTransport, profile: number, k: typeof W, fieldByteOffset: number, valueUm: number) {
  const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[] };
  const rec = m.profiles[profile].perf.get(`${k.row}:${k.col}`)!;
  rec[fieldByteOffset] = valueUm & 0xff;
  rec[fieldByteOffset + 1] = valueUm >>> 8;
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
  const cal = useCalibrationStore();
  if (cal.phase === 'running') await cal.cancel();
  await useDeviceStore().disconnect({ flush: false });
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('CSW Test 11 (store): Recal list, needsCal union, and calibration save/cancel (kills M9)', () => {
  it('recal list survives reload, profile switch and reconnect; cancel and failed commit clear nothing; finish clears only lastSaved (kills M9)', async () => {
    const { device, mock, perf } = await setup();
    const sync = useSyncStore();

    // Mark W and A via "replaced"
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'replaced');
    await sync.flush();
    const expectedWA = [W.id, A.id].sort((a, b) => a - b);
    expect(perf.recalKeys).toEqual(expectedWA);
    expect(perf.uncalibrated).toEqual([]);
    expect(perf.needsCal).toEqual(expectedWA);

    // Union with board uncalibrated flag (S has board calibrate = 0, A also has calibrate = 0 → deduplicated sorted union)
    setAxis(mock, S, { calibrate: 0 });
    setAxis(mock, A, { calibrate: 0 });
    await perf.load(true);
    expect(perf.uncalibrated).toEqual([A.id, S.id].sort((a, b) => a - b));
    expect(perf.recalKeys).toEqual(expectedWA);
    expect(perf.needsCal).toEqual([W.id, A.id, S.id].sort((a, b) => a - b));

    // Kept across profile switch
    await device.switchProfile(1);
    await perf.load(true);
    expect(perf.recalKeys).toEqual(expectedWA);

    // Kept across full reconnect (fresh Pinia = simulated page reload)
    await device.disconnect();
    setActivePinia(createPinia());
    const device2 = useDeviceStore();
    await device2.connectDemo('max');
    const mock2 = device2.transport as MockTransport;
    const perf2 = usePerformanceStore();
    await perf2.load();
    expect(perf2.recalKeys).toEqual(expectedWA);
    expect(perf2.needsCal).toEqual(expectedWA);

    const cal = useCalibrationStore();
    await cal.refresh();

    // 1. Cancelled calibration session after pressing W to bottom (status 2): clears NOTHING (kills M9)
    await cal.start();
    mock2.simulatePress(W.id, 3.31);
    await until(() => cal.frame.status[W.id] === 2);
    mock2.simulatePress(W.id, 0);
    await until(() => cal.frame.route[W.id] === 0);
    expect(await cal.cancel()).toBe(true);
    expect(cal.lastSaved).toBeNull();
    expect(perf2.recalKeys).toEqual(expectedWA);
    expect(perf2.needsCal).toEqual(expectedWA);

    // 2. Failed commit during finish(): clears NOTHING
    await cal.start();
    mock2.simulatePress(W.id, 3.31);
    await until(() => cal.frame.status[W.id] === 2);
    mock2.simulatePress(W.id, 0);
    await until(() => cal.frame.route[W.id] === 0);
    const commitSpy = vi.spyOn(mock2, 'commit').mockRejectedValueOnce(new Error('commit failed'));
    expect(await cal.finish()).toBe(false);
    commitSpy.mockRestore();
    expect(cal.lastSaved).toBeNull();
    expect(perf2.recalKeys).toEqual(expectedWA);

    // 3. Saved session where ONLY W is pressed (not A): clears W only; A remains in recalKeys!
    await cal.start();
    mock2.simulatePress(W.id, 3.31);
    await until(() => cal.frame.status[W.id] === 2);
    mock2.simulatePress(W.id, 0);
    await until(() => cal.frame.route[W.id] === 0);
    expect(await cal.finish()).toBe(true);
    expect(cal.lastSaved).toEqual([W.id]);
    expect(perf2.recalKeys).toEqual([A.id]);
    expect(perf2.needsCal).toEqual([A.id]);

    // 4. Saved session calibrating A: recal list empties completely
    await cal.start();
    mock2.simulatePress(A.id, 3.31);
    await until(() => cal.frame.status[A.id] === 2);
    mock2.simulatePress(A.id, 0);
    await until(() => cal.frame.route[A.id] === 0);
    expect(await cal.finish()).toBe(true);
    expect(cal.lastSaved).toEqual([A.id]);
    expect(perf2.recalKeys).toEqual([]);
    expect(perf2.needsCal).toEqual([]);
    // Let finish()'s background perf2.load(true) settle before leaving this Pinia instance.
    await until(() => !perf2.loading);
  }, 15000);

  it('board with an unreadable serial stores no assignments, while recal list uses board:{boardIdHex}', async () => {
    const { device, perf } = await setup();
    const sync = useSyncStore();
    device.info = { ...device.info!, serialHex: '000000000000000000000000' };

    const res = perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'replaced');
    expect(res.status).toBe('applied');
    await sync.flush();

    expect(localStorage.getItem('ae64.switch.assign')).toBeNull();
    expect(perf.assignments).toEqual({});
    expect(perf.recalKeys).toEqual([W.id]);
    expect(perf.needsCal).toEqual([W.id]);
    expect(JSON.parse(localStorage.getItem('ae64.switch.recal')!).boards['board:0030000d']).toEqual([W.id]);
  });
});

describe('CSW Test 13 (store): Board-global switches across profiles, profileDiff drops switch, and Travel deep fix', () => {
  it('switch write shows in every profile, profileDiff excludes switch, and fixDeepTravel writes only deep keys via fitTravel', async () => {
    const { device, mock, perf } = await setup();
    const sync = useSyncStore();

    // Profile compare has no 'switch' field
    expect(DIFF_FIELDS).not.toContain('switch');
    expect(diffProfiles(
      { [W.id]: { ...perf.values[W.id], axisV2Id: 12432 } },
      { [W.id]: { ...perf.values[W.id], axisV2Id: 4112 } },
      [W.id],
    )).toEqual([]);

    // Put a 4.0 mm switch (White 4416, R 4015) on W & A, then set deep values in profile 1 (FPS):
    // W: actuation (normalPress) 3.9 mm (Standard); A: pressDeadStroke 3.6 mm (as another app could write)
    const white = findSwitch(perf.catalog, 4416)!;
    perf.applySwitch({ kind: 'catalog', entry: white }, [W.id, A.id]);
    await sync.flush();
    // Seed deep values directly in profile 1
    setProfilePerfBytes(mock, 1, W, 1, 3900); // normalPress 3.9 mm
    setProfilePerfBytes(mock, 1, W, 3, 3900); // normalRelease 3.9 mm
    setProfilePerfBytes(mock, 1, A, 11, 3600); // pressDeadStroke 3.6 mm

    // On profile 0, switch W & A to generic 3.40 mm (3400 / 20550): plan reports deeper
    const g3400 = perf.genericEntry;
    const plan = perf.planSwitch({ kind: 'custom', custom: g3400 }, [W.id, A.id]);
    expect(plan.deeper).toBe(true);
    perf.applySwitch({ kind: 'custom', custom: g3400 }, [W.id, A.id], 'notReplaced');
    await sync.flush();

    // Switch to profile 1: the 3.40 mm custom switch shows on profile 1 too (board-wide!), and W & A are flagged as deepKeys
    await device.switchProfile(1);
    await perf.load(true);
    expect(perf.values[W.id]).toMatchObject({ axisV2Id: white.id, axisRangeMax: 3400, axisCoefficient: 20550, normalPress: 3.9 });
    expect(perf.values[A.id]).toMatchObject({ axisV2Id: white.id, axisRangeMax: 3400, axisCoefficient: 20550, pressDeadStroke: 3.6 });
    expect(perf.keySwitch(W.id)?.kind).toBe('custom');
    expect(perf.deepKeys).toEqual([W.id, A.id].sort((a, b) => a - b));

    // Nothing written yet; now invoke fixDeepTravel()
    const ex = spyExchange(mock);
    const fixed = perf.fixDeepTravel();
    expect(fixed).toBe(2);
    await sync.flush();

    const cmds = ex.mock.calls.map(([f]) => cmdOf(f));
    expect(cmds.filter((c) => c === '04 02')).toHaveLength(2); // ONLY the 2 deep keys, not all 64
    expect(cmds.filter((c) => c === '02 02')).toHaveLength(1);
    expect(cmds.filter((c) => c === '04 01')).toHaveLength(2);
    expect(sync.state).toBe('saved');

    // W lowered to 3.40 mm; A's deep dead zone lowered to 1.0 mm (not 3.40); triple untouched
    expect(await mock.getPerformance(W)).toMatchObject({
      axisV2Id: white.id, axisRangeMax: 3400, axisCoefficient: 20550,
      normalPress: 3.4, normalRelease: 3.4,
    });
    expect(await mock.getPerformance(A)).toMatchObject({
      axisV2Id: white.id, axisRangeMax: 3400, axisCoefficient: 20550,
      pressDeadStroke: 1.0,
    });
    expect(perf.deepKeys).toEqual([]);
  });

  it('deepKeys ignores values within travelLimitMm(R) + 0.5 µm and ignores lost keys', async () => {
    const { mock, perf } = await setup();
    // W has UR Ice (3310 → limit 3.31). 3.3104 is within +0.5 µm (not deep); 3.311 is deep.
    perf.values = {
      ...perf.values,
      [W.id]: { ...perf.values[W.id], normalPress: 3.3104, normalRelease: 3.3104 },
      [A.id]: { ...perf.values[A.id], normalPress: 3.311, normalRelease: 3.311 },
      [S.id]: { ...perf.values[S.id], axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, normalPress: 2.0 },
    };
    expect(perf.deepKeys).toEqual([A.id]);
    expect(mock.connected).toBe(true);
  });
});

describe('CSW Test 19 (store): perf.verify lifecycle (kills M25, M26)', () => {
  it('set by verified custom Apply; NOT set by listed Apply (which clears it) or rename only; cleared by Undo, Redo, clearVerify and disconnect (kills M25, M26)', async () => {
    const { device, mock, perf } = await setup();
    const sync = useSyncStore();
    const history = useHistoryStore();
    const apollo = findSwitch(perf.catalog, 4208)!;
    const skyline = findSwitch(perf.catalog, 13472)!;

    expect(perf.verify).toBeNull();

    // 1. Listed Apply NEVER sets perf.verify (kills M25)
    perf.applySwitch({ kind: 'catalog', entry: apollo }, [S.id]);
    await sync.flush();
    expect(perf.verify).toBeNull();

    // 2. Rename-only Apply NEVER sets perf.verify (kills M25)
    setAxis(mock, D, { axisV2Id: skyline.id, axisRangeMax: skyline.rangeMax, axisCoefficient: skyline.coefficient, calibrate: 1 });
    await perf.load(true);
    const rn = perf.applySwitch({ kind: 'custom', custom: FLUX }, [D.id]);
    expect(rn.status).toBe('renamed');
    expect(perf.verify).toBeNull();

    // 3. Verified custom Apply sets perf.verify with the written keys and passed: false
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id], 'notReplaced');
    expect(perf.verify).toBeNull(); // not set until verified
    await sync.flush();
    expect(perf.verify).toEqual({
      board: device.info!.serialHex,
      keys: [W.id, A.id].sort((a, b) => a - b),
      name: FLUX.name,
      rangeUm: 3500,
      passed: false,
    });

    // markVerifyPassed flips passed to true with 0 HID and stays true
    const ex = spyExchange(mock);
    perf.markVerifyPassed();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.verify?.passed).toBe(true);

    // Profile switch preserves perf.verify
    await device.switchProfile(1);
    await perf.load(true);
    expect(perf.verify?.passed).toBe(true);

    // 4. Listed Apply CLEARS perf.verify (kills M25)
    perf.applySwitch({ kind: 'catalog', entry: apollo }, [W.id]);
    expect(perf.verify).toBeNull();
    await sync.flush();
    expect(perf.verify).toBeNull();

    // 5. Undo of custom Apply CLEARS perf.verify (kills M26)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'notReplaced');
    await sync.flush();
    expect(perf.verify?.keys).toEqual([W.id]);

    history.undo();
    expect(perf.verify).toBeNull();
    await sync.flush();
    expect(perf.verify).toBeNull(); // still null after Undo verifies (kills M26)

    // Redo does not re-enable perf.verify
    history.redo();
    await sync.flush();
    expect(perf.verify).toBeNull();

    // 6. clearVerify ("Bỏ theo dõi") clears perf.verify with 0 HID
    const jadePro = findSwitch(perf.catalog, 4128)!;
    perf.applySwitch({ kind: 'catalog', entry: jadePro }, [W.id]);
    await sync.flush();
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'notReplaced');
    await sync.flush();
    expect(perf.verify).not.toBeNull();
    ex.mockClear();
    perf.clearVerify();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.verify).toBeNull();

    // 7. Disconnect clears perf.verify
    perf.applySwitch({ kind: 'catalog', entry: jadePro }, [W.id], 'notReplaced');
    await sync.flush();
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id], 'notReplaced');
    await sync.flush();
    expect(perf.verify).not.toBeNull();
    await device.disconnect();
    expect(perf.verify).toBeNull();
  });
});
