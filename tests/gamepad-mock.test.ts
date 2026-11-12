// The demo's emulation of the XInput gamepad firmware (mockGamepad.ts + MockTransport seed 'pro-xinput'):
// every AGP1 status, token staging, the 5 s expiry, revisions, the Xbox USB switch and the virtual Gamepad API pad.
import { describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createMockTransport } from '../src/protocol';
import {
  GP_CAP, GP_CMD, GP_CONFIG_BYTES, GP_STATUS, abortData, beginData, commitData, crc32, decodeConfig, decodeInfo, emptyConfig,
  encodeConfig, encodeFrame, readData, usbSetData, writeData,
} from '../src/protocol/gamepad';
import { MockGamepadFirmware, USB_SWITCH_MS, firmwareAccepts } from '../src/protocol/mockGamepad';
import { PHYSICAL_KEYS } from '../src/protocol/layout';
import { useDeviceStore } from '../src/stores/device';

const TOKEN = [9, 8, 7, 6, 5, 4, 3, 2];
const frame = (cmd: number, data: number[] = [], seq = 1): number[] => {
  const p = encodeFrame(cmd, seq, data);
  return [...p, ...new Array(64 - p.length).fill(0)];
};

function firmware(o: { caps?: number; maxUm?: number } = {}) {
  let now = 1000;
  const fw = new MockGamepadFirmware({ block: encodeConfig(emptyConfig()), maxTravelUm: () => o.maxUm ?? 3400, caps: o.caps, now: () => now });
  const send = (cmd: number, data: number[] = []) => fw.handle(frame(cmd, data))!;
  const status = (cmd: number, data: number[] = []) => send(cmd, data)[8];
  return { fw, send, status, tick: (ms: number) => { now += ms; } };
}

/** BEGIN + every WRITE of `block`; returns its CRC. */
function upload(f: ReturnType<typeof firmware>, block: Uint8Array, token = TOKEN, crc = crc32(block)): number {
  expect(f.status(GP_CMD.BEGIN, beginData(f.fw.revision, crc, token))).toBe(GP_STATUS.OK);
  for (let o = 0; o < GP_CONFIG_BYTES; o += 40) expect(f.status(GP_CMD.WRITE, writeData(token, o, Array.from(block.slice(o, o + 40))))).toBe(GP_STATUS.OK);
  return crc;
}

describe('MockGamepadFirmware', () => {
  it('INFO reports the board, capabilities, revision, limits and the active CRC', () => {
    const f = firmware();
    const r = f.send(GP_CMD.INFO);
    expect(r.slice(0, 10)).toEqual([...frame(GP_CMD.INFO).slice(0, 8), 0, 20]);
    expect(decodeInfo(r.slice(10, 30))).toMatchObject({ caps: 30, revision: 1, maxTravelUm: 10000, crc: crc32(f.fw.active) });
  });
  it('by default it is firmware v0.8.1: no HID output, so a HID block is refused with backend unavailable', () => {
    const f = firmware();
    expect(f.fw.caps).toBe(GP_CAP.XINPUT | GP_CAP.PERSISTENT | GP_CAP.USB_SWITCH | GP_CAP.USB_PERSISTENT);
    const crc = upload(f, encodeConfig({ ...emptyConfig(), transport: 'hid' }));
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.BACKEND);
    expect(f.status(GP_CMD.ABORT, abortData(TOKEN))).toBe(GP_STATUS.OK);
    const off = upload(f, encodeConfig({ ...emptyConfig(), transport: 'hid', mode: 'off' }));
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, off, 1))).toBe(GP_STATUS.OK); // mode off needs no output
  });
  it('a full upload commits with revision + 1 and the persistent flag; READ returns the new block', () => {
    const f = firmware();
    const block = encodeConfig({ ...emptyConfig(), mode: 'mixed' });
    const crc = upload(f, block);
    const r = f.send(GP_CMD.COMMIT, commitData(TOKEN, crc, 1));
    expect(r[8]).toBe(GP_STATUS.OK);
    expect(r.slice(9, 15)).toEqual([5, 2, 0, 0, 0, 1]);
    expect(f.fw.revision).toBe(2);
    const read = f.send(GP_CMD.READ, readData(2, 48, 48));
    expect(read[9]).toBe(54);
    expect(read.slice(16, 64)).toEqual(Array.from(block.slice(48, 96)));
  });
  it('persistent flag 0 without the persistent capability', () => {
    const f = firmware({ caps: GP_CAP.XINPUT | GP_CAP.HID });
    const crc = upload(f, encodeConfig(emptyConfig()));
    expect(f.send(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))[14]).toBe(0);
  });
  it('another token is refused (WRITE, COMMIT, ABORT) while an upload is staged', () => {
    const f = firmware();
    const block = encodeConfig(emptyConfig());
    const crc = upload(f, block);
    const other = [1, 1, 1, 1, 1, 1, 1, 1];
    expect(f.status(GP_CMD.WRITE, writeData(other, 0, [0x41]))).toBe(GP_STATUS.CONFLICT);
    expect(f.status(GP_CMD.COMMIT, commitData(other, crc, 1))).toBe(GP_STATUS.CONFLICT);
    expect(f.status(GP_CMD.ABORT, abortData(other))).toBe(GP_STATUS.CONFLICT);
    expect(f.status(GP_CMD.BEGIN, beginData(1, crc, other))).toBe(GP_STATUS.CONFLICT);
    expect(f.fw.staged).toBe(true);
    expect(f.status(GP_CMD.ABORT, abortData(TOKEN))).toBe(GP_STATUS.OK);
    expect(f.fw.staged).toBe(false);
    expect(f.status(GP_CMD.ABORT, abortData(other))).toBe(GP_STATUS.OK); // nothing staged: any token
  });
  it('BEGIN again with the same token, CRC and revision is accepted and keeps the bytes', () => {
    const f = firmware();
    const block = encodeConfig(emptyConfig());
    const crc = upload(f, block);
    expect(f.status(GP_CMD.BEGIN, beginData(1, crc, TOKEN))).toBe(GP_STATUS.OK);
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.OK);
  });
  it('an upload idle for more than 5 s expires; at exactly 5 s it is still alive', () => {
    const f = firmware();
    const block = encodeConfig(emptyConfig());
    const crc = upload(f, block);
    f.tick(5000);
    expect(f.status(GP_CMD.WRITE, writeData(TOKEN, 0, [block[0]]))).toBe(GP_STATUS.OK); // refreshes the activity time
    f.tick(5001);
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.CONFLICT);
    expect(f.fw.staged).toBe(false);
    expect(f.status(GP_CMD.WRITE, writeData(TOKEN, 0, [block[0]]))).toBe(GP_STATUS.CONFLICT);
  });
  it('a stale revision conflicts (READ, BEGIN, COMMIT)', () => {
    const f = firmware();
    expect(f.status(GP_CMD.READ, readData(2, 0, 48))).toBe(GP_STATUS.CONFLICT);
    expect(f.status(GP_CMD.BEGIN, beginData(0, 1, TOKEN))).toBe(GP_STATUS.CONFLICT);
    const crc = upload(f, encodeConfig(emptyConfig()));
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 2))).toBe(GP_STATUS.CONFLICT);
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc ^ 1, 1))).toBe(GP_STATUS.CONFLICT);
  });
  it('COMMIT before every byte arrived: incomplete', () => {
    const f = firmware();
    const block = encodeConfig(emptyConfig());
    expect(f.status(GP_CMD.BEGIN, beginData(1, crc32(block), TOKEN))).toBe(GP_STATUS.OK);
    for (let o = 0; o < 200; o += 40) f.status(GP_CMD.WRITE, writeData(TOKEN, o, Array.from(block.slice(o, o + 40))));
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc32(block), 1))).toBe(GP_STATUS.INCOMPLETE);
  });
  it('bytes that do not match the BEGIN CRC: CRC error', () => {
    const f = firmware();
    const block = encodeConfig(emptyConfig());
    const crc = upload(f, block, TOKEN, crc32(block) ^ 0x10);
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.CRC);
    expect(f.fw.revision).toBe(1);
  });
  it('a block beyond a key’s calibrated travel: invalid configuration', () => {
    const f = firmware({ maxUm: 3000 });
    const cfg = emptyConfig();
    cfg.bindings[0] = { ...cfg.bindings[0], key: 15, endUm: 3100, declaredUm: 4000 };
    const crc = upload(f, encodeConfig(cfg));
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.CONFIG);
  });
  it('an output the firmware does not offer: backend unavailable', () => {
    const f = firmware({ caps: GP_CAP.XINPUT | GP_CAP.PERSISTENT });
    const crc = upload(f, encodeConfig({ ...emptyConfig(), transport: 'hid' }));
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.BACKEND);
  });
  it('a failed install: storage failure, nothing changes', () => {
    const f = firmware();
    const before = Array.from(f.fw.active);
    const crc = upload(f, encodeConfig({ ...emptyConfig(), mode: 'off' }));
    f.fw.failInstall = true;
    expect(f.status(GP_CMD.COMMIT, commitData(TOKEN, crc, 1))).toBe(GP_STATUS.STORAGE);
    expect(Array.from(f.fw.active)).toEqual(before);
    expect(f.fw.revision).toBe(1);
  });
  it('malformed frames: format error, no data', () => {
    const f = firmware();
    const v2 = frame(GP_CMD.INFO);
    v2[2] = 2;
    expect(f.fw.handle(v2)![8]).toBe(GP_STATUS.FORMAT);
    const st = frame(GP_CMD.INFO);
    st[8] = 1;
    expect(f.fw.handle(st)![8]).toBe(GP_STATUS.FORMAT);
    const long = frame(GP_CMD.INFO);
    long[9] = 55;
    expect(f.fw.handle(long)![8]).toBe(GP_STATUS.FORMAT);
    const r = f.send(GP_CMD.INFO, [0]);
    expect([r[8], r[9], r.slice(10).some((b) => b)]).toEqual([GP_STATUS.FORMAT, 0, false]);
    expect(f.status(GP_CMD.READ, readData(1, 161, 48))).toBe(GP_STATUS.FORMAT);
    expect(f.status(GP_CMD.BEGIN, beginData(1, 1, new Array(8).fill(0)))).toBe(GP_STATUS.FORMAT);
    expect(f.status(GP_CMD.WRITE, writeData(TOKEN, 0, [1]))).toBe(GP_STATUS.CONFLICT); // nothing staged is checked first
  });
  it('frames outside AGP1 are left to the stock dispatcher', () => {
    const f = firmware();
    const magic = frame(GP_CMD.INFO);
    magic[4] = 0;
    expect(f.fw.handle(magic)).toBeNull();
    expect(f.fw.handle(frame(0x28))).toBeNull();
    expect(f.fw.handle(frame(0x2f))).toBeNull();
    expect(f.fw.handle(frame(0x1f))).toBeNull();
    expect(f.fw.handle(frame(0x36))).toBeNull();
    expect(f.fw.handle([0x04, 0x01])).toBeNull();
    const usbNoMagic = frame(GP_CMD.USB_STATUS);
    usbNoMagic[7] = 0;
    expect(f.fw.handle(usbNoMagic)).toBeNull();
  });
  it("0x30–0x35 belong to the firmware's separate FNR1 protocol: answered with its magic, never by AGP1 or stock", () => {
    const f = firmware();
    const r = f.send(0x30, [0, 0]);
    expect(r.slice(0, 10)).toEqual([0x10, 0x30, 1, 1, 0x46, 0x4e, 0x52, 0x31, GP_STATUS.FORMAT, 0]); // AGP1 magic: format error
    const fnr = frame(0x35);
    fnr.splice(4, 4, 0x46, 0x4e, 0x52, 0x31);
    expect(f.fw.handle(fnr)![8]).toBe(GP_STATUS.UNSUPPORTED); // not emulated
  });
  it('firmwareAccepts: duplicate keys and a bound key without a calibrated stroke', () => {
    const cfg = emptyConfig();
    cfg.bindings[10].key = 5;
    expect(firmwareAccepts(encodeConfig(cfg), () => 3400)).toBe(true);
    expect(firmwareAccepts(encodeConfig(cfg), () => 0)).toBe(false); // a button needs a calibrated key too
    const block = encodeConfig(cfg);
    block[16 + 11 * 8] = 5; // B on the same key
    expect(firmwareAccepts(block, () => 3400)).toBe(false);
  });

  describe('Xbox USB switch', () => {
    it('status, a no-op set, a queued change that completes, and its conflicts', () => {
      const f = firmware();
      const st = () => f.send(GP_CMD.USB_STATUS).slice(10, 22);
      expect(st()).toEqual([0x0a, 0, 0x30, 0, 1, 1, 1, 0, 1, 0, 0, 0]);
      expect(f.send(GP_CMD.USB_SET, usbSetData(true, 1)).slice(10, 22)).toEqual([0x0a, 0, 0x30, 0, 1, 1, 1, 0, 1, 0, 0, 0]);
      expect(f.status(GP_CMD.USB_SET, usbSetData(false, 0))).toBe(GP_STATUS.CONFLICT);
      expect(f.send(GP_CMD.USB_SET, usbSetData(false, 1)).slice(10, 22)).toEqual([0x0a, 0, 0x30, 0, 1, 1, 0, 1, 2, 0, 0, 0]);
      expect(f.status(GP_CMD.USB_SET, usbSetData(true, 2))).toBe(GP_STATUS.CONFLICT); // still pending
      f.tick(USB_SWITCH_MS);
      expect(st()).toEqual([0x0a, 0, 0x30, 0, 1, 0, 0, 0, 2, 0, 0, 0]);
      const bad = usbSetData(true, 2);
      bad[0] = 0x0d;
      expect(f.status(GP_CMD.USB_SET, bad)).toBe(GP_STATUS.FORMAT);
      expect(f.status(GP_CMD.USB_SET, [...usbSetData(true, 2), 0])).toBe(GP_STATUS.FORMAT); // USB_SET carries exactly 10 bytes
      expect(f.status(GP_CMD.USB_STATUS, [0])).toBe(GP_STATUS.FORMAT);
    });
    it('while a switch is pending, every 0x21–0x35 command conflicts whatever it holds; INFO and USB_STATUS still answer', () => {
      const f = firmware();
      expect(f.send(GP_CMD.USB_SET, usbSetData(false, 1))[17]).toBe(1);
      for (const cmd of [0x21, 0x22, 0x23, 0x24, 0x25, 0x28, 0x2f, 0x30, 0x35]) {
        const r = f.send(cmd, cmd === GP_CMD.READ ? readData(1, 0, 48) : [1, 2, 3]);
        expect([cmd, r[8], r[9]]).toEqual([cmd, GP_STATUS.CONFLICT, 0]);
        expect(r.slice(0, 8)).toEqual(frame(cmd, [1]).slice(0, 8));
      }
      const noMagic = frame(GP_CMD.READ, readData(1, 0, 48));
      noMagic[4] = 0;
      expect(f.fw.handle(noMagic)![8]).toBe(GP_STATUS.CONFLICT); // checked before the magic
      expect(f.status(GP_CMD.USB_SET, usbSetData(true, 2))).toBe(GP_STATUS.CONFLICT);
      expect(f.status(GP_CMD.INFO)).toBe(GP_STATUS.OK);
      expect(f.send(GP_CMD.USB_STATUS).slice(15, 18)).toEqual([1, 0, 1]);
      expect(f.fw.handle(frame(0x1f))).toBeNull();
      f.tick(USB_SWITCH_MS);
      expect(f.status(GP_CMD.READ, readData(1, 0, 48))).toBe(GP_STATUS.OK);
    });
    it('a staged upload blocks the switch until it is aborted or expires', () => {
      const f = firmware();
      upload(f, encodeConfig(emptyConfig()));
      expect(f.status(GP_CMD.USB_SET, usbSetData(false, 1))).toBe(GP_STATUS.CONFLICT);
      f.tick(5001);
      expect(f.send(GP_CMD.USB_SET, usbSetData(false, 1))[17]).toBe(1);
    });
    it('no USB switch capability: unsupported', () => {
      const f = firmware({ caps: GP_CAP.XINPUT });
      expect(f.status(GP_CMD.USB_STATUS)).toBe(GP_STATUS.UNSUPPORTED);
      expect(f.status(GP_CMD.USB_SET, usbSetData(true, 1))).toBe(GP_STATUS.UNSUPPORTED);
    });
  });
});

describe('MockTransport seeds', () => {
  it('stock seeds answer family 0x10 with 10 FF; pro-xinput runs the gamepad firmware with the demo mapping', async () => {
    const pro = createMockTransport({ seed: 'pro' });
    await pro.getDeviceInfo();
    expect(await pro.gamepadInfo()).toBeNull();
    expect(pro.gamepadFirmware).toBeNull();
    const t = createMockTransport({ seed: 'pro-xinput' });
    expect((await t.getDeviceInfo()).boardIdHex).toBe('0030000a');
    const info = (await t.gamepadInfo())!;
    expect(info).toMatchObject({ revision: 1, caps: 30, transports: { hid: false, xinput: true }, usbSwitch: true });
    const bytes: number[] = [];
    for (let o = 0; o < GP_CONFIG_BYTES; o += 48) bytes.push(...(await t.gamepadRead(1, o, Math.min(48, GP_CONFIG_BYTES - o))));
    expect(crc32(bytes)).toBe(info.crc);
    const cfg = decodeConfig(bytes);
    const name = (k: number | null) => (k === null ? null : PHYSICAL_KEYS[k].name);
    expect(cfg.bindings.slice(0, 6).map((b) => name(b.key))).toEqual(['Q', 'E', 'A', 'D', 'S', 'W']);
    expect(cfg.bindings.slice(10, 14).map((b) => name(b.key))).toEqual(['Space', 'Shift', 'R', 'F']);
    expect(cfg.bindings[2]).toMatchObject({ startUm: 500, endUm: 3400, declaredUm: 3400 });
  });
  it('a lost COMMIT reply still commits on the keyboard (the hook simulates the timeout)', async () => {
    const t = createMockTransport({ seed: 'pro-xinput' });
    await t.getDeviceInfo();
    await t.gamepadInfo();
    const block = encodeConfig({ ...emptyConfig(), mode: 'off' });
    const crc = crc32(block);
    await t.gamepadBegin(1, crc, TOKEN);
    for (let o = 0; o < GP_CONFIG_BYTES; o += 40) await t.gamepadWrite(TOKEN, o, Array.from(block.slice(o, o + 40)));
    t.dropGamepadReply = (cmd) => cmd === GP_CMD.COMMIT;
    await expect(t.gamepadCommit(TOKEN, crc, 1)).rejects.toThrow(/23/);
    expect(t.gamepadFirmware!.revision).toBe(2);
    expect(t.dropGamepadReply).toBeNull();
  });
  it('the virtual gamepad follows the simulated keys, and disappears when the mode is off or the Xbox device is hidden', async () => {
    const t = createMockTransport({ seed: 'pro-xinput' });
    const id = (n: string) => PHYSICAL_KEYS.find((k) => k.name === n)!.id;
    expect(t.virtualGamepad()).toMatchObject({ connected: true, mapping: 'standard', axes: [0, 0, 0, 0] });
    t.simulatePress(id('W'), 3.4);
    t.simulatePress(id('Space'), 3.4);
    t.simulatePress(id('Q'), 1.95);
    const pad = t.virtualGamepad()!;
    expect(pad.axes[1]).toBe(-1); // up is negative in the Gamepad API
    expect(pad.buttons[0]).toEqual({ pressed: true, touched: true, value: 1 });
    expect(pad.buttons[6].value).toBeCloseTo(0.498, 2); // LT halfway between 0.5 and 3.4 mm
    expect(pad.buttons.length).toBe(17);
    const fw = t.gamepadFirmware!;
    fw.usb.enabled = false;
    expect(t.virtualGamepad()).toBeNull();
    fw.usb.enabled = true;
    fw.active = encodeConfig({ ...emptyConfig(), mode: 'off' });
    expect(t.virtualGamepad()).toBeNull();
    expect(createMockTransport({ seed: 'pro' }).virtualGamepad()).toBeNull();
  });
  it('useGamepadHandler puts another firmware model behind the demo keyboard (64-byte frames in, null = stock)', async () => {
    const t = createMockTransport({ seed: 'pro-xinput' });
    await t.getDeviceInfo();
    const seen: Uint8Array[] = [];
    t.useGamepadHandler((req) => { seen.push(req); return null; });
    expect(await t.gamepadInfo()).toBeNull();
    expect(seen.length).toBe(1);
    expect(seen[0]).toBeInstanceOf(Uint8Array);
    expect(seen[0].length).toBe(64);
    expect(Array.from(seen[0].slice(0, 10))).toEqual([0x10, GP_CMD.INFO, 1, seen[0][3], 0x41, 0x47, 0x50, 0x31, 0, 0]);
    const fw = t.gamepadFirmware!;
    t.useGamepadHandler((req) => Uint8Array.from(fw.handle(req)!));
    expect(await t.gamepadInfo()).toMatchObject({ revision: 1, caps: 30 });
    t.useGamepadHandler(null);
    expect(await t.gamepadInfo()).toMatchObject({ revision: 1 });
  });
  it('connectDemo("pro-xinput") opens the demo as an AE64 Pro and remembers the seed', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('pro-xinput');
    expect(device.model).toBe('pro');
    expect(device.demoSeed).toBe('pro-xinput');
    expect(await device.withTransport((t) => t.gamepadInfo())).not.toBeNull();
    await device.switchDemoModel('pro');
    expect(device.demoSeed).toBe('pro');
    expect(await device.withTransport((t) => t.gamepadInfo())).toBeNull();
    await device.disconnect();
    expect(device.demoSeed).toBeNull();
    await device.connectDemo();
    expect(device.demoSeed).toBe('pro');
    await device.switchDemoModel('pro-xinput');
    await device.disconnect();
    await device.connectDemo();
    expect(device.demoSeed).toBe('pro-xinput');
    await device.disconnect();
  });
});
