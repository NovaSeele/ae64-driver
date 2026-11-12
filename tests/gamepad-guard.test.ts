// The family-0x10 guard (safety.ts checkFrame + checkGamepadFrame, BaseTransport.request): AE64 Pro only, INFO first,
// WRITE / COMMIT only inside this connection's BEGIN, COMMIT only for a complete, valid block whose output the firmware offers.
import { describe, expect, it } from 'vitest';
import { createMockTransport, MockTransport, UnsafeCommandError, WriteNotAllowedError } from '../src/protocol';
import { replyMatches } from '../src/protocol/client';
import { checkFrame, checkGamepadFrame, isWriteCommand } from '../src/protocol/safety';
import type { GamepadGuard } from '../src/protocol/safety';
import {
  GP_CAP, GP_CMD, GP_CONFIG_BYTES, beginData, commitData, crc32, emptyConfig, encodeConfig, encodeFrame, readData, usbSetData, writeData,
} from '../src/protocol/gamepad';
import { MockGamepadFirmware } from '../src/protocol/mockGamepad';
import type { DemoSeed } from '../src/protocol/mock';

const TOKEN = [1, 2, 3, 4, 5, 6, 7, 8];
const OTHER = [8, 7, 6, 5, 4, 3, 2, 1];

/** A connected demo transport whose outgoing family-0x10 frames are recorded. */
async function open(seed: DemoSeed, opts: { info?: boolean } = {}) {
  const t = createMockTransport({ seed });
  const sent: number[][] = [];
  t.onPacketRaw((dir, bytes) => { if (dir === 'out' && bytes[0] === 0x10) sent.push(Array.from(bytes)); });
  if (opts.info !== false) await t.getDeviceInfo();
  return { t, sent };
}

/** BEGIN + all WRITEs of `block` (as the store does), returning the CRC. */
async function stage(t: MockTransport, block: Uint8Array, token = TOKEN): Promise<number> {
  const info = (await t.gamepadInfo())!;
  const crc = crc32(block);
  await t.gamepadBegin(info.revision, crc, token);
  for (let o = 0; o < GP_CONFIG_BYTES; o += 40) await t.gamepadWrite(token, o, Array.from(block.slice(o, o + 40)));
  return crc;
}

describe('family 0x10 is only sent to an AE64 Pro', () => {
  it('an AE64 Max never sends it, whatever is asked', async () => {
    const { t, sent } = await open('max');
    await expect(t.gamepadInfo()).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadRead(1, 0, 48)).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadUsbStatus()).rejects.toThrow(UnsafeCommandError);
    await expect(t.raw(encodeFrame(GP_CMD.INFO, 1))).rejects.toThrow(UnsafeCommandError);
    expect(sent).toEqual([]);
  });
  it('nothing is sent before 01 02 read the board, even to the gamepad firmware', async () => {
    const { t, sent } = await open('pro-xinput', { info: false });
    await expect(t.gamepadInfo()).rejects.toThrow(UnsafeCommandError);
    expect(sent).toEqual([]);
    await t.getDeviceInfo();
    expect(await t.gamepadInfo()).not.toBeNull();
    expect(sent.length).toBe(1);
  });
});

describe('stock Pro firmware only ever gets INFO', () => {
  it('INFO answers `10 FF`: null, not an error; every other command is refused before sending', async () => {
    const { t, sent } = await open('pro');
    expect(await t.gamepadInfo()).toBeNull();
    expect(sent.map((f) => f[1])).toEqual([GP_CMD.INFO]);
    const block = encodeConfig(emptyConfig());
    await expect(t.gamepadRead(1, 0, 48)).rejects.toThrow(/INFO confirmed/);
    await expect(t.gamepadBegin(1, crc32(block), TOKEN)).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadWrite(TOKEN, 0, [1])).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadCommit(TOKEN, 0, 1)).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadAbort(TOKEN)).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadUsbStatus()).rejects.toThrow(UnsafeCommandError);
    await expect(t.gamepadUsbSet(true, 1)).rejects.toThrow(UnsafeCommandError);
    expect(sent.map((f) => f[1])).toEqual([GP_CMD.INFO]);
  });
});

describe('gamepad firmware: INFO first, then the upload rules', () => {
  it('no READ, BEGIN, WRITE, COMMIT, ABORT or USB command before INFO', async () => {
    const { t, sent } = await open('pro-xinput');
    await expect(t.gamepadRead(1, 0, 48)).rejects.toThrow(/INFO confirmed/);
    await expect(t.gamepadBegin(1, 1, TOKEN)).rejects.toThrow(/INFO confirmed/);
    await expect(t.gamepadWrite(TOKEN, 0, [1])).rejects.toThrow(/INFO confirmed/);
    await expect(t.gamepadCommit(TOKEN, 1, 1)).rejects.toThrow(/INFO confirmed/);
    await expect(t.gamepadAbort(TOKEN)).rejects.toThrow(/INFO confirmed/);
    await expect(t.gamepadUsbSet(true, 1)).rejects.toThrow(/INFO confirmed/);
    expect(sent).toEqual([]);
  });
  it('WRITE and COMMIT need a BEGIN of this connection, with its token', async () => {
    const { t, sent } = await open('pro-xinput');
    const info = (await t.gamepadInfo())!;
    await expect(t.gamepadWrite(TOKEN, 0, [1])).rejects.toThrow(/without a BEGIN/);
    await expect(t.gamepadCommit(TOKEN, info.crc, info.revision)).rejects.toThrow(/without a BEGIN/);
    const block = encodeConfig(emptyConfig());
    await t.gamepadBegin(info.revision, crc32(block), TOKEN);
    await expect(t.gamepadWrite(OTHER, 0, [1])).rejects.toThrow(/token differs/);
    expect(sent.map((f) => f[1])).toEqual([GP_CMD.INFO, GP_CMD.BEGIN]);
  });
  it('COMMIT needs every byte written, the BEGIN CRC and revision, and bytes matching that CRC', async () => {
    const { t, sent } = await open('pro-xinput');
    const block = encodeConfig(emptyConfig());
    const info = (await t.gamepadInfo())!;
    const crc = crc32(block);
    await t.gamepadBegin(info.revision, crc, TOKEN);
    for (let o = 0; o < 200; o += 40) await t.gamepadWrite(TOKEN, o, Array.from(block.slice(o, o + 40)));
    await expect(t.gamepadCommit(TOKEN, crc, info.revision)).rejects.toThrow(/every byte/);
    await t.gamepadBegin(info.revision, crc, TOKEN); // the failed COMMIT ended the local upload
    for (let o = 0; o < GP_CONFIG_BYTES; o += 40) await t.gamepadWrite(TOKEN, o, Array.from(block.slice(o, o + 40)));
    await expect(t.gamepadCommit(TOKEN, crc ^ 1, info.revision)).rejects.toThrow(/CRC or revision/);
    await t.gamepadBegin(info.revision, crc, TOKEN);
    for (let o = 0; o < GP_CONFIG_BYTES; o += 40) await t.gamepadWrite(TOKEN, o, Array.from(block.slice(o, o + 40)));
    await expect(t.gamepadCommit(TOKEN, crc, info.revision + 1)).rejects.toThrow(/CRC or revision/);
    // Bytes that do not match the BEGIN CRC.
    await t.gamepadBegin(info.revision, crc, TOKEN);
    const other = Uint8Array.from(block);
    other[100] ^= 1;
    for (let o = 0; o < GP_CONFIG_BYTES; o += 40) await t.gamepadWrite(TOKEN, o, Array.from(other.slice(o, o + 40)));
    await expect(t.gamepadCommit(TOKEN, crc, info.revision)).rejects.toThrow(/BEGIN CRC/);
    expect(sent.some((f) => f[1] === GP_CMD.COMMIT)).toBe(false);
    expect(t.gamepadFirmware!.revision).toBe(info.revision);
  });
  it('COMMIT of a block that is not a valid AGC1 configuration is refused before sending', async () => {
    const { t, sent } = await open('pro-xinput');
    const bad = encodeConfig(emptyConfig());
    bad[0] = 0x58; // magic
    const crc = await stage(t, bad);
    await expect(t.gamepadCommit(TOKEN, crc, t.gamepadFirmware!.revision)).rejects.toThrow(/not a valid AGC1/);
    expect(sent.some((f) => f[1] === GP_CMD.COMMIT)).toBe(false);
  });
  it('COMMIT of an output the firmware does not offer is refused; mode off needs none', async () => {
    const { t, sent } = await open('pro-xinput');
    (t as unknown as { gamepadFirmware: MockGamepadFirmware }).gamepadFirmware = new MockGamepadFirmware({
      caps: GP_CAP.XINPUT | GP_CAP.PERSISTENT, block: encodeConfig(emptyConfig()), maxTravelUm: () => 3400,
    });
    const hid = encodeConfig({ ...emptyConfig(), transport: 'hid' });
    const crc = await stage(t, hid);
    await expect(t.gamepadCommit(TOKEN, crc, 1)).rejects.toThrow(/does not offer/);
    expect(sent.some((f) => f[1] === GP_CMD.COMMIT)).toBe(false);
    // The keyboard still holds that upload: a new BEGIN with another CRC conflicts until it is aborted.
    await expect(t.gamepadBegin(1, 123, TOKEN)).rejects.toThrow(/conflict/);
    await t.gamepadAbort(TOKEN);
    const off = encodeConfig({ ...emptyConfig(), transport: 'hid', mode: 'off' });
    const crcOff = await stage(t, off);
    expect(await t.gamepadCommit(TOKEN, crcOff, 1)).toEqual({ revision: 2, persistent: true });
  });
  it('a complete valid upload passes and is committed', async () => {
    const { t } = await open('pro-xinput');
    const block = encodeConfig({ ...emptyConfig(), mode: 'mixed' });
    const crc = await stage(t, block);
    expect(await t.gamepadCommit(TOKEN, crc, 1)).toEqual({ revision: 2, persistent: true });
    expect(Array.from(t.gamepadFirmware!.active)).toEqual(Array.from(block));
    // The upload ended: WRITE needs a new BEGIN.
    await expect(t.gamepadWrite(TOKEN, 0, [1])).rejects.toThrow(/without a BEGIN/);
  });
  it('USB commands need the USB switch capability', async () => {
    const { t, sent } = await open('pro-xinput');
    (t as unknown as { gamepadFirmware: MockGamepadFirmware }).gamepadFirmware = new MockGamepadFirmware({
      caps: GP_CAP.XINPUT, block: encodeConfig(emptyConfig()), maxTravelUm: () => 3400,
    });
    await t.gamepadInfo();
    await expect(t.gamepadUsbStatus()).rejects.toThrow(/USB switch/);
    await expect(t.gamepadUsbSet(true, 1)).rejects.toThrow(/USB switch/);
    expect(sent.map((f) => f[1])).toEqual([GP_CMD.INFO]);
  });
  it('a later INFO that is not the gamepad firmware closes the gate again', async () => {
    const { t } = await open('pro-xinput');
    await t.gamepadInfo();
    (t as unknown as { gamepadFirmware: null }).gamepadFirmware = null; // stock reply from now on
    expect(await t.gamepadInfo()).toBeNull();
    await expect(t.gamepadRead(1, 0, 48)).rejects.toThrow(/INFO confirmed/);
  });
  it('writes are refused while calibrating; reads still pass', async () => {
    const { t } = await open('pro-xinput');
    const info = (await t.gamepadInfo())!;
    await t.startCalibration();
    await expect(t.gamepadBegin(info.revision, 1, TOKEN)).rejects.toThrow(/calibrating/);
    expect((await t.gamepadRead(info.revision, 0, 4)).length).toBe(4);
    await t.stopCalibration();
  });
  it('a board outside the allow-list cannot write family 10', async () => {
    const { t } = await open('pro-xinput');
    await t.gamepadInfo();
    t.boardAllowed = false;
    await expect(t.gamepadBegin(1, 1, TOKEN)).rejects.toThrow(WriteNotAllowedError);
  });
});

describe('frame rules (safety.ts)', () => {
  const f = (cmd: number, data: number[] = []) => encodeFrame(cmd, 5, data);
  const why = (p: number[]) => { try { checkFrame(p); return null; } catch (e) { return (e as Error).message; } };
  it('accepts every well-formed command and classifies reads and writes', () => {
    const ok: [number[], boolean][] = [
      [f(GP_CMD.INFO), false],
      [f(GP_CMD.READ, readData(1, 160, 48)), false],
      [f(GP_CMD.USB_STATUS), false],
      [f(GP_CMD.BEGIN, beginData(1, 2, TOKEN)), true],
      [f(GP_CMD.WRITE, writeData(TOKEN, 168, new Array(40).fill(0))), true],
      [f(GP_CMD.WRITE, writeData(TOKEN, 207, [0])), true],
      [f(GP_CMD.COMMIT, commitData(TOKEN, 2, 1)), true],
      [f(GP_CMD.ABORT, TOKEN), true],
      [f(GP_CMD.USB_SET, usbSetData(true, 3)), true],
    ];
    for (const [p, write] of ok) {
      expect(why(p)).toBeNull();
      expect(isWriteCommand(p)).toBe(write);
    }
  });
  it.each([
    ['protocol 2', () => { const p = f(GP_CMD.INFO); p[2] = 2; return p; }],
    ['magic', () => { const p = f(GP_CMD.INFO); p[7] = 0x32; return p; }],
    ['status set', () => { const p = f(GP_CMD.INFO); p[8] = 1; return p; }],
    ['length byte vs payload', () => { const p = f(GP_CMD.INFO); p[9] = 1; return p; }],
    ['INFO with data', () => f(GP_CMD.INFO, [0])],
    ['USB_STATUS with data', () => f(GP_CMD.USB_STATUS, [0])],
    ['READ count 0', () => f(GP_CMD.READ, readData(1, 0, 0))],
    ['READ count 49', () => f(GP_CMD.READ, readData(1, 0, 49))],
    ['READ past the block', () => f(GP_CMD.READ, readData(1, 161, 48))],
    ['READ short', () => f(GP_CMD.READ, readData(1, 0, 48).slice(0, 6))],
    ['BEGIN length 207', () => { const d = beginData(1, 2, TOKEN); d[8] = 207; return f(GP_CMD.BEGIN, d); }],
    ['BEGIN zero token', () => f(GP_CMD.BEGIN, beginData(1, 2, new Array(8).fill(0)))],
    ['WRITE no data', () => f(GP_CMD.WRITE, writeData(TOKEN, 0, []))],
    ['WRITE past the block', () => f(GP_CMD.WRITE, writeData(TOKEN, 207, [0, 0]))],
    ['COMMIT 15 bytes', () => f(GP_CMD.COMMIT, commitData(TOKEN, 2, 1).slice(1))],
    ['ABORT 7 bytes', () => f(GP_CMD.ABORT, TOKEN.slice(1))],
    ['USB_SET Max board', () => { const d = usbSetData(true, 1); d[0] = 0x0d; return f(GP_CMD.USB_SET, d); }],
    ['USB_SET enabled 2', () => { const d = usbSetData(true, 1); d[4] = 2; return f(GP_CMD.USB_SET, d); }],
    ['USB_SET reserved', () => { const d = usbSetData(true, 1); d[5] = 1; return f(GP_CMD.USB_SET, d); }],
    ['unknown command 0x28', () => f(0x28)],
  ])('refuses %s', (_, build) => {
    expect(why(build())).not.toBeNull();
  });
  it('the read-only (diagnostics) path never takes a gamepad write', () => {
    expect(() => checkFrame(f(GP_CMD.INFO), { readOnly: true })).not.toThrow();
    expect(() => checkFrame(f(GP_CMD.BEGIN, beginData(1, 2, TOKEN)), { readOnly: true })).toThrow(/read-only/);
  });

  const guard = (g: Partial<GamepadGuard>): GamepadGuard => ({ boardIdHex: '0030000a', caps: 31, staging: null, ...g });
  it('checkGamepadFrame: board, INFO, USB capability', () => {
    expect(checkGamepadFrame(f(GP_CMD.INFO), guard({ boardIdHex: '0030000d' }))).toMatch(/AE64 Pro/);
    expect(checkGamepadFrame(f(GP_CMD.INFO), guard({ boardIdHex: undefined }))).toMatch(/not read/);
    expect(checkGamepadFrame(f(GP_CMD.INFO), guard({ boardIdHex: '0030000A', caps: null }))).toBeNull();
    expect(checkGamepadFrame(f(GP_CMD.READ, readData(1, 0, 1)), guard({ caps: null }))).toMatch(/INFO/);
    expect(checkGamepadFrame(f(GP_CMD.READ, readData(1, 0, 1)), guard({}))).toBeNull();
    expect(checkGamepadFrame(f(GP_CMD.ABORT, TOKEN), guard({}))).toBeNull();
    expect(checkGamepadFrame(f(GP_CMD.BEGIN, beginData(1, 2, TOKEN)), guard({}))).toBeNull();
    expect(checkGamepadFrame(f(GP_CMD.USB_STATUS), guard({ caps: 31 & ~GP_CAP.USB_SWITCH }))).toMatch(/USB/);
    expect(checkGamepadFrame(f(GP_CMD.USB_STATUS), guard({}))).toBeNull();
    expect(checkGamepadFrame([0x04, 0x01], guard({ boardIdHex: '0030000d' }))).toBeNull();
  });
});

describe('reply matching', () => {
  const req = encodeFrame(GP_CMD.INFO, 9);
  it('accepts the stock 10 FF and the AGP1 echo; nothing else', () => {
    expect(replyMatches(req, [0x10, 0xff, 0, 0])).toBe(true);
    expect(replyMatches(req, [...req.slice(0, 8), 0, 0])).toBe(true);
    expect(replyMatches(req, [0x10, 0x20, 1, 8, 0x41, 0x47, 0x50, 0x31])).toBe(false);
    expect(replyMatches(req, [0x04, 0x01])).toBe(false);
    expect(replyMatches([0x04, 0x01, 1, 2], [0x04, 0x01, 1, 2])).toBe(true);
  });
});

describe('WebHID path', () => {
  async function hid(answer: (frame: Uint8Array) => number[][]) {
    const { HidTransport } = await import('../src/protocol');
    const listeners: ((e: { data: DataView }) => void)[] = [];
    const sent: Uint8Array[] = [];
    const proInfo = [0x01, 0x02, 0x01, 0x00, 0x00, 0x30, 0x00, 0x0a, 0x00, 0x01, 0x00, 0x00];
    const dev = {
      opened: true, productName: 'fake', vendorId: 0x1ca6, productId: 0x300a,
      collections: [{ usagePage: 0xffb0, usage: 1 }],
      addEventListener: (_: string, cb: (e: { data: DataView }) => void) => listeners.push(cb),
      removeEventListener: () => undefined,
      sendReport: async (_id: number, f: Uint8Array) => {
        sent.push(f);
        const replies = f[0] === 0x01 && f[1] === 0x02 ? [proInfo] : answer(f);
        setTimeout(() => {
          for (const bytes of replies) {
            const a = new Uint8Array(64);
            a.set(bytes);
            for (const cb of listeners) cb({ data: new DataView(a.buffer) });
          }
        }, 1);
      },
      close: async () => undefined,
    };
    (globalThis.navigator as unknown as { hid: unknown }).hid = { addEventListener() {}, removeEventListener() {} };
    const t = new HidTransport(dev as unknown as HIDDevice);
    await t.open();
    await t.getDeviceInfo();
    return { t, sent };
  }

  it('a stock `10 FF` answers INFO at once (no timeout): no gamepad firmware', async () => {
    const { t, sent } = await hid(() => [[0x10, 0xff]]);
    const t0 = Date.now();
    expect(await t.gamepadInfo()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(sent.filter((f) => f[0] === 0x10).length).toBe(1);
  });
  it('a reply with another sequence is ignored; the matching one is used', async () => {
    const info = [0x0a, 0, 0x30, 0, 31, 24, 1, 0, 3, 0, 0, 0, 0x10, 0x27, 208, 0, 1, 2, 3, 4];
    const { t } = await hid((f) => {
      const echo = Array.from(f.slice(0, 8));
      const stale = [...echo];
      stale[3] = (stale[3] + 1) & 255;
      return [[...stale, 0, 20, ...info.map(() => 0)], [...echo, 0, 20, ...info]];
    });
    expect(await t.gamepadInfo()).toMatchObject({ revision: 3, crc: 0x04030201 });
  });
});
