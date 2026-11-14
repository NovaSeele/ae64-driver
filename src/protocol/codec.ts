// Pure encoders/decoders for AE64 packets. Requests are built as number[] payloads (the transport
// zero-pads to 64 bytes); replies are decoded from the raw 64-byte report. Multi-byte integers are
// unsigned little-endian except the board ID (big-endian). Distances are mm in the API, µm on the wire.

import type {
  AdvancedRecord, AxisRow, Bytes, DeviceInfo, FeatureBitmap, KeyPos, LedRecord, LightingAreas, LightingBase,
  MacroAction, MacroMeta, PaletteEntry, Performance, PerfMode, ProtocolVersion,
} from './types';
import {
  FAMILY, LED_RECORDS_PER_PACKET, MACRO_ACTIONS_PER_PAGE, MACRO_MAX_DELAY_MS,
  PALETTE_SIZE, SOCD_PAIR_MODES,
} from './constants';
import { t } from '../i18n/vi';

// ---------------------------------------------------------------- primitives

export function byte(value: number, field = 'value'): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(t('error.byteRange', { field, val: value }));
  return value;
}

export function le16(value: number, field = 'value'): [number, number] {
  const n = Math.round(value);
  if (!Number.isInteger(n) || n < 0 || n > 0xffff) throw new RangeError(t('error.u16Range', { field, val: value }));
  return [n & 0xff, n >>> 8];
}

export function read16(data: ArrayLike<number>, offset: number): number {
  return (data[offset] ?? 0) | ((data[offset + 1] ?? 0) << 8);
}

/** mm → µm (rounded to the 0.001 mm wire resolution). */
export function mmToUm(mm: number): number {
  return Math.round(mm * 1000);
}

export function umToMm(um: number): number {
  return um / 1000;
}

function mm16(mm: number, field: string): [number, number] {
  return le16(mmToUm(mm), field);
}

function pos(p: KeyPos, label = 'key'): [number, number] {
  return [byte(p.row, `${label} row`), byte(p.col, `${label} column`)];
}

function readList16(data: Bytes, start: number): number[] {
  const out: number[] = [];
  for (let o = start; o + 1 < data.length; o += 2) out.push(read16(data, o));
  return out;
}

// ---------------------------------------------------------------- 01 device

export function decodeProtocolVersion(d: Bytes): ProtocolVersion {
  return { main: d[2], sub: d[3], hardware: d[4], software: d[5] };
}

export function decodeDeviceInfo(d: Bytes): DeviceInfo {
  const boardId = ((d[4] << 24) | (d[5] << 16) | (d[6] << 8) | d[7]) >>> 0;
  // Timestamp is ASCII from byte 29 ("2026101215:13:41", 16 chars on the Max), NUL-terminated.
  const ts = Array.from(d.slice(29, 45));
  const end = ts.indexOf(0);
  return {
    type: d[2],
    subType: d[3],
    boardId,
    boardIdHex: boardId.toString(16).padStart(8, '0'),
    firmware: Array.from(d.slice(8, 12)).join('.'),
    pcb: Array.from(d.slice(12, 16)).join('-'),
    runMode: d[16],
    // The factory driver prints the 12 UID bytes as concatenated decimals.
    serial: Array.from(d.slice(17, 29)).join(''),
    // `serial` loses information ([1, 11] and [11, 1] both read "111"): compare keyboards by this one.
    serialHex: Array.from(d.slice(17, 29), (b) => (b & 0xff).toString(16).padStart(2, '0')).join(''),
    timestamp: String.fromCharCode(...(end < 0 ? ts : ts.slice(0, end))),
  };
}

export function decodeFeatures(d: Bytes): FeatureBitmap {
  const bit = (b: number, m: number) => Boolean(b & m);
  return {
    axis: { mechanical: bit(d[2], 1), magnetic: bit(d[2], 2), optical: bit(d[2], 4), inductive: bit(d[2], 8), magnetic3D: bit(d[2], 16) },
    connection: { usb: bit(d[3], 1), wireless24: bit(d[3], 2), bluetooth: bit(d[3], 4), usb3: bit(d[3], 8) },
    basic: { rgb: bit(d[4], 1), knob: bit(d[4], 2) },
    extended: {
      smallScreen: bit(d[5], 1), fullScreen: bit(d[5], 2), haptic: bit(d[5], 4), voicePlayback: bit(d[5], 8),
      voiceRecognition: bit(d[5], 16), gamepad: bit(d[5], 32), dotMatrix: bit(d[5], 64),
    },
    raw: Array.from(d.slice(2, 6)),
  };
}

// ---------------------------------------------------------------- 02 global

/** Reply `02 08 00 count {index, modes, rows, cols}…`. The keyboard matrix (area 0) has a fixed
 *  6×21 LED address space, so `leds` is only reported for single-row areas (the 38-LED strip). */
export function decodeLightingAreas(d: Bytes): LightingAreas {
  const count = d[3];
  const areas: LightingAreas['areas'] = [];
  for (let i = 0; i < count; i++) {
    const o = 4 + i * 4;
    const rows = d[o + 2];
    const cols = d[o + 3];
    areas.push(rows === 1 ? { modes: d[o + 1], leds: cols } : { modes: d[o + 1] });
  }
  return { count, areas, raw: Array.from(d.slice(3, 4 + count * 4)) };
}

export function decodeProfileName(d: Bytes): string {
  const bytes = Array.from(d.slice(4, 36)).filter((b) => b !== 0 && b !== 0xff);
  return new TextDecoder().decode(Uint8Array.from(bytes));
}

/** UTF-8, truncated to 32 bytes without splitting a character. */
export function encodeProfileName(name: string): number[] {
  const out: number[] = [];
  for (const ch of name) {
    const b = Array.from(new TextEncoder().encode(ch));
    if (out.length + b.length > 32) break;
    out.push(...b);
  }
  return out;
}

export function decodeByteList(d: Bytes): number[] {
  return Array.from(d.slice(4, 4 + d[3]));
}

// ---------------------------------------------------------------- 03 layout

export interface LayoutStyleEntry { y: number; x: number; ratio: number }

/** Reply `03 05 row` + packed uint16 per firmware column: y = bits 11–15 /4, x = bits 4–10 /4, ratio code = bits 0–3. */
export function decodeLayoutStyle(d: Bytes): LayoutStyleEntry[] {
  const out: LayoutStyleEntry[] = [];
  for (let o = 3; o + 1 < d.length; o += 2) {
    const p = read16(d, o);
    out.push({ y: ((p >>> 11) & 31) / 4, x: ((p >>> 4) & 127) / 4, ratio: p & 15 });
  }
  return out;
}

export function encodeLayoutStyleEntry(e: LayoutStyleEntry): number {
  return ((Math.round(e.y * 4) & 31) << 11) | ((Math.round(e.x * 4) & 127) << 4) | (e.ratio & 15);
}

/** Keycode rows (`03 01`, `03 06`): uint16 values from byte 4, index = firmware column. */
export function decodeKeycodeRow(d: Bytes): number[] {
  return readList16(d, 4);
}

// ---------------------------------------------------------------- 04 performance

export function encodePerformance(p: KeyPos, s: Performance): number[] {
  return [
    FAMILY.PERFORMANCE, 0x02, ...pos(p), byte(s.mode, 'mode'),
    ...mm16(s.normalPress, 'normalPress'), ...mm16(s.normalRelease, 'normalRelease'),
    ...mm16(s.rtFirstTouch, 'rtFirstTouch'), ...mm16(s.rtPress, 'rtPress'), ...mm16(s.rtRelease, 'rtRelease'),
    ...mm16(s.pressDeadStroke, 'pressDeadStroke'), ...mm16(s.releaseDeadStroke, 'releaseDeadStroke'),
    byte(s.axis, 'axis'), byte(s.calibrate, 'calibrate'),
    ...le16(s.axisV2Id, 'axisV2Id'), ...le16(s.axisRangeMax, 'axisRangeMax'), ...le16(s.axisCoefficient, 'axisCoefficient'),
  ];
}

/** Rapid Trigger, continuous (1) or not (2). */
export function isRtMode(mode: number): boolean {
  return mode === 1 || mode === 2;
}

/** Protocol version a.b.c.d ≥ 1.3.0.0: the firmware accepts mode 2 (Rapid Trigger without Continuous RT). */
export function supportsIntervalRt(v: ProtocolVersion | null | undefined): boolean {
  if (!v) return false;
  const a = [v.main, v.sub, v.hardware, v.software];
  const b = [1, 3, 0, 0];
  for (let i = 0; i < 4; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

export function decodePerformance(d: Bytes): Performance {
  return {
    // Raw byte (0 standard, 1 RT continuous, 2 RT non-continuous); never collapsed, so a write-back keeps it.
    mode: d[4] as PerfMode,
    normalPress: umToMm(read16(d, 5)),
    normalRelease: umToMm(read16(d, 7)),
    rtFirstTouch: umToMm(read16(d, 9)),
    rtPress: umToMm(read16(d, 11)),
    rtRelease: umToMm(read16(d, 13)),
    pressDeadStroke: umToMm(read16(d, 15)),
    releaseDeadStroke: umToMm(read16(d, 17)),
    axis: d[19],
    calibrate: d[20],
    axisV2Id: read16(d, 21),
    axisRangeMax: read16(d, 23),
    axisCoefficient: read16(d, 25),
  };
}

/** Axis data (`04 03 type row`): uint16 per firmware column from byte 4. */
export function decodeAxisRow(d: Bytes): AxisRow {
  return { type: d[2], row: d[3], values: readList16(d, 4) };
}

// ---------------------------------------------------------------- 05 lighting

export function decodeLightingBase(d: Bytes): LightingBase {
  return {
    area: d[2], open: d[4] !== 0, openMode: d[4], mode: d[5],
    brightness: d[6], speed: d[7], direction: d[8], paletteIndex: d[9],
  };
}

export function encodeLightingBase(b: LightingBase): number[] {
  return [
    FAMILY.LIGHTING, 0x02, byte(b.area, 'area'), 0x00,
    b.open ? byte(b.openMode || 1, 'openMode') : 0,
    byte(b.mode, 'mode'), byte(b.brightness, 'brightness'), byte(b.speed, 'speed'),
    byte(b.direction, 'direction'), byte(b.paletteIndex, 'paletteIndex'),
  ];
}

/** Palette: eight `B,G,R,hue` records from byte 4. */
export function decodePalette(d: Bytes): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  for (let i = 0; i < PALETTE_SIZE; i++) {
    const o = 4 + i * 4;
    out.push({ r: d[o + 2], g: d[o + 1], b: d[o], hue: d[o + 3] });
  }
  return out;
}

export function encodePalette(area: number, colors: PaletteEntry[]): number[] {
  if (colors.length !== PALETTE_SIZE) throw new RangeError(t('error.paletteSize'));
  return [
    FAMILY.LIGHTING, 0x02, byte(area, 'area'), 0x01,
    ...colors.flatMap((c) => [byte(c.b, 'blue'), byte(c.g, 'green'), byte(c.r, 'red'), byte(c.hue, 'hue')]),
  ];
}

/** LED records: fifteen `B,G,R,flag` per packet from byte 4; flag FF = custom override. */
export function decodeColors(d: Bytes): LedRecord[] {
  const out: LedRecord[] = [];
  for (let i = 0; i < LED_RECORDS_PER_PACKET; i++) {
    const o = 4 + i * 4;
    out.push({ r: d[o + 2], g: d[o + 1], b: d[o], custom: d[o + 3] === 0xff });
  }
  return out;
}

export function encodeColors(leds: LedRecord[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < LED_RECORDS_PER_PACKET; i++) {
    const c = leds[i] ?? { r: 0, g: 0, b: 0, custom: false };
    out.push(byte(c.b, 'blue'), byte(c.g, 'green'), byte(c.r, 'red'), c.custom ? 0xff : 0x00);
  }
  return out;
}

// ---------------------------------------------------------------- 06 advanced

export function decodeAdvanced(d: Bytes): AdvancedRecord {
  const mode = d[4];
  const row = d[2];
  const col = d[3];
  switch (mode) {
    case 0: return { mode: 0, row, col, type: 'NONE' };
    case 1: return {
      mode: 1, row, col, type: 'DKS',
      keycodes: [read16(d, 5), read16(d, 7), read16(d, 9), read16(d, 11)],
      travels: [d[13], d[14], d[15], d[16]],
      deadzones: [umToMm(read16(d, 17)), umToMm(read16(d, 19))],
    };
    case 2: return {
      mode: 2, row, col, type: 'MPT',
      keycodes: [read16(d, 5), read16(d, 7), read16(d, 9)],
      depths: [umToMm(read16(d, 11)), umToMm(read16(d, 13)), umToMm(read16(d, 15))],
    };
    case 3: return { mode: 3, row, col, type: 'MT', keycodes: [read16(d, 5), read16(d, 7)], time: read16(d, 9) };
    case 4: return { mode: 4, row, col, type: 'TGL', keycode: read16(d, 5), time: read16(d, 7) };
    case 5: return { mode: 5, row, col, type: 'END', keycodes: [read16(d, 5), read16(d, 7)], delay: read16(d, 9) };
    case 6: return {
      mode: 6, row, col, type: 'SOCD', pairedRow: d[5], pairedCol: d[6],
      keycodes: [read16(d, 7), read16(d, 9)], delay: read16(d, 11), socdMode: d[13],
    };
    case 7: return {
      mode: 7, row, col, type: 'RS', pairedRow: d[5], pairedCol: d[6],
      keycodes: [read16(d, 7), read16(d, 9)], delay: read16(d, 11),
    };
    default: return { mode, row, col, type: 'UNKNOWN', raw: Array.from(d.slice(5)) };
  }
}

export function encodeClearAdvanced(p: KeyPos): number[] {
  return [FAMILY.ADVANCED, 0x02, ...pos(p), 0];
}

/** DKS: `06 02 row col 01 key1..4 (LE16) trp1..4 (byte) db1 db2 (µm LE16)`. */
export function encodeDks(a: { pos: KeyPos; keycodes: number[]; travels: number[]; dbs: [number, number] }): number[] {
  if (a.keycodes.length !== 4 || a.travels.length !== 4) throw new RangeError(t('error.dksCount'));
  return [
    FAMILY.ADVANCED, 0x02, ...pos(a.pos), 1,
    ...a.keycodes.flatMap((k, i) => le16(k, `DKS keycode ${i + 1}`)),
    ...a.travels.map((t, i) => byte(t, `DKS trigger ${i + 1}`)),
    ...mm16(a.dbs[0], 'DKS min travel'), ...mm16(a.dbs[1], 'DKS max travel'),
  ];
}

/** MPT: `06 02 row col 02 key1..3 (LE16) depth1..3 (µm LE16)`; depths strictly increasing. */
export function encodeMpt(a: { pos: KeyPos; keycodes: number[]; depths: number[] }): number[] {
  if (a.keycodes.length !== 3 || a.depths.length !== 3) throw new RangeError(t('error.mptCount'));
  const [d1, d2, d3] = a.depths;
  if (!(d1 > 0 && d1 < d2 && d2 < d3)) throw new RangeError(t('error.mptOrder'));
  return [
    FAMILY.ADVANCED, 0x02, ...pos(a.pos), 2,
    ...a.keycodes.flatMap((k, i) => le16(k, `MPT keycode ${i + 1}`)),
    ...a.depths.flatMap((d, i) => mm16(d, `MPT depth ${i + 1}`)),
  ];
}

function assertPair(first: KeyPos, second: KeyPos) {
  if (first.row === second.row && first.col === second.col) throw new RangeError(t('error.pairDistinct'));
}

/** SOCD pair: two reciprocal mode-6 records; outputs reversed in the second; mode bytes per SOCD_PAIR_MODES. */
export function encodeSocdPair(a: { first: KeyPos; second: KeyPos; keycodes: [number, number]; delay: number; mode: 0 | 1 | 2 | 3 }): [number[], number[]] {
  assertPair(a.first, a.second);
  const modes = SOCD_PAIR_MODES[a.mode];
  if (!modes) throw new RangeError(t('error.socdMode'));
  const [ka, kb] = a.keycodes;
  return [
    [FAMILY.ADVANCED, 0x02, ...pos(a.first, 'A'), 6, ...pos(a.second, 'B'), ...le16(ka), ...le16(kb), ...le16(a.delay, 'delay'), modes[0]],
    [FAMILY.ADVANCED, 0x02, ...pos(a.second, 'B'), 6, ...pos(a.first, 'A'), ...le16(kb), ...le16(ka), ...le16(a.delay, 'delay'), modes[1]],
  ];
}

/** Rappy Snappy pair: mode-7 records like SOCD but without the priority byte. */
export function encodeRappySnappyPair(a: { first: KeyPos; second: KeyPos; keycodes: [number, number]; delay: number }): [number[], number[]] {
  assertPair(a.first, a.second);
  const [ka, kb] = a.keycodes;
  return [
    [FAMILY.ADVANCED, 0x02, ...pos(a.first, 'A'), 7, ...pos(a.second, 'B'), ...le16(ka), ...le16(kb), ...le16(a.delay, 'delay')],
    [FAMILY.ADVANCED, 0x02, ...pos(a.second, 'B'), 7, ...pos(a.first, 'A'), ...le16(kb), ...le16(ka), ...le16(a.delay, 'delay')],
  ];
}

// ---------------------------------------------------------------- 07 macro

export function decodeMacroMeta(d: Bytes): MacroMeta {
  return { id: d[2], valid: d[3] === 1, actionCount: read16(d, 4), repeatCount: read16(d, 6), mode: d[8] };
}

export function encodeMacroMeta(m: MacroMeta): number[] {
  return [
    FAMILY.MACRO, 0x02, byte(m.id, 'macro id'), m.valid ? 1 : 0,
    ...le16(m.actionCount, 'actionCount'), ...le16(m.repeatCount, 'repeatCount'), byte(m.mode, 'macro mode'),
  ];
}

/** Packed action (uint32 LE): bit 31 = down, bits 16–30 = delay ms, bits 0–15 = keycode. */
export function packMacroAction(a: MacroAction): number {
  if (!Number.isInteger(a.delay) || a.delay < 0 || a.delay > MACRO_MAX_DELAY_MS) throw new RangeError(t('error.macroDelay', { max: MACRO_MAX_DELAY_MS }));
  if (!Number.isInteger(a.keycode) || a.keycode <= 0 || a.keycode > 0xffff) throw new RangeError(t('error.macroKeycode'));
  return ((a.down ? 0x80000000 : 0) | (a.delay << 16) | a.keycode) >>> 0;
}

export function unpackMacroAction(packed: number): MacroAction {
  return { down: Boolean(packed >>> 31), delay: (packed >>> 16) & 0x7fff, keycode: packed & 0xffff };
}

export function macroPageCount(actionCount: number): number {
  return Math.ceil(actionCount / MACRO_ACTIONS_PER_PAGE);
}

/** `07 04 id page` + up to 15 packed actions. The offset byte is a page number, not an index. */
export function encodeMacroPage(id: number, page: number, actions: MacroAction[]): number[] {
  if (actions.length > MACRO_ACTIONS_PER_PAGE) throw new RangeError(t('error.macroActionsPerPage'));
  return [
    FAMILY.MACRO, 0x04, byte(id, 'macro id'), byte(page, 'macro page'),
    ...actions.flatMap((a) => {
      const p = packMacroAction(a);
      return [p & 0xff, (p >>> 8) & 0xff, (p >>> 16) & 0xff, (p >>> 24) & 0xff];
    }),
  ];
}

export function encodeMacroPages(id: number, actions: MacroAction[]): number[][] {
  const pages: number[][] = [];
  for (let p = 0; p < macroPageCount(actions.length); p++) {
    pages.push(encodeMacroPage(id, p, actions.slice(p * MACRO_ACTIONS_PER_PAGE, (p + 1) * MACRO_ACTIONS_PER_PAGE)));
  }
  return pages;
}

export function decodeMacroPage(d: Bytes): MacroAction[] {
  const out: MacroAction[] = [];
  for (let i = 0; i < MACRO_ACTIONS_PER_PAGE; i++) {
    const o = 4 + i * 4;
    out.push(unpackMacroAction((d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0));
  }
  return out;
}
