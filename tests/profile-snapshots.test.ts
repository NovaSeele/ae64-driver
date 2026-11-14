// DESIGN G §3.7, §11 item 3 (+ brief G cases 3b, 3c): the performance store keeps the values of each profile the app leaves
// (`profileSnapshots`), stamped with when it left, and drops a read that a profile switch interrupted. Demo keyboard only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { watch } from 'vue';
import { PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useSyncStore } from '../src/stores/sync';

vi.setConfig({ testTimeout: 30000 });

const WASD = ['W', 'A', 'S', 'D'].map((n) => PHYSICAL_KEYS.find((k) => k.name === n)!.id);
/** The demo's profile 2 "FPS" (index 1): W A S D Rapid Trigger 0.3, every other key Standard 1.2. */
const isFps = (id: number, p: Performance) => (WASD.includes(id)
  ? p.mode === 1 && Math.abs(p.rtFirstTouch - 0.3) < 1e-6
  : p.mode === 0 && Math.abs(p.normalPress - 1.2) < 1e-6);
/** The demo's profile 3 "Typing" (index 2): every key Standard 2.0, deadzones 0.2. */
const isTyping = (p: Performance) => p.mode === 0 && Math.abs(p.normalPress - 2) < 1e-6 && Math.abs(p.pressDeadStroke - 0.2) < 1e-6;
const at = (h: number, m: number) => new Date(2026, 10, 14, h, m).getTime();

async function setup() {
  const device = useDeviceStore();
  const perf = usePerformanceStore();
  await device.connectDemo();
  // what a page that shows travel values does (Overview, Travel, Profiles): read the new profile after a switch
  const off = device.onProfileChanged(() => void perf.load(true));
  const idle = () => vi.waitFor(() => {
    expect(perf.loading).toBe(false);
    expect(perf.loadedProfile).toBe(device.activeProfile);
  }, { timeout: 15000, interval: 5 });
  return { device, perf, off, idle };
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('profileSnapshots (DESIGN G §3.7)', () => {
  it('the profile left keeps its edits: load 0, edit a key, switch to 1 → snapshot 0 has the edited value', async () => {
    const { device, perf, idle } = await setup();
    await perf.load();
    expect(perf.profileSnapshots.size).toBe(0);
    const id = PHYSICAL_KEYS.find((k) => k.name === 'Q')!.id;
    expect(perf.values[id].rtFirstTouch).toBe(1);
    expect(perf.apply([id], () => ({ rtFirstTouch: 1.7, normalPress: 1.7 }), 'test')).toBe(1);
    await useSyncStore().flush(); // the edit is written and read back (the store's values are the verified ones)
    const left = perf.values;
    await device.switchProfile(1);
    await idle();
    expect(perf.profileSnapshots.get(0)!.values[id].rtFirstTouch).toBe(1.7);
    expect(perf.profileSnapshots.get(0)!.values).toBe(left); // the values as they were when left, not a re-read
    expect(perf.profileSnapshots.has(1)).toBe(false); // the active profile's values are live, not a snapshot
    expect(Object.entries(perf.values).every(([k, p]) => isFps(Number(k), p))).toBe(true);
  });

  it('another keyboard (or demo model) → every snapshot is gone', async () => {
    const { device, perf, idle } = await setup();
    await perf.load();
    await device.switchProfile(1);
    await idle();
    expect(perf.profileSnapshots.size).toBe(1);
    await device.switchDemoModel('pro');
    expect(perf.profileSnapshots.size).toBe(0);
    await perf.load();
    await device.switchProfile(2);
    await idle();
    expect([...perf.profileSnapshots.keys()]).toEqual([0]); // no leftover "left at" from the old connection either
  });

  it('a switch in the middle of a read drops that read: 0 read, switch to 1, at 10 keys switch to 2', async () => {
    const { device, perf, idle } = await setup();
    await perf.load();
    const p0 = perf.values;
    // G-TEST-2: a switch is never an error, not even for one render (every value loadError takes, synchronously)
    const errors: (string | null)[] = [];
    const stopErr = watch(() => perf.loadError, (e) => errors.push(e), { flush: 'sync' });
    const stop = watch(() => perf.loadedCount, (n) => {
      if (n === 10 && device.activeProfile === 1) void device.switchProfile(2);
    }, { flush: 'sync' });
    await device.switchProfile(1);
    await vi.waitFor(() => expect(device.activeProfile).toBe(2), { timeout: 15000, interval: 5 });
    await idle();
    stop();
    stopErr();
    expect(errors.filter((e) => e !== null)).toEqual([]);
    expect(perf.profileSnapshots.has(1)).toBe(false); // profile 2 (index 1) was never read in full: still "not opened"
    expect(perf.profileSnapshots.get(0)!.values).toBe(p0);
    expect(perf.loadedProfile).toBe(2);
    expect(Object.keys(perf.values)).toHaveLength(64);
    expect(Object.values(perf.values).every(isTyping)).toBe(true);
    expect(perf.loadError).toBeNull();
  });

  it('3b: 1 → 2 → 1 quickly in the middle of reading 1: the values are never a mix, and the next read is right on every key', async () => {
    const { device, perf, idle } = await setup();
    await perf.load();
    // every set of values the store publishes from here on is profile index 1's own (no profile index 2 numbers mixed in)
    const published: Record<number, Performance>[] = [];
    const stopValues = watch(() => perf.values, (v) => { if (Object.keys(v).length) published.push(v); }, { flush: 'sync' });
    let fired = false;
    const stop = watch(() => perf.loadedCount, (n) => {
      if (n !== 10 || fired || device.activeProfile !== 1) return;
      fired = true;
      void (async () => {
        await device.switchProfile(2);
        await device.switchProfile(1);
      })();
    }, { flush: 'sync' });
    await device.switchProfile(1);
    await vi.waitFor(() => expect(fired).toBe(true), { timeout: 15000, interval: 5 });
    await vi.waitFor(() => expect(device.activeProfile).toBe(1), { timeout: 15000, interval: 5 });
    await idle();
    stop();
    await perf.load(true);
    stopValues();
    expect(perf.loadedProfile).toBe(1);
    expect(Object.keys(perf.values)).toHaveLength(64);
    expect(Object.entries(perf.values).every(([k, p]) => isFps(Number(k), p))).toBe(true);
    expect(published.length).toBeGreaterThan(0);
    for (const v of published) expect(Object.entries(v).filter(([k, p]) => !isFps(Number(k), p))).toEqual([]);
  });

  it('the time on a snapshot is when the app left the profile, even when the next read comes later', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { device, perf, off, idle } = await setup();
    off(); // a page that does not read travel values (Keymap, Lighting…): nothing loads on the switch
    vi.setSystemTime(at(10, 0));
    await perf.load();
    vi.setSystemTime(at(10, 5));
    await device.switchProfile(1);
    vi.setSystemTime(at(10, 20));
    await perf.load();
    await idle();
    expect(perf.profileSnapshots.get(0)!.at).toBe(at(10, 5));
  });

  it('G-TEST-1: load(true) on the same profile later (calibration done, "Read again") stamps that profile with now', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { device, perf, off } = await setup();
    off();
    vi.setSystemTime(at(10, 0));
    await perf.load();
    vi.setSystemTime(at(10, 5));
    await device.switchProfile(1);
    vi.setSystemTime(at(10, 6));
    await perf.load();
    expect(perf.profileSnapshots.get(0)!.at).toBe(at(10, 5));
    vi.setSystemTime(at(10, 20));
    await perf.load(true);
    expect(perf.profileSnapshots.get(1)!.at).toBe(at(10, 20)); // not 10:05, the time profile 1 (index 0) was left
    expect(perf.profileSnapshots.get(0)!.at).toBe(at(10, 5));
  });

  it('3c: back on the profile in `values` before any read (0 → 1 → 0), then an edit: the time is the next read\'s, not the first leave', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { device, perf, off } = await setup();
    off();
    vi.setSystemTime(at(10, 0));
    await perf.load();
    vi.setSystemTime(at(10, 5));
    await device.switchProfile(1);
    vi.setSystemTime(at(10, 10));
    await device.switchProfile(0);
    vi.setSystemTime(at(10, 12));
    const id = PHYSICAL_KEYS.find((k) => k.name === 'E')!.id;
    expect(perf.apply([id], () => ({ rtFirstTouch: 0.6, normalPress: 0.6 }), 'test')).toBe(1); // still the live profile
    await useSyncStore().flush();
    vi.setSystemTime(at(10, 15));
    await perf.load(true);
    expect(perf.profileSnapshots.get(0)!.at).toBe(at(10, 15));
    expect(perf.profileSnapshots.get(0)!.values[id].rtFirstTouch).toBe(0.6);
  });
});
