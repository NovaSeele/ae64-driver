// Regressions from the logic review (R1–R6) and the fixes that followed: each test states the correct
// behaviour that the reviewer's repro showed broken.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { HidTransport, MockTransport, PHYSICAL_KEYS, SAVE_GROUP, UnsafeCommandError } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { useKeymapStore } from '../src/stores/keymap';
import { usePerformanceStore } from '../src/stores/performance';
import { useCalibrationStore } from '../src/stores/calibration';
import { useDiagnosticsStore } from '../src/stores/diagnostics';

const ESC = PHYSICAL_KEYS.find((k) => k.name === 'Esc')!;
const Q = PHYSICAL_KEYS.find((k) => k.name === 'Q')!;
const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

async function connectMock(): Promise<MockTransport> {
  const device = useDeviceStore();
  await device.connectDemo();
  return device.transport as MockTransport;
}

/** Read one key's performance record from another profile, then switch back (mock only). */
async function perfIn(mock: MockTransport, profile: number, back: number) {
  await mock.setActiveProfile(profile);
  const p = await mock.getPerformance(Q);
  await mock.setActiveProfile(back);
  return p;
}

beforeEach(() => setActivePinia(createPinia()));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('R1 sync: a job that can never be saved does not block the others', () => {
  it('undo back to a factory-reset keycode is not written, and later edits still save', async () => {
    const mock = await connectMock();
    (mock as unknown as { profiles: { keymap: number[][][] }[] }).profiles[0].keymap[1][ESC.row][ESC.col] = 0xf200;
    const keymap = useKeymapStore();
    const sync = useSyncStore();
    await keymap.load(true);
    expect(keymap.values[1][ESC.id]).toBe(0xf200);

    keymap.activeLayer = 1;
    keymap.applyKeycode([ESC.id], 0x0029);
    await sync.flush();

    const setKeycode = vi.spyOn(mock, 'setKeycode');
    useHistoryStore().undo();
    await sync.flush().catch(() => undefined);
    expect(setKeycode.mock.calls.some(([, code]) => code === 0xf200)).toBe(false);

    keymap.activeLayer = 0;
    keymap.applyKeycode([W.id], 0x0004);
    await sync.flush();
    expect(setKeycode.mock.calls.some(([pos, code]) => pos.row === W.row && pos.col === W.col && code === 0x0004)).toBe(true);
    expect(sync.state).toBe('saved');
  });

  it('a permanently refused job is dropped once, its edit reverted, and the queue keeps working', async () => {
    await connectMock();
    const sync = useSyncStore();
    const dropped: string[] = [];
    sync.enqueue({
      key: 'bad', label: 'bad', write: async () => { throw new UnsafeCommandError([0x02, 0xff], 'test'); },
      onDrop: (reason) => dropped.push(reason),
    });
    await expect(sync.flush()).rejects.toThrow();
    expect(dropped).toHaveLength(1);
    let wrote = false;
    sync.enqueue({ key: 'good', label: 'good', write: async () => { wrote = true; } });
    await sync.flush();
    expect(wrote).toBe(true);
    expect(sync.state).toBe('saved');
  });
});

describe('R2 sync: flush() while a batch is running reports that batch\'s failure', () => {
  it('a second flush rejects when the running batch failed', async () => {
    await connectMock();
    const sync = useSyncStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    sync.enqueue({
      key: 'perf:0:1', group: SAVE_GROUP.PERFORMANCE, label: 'x',
      write: async () => { await gate; throw new Error('write failed'); },
    });
    const first = sync.flush().then(() => 'ok', () => 'rejected');
    await Promise.resolve();
    const second = sync.flush().then(() => 'ok', () => 'rejected');
    release();
    expect(await Promise.all([first, second])).toEqual(['rejected', 'rejected']);
  });
});

describe('R3 keymap: layer-0 legends follow the edit', () => {
  it('the legend keeps the new code before and after the debounced write', async () => {
    await connectMock();
    const device = useDeviceStore();
    const keymap = useKeymapStore();
    await keymap.load(true);
    keymap.activeLayer = 0;
    keymap.applyKeycode([Q.id], 0x0004);
    await new Promise((r) => setTimeout(r, 50));
    expect(device.layer0[Q.id]).toBe(0x0004);
    await useSyncStore().flush();
    expect(device.layer0[Q.id]).toBe(0x0004);
  });
});

describe('R4 HID: a late reply is never taken for another key', () => {
  it('a stray 04 01 reply for Q is ignored while W is pending; W gets its own record', async () => {
    vi.useFakeTimers();
    const listeners: ((e: { data: DataView }) => void)[] = [];
    const sent: Uint8Array[] = [];
    const dev = {
      opened: true, productName: 'fake', vendorId: 0x1ca6, productId: 0x300d,
      collections: [{ usagePage: 0xffb0, usage: 1 }],
      addEventListener: (_: string, cb: (e: { data: DataView }) => void) => listeners.push(cb),
      removeEventListener: () => undefined,
      sendReport: async (_id: number, f: Uint8Array) => { sent.push(f); },
      close: async () => undefined,
    };
    (globalThis.navigator as unknown as { hid: unknown }).hid = { addEventListener() {}, removeEventListener() {} };
    const t = new HidTransport(dev as unknown as HIDDevice);
    await t.open();
    const reply = (bytes: number[]) => {
      const a = new Uint8Array(64);
      a.set(bytes);
      for (const cb of listeners) cb({ data: new DataView(a.buffer) });
    };
    const perfReply = (row: number, col: number, press: number, rangeMax: number, coef: number) => [
      0x04, 0x01, row, col, 0, press & 0xff, press >> 8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      1, 1, 5, 0, rangeMax & 0xff, rangeMax >> 8, coef & 0xff, coef >> 8,
    ];

    const p1 = t.getPerformance(Q).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await p1).toBe('TransportTimeoutError');

    const p2 = t.getPerformance(W);
    await vi.advanceTimersByTimeAsync(200); // quiet period after the timeout, then W is sent
    expect(sent.at(-1)!.slice(0, 4)).toEqual(new Uint8Array([0x04, 0x01, W.row, W.col]));
    reply(perfReply(Q.row, Q.col, 1500, 3310, 777)); // Q's late reply: ignored
    reply(perfReply(W.row, W.col, 1200, 3310, 555)); // W's own reply
    const w = await p2;
    expect(w.axisCoefficient).toBe(555);
  });
});

describe('R5 profile switch never carries an unsaved edit into another profile', () => {
  it('a transient failure is retried before the switch: the edit lands in the old profile', async () => {
    const mock = await connectMock();
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    const sync = useSyncStore();
    await perf.load(true);
    const p1Before = await perfIn(mock, 1, 0);

    const orig = mock.setPerformance.bind(mock);
    let fail = true;
    vi.spyOn(mock, 'setPerformance').mockImplementation(async (pos, p) => {
      await new Promise((r) => setTimeout(r, 30));
      if (fail) { fail = false; throw new Error('USB hiccup'); }
      return orig(pos, p);
    });

    perf.apply([Q.id], () => ({ normalPress: 0.4 }), 'test');
    const flushing = sync.flush().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 5));
    await device.switchProfile(1);
    await flushing;
    await sync.retry();
    expect(device.activeProfile).toBe(1);
    expect((await mock.getPerformance(Q)).normalPress).toBeCloseTo(p1Before.normalPress);
    expect((await perfIn(mock, 0, 1)).normalPress).toBeCloseTo(0.4);
  });

  it('a persistent failure refuses the switch, and the edit is never written to another profile', async () => {
    const mock = await connectMock();
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    const sync = useSyncStore();
    await perf.load(true);
    const p1Before = await perfIn(mock, 1, 0);
    const write = vi.spyOn(mock, 'setPerformance').mockRejectedValue(new Error('USB hiccup'));

    perf.apply([Q.id], () => ({ normalPress: 0.4 }), 'test');
    await expect(device.switchProfile(1)).rejects.toThrow();
    expect(device.activeProfile).toBe(0);

    // Even if the profile changes behind the queue's back, a job tagged with profile 0 is dropped, not written.
    write.mockRestore();
    await mock.setActiveProfile(1);
    device.activeProfile = 1;
    await sync.retry();
    expect((await mock.getPerformance(Q)).normalPress).toBeCloseTo(p1Before.normalPress);
  });
});

describe('R6 the exclusive count survives a disconnect during an exclusive job', () => {
  it('after a reconnect the next exclusive job pauses the pollers again', async () => {
    const device = useDeviceStore();
    const mock = await connectMock();
    let release!: () => void;
    const job = device.withTransport(async () => {
      await new Promise<void>((r) => { release = r; });
      throw new Error('disconnected');
    }, { exclusive: true }).catch(() => undefined);
    expect(device.exclusiveActive).toBe(true);
    (mock as unknown as { emitDisconnect(): void }).emitDisconnect();
    release();
    await job;
    await device.connectDemo();
    let seen: boolean | null = null;
    await device.withTransport(async () => { seen = device.exclusiveActive; }, { exclusive: true });
    expect(seen).toBe(true);
    expect(device.exclusiveActive).toBe(false);
  });
});

describe('calibration lock', () => {
  it('while calibrating only "stop calibration" is written; undo and profile switch are refused', async () => {
    const mock = await connectMock();
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    await perf.load(true);
    perf.apply([W.id], () => ({ normalPress: 1.0 }), 'test');
    await useSyncStore().flush();

    const cal = useCalibrationStore();
    await cal.start();
    expect(cal.phase).toBe('running');
    expect(mock.calibrationLocked).toBe(true);

    const setPerformance = vi.spyOn(mock, 'setPerformance');
    useHistoryStore().undo();
    expect(perf.values[W.id].normalPress).toBeCloseTo(1.0); // undo ignored
    await expect(device.switchProfile(1)).rejects.toThrow();
    expect(device.activeProfile).toBe(0);
    await expect(mock.setPerformance(W, (await mock.getPerformance(W)))).rejects.toBeInstanceOf(UnsafeCommandError);
    setPerformance.mockClear();

    await cal.cancel();
    expect(mock.calibrationLocked).toBe(false);
    await perf.load(); // the calibrate flag is re-read after a session
    useHistoryStore().undo();
    await useSyncStore().flush();
    expect(setPerformance).toHaveBeenCalled();
  });
});

describe('device housekeeping', () => {
  it('records packets only while someone watches the log', async () => {
    const mock = await connectMock();
    const device = useDeviceStore();
    const before = device.packetLog.length;
    await mock.getActiveProfile();
    expect(device.packetLog.length).toBe(before);
    const stop = device.watchPackets();
    await mock.getActiveProfile();
    expect(device.packetLog.length).toBe(before + 2);
    stop();
    await mock.getActiveProfile();
    expect(device.packetLog.length).toBe(before + 2);
  });

  it('keys reporting an unknown performance mode are left alone', async () => {
    await connectMock();
    const perf = usePerformanceStore();
    await perf.load(true);
    perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], mode: 5 as never } };
    // Recorded only: a real job would fire after this test, on the next test's connection.
    const enqueue = vi.spyOn(useSyncStore(), 'enqueue').mockImplementation(() => undefined);
    perf.apply([W.id, Q.id], () => ({ normalPress: 1.7 }), 'test');
    expect(enqueue.mock.calls.map(([job]) => job.key)).toEqual([`perf:0:${Q.id}`]);
    expect(perf.values[W.id].normalPress).not.toBeCloseTo(1.7);
  });
});

describe('backup restore never stops half-way on a value the keyboard would refuse', () => {
  it('rejects a distance beyond the key travel, and mode 2 on firmware without it, before writing anything', async () => {
    const mock = await connectMock();
    const device = useDeviceStore();
    const diag = useDiagnosticsStore();
    const setKeycode = vi.spyOn(mock, 'setKeycode');
    const setPerformance = vi.spyOn(mock, 'setPerformance');

    const tooDeep = await diag.generateBackup();
    tooDeep.keymap[0][Q.id] = 0x0004; // a keymap change that would be written first
    tooDeep.performance[W.id] = { ...tooDeep.performance[W.id], normalPress: 3.8 }; // W travels 3.31 mm
    await expect(diag.applyRestore(await diag.parseAndDiffBackup(JSON.stringify(tooDeep)))).rejects.toThrow(/key travel/);

    device.version = { main: 1, sub: 2, hardware: 0, software: 0 };
    const mode2 = await diag.generateBackup();
    mode2.keymap[0][Q.id] = 0x0004;
    mode2.performance[W.id] = { ...mode2.performance[W.id], mode: 2 };
    await expect(diag.applyRestore(await diag.parseAndDiffBackup(JSON.stringify(mode2)))).rejects.toThrow(/1\.3\.0\.0/);

    expect(setKeycode).not.toHaveBeenCalled();
    expect(setPerformance).not.toHaveBeenCalled();
  }, 15000);
});

describe('per-keyboard caches', () => {
  it('a new connection drops cached performance, keymap, advanced and lighting data', async () => {
    await connectMock();
    const perf = usePerformanceStore();
    const keymap = useKeymapStore();
    await perf.load(true);
    await keymap.load(true);
    expect(perf.loadedProfile).toBe(0);
    await useDeviceStore().connectDemo(); // e.g. demo → the real keyboard
    expect(perf.loadedProfile).toBe(null);
    expect(Object.keys(perf.values)).toHaveLength(0);
    expect(keymap.loadedProfile).toBe(null);
    // Edits are refused until the new keyboard was read.
    const enqueue = vi.spyOn(useSyncStore(), 'enqueue').mockImplementation(() => undefined);
    perf.apply([W.id], () => ({ normalPress: 1.1 }), 'test');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
