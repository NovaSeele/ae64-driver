// Visual calibration, store side (DESIGN D §3.1, §11): the deepest route per key in the session (peakRoute), the keys a
// saved session calibrated (lastSaved), and the lists the page shows (pressed, too shallow, waiting). No HID command of
// their own: everything comes from the frames the session polls anyway.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useCalibrationStore } from '../src/stores/calibration';

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W'), A = key('A'), S = key('S'), D = key('D');

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let mock: MockTransport;
let cal: ReturnType<typeof useCalibrationStore>;
/** Press a key to `mm` and wait until a polled frame has it. */
async function press(id: number, mm: number) {
  mock.simulatePress(id, mm);
  const um = Math.round(mm * 1000);
  await until(() => cal.frame.route[id] === um);
}
/** Give one key its own switch travel (µm) in the performance store. */
function travel(id: number, um: number) {
  const perf = usePerformanceStore();
  const base = perf.values[id] ?? ({ axisRangeMax: 3310 } as Performance);
  perf.values = { ...perf.values, [id]: { ...base, axisRangeMax: um } };
}

beforeEach(async () => {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo();
  mock = device.transport as MockTransport;
  cal = useCalibrationStore();
  await cal.refresh();
});
afterEach(async () => {
  for (const k of [W, A, S, D]) mock.simulatePress(k.id, 0);
  if (cal.phase === 'running') await cal.cancel();
  vi.restoreAllMocks();
});

describe('peakRoute (D1)', () => {
  it('starts at 0 when a session starts, rises with the polled frames, and stays after Finish until the next start', async () => {
    await cal.start();
    expect([...cal.peakRoute].every((v) => v === 0)).toBe(true);
    await press(W.id, 2.0);
    await press(W.id, 1.0); // up again: the deepest stays
    expect(cal.peakRoute[W.id]).toBe(2000);
    await press(W.id, 0);
    await cal.finish();
    expect(cal.peakRoute[W.id]).toBe(2000); // kept to look back at
    await cal.start();
    expect(cal.peakRoute[W.id]).toBe(0); // a new session starts from nothing
  });

  it('a frame read after Finish was pressed is not the session\'s: it does not raise the peak', async () => {
    await cal.start();
    await press(W.id, 2.0);
    const read = mock.getAxisData.bind(mock);
    let finishing: Promise<boolean> | null = null;
    // the next read is in flight when Finish is pressed, and sees W pressed deeper
    vi.spyOn(mock, 'getAxisData').mockImplementation(async (type, row) => {
      if (!finishing) {
        mock.simulatePress(W.id, 2.9);
        finishing = cal.finish();
      }
      return read(type, row);
    });
    await until(() => finishing !== null);
    await finishing;
    expect(cal.phase).toBe('idle');
    expect(cal.peakRoute[W.id]).toBe(2000);
  });

  it('a new connection clears the peaks and the saved result', async () => {
    await cal.start();
    await press(W.id, 3.31);
    await press(W.id, 0);
    await cal.finish();
    expect(cal.lastSaved).toEqual([W.id]);
    useDeviceStore().connection++;
    await Promise.resolve();
    expect(cal.peakRoute[W.id]).toBe(0);
    expect(cal.lastSaved).toBe(null);
    expect(cal.hasSession).toBe(false);
  });
});

describe('lastSaved: proof that a session was saved', () => {
  it('Finish: the keys the session calibrated (status 2), kept green after the store turns them back to 1', async () => {
    await cal.start();
    expect(cal.lastSaved).toBe(null);
    await press(W.id, 3.31);
    await press(A.id, 3.2);
    await press(W.id, 0);
    await press(A.id, 0);
    expect(await cal.finish()).toBe(true);
    expect(cal.frame.status[W.id]).toBe(1); // the store's 2 → 1, as before
    expect(cal.lastSaved).toEqual([W.id, A.id].sort((a, b) => PHYSICAL_KEYS.findIndex((k) => k.id === a) - PHYSICAL_KEYS.findIndex((k) => k.id === b)));
    expect(cal.isNew(W.id)).toBe(true);
    expect(cal.isNew(S.id)).toBe(false);
    expect(cal.sessionNewCount).toBe(2);
  });

  it('null after Cancel, after a failed Finish, and once a new session starts', async () => {
    await cal.start();
    await press(W.id, 3.31);
    await press(W.id, 0);
    await cal.cancel();
    expect(cal.lastSaved).toBe(null);
    expect(cal.hasSession).toBe(false);

    await cal.start();
    await press(W.id, 3.31);
    await press(W.id, 0);
    vi.spyOn(mock, 'commit').mockRejectedValueOnce(new Error('commit failed'));
    expect(await cal.finish()).toBe(false);
    expect(cal.lastSaved).toBe(null);

    await cal.start();
    await press(W.id, 3.31);
    await press(W.id, 0);
    await cal.finish();
    expect(cal.lastSaved).toEqual([W.id]);
    await cal.start();
    expect(cal.lastSaved).toBe(null);
  });

  it('end() when the session already ended (a failed read stopped it) saves nothing and leaves lastSaved null', async () => {
    await cal.start();
    await press(W.id, 3.31);
    vi.spyOn(mock, 'getAxisData').mockRejectedValueOnce(new Error('poll failed'));
    await until(() => cal.phase === 'idle');
    const commit = vi.spyOn(mock, 'commit');
    expect(await cal.finish()).toBe(true); // end() on a session that is no longer running: nothing to do
    expect(commit).not.toHaveBeenCalled();
    expect(cal.lastSaved).toBe(null);
  });
});

describe('pressed and too shallow (D1, DESIGN D §3.1)', () => {
  it('pressed: deeper than 300 µm (0.300 is not, 0.301 is)', async () => {
    await cal.start();
    await press(W.id, 0.3);
    await press(W.id, 0);
    expect(cal.pressedIds).toEqual([]);
    await press(W.id, 0.301);
    await press(W.id, 0);
    expect(cal.pressedIds).toEqual([W.id]);
  });

  it('95 % of the key\'s own travel, on keys back at rest: 2.849 of 3.000 is too shallow, 2.850 is not', async () => {
    travel(W.id, 3000);
    travel(A.id, 3000);
    await cal.start();
    await press(W.id, 2.849);
    await press(A.id, 2.85);
    await press(W.id, 0);
    await press(A.id, 0);
    expect(cal.shallowIds).toEqual([W.id]);
    expect(cal.waitIds).toEqual([A.id]); // deep enough, the firmware has not said 2: waiting
  });

  it('another travel (3.15 mm): 2.992 is too shallow, 2.993 is not (95 % = 2.9925)', async () => {
    travel(S.id, 3150);
    travel(D.id, 3150);
    await cal.start();
    await press(S.id, 2.992);
    await press(D.id, 2.993);
    await press(S.id, 0);
    await press(D.id, 0);
    expect(cal.shallowIds).toEqual([S.id]);
  });

  it('while Finish reloads the performance store (values empty), a key keeps its own travel: not "too shallow"', async () => {
    travel(D.id, 3130);
    await cal.start();
    await press(D.id, 3.0); // 96 % of 3.13, but 91 % of the 3.31 default
    await press(D.id, 0);
    expect(cal.shallowIds).toEqual([]);
    usePerformanceStore().values = {}; // what load(true) does first
    expect(cal.rangeUm(D.id)).toBe(3130);
    expect(cal.shallowIds).toEqual([]);
    useDeviceStore().connection++; // another keyboard: what was read of this one is gone
    expect(cal.rangeUm(D.id)).toBe(3310);
  });

  it('a key held at 60 % is not too shallow yet; it is once released', async () => {
    await cal.start();
    await press(W.id, 1.99);
    expect(cal.pressedIds).toEqual([W.id]);
    expect(cal.shallowIds).toEqual([]);
    await press(W.id, 0.2); // back under 0.3 mm
    expect(cal.shallowIds).toEqual([W.id]);
  });

  it('a newly calibrated key (status 2) is never too shallow, even under 95 %', async () => {
    await cal.start();
    await press(W.id, 3.05); // the emulator says 2 past 3.0 mm; 3.05 is under 95 % of 3.31
    await press(W.id, 0);
    expect(cal.frame.status[W.id]).toBe(2);
    expect(cal.shallowIds).toEqual([]);
    expect(cal.waitIds).toEqual([]);
  });

  it('% not trusted: no key is too shallow (they wait instead)', async () => {
    cal.trustPeaks = false;
    await cal.start();
    await press(W.id, 1.5);
    await press(W.id, 0);
    expect(cal.shallowIds).toEqual([]);
    expect(cal.waitIds).toEqual([W.id]);
  });

  it('no session: nothing is pressed, nothing is too shallow', async () => {
    expect(cal.hasSession).toBe(false);
    expect(cal.pressedIds).toEqual([]);
    expect(cal.shallowIds).toEqual([]);
  });
});
