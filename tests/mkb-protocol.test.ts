// MKB-V step 1 protocol-core tests covering DESIGN §3–§8, §10, §15, §16.2 (protocol level).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONNECT_HID_FILTERS, FW_PROBE_FILTER, GENERIC_MOCK_NAMES, GENERIC_ROWS, HID_FILTERS, PHYSICAL_KEYS,
  PUBLIC_BOARD_NAMES, VENDOR_ID, VENDOR_ID_AULA, VENDOR_ID_WUQUE,
  BaseTransport, GenericMockTransport, HidTransport, MockTransport, UnsafeCommandError, WriteNotAllowedError,
  buildGenericLayout, classify, connectHid, createGenericMock, genericDisplayName, isAe64,
  ledCount, matchesPlatform, reconnectGrantedHid, rememberDevice,
} from '../src/protocol';
import type { DeviceInfo, ProtocolVersion, TransportIdentity } from '../src/protocol';
import { FirmwareSessionError, __fwTestSeam, frameOf } from '../src/protocol/client';
import { decodeLightingAreas, encodeLayoutStyleEntry } from '../src/protocol/codec';
import { FW_BOARD_MAX, FW_BOARD_PRO, checkFile } from '../src/protocol/firmware';
import { GP_CMD, beginData, commitData, encodeFrame, usbSetData, writeData } from '../src/protocol/gamepad';
import { HidFwPort } from '../src/protocol/hid';
import { MockBootloader, MockFwBus } from '../src/protocol/mockFirmware';
import { checkFrame, isWriteCommand } from '../src/protocol/safety';
import { TabLockedError } from '../src/protocol/tabLock';
import { makeFw } from './fw-helpers';

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] as const;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const cfgCol = (extra: { usagePage: number; usage: number }[] = []) => [
  { usagePage: 0xffb0, usage: 1, inputReports: [64], outputReports: [64] },
  ...extra.map((c) => ({ ...c, inputReports: [], outputReports: [] })),
];

const mkIdentity = (overrides: Partial<TransportIdentity> = {}): TransportIdentity => ({
  vendorId: VENDOR_ID,
  productId: 0xf001,
  productName: 'Mock',
  collections: cfgCol(),
  ...overrides,
});

const mkInfo = (overrides: Partial<DeviceInfo> = {}): DeviceInfo => ({
  type: 1,
  subType: 0,
  boardId: 0x00f00001,
  boardIdHex: '00f00001',
  firmware: '1.0.0.0',
  pcb: '1-0-0-0',
  runMode: 0,
  serial: '123456',
  serialHex: '112233445566778899aabbcc',
  timestamp: '2026112700:00:00',
  ...overrides,
});

const VER_13: ProtocolVersion = { main: 1, sub: 3, hardware: 0, software: 0 };
const VER_12: ProtocolVersion = { main: 1, sub: 2, hardware: 0, software: 0 };
const VER_20: ProtocolVersion = { main: 2, sub: 0, hardware: 0, software: 0 };

const rawRequest = (t: BaseTransport, payload: number[], timeoutMs?: number) =>
  (t as unknown as { request(p: number[], ms?: number): Promise<Uint8Array> }).request(payload, timeoutMs);

const TOKEN = [1, 2, 3, 4, 5, 6, 7, 8];

/** Sample valid payload for every `write: true` rule in safety.ts (non-family-10). */
const NON_GP_WRITE_SAMPLES: readonly [string, number[]][] = [
  ['02 02 commit', [0x02, 0x02, 2]],
  ['02 03 02 setActiveProfile', [0x02, 0x03, 0x02, 0]],
  ['02 03 04 setProfileName', [0x02, 0x03, 0x04, 0, 0x41]],
  ['02 04 02 setSystemMode', [0x02, 0x04, 0x02, 0]],
  ['02 05 02 setPollingRate', [0x02, 0x05, 0x02, 0]],
  ['02 06 00 startCalibration', [0x02, 0x06, 0x00]],
  ['02 06 01 stopCalibration', [0x02, 0x06, 0x01]],
  ['02 0d 00 setRgbSleep', [0x02, 0x0d, 0x00, 10, 0]],
  ['02 10 00 setShakeOptimization', [0x02, 0x10, 0x00, 1]],
  ['03 04 setKeycode row 1', [0x03, 0x04, 0, 1, 0, 0x04, 0x00]],
  ['03 04 setKeycode row 0', [0x03, 0x04, 0, 0, 0, 0x04, 0x00]],
  ['04 02 setPerformance', [0x04, 0x02, 1, 0, 0]],
  ['05 02 setLightingBase', [0x05, 0x02, 0, 0, 1, 0, 80, 50, 0, 0]],
  ['05 04 writeLedMatrix', [0x05, 0x04, 0, 0]],
  ['06 02 clearAdvanced', [0x06, 0x02, 1, 0, 0]],
  ['07 02 setMacroMeta', [0x07, 0x02, 0, 1, 0, 0, 1, 0, 0]],
  ['07 04 writeMacroActions', [0x07, 0x04, 0, 0]],
];

/** Sample valid payload for every family-10 `write: true` rule in safety.ts. */
const GP_WRITE_SAMPLES: readonly [string, number[]][] = [
  ['10 BEGIN', encodeFrame(GP_CMD.BEGIN, 1, beginData(1, 2, TOKEN))],
  ['10 WRITE', encodeFrame(GP_CMD.WRITE, 1, writeData(TOKEN, 0, [0]))],
  ['10 COMMIT', encodeFrame(GP_CMD.COMMIT, 1, commitData(TOKEN, 2, 1))],
  ['10 ABORT', encodeFrame(GP_CMD.ABORT, 1, TOKEN)],
  ['10 USB_SET', encodeFrame(GP_CMD.USB_SET, 1, usbSetData(true, 1))],
];

// ------------------------------------------------------------------ S1: family 08 & family 10

describe('S1 firmware family 08 frame lock (M2)', () => {
  it('refuses fwEnter on a session with support "generic" via __fwTestSeam and sends no 08 frame', async () => {
    const t = createGenericMock('gspoof', { latencyMs: 0 });
    const sent08: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x08) sent08.push(Array.from(b)); });

    const bytes = makeFw({ board: FW_BOARD_MAX });
    const check = checkFile(bytes, FW_BOARD_MAX);
    expect(check.ok).toBe(true);

    const ticket = __fwTestSeam!.newSession({
      bytes,
      check,
      board: FW_BOARD_MAX,
      serialHex: '112233445566778899aabbcc',
      appSerialHex: '112233445566778899aabbcc',
      step: 'open',
      app: t,
      boot: null,
      rescue: false,
      support: 'generic',
    });

    await expect(t.fwEnter(ticket)).rejects.toThrow(UnsafeCommandError);
    await expect(t.fwEnter(ticket)).rejects.toThrow('firmware only in an AE64 or rescue session');
    expect(sent08).toEqual([]);
  });
});

describe('S1 firmware session opening lock (M2b)', () => {
  it('gspoof with a valid AE64 Max file passes file/official/mode/board/serial and stops at FirmwareSessionError("kind")', async () => {
    const t = createGenericMock('gspoof', { latencyMs: 0 });
    const sent08: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x08) sent08.push(Array.from(b)); });

    const file = makeFw({ board: FW_BOARD_MAX });
    await expect(t.beginFirmwareSession(file, { officialOnly: false }))
      .rejects.toSatisfy((err: unknown) => err instanceof FirmwareSessionError && err.reason === 'kind');
    expect(sent08).toEqual([]);
  });

  it('beginRescueSession refuses a 38A6 bootloader spoofing an AE64 board with FirmwareSessionError("kind")', async () => {
    // 38A6 VID with runMode 255 and AE64 Max board passes mode/board/file/official, then stops at kind.
    const t = createGenericMock('gboot', { latencyMs: 0, vendorId: VENDOR_ID_AULA });
    vi.spyOn(t, 'getDeviceInfo').mockResolvedValue(mkInfo({
      boardId: FW_BOARD_MAX,
      boardIdHex: '0030000d',
      runMode: 255,
    }));
    const file = makeFw({ board: FW_BOARD_MAX });
    await expect(t.beginRescueSession(file, { officialOnly: false }))
      .rejects.toSatisfy((err: unknown) => err instanceof FirmwareSessionError && err.reason === 'kind');
  });

  it('beginRescueSession still succeeds for an AE64 1CA6 MockBootloader', async () => {
    const bus = new MockFwBus([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { model: 'pro' });
    const boot = new MockBootloader(bus, bus.serial, 'boot');
    const ticket = await boot.beginRescueSession(makeFw({ board: FW_BOARD_PRO }));
    expect(ticket).toBeDefined();
  });
});

describe('S1 family 10 gamepad lock (M3)', () => {
  it('gspoofPro refuses a hand-built 10 01 through request() with the support reason and sends no 10 frame', async () => {
    const t = createGenericMock('gspoofPro', { latencyMs: 0 });
    const sent10: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x10) sent10.push(Array.from(b)); });

    const info = await t.getDeviceInfo();
    expect(info.boardIdHex).toBe('0030000a');
    t.setSupport('generic');

    const gpInfo = encodeFrame(GP_CMD.INFO, 1);
    await expect(rawRequest(t, [0x10, 0x01])).rejects.toThrow(UnsafeCommandError);
    await expect(rawRequest(t, [0x10, 0x01])).rejects.toThrow('family 10 only on an AE64 connection');
    await expect(rawRequest(t, gpInfo)).rejects.toThrow('family 10 only on an AE64 connection');
    await expect(t.gamepadInfo()).rejects.toThrow('family 10 only on an AE64 connection');
    expect(sent10).toEqual([]);
  });
});

// ------------------------------------------------------------------ K2 / R1 & transport support semantics

describe('K2 / R1 boardAllowed and support semantics', () => {
  it('gspoof keeps boardAllowed false across repeated getDeviceInfo() calls and refuses 04 02', async () => {
    const t = createGenericMock('gspoof', { latencyMs: 0 });
    expect(t.support).toBeUndefined();
    expect(t.boardAllowed).toBe(false);

    const first = await t.getDeviceInfo();
    expect(first.boardIdHex).toBe('0030000d');
    expect(t.boardAllowed).toBe(false);

    t.setSupport('generic');
    expect(t.support).toBe('generic');
    expect(t.boardAllowed).toBe(false);

    // Second 01 02 (as during export) must never set boardAllowed to true (K2).
    const second = await t.getDeviceInfo();
    expect(second.boardIdHex).toBe('0030000d');
    expect(t.boardAllowed).toBe(false);

    const sentWrites: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x04 && b[1] === 0x02) sentWrites.push(Array.from(b)); });
    await expect(rawRequest(t, [0x04, 0x02, 1, 0, 0])).rejects.toThrow(WriteNotAllowedError);
    expect(sentWrites).toEqual([]);
  });

  it('setSupport throws on an AE64 identity and on a second call for a non-AE64 identity', async () => {
    const ae64 = new MockTransport({ seed: 'max', latencyMs: 0 });
    expect(ae64.support).toBeUndefined();
    expect(() => ae64.setSupport('generic')).toThrow();
    await ae64.getDeviceInfo();
    expect(ae64.support).toBe('ae64');
    expect(ae64.boardAllowed).toBe(true);
    expect(() => ae64.setSupport('generic')).toThrow();

    const gen = createGenericMock('g60', { latencyMs: 0 });
    expect(gen.support).toBeUndefined();
    gen.setSupport('generic');
    expect(gen.support).toBe('generic');
    expect(() => gen.setSupport('generic')).toThrow();
  });
});

// ------------------------------------------------------------------ S3 locks 1 & 2 (M4, M5)

describe('S3 transport write locks (M4, M5)', () => {
  it('Lock 1 (M4): refuses every write:true rule with WriteNotAllowedError when Lock 2 is removed', async () => {
    const t = createGenericMock('g60', { latencyMs: 0 });
    await t.getDeviceInfo();
    t.setSupport('generic');
    expect(t.boardAllowed).toBe(false);

    // Remove Lock 2: drop readOnly from frameOptions so only Lock 1 (!boardAllowed) blocks writes.
    vi.spyOn(t as unknown as { frameOptions(): unknown }, 'frameOptions').mockReturnValue({ rows: 'generic' });

    const sent: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out') sent.push(Array.from(b)); });

    for (const [label, payload] of NON_GP_WRITE_SAMPLES) {
      expect(isWriteCommand(payload), label).toBe(true);
      await expect(rawRequest(t, payload), label).rejects.toThrow(WriteNotAllowedError);
    }
    // Family-10 write rules are also marked write:true (refused by S1 support check before Lock 1).
    for (const [label, payload] of GP_WRITE_SAMPLES) {
      expect(isWriteCommand(payload), label).toBe(true);
      await expect(rawRequest(t, payload), label).rejects.toThrow(UnsafeCommandError);
    }
    expect(sent).toEqual([]);
  });

  it('Lock 2 (M5): refuses every write:true rule with UnsafeCommandError when Lock 1 is removed', async () => {
    const t = createGenericMock('g60', { latencyMs: 0 });
    await t.getDeviceInfo();
    t.setSupport('generic');

    // Remove Lock 1: force boardAllowed = true so only Lock 2 (frameOf readOnly:true) blocks writes.
    t.boardAllowed = true;

    const sent: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out') sent.push(Array.from(b)); });

    for (const [label, payload] of NON_GP_WRITE_SAMPLES) {
      await expect(rawRequest(t, payload), label).rejects.toThrow(UnsafeCommandError);
      await expect(rawRequest(t, payload), label).rejects.toThrow(/read-only/);
    }
    for (const [label, payload] of GP_WRITE_SAMPLES) {
      expect(() => checkFrame(payload, { readOnly: true, rows: 'generic' }), label).toThrow(UnsafeCommandError);
      await expect(rawRequest(t, payload), label).rejects.toThrow(UnsafeCommandError);
    }
    expect(sent).toEqual([]);
  });

  it('Lock 2 pre-G4 (M5b): refuses writes on a non-AE64 identity BEFORE setSupport even with Lock 1 removed', async () => {
    const t = createGenericMock('g60', { latencyMs: 0 });
    expect(t.support).toBeUndefined();
    t.boardAllowed = true; // remove Lock 1

    const sent: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out') sent.push(Array.from(b)); });

    await expect(rawRequest(t, [0x04, 0x02, 1, 0, 0])).rejects.toThrow(UnsafeCommandError);
    await expect(rawRequest(t, [0x04, 0x02, 1, 0, 0])).rejects.toThrow('write command on a read-only path');
    expect(sent).toEqual([]);
  });
});

// ------------------------------------------------------------------ S5 filters, predicates, FwPort, connectHid, reconnect, rememberDevice (M8, M9, M19)

describe('S5 device filters, selection and FwPort isolation (M8, M9, M19)', () => {
  function fakeHidDevice(o: {
    vendorId: number;
    productId: number;
    productName?: string;
    collections?: { usagePage?: number; usage?: number; inputReports?: HIDReportInfo[]; outputReports?: HIDReportInfo[] }[];
  }) {
    const dev = {
      opened: false,
      opens: 0,
      vendorId: o.vendorId,
      productId: o.productId,
      productName: o.productName,
      collections: o.collections ?? [{ usagePage: 0xffb0, usage: 1 }],
      open: async () => { dev.opened = true; dev.opens++; },
      close: async () => { dev.opened = false; },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      sendReport: async () => undefined,
    };
    return dev;
  }

  it('requestDevice uses exact filter order [...HID_FILTERS, FW_PROBE_FILTER, 38A6, 36B5] (M8)', async () => {
    const expected = [
      ...HID_FILTERS,
      FW_PROBE_FILTER,
      { vendorId: 0x38a6, usagePage: 0xffb0, usage: 0x01 },
      { vendorId: 0x36b5, usagePage: 0xffb0, usage: 0x01 },
    ];
    expect(CONNECT_HID_FILTERS).toEqual(expected);

    const seenFilters: HIDDeviceFilter[][] = [];
    const dev38a6 = fakeHidDevice({ vendorId: 0x38a6, productId: 0xf002, productName: 'Mock 75' });
    vi.stubGlobal('navigator', {
      hid: {
        requestDevice: async (opts: { filters: HIDDeviceFilter[] }) => {
          seenFilters.push(opts.filters);
          return [dev38a6];
        },
        getDevices: async () => [dev38a6],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });

    const t = await connectHid();
    expect(seenFilters).toEqual([expected]);
    expect(t.identity.vendorId).toBe(0x38a6);
    expect(t.identity.productId).toBe(0xf002);
    expect(t.connected).toBe(true);
    await t.close();
  });

  it('matchesPlatform accepts 1CA6, 38A6, 36B5 with FFB0:01 and rejects other vendors/collections', () => {
    expect(matchesPlatform(mkIdentity({ vendorId: VENDOR_ID }))).toBe(true);
    expect(matchesPlatform(mkIdentity({ vendorId: VENDOR_ID_AULA }))).toBe(true);
    expect(matchesPlatform(mkIdentity({ vendorId: VENDOR_ID_WUQUE }))).toBe(true);
    expect(matchesPlatform(mkIdentity({ vendorId: 0x17ef }))).toBe(false);
    expect(matchesPlatform(mkIdentity({ vendorId: 0x046d }))).toBe(false);
    expect(matchesPlatform(mkIdentity({ vendorId: 0x31e3 }))).toBe(false);
    expect(matchesPlatform(mkIdentity({ vendorId: VENDOR_ID_AULA, collections: [{ usagePage: 0xff80, usage: 1, inputReports: [], outputReports: [] }] }))).toBe(false);
  });

  it('FwPort.list() with a granted 38A6 (or 36B5) device opens nothing (M19)', async () => {
    const d38a6 = fakeHidDevice({ vendorId: 0x38a6, productId: 0xf002, productName: 'AULA' });
    const d36b5 = fakeHidDevice({ vendorId: 0x36b5, productId: 0xf003, productName: 'Wuque' });
    vi.stubGlobal('navigator', {
      hid: {
        getDevices: async () => [d38a6, d36b5],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });
    const port = new HidFwPort();
    const opened = await port.list();
    expect(opened).toEqual([]);
    expect(d38a6.opens).toBe(0);
    expect(d36b5.opens).toBe(0);
  });

  it('reconnectGrantedHid prefers AE64 first, then remembered platform (VID+PID), then first platform', async () => {
    const d36b5 = fakeHidDevice({ vendorId: 0x36b5, productId: 0xf003, productName: 'Wuque' });
    const d38a6 = fakeHidDevice({ vendorId: 0x38a6, productId: 0xf002, productName: 'AULA' });
    const dStray = fakeHidDevice({ vendorId: 0x17ef, productId: 0x1234, productName: 'Lenovo' });
    vi.stubGlobal('navigator', {
      hid: {
        getDevices: async () => [dStray, d36b5, d38a6],
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
      },
    });

    // Branch 2: remembered platform device (38A6:F002) beats earlier 36B5:F003.
    rememberDevice(0x38a6, 0xf002);
    const t1 = await reconnectGrantedHid();
    expect(t1?.identity.vendorId).toBe(0x38a6);
    expect(t1?.identity.productId).toBe(0xf002);
    await t1?.close();

    // Branch 3: no remembered match -> first matchesPlatform (36B5:F003), stray ignored.
    localStorage.clear();
    const t2 = await reconnectGrantedHid();
    expect(t2?.identity.vendorId).toBe(0x36b5);
    expect(t2?.identity.productId).toBe(0xf003);
    expect(dStray.opens).toBe(0);
    await t2?.close();

    // rememberDevice AE64 JSON is byte-identical to today.
    rememberDevice(VENDOR_ID, 0x300d);
    expect(localStorage.getItem('ae64.lastDevice')).toBe('{"vendorId":7334,"productId":12301}');

    // TabLockedError carries vendorId + productId.
    const err = new TabLockedError(0x38a6, 0xf002);
    expect(err.vendorId).toBe(0x38a6);
    expect(err.productId).toBe(0xf002);
  });
});

// ------------------------------------------------------------------ classify (G0–G4, §5.3, M1, M9, M10)

describe('classify pure function (G0–G4, §5.3, M1, M9, M10)', () => {
  it('classifies AE64 identities (ae64, ae64-unlisted, rescue, mode)', () => {
    const ae64Max = mkIdentity({ vendorId: VENDOR_ID, productId: 0x300d });
    expect(isAe64(ae64Max)).toBe(true);
    expect(classify(ae64Max, mkInfo({ boardId: 0x0030000d, boardIdHex: '0030000d', runMode: 0 }))).toEqual({ ok: true, support: 'ae64' });
    expect(classify(ae64Max, mkInfo({ boardId: 0x0030000b, boardIdHex: '0030000b', runMode: 0 }))).toEqual({ ok: true, support: 'ae64-unlisted' });
    expect(classify(ae64Max, mkInfo({ boardId: 0x00999999, boardIdHex: '00999999', runMode: 255 }))).toEqual({ ok: true, support: 'rescue' });
    expect(classify(ae64Max, mkInfo({ runMode: 2 }))).toEqual({ ok: false, reason: 'mode' });
  });

  it('G0 (M9): refuses any non-AE64 device with an FF80 collection before or after 01 02', () => {
    const gff80 = createGenericMock('gff80', { latencyMs: 0 });
    expect(classify(gff80.identity, null)).toEqual({ ok: false, reason: 'receiver' });
    expect(classify(gff80.identity, mkInfo(), VER_13)).toEqual({ ok: false, reason: 'receiver' });
  });

  it('G1, G2, G3: refuses missing info, unknown run modes, and blank boards (0 / FFFFFFFF)', () => {
    const id = mkIdentity();
    expect(classify(id, null)).toEqual({ ok: false, reason: 'protocol' });
    expect(classify(id, mkInfo({ runMode: 1 }), VER_13)).toEqual({ ok: false, reason: 'mode' });
    expect(classify(id, mkInfo({ boardId: 0, boardIdHex: '00000000' }), VER_13)).toEqual({ ok: false, reason: 'protocol' });
    expect(classify(id, mkInfo({ boardId: 0xffffffff, boardIdHex: 'ffffffff' }), VER_13)).toEqual({ ok: false, reason: 'protocol' });
  });

  it('§5.3 run mode 255 (M1): allows 1CA6 AE64/blank bootloaders, refuses non-AE64 boards and other VIDs', () => {
    const boot1ca6 = createGenericMock('gboot', { latencyMs: 0 }).identity;
    const boot38a6 = createGenericMock('gboot', { latencyMs: 0, vendorId: VENDOR_ID_AULA }).identity;
    const boot36b5 = mkIdentity({ vendorId: VENDOR_ID_WUQUE, productId: 0xf008 });

    // 1CA6 non-AE64 PID with AE64 board or blank board -> rescue
    expect(classify(boot1ca6, mkInfo({ runMode: 255, boardId: FW_BOARD_PRO, boardIdHex: '0030000a' }))).toEqual({ ok: true, support: 'rescue' });
    expect(classify(boot1ca6, mkInfo({ runMode: 255, boardId: FW_BOARD_MAX, boardIdHex: '0030000d' }))).toEqual({ ok: true, support: 'rescue' });
    expect(classify(boot1ca6, mkInfo({ runMode: 255, boardId: 0, boardIdHex: '00000000' }))).toEqual({ ok: true, support: 'rescue' });
    expect(classify(boot1ca6, mkInfo({ runMode: 255, boardId: 0xffffffff, boardIdHex: 'ffffffff' }))).toEqual({ ok: true, support: 'rescue' });

    // 1CA6 non-AE64 PID with non-AE64 board -> bootOther (kills M1)
    expect(classify(boot1ca6, mkInfo({ runMode: 255, boardId: 0x00f00008, boardIdHex: '00f00008' }))).toEqual({ ok: false, reason: 'bootOther' });

    // Non-1CA6 VID -> always bootOther, even with an AE64 or blank board
    expect(classify(boot38a6, mkInfo({ runMode: 255, boardId: 0x00f00008, boardIdHex: '00f00008' }))).toEqual({ ok: false, reason: 'bootOther' });
    expect(classify(boot38a6, mkInfo({ runMode: 255, boardId: FW_BOARD_MAX, boardIdHex: '0030000d' }))).toEqual({ ok: false, reason: 'bootOther' });
    expect(classify(boot36b5, mkInfo({ runMode: 255, boardId: 0, boardIdHex: '00000000' }))).toEqual({ ok: false, reason: 'bootOther' });
  });

  it('G4 (M10): requires main === 1 for generic support', () => {
    const id = createGenericMock('gproto2', { latencyMs: 0 }).identity;
    const info = mkInfo({ boardId: 0x00f00007, boardIdHex: '00f00007' });
    expect(classify(id, info)).toEqual({ ok: false, reason: 'version' });
    expect(classify(id, info, VER_20)).toEqual({ ok: false, reason: 'version' });
    expect(classify(id, info, { main: 0, sub: 9, hardware: 0, software: 0 })).toEqual({ ok: false, reason: 'version' });
    expect(classify(id, info, VER_12)).toEqual({ ok: true, support: 'generic' });
    expect(classify(id, info, VER_13)).toEqual({ ok: true, support: 'generic' });
  });
});

// ------------------------------------------------------------------ Rows R4 (M13, M13b)

describe('Rows R4 checkFrame & transport row gating (M13, M13b)', () => {
  const ROW0_READS: readonly [string, number[]][] = [
    ['03 01', [0x03, 0x01, 0, 0]],
    ['03 03', [0x03, 0x03, 0, 0, 0]],
    ['03 05', [0x03, 0x05, 0]],
    ['03 06', [0x03, 0x06, 0, 0]],
    ['04 01', [0x04, 0x01, 0, 0]],
    ['04 03', [0x04, 0x03, 1, 0]],
    ['06 01', [0x06, 0x01, 0, 0, 0]],
  ];
  const ROW0_WRITES: readonly [string, number[]][] = [
    ['03 04', [0x03, 0x04, 0, 0, 0, 0x04, 0x00]],
    ['04 02', [0x04, 0x02, 0, 0, 0]],
    ['06 02', [0x06, 0x02, 0, 0, 0]],
    ['06 02 SOCD partner row 0', [0x06, 0x02, 1, 0, 6, 0, 1, 0x04, 0, 0x07, 0]],
  ];

  it('refuses row 0 with no options and with rows:"ae64", accepts row-0 reads with rows:"generic" (M13b)', () => {
    for (const [label, p] of ROW0_READS) {
      expect(() => checkFrame(p), `default ${label}`).toThrow(UnsafeCommandError);
      expect(() => checkFrame(p, { rows: 'ae64' }), `ae64 ${label}`).toThrow(UnsafeCommandError);
      expect(() => frameOf(p), `frameOf default ${label}`).toThrow(UnsafeCommandError);
      expect(() => checkFrame(p, { rows: 'generic' }), `generic ${label}`).not.toThrow();
      expect(() => checkFrame(p, { readOnly: true, rows: 'generic' }), `generic ro ${label}`).not.toThrow();
    }
    for (const [label, p] of ROW0_WRITES) {
      expect(() => checkFrame(p), `default ${label}`).toThrow(UnsafeCommandError);
      expect(() => checkFrame(p, { readOnly: true, rows: 'generic' }), `generic ro ${label}`).toThrow(UnsafeCommandError);
    }
    // Row 6 and col 21 stay refused even on generic.
    expect(() => checkFrame([0x03, 0x05, 6], { rows: 'generic' })).toThrow(UnsafeCommandError);
    expect(() => checkFrame([0x04, 0x01, 0, 21], { rows: 'generic' })).toThrow(UnsafeCommandError);
  });

  it('refuses row 0 on an AE64 connection and accepts row-0 reads on a generic connection (M13)', async () => {
    const ae64 = new MockTransport({ seed: 'max', latencyMs: 0 });
    await ae64.getDeviceInfo();
    expect(ae64.support).toBe('ae64');
    await expect(ae64.getLayoutStyle(0)).rejects.toThrow(UnsafeCommandError);
    await expect(ae64.getKeymapRow(0, 0)).rejects.toThrow(UnsafeCommandError);
    await expect(ae64.getAxisData('route', 0)).rejects.toThrow(UnsafeCommandError);

    const g75 = createGenericMock('g75', { latencyMs: 0 });
    await g75.getDeviceInfo();
    // Before setSupport('generic'), row 0 is still refused.
    await expect(g75.getLayoutStyle(0)).rejects.toThrow(UnsafeCommandError);
    g75.setSupport('generic');
    const row0Style = await g75.getLayoutStyle(0);
    expect(row0Style[0].ratio).toBe(1);
    const row0Keys = await g75.getKeymapRow(0, 0);
    expect(row0Keys[0]).toBe(0x29); // Esc on row 0
    const row0Perf = await g75.getPerformance({ row: 0, col: 0 });
    expect(row0Perf.axisRangeMax).toBe(3500);
    g75.simulatePressPos(0, 1, 2.0);
    expect((await g75.getAxisData('route', 0)).values[1]).toBe(2000);
    expect((await g75.getAxisData('keyStatus', 0)).values[1]).toBe(1);
  });
});

// ------------------------------------------------------------------ Areas R11 (M22) & ledCount (§10.2)

describe('Areas R11 and per-connection ledCount (M22)', () => {
  it('godd count 16 clamps to 15 and sets truncated:true (M22)', async () => {
    const godd = createGenericMock('godd', { latencyMs: 0 });
    const areas = await godd.getLightingAreas();
    expect(areas.count).toBe(16);
    expect(areas.areas).toHaveLength(15);
    expect(areas.shapes).toHaveLength(15);
    expect(areas.truncated).toBe(true);
    expect(areas.shapes[0]).toEqual({ id: 0, rows: 5, cols: 15 });
    expect(areas.shapes[1]).toEqual({ id: 1, rows: 1, cols: 12 });
    expect(areas.shapes.every((s) => Number.isInteger(s.rows) && Number.isInteger(s.cols))).toBe(true);
  });

  it('g75 keeps area shapes and uses per-connection ledCount for readLedMatrix', async () => {
    const g75 = createGenericMock('g75', { latencyMs: 0 });
    await g75.getDeviceInfo();
    g75.setSupport('generic');
    const areas = await g75.getLightingAreas();
    expect(areas.count).toBe(2);
    expect(areas.truncated).toBe(false);
    expect(areas.shapes).toEqual([
      { id: 0, rows: 6, cols: 16 },
      { id: 1, rows: 1, cols: 20 },
    ]);
    expect(g75.ledCount(0)).toBe(126);
    expect(g75.ledCount(1)).toBe(20);

    const stripPages: number[] = [];
    g75.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x05 && b[1] === 0x03 && b[2] === 1) stripPages.push(b[3]); });
    const strip = await g75.readLedMatrix(1);
    expect(strip).toHaveLength(20);
    expect(stripPages).toEqual([0, 1]); // 20 LEDs = 2 pages (0..14, 15..19), never page 2
  });

  it('keeps AE64 decodeLightingAreas values unchanged plus shapes/truncated, and 126/38 ledCount', () => {
    const raw = new Uint8Array(64);
    raw.set([0x02, 0x08, 0x00, 0x02, 0x00, 0x13, 0x06, 0x0f, 0x01, 0x05, 0x01, 0x26]);
    const decoded = decodeLightingAreas(raw);
    expect(decoded.count).toBe(2);
    expect(decoded.areas).toEqual([{ modes: 19 }, { modes: 5, leds: 38 }]);
    expect(decoded.shapes).toEqual([
      { id: 0, rows: 6, cols: 15 },
      { id: 1, rows: 1, cols: 38 },
    ]);
    expect(decoded.truncated).toBe(false);
    expect(ledCount(0)).toBe(126);
    expect(ledCount(1)).toBe(38);
    // Generic 5-row board uses rows * 21 = 105; oversized matrix (>6 rows or >21 cols) returns 0.
    expect(ledCount(0, {
      support: 'generic',
      areas: { count: 1, areas: [{ modes: 10 }], shapes: [{ id: 0, rows: 5, cols: 14 }], truncated: false, raw: [] },
    })).toBe(105);
    expect(ledCount(0, {
      support: 'generic',
      areas: { count: 1, areas: [{ modes: 10 }], shapes: [{ id: 0, rows: 7, cols: 15 }], truncated: false, raw: [] },
    })).toBe(0);
  });
});

// ------------------------------------------------------------------ Layout R12 builder (M14, M23)

describe('Generic layout builder R12 (M14, M23)', () => {
  async function readGenericLayout(t: ReturnType<typeof createGenericMock>) {
    t.setSupport('generic');
    const styles = [];
    for (const r of GENERIC_ROWS) {
      try { styles.push(await t.getLayoutStyle(r)); } catch { styles.push(null); }
    }
    return buildGenericLayout(styles);
  }

  it('builds g60 (61 keys on rows 1–5) and g75 (81 keys on rows 0–5)', async () => {
    const g60 = createGenericMock('g60', { latencyMs: 0 });
    const l60 = await readGenericLayout(g60);
    expect(l60.keys).toHaveLength(61);
    expect(l60.rows).toEqual([1, 2, 3, 4, 5]);
    expect(l60.missingRows).toEqual([]);
    expect(l60.layoutPadding).toEqual([]);
    expect(l60.hasOverlap).toBe(false);
    expect(l60.keys.every((k) => k.unknownRatio === undefined)).toBe(true);
    expect(l60.keys.filter((k) => k.row === 5)).toHaveLength(8);
    expect(l60.keys.find((k) => k.row === 5 && k.col === 6)?.w).toBe(6.25);

    const g75 = createGenericMock('g75', { latencyMs: 0 });
    const l75 = await readGenericLayout(g75);
    expect(l75.keys).toHaveLength(81);
    expect(l75.rows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(l75.missingRows).toEqual([]);
    expect(l75.hasOverlap).toBe(false);
    expect(l75.keys.every((k) => k.unknownRatio === undefined)).toBe(true);
    expect(Math.max(...l75.keys.map((k) => k.x + k.w))).toBe(16);
  });

  it('godd: unknown widths from gap & row-end 1u (M14), hole, overlap note, padding 21–29 ignored & flagged (M23)', async () => {
    const godd = createGenericMock('godd', { latencyMs: 0 });
    const layout = await readGenericLayout(godd);
    // 11 keys only (cols 21 & 25 ignored, col 2 hole omitted)
    expect(layout.keys).toHaveLength(11);
    expect(layout.keys.every((k) => k.col <= 20)).toBe(true);
    expect(layout.layoutPadding).toEqual([1]);
    expect(layout.hasOverlap).toBe(true);
    expect(layout.keys.find((k) => k.row === 1 && k.col === 2)).toBeUndefined(); // hole

    // Unknown code 7: gap to col 3 (x=3.75 - 1 = 2.75)
    const k7 = layout.keys.find((k) => k.row === 1 && k.col === 1)!;
    expect(k7.unknownRatio).toBe(7);
    expect(k7.w).toBe(2.75);

    // Unknown code 8 at row end: no next key -> 1u
    const k8 = layout.keys.find((k) => k.row === 1 && k.col === 4)!;
    expect(k8.unknownRatio).toBe(8);
    expect(k8.w).toBe(1);

    // Unknown code 12 (2-row-tall key slot): gap to col 3 (x=4.5 - 3 = 1.5)
    const k12 = layout.keys.find((k) => k.row === 2 && k.col === 2)!;
    expect(k12.unknownRatio).toBe(12);
    expect(k12.w).toBe(1.5);

    // Ids run 0..N-1 in row-then-col order and names default to R{row}·C{col}.
    expect(layout.keys.map((k) => k.id)).toEqual(Array.from({ length: 11 }, (_, i) => i));
    expect(layout.keys[0].name).toBe('R1·C0');
    expect(layout.keys).not.toEqual(PHYSICAL_KEYS);
  });

  it('handles missing rows, origin normalisation, edge gap bounds, exact 0.25u touch, and empty layouts without PHYSICAL_KEYS', () => {
    // Empty / all missing -> never PHYSICAL_KEYS
    const empty = buildGenericLayout([null, null, null, null, null, null]);
    expect(empty.keys).toEqual([]);
    expect(empty.rows).toEqual([]);
    expect(empty.missingRows).toEqual([0, 1, 2, 3, 4, 5]);
    expect(empty.hasOverlap).toBe(false);

    // Origin normalisation + gap > 7 -> 1u + exact 0.25u overlap is NOT flagged (> 0.25 required)
    const row0 = Array.from({ length: 30 }, () => ({ x: 0, y: 0, ratio: 0 }));
    row0[0] = { x: 2, y: 1.5, ratio: 7 }; // unknown code 7, next key at x=10.5 -> gap 8.5 > 7 -> 1u
    row0[1] = { x: 10.5, y: 1.5, ratio: 1 };
    const row1 = Array.from({ length: 30 }, () => ({ x: 0, y: 0, ratio: 0 }));
    row1[0] = { x: 2, y: 2.5, ratio: 1 }; // [0, 1] after normalisation
    row1[1] = { x: 2.75, y: 2.5, ratio: 1 }; // [0.75, 1.75] -> overlap exactly 0.25 (not > 0.25)
    const built = buildGenericLayout([row0, row1, null, null, null, null]);
    expect(built.missingRows).toEqual([2, 3, 4, 5]);
    expect(built.keys[0]).toMatchObject({ x: 0, y: 0, uiRow: 0, w: 1, unknownRatio: 7 });
    expect(built.keys[2]).toMatchObject({ x: 0, y: 1, uiRow: 1, w: 1 });
    expect(built.hasOverlap).toBe(false);
    // Sanity check encodeLayoutStyleEntry round-trip still works
    expect(encodeLayoutStyleEntry({ y: 0, x: 1, ratio: 7 }) & 15).toBe(7);
  });
});

// ------------------------------------------------------------------ Identity N6

describe('Identity N6 null-safe HidTransport mapping', () => {
  it('opens a bare HIDDevice with only {usagePage: 0xffb0, usage: 1} and no productName or report lists', async () => {
    vi.stubGlobal('navigator', {
      hid: { addEventListener: () => undefined, removeEventListener: () => undefined },
    });
    const bare = {
      opened: true,
      vendorId: VENDOR_ID,
      productId: 0x300d,
      collections: [{ usagePage: 0xffb0, usage: 1 }],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: async () => undefined,
    };
    const t = new HidTransport(bare as unknown as HIDDevice);
    await t.open();
    expect(t.identity).toEqual({
      vendorId: VENDOR_ID,
      productId: 0x300d,
      productName: '',
      collections: [{ usagePage: 0xffb0, usage: 1, inputReports: [], outputReports: [] }],
    });
    await t.close();
  });

  it('computes inputReports and outputReports byte sizes from items (sum reportSize*reportCount / 8)', () => {
    const dev = {
      opened: false,
      vendorId: VENDOR_ID_AULA,
      productId: 0xf002,
      productName: 'AULA AG75',
      collections: [{
        usagePage: 0xffb0,
        usage: 1,
        inputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 64 }] }],
        outputReports: [{ reportId: 0, items: [{ reportSize: 8, reportCount: 32 }, { reportSize: 8, reportCount: 32 }] }],
      }],
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const t = new HidTransport(dev as unknown as HIDDevice);
    expect(t.identity).toEqual({
      vendorId: VENDOR_ID_AULA,
      productId: 0xf002,
      productName: 'AULA AG75',
      collections: [{ usagePage: 0xffb0, usage: 1, inputReports: [64], outputReports: [64] }],
    });
  });

  it('every concrete transport in src/protocol defines its own identity override (MI-a)', () => {
    const classes = [
      ['HidTransport', HidTransport],
      ['MockTransport', MockTransport],
      ['MockBootloader', MockBootloader],
      ['GenericMockTransport', GenericMockTransport],
    ] as const;
    for (const [name, Cls] of classes) {
      expect(Object.getOwnPropertyDescriptor(Cls.prototype, 'identity'), name).toBeDefined();
    }
  });

  it('HidTransport on 38A6:F002 keeps its real identity, undefined support, and boardAllowed=false after 0030000D 01 02 (MI-b)', async () => {
    const listeners: ((e: { data: DataView }) => void)[] = [];
    const dev = {
      opened: true,
      vendorId: VENDOR_ID_AULA,
      productId: 0xf002,
      productName: 'Fake 38A6',
      collections: [{ usagePage: 0xffb0, usage: 1 }],
      addEventListener: (_: string, cb: (e: { data: DataView }) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined,
      sendReport: async () => {
        const reply = new Uint8Array(64);
        // 01 02 reply reporting AE64 Max board 0030000D, run mode 0
        reply.set([
          0x01, 0x02, 0x01, 0x00, 0x00, 0x30, 0x00, 0x0d,
          0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
          0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
        ]);
        setTimeout(() => { for (const cb of [...listeners]) cb({ data: new DataView(reply.buffer) }); }, 0);
      },
      close: async () => undefined,
    };
    vi.stubGlobal('navigator', {
      hid: { addEventListener: () => undefined, removeEventListener: () => undefined },
    });
    const t = new HidTransport(dev as unknown as HIDDevice);
    await t.open();
    const info = await t.getDeviceInfo();
    expect(info.boardIdHex).toBe('0030000d');
    expect(info.runMode).toBe(0);
    expect(t.identity.vendorId).toBe(0x38a6);
    expect(t.support).toBeUndefined();
    expect(t.boardAllowed).toBe(false);
    await t.close();
  });
});

// ------------------------------------------------------------------ Name §7

describe('Public name table and genericDisplayName (§7)', () => {
  it('holds exactly the 3 public entries and resolves table hits case-insensitively', () => {
    expect(Object.keys(PUBLIC_BOARD_NAMES)).toHaveLength(3);
    const id = mkIdentity({ vendorId: VENDOR_ID, productId: 0xf001, productName: 'Raw Name' });
    expect(genericDisplayName(id, '00300002')).toBe('Everglide SU75 Pro');
    expect(genericDisplayName(id, '00300007')).toBe('Everglide SU75 Ultra');
    expect(genericDisplayName(id, '001B0010')).toBe('Wuque BABAO60 HE');
    expect(genericDisplayName(id, '001b0010')).toBe('Wuque BABAO60 HE');
  });

  it('sanitises raw productName (trim, printable only, <= 40 chars) and falls back to VID:PID', () => {
    expect(genericDisplayName(mkIdentity({ productName: 'Mock 60' }), '00f00001')).toBe('Mock 60');
    expect(genericDisplayName(mkIdentity({ vendorId: 0x1ca6, productId: 0xf001, productName: '' }), '00f00001', 'vi'))
      .toBe('Bàn phím 1CA6:F001');
    expect(genericDisplayName(mkIdentity({ vendorId: 0x1ca6, productId: 0xf001, productName: '' }), '00f00001', 'en'))
      .toBe('Keyboard 1CA6:F001');
    expect(genericDisplayName(createGenericMock('gmiss').identity, '00f00004', 'vi')).toBe('Bàn phím 1CA6:F004');

    // 41 characters -> capped at 40
    const long41 = 'A'.repeat(41);
    expect(genericDisplayName(mkIdentity({ productName: long41 }))).toBe('A'.repeat(40));

    // Unprintable characters stripped; only-unprintable falls back to VID:PID
    expect(genericDisplayName(mkIdentity({ productName: '  \x00Mock\x07\u202e 75\n\x7f  ' }))).toBe('Mock 75');
    expect(genericDisplayName(mkIdentity({ vendorId: 0x38a6, productId: 0x00ab, productName: '\x00\x01\x1f\x7f  ' }), null, 'vi'))
      .toBe('Bàn phím 38A6:00AB');

    // Spoofed AE64 board ID is NOT in the public name table -> never returns "AE64"
    expect(genericDisplayName(createGenericMock('gspoof').identity, '0030000d')).toBe('Mock Spoof');
  });
});

// ------------------------------------------------------------------ All 12 generic mocks (§15)

describe('12 generic mocks (§15)', () => {
  it('every mock supplies an identity and never presets support', () => {
    expect(GENERIC_MOCK_NAMES).toHaveLength(12);
    for (const name of GENERIC_MOCK_NAMES) {
      const m = createGenericMock(name, { latencyMs: 0 });
      expect(m.support, name).toBeUndefined();
      expect(m.boardAllowed, name).toBe(false);
      expect(isAe64(m.identity), name).toBe(false);
    }
  });

  it('gv3 replies 55 AA (fails replyMatches -> timeout); gsilent answers gates only; gmiss drops specific reads', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });

    const gv3 = createGenericMock('gv3', { latencyMs: 0 });
    const gv3Err = gv3.getDeviceInfo(20).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(25);
    expect(await gv3Err).toBe('TransportTimeoutError');

    const gsilent = createGenericMock('gsilent', { latencyMs: 0 });
    const pInfo = gsilent.getDeviceInfo();
    const pVer = gsilent.getProtocolVersion();
    await vi.advanceTimersByTimeAsync(5);
    expect((await pInfo).boardIdHex).toBe('00f00005');
    expect(await pVer).toMatchObject({ main: 1, sub: 3 });
    const featErr = gsilent.getFeatures().catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await featErr).toBe('TransportTimeoutError');

    const gmiss = createGenericMock('gmiss', { latencyMs: 0 });
    gmiss.setSupport('generic');
    const rtErr = gmiss.getRtPrecision().catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await rtErr).toBe('TransportTimeoutError');
    const row3Err = gmiss.getLayoutStyle(3).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await row3Err).toBe('TransportTimeoutError');
    const profErr = gmiss.getActiveProfile().catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await profErr).toBe('TransportTimeoutError');
    const light1Err = gmiss.getLightingBase(1).catch((e: Error) => e.name);
    await vi.advanceTimersByTimeAsync(1600);
    expect(await light1Err).toBe('TransportTimeoutError');
  });

  it('godd reports profile count 6 and 4.5 mm rangeMax; gtwin reports protocol 1.2 and distinct type/subType; gproto2 reports 2.0', async () => {
    const godd = createGenericMock('godd', { latencyMs: 0 });
    expect(await godd.getProfileCount()).toBe(6);
    expect((await godd.getPerformance({ row: 1, col: 0 })).axisRangeMax).toBe(4500);

    const gtwin = createGenericMock('gtwin', { latencyMs: 0 });
    expect(await gtwin.getProtocolVersion()).toMatchObject({ main: 1, sub: 2 });
    const twinInfo = await gtwin.getDeviceInfo();
    expect([twinInfo.type, twinInfo.subType]).toEqual([2, 3]);
    expect((await gtwin.getLightingAreas()).count).toBe(2);

    const gproto2 = createGenericMock('gproto2', { latencyMs: 0 });
    expect(await gproto2.getProtocolVersion()).toMatchObject({ main: 2, sub: 0 });
  });
});
