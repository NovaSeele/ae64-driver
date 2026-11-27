// MKB-V step 2b: read-only keyboard info export (DESIGN §13, §5.4, §16.2 Export row + R1/K2/R12).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  BaseTransport, FIRMWARE_ROWS, GENERIC_ROWS, GenericMockTransport, LAYER_COUNT, MockTransport,
  UnsafeCommandError, WriteNotAllowedError,
} from '../src/protocol';
import { isWriteCommand } from '../src/protocol/safety';
import { PROFILE_POLL_MS, useDeviceStore } from '../src/stores/device';
import { useDiagnosticsStore } from '../src/stores/diagnostics';
import { useLiveStore } from '../src/stores/live';
import {
  GITHUB_KEYBOARD_INFO_ISSUE_URL, KEYBOARD_EXPORT_SCHEMA, exportKeyboardInfo, formatRefusalInfo,
  keyboardExportFileName,
} from '../src/data/keyboardExport';
import { setLocale } from '../src/i18n/locale';
import { isProfilePoll } from './helpers/profilePoll';

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;
const hex = (b: number): string => (b & 0xff).toString(16).padStart(2, '0');

/** Compact wire tag matching DESIGN §13 read notation. */
function exportTag(f: Uint8Array): string {
  if (f[0] === 0x01) return `${hex(f[0])} ${hex(f[1])}`;
  if (f[0] === 0x02) {
    if (f[1] === 0x03 && f[2] === 0x03) return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])} ${hex(f[3])}`;
    return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])}`;
  }
  if (f[0] === 0x03) {
    if (f[1] === 0x05) return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])}`;
    return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])} ${hex(f[3])}`;
  }
  if (f[0] === 0x04) return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])} ${hex(f[3])}`;
  if (f[0] === 0x05) return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])} ${hex(f[3])}`;
  if (f[0] === 0x06 && f[1] === 0x01) return `${hex(f[0])} ${hex(f[1])} ${hex(f[2])} ${hex(f[3])} ${hex(f[4])}`;
  return Array.from(f.slice(0, 4), hex).join(' ');
}

function captureOut() {
  const frames: Uint8Array[] = [];
  const proto = BaseTransport.prototype as unknown as { log: (d: 'out' | 'in', b: Uint8Array, note?: string) => void };
  const orig = proto.log;
  const spy = vi.spyOn(proto, 'log').mockImplementation(function (this: BaseTransport, dir, bytes, note) {
    if (dir === 'out') frames.push(Uint8Array.from(bytes));
    return orig.call(this, dir, bytes, note);
  });
  return { frames, tags: () => frames.map(exportTag), spy };
}

async function settle<T>(promise: Promise<T>, stepMs = 5, maxSteps = 20_000): Promise<T> {
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

/** Builds the exact expected §13 outgoing tag sequence for a connected keyboard. */
function expectedExportTags(opts: {
  generic: boolean;
  systemMode: number;
  rows: readonly number[];
  keys: readonly { row: number; col: number }[];
  areaCount: number;
}): string[] {
  const layoutRows = opts.generic ? GENERIC_ROWS : FIRMWARE_ROWS;
  const tags: string[] = [
    '01 02',
    '01 01', '01 03',
    '02 03 01', '02 03 00', '02 04 01', '02 05 00', '02 05 01',
    '02 08 00', '02 0c 00', '02 0e 00', '02 0d 01', '02 10 01',
    ...layoutRows.map((r) => `03 05 ${hex(r)}`),
  ];
  for (let layer = 0; layer < LAYER_COUNT; layer++) {
    const sysLayer = ((opts.systemMode & 15) << 4) | (layer & 15);
    for (const r of opts.rows) tags.push(`03 06 ${hex(sysLayer)} ${hex(r)}`);
  }
  for (const r of opts.rows) tags.push(`03 01 00 ${hex(r)}`);
  for (const k of opts.keys) tags.push(`04 01 ${hex(k.row)} ${hex(k.col)}`);
  for (const k of opts.keys) tags.push(`06 01 ${hex(k.row)} ${hex(k.col)} 00`);
  for (let a = 0; a < Math.min(opts.areaCount, 2); a++) {
    tags.push(`05 01 ${hex(a)} 00`, `05 01 ${hex(a)} 01`);
  }
  tags.push('02 03 01');
  return tags;
}

beforeEach(() => {
  localStorage.clear();
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
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  setLocale('vi');
});

describe('keyboard info export (DESIGN §13, §16.2)', () => {
  it('g75: exact §13 frame log, exclusive (no interleaved poll, kills M25), no raw() (M27), no 02 03 03 (M15), no serial (M16), no writes', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const now = new Date(2026, 10, 27, 16, 5);
    vi.setSystemTime(now);

    const device = useDeviceStore();
    // 15 ms per frame × 216 frames = 3,240 ms > PROFILE_POLL_MS (2,000 ms and 40 ms stress):
    // proves the profile poll never interleaves between first and last read (M25).
    await settle(device.connectGenericMock('g75', { latencyMs: 15 }), 15);
    expect(device.connected).toBe(true);
    expect(device.rows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(device.keys).toHaveLength(81);

    const t = device.transport as GenericMockTransport;
    const rawSpy = vi.spyOn(t, 'raw');
    const out = captureOut();

    // Record exclusiveActive state while the export is in flight.
    let sawExclusive = false;
    const origGetInfo = t.getDeviceInfo.bind(t);
    vi.spyOn(t, 'getDeviceInfo').mockImplementation(async () => {
      sawExclusive = device.exclusiveActive;
      return origGetInfo();
    });

    const result = await settle(exportKeyboardInfo({ now }), 15);

    expect(sawExclusive).toBe(true);
    expect(device.exclusiveActive).toBe(false);
    expect(rawSpy).not.toHaveBeenCalled();

    // Exact §13 frame sequence — NOT filtered for profile polls because exclusive must prevent ANY poll between #2 and #12.
    const expected = expectedExportTags({
      generic: true,
      systemMode: 0,
      rows: device.rows,
      keys: device.keys,
      areaCount: 2,
    });
    expect(out.tags()).toEqual(expected);

    // Exactly two `02 03 01` reads (#4 start and #12 end), zero interleaved profile polls.
    expect(out.frames.filter(isProfilePoll)).toHaveLength(2);
    expect(exportTag(out.frames[0])).toBe('01 02');
    expect(exportTag(out.frames[out.frames.length - 1])).toBe('02 03 01');

    // Zero writes, zero forbidden families/commands (M15, §13 Not sent).
    expect(out.frames.filter((f) => isWriteCommand(Array.from(f)))).toEqual([]);
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x03)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x05 && f[1] === 0x03)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x07)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x08)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x10)).toBe(false);

    // Payload shape and file name.
    expect(result.fileName).toBe('ae64control-keyboard-00f00002-20261127-1605.json');
    expect(result.payload.schema).toBe(KEYBOARD_EXPORT_SCHEMA);
    expect(result.payload.name).toBe('Mock 75');
    expect(result.payload.support).toBe('generic');
    expect(result.payload.rows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(result.payload.identity.vendorId).toBe(0x38a6);
    expect(result.payload.identity.productId).toBe(0xf002);
    expect(result.payload.profileChanged).toBe(false);
    expect(result.payload.stoppedAt).toBeUndefined();
    expect(result.payload.layoutPadding).toEqual([]);
    expect(result.payload.pressedCells).toEqual([]);
    expect(result.payload.reads.layoutStyle).toHaveLength(6);
    expect(result.payload.reads.layoutStyle[0].entries).toHaveLength(30);
    expect(result.payload.reads.layoutStyle[0].entriesHex).toHaveLength(30);
    expect(result.payload.reads.performance).toHaveLength(81);
    expect(result.payload.reads.advanced).toHaveLength(81);
    expect(result.payload.reads.lighting).toHaveLength(2);

    // M16: zero serial bytes or strings anywhere in JSON (g75 default serial is 10 20 30 .. c0).
    const devInfo = result.payload.reads.deviceInfo!;
    expect('serial' in devInfo.value).toBe(false);
    expect('serialHex' in devInfo.value).toBe(false);
    const diBytes = devInfo.hex.split(' ');
    expect(diBytes.slice(17, 29)).toEqual(new Array(12).fill('00'));
    expect(result.json).not.toContain('10 20 30 40 50 60 70 80 90 a0 b0 c0');
    expect(result.json).not.toContain('102030405060708090a0b0c0');
    expect(result.json).not.toContain(device.info!.serial);
    expect(result.json).not.toContain(device.info!.serialHex);
    // M15: no profile names stored.
    expect(result.json).not.toContain('Profile 1');

    // Poll resumes after export finishes.
    out.frames.length = 0;
    await vi.advanceTimersByTimeAsync(PROFILE_POLL_MS + 50);
    expect(out.frames.filter(isProfilePoll).length).toBeGreaterThanOrEqual(1);
  });

  it('g75: Fn profile key mid-export sets profileChanged: true; Key test pressed cells recorded with 0 HID', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g75', { latencyMs: 0 }));
    const t = device.transport as GenericMockTransport;

    // Simulate Key test presses on row 0 col 0 (Esc) and row 1 col 1 without sending HID commands.
    const live = useLiveStore();
    const row0Vals = new Array(21).fill(0);
    row0Vals[0] = 2000; // 2.0 mm > PRESSED_MM
    live.ingest('route', 0, row0Vals, 100);
    const row1Vals = new Array(21).fill(0);
    row1Vals[1] = 1500;
    live.ingest('route', 1, row1Vals, 120);

    // Switch hardware profile mid-export when reading performance.
    let switched = false;
    const origPerf = t.getPerformance.bind(t);
    vi.spyOn(t, 'getPerformance').mockImplementation(async (pos) => {
      if (!switched) {
        switched = true;
        t.setHardwareProfile(2);
      }
      return origPerf(pos);
    });

    const result = await settle(exportKeyboardInfo());

    expect(result.payload.reads.profileStart?.value).toBe(0);
    expect(result.payload.reads.profileEnd?.value).toBe(2);
    expect(result.payload.profileChanged).toBe(true);
    expect(result.payload.pressedCells).toEqual([{ row: 0, col: 0 }, { row: 1, col: 1 }]);
  });

  it('gmiss: stops at first timeout (02 03 01) with stoppedAt and error, no retries, file still made', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.connected).toBe(true);

    const out = captureOut();
    const result = await settle(exportKeyboardInfo(), 50);

    expect(out.tags()).toEqual(['01 02', '01 01', '01 03', '02 03 01']);
    expect(result.payload.schema).toBe(KEYBOARD_EXPORT_SCHEMA);
    expect(result.payload.name).toBe('Bàn phím 1CA6:F004');
    expect(result.payload.stoppedAt).toBe('02 03 01');
    expect(result.payload.error).toBeTruthy();
    expect(result.payload.reads.deviceInfo?.value.boardIdHex).toBe('00f00004');
    expect(result.payload.reads.protocolVersion?.value).toEqual({ main: 1, sub: 3, hardware: 0, software: 0 });
    expect(result.payload.reads.features).toBeDefined();
    expect(result.payload.reads.profileStart).toBeUndefined();
    expect(result.payload.profileChanged).toBe(false);
    expect(result.fileName).toMatch(/^ae64control-keyboard-00f00004-\d{8}-\d{4}\.json$/);
  });

  it('disconnect mid-export stops cleanly with stoppedAt and preserves metadata and prior reads', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g75', { latencyMs: 0 }));
    const t = device.transport as GenericMockTransport;

    const origLayout = t.getLayoutStyle.bind(t);
    vi.spyOn(t, 'getLayoutStyle').mockImplementation(async (row) => {
      if (row === 2) {
        await t.close();
      }
      return origLayout(row);
    });

    const result = await settle(exportKeyboardInfo());

    expect(result.payload.stoppedAt).toBe('03 05 02');
    expect(result.payload.error).toBeTruthy();
    expect(result.payload.name).toBe('Mock 75');
    expect(result.payload.support).toBe('generic');
    expect(result.payload.reads.layoutStyle.map((r) => r.row)).toEqual([0, 1]);
  });

  it('gspoof (R1 / K2 / M16): second 01 02 in export keeps boardAllowed false, refuses writes, and stores no serial', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gspoof', { latencyMs: 0 }));
    const t = device.transport as GenericMockTransport;
    expect(device.support).toBe('generic');
    expect(t.boardAllowed).toBe(false);
    expect(device.boardAllowed).toBe(false);

    const result = await settle(exportKeyboardInfo());

    // R1 / K2: after the export's second `01 02`, boardAllowed MUST stay false and writes MUST be refused.
    expect(t.boardAllowed).toBe(false);
    expect(device.boardAllowed).toBe(false);
    const k0 = device.keys[0];
    const perf = result.payload.reads.performance[0].value;
    await expect(t.setPerformance(k0, perf)).rejects.toSatisfy(
      (err: unknown) => err instanceof WriteNotAllowedError || err instanceof UnsafeCommandError,
    );

    // M16: gspoof serial [0x11, 0x22, ..., 0xcc] must NEVER appear in any form in the exported JSON.
    expect(result.payload.name).toBe('Mock Spoof');
    expect(result.payload.name).not.toMatch(/AE64/i);
    expect(result.json).not.toContain('11 22 33 44 55 66 77 88 99 aa bb cc');
    expect(result.json).not.toContain('112233445566778899aabbcc');
    expect(result.json).not.toContain(device.info!.serial);
    expect(result.json).not.toContain(device.info!.serialHex);
    expect(result.json).not.toMatch(/"serial(Hex)?"\s*:/);
    expect(result.payload.reads.deviceInfo?.hex.split(' ').slice(17, 29)).toEqual(new Array(12).fill('00'));
  });

  it('godd (R12, R10, R11): flags layoutPadding row 1, keeps all 30 entries, clamps lighting areas to 2, never sends 02 03 03', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('godd', { latencyMs: 0 }));

    const out = captureOut();
    const result = await settle(exportKeyboardInfo());

    expect(result.payload.stoppedAt).toBeUndefined();
    expect(result.payload.layoutPadding).toEqual([1]);
    expect(result.payload.reads.layoutStyle.find((r) => r.row === 1)?.hasPadding).toBe(true);
    expect(result.payload.reads.layoutStyle.find((r) => r.row === 1)?.entries).toHaveLength(30);
    expect(result.payload.reads.lightingAreas?.value.truncated).toBe(true);
    expect(result.payload.reads.lighting).toHaveLength(2);
    expect(result.payload.reads.profileCount?.value).toBe(6);
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x03)).toBe(false);
    expect(out.frames.filter((f) => isWriteCommand(Array.from(f)))).toEqual([]);
  });

  it('AE64 (max): export uses rows 1–5 (no row 0), exact §13 frame log, no writes, no serial, no profile names', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const now = new Date(2026, 10, 27, 9, 30);
    vi.setSystemTime(now);

    const device = useDeviceStore();
    await settle(device.connectDemo('max'));
    const t = device.transport as MockTransport;
    const rawSpy = vi.spyOn(t, 'raw');
    const diag = useDiagnosticsStore();

    const out = captureOut();
    const result = await settle(diag.exportKeyboardInfo({ now }));

    expect(rawSpy).not.toHaveBeenCalled();
    expect(result.payload.support).toBe('ae64');
    expect(result.payload.name).toBe('AE64 Max');
    expect(result.payload.rows).toEqual([1, 2, 3, 4, 5]);
    expect(result.fileName).toBe('ae64control-keyboard-0030000d-20261127-0930.json');

    const expected = expectedExportTags({
      generic: false,
      systemMode: 0,
      rows: [1, 2, 3, 4, 5],
      keys: device.keys,
      areaCount: 2,
    });
    expect(out.tags()).toEqual(expected);

    // Must never send 03 05 00 on AE64.
    expect(out.tags()).not.toContain('03 05 00');
    expect(out.frames.filter((f) => isWriteCommand(Array.from(f)))).toEqual([]);
    expect(out.frames.some((f) => f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x03)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x05 && f[1] === 0x03)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x07)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x08)).toBe(false);
    expect(out.frames.some((f) => f[0] === 0x10)).toBe(false);

    // No serial bytes/strings and no profile names in JSON.
    expect(result.json).not.toContain(device.info!.serial);
    expect(result.json).not.toContain(device.info!.serialHex);
    expect(result.json).not.toMatch(/"serial(Hex)?"\s*:/);
    expect(result.json).not.toContain('"Default"');
    expect(result.json).not.toContain('"FPS"');
    expect(result.json).not.toContain('"Typing"');
  });

  it('filename formatter, refusal formatter (§5.4), GitHub link, and issue template match §13', () => {
    expect(keyboardExportFileName('0030000D', new Date(2026, 0, 5, 7, 8)))
      .toBe('ae64control-keyboard-0030000d-20260105-0708.json');
    expect(keyboardExportFileName(undefined, new Date(2026, 0, 5, 7, 8)))
      .toBe('ae64control-keyboard-unknown-20260105-0708.json');

    expect(GITHUB_KEYBOARD_INFO_ISSUE_URL)
      .toBe('https://github.com/NovaSeele/ae64-driver/issues/new?template=keyboard-info.yml');

    const text = formatRefusalInfo({
      reason: 'version',
      identity: {
        vendorId: 0x1ca6,
        productId: 0xf007,
        productName: 'Mock Proto 2',
        collections: [{ usagePage: 0xffb0, usage: 1, inputReports: [64], outputReports: [64] }],
      },
      version: { main: 2, sub: 0, hardware: 0, software: 0 },
    });
    expect(text).toContain('VID: 0x1CA6');
    expect(text).toContain('PID: 0xF007');
    expect(text).toContain('Product: Mock Proto 2');
    expect(text).toContain('0xFFB0:0x0001 (in:[64] out:[64])');
    expect(text).toContain('Reason: version');
    expect(text).toContain('Protocol: 2.0.0.0');

    const yml = readFileSync(resolve('.github/ISSUE_TEMPLATE/keyboard-info.yml'), 'utf8');
    expect(yml).toContain('brand-model');
    expect(yml).toContain('export-file');
    expect(yml).toContain('photo');
    expect(yml.toLowerCase()).toContain('public');
    expect(yml).toContain('công khai');
  });
});
