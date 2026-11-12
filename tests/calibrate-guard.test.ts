import { describe, expect, it, vi } from 'vitest';
import { MockTransport, PHYSICAL_KEYS, UnsafeCommandError } from '../src/protocol';
import { checkPerformanceWrite } from '../src/protocol/safety';
import type { Performance } from '../src/protocol';

const base: Performance = {
  mode: 0, normalPress: 1.5, normalRelease: 1.5, rtFirstTouch: 0.5, rtPress: 0.3, rtRelease: 0.3,
  pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 1, calibrate: 1, axisV2Id: 7, axisRangeMax: 3500, axisCoefficient: 120,
};
const rec = (over: Partial<Performance>): Performance => ({ ...base, ...over });

describe('calibrate must equal the latest read', () => {
  it('seen [1, 0]: a write with 1 is refused, a write with 0 passes', () => {
    const seen = [rec({ calibrate: 1 }), rec({ calibrate: 0 })];
    expect(checkPerformanceWrite(rec({ calibrate: 1 }), seen)).toBe(
      'sensor field calibrate would change (0 → 1): must equal the latest read',
    );
    expect(checkPerformanceWrite(rec({ calibrate: 0 }), seen)).toBeNull();
  });

  it('seen [1]: a write with 1 passes, a write with 0 is refused', () => {
    const seen = [rec({ calibrate: 1 })];
    expect(checkPerformanceWrite(rec({ calibrate: 1 }), seen)).toBeNull();
    expect(checkPerformanceWrite(rec({ calibrate: 0 }), seen)).toMatch(/calibrate would change \(1 → 0\).*latest read/);
  });

  it('axis: an earlier seen value still passes', () => {
    const seen = [rec({ axis: 1 }), rec({ axis: 0 })];
    expect(checkPerformanceWrite(rec({ axis: 1 }), seen)).toBeNull();
    expect(checkPerformanceWrite(rec({ axis: 2 }), seen)).toMatch(/axis would change/);
  });

  it('after a switch change the board reports calibrate 0: a write with 1 throws and sends nothing', async () => {
    const t = new MockTransport({ latencyMs: 0 });
    await t.getDeviceInfo(); // sets the board id the catalog check needs
    const w = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
    const before = await t.getPerformance(w);
    expect(before.calibrate).toBe(1);
    // Apollo: a catalog switch of the Max board, different from W's UR.
    await t.setPerformance(w, { ...before, axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 });
    const after = await t.getPerformance(w);
    expect(after.calibrate).toBe(0);

    const write = vi.spyOn(t as unknown as { write(p: number[]): Promise<void> }, 'write');
    await expect(t.setPerformance(w, { ...after, calibrate: 1 })).rejects.toBeInstanceOf(UnsafeCommandError);
    expect(write).not.toHaveBeenCalled();
    await expect(t.setPerformance(w, { ...after, rtPress: 0.5 })).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
