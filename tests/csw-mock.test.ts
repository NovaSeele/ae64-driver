// CSW step 1: MockTransport global axis array, id-only calibrate drop, 04 02 silent refusal and wipeAxis (DESIGN §15).
import { describe, expect, it } from 'vitest';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { encodePerformance } from '../src/protocol/codec';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

/** Sends a raw 04 02 frame directly to MockTransport's firmware handler, bypassing the host write guard (DESIGN §15). */
function sendRawPerf(mock: MockTransport, key: { row: number; col: number }, p: Performance): Uint8Array {
  return (mock as unknown as { handle(req: number[]): Uint8Array }).handle(encodePerformance(key, p));
}

describe('MockTransport axis behaviour (DESIGN §15)', () => {
  it.each(['max', 'pro'] as const)('axis triple and calibrate are global across all 4 profiles on %s seed (kills M17)', async (seed) => {
    const mock = new MockTransport({ latencyMs: 0, seed });
    await mock.getDeviceInfo();

    // Write a new switch triple on profile 1 (FPS) and a distinct actuation on profile 1.
    await mock.setActiveProfile(1);
    const p1Before = await mock.getPerformance(W);
    await mock.setPerformance(W, {
      ...p1Before,
      normalPress: 1.75,
      normalRelease: 1.75,
      axisV2Id: 13472,
      axisRangeMax: 3500,
      axisCoefficient: 17536,
    });

    // Switch to profile 2 (Typing): must see the global triple + calibrate 0, while keeping profile 2's own normalPress (2.0).
    await mock.setActiveProfile(2);
    const p2 = await mock.getPerformance(W);
    expect({ axisV2Id: p2.axisV2Id, axisRangeMax: p2.axisRangeMax, axisCoefficient: p2.axisCoefficient, calibrate: p2.calibrate })
      .toEqual({ axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 0 });
    expect(p2.normalPress).toBe(2.0); // profile 2's own performance fields untouched

    // Profiles 0 and 3 also see the same global triple + calibrate 0.
    for (const prof of [0, 3]) {
      await mock.setActiveProfile(prof);
      const pr = await mock.getPerformance(W);
      expect({ axisV2Id: pr.axisV2Id, axisRangeMax: pr.axisRangeMax, axisCoefficient: pr.axisCoefficient, calibrate: pr.calibrate })
        .toEqual({ axisV2Id: 13472, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 0 });
    }

    // Calibration status via 04 03 type 2 is also global across profiles.
    const calRow = await mock.getAxisData('calibration', W.row);
    expect(calRow.values[W.col]).toBe(0);
    expect(calRow.values[A.col]).toBe(1);

    // Calibrating W on profile 3 sets calibrate back to 1 globally (visible on profile 1).
    await mock.startCalibration();
    mock.simulatePress(W.id, 3.4);
    await mock.getAxisData('calibration', W.row);
    await mock.stopCalibration();
    await mock.setActiveProfile(1);
    expect((await mock.getPerformance(W)).calibrate).toBe(1);
    expect((await mock.getPerformance(W)).normalPress).toBe(1.75);
  });

  it.each(['max', 'pro'] as const)('calibrate drops to 0 only when the written id differs from stored id on %s seed', async (seed) => {
    const mock = new MockTransport({ latencyMs: 0, seed });
    await mock.getDeviceInfo();
    const initial = await mock.getPerformance(W);
    expect(initial.calibrate).toBe(1);

    // R-only change (same id): calibrate stays 1.
    await mock.setPerformance(W, { ...initial, axisRangeMax: 3500 });
    const afterR = await mock.getPerformance(W);
    expect(afterR).toMatchObject({ axisV2Id: initial.axisV2Id, axisRangeMax: 3500, axisCoefficient: initial.axisCoefficient, calibrate: 1 });

    // c-only change (same id): calibrate stays 1.
    await mock.setPerformance(W, { ...afterR, axisCoefficient: 17536 });
    const afterC = await mock.getPerformance(W);
    expect(afterC).toMatchObject({ axisV2Id: initial.axisV2Id, axisRangeMax: 3500, axisCoefficient: 17536, calibrate: 1 });

    // R + c change (same id): calibrate stays 1.
    await mock.setPerformance(W, { ...afterC, axisRangeMax: 3600, axisCoefficient: 19000 });
    const afterRC = await mock.getPerformance(W);
    expect(afterRC).toMatchObject({ axisV2Id: initial.axisV2Id, axisRangeMax: 3600, axisCoefficient: 19000, calibrate: 1 });

    // Id change: calibrate drops to 0.
    await mock.setPerformance(W, { ...afterRC, axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 });
    const afterId = await mock.getPerformance(W);
    expect(afterId).toMatchObject({ axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500, calibrate: 0 });

    // Subsequent R-only change on an uncalibrated key keeps calibrate 0.
    await mock.setPerformance(W, { ...afterId, axisRangeMax: 3500 });
    expect((await mock.getPerformance(W)).calibrate).toBe(0);
  });

  it('04 02 silently refuses invalid axis fields (id < 0x1000, R < 1000, R > 5000, c < 4096) while storing performance fields', async () => {
    const mock = new MockTransport({ latencyMs: 0, seed: 'max' });
    await mock.getDeviceInfo();
    const before = await mock.getPerformance(W);
    expect(before).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500, calibrate: 1 });

    const refusedCases: [string, Partial<Performance>, number][] = [
      ['id < 0x1000 (2128)', { axisV2Id: 2128, axisRangeMax: 3600, axisCoefficient: 20224 }, 1.11],
      ['id < 0x1000 (0x0fff)', { axisV2Id: 0x0fff, axisRangeMax: 3500, axisCoefficient: 20000 }, 1.22],
      ['R < 1000 (999)', { axisV2Id: 4208, axisRangeMax: 999, axisCoefficient: 20000 }, 1.33],
      ['R > 5000 (5001)', { axisV2Id: 4208, axisRangeMax: 5001, axisCoefficient: 20000 }, 1.44],
      ['c < 4096 (4095)', { axisV2Id: 4208, axisRangeMax: 3500, axisCoefficient: 4095 }, 1.55],
    ];

    for (const [label, badAxis, press] of refusedCases) {
      const reply = sendRawPerf(mock, W, { ...before, normalPress: press, normalRelease: press, ...badAxis });
      expect(reply[0], label).toBe(0x04);
      expect(reply[1], label).toBe(0x02);
      const readBack = await mock.getPerformance(W);
      // Old triple and calibrate stayed (even when badAxis carried a different id 4208).
      expect(readBack, label).toMatchObject({
        axisV2Id: before.axisV2Id,
        axisRangeMax: before.axisRangeMax,
        axisCoefficient: before.axisCoefficient,
        calibrate: 1,
        normalPress: press,
        normalRelease: press,
      });
    }

    // Exact firmware boundary values (id 0x1000, R 1000..5000, c 4096) ARE accepted.
    sendRawPerf(mock, W, { ...before, normalPress: 0.9, normalRelease: 0.9, axisV2Id: 0x1000, axisRangeMax: 1000, axisCoefficient: 4096 });
    expect(await mock.getPerformance(W)).toMatchObject({
      axisV2Id: 0x1000, axisRangeMax: 1000, axisCoefficient: 4096, calibrate: 0, normalPress: 0.9,
    });
    sendRawPerf(mock, W, { ...before, normalPress: 2.5, normalRelease: 2.5, axisV2Id: 0x1000, axisRangeMax: 5000, axisCoefficient: 4096 });
    expect(await mock.getPerformance(W)).toMatchObject({
      axisV2Id: 0x1000, axisRangeMax: 5000, axisCoefficient: 4096, calibrate: 0, normalPress: 2.5,
    });
  });

  it.each(['max', 'pro'] as const)('wipeAxis sets every key to 0/0/0 with calibrate 0 across all profiles on %s seed', async (seed) => {
    const mock = new MockTransport({ latencyMs: 0, seed });
    await mock.getDeviceInfo();
    const wBefore = await mock.getPerformance(W);

    mock.wipeAxis();

    for (const prof of [0, 1]) {
      await mock.setActiveProfile(prof);
      for (const key of PHYSICAL_KEYS) {
        const p = await mock.getPerformance(key);
        expect({ axisV2Id: p.axisV2Id, axisRangeMax: p.axisRangeMax, axisCoefficient: p.axisCoefficient, calibrate: p.calibrate })
          .toEqual({ axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0, calibrate: 0 });
      }
    }
    // Performance fields remain intact.
    await mock.setActiveProfile(0);
    expect((await mock.getPerformance(W)).normalPress).toBe(wBefore.normalPress);
    // Calibration axis data reports 0 for every physical key.
    for (let row = 1; row <= 5; row++) {
      const cal = await mock.getAxisData('calibration', row);
      for (const key of PHYSICAL_KEYS.filter((k) => k.row === row)) {
        expect(cal.values[key.col]).toBe(0);
      }
    }
  });
});
