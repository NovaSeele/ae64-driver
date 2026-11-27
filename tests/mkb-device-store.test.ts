// MKB-V step 2a-1: device store connect path for non-AE64 keyboards in read-only view mode (DESIGN §3–§5, §7–§8, §12, §15, §16.2).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  BaseTransport, FIRMWARE_ROWS, GenericMockTransport, MockTransport, PRODUCT_ID_PRO, REQUEST_TIMEOUT_MS,
  TransportTimeoutError, VENDOR_ID, VENDOR_ID_AULA, VENDOR_ID_WUQUE, createGenericMock,
} from '../src/protocol';
import type { Bytes } from '../src/protocol';
import { MockBootloader, MockFwBus } from '../src/protocol/mockFirmware';
import { writeCalibrationFlag, readCalibrationFlag } from '../src/data/calibrationFlag';
import { PROFILE_POLL_MS, useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { useToast } from '../src/components/ui/toast';
import { t as tr } from '../src/i18n/vi';
import { setLocale } from '../src/i18n/locale';
import { FakeHidDevice, installFakeHid, removeFakeHid } from './fw-hid';
import { isProfilePoll } from './helpers/profilePoll';
import App from '../src/App.vue';

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;

const hex = (b: number): string => b.toString(16).padStart(2, '0');

/** Compact command tag matching DESIGN §5.1 / §5.2 frame notation. */
function frameTag(f: Uint8Array): string {
  const len = f[0] === 0x01 ? 2
    : f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x03 ? 4
      : f[0] === 0x03 && f[1] === 0x01 ? 4
        : 3;
  return Array.from(f.slice(0, len), hex).join(' ');
}

/** Captures every outgoing frame sent through BaseTransport.prototype.log. */
function captureOut() {
  const frames: Uint8Array[] = [];
  const proto = BaseTransport.prototype as unknown as { log: (d: 'out' | 'in', b: Uint8Array, note?: string) => void };
  const orig = proto.log;
  const spy = vi.spyOn(proto, 'log').mockImplementation(function (this: BaseTransport, dir, bytes, note) {
    if (dir === 'out') frames.push(Uint8Array.from(bytes));
    return orig.call(this, dir, bytes, note);
  });
  return { frames, tags: () => frames.map(frameTag), spy };
}

/** Advances fake timers in small steps until `promise` settles. */
async function settle<T>(promise: Promise<T>, stepMs = 10, maxSteps = 5000): Promise<T> {
  let done = false;
  let val!: T;
  let err: unknown;
  let failed = false;
  promise.then(
    (v) => { done = true; val = v; },
    (e) => { done = true; failed = true; err = e; },
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('settle: timed out');
  if (failed) throw err;
  return val;
}

const toasts = () => useToast().items.value.map((x) => x.text);

beforeEach(() => {
  localStorage.clear();
  useToast().items.value = [];
  setLocale('vi');
  setActivePinia(createPinia());
});

afterEach(async () => {
  try {
    const device = useDeviceStore();
    if (device.transport) await device.disconnect({ flush: false });
  } catch {
    // store not active
  }
  removeFakeHid();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
  setLocale('vi');
});

// ------------------------------------------------------------------ S1: gboot (both VIDs) & run-mode-255 table (§5.3)

describe('S1 non-AE64 bootloader refusal (M1)', () => {
  it.each([
    ['1CA6:F008', VENDOR_ID],
    ['38A6:F008', VENDOR_ID_AULA],
  ])('gboot (%s): sends 01 02 only, refuses with error.bootOther, never calls openRescue', async (_label, vendorId) => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    const fw = useFirmwareStore();
    const openRescue = vi.spyOn(fw, 'openRescue');

    await settle(device.connectGenericMock('gboot', { vendorId, latencyMs: 0 }));

    expect(out.tags()).toEqual(['01 02']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.bootOther', { name: 'Mock Boot' }));
    expect(device.refusal).toEqual({
      reason: 'bootOther',
      identity: expect.objectContaining({ vendorId, productId: 0xf008, productName: 'Mock Boot' }),
    });
    expect(fw.rescue).toBe(false);
    expect(openRescue).not.toHaveBeenCalled();
  });

  it('38A6 bootloader spoofing an AE64 board is still refused with error.bootOther (no rescue)', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const fakeBoot = new MockBootloader(bus, bus.serial, 'boot-other');
    const dev = new FakeHidDevice(hid, fakeBoot, { vendorId: VENDOR_ID_AULA, productId: 0xf008, productName: 'AULA Boot' });
    hid.strays.push(dev);
    hid.next = () => [dev];

    const device = useDeviceStore();
    const fw = useFirmwareStore();
    const openRescue = vi.spyOn(fw, 'openRescue');
    await settle(device.connect());

    expect(dev.sends.map(frameTag)).toEqual(['01 02']);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.bootOther', { name: 'AULA Boot' }));
    expect(dev.opened).toBe(false);
    expect(fw.rescue).toBe(false);
    expect(openRescue).not.toHaveBeenCalled();
  });

  it.each([
    ['board 0', 0x00000000],
    ['board FFFFFFFF', 0xffffffff],
  ])('unchanged §5.3: 1CA6 non-AE64 PID in run mode 255 with %s still opens rescue', async (_label, board) => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const boot = new MockBootloader(bus, bus.serial, 'boot-other');
    const origEx = (boot as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(boot);
    (boot as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = async (f, ms) => {
      const r = await origEx(f, ms);
      if (f[0] === 0x01 && f[1] === 0x02) {
        const copy = Uint8Array.from(r);
        copy[4] = (board >>> 24) & 0xff;
        copy[5] = (board >>> 16) & 0xff;
        copy[6] = (board >>> 8) & 0xff;
        copy[7] = board & 0xff;
        return copy;
      }
      return r;
    };
    const dev = new FakeHidDevice(hid, boot, { vendorId: VENDOR_ID, productId: 0x0000, productName: 'Bootloader' });
    hid.strays.push(dev);
    hid.next = () => [dev];

    const device = useDeviceStore();
    const fw = useFirmwareStore();
    const openRescue = vi.spyOn(fw, 'openRescue');
    await settle(device.connect());

    expect(dev.sends.map(frameTag)).toEqual(['01 02']);
    expect(openRescue).toHaveBeenCalledOnce();
    expect(fw.rescue).toBe(true);
    expect(device.status).toBe('idle');
    fw.clear();
  });

  it('non-AE64 device in an unknown run mode (not 0 or 255) refuses with fw.rescue.unknownMode', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const inner = createGenericMock('g60', { latencyMs: 0 });
    const origEx = (inner as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(inner);
    (inner as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = async (f, ms) => {
      const r = await origEx(f, ms);
      if (f[0] === 0x01 && f[1] === 0x02) { const copy = Uint8Array.from(r); copy[16] = 7; return copy; }
      return r;
    };
    const dev = new FakeHidDevice(hid, inner, { vendorId: VENDOR_ID_AULA, productId: 0xf001, productName: 'Odd Mode' });
    hid.strays.push(dev);
    hid.next = () => [dev];

    const device = useDeviceStore();
    const openRescue = vi.spyOn(useFirmwareStore(), 'openRescue');
    await settle(device.connect());

    expect(dev.sends.map(frameTag)).toEqual(['01 02']);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('fw.rescue.unknownMode', { mode: 7 }));
    expect(device.refusal?.reason).toBe('mode');
    expect(openRescue).not.toHaveBeenCalled();
    expect(dev.opened).toBe(false);
  });
});

// ------------------------------------------------------------------ S6: gates G0, G1, G3, G4 and 3 timeouts in a row

describe('S6 clean refusal gates G0–G4 and 3-timeout close (M10)', () => {
  it('G0 gff80: refuses before any command with error.receiver and sends zero frames', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gff80', { latencyMs: 0 }));

    expect(out.frames).toEqual([]);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.receiver'));
    expect(device.refusal).toEqual({
      reason: 'receiver',
      identity: expect.objectContaining({ vendorId: VENDOR_ID, productId: 0xf00a }),
    });
  });

  it('G1 gv3: 01 02 non-matching 55 AA reply times out -> error.protocolUnknown, closed, 01 02 only', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gv3', { latencyMs: 0 }));

    expect(out.tags()).toEqual(['01 02']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: 'Mock V3' }));
    expect(device.refusal).toEqual({
      reason: 'protocol',
      identity: expect.objectContaining({ vendorId: VENDOR_ID, productId: 0xf006, productName: 'Mock V3' }),
    });
  });

  it.each([
    ['board 0', 0x00000000],
    ['board FFFFFFFF', 0xffffffff],
  ])('G3 %s in run mode 0: stops before 01 01 with error.protocolUnknown', async (_label, board) => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const inner = createGenericMock('g60', { latencyMs: 0 });
    const origEx = (inner as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(inner);
    (inner as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = async (f, ms) => {
      const r = await origEx(f, ms);
      if (f[0] === 0x01 && f[1] === 0x02) {
        const copy = Uint8Array.from(r);
        copy[4] = (board >>> 24) & 0xff;
        copy[5] = (board >>> 16) & 0xff;
        copy[6] = (board >>> 8) & 0xff;
        copy[7] = board & 0xff;
        return copy;
      }
      return r;
    };
    const dev = new FakeHidDevice(hid, inner, { vendorId: VENDOR_ID_WUQUE, productId: 0xf099, productName: 'Zero Board' });
    hid.strays.push(dev);
    hid.next = () => [dev];

    const device = useDeviceStore();
    await settle(device.connect());

    expect(dev.sends.map(frameTag)).toEqual(['01 02']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: 'Zero Board' }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(dev.opened).toBe(false);
  });

  it('G4 gproto2 (M10 store-level): 01 02 and 01 01 only, error.protocolVersion with "2.0", closed, refusal keeps version', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gproto2', { latencyMs: 0 }));

    expect(out.tags()).toEqual(['01 02', '01 01']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolVersion', { name: 'Mock Proto 2', version: '2.0' }));
    expect(device.error).toContain('2.0');
    expect(device.refusal).toEqual({
      reason: 'version',
      identity: expect.objectContaining({ vendorId: VENDOR_ID, productId: 0xf007, productName: 'Mock Proto 2' }),
      version: { main: 2, sub: 0, hardware: 0, software: 0 },
    });
  });

  it('gsilent: answers gates G1/G4, then closes after 3 consecutive read timeouts with error.protocolUnknown', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gsilent', { latencyMs: 0 }));

    // G1 (01 02), G4 (01 01), then 3 timed-out reads (01 03, 02 03 00, 02 0C 00); stops before 03 05.
    expect(out.tags()).toEqual(['01 02', '01 01', '01 03', '02 03 00', '02 0c 00']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: 'Mock Silent' }));
    expect(device.refusal?.reason).toBe('protocol');
  });

  it('after init on generic: 2 timeouts + 1 success resets counter; 3 timeouts in a row via withTransport closes with error.protocolUnknown', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    // Use gmiss (no periodic profile poll) so only our explicit withTransport reads run on the wire.
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.connected).toBe(true);
    const t = device.transport as GenericMockTransport;

    // Make 02 04 01 (getSystemMode) time out while 02 05 01 (getPollingRate) succeeds.
    const origEx = (t as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(t);
    (t as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = (f, ms) => {
      if (f[0] === 0x02 && f[1] === 0x04 && f[2] === 0x01) {
        return new Promise((_, reject) => setTimeout(() => reject(new TransportTimeoutError([0x02, 0x04])), ms));
      }
      return origEx(f, ms);
    };

    // 2 timeouts -> stays connected.
    await expect(settle(device.withTransport((trp) => trp.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    await expect(settle(device.withTransport((trp) => trp.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    expect(device.connected).toBe(true);

    // 1 successful read resets the consecutive timeout count.
    await settle(device.withTransport((trp) => trp.getPollingRate()));
    expect(device.connected).toBe(true);

    // Now 2 more timeouts still stay connected.
    await expect(settle(device.withTransport((trp) => trp.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    await expect(settle(device.withTransport((trp) => trp.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    expect(device.connected).toBe(true);

    // 3rd consecutive timeout closes the connection cleanly with error.protocolUnknown.
    await expect(settle(device.withTransport((trp) => trp.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: 'Bàn phím 1CA6:F004' }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(t.connected).toBe(false);
  });

  it('AE64 connection is NOT closed by 3 timeouts in a row (generic-only rule)', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectDemo('max'));
    const t = device.transport as MockTransport;
    const origEx = (t as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(t);
    (t as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = (f, ms) => {
      if (f[0] === 0x02 && f[1] === 0x04 && f[2] === 0x01) {
        return new Promise((_, reject) => setTimeout(() => reject(new TransportTimeoutError([0x02, 0x04])), ms));
      }
      return origEx(f, ms);
    };

    for (let i = 0; i < 3; i++) {
      await expect(settle(device.withTransport((trp) => trp.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    }
    expect(device.connected).toBe(true);
    expect(t.connected).toBe(true);
  });

  it('grouped profile-poll answers reset the 3-timeout counter (alternating over 6 polls stays open; 3 in a row closes)', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));
    expect(device.connected).toBe(true);
    const t = device.transport as GenericMockTransport;

    const origEx = (t as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(t);
    let pollIdx = 0;
    let forceAllTimeouts = false;
    (t as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = (f, ms) => {
      if (isProfilePoll(f)) {
        pollIdx++;
        if (forceAllTimeouts || pollIdx % 2 === 1) {
          return new Promise((_, reject) => setTimeout(() => reject(new TransportTimeoutError([0x02, 0x03])), ms));
        }
      }
      return origEx(f, ms);
    };

    // 6 polls alternating timeout / answered (3 total timeouts, never consecutive): must stay connected.
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(Math.max(PROFILE_POLL_MS, REQUEST_TIMEOUT_MS + 100));
    }
    expect(pollIdx).toBeGreaterThanOrEqual(6);
    expect(device.connected).toBe(true);
    expect(t.connected).toBe(true);

    // Start the forced run right after an answered poll (any poll interval), so the count starts from 0.
    while (pollIdx % 2 === 1) await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    // Now exactly 3 consecutive poll timeouts must close the connection with error.protocolUnknown.
    forceAllTimeouts = true;
    const pollsBefore = pollIdx;
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(Math.max(PROFILE_POLL_MS, REQUEST_TIMEOUT_MS + 100));
    }
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 100);
    expect(pollIdx - pollsBefore).toBe(3);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: 'Mock 60' }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(t.connected).toBe(false);
  });

  it('tryAutoReconnect returns true for an AE64 identity even when init ends without connected or rescue (S8)', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const oddMode = new MockTransport({ seed: 'pro', latencyMs: 0 });
    const origHandle = oddMode.handle.bind(oddMode);
    oddMode.handle = (req: number[]) => {
      const r = origHandle(req);
      if (req[0] === 0x01 && req[1] === 0x02) r[16] = 7; // unknown runMode -> handOver sets error, does not throw
      return r;
    };
    const dev = new FakeHidDevice(hid, oddMode, { vendorId: VENDOR_ID, productId: PRODUCT_ID_PRO, productName: 'AE64 Pro' });
    hid.strays.push(dev);

    const device = useDeviceStore();
    const fw = useFirmwareStore();
    const ok = await settle(device.tryAutoReconnect());

    expect(ok).toBe(true);
    expect(device.connected).toBe(false);
    expect(fw.rescue).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('fw.rescue.unknownMode', { mode: 7 }));
    expect(dev.sends.map(frameTag)).toEqual(['01 02']);
    expect(dev.opened).toBe(false);
  });
});

// ------------------------------------------------------------------ Init R13, Profiles R10 (M21), Poll R13 (M24), S4 (M7)

describe('generic init frames (R13), profiles clamp (M21), poll guard (M24), precision (M7)', () => {
  it('g60: exact §5.1 + §5.2 init frame sequence', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(device.boardAllowed).toBe(false);
    expect(out.tags()).toEqual([
      '01 02', '01 01', '01 03',
      '02 03 00', '02 03 01', '02 03 03 00', '02 03 03 01', '02 03 03 02', '02 03 03 03',
      '02 0c 00',
      '03 05 00', '03 05 01', '03 05 02', '03 05 03', '03 05 04', '03 05 05',
      '03 01 00 01', '03 01 00 02', '03 01 00 03', '03 01 00 04', '03 01 00 05',
    ]);
    expect(device.keys).toHaveLength(61);
    expect(device.rows).toEqual([1, 2, 3, 4, 5]);
    expect(device.unknown.profiles).toBe(false);
    expect(device.unknown.rtPrecision).toBe(false);
  });

  it('g75: exact §5.1 + §5.2 init frame sequence including row 0 layer-0 read, precision 0.001, 81 keys', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g75', { latencyMs: 0 }));

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(device.boardAllowed).toBe(false);
    expect(out.tags()).toEqual([
      '01 02', '01 01', '01 03',
      '02 03 00', '02 03 01', '02 03 03 00', '02 03 03 01', '02 03 03 02', '02 03 03 03',
      '02 0c 00',
      '03 05 00', '03 05 01', '03 05 02', '03 05 03', '03 05 04', '03 05 05',
      '03 01 00 00', '03 01 00 01', '03 01 00 02', '03 01 00 03', '03 01 00 04', '03 01 00 05',
    ]);
    expect(device.rows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(device.keys).toHaveLength(81);
    expect(device.rtPrecision).toBe(0.001);
    expect(device.unknown.rtPrecision).toBe(false);
    // Row-0 layer-0 names decoded properly (Esc, F1..F12, Del).
    const row0Keys = device.keys.filter((k) => k.row === 0);
    expect(row0Keys.length).toBeGreaterThan(0);
    expect(device.legend(row0Keys[0])).toBe('Esc');
    expect(device.legend(row0Keys[1])).toBe('F1');
  });

  it('godd (R10, M21): profile count 6 connects, profiles unknown, no 02 03 01 or 02 03 03 sent, exact init log, overlap/padding noted', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('godd', { latencyMs: 0 }));

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(out.tags()).toEqual([
      '01 02', '01 01', '01 03',
      '02 03 00',
      '02 0c 00',
      '03 05 00', '03 05 01', '03 05 02', '03 05 03', '03 05 04', '03 05 05',
      '03 01 00 01', '03 01 00 02', '03 01 00 03',
    ]);
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x03 && (f[2] === 0x01 || f[2] === 0x03))).toBe(false);
    expect(device.unknown.profiles).toBe(true);
    expect(device.profileCount).toBe(0);
    expect(device.profileNames).toEqual([]);
    expect(device.unknown.layoutOverlap).toBe(true);
    expect(device.unknown.layoutPadding).toEqual([1]);
    expect(device.rows).toEqual([1, 2, 3]);
    // No profile poll should fire either when profiles are unknown.
    out.frames.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.frames).toEqual([]);
    expect(device.connected).toBe(true);
  });

  it('g60 with profileCount 0 (R10, M21): connects, profiles unknown, no 02 03 01 or 02 03 03 sent, no profile poll over 10 s', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    vi.spyOn(GenericMockTransport.prototype, 'getProfileCount').mockResolvedValue(0);
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x03 && (f[2] === 0x01 || f[2] === 0x03))).toBe(false);
    expect(device.unknown.profiles).toBe(true);
    expect(device.profileCount).toBe(0);
    expect(device.profileNames).toEqual([]);
    out.frames.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.frames.filter(isProfilePoll)).toEqual([]);
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x01)).toBe(false);
    expect(device.connected).toBe(true);
  });

  it('gmiss (R13/M24, S4/M7): precision unknown (no 0.001 fallback), row 3 missing, no profile poll starts and stays connected over 10 s', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    // S4 / M7: precision unknown, NOT the AE64 0.001 fallback.
    expect(device.rtPrecision).toBe(0);
    expect(device.rtPrecision).not.toBe(0.001);
    expect(device.unknown.rtPrecision).toBe(true);
    // Profiles active did not answer; row 3 layout did not answer.
    expect(device.unknown.profiles).toBe(true);
    expect(device.unknown.missingLayoutRows).toEqual([3]);
    expect(device.rows).toEqual([1, 2, 4, 5]);
    expect(device.displayName).toBe('Bàn phím 1CA6:F004');

    // Poll R13 / M24: clear init frames, advance 10 s of fake time -> zero 02 03 01 polls, stays connected.
    out.frames.length = 0;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.frames.filter(isProfilePoll)).toEqual([]);
    expect(out.frames).toEqual([]);
    expect(device.connected).toBe(true);
    expect(device.status).toBe('connected');
  });

  it('S7 gtwin: takes the exact same path and init frames as g60', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out60 = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));
    const frames60 = out60.tags();
    await device.disconnect({ flush: false });
    out60.spy.mockRestore();

    const outTwin = captureOut();
    await settle(device.connectGenericMock('gtwin', { latencyMs: 0 }));
    const framesTwin = outTwin.tags();

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(device.boardAllowed).toBe(false);
    expect(device.version).toMatchObject({ main: 1, sub: 2 });
    expect(framesTwin).toEqual(frames60);
  });
});

// ------------------------------------------------------------------ Rows, Names, S9 tables (M18), Legend, 0-key fallback

describe('rows, names, model gating (M18), legend, and zero-key layout', () => {
  it('names and model gating: gmiss, g60, gspoof, gspoofPro, and AE64 unchanged', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();

    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.displayName).toBe('Bàn phím 1CA6:F004');
    setLocale('en');
    expect(device.displayName).toBe('Keyboard 1CA6:F004');
    setLocale('vi');
    expect(device.model).toBeNull();
    expect(device.modelName).toBeNull();

    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));
    expect(device.displayName).toBe('Mock 60');
    expect(device.model).toBeNull();
    expect(device.modelName).toBeNull();

    // gspoof reports AE64 Max board 0030000D -> model/modelName MUST stay null, displayName MUST NOT contain "AE64" (M18).
    await settle(device.connectGenericMock('gspoof', { latencyMs: 0 }));
    expect(device.info?.boardIdHex).toBe('0030000d');
    expect(device.boardAllowed).toBe(false);
    expect(device.model).toBeNull();
    expect(device.modelName).toBeNull();
    expect(device.displayName).toBe('Mock Spoof');
    expect(device.displayName).not.toMatch(/AE64/i);

    // gspoofPro reports AE64 Pro board 0030000A -> same.
    await settle(device.connectGenericMock('gspoofPro', { latencyMs: 0 }));
    expect(device.info?.boardIdHex).toBe('0030000a');
    expect(device.boardAllowed).toBe(false);
    expect(device.model).toBeNull();
    expect(device.modelName).toBeNull();
    expect(device.displayName).toBe('Mock Spoof Pro');
    expect(device.displayName).not.toMatch(/AE64/i);

    // AE64 rows, model, modelName, displayName unchanged.
    await settle(device.connectDemo('max'));
    expect(device.support).toBe('ae64');
    expect(device.rows).toEqual([...FIRMWARE_ROWS]);
    expect(device.model).toBe('max');
    expect(device.modelName).toBe('AE64 Max');
    expect(device.displayName).toBe('AE64 Max');
  });

  it('generic legend shows R{row}·C{col} for 0 or unknown keycodes, and zero-key generic board never falls back to PHYSICAL_KEYS', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));
    const k0 = device.keys[0];
    expect(device.legend(k0)).toBe('Esc');
    device.layer0 = [0, ...device.layer0.slice(1)];
    expect(device.legend(k0)).toBe(`R${k0.row}·C${k0.col}`);
    device.layer0 = [0x9999, ...device.layer0.slice(1)];
    expect(device.legend(k0)).toBe(`R${k0.row}·C${k0.col}`);
    await device.disconnect({ flush: false });

    // A generic board whose 03 05 rows all return ratio 0 -> 0 keys, NEVER PHYSICAL_KEYS.
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const empty = createGenericMock('g60', { latencyMs: 0 });
    const origEx = (empty as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(empty);
    (empty as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange = async (f, ms) => {
      if (f[0] === 0x03 && f[1] === 0x05) {
        const z = new Uint8Array(64);
        z[0] = 0x03; z[1] = 0x05; z[2] = f[2];
        return z;
      }
      return origEx(f, ms);
    };
    const dev = new FakeHidDevice(hid, empty, { vendorId: VENDOR_ID_AULA, productId: 0xf077, productName: 'Empty Layout' });
    hid.strays.push(dev);
    hid.next = () => [dev];
    await settle(device.connect());

    expect(device.connected).toBe(true);
    expect(device.keys).toEqual([]);
    expect(device.rows).toEqual([]);
    expect(dev.sends.some((f) => f[0] === 0x03 && f[1] === 0x01)).toBe(false);
  });
});

// ------------------------------------------------------------------ No W-12 & no notAllowed toast on generic

describe('no W-12 and no notAllowed toast on generic (ae64-unlisted toast kept)', () => {
  it('never sends 02 06 01 on generic even with a matching calibration flag, and shows no notAllowed toast', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    // g60 uses DEFAULT_SERIAL [0x10..0xc0] -> serialHex '102030405060708090a0b0c0'.
    writeCalibrationFlag('102030405060708090a0b0c0');
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));

    expect(device.connected).toBe(true);
    expect(device.info?.serialHex).toBe('102030405060708090a0b0c0');
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x06)).toBe(false);
    expect(device.staleCalibration).toBe(false);
    expect(readCalibrationFlag()?.serial).toBe('102030405060708090a0b0c0');
    expect(toasts()).toEqual([]);
  });

  it('ae64-unlisted still shows device.notAllowed toast and keeps AE64 rows', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'max' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const unlisted = new MockTransport({ seed: 'max', latencyMs: 0 });
    const origHandle = unlisted.handle.bind(unlisted);
    unlisted.handle = (req: number[]) => {
      const r = origHandle(req);
      if (req[0] === 0x01 && req[1] === 0x02) {
        r[4] = 0x00; r[5] = 0x30; r[6] = 0x00; r[7] = 0x99; // unlisted board 00300099 on AE64 Max PID
      }
      return r;
    };
    const dev = new FakeHidDevice(hid, unlisted, { vendorId: VENDOR_ID, productId: 0x300d, productName: 'AE64 Unlisted' });
    hid.strays.push(dev);
    hid.next = () => [dev];

    const device = useDeviceStore();
    await settle(device.connect());

    expect(device.connected).toBe(true);
    expect(device.support).toBe('ae64-unlisted');
    expect(device.boardAllowed).toBe(false);
    expect(device.rows).toEqual([...FIRMWARE_ROWS]);
    expect(toasts()).toContain(tr('device.notAllowed', { board: '00300099' }));
  });
});

// ------------------------------------------------------------------ S5 end-to-end (38A6 through FakeHid) & Replug

describe('S5 end-to-end 38A6 WebHID connect and generic replug', () => {
  it('38A6 pick in device.connect() opens through HidTransport in generic view mode', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    const hid = installFakeHid(bus);
    const g75 = createGenericMock('g75', { latencyMs: 0 });
    const dev = new FakeHidDevice(hid, g75, { vendorId: VENDOR_ID_AULA, productId: 0xf002, productName: 'Mock 75' });
    hid.strays.push(dev);
    hid.next = () => [dev];

    const device = useDeviceStore();
    await settle(device.connect());

    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(device.boardAllowed).toBe(false);
    expect(device.displayName).toBe('Mock 75');
    expect(device.rows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(device.keys).toHaveLength(81);
    expect(JSON.parse(localStorage.getItem('ae64.lastDevice')!)).toEqual({ vendorId: VENDOR_ID_AULA, productId: 0xf002 });
  });

  it('generic unplug and plug back reconnects via matchesPlatform with same VID+PID and ignores other devices', async () => {
    type Listener = (e: unknown) => void;
    const g75 = createGenericMock('g75', { latencyMs: 0 });
    const g75Ex = (g75 as unknown as { exchange(f: Uint8Array, ms: number): Promise<Bytes> }).exchange.bind(g75);
    const mkDev = (vendorId: number, productId: number, collections = [{ usagePage: 0xffb0, usage: 1 }]) => {
      const listeners: Listener[] = [];
      const dev = {
        opened: false,
        productName: 'Mock 75',
        vendorId,
        productId,
        collections,
        opens: 0,
        open: async () => { dev.opened = true; dev.opens++; },
        close: async () => { dev.opened = false; },
        addEventListener: (_: string, cb: Listener) => { listeners.push(cb); },
        removeEventListener: (_: string, cb: Listener) => { listeners.splice(listeners.indexOf(cb), 1); },
        sendReport: async (_id: number, frame: Uint8Array) => {
          const reply = await g75Ex(Uint8Array.from(frame), 1500);
          setTimeout(() => { for (const cb of [...listeners]) cb({ data: new DataView(reply.buffer) }); }, 0);
        },
      };
      return dev;
    };

    const target = mkDev(VENDOR_ID_AULA, 0xf002);
    const otherPid = mkDev(VENDOR_ID_AULA, 0xf099);
    const otherVid = mkDev(VENDOR_ID_WUQUE, 0xf002);
    const noConfig = mkDev(VENDOR_ID_AULA, 0xf002, [{ usagePage: 1, usage: 6 }]);

    const registry = new Map<string, Listener[]>();
    const on = (type: string) => registry.get(type) ?? [];
    vi.stubGlobal('navigator', {
      hid: {
        getDevices: async () => [target],
        requestDevice: async () => [target],
        addEventListener: (type: string, cb: Listener) => { registry.set(type, [...on(type), cb]); },
        removeEventListener: (type: string, cb: Listener) => { registry.set(type, on(type).filter((l) => l !== cb)); },
      },
    });

    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connect();
    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(target.opens).toBe(1);

    // Unplug target -> arms replug for 38A6:F002.
    target.opened = false;
    on('disconnect').slice().forEach((cb) => cb({ device: target }));
    expect(device.status).toBe('idle');
    expect(on('connect')).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem('ae64.lastDevice')!)).toEqual({ vendorId: VENDOR_ID_AULA, productId: 0xf002 });

    // Non-matching devices are ignored.
    for (const decoy of [otherPid, otherVid, noConfig]) {
      on('connect').slice().forEach((cb) => cb({ device: decoy }));
      await flushPromises();
      expect(device.status).toBe('idle');
      expect(target.opens).toBe(1);
    }

    // Plugging back the same 38A6:F002 reconnects once and disarms the listener.
    on('connect').slice().forEach((cb) => cb({ device: target }));
    await vi.waitFor(() => expect(device.connected).toBe(true));
    expect(device.support).toBe('generic');
    expect(target.opens).toBe(2);
    expect(on('connect')).toHaveLength(0);
  });
});

// ------------------------------------------------------------------ setSupport spy & dev ?mock= URL hook

describe('setSupport spy and dev ?mock= URL hook', () => {
  it('setSupport is called exactly once on generic connects and never on AE64 or refused non-AE64 connects', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const spy = vi.spyOn(BaseTransport.prototype, 'setSupport');
    const device = useDeviceStore();

    // AE64 seeds: setSupport NEVER called.
    for (const seed of ['max', 'pro', 'pro-xinput'] as const) {
      spy.mockClear();
      await settle(device.connectDemo(seed));
      expect(device.support).toBe('ae64');
      expect(spy).not.toHaveBeenCalled();
    }

    // Refused non-AE64 mocks: setSupport NEVER called.
    for (const refused of ['gff80', 'gv3', 'gboot', 'gproto2'] as const) {
      spy.mockClear();
      await settle(device.connectGenericMock(refused, { latencyMs: 0 }));
      expect(device.connected).toBe(false);
      expect(spy).not.toHaveBeenCalled();
    }

    // Passing generic mocks: setSupport('generic') called EXACTLY ONCE.
    for (const ok of ['g60', 'g75', 'gspoof'] as const) {
      spy.mockClear();
      await settle(device.connectGenericMock(ok, { latencyMs: 0 }));
      expect(device.connected).toBe(true);
      expect(device.support).toBe('generic');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith('generic');
    }
  });

  it('App.vue connects ?mock=g60 automatically in DEV mode', async () => {
    const origHref = window.location.href;
    window.history.replaceState({}, '', '/?mock=g60');
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/:pathMatch(.*)*', component: { template: '<div />' } }],
    });
    await router.push('/');
    await router.isReady();

    const w = mount(App, { global: { plugins: [router] } });
    const device = useDeviceStore();
    await vi.waitFor(() => expect(device.connected).toBe(true));
    expect(device.support).toBe('generic');
    expect(device.displayName).toBe('Mock 60');
    w.unmount();
    window.history.replaceState({}, '', origHref);
  });
});
