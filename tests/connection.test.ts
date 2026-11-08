import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import type { SyncJob } from '../src/stores/sync';
import { usePerformanceStore } from '../src/stores/performance';
import { useKeymapStore } from '../src/stores/keymap';
import { useLightingStore } from '../src/stores/lighting';

async function setup() {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo();
  return { device, mock: device.transport as MockTransport, sync: useSyncStore() };
}

/** A promise settled from outside, to hold a read of the old keyboard until after the new connection. */
function gate() {
  let release!: () => void;
  let fail!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => { release = res; fail = rej; });
  return { promise, release, fail };
}

describe('load started before a new connection', () => {
  afterEach(() => vi.restoreAllMocks());

  for (const outcome of ['resolves', 'rejects'] as const) {
    it(`performance: a load that ${outcome} after the switch leaves the new connection alone`, async () => {
      const { device, mock } = await setup();
      const perf = usePerformanceStore();
      const g = gate();
      const real = mock.getPerformance.bind(mock);
      vi.spyOn(mock, 'getPerformance').mockImplementation(async (key) => { await g.promise; return real(key); });

      const stale = perf.load();
      await device.connectDemo();
      if (outcome === 'resolves') g.release(); else g.fail(new Error('old transport gone'));
      await stale;

      expect(perf.loadedProfile).toBeNull();
      expect(Object.keys(perf.values)).toHaveLength(0);
      expect(perf.loadError).toBeNull();
      expect(perf.loading).toBe(false);

      await perf.load(); // starts fresh instead of returning the stale promise
      expect(perf.loadedProfile).toBe(device.activeProfile);
      expect(Object.keys(perf.values)).toHaveLength(device.keys.length);
    });

    it(`keymap: a load that ${outcome} after the switch leaves the new connection alone`, async () => {
      const { device, mock } = await setup();
      const keymap = useKeymapStore();
      const g = gate();
      const real = mock.getKeymapRow.bind(mock);
      vi.spyOn(mock, 'getKeymapRow').mockImplementation(async (layer, row) => { await g.promise; return real(layer, row); });

      const stale = keymap.load();
      await device.connectDemo();
      if (outcome === 'resolves') g.release(); else g.fail(new Error('old transport gone'));
      await stale;

      expect(keymap.loadedProfile).toBeNull();
      expect(Object.keys(keymap.values[0])).toHaveLength(0);
      expect(keymap.loadError).toBeNull();
      expect(keymap.loading).toBe(false);

      await keymap.load();
      expect(keymap.loadedProfile).toBe(device.activeProfile);
      expect(Object.keys(keymap.values[0])).toHaveLength(device.keys.length);
    });
  }
});

describe('sync jobs', () => {
  afterEach(() => vi.restoreAllMocks());

  function captureJobs(sync: ReturnType<typeof useSyncStore>): SyncJob[] {
    const jobs: SyncJob[] = [];
    const enqueue = sync.enqueue;
    vi.spyOn(sync, 'enqueue').mockImplementation((job) => { jobs.push(job); enqueue(job); });
    return jobs;
  }

  it('a performance job names its key', async () => {
    const { sync } = await setup();
    const perf = usePerformanceStore();
    await perf.load();
    const jobs = captureJobs(sync);
    perf.apply([5], () => ({ mode: 0, normalPress: 1.7 }), 'test');
    expect(jobs.map((j) => j.keys)).toEqual([[5]]);
  });

  it('a keymap job names its key', async () => {
    const { sync } = await setup();
    const keymap = useKeymapStore();
    await keymap.load();
    const jobs = captureJobs(sync);
    keymap.applyKeycode([7], 0x0005);
    expect(jobs.map((j) => j.keys)).toEqual([[7]]);
  });

  it('a dropped lighting job marks the store stale without reloading', async () => {
    const { device, mock, sync } = await setup();
    const lighting = useLightingStore();
    await lighting.load();
    expect(lighting.loadedProfile).toBe(device.activeProfile);
    const reads = vi.spyOn(mock, 'getLightingBase');

    lighting.applyBase(0, { brightness: 33 }, 'test');
    expect(sync.pendingCount()).toBe(1);
    const seq = lighting.staleSeq;
    sync.reset(); // drops the queued job

    expect(lighting.loadedProfile).toBeNull();
    expect(lighting.staleSeq).toBe(seq + 1); // an open Lighting page reloads on this
    expect(reads).not.toHaveBeenCalled();
  });
});
