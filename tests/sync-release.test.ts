import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

// The mock does what the firmware does: every performance write stores normalRelease = normalPress.
async function setup() {
  const device = useDeviceStore();
  await device.connectDemo();
  const mock = device.transport as MockTransport;
  vi.spyOn(mock, 'setPerformance'); // counts calls; the mock's own rule ties the release
  const perf = usePerformanceStore();
  await perf.load();
  // Stale release in values: the board and the app disagree until the key is edited.
  perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], mode: 0, normalPress: 1, normalRelease: 0.4 } };
  return { mock, perf };
}

describe('firmware ties normalRelease to normalPress', () => {
  beforeEach(() => setActivePinia(createPinia()));

  it('an actuation edit verifies on the first attempt, with release = press in the payload and in values', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const setPerf = vi.mocked(mock.setPerformance);
    setPerf.mockClear();
    perf.apply([W.id], () => ({ normalPress: 2, rtFirstTouch: 2 }), 'act');
    await sync.flush();
    expect(setPerf).toHaveBeenCalledTimes(1);
    expect(setPerf.mock.calls[0][1]).toMatchObject({ normalPress: 2, normalRelease: 2 });
    expect(sync.state).toBe('saved');
    expect(sync.lastError).toBeNull();
    expect(perf.values[W.id].normalRelease).toBe(2);
    expect((await mock.getPerformance(W)).normalRelease).toBe(2);
  });

  it('a deadzone-only edit on a key with a stale release verifies first time', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const setPerf = vi.mocked(mock.setPerformance);
    setPerf.mockClear();
    perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], normalPress: 1, normalRelease: 0.4 } };
    perf.apply([W.id], () => ({ pressDeadStroke: 0.3 }), 'dead');
    await sync.flush();
    expect(setPerf).toHaveBeenCalledTimes(1);
    expect(setPerf.mock.calls[0][1].normalRelease).toBe(setPerf.mock.calls[0][1].normalPress);
    expect(sync.state).toBe('saved');
  });

  it('write sends release = press even when values still hold an old release', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const setPerf = vi.mocked(mock.setPerformance);
    setPerf.mockClear();
    perf.apply([W.id], () => ({ normalPress: 2, rtFirstTouch: 2 }), 'act');
    perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], normalRelease: 0.7 } }; // stale again before the write
    await sync.flush();
    expect(setPerf.mock.calls[0][1]).toMatchObject({ normalPress: 2, normalRelease: 2 });
    expect(sync.state).toBe('saved');
  });

  it('undo of the actuation edit writes press 1 with release 1 and verifies', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    perf.apply([W.id], () => ({ normalPress: 2, rtFirstTouch: 2 }), 'act');
    await sync.flush();
    const setPerf = vi.mocked(mock.setPerformance);
    setPerf.mockClear();
    useHistoryStore().undo();
    await sync.flush();
    expect(setPerf).toHaveBeenCalledTimes(1);
    expect(setPerf.mock.calls[0][1]).toMatchObject({ normalPress: 1, normalRelease: 1 });
    expect(sync.state).toBe('saved');
    expect(perf.values[W.id]).toMatchObject({ normalPress: 1, normalRelease: 1 });
  });

  describe('a stale release ABOVE press', () => {
    async function aboveSetup() {
      const s = await setup();
      s.perf.values = { ...s.perf.values, [W.id]: { ...s.perf.values[W.id], normalPress: 1, normalRelease: 2 } };
      const setPerf = vi.mocked(s.mock.setPerformance);
      setPerf.mockClear();
      return { ...s, setPerf, sync: useSyncStore() };
    }

    it('an actuation edit 1.0 → 1.5 verifies first time with release = press', async () => {
      const { perf, setPerf, sync } = await aboveSetup();
      perf.apply([W.id], () => ({ normalPress: 1.5, rtFirstTouch: 1.5 }), 'act');
      await sync.flush();
      expect(setPerf).toHaveBeenCalledTimes(1);
      expect(setPerf.mock.calls[0][1].normalRelease).toBe(setPerf.mock.calls[0][1].normalPress);
      expect(sync.state).toBe('saved');
      expect(sync.lastError).toBeNull();
      expect(perf.values[W.id].normalRelease).toBe(perf.values[W.id].normalPress);
    });

    it('a preset verifies first time with release = press', async () => {
      const { perf, setPerf, sync } = await aboveSetup();
      perf.apply([W.id], () => ({ mode: 0, normalPress: 1.5, rtFirstTouch: 1.5, pressDeadStroke: 0.2 }), 'preset');
      await sync.flush();
      expect(setPerf).toHaveBeenCalledTimes(1);
      expect(setPerf.mock.calls[0][1].normalRelease).toBe(setPerf.mock.calls[0][1].normalPress);
      expect(sync.state).toBe('saved');
      expect(perf.values[W.id].normalRelease).toBe(perf.values[W.id].normalPress);
    });

    it('a deadzone-only edit verifies first time with release = press', async () => {
      const { perf, setPerf, sync } = await aboveSetup();
      perf.apply([W.id], () => ({ pressDeadStroke: 0.3 }), 'dead');
      await sync.flush();
      expect(setPerf).toHaveBeenCalledTimes(1);
      expect(setPerf.mock.calls[0][1].normalRelease).toBe(setPerf.mock.calls[0][1].normalPress);
      expect(sync.state).toBe('saved');
      expect(perf.values[W.id].normalRelease).toBe(perf.values[W.id].normalPress);
    });
  });

  it('a read-back with another field off still fails', async () => {
    const { mock, perf } = await setup();
    const sync = useSyncStore();
    const get = mock.getPerformance.bind(mock);
    vi.spyOn(mock, 'getPerformance').mockImplementation(async (k) => ({ ...(await get(k)), pressDeadStroke: 0.9 }));
    perf.apply([W.id], () => ({ normalPress: 2, rtFirstTouch: 2 }), 'act');
    await sync.flush().catch(() => undefined);
    expect(sync.state).not.toBe('saved');
  });
});

describe('mock firmware rule', () => {
  beforeEach(() => setActivePinia(createPinia()));
  it('stores normalRelease = normalPress whatever release was written, in both directions', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const mock = device.transport as MockTransport;
    const rec = await mock.getPerformance(W);
    await mock.setPerformance(W, { ...rec, normalPress: 2, normalRelease: 1 });
    expect((await mock.getPerformance(W)).normalRelease).toBe(2);
    await mock.setPerformance(W, { ...(await mock.getPerformance(W)), normalPress: 1, normalRelease: 2 });
    expect((await mock.getPerformance(W)).normalRelease).toBe(1);
  });
});
