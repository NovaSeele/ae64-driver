// Key check (part C): the live store's peaks and "not back to 0", the summary the page shows, and the batched
// screen-reader sentences. DESIGN C §3.1–§3.2, §7, §11.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MockTransport, Performance, PhysicalKey } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { FULL_TRAVEL, PRESSED_MM, REST_ARM_MM, REST_OFF_MM, REST_OFF_MS, STUCK_ANNOUNCE_MS, useLiveStore } from '../src/stores/live';
import { CheckAnnouncer, isFull, rangeOf, summarizeCheck } from '../src/components/live/keyCheck';
import { t } from '../src/i18n/vi';
import { locale } from '../src/i18n/locale';

let live: ReturnType<typeof useLiveStore>;
let device: ReturnType<typeof useDeviceStore>;
const key = (name: string): PhysicalKey => device.keys.find((k) => k.name === name)!;

/** Feed one route read of the key's row with the key at `mm` (the other keys of the row at rest). */
function route(k: PhysicalKey, mm: number, now: number): void {
  const vals = new Array(16).fill(0);
  vals[k.col] = Math.round(mm * 1000);
  live.ingest('route', k.row, vals, now);
}
function status(k: PhysicalKey, st: number, now: number): void {
  const vals = new Array(16).fill(0);
  vals[k.col] = st;
  live.ingest('keyStatus', k.row, vals, now);
}
const view = () => summarizeCheck(live.data, device.keys, usePerformanceStore().values);

beforeEach(async () => {
  setActivePinia(createPinia());
  locale.value = 'vi';
  device = useDeviceStore();
  await device.connectDemo();
  live = useLiveStore();
  live.resetPeaks(0);
});

describe('key check — thresholds', () => {
  it('has the documented constants', () => {
    expect([PRESSED_MM, REST_ARM_MM, REST_OFF_MM, REST_OFF_MS, STUCK_ANNOUNCE_MS, FULL_TRAVEL]).toEqual([0.3, 0.5, 0.2, 800, 2000, 0.95]);
  });
});

describe('key check — peaks (C1)', () => {
  it('a key held still changes nothing: checkVersion moves at most once over 2 s (Float32 storage, C-F32-1)', () => {
    const w = key('W'), e = key('E');
    // W held at 3.31 for 2 s, one sample every 10 ms: the first sample is the new deepest reading, the rest are not
    route(w, 3.31, 0);
    let v = live.data.checkVersion;
    for (let now = 10; now <= 2000; now += 10) route(w, 3.31, now);
    expect(live.data.checkVersion - v).toBeLessThanOrEqual(1);
    // E stuck at 0.42 (released by the firmware): once counted stuck, staying there moves nothing either
    route(e, 3.0, 3000);
    status(e, 1, 3001);
    status(e, 0, 3002);
    route(e, 0.42, 3010);
    route(e, 0.42, 3010 + REST_OFF_MS);
    expect(live.data.restOffMm[e.id]).toBeCloseTo(0.42, 5);
    v = live.data.checkVersion;
    for (let now = 3020 + REST_OFF_MS; now <= 5020 + REST_OFF_MS; now += 10) route(e, 0.42, now);
    expect(live.data.checkVersion - v).toBeLessThanOrEqual(1);
  });

  it('peakMm follows a press made with mock.simulatePress and does not drop on release', async () => {
    const mock = device.transport as MockTransport;
    const w = key('W');
    const read = async (now: number) => {
      const r = await mock.getAxisData('route', w.row);
      live.ingest('route', w.row, r.values, now);
    };
    mock.simulatePress(w.id, 1.2);
    await read(10);
    expect(live.data.peakMm[w.id]).toBeCloseTo(1.2, 2);
    mock.simulatePress(w.id, 2.6);
    await read(20);
    expect(live.data.peakMm[w.id]).toBeCloseTo(2.6, 2);
    mock.simulatePress(w.id, 0);
    await read(30);
    expect(live.data.travel[w.id]).toBe(0);
    expect(live.data.peakMm[w.id]).toBeCloseTo(2.6, 2);
    expect(live.data.peakRatio[w.id]).toBeCloseTo(2.6 / 3.31, 2);
    expect(live.data.pressedIds.has(w.id)).toBe(true);
  });

  it('resetPeaks empties everything and starts the check clock', () => {
    const w = key('W');
    route(w, 3.0, 10);
    status(w, 0, 11);
    route(w, 0.42, 12);
    route(w, 0.42, 900);
    expect(live.data.restOffMm[w.id]).toBeCloseTo(0.42, 3);
    const v = live.data.checkVersion;
    live.resetPeaks(1234);
    expect(live.data.peakMm[w.id]).toBe(0);
    expect(live.data.peakRatio[w.id]).toBe(0);
    expect(live.data.restOffMm[w.id]).toBe(0);
    expect(live.data.offSince[w.id]).toBe(-1);
    expect(live.data.pressedIds.size).toBe(0);
    expect(live.data.checkStartedAt).toBe(1234);
    expect(live.data.checkVersion).toBe(v + 1);
    // the key is still deep after the reset, but it has to go past REST_ARM_MM again to be stuck
    route(w, 0.42, 2000);
    route(w, 0.42, 3000);
    expect(live.data.restOffMm[w.id]).toBe(0);
  });

  it('reset() (profile or keyboard changed) also starts the check over', () => {
    const w = key('W');
    route(w, 2, 10);
    expect(live.data.pressedIds.size).toBe(1);
    live.reset();
    expect(live.data.pressedIds.size).toBe(0);
    expect(live.data.peakMm[w.id]).toBe(0);
  });

  it('counts a key as pressed above PRESSED_MM only: 0.29 no, 0.31 yes', () => {
    const w = key('W');
    route(w, 0.29, 10);
    expect(live.data.pressedIds.has(w.id)).toBe(false);
    expect(view().pressed).toBe(0);
    expect(view().marks[w.id]).toBeUndefined();
    route(w, 0.31, 20);
    expect(live.data.pressedIds.has(w.id)).toBe(true);
    expect(view().pressed).toBe(1);
    expect(view().marks[w.id]).toBeCloseTo(0.31 / 3.31, 3);
  });

  it('bumps checkVersion only when something the check shows changed', () => {
    const w = key('W');
    route(w, 1, 10);
    const v = live.data.checkVersion;
    route(w, 0.8, 20); // shallower: nothing new
    route(w, 0.8, 30);
    expect(live.data.checkVersion).toBe(v);
    route(w, 1.1, 40);
    expect(live.data.checkVersion).toBe(v + 1);
  });

  it('remembers the keys that came back up after a press, once each, until drained', () => {
    const w = key('W'), a = key('A');
    route(w, 1, 10);
    route(a, 1, 10);
    route(w, 0.1, 20);
    route(w, 1, 30);
    route(w, 0.1, 40);
    expect(live.drainReleased()).toEqual([w.id]);
    expect(live.drainReleased()).toEqual([]);
  });
});

describe('key check — not back to 0 (fake clock)', () => {
  /** Press W to 3.0 mm, firmware releases, the key stays at `mm` from t = 100. */
  function stick(mm = 0.42) {
    const w = key('W');
    route(w, 3.0, 0);
    status(w, 1, 1);
    status(w, 0, 50);
    route(w, mm, 100);
    return w;
  }

  it('799 ms: not yet; 801 ms: stuck at 0.42', () => {
    const w = stick();
    route(w, 0.42, 899);
    expect(live.data.restOffMm[w.id]).toBe(0);
    expect(view().stuck).toBe(0);
    route(w, 0.42, 901);
    expect(live.data.restOffMm[w.id]).toBeCloseTo(0.42, 3);
    expect(view().stuck).toBe(1);
    expect(view().issues[0]).toMatchObject({ id: w.id, kind: 'stuck' });
    expect(view().issues[0].mm).toBeCloseTo(0.42, 3);
  });

  it('follows the travel while stuck, and clears below 0.20 mm', () => {
    const w = stick();
    route(w, 0.42, 1000);
    route(w, 0.35, 1100);
    expect(live.data.restOffMm[w.id]).toBeCloseTo(0.35, 3);
    route(w, 0.2, 1200); // 0.20 is not below 0.20: still stuck
    expect(live.data.restOffMm[w.id]).toBeCloseTo(0.2, 3);
    route(w, 0.19, 1300);
    expect(live.data.restOffMm[w.id]).toBe(0);
    expect(live.data.offSince[w.id]).toBe(-1);
    expect(view().stuck).toBe(0);
  });

  it('0.25 mm held for 1 s is stuck (the clear threshold is 0.20, not more)', () => {
    const w = stick(0.25);
    route(w, 0.25, 1000);
    expect(live.data.restOffMm[w.id]).toBeCloseTo(0.25, 3);
  });

  it('a key that never went past 0.5 mm is never stuck', () => {
    const w = key('W');
    status(w, 0, 0);
    route(w, 0.45, 100);
    route(w, 0.45, 5000);
    expect(live.data.restOffMm[w.id]).toBe(0);
    route(w, 0.51, 5100); // past REST_ARM_MM once: from now on it counts
    route(w, 0.45, 5200);
    route(w, 0.45, 6100);
    expect(live.data.restOffMm[w.id]).toBeCloseTo(0.45, 3);
  });

  it('0.45 mm after a press to 0.45 is not stuck: REST_ARM_MM is 0.5, not 0.4', () => {
    const w = key('W');
    status(w, 0, 0);
    route(w, 0.45, 100);
    route(w, 0.42, 200);
    route(w, 0.42, 2000);
    expect(live.data.restOffMm[w.id]).toBe(0);
  });

  it('is not stuck while the firmware reports the key pressed', () => {
    const w = key('W');
    route(w, 3.0, 0);
    status(w, 1, 1);
    route(w, 0.42, 100);
    route(w, 0.42, 3000);
    expect(live.data.restOffMm[w.id]).toBe(0);
    // stuck, then the firmware reads it pressed again: no longer stuck
    status(w, 0, 3001);
    route(w, 0.42, 3002);
    route(w, 0.42, 3900);
    expect(live.data.restOffMm[w.id]).toBeGreaterThan(0);
    status(w, 1, 3901);
    expect(live.data.restOffMm[w.id]).toBe(0);
  });

  it('700 ms is not enough (REST_OFF_MS is 800)', () => {
    const w = stick();
    route(w, 0.42, 820);
    expect(live.data.restOffMm[w.id]).toBe(0);
  });
});

describe('key check — full travel (C2)', () => {
  const S = (axisRangeMax: number) => ({ axisRangeMax } as Performance);

  it('95 % of the switch travel: 3.15 / 3.31 full, 3.12 and 3.10 short', () => {
    expect(isFull(3.15, 3.31)).toBe(true);
    expect(isFull(3.12, 3.31)).toBe(false); // 94.3 %: full at 94 %, short at 95 %
    expect(isFull(3.10, 3.31)).toBe(false);
    // exactly 95 %, and the same depth as the store keeps it (Float32): full
    expect(isFull(0.95 * 3.4, 3.4)).toBe(true);
    expect(isFull(Math.fround(3.23), 3.4)).toBe(true);
    expect(isFull(Math.fround(3.1445), 3.31)).toBe(true);
  });

  it('uses the key travel from the settings; 3.31 mm, estimated, while it is not read', () => {
    expect(rangeOf(S(4000))).toBe(4);
    expect(rangeOf(undefined)).toBe(3.31);
    expect(rangeOf(S(0))).toBe(3.31);
    const w = key('W'), a = key('A'), e = key('E');
    route(w, 3.15, 10);
    route(a, 3.10, 10);
    route(e, 3.12, 10);
    const none = summarizeCheck(live.data, device.keys, {});
    expect(none.estimated).toBe(true);
    expect(none.kinds[w.id]).toBe('ok');
    expect(none.kinds[a.id]).toBe('short');
    expect(none.kinds[e.id]).toBe('short');
    expect([none.pressed, none.full, none.short]).toEqual([3, 1, 2]);
    const all: Record<number, Performance> = {};
    for (const k of device.keys) all[k.id] = S(3310);
    expect(summarizeCheck(live.data, device.keys, all).estimated).toBe(false);
    all[a.id] = S(3200); // A's switch is shorter: 3.10 is 96.9 % of it
    expect(summarizeCheck(live.data, device.keys, all).kinds[a.id]).toBe('ok');
    // a key whose settings are read but whose travel is 0 (not reported): estimated too, its travel is 3.31
    all[key('Z').id] = S(0);
    expect(summarizeCheck(live.data, device.keys, all).estimated).toBe(true);
  });

  it('keeps what did not change: the same view when nothing changed, the same row and issue objects otherwise (C-PERF-1)', () => {
    const w = key('W'), a = key('A'), s = key('S');
    route(w, 3.31, 10);
    route(a, 2.0, 10);
    route(s, 1.0, 10);
    const v1 = view();
    expect(summarizeCheck(live.data, device.keys, usePerformanceStore().values, (k) => k.name, v1)).toBe(v1);
    route(s, 1.5, 20); // only S went deeper
    const v2 = summarizeCheck(live.data, device.keys, usePerformanceStore().values, (k) => k.name, v1);
    expect(v2).not.toBe(v1);
    const row = (v: typeof v1, id: number) => v.rows.find((r) => r.id === id);
    const iss = (v: typeof v1, id: number) => v.issues.find((i) => i.id === id);
    expect(row(v2, w.id)).toBe(row(v1, w.id));
    expect(row(v2, a.id)).toBe(row(v1, a.id));
    expect(row(v2, s.id)).not.toBe(row(v1, s.id));
    expect(row(v2, s.id)!.mm).toBeCloseTo(1.5, 5);
    expect(iss(v2, a.id)).toBe(iss(v1, a.id));
    expect(iss(v2, s.id)).not.toBe(iss(v1, s.id));
  });

  it('a full key that becomes stuck gets a new row: only its kind changed (C-TEST-2 #42)', () => {
    const d = key('D');
    route(d, 3.31, 0); // full travel
    status(d, 1, 1);
    status(d, 0, 50); // released by the firmware, the key stays at 0.42
    route(d, 0.42, 100);
    const v1 = view();
    const r1 = v1.rows.find((r) => r.id === d.id)!;
    expect(r1.kind).toBe('ok');
    route(d, 0.42, 100 + REST_OFF_MS + 100); // past 0.8 s: stuck; the peak, ratio and bar are the same
    const v2 = summarizeCheck(live.data, device.keys, usePerformanceStore().values, (k) => k.name, v1);
    const r2 = v2.rows.find((r) => r.id === d.id)!;
    expect([r2.mm, r2.ratio, r2.bar]).toEqual([r1.mm, r1.ratio, r1.bar]);
    expect(r2.kind).toBe('stuck');
    expect(r2).not.toBe(r1);
    route(d, 0, 2000); // back to 0: full again
    const v3 = summarizeCheck(live.data, device.keys, usePerformanceStore().values, (k) => k.name, v2);
    expect(v3.rows.find((r) => r.id === d.id)!.kind).toBe('ok');
  });

  it('a deeper reading past a shorter switch travel still updates its row (the bar stays full, the mm does not)', () => {
    const d = key('D');
    const short = { [d.id]: { axisRangeMax: 3000 } as Performance }; // a 3.0 mm switch: 3.10 and 3.25 both fill the bar
    route(d, 3.10, 10);
    const v1 = summarizeCheck(live.data, device.keys, short);
    route(d, 3.25, 20);
    const v2 = summarizeCheck(live.data, device.keys, short, (k) => k.name, v1);
    const r1 = v1.rows.find((r) => r.id === d.id)!, r2 = v2.rows.find((r) => r.id === d.id)!;
    expect(r2.ratio).toBe(r1.ratio);
    expect(r2.mm).toBeCloseTo(3.25, 5);
  });

  it('orders issues stuck first, then short shallowest first; rows deepest first then by name', () => {
    const w = key('W'), a = key('A'), y = key('Y'), e = key('E'), s = key('S'), d = key('D');
    route(a, 2.81, 0); route(e, 3.02, 0); route(y, 3.10, 0); route(s, 3.31, 0); route(d, 3.31, 0);
    route(w, 3.31, 0); status(w, 1, 1); status(w, 0, 2); route(w, 0.42, 10); route(w, 0.42, 900);
    const v = summarizeCheck(live.data, device.keys, {});
    expect(v.issues.map((i) => i.name)).toEqual(['W', 'A', 'E', 'Y']);
    expect(v.rows.map((r) => r.name)).toEqual(['D', 'S', 'W', 'Y', 'E', 'A']);
    // W is full and stuck: counted in both, shown as stuck, its bar by depth
    expect([v.pressed, v.full, v.short, v.stuck]).toEqual([6, 3, 3, 1]);
    expect(v.rows.find((r) => r.name === 'W')).toMatchObject({ kind: 'stuck', bar: 'ok' });
  });
});

describe('key check — screen-reader sentences (§7)', () => {
  const names = (id: number) => device.keys[id].name;
  const say = (a: CheckAnnouncer, now: number) => a.tick(live.data, view(), live.drainReleased(), names, now, t);

  it('stuck 1999 ms: silent; 2001 ms: announced exactly once', () => {
    const a = new CheckAnnouncer();
    const w = key('W');
    route(w, 3.31, 0); status(w, 1, 1); status(w, 0, 2);
    route(w, 0.42, 100); // offSince 100
    route(w, 0.42, 901); // stuck from here on (shown)
    expect(view().stuck).toBe(1);
    route(w, 0.42, 2099);
    expect(say(a, 2099)).toBeNull();
    route(w, 0.42, 2101);
    expect(say(a, 2101)).toBe(t('live.announceStuck', { key: 'W', mm: '0.42' }));
    route(w, 0.42, 3600);
    expect(say(a, 3600)).toBeNull();
  });

  it('a finger resting partway with Rapid Trigger: counted and shown, not read; lifted: gone, nothing read', () => {
    const a = new CheckAnnouncer();
    const w = key('W');
    route(w, 3.31, 0); status(w, 1, 1);
    route(w, 1.5, 100); status(w, 0, 110); // RT released mid-travel, the finger stays at 1.5 mm
    route(w, 1.5, 120);
    route(w, 1.5, 1100);
    expect(view().stuck).toBe(1);
    expect(view().issues.map((i) => i.kind)).toEqual(['stuck']);
    expect(say(a, 1100)).toBeNull();
    route(w, 0.1, 1200);
    expect(view().stuck).toBe(0);
    expect(view().issues).toEqual([]);
    expect(say(a, 2600)).toBeNull();
  });

  it('keys released short are read together; full keys are silent; all keys once', () => {
    const a = new CheckAnnouncer();
    const w = key('W'), q = key('Q'), e = key('E');
    route(q, 2.8, 0); route(e, 2.9, 0); route(w, 3.31, 0);
    route(q, 0, 10); route(e, 0, 10); route(w, 0, 10);
    expect(say(a, 1500)).toBe(t('live.announceShort', { keys: 'Q, E' }));
    expect(say(a, 3000)).toBeNull();
    for (const k of device.keys) route(k, 3.31, 4000);
    expect(say(a, 4500)).toBe(t('live.announceAll', { n: device.keys.length }));
    expect(say(a, 6000)).toBeNull();
  });

  it('start over is read first', () => {
    const a = new CheckAnnouncer();
    a.restart();
    expect(say(a, 0)).toBe(t('live.restartDone'));
    expect(say(a, 1500)).toBeNull();
  });
});
