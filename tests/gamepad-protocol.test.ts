// AGP1 frames and the AGC1 block (src/protocol/gamepad.ts). The byte vectors were produced by an independent encoder
// (the reference driver's, run outside the repo) for the same configuration; the CRC values were checked with Node's zlib.crc32.
import { describe, expect, it } from 'vitest';
import {
  GP_CONTROLS, GP_DEADZONE_MAX, agp1ReplyMatches, beginData, checkTravelLimits, cloneConfig, commitData, crc32, decodeCommitReply,
  decodeConfig, decodeInfo, decodeReadReply, decodeReply, decodeUsbState, defaultBinding, emptyConfig, encodeConfig, encodeFrame,
  evaluate, level, readData, usbSetAccepted, usbSetData, validateConfig, writeData, abortData, GamepadConfigError,
  encodeFrame64, keyIndexOf, keyPosOf, normalizeTravel, toFirmwareReport,
} from '../src/protocol/gamepad';
import type { GamepadConfig, GpBinding } from '../src/protocol/gamepad';
import { PHYSICAL_KEYS } from '../src/protocol/layout';

const hex = (b: ArrayLike<number>): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const unhex = (s: string): Uint8Array => Uint8Array.from(s.match(/../g)!.map((h) => parseInt(h, 16)));

const REF_BLOCK =
  '41474331010201050200d204000018000f01c800b80bac0dff00f401ac0da00f1d00f401ac0da00fff00f401ac0da00fff00f401ac0da00f10000a00140014'
  + '00ff00f401ac0da00fff00f401ac0da00fff00f401ac0da00f3f010000102710273a00f401ac0da00fff00f401ac0da00fff00f401ac0da00fff00f401ac0d'
  + 'a00fff00f401ac0da00fff00f401ac0da00fff00f401ac0da00fff00f401ac0da00fff00f401ac0da00fff00f401ac0da00fff00f401ac0da00fff00f401ac'
  + '0da00fff00f401ac0da00f0000d2042909800d';
const REF_CRC = 0x9d258a92;

/** The configuration REF_BLOCK encodes. */
function refConfig(): GamepadConfig {
  const cfg = emptyConfig();
  cfg.mode = 'mixed';
  cfg.transport = 'hid';
  cfg.sticks = [{ opposition: 'deeper', circular: true, deadzone: 1234 }, { opposition: 'neutral', circular: false, deadzone: 0 }];
  const set = (id: string, b: Partial<GpBinding>) => Object.assign(cfg.bindings[GP_CONTROLS.findIndex((c) => c.id === id)], b);
  set('LT', { key: 15, curve: 'smooth', startUm: 200, endUm: 3000, declaredUm: 3500 });
  set('LX-', { key: 29, curve: 'linear', startUm: 500, endUm: 3500, declaredUm: 4000 });
  set('LY+', { key: 16, curve: 'linear', startUm: 10, endUm: 20, declaredUm: 20 });
  set('RY+', { key: 63, curve: 'smooth', startUm: 0, endUm: 10000, declaredUm: 10000 });
  set('A', { key: 58, curve: 'linear', startUm: 500, endUm: 3500, declaredUm: 4000 });
  set('DPAD_RIGHT', { key: 0, curve: 'linear', startUm: 1234, endUm: 2345, declaredUm: 3456 });
  return cfg;
}

describe('64-byte frame', () => {
  it('encodeFrame64 is encodeFrame zero-padded to the report size', () => {
    const f = encodeFrame64(0x25, 7, readData(1, 0, 48));
    expect(f).toBeInstanceOf(Uint8Array);
    expect(f.length).toBe(64);
    expect(hex(f)).toBe(hex([...encodeFrame(0x25, 7, readData(1, 0, 48)), ...new Array(47).fill(0)]));
    expect(() => encodeFrame64(0x22, 1, new Array(55).fill(0))).toThrow(RangeError);
  });
});

describe('CRC-32', () => {
  it('has the standard check value and matches zlib', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    const data = Uint8Array.from({ length: 208 }, (_, i) => (i * 37 + 11) & 255);
    expect(crc32(data)).toBe(0x8e7dd51b); // zlib.crc32 of the same bytes
    expect(crc32([])).toBe(0);
  });
});

describe('AGC1 block', () => {
  it('encodes byte for byte like the independent encoder, with the known CRC', () => {
    const bytes = encodeConfig(refConfig());
    expect(bytes.length).toBe(208);
    expect(hex(bytes)).toBe(REF_BLOCK);
    expect(crc32(bytes)).toBe(REF_CRC);
  });
  it('decodes the vector back to the same configuration', () => {
    expect(decodeConfig(unhex(REF_BLOCK))).toEqual(refConfig());
  });
  it('round-trips the empty configuration', () => {
    expect(decodeConfig(encodeConfig(emptyConfig()))).toEqual(emptyConfig());
  });
  it('refuses to encode an invalid configuration', () => {
    const cfg = refConfig();
    cfg.bindings[0].endUm = cfg.bindings[0].declaredUm + 1;
    expect(() => encodeConfig(cfg)).toThrow(GamepadConfigError);
  });

  const corrupt = (at: number, value: number) => { const b = unhex(REF_BLOCK); b[at] = value; return b; };
  it.each([
    ['magic', 0, 0x42],
    ['version', 4, 2],
    ['mode 3', 5, 3],
    ['transport 0', 6, 0],
    ['transport 3', 6, 3],
    ['stick flag bit 3', 7, 8 | 1],
    ['opposition 3', 8, 6],
    ['reserved byte 9', 9, 1],
    ['binding count', 14, 23],
    ['key 64', 16, 64],
    ['curve 2', 17, 2],
  ])('decode rejects %s', (_, at, value) => {
    expect(() => decodeConfig(corrupt(at, value))).toThrow(GamepadConfigError);
  });
  it('decode accepts key 255 (unassigned) and rejects a block of another length', () => {
    expect(decodeConfig(corrupt(16, 255)).bindings[0].key).toBeNull();
    expect(() => decodeConfig(unhex(REF_BLOCK).slice(0, 207))).toThrow(GamepadConfigError);
  });
  it('decode applies the value rules too (dead zone 9500, square with a dead zone)', () => {
    const b = unhex(REF_BLOCK);
    b[10] = 9500 & 255; b[11] = 9500 >> 8;
    expect(() => decodeConfig(b)).toThrow(GamepadConfigError);
    const s = unhex(REF_BLOCK);
    s[12] = 1; // stick 1 is square
    expect(() => decodeConfig(s)).toThrow(GamepadConfigError);
  });
});

describe('validateConfig boundaries', () => {
  const codes = (cfg: GamepadConfig) => validateConfig(cfg).map((i) => i.code);
  const withBinding = (b: Partial<GpBinding>, index = 0) => { const c = emptyConfig(); Object.assign(c.bindings[index], b); return c; };

  it('the reference and empty configurations are valid', () => {
    expect(validateConfig(refConfig())).toEqual([]);
    expect(validateConfig(emptyConfig())).toEqual([]);
  });
  it('declared travel 10–10000', () => {
    expect(codes(withBinding({ startUm: 0, endUm: 9, declaredUm: 9 }))).toEqual(['declared']);
    expect(codes(withBinding({ startUm: 0, endUm: 10, declaredUm: 10 }))).toEqual([]);
    expect(codes(withBinding({ startUm: 0, endUm: 10000, declaredUm: 10000 }))).toEqual([]);
    expect(codes(withBinding({ startUm: 0, endUm: 10000, declaredUm: 10001 }))).toEqual(['declared']);
    expect(codes(withBinding({ declaredUm: 4000.5 }))).toEqual(['declared']);
  });
  it('0 ≤ start < end ≤ declared', () => {
    expect(codes(withBinding({ startUm: 0, endUm: 1, declaredUm: 10 }))).toEqual([]);
    expect(codes(withBinding({ startUm: -1, endUm: 1, declaredUm: 10 }))).toEqual(['range']);
    expect(codes(withBinding({ startUm: 5, endUm: 5, declaredUm: 10 }))).toEqual(['range']);
    expect(codes(withBinding({ startUm: 6, endUm: 5, declaredUm: 10 }))).toEqual(['range']);
    expect(codes(withBinding({ startUm: 0, endUm: 10, declaredUm: 10 }))).toEqual([]);
    expect(codes(withBinding({ startUm: 0, endUm: 11, declaredUm: 10 }))).toEqual(['range']);
    expect(codes(withBinding({ startUm: 0.5, endUm: 11, declaredUm: 100 }))).toEqual(['range']);
  });
  it('unassigned records are checked as well (the firmware checks all 24)', () => {
    expect(codes(withBinding({ key: null, startUm: 3000, endUm: 2000 }, 23))).toEqual(['range']);
  });
  it('dead zone 0–9499, square needs 0', () => {
    const dz = (deadzone: number, circular = true) => { const c = emptyConfig(); c.sticks[1] = { ...c.sticks[1], deadzone, circular }; return codes(c); };
    expect(dz(0)).toEqual([]);
    expect(dz(GP_DEADZONE_MAX)).toEqual([]);
    expect(dz(9500)).toEqual(['stickDeadzone']);
    expect(dz(-1)).toEqual(['stickDeadzone']);
    expect(dz(1.5)).toEqual(['stickDeadzone']);
    expect(dz(0, false)).toEqual([]);
    expect(dz(1, false)).toEqual(['squareDeadzone']);
  });
  it('keys 0–63, one output per key', () => {
    expect(codes(withBinding({ key: 0 }))).toEqual([]);
    expect(codes(withBinding({ key: 63 }))).toEqual([]);
    expect(codes(withBinding({ key: 64 }))).toEqual(['key']);
    expect(codes(withBinding({ key: -1 }))).toEqual(['key']);
    const dup = withBinding({ key: 30 }, 3);
    dup.bindings[12].key = 30;
    expect(validateConfig(dup)).toEqual([{ code: 'duplicateKey', index: 12, key: 30 }]);
  });
  it('mode, transport, curve, opposition and record count', () => {
    const c = emptyConfig();
    expect(codes({ ...c, mode: 'on' as never })).toEqual(['mode']);
    expect(codes({ ...c, transport: 'usb' as never })).toEqual(['transport']);
    expect(codes(withBinding({ curve: 'cubic' as never }))).toEqual(['curve']);
    const o = emptyConfig();
    o.sticks[0].opposition = 'first' as never;
    expect(codes(o)).toEqual(['opposition']);
    expect(codes({ ...c, bindings: c.bindings.slice(1) })).toEqual(['bindingCount']);
  });
  it('defaultBinding fits any switch travel', () => {
    expect(defaultBinding(4000)).toEqual({ key: null, curve: 'linear', startUm: 500, endUm: 3500, declaredUm: 4000 });
    expect(defaultBinding(3310)).toMatchObject({ startUm: 500, endUm: 3310, declaredUm: 3310 });
    expect(defaultBinding(400)).toMatchObject({ startUm: 390, endUm: 400 });
    for (const t of [10, 11, 400, 3310, 10000, 99999, 0]) {
      const c = emptyConfig();
      c.bindings[0] = defaultBinding(t);
      expect(validateConfig(c)).toEqual([]);
    }
  });
  it('cloneConfig is deep', () => {
    const a = refConfig();
    const b = cloneConfig(a);
    b.bindings[0].startUm = 1;
    b.sticks[0].deadzone = 1;
    expect(a.bindings[0].startUm).toBe(200);
    expect(a.sticks[0].deadzone).toBe(1234);
  });
});

describe('AGP1 frames', () => {
  it('encodes a READ request like the independent encoder', () => {
    const p = encodeFrame(0x25, 7, readData(1, 48, 48));
    const frame = [...p, ...new Array(64 - p.length).fill(0)];
    expect(hex(frame)).toBe('10250107414750310007010000003000300000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000');
  });
  it('limits data to 54 bytes and masks the sequence', () => {
    expect(encodeFrame(0x20, 0x1ff).slice(0, 10)).toEqual([0x10, 0x20, 1, 0xff, 0x41, 0x47, 0x50, 0x31, 0, 0]);
    expect(encodeFrame(0x22, 1, new Array(54).fill(1)).length).toBe(64);
    expect(() => encodeFrame(0x22, 1, new Array(55).fill(1))).toThrow(RangeError);
  });
  it('request data layouts', () => {
    const token = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(beginData(0x01020304, 0xaabbccdd, token)).toEqual([4, 3, 2, 1, 0xdd, 0xcc, 0xbb, 0xaa, 208, 0, ...token]);
    expect(writeData(token, 200, [9, 9])).toEqual([...token, 200, 0, 9, 9]);
    expect(commitData(token, 0x11223344, 7)).toEqual([...token, 0x44, 0x33, 0x22, 0x11, 7, 0, 0, 0]);
    expect(abortData(token)).toEqual(token);
    expect(usbSetData(true, 5)).toEqual([0x0a, 0, 0x30, 0, 1, 0, 5, 0, 0, 0]);
    expect(usbSetData(false, 0x01000000)).toEqual([0x0a, 0, 0x30, 0, 0, 0, 0, 0, 0, 1]);
    expect(() => abortData([1, 2, 3])).toThrow(RangeError);
  });

  const req = encodeFrame(0x25, 9, readData(3, 0, 48));
  const reply = (patch: (r: number[]) => void = () => undefined): number[] => {
    const r = new Array(64).fill(0);
    req.slice(0, 8).forEach((b, i) => { r[i] = b; });
    r[9] = 6;
    r.splice(10, 6, 3, 0, 0, 0, 0, 0);
    patch(r);
    return r;
  };
  it('reply matching: stock 10 FF, or the same command, sequence and magic', () => {
    expect(agp1ReplyMatches(req, reply())).toBe(true);
    expect(agp1ReplyMatches(req, [0x10, 0xff, ...new Array(62).fill(0)])).toBe(true);
    expect(agp1ReplyMatches(req, reply((r) => { r[1] = 0x20; }))).toBe(false);
    expect(agp1ReplyMatches(req, reply((r) => { r[3] = 8; }))).toBe(false);
    expect(agp1ReplyMatches(req, reply((r) => { r[7] = 0x32; }))).toBe(false);
    expect(agp1ReplyMatches(req, reply((r) => { r[0] = 0x04; }))).toBe(false);
  });
  it('decodeReply checks the echoed header and drops data on an error status', () => {
    expect(decodeReply(req, reply())).toEqual({ stock: false, status: 0, data: [3, 0, 0, 0, 0, 0] });
    expect(decodeReply(req, [0x10, 0xff])).toEqual({ stock: true });
    for (let i = 0; i < 8; i++) expect(() => decodeReply(req, reply((r) => { r[i] ^= 0x40; }))).toThrow(/byte/);
    expect(() => decodeReply(req, reply((r) => { r[9] = 55; }))).toThrow(/length/);
    expect(decodeReply(req, reply((r) => { r[8] = 3; }))).toEqual({ stock: false, status: 3, data: [] });
  });
});

describe('command replies', () => {
  const info = (patch: (d: number[]) => void = () => undefined): number[] => {
    const d = [0x0a, 0, 0x30, 0, 31, 24, 1, 0, 5, 0, 0, 0, 0x10, 0x27, 208, 0, 0x92, 0x8a, 0x25, 0x9d];
    patch(d);
    return d;
  };
  it('decodeInfo reads every field', () => {
    expect(decodeInfo(info())).toEqual({
      boardId: 0x0030000a, caps: 31, transports: { hid: true, xinput: true }, persistent: true, usbSwitch: true, usbPersistent: true,
      revision: 5, maxTravelUm: 10000, configBytes: 208, crc: REF_CRC,
    });
    expect(decodeInfo(info((d) => { d[4] = 2; }))).toMatchObject({ caps: 2, transports: { hid: false, xinput: true }, persistent: false, usbSwitch: false, usbPersistent: false });
  });
  it.each([
    ['short', (d: number[]) => { d.pop(); }],
    ['long', (d: number[]) => { d.push(0); }],
    ['Max board', (d: number[]) => { d[0] = 0x0d; }],
    ['23 records', (d: number[]) => { d[5] = 23; }],
    ['version 2', (d: number[]) => { d[6] = 2; }],
    ['reserved', (d: number[]) => { d[7] = 1; }],
    ['block 207', (d: number[]) => { d[14] = 207; }],
    ['unknown cap bit', (d: number[]) => { d[4] = 32; }],
    ['max travel 9', (d: number[]) => { d[12] = 9; d[13] = 0; }],
    ['max travel 10001', (d: number[]) => { d[12] = 0x11; d[13] = 0x27; }],
  ])('decodeInfo refuses %s', (_, patch) => {
    expect(decodeInfo(info(patch))).toBeNull();
  });
  it('decodeReadReply checks revision, offset and length', () => {
    const d = [5, 0, 0, 0, 48, 0, ...new Array(48).fill(7)];
    expect(decodeReadReply(d, 5, 48, 48)).toEqual(new Array(48).fill(7));
    expect(() => decodeReadReply(d, 6, 48, 48)).toThrow();
    expect(() => decodeReadReply(d, 5, 0, 48)).toThrow();
    expect(() => decodeReadReply(d.slice(0, -1), 5, 48, 48)).toThrow();
  });
  it('decodeCommitReply needs revision + 1 and length 5', () => {
    expect(decodeCommitReply([6, 0, 0, 0, 1], 5)).toEqual({ revision: 6, persistent: true });
    expect(decodeCommitReply([0, 0, 0, 0, 0], 0xffffffff)).toEqual({ revision: 0, persistent: false });
    expect(decodeCommitReply([5, 0, 0, 0, 1], 5)).toBeNull();
    expect(decodeCommitReply([6, 0, 0, 0], 5)).toBeNull();
    expect(decodeCommitReply([6, 0, 0, 0, 2], 5)).toBeNull();
  });
  const usb = (en: number, target: number, phase: number, rev = 4) => [0x0a, 0, 0x30, 0, 1, en, target, phase, rev, 0, 0, 0];
  it('decodeUsbState', () => {
    expect(decodeUsbState(usb(1, 1, 0))).toEqual({ enabled: true, targetEnabled: true, phase: 0, revision: 4 });
    expect(decodeUsbState(usb(0, 1, 1))).toEqual({ enabled: false, targetEnabled: true, phase: 1, revision: 4 });
    expect(() => decodeUsbState(usb(0, 1, 0))).toThrow();
    expect(() => decodeUsbState(usb(1, 1, 3))).toThrow();
    expect(() => decodeUsbState(usb(2, 1, 1))).toThrow();
    expect(() => decodeUsbState(usb(1, 2, 1))).toThrow();
    expect(() => decodeUsbState([0x0d, ...usb(1, 1, 0).slice(1)])).toThrow();
    expect(() => decodeUsbState([...usb(1, 1, 0).slice(0, 4), 2, ...usb(1, 1, 0).slice(5)])).toThrow();
    expect(() => decodeUsbState(usb(1, 1, 0).slice(1))).toThrow();
  });
  it('usbSetAccepted: a no-op keeps the revision at phase 0; a queued change is phase 1 with revision + 1', () => {
    expect(usbSetAccepted(decodeUsbState(usb(1, 1, 0, 4)), true, 4)).toBe(true);
    expect(usbSetAccepted(decodeUsbState(usb(0, 1, 1, 5)), true, 4)).toBe(true);
    expect(usbSetAccepted(decodeUsbState(usb(0, 1, 1, 6)), true, 4)).toBe(false);
    expect(usbSetAccepted(decodeUsbState(usb(0, 1, 1, 4)), true, 4)).toBe(false);
    expect(usbSetAccepted(decodeUsbState(usb(0, 0, 0, 4)), true, 4)).toBe(false);
    expect(usbSetAccepted(decodeUsbState(usb(0, 1, 2, 5)), true, 4)).toBe(false);
    expect(usbSetAccepted(decodeUsbState(usb(1, 1, 0, 5)), true, 4)).toBe(false);
  });
});

/** Every key's measured maximum is 10000 µm: normalised depth = µm, so the vectors read in µm. */
const FULL = () => 10000;

describe('curves and preview', () => {
  it('smooth curve matches the independent model at every breakpoint', () => {
    const b = { curve: 'smooth' as const, start: 200, end: 3000 };
    expect([0, 200, 201, 500, 1133, 1134, 1500, 2066, 2067, 2999, 3000].map((t) => level(b, t))).toEqual([0, 0, 2, 832, 2591, 2594, 4482, 7403, 7408, 9996, 10000]);
  });
  it('linear curve', () => {
    const b = { curve: 'linear' as const, start: 200, end: 3000 };
    expect([0, 200, 201, 500, 1600, 2999, 3000, 9999].map((t) => level(b, t))).toEqual([0, 0, 3, 1071, 5000, 9996, 10000, 10000]);
    expect(level(b, Number.NaN)).toBe(0);
  });
  it('evaluate matches the independent model', () => {
    const travel: Record<number, number> = { 29: 2000, 15: 1000, 16: 15, 63: 5000 };
    const out = evaluate(refConfig(), (k) => travel[k] ?? 0, (k) => k === 58 || k === 0, FULL);
    expect(out).toMatchObject({ lx: -4708, ly: 4708, rx: 0, ry: 5000, lt: 56, rt: 0, buttons: ['A'], dpad: ['DPAD_RIGHT'] });
    expect(out.levels.slice(0, 10)).toEqual([2221, 0, 5000, 0, 0, 5000, 0, 0, 0, 5000]);
  });
  it('opposition policies, dead zone and D-pad cancelling', () => {
    const cfg = emptyConfig();
    const keys = [2, 3, 4, 5]; // LX-, LX+, LY-, LY+ on keys 2–5
    keys.forEach((k, i) => Object.assign(cfg.bindings[2 + i], { key: k, startUm: 0, endUm: 1000, declaredUm: 4000 }));
    cfg.sticks[0] = { circular: false, opposition: 'difference', deadzone: 0 };
    const depth = (d: Record<number, number>) => (k: number) => d[k] ?? 0;
    expect(evaluate(cfg, depth({ 2: 300, 3: 800 }), () => false, FULL).lx).toBe(5000);
    cfg.sticks[0].opposition = 'neutral';
    expect(evaluate(cfg, depth({ 2: 300, 3: 800 }), () => false, FULL).lx).toBe(0);
    expect(evaluate(cfg, depth({ 3: 800 }), () => false, FULL).lx).toBe(8000);
    cfg.sticks[0].opposition = 'deeper';
    expect(evaluate(cfg, depth({ 2: 900, 3: 800 }), () => false, FULL).lx).toBe(-9000);
    expect(evaluate(cfg, depth({ 2: 800, 3: 800 }), () => false, FULL).lx).toBe(0);
    cfg.sticks[0] = { circular: true, opposition: 'difference', deadzone: 2000 };
    expect(evaluate(cfg, depth({ 3: 200 }), () => false, FULL).lx).toBe(0);
    expect(evaluate(cfg, depth({ 3: 1000 }), () => false, FULL).lx).toBe(10000);
    cfg.bindings[20].key = 40;
    cfg.bindings[21].key = 41;
    expect(evaluate(cfg, () => 0, (k) => k === 40, FULL).dpad).toEqual(['DPAD_UP']);
    expect(evaluate(cfg, () => 0, (k) => k === 40 || k === 41, FULL).dpad).toEqual([]);
    expect(evaluate({ ...cfg, mode: 'off' }, depth({ 3: 1000 }), () => true, FULL)).toMatchObject({ lx: 0, buttons: [], dpad: [] });
  });
});

describe('travel limits', () => {
  it('an analog record must end inside the key range; every assigned key needs a known range', () => {
    const cfg = refConfig();
    const lim: Record<number, number> = { 15: 3000, 29: 3500, 16: 3310, 63: 10000, 58: 100, 0: 3310 };
    expect(checkTravelLimits(cfg, (k) => lim[k])).toEqual([]);
    expect(checkTravelLimits(cfg, (k) => (k === 15 ? 2999 : lim[k]))).toEqual([{ code: 'overTravel', index: 0, key: 15, limitUm: 2999 }]);
    expect(checkTravelLimits(cfg, (k) => (k === 29 ? undefined : lim[k]))).toEqual([{ code: 'noTravel', index: 2, key: 29 }]);
    expect(checkTravelLimits(cfg, (k) => (k === 58 ? 9 : lim[k]))).toEqual([{ code: 'noTravel', index: 10, key: 58 }]);
    expect(checkTravelLimits(cfg, (k) => (k === 63 ? 10001 : lim[k]))).toEqual([{ code: 'noTravel', index: 9, key: 63 }]);
    expect(checkTravelLimits(cfg, (k) => (k === 0 ? 3310.5 : lim[k]))).toEqual([{ code: 'noTravel', index: 23, key: 0 }]);
  });
});

describe('order tables', () => {
  it('24 outputs in AGC1 record order', () => {
    expect(GP_CONTROLS.map((c) => c.id)).toEqual([
      'LT', 'RT', 'LX-', 'LX+', 'LY-', 'LY+', 'RX-', 'RX+', 'RY-', 'RY+', 'A', 'B', 'X', 'Y', 'LB', 'RB', 'BACK', 'START', 'L3', 'R3',
      'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT',
    ]);
  });
  it('the physical key index is PHYSICAL_KEYS order (the gamepad firmware numbering)', () => {
    expect(PHYSICAL_KEYS.map((k) => k.name).join(' ')).toBe(
      'Esc 1 2 3 4 5 6 7 8 9 0 - = Backspace Tab Q W E R T Y U I O P [ ] \\ Caps A S D F G H J K L ; \' Enter '
      + 'Shift Z X C V B N M , . / Shift ↑ Del Ctrl Win Alt Space Alt Fn ← ↓ →',
    );
    expect(PHYSICAL_KEYS.map((k) => k.id)).toEqual([...Array(64).keys()]);
  });
  it('index = id for all 64 keys: keyIndexOf / keyPosOf follow the firmware matrix_columns by (row, col)', () => {
    for (const k of PHYSICAL_KEYS) {
      expect(keyIndexOf(k.row, k.col)).toBe(k.id);
      expect(keyPosOf(k.id)).toEqual({ row: k.row, col: k.col });
    }
    // board_port.c matrix_columns: rows 3–5 have holes
    expect([keyIndexOf(3, 12), keyIndexOf(4, 1), keyIndexOf(5, 3), keyIndexOf(6, 0), keyIndexOf(1, 14)]).toEqual([null, null, null, null, null]);
    expect([keyIndexOf(3, 13), keyIndexOf(4, 0), keyIndexOf(4, 2), keyIndexOf(5, 6), keyIndexOf(5, 14)]).toEqual([40, 41, 42, 58, 63]);
    expect([keyPosOf(-1), keyPosOf(64), keyPosOf(1.5), keyPosOf(255)]).toEqual([null, null, null, null]);
  });
});

/**
 * Reports of the real firmware (v0.8.1 sources in the wasm oracle, run outside the repo) for ORACLE_BLOCK with per-key
 * maxima 15/16: 3310 µm, 29/31: 3700 µm, 58: 4000 µm. The depths and pressed flags went in through the board harness's
 * key(); the report is struct gp_report.
 */
const ORACLE_BLOCK =
  '414743310101020101000000000018000f01c800b80bee0c10000000ee0cee0c1d00f401ac0da00f1f01f401ac0da00fff000000e803e803ff000000e803e803'
  + 'ff000000e803e803ff000000e803e803ff000000e803e803ff000000e803e8033a000000e803a00fff000000e803e803ff000000e803e803ff000000e803e803'
  + 'ff000000e803e803ff000000e803e803ff000000e803e803ff000000e803e803ff000000e803e803ff000000e803e803ff000000e803e803ff000000e803e803'
  + 'ff000000e803e803ff000000e803e803';

describe('preview = firmware report (oracle vectors)', () => {
  const max: Record<number, number> = { 15: 3310, 16: 3310, 29: 3700, 31: 3700, 58: 4000 };
  const cfg = decodeConfig(unhex(ORACLE_BLOCK));
  const run = (depth: Record<number, number>, down: number[] = [], m: Record<number, number> = max) =>
    toFirmwareReport(evaluate(cfg, (k) => depth[k] ?? 0, (k) => down.includes(k), (k) => m[k]));
  it('the block decodes to what it was built from', () => {
    expect(cfg.bindings[0]).toEqual({ key: 15, curve: 'smooth', startUm: 200, endUm: 3000, declaredUm: 3310 });
    expect(cfg.bindings[3]).toEqual({ key: 31, curve: 'smooth', startUm: 500, endUm: 3500, declaredUm: 4000 });
    expect(hex(encodeConfig(cfg))).toBe(ORACLE_BLOCK);
  });
  it("depths are normalised to each key's measured maximum before the curve", () => {
    expect(run({ 15: 1000, 16: 1655, 29: 2000, 31: 0, 58: 300 }, [58])).toEqual({ lx: -16384, ly: 0, rx: 0, ry: 0, lt: 56, rt: 127, buttons: 1, dpad: 0 });
    expect(run({ 15: 3310, 16: 3310, 29: 0, 31: 3000 })).toEqual({ lx: 28517, ly: 0, rx: 0, ry: 0, lt: 255, rt: 255, buttons: 0, dpad: 0 });
    expect(run({ 15: 201, 16: 1, 29: 3700, 31: 3700 })).toEqual({ lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: 0, dpad: 0 });
    expect(run({ 15: 2222, 16: 2000, 29: 1200, 31: 2900, 58: 0 }, [58])).toEqual({ lx: 20020, ly: 0, rx: 0, ry: 0, lt: 199, rt: 154, buttons: 1, dpad: 0 });
    expect(normalizeTravel(1000, 3310)).toBe(3021);
    expect(normalizeTravel(3310, 3310)).toBe(10000);
  });
  it('a bound key deeper than its maximum, or without one, makes the whole frame neutral', () => {
    const zero = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: 0, dpad: 0 };
    expect(run({ 15: 2222, 16: 3311, 29: 1200 }, [58])).toEqual(zero);
    expect(evaluate(cfg, (k) => (k === 16 ? 3311 : 0), () => true, (k) => max[k]).neutral).toBe('overTravel');
    expect(evaluate(cfg, () => 1000, () => true, (k) => (k === 58 ? undefined : max[k])).neutral).toBe('noTravel');
    expect(evaluate(cfg, () => 1000, () => true, (k) => (k === 58 ? 9 : max[k])).neutral).toBe('noTravel');
    expect(evaluate(cfg, () => 1000, () => true, (k) => (k === 15 ? 2999 : max[k])).neutral).toBe('noTravel'); // LT ends at 3000
    expect(evaluate({ ...cfg, mode: 'off' }, () => 1000, () => true, (k) => max[k]).neutral).toBe('off');
    expect(evaluate(cfg, () => 0, () => false, (k) => max[k]).neutral).toBeNull();
  });
  it('firmware report units: int16 sticks (32767 / 32768 scaling, truncation), button and D-pad bits', () => {
    const out = evaluate(emptyConfig(), () => 0, () => false, () => 4000);
    const at = (o: Partial<typeof out>) => toFirmwareReport({ ...out, ...o });
    expect([at({ lx: 10000 }).lx, at({ lx: -10000 }).lx, at({ ly: 5000 }).ly, at({ rx: -1 }).rx, at({ ry: 1 }).ry, at({ lx: -0 }).lx])
      .toEqual([32767, -32768, 16383, -3, 3, 0]);
    expect(Object.is(at({ lx: -0 }).lx, 0)).toBe(true);
    expect(at({ buttons: ['A', 'R3', 'BACK'] }).buttons).toBe(1 | 512 | 64);
    expect(at({ dpad: ['DPAD_UP', 'DPAD_RIGHT'] }).dpad).toBe(1 | 8);
    expect(at({ dpad: ['DPAD_DOWN', 'DPAD_LEFT'] }).dpad).toBe(2 | 4);
    expect(at({ lt: 7, rt: 255 })).toMatchObject({ lt: 7, rt: 255 });
  });
});
