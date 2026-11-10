import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { ActuationModel, MISMATCH_MS, TravelRing, releasePoint, settingsFrom, useLiveStore } from '../src/stores/live';
import type { ActuationSettings } from '../src/stores/live';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { keyIdForCode } from '../src/components/live/demoPress';

const STD: ActuationSettings = {
  mode: 0, normalPress: 2, normalRelease: 0, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3,
  pressDeadStroke: 0, releaseDeadStroke: 0, range: 3.31,
};
const RT: ActuationSettings = { ...STD, mode: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.2 };
/** Rapid Trigger without Continuous RT (factory driver IntervalRT). */
const RT2: ActuationSettings = { ...RT, mode: 2 };

/** Feed a travel sequence; returns the events as 'P@mm' / 'R@mm'. */
function run(m: ActuationModel, seq: number[]): string[] {
  const out: string[] = [];
  for (const mm of seq) {
    const e = m.update(mm);
    if (e) out.push(`${e === 'press' ? 'P' : 'R'}@${mm}`);
  }
  return out;
}

describe('ActuationModel — standard', () => {
  it('actuates at normalPress (inclusive) and releases below it', () => {
    const m = new ActuationModel(STD);
    expect(run(m, [0, 1, 1.99, 2, 2.5, 3.31, 2.5, 2.0, 1.99, 0])).toEqual(['P@2', 'R@1.99']);
    expect(m.actuated).toBe(false);
  });

  it('uses normalRelease as the release point when set (hysteresis)', () => {
    const m = new ActuationModel({ ...STD, normalRelease: 1.5 });
    expect(run(m, [2.1, 1.8, 1.6, 1.5, 1.49, 1.9, 2.0])).toEqual(['P@2.1', 'R@1.49', 'P@2']);
  });

  it('ignores a normalRelease deeper than the press point (no oscillation)', () => {
    const s = { ...STD, normalRelease: 2.5 };
    expect(releasePoint(s)).toBe(2);
    const m = new ActuationModel(s);
    expect(run(m, [2.1, 2.2, 2.3, 2.0, 1.9])).toEqual(['P@2.1', 'R@1.9']);
  });

  it('top dead zone never actuates, even with a shallow actuation point', () => {
    const m = new ActuationModel({ ...STD, normalPress: 0.1, pressDeadStroke: 0.2 });
    expect(run(m, [0.1, 0.15, 0.2])).toEqual([]);
    expect(run(m, [0.21])).toEqual(['P@0.21']);
    expect(run(m, [0.2])).toEqual(['R@0.2']);
  });

  it('bottom dead zone counts as fully pressed', () => {
    const m = new ActuationModel({ ...STD, normalPress: 3.25, releaseDeadStroke: 0.15 });
    expect(m.effective(3.2)).toBe(3.31);
    expect(run(m, [3.0, 3.2, 3.1])).toEqual(['P@3.2', 'R@3.1']);
  });

  it('never shows RT lines', () => {
    const m = new ActuationModel(STD);
    run(m, [3]);
    expect(m.resetAt).toBeNull();
    expect(m.reactuateAt).toBeNull();
  });
});

describe('ActuationModel — Rapid Trigger', () => {
  it('first actuation at rtFirstTouch, release after rising rtRelease from the peak', () => {
    const m = new ActuationModel(RT);
    expect(run(m, [0.5, 0.99, 1.0])).toEqual(['P@1']);
    expect(run(m, [2.0, 2.5, 2.4, 2.31])).toEqual([]);
    expect(m.peak).toBe(2.5);
    expect(m.resetAt).toBeCloseTo(2.3);
    expect(run(m, [2.3])).toEqual(['R@2.3']);
  });

  it('re-actuates after going rtPress below the trough, tracking the trough while released', () => {
    const m = new ActuationModel(RT);
    run(m, [1.2, 2.5, 2.2]); // press, then release at 2.2
    expect(m.actuated).toBe(false);
    expect(m.armed).toBe(true);
    expect(run(m, [2.0, 1.8])).toEqual([]); // keeps rising: trough follows
    expect(m.trough).toBe(1.8);
    expect(m.reactuateAt).toBeCloseTo(2.1);
    expect(run(m, [2.0, 2.1])).toEqual(['P@2.1']);
    expect(m.peak).toBe(2.1);
  });

  it('without Continuous RT, rising above rtFirstTouch fully resets (released and disarmed)', () => {
    const m = new ActuationModel(RT2);
    run(m, [1.5, 3.0]);
    expect(run(m, [0.9])).toEqual(['R@0.9']);
    expect(m.armed).toBe(false);
    expect(m.reactuateAt).toBeNull();
    // Must reach rtFirstTouch again — rtPress below the trough is not enough.
    expect(run(m, [0.5, 0.9])).toEqual([]);
    expect(run(m, [1.0])).toEqual(['P@1']);
  });

  it('without Continuous RT, a release while released-but-armed above first touch does not emit twice', () => {
    const m = new ActuationModel(RT2);
    run(m, [2.0, 1.7]); // P, R
    expect(run(m, [1.5, 0.5])).toEqual([]);
    expect(m.armed).toBe(false);
  });

  it('without Continuous RT, the reset line never goes above the first-touch point', () => {
    const m = new ActuationModel({ ...RT2, rtRelease: 0.5 });
    run(m, [1.2]);
    expect(m.resetAt).toBe(1); // peak − rtRelease = 0.7, but rising above 1.0 releases first
    expect(run(m, [1.0, 0.99])).toEqual(['R@0.99']);
  });

  it('Continuous RT keeps tracking above the first actuation point until the key is fully up', () => {
    const m = new ActuationModel(RT);
    expect(run(m, [0.5, 1.0])).toEqual(['P@1']); // first actuation still at rtFirstTouch
    expect(run(m, [2.0, 1.8])).toEqual(['R@1.8']); // 2.0 − 0.2
    expect(run(m, [0.6, 0.4])).toEqual([]); // above rtFirstTouch: still armed, trough follows
    expect(m.armed).toBe(true);
    expect(m.reactuateAt).toBeCloseTo(0.7);
    expect(run(m, [0.7])).toEqual(['P@0.7']); // re-actuates 0.3 below the trough, above rtFirstTouch
    expect(m.resetAt).toBeCloseTo(0.5); // peak 0.7 − 0.2, not clamped to rtFirstTouch
    expect(run(m, [0])).toEqual(['R@0']); // fully up: released and disarmed
    expect(m.armed).toBe(false);
    expect(run(m, [0.5, 0.9])).toEqual([]); // the next press needs rtFirstTouch again
    expect(run(m, [1.0])).toEqual(['P@1']);
  });

  it('Continuous RT resets inside the top dead zone', () => {
    const m = new ActuationModel({ ...RT, pressDeadStroke: 0.2 });
    run(m, [1.5, 1.2]); // P, R
    expect(run(m, [0.15])).toEqual([]);
    expect(m.armed).toBe(false);
  });

  it('holding at the bottom dead zone does not release on noise', () => {
    const m = new ActuationModel({ ...RT, releaseDeadStroke: 0.2 });
    expect(run(m, [1.5, 3.2, 3.15, 3.12, 3.3])).toEqual(['P@1.5']);
    expect(m.peak).toBe(3.31);
    expect(run(m, [3.0])).toEqual(['R@3']); // 3.31 − 0.2 = 3.11 ≥ 3.0
  });

  it('top dead zone with RT: travel inside it counts as 0', () => {
    const m = new ActuationModel({ ...RT, rtFirstTouch: 0.1, pressDeadStroke: 0.15 });
    expect(run(m, [0.12, 0.15])).toEqual([]);
    expect(run(m, [0.16])).toEqual(['P@0.16']);
  });

  it('settings can change mid-press (markers follow edits)', () => {
    const m = new ActuationModel(RT);
    run(m, [2.0]);
    m.settings = { ...RT, rtRelease: 1.0 };
    expect(run(m, [1.5])).toEqual([]);
    expect(run(m, [1.0])).toEqual(['R@1']);
  });

  it('matches the demo emulator on a press / partial lift / re-press sequence', async () => {
    const perf: Performance = {
      mode: 1, normalPress: 2, normalRelease: 2, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.3,
      pressDeadStroke: 0.1, releaseDeadStroke: 0, axis: 0, calibrate: 1, axisV2Id: 0, axisRangeMax: 3310, axisCoefficient: 0,
    };
    const m = new ActuationModel(settingsFrom(perf));
    expect(m.settings.range).toBe(3.31);
    const seq = [0.05, 0.5, 1.0, 2.0, 3.31, 3.1, 2.9, 2.5, 3.0, 3.31, 2.0, 0.6, 0];
    // Mirror of MockTransport.simulatePress's state machine.
    const mock = new MockTransport({ latencyMs: 0 });
    const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
    for (const mm of seq) {
      m.update(mm);
      mock.simulatePress(W.id, mm);
      const status = (await mock.getAxisData('keyStatus', W.row)).values[W.col];
      expect(m.actuated, `at ${mm}`).toBe(status > 0);
    }
  });
});

describe('TravelRing', () => {
  it('keeps the newest samples in order and filters by time', () => {
    const r = new TravelRing(4);
    for (let i = 0; i < 6; i++) r.push(i * 10, i / 10);
    const seen: number[] = [];
    r.forEach(0, (t) => seen.push(t));
    expect(seen).toEqual([20, 30, 40, 50]);
    const recent: number[] = [];
    r.forEach(35, (t) => recent.push(t));
    expect(recent).toEqual([40, 50]);
    r.clear();
    r.forEach(0, () => { throw new Error('not empty'); });
  });
});

describe('demo key mapping', () => {
  it('maps KeyboardEvent.code to physical keys', () => {
    const name = (code: string) => PHYSICAL_KEYS[keyIdForCode(code)!]?.name;
    expect(name('KeyW')).toBe('W');
    expect(name('Escape')).toBe('Esc');
    expect(name('Space')).toBe('Space');
    expect(name('ShiftRight')).toBe('Shift');
    expect(name('ArrowRight')).toBe('→');
    expect(name('Delete')).toBe('Del');
    expect(keyIdForCode('F5')).toBeUndefined();
  });
});

describe('live store (poller over MockTransport)', () => {
  const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
  const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;
  const until = async (cond: () => boolean, ms = 1500) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('timeout');
      await new Promise((r) => setTimeout(r, 5));
    }
  };

  beforeEach(async () => {
    setActivePinia(createPinia());
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
  });
  afterEach(() => useLiveStore().stop());

  it('tracks the pinned key, counts actuations and agrees with firmware status', async () => {
    const live = useLiveStore();
    const mock = useDeviceStore().transport as MockTransport;
    live.pin(W.id);
    live.start();
    mock.simulatePress(W.id, 2.0);
    await until(() => live.data.current > 1.9 && live.data.firmwarePressed);
    expect(live.data.travel[W.id]).toBeCloseTo(2.0, 3);
    expect(live.data.ratio[W.id]).toBeCloseTo(2000 / 3310, 4);
    expect(live.data.count).toBe(1);
    expect(live.data.lastActuation).toBeCloseTo(2.0, 3);
    expect(live.data.model?.actuated).toBe(true);
    mock.simulatePress(W.id, 0);
    await until(() => live.data.current === 0 && !live.data.firmwarePressed);
    expect(live.data.lastRelease).toBe(0);
    expect(live.data.events.map((e) => e.kind)).toEqual(['press', 'release']);
    expect(live.data.mismatch).toBe(false);
    expect(live.data.ring.size).toBeGreaterThan(2);
  });

  it('auto-follow moves focus to the deepest key', async () => {
    const live = useLiveStore();
    const mock = useDeviceStore().transport as MockTransport;
    live.setFocus(W.id);
    live.start();
    mock.simulatePress(A.id, 1.5);
    await until(() => live.focusId === A.id);
    expect(live.data.current).toBeCloseTo(1.5, 3);
  });

  it('suspendFollow keeps the focused key (and the epoch) until it is lifted', async () => {
    const live = useLiveStore();
    const mock = useDeviceStore().transport as MockTransport;
    live.setFocus(W.id);
    live.start();
    live.suspendFollow(true);
    const epoch = live.data.epoch;
    mock.simulatePress(A.id, 1.5);
    await until(() => live.data.travel[A.id] > 1.4);
    await new Promise((r) => setTimeout(r, 40));
    expect(live.focusId).toBe(W.id);
    expect(live.data.epoch).toBe(epoch);
    live.suspendFollow(false);
    await until(() => live.focusId === A.id);
  });

  it('flags a mismatch when firmware disagrees with the settings for long enough', async () => {
    const live = useLiveStore();
    const perf = usePerformanceStore();
    const mock = useDeviceStore().transport as MockTransport;
    live.pin(W.id);
    live.start();
    // The UI thinks actuation is at 3.0 mm (unsaved edit); the firmware still fires at 1.0 mm.
    perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], rtFirstTouch: 3.0 } };
    mock.simulatePress(W.id, 2.0);
    await until(() => live.data.firmwarePressed);
    await new Promise((r) => setTimeout(r, MISMATCH_MS + 60));
    await until(() => live.data.mismatch);
    expect(live.data.model?.actuated).toBe(false);
  });

  it('pauses while an exclusive job runs and stops on disconnect', async () => {
    const live = useLiveStore();
    const device = useDeviceStore();
    live.pin(W.id);
    live.start();
    let release!: () => void;
    const job = device.withTransport(() => new Promise<void>((r) => { release = r; }), { exclusive: true });
    await until(() => live.paused);
    const v = live.data.version;
    await new Promise((r) => setTimeout(r, 60));
    expect(live.data.version).toBe(v);
    release();
    await job;
    await until(() => !live.paused && live.data.version > v);
    await device.disconnect();
    await until(() => !live.running);
  });
});

describe('ActuationModel — Rapid Trigger near the bottom', () => {
  // The real keyboard's defaults (device snapshot of the S key): Continuous RT, first touch 1.00,
  // rtPress 0.80, rtRelease 0.30, dead zones 0.10, range 3.31.
  const S: ActuationSettings = {
    mode: 1, normalPress: 2, normalRelease: 0, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.3,
    pressDeadStroke: 0.1, releaseDeadStroke: 0.1, range: 3.31,
  };
  /** 0.05 mm steps through the waypoints, rounded to 0.01 like device samples. */
  function path(points: number[]): number[] {
    const out: number[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i], n = Math.max(1, Math.round(Math.abs(b - a) / 0.05));
      for (let k = 1; k <= n; k++) out.push(Math.round((a + ((b - a) * k) / n) * 100) / 100);
    }
    return out;
  }

  it('re-actuates on reaching the bottom after a lift whose trough + rtPress is past the bottom', () => {
    const m = new ActuationModel(S);
    const events = run(m, path([0, 2.87, 2.02, 2.87, 2.55, 3.27]));
    expect(events.slice(0, 4).map((e) => e[0])).toEqual(['P', 'R', 'P', 'R']);
    expect(events.at(-1)?.[0]).toBe('P'); // 2.55 + 0.80 = 3.35 > 3.31: the bottom band re-actuates
    expect(m.actuated).toBe(true);
    expect(m.reactuateAt).toBeNull();
  });

  it('shows the same re-actuation point it uses', () => {
    const m = new ActuationModel(S);
    run(m, path([0, 3.0, 2.55]));
    expect(m.actuated).toBe(false);
    expect(m.reactuateAt).toBeCloseTo(3.31);
    expect(run(m, [3.2])).toEqual([]); // 3.2 is above the bottom dead zone and short of 3.35
    expect(run(m, [3.25])).toEqual(['P@3.25']); // inside the bottom dead zone (≥ 3.21) = full travel
  });
});
