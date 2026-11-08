import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS, SAVE_GROUP } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useCalibrationStore } from '../src/stores/calibration';
import { useLiveStore } from '../src/stores/live';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('calibration store', () => {
  let mock: MockTransport;

  beforeEach(async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo();
    mock = device.transport as MockTransport;
  });
  afterEach(() => vi.restoreAllMocks());

  it('refresh reads ADC / route / calibration for every key', async () => {
    const cal = useCalibrationStore();
    await cal.refresh();
    const f = cal.frame;
    expect(f.status.every((s) => s === 1)).toBe(true);
    expect(cal.calibratedCount).toBe(64);
    expect(f.adc.every((a) => a > 0)).toBe(true);
    const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;
    expect(f.adc[A.id]).toBe(2760); // snapshot row 3 col 1
  });

  it('start → poll → finish sends 02 06 00, 02 06 01 and commits group 1', async () => {
    const cal = useCalibrationStore();
    const live = useLiveStore();
    live.pin(W.id);
    live.start();
    const start = vi.spyOn(mock, 'startCalibration');
    const stop = vi.spyOn(mock, 'stopCalibration');
    const commit = vi.spyOn(mock, 'commit');

    await cal.start();
    expect(start).toHaveBeenCalledOnce();
    expect(cal.error).toBe(null);
    expect(cal.phase).toBe('running');
    expect(live.running).toBe(false);

    // Press W to the bottom: the emulator reports it as newly calibrated (2).
    mock.simulatePress(W.id, 3.31);
    await until(() => cal.frame.status[W.id] === 2);
    expect(cal.newCount).toBe(1);
    expect(cal.frame.route[W.id]).toBe(3310);
    // Released: the emulator drops back to 1, the store keeps it as newly calibrated.
    mock.simulatePress(W.id, 0);
    await until(() => cal.frame.route[W.id] === 0);
    expect(cal.frame.status[W.id]).toBe(2);

    await cal.finish();
    expect(stop).toHaveBeenCalledOnce();
    expect(commit.mock.calls.map((c) => c[0])).toEqual([SAVE_GROUP.CALIBRATION]);
    expect(cal.phase).toBe('idle');
    expect(cal.frame.status[W.id]).toBe(1);
  });

  it('cancel stops calibration without committing', async () => {
    const cal = useCalibrationStore();
    const stop = vi.spyOn(mock, 'stopCalibration');
    const commit = vi.spyOn(mock, 'commit');
    await cal.start();
    await cal.cancel();
    expect(stop).toHaveBeenCalledOnce();
    expect(commit).not.toHaveBeenCalled();
    expect(cal.phase).toBe('idle');
  });

  it('is refused on a board outside the allowlist (writes blocked)', async () => {
    const device = useDeviceStore();
    // Simulate a read-only session: the transport's write guard refuses 02 06.
    vi.spyOn(mock, 'startCalibration').mockRejectedValue(new Error('write refused'));
    const cal = useCalibrationStore();
    await cal.start();
    expect(cal.phase).toBe('idle');
    expect(cal.error).toBe('write refused');
    expect(device.connected).toBe(true);
  });
});
