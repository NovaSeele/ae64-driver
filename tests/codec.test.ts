import { describe, expect, it } from 'vitest';
import * as c from '../src/protocol/codec';
import { MockTransport, PHYSICAL_KEYS, keycodeLabel, comboKeycode, decodeCombo, keysFromLayoutStyles, SAVE_GROUP } from '../src/protocol';
import { frameOf } from '../src/protocol/client';
import type { Performance } from '../src/protocol';

const hex = (s: string) => Uint8Array.from(s.trim().split(/\s+/).map((h) => parseInt(h, 16)));
const pad = (b: ArrayLike<number>) => { const out = new Uint8Array(64); out.set(Array.from(b)); return out; };

describe('device decoders (snapshot vectors)', () => {
  it('decodes 01 02 device info: board 0030000d, firmware 0.0.4.0', () => {
    const info = c.decodeDeviceInfo(pad(hex('01 02 01 00 00 30 00 0d 00 00 04 00 01 00 00 00 00 36 08 12 50 43 39 46 35 36 05 16 57 32 30 32 36 31 30 31 32 31 35 3a 31 33 3a 34 31')));
    expect(info.type).toBe(1);
    expect(info.subType).toBe(0);
    expect(info.boardId).toBe(0x0030000d);
    expect(info.boardIdHex).toBe('0030000d');
    expect(info.firmware).toBe('0.0.4.0');
    expect(info.pcb).toBe('1-0-0-0');
    expect(info.runMode).toBe(0);
    expect(info.timestamp).toBe('2026101215:13:41');
    expect(info.serial).toBe([0x36, 0x08, 0x12, 0x50, 0x43, 0x39, 0x46, 0x35, 0x36, 0x05, 0x16, 0x57].join(''));
  });

  it('decodes protocol version and feature bitmap', () => {
    expect(c.decodeProtocolVersion(pad(hex('01 01 01 03 00 00')))).toEqual({ main: 1, sub: 3, hardware: 0, software: 0 });
    const f = c.decodeFeatures(pad(hex('01 03 02 01 01 00')));
    expect(f.axis.magnetic).toBe(true);
    expect(f.axis.mechanical).toBe(false);
    expect(f.connection.usb).toBe(true);
    expect(f.basic).toEqual({ rgb: true, knob: false });
    expect(f.extended.gamepad).toBe(false);
    expect(f.raw).toEqual([2, 1, 1, 0]);
  });

  it('decodes lighting areas and byte lists', () => {
    const areas = c.decodeLightingAreas(pad(hex('02 08 00 02 00 13 06 0f 01 05 01 26')));
    expect(areas.count).toBe(2);
    expect(areas.areas).toEqual([{ modes: 19 }, { modes: 5, leds: 38 }]);
    expect(c.decodeByteList(pad(hex('02 05 00 06 00 01 02 03 04 05')))).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('primitives', () => {
  it('LE16 and µm↔mm conversion', () => {
    expect(c.le16(2000)).toEqual([0xd0, 0x07]);
    expect(c.read16([0xd0, 0x07], 0)).toBe(2000);
    expect(c.mmToUm(0.1)).toBe(100);
    expect(c.mmToUm(3.31)).toBe(3310);
    expect(c.umToMm(800)).toBe(0.8);
    expect(() => c.le16(0x10000)).toThrow(RangeError);
  });

  it('refuses family 08 frames and pads to 64 bytes', () => {
    expect(() => frameOf([0x08, 0x01])).toThrow();
    const f = frameOf([0x04, 0x01, 3, 2]);
    expect(f.length).toBe(64);
    expect(Array.from(f.slice(0, 5))).toEqual([4, 1, 3, 2, 0]);
  });

  it('profile names are UTF-8 and capped at 32 bytes', () => {
    const enc = c.encodeProfileName('Chơi game');
    expect(c.decodeProfileName(pad([2, 3, 3, 0, ...enc]))).toBe('Chơi game');
    expect(c.encodeProfileName('ệ'.repeat(20)).length).toBeLessThanOrEqual(32);
  });
});

describe('performance', () => {
  const snapshot: Performance = {
    mode: 1, normalPress: 2, normalRelease: 2, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.3,
    pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500,
  };

  it('encodes the snapshot record to the documented byte layout', () => {
    const p = c.encodePerformance({ row: 2, col: 2 }, snapshot);
    expect(p).toEqual([
      0x04, 0x02, 2, 2, 1,
      0xd0, 0x07, 0xd0, 0x07, // normal press / release 2000 µm
      0xe8, 0x03,             // rt first touch 1000
      0x20, 0x03, 0x2c, 0x01, // rt press 800 / release 300
      0x64, 0x00, 0x64, 0x00, // dead zones 100 / 100
      0, 1,                   // axis, calibrate
      0x90, 0x30,             // axisV2Id 12432
      0xee, 0x0c,             // axisRangeMax 3310
      0x14, 0x50,             // axisCoefficient 20500
    ]);
  });

  it('decodes a 04 01 reply and round-trips', () => {
    const reply = pad([0x04, 0x01, 2, 2, ...c.encodePerformance({ row: 2, col: 2 }, snapshot).slice(4)]);
    expect(c.decodePerformance(reply)).toEqual(snapshot);
  });
});

describe('layout + keymap', () => {
  it('layout style packs y/x/ratio and round-trips', () => {
    const entries = [{ y: 3, x: 0, ratio: 5 }, { y: 3, x: 2, ratio: 1 }, { y: 4, x: 3.75, ratio: 9 }];
    const bytes = pad([0x03, 0x05, 4, ...entries.flatMap((e) => c.le16(c.encodeLayoutStyleEntry(e)))]);
    expect(c.decodeLayoutStyle(bytes).slice(0, 3)).toEqual(entries);
  });

  it('decodes the snapshot layer-0 keymap row 5 (Space col 6, Fn F101 col 10)', () => {
    const codes = [0xe0, 0xe3, 0xe2, 0, 0, 0, 0x2c, 0, 0, 0xe6, 0xf101, 0, 0x50, 0x51, 0x4f];
    const row = c.decodeKeycodeRow(pad([0x03, 0x01, 0, 5, ...codes.flatMap((k) => c.le16(k))]));
    expect(row.slice(0, 15)).toEqual(codes);
    expect(keycodeLabel(row[10]).label).toBe('Fn1');
    expect(keycodeLabel(row[6]).label).toBe('Space');
  });

  it('builds 64 physical keys with snapshot sensor columns', () => {
    expect(PHYSICAL_KEYS).toHaveLength(64);
    const row5 = PHYSICAL_KEYS.filter((k) => k.row === 5).map((k) => k.col);
    expect(row5).toEqual([0, 1, 2, 6, 9, 10, 12, 13, 14]);
    expect(PHYSICAL_KEYS.find((k) => k.name === 'Space')).toMatchObject({ x: 3.75, w: 6.25, row: 5, col: 6 });
  });

  it('accepts 03 05 discovery only when it matches the sensor columns', async () => {
    const t = new MockTransport({ latencyMs: 0 });
    const styles = [];
    for (let r = 1; r <= 5; r++) styles.push(await t.getLayoutStyle(r));
    const keys = keysFromLayoutStyles(styles);
    expect(keys.map((k) => [k.x, k.y, k.w])).toEqual(PHYSICAL_KEYS.map((k) => [k.x, k.y, k.w]));
    expect(keysFromLayoutStyles([])).toHaveLength(64);
  });
});

describe('keycodes', () => {
  it('labels special, layer and unknown codes', () => {
    expect(keycodeLabel(0x0001)).toMatchObject({ label: 'Trans', group: 'special' });
    expect(keycodeLabel(0x0000).group).toBe('special');
    expect(keycodeLabel(0xf103).label).toBe('Fn3');
    expect(keycodeLabel(0xf505).label).toBe('M5');
    expect(keycodeLabel(0x20e9).group).toBe('media');
    expect(keycodeLabel(0xbeef).group).toBe('unknown');
  });

  it('modifier combos use the high byte', () => {
    const code = comboKeycode(0x01 | 0x02, 0x06); // Ctrl+Shift+C
    expect(code).toBe(0x0306);
    expect(decodeCombo(code)).toEqual({ mask: 3, trigger: 6 });
    expect(keycodeLabel(code)).toMatchObject({ label: 'Ctrl+Shift+C', group: 'combo' });
    expect(decodeCombo(0x4100)).toBeNull(); // mouse left is not a combo
  });
});

describe('lighting colours', () => {
  it('encodes BGR + flag records and decodes them back', () => {
    const leds = [{ r: 0x3f, g: 0xe0, b: 0xc5, custom: true }, { r: 1, g: 2, b: 3, custom: false }];
    const enc = c.encodeColors(leds);
    expect(enc.slice(0, 8)).toEqual([0xc5, 0xe0, 0x3f, 0xff, 3, 2, 1, 0]);
    expect(enc).toHaveLength(60);
    expect(c.decodeColors(pad([5, 3, 0, 0, ...enc])).slice(0, 2)).toEqual(leds);
  });

  it('lighting base and palette', () => {
    const base = { area: 0, open: true, openMode: 3, mode: 1, brightness: 80, speed: 50, direction: 0, paletteIndex: 2 };
    const enc = c.encodeLightingBase(base);
    expect(enc).toEqual([5, 2, 0, 0, 3, 1, 80, 50, 0, 2]);
    expect(c.decodeLightingBase(pad(enc))).toEqual(base);
    expect(c.encodeLightingBase({ ...base, open: false })[4]).toBe(0);
    const pal = Array.from({ length: 8 }, (_, i) => ({ r: i, g: 10 + i, b: 20 + i, hue: 0 }));
    expect(c.decodePalette(pad(c.encodePalette(0, pal)))).toEqual(pal);
  });
});

describe('advanced keys (reference packet layouts)', () => {
  const A = { row: 3, col: 1 };
  const B = { row: 3, col: 3 };

  it('DKS', () => {
    const p = c.encodeDks({ pos: { row: 2, col: 2 }, keycodes: [0x1a, 0x2c, 0, 0], travels: [0x01, 0x18, 0, 0x80], dbs: [0.5, 3.3] });
    expect(p).toEqual([6, 2, 2, 2, 1, 0x1a, 0, 0x2c, 0, 0, 0, 0, 0, 0x01, 0x18, 0, 0x80, 0xf4, 0x01, 0xe4, 0x0c]);
    expect(c.decodeAdvanced(pad(p))).toEqual({
      mode: 1, row: 2, col: 2, type: 'DKS', keycodes: [0x1a, 0x2c, 0, 0], travels: [1, 0x18, 0, 0x80], deadzones: [0.5, 3.3],
    });
  });

  it('MPT', () => {
    const p = c.encodeMpt({ pos: A, keycodes: [0x04, 0x05, 0], depths: [0.5, 1.5, 2.5] });
    expect(p).toEqual([6, 2, 3, 1, 2, 4, 0, 5, 0, 0, 0, 0xf4, 0x01, 0xdc, 0x05, 0xc4, 0x09]);
    expect(() => c.encodeMpt({ pos: A, keycodes: [4, 5, 0], depths: [1, 1, 2] })).toThrow();
  });

  it('SOCD pair: reversed outputs and reciprocal priority bytes', () => {
    const [a, b] = c.encodeSocdPair({ first: A, second: B, keycodes: [0x04, 0x07], delay: 0x0102, mode: 1 });
    expect(a).toEqual([6, 2, 3, 1, 6, 3, 3, 0x04, 0, 0x07, 0, 0x02, 0x01, 1]);
    expect(b).toEqual([6, 2, 3, 3, 6, 3, 1, 0x07, 0, 0x04, 0, 0x02, 0x01, 2]);
    expect(c.decodeAdvanced(pad(a))).toMatchObject({ type: 'SOCD', pairedRow: 3, pairedCol: 3, keycodes: [4, 7], delay: 0x0102, socdMode: 1 });
    expect(c.encodeSocdPair({ first: A, second: B, keycodes: [4, 7], delay: 0, mode: 3 }).map((x) => x[13])).toEqual([3, 3]);
    expect(() => c.encodeSocdPair({ first: A, second: A, keycodes: [4, 7], delay: 0, mode: 0 })).toThrow();
  });

  it('Rappy Snappy pair', () => {
    const [a, b] = c.encodeRappySnappyPair({ first: A, second: B, keycodes: [0x04, 0x07], delay: 5 });
    expect(a).toEqual([6, 2, 3, 1, 7, 3, 3, 0x04, 0, 0x07, 0, 5, 0]);
    expect(b).toEqual([6, 2, 3, 3, 7, 3, 1, 0x07, 0, 0x04, 0, 5, 0]);
    expect(c.decodeAdvanced(pad(b))).toMatchObject({ type: 'RS', keycodes: [7, 4], delay: 5 });
  });

  it('decodes snapshot W (06 01 2 2 0) as NONE', () => {
    expect(c.decodeAdvanced(pad([6, 1, 2, 2, 0]))).toEqual({ mode: 0, row: 2, col: 2, type: 'NONE' });
    expect(c.encodeClearAdvanced(A)).toEqual([6, 2, 3, 1, 0]);
  });
});

describe('macro', () => {
  it('packs actions: bit31 down, bits16–30 delay, bits0–15 keycode', () => {
    const a = { down: true, delay: 32767, keycode: 0xf500 };
    const packed = c.packMacroAction(a);
    expect(packed).toBe(0xfffff500);
    expect(c.unpackMacroAction(packed)).toEqual(a);
    expect(c.packMacroAction({ down: false, delay: 1, keycode: 4 })).toBe(0x00010004);
    expect(() => c.packMacroAction({ down: true, delay: 32768, keycode: 4 })).toThrow();
  });

  it('splits into pages of 15 with page offsets, and unpacks', () => {
    const actions = Array.from({ length: 31 }, (_, i) => ({ down: i % 2 === 0, delay: i + 1, keycode: 4 + (i % 26) }));
    const pages = c.encodeMacroPages(3, actions);
    expect(pages).toHaveLength(3);
    expect(pages.map((p) => p.slice(0, 4))).toEqual([[7, 4, 3, 0], [7, 4, 3, 1], [7, 4, 3, 2]]);
    expect(pages.map((p) => (p.length - 4) / 4)).toEqual([15, 15, 1]);
    const decoded = pages.flatMap((p) => c.decodeMacroPage(pad([7, 3, ...p.slice(2)])));
    expect(decoded.slice(0, 31)).toEqual(actions);
  });

  it('meta encode/decode', () => {
    const m = { id: 2, valid: true, actionCount: 31, repeatCount: 65535, mode: 4 };
    const enc = c.encodeMacroMeta(m);
    expect(enc).toEqual([7, 2, 2, 1, 31, 0, 0xff, 0xff, 4]);
    expect(c.decodeMacroMeta(pad(enc))).toEqual(m);
  });
});

describe('mock transport', () => {
  it('answers with snapshot device facts and persists writes', async () => {
    const t = new MockTransport({ latencyMs: 0 });
    const info = await t.getDeviceInfo();
    expect(info.boardIdHex).toBe('0030000d');
    expect(t.boardAllowed).toBe(true);
    expect(await t.getRtPrecision()).toBe(0.001);
    expect(await t.getMacroSpace()).toEqual({ count: 16, capacity: 960 });
    expect(await t.getPollingRates()).toEqual([0, 1, 2, 3, 4, 5]);
    const row4 = await t.getKeymapRow(0, 4);
    expect(row4.slice(12, 15)).toEqual([0x4c, 0x52, 0x46]);
    const w = { row: 2, col: 2 };
    const perf = await t.getPerformance(w);
    expect(perf).toMatchObject({ mode: 1, rtFirstTouch: 1, rtPress: 0.8, axisV2Id: 12432, axisRangeMax: 3310 });
    await t.setPerformance(w, { ...perf, rtPress: 0.25 });
    await t.commit(SAVE_GROUP.PERFORMANCE);
    expect((await t.getPerformance(w)).rtPress).toBe(0.25);
    const actions = [{ down: true, delay: 5, keycode: 4 }, { down: false, delay: 7, keycode: 4 }];
    await t.writeMacroActions(5, actions);
    expect(await t.readMacroActions(5, 2)).toEqual(actions);
    expect((await t.readLedMatrix(0)).length).toBe(126);
    expect((await t.readLedMatrix(1)).length).toBe(38);
  });

  it('simulatePress drives route and key status', async () => {
    const t = new MockTransport({ latencyMs: 0 });
    const w = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
    t.simulatePress(w.id, 1.5);
    const route = await t.getAxisData('route', 2);
    const status = await t.getAxisData('keyStatus', 2);
    expect(route.values[w.col]).toBe(1500);
    expect(status.values[w.col]).toBe(1);
    t.simulatePress(w.id, 0);
    expect((await t.getAxisData('keyStatus', 2)).values[w.col]).toBe(0);
  });

  it('refuses writes until the board is identified as allowed', async () => {
    const t = new MockTransport({ latencyMs: 0 });
    await expect(t.commit(SAVE_GROUP.ALL)).rejects.toThrow();
    await expect(t.raw([0x08, 0x01])).rejects.toThrow();
    await t.getDeviceInfo();
    await expect(t.raw([0x08, 0x01])).rejects.toThrow();
    await expect(t.commit(SAVE_GROUP.ALL)).resolves.toBeUndefined();
  });
});
