// Gamepad configuration of the experimental AE64 Pro XInput firmware: the AGP1 vendor protocol (family 0x10)
// and the 208-byte AGC1 configuration block. Pure functions only: no I/O, no state.
//
// Byte layout (little-endian everywhere):
// - AGP1 frame (64 bytes): [0] 0x10, [1] command, [2] protocol 1, [3] sequence, [4..7] "AGP1", [8] status
//   (0 in requests), [9] data length 0–54, [10..63] data. A reply echoes bytes 0–7; a nonzero status carries no
//   data. Stock firmware answers family 0x10 with `10 FF` (no gamepad firmware).
// - AGC1 block (208 bytes): "AGC1", version 1, mode, transport, two stick flag bytes, 0, two LE16 dead zones,
//   LE16 binding count 24, then 24 binding records of 8 bytes (key, curve, start µm, full µm, declared µm).
// The physical key index (0–63) is the firmware's logical key: row-major over the sensor columns of each row
// (SENSOR_COLUMNS, the firmware's matrix_columns), which is also PHYSICAL_KEYS order: Esc…Backspace, Tab…\, Caps…Enter,
// Shift…Del, Ctrl…→. keyIndexOf / keyPosOf convert between it and the (row, col) the other commands use.

import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';
import { SENSOR_COLUMNS } from './layout';

export const GP_FAMILY = 0x10;
export const GP_VERSION = 1;
export const GP_MAGIC: readonly number[] = [0x41, 0x47, 0x50, 0x31]; // "AGP1"
export const GP_CONFIG_MAGIC: readonly number[] = [0x41, 0x47, 0x43, 0x31]; // "AGC1"
/** The only board the gamepad firmware exists for (AE64 Pro). */
export const GP_BOARD_ID = 0x0030000a;
export const GP_BOARD_HEX = '0030000a';
export const GP_HEADER_BYTES = 10;
export const GP_MAX_DATA = 54;
export const GP_CONFIG_BYTES = 208;
export const GP_READ_CHUNK = 48;
export const GP_WRITE_CHUNK = 40;
export const GP_BINDING_COUNT = 24;
export const GP_KEY_COUNT = 64;
export const GP_NO_KEY = 255;
export const GP_LEVEL_MAX = 10000;
export const GP_TRAVEL_MIN_UM = 10;
export const GP_TRAVEL_MAX_UM = 10000;
/** Highest stick dead zone (1/10000 of full deflection): the firmware requires < 9500. */
export const GP_DEADZONE_MAX = 9499;
/** The keyboard drops an upload that saw no BEGIN/WRITE for longer than this. */
export const GP_TRANSACTION_TIMEOUT_MS = 5000;

export const GP_CMD = {
  INFO: 0x20, BEGIN: 0x21, WRITE: 0x22, COMMIT: 0x23, ABORT: 0x24, READ: 0x25, USB_STATUS: 0x26, USB_SET: 0x27,
} as const;

export const GP_STATUS = {
  OK: 0, UNSUPPORTED: 1, FORMAT: 2, CONFLICT: 3, CONFIG: 4, INCOMPLETE: 5, CRC: 6, BACKEND: 7, STORAGE: 8,
} as const;

const CMD_NAMES: Readonly<Record<number, string>> = {
  0x20: 'INFO', 0x21: 'BEGIN', 0x22: 'WRITE', 0x23: 'COMMIT', 0x24: 'ABORT', 0x25: 'READ', 0x26: 'USB_STATUS', 0x27: 'USB_SET',
};

/** Human reason for a nonzero AGP1 status. */
export function statusText(status: number): string {
  return status >= 1 && status <= 8 ? t(`gp.status.${status}` as MessageKey) : t('gp.statusUnknown', { status });
}

/** The stock firmware answered `10 FF`: no gamepad firmware on this keyboard. */
export class GamepadUnsupportedError extends Error {
  constructor() {
    super(t('gp.noFirmware'));
    this.name = 'GamepadUnsupportedError';
  }
}

/** The gamepad firmware answered with a nonzero status. */
export class GamepadStatusError extends Error {
  constructor(readonly status: number, readonly cmd: number) {
    super(t('gp.refused', { cmd: CMD_NAMES[cmd] ?? cmd.toString(16), reason: statusText(status) }));
    this.name = 'GamepadStatusError';
  }
}

/** INFO capability bits. */
export const GP_CAP = { HID: 1, XINPUT: 2, PERSISTENT: 4, USB_SWITCH: 8, USB_PERSISTENT: 16 } as const;

// ------------------------------------------------------------------ controls

export type GpControlKind = 'trigger' | 'stick' | 'button' | 'dpad';

/** The 24 outputs in AGC1 record order. */
export const GP_CONTROLS = [
  { id: 'LT', kind: 'trigger' }, { id: 'RT', kind: 'trigger' },
  { id: 'LX-', kind: 'stick' }, { id: 'LX+', kind: 'stick' }, { id: 'LY-', kind: 'stick' }, { id: 'LY+', kind: 'stick' },
  { id: 'RX-', kind: 'stick' }, { id: 'RX+', kind: 'stick' }, { id: 'RY-', kind: 'stick' }, { id: 'RY+', kind: 'stick' },
  { id: 'A', kind: 'button' }, { id: 'B', kind: 'button' }, { id: 'X', kind: 'button' }, { id: 'Y', kind: 'button' },
  { id: 'LB', kind: 'button' }, { id: 'RB', kind: 'button' }, { id: 'BACK', kind: 'button' }, { id: 'START', kind: 'button' },
  { id: 'L3', kind: 'button' }, { id: 'R3', kind: 'button' },
  { id: 'DPAD_UP', kind: 'dpad' }, { id: 'DPAD_DOWN', kind: 'dpad' }, { id: 'DPAD_LEFT', kind: 'dpad' }, { id: 'DPAD_RIGHT', kind: 'dpad' },
] as const satisfies readonly { id: string; kind: GpControlKind }[];

export type GpControl = (typeof GP_CONTROLS)[number]['id'];

/** Record index of an output. */
export function controlIndex(id: GpControl): number {
  return GP_CONTROLS.findIndex((c) => c.id === id);
}

/** Triggers and stick directions (records 0–9) use the travel curve; buttons and the D-pad are on/off. */
export function isAnalogIndex(index: number): boolean {
  return index >= 0 && index < 10;
}

// ------------------------------------------------------------------ key index

const KEY_POS: readonly { row: number; col: number }[] = SENSOR_COLUMNS.flatMap((cols, r) => cols.map((col) => ({ row: r + 1, col })));

/** The record key index of the key at firmware (row 1–5, sensor column), or null when no key is there. */
export function keyIndexOf(row: number, col: number): number | null {
  const i = KEY_POS.findIndex((p) => p.row === row && p.col === col);
  return i < 0 ? null : i;
}

/** Firmware (row, sensor column) of a record key index, or null when it is not 0–63. */
export function keyPosOf(index: number): { row: number; col: number } | null {
  const p = Number.isInteger(index) ? KEY_POS[index] : undefined;
  return p ? { ...p } : null;
}

// ------------------------------------------------------------------ configuration model

export type GpMode = 'off' | 'controller' | 'mixed';
export type GpTransport = 'hid' | 'xinput';
export type GpOpposition = 'difference' | 'neutral' | 'deeper';
export type GpCurve = 'linear' | 'smooth';

export const GP_MODES: readonly GpMode[] = ['off', 'controller', 'mixed'];
export const GP_OPPOSITIONS: readonly GpOpposition[] = ['difference', 'neutral', 'deeper'];
const TRANSPORT_BYTE: Readonly<Record<GpTransport, number>> = { hid: 1, xinput: 2 };

export interface GpBinding {
  /** Physical key index 0–63, or null when the output is not assigned. */
  key: number | null;
  curve: GpCurve;
  /** Depth (µm) where the output starts to move. */
  startUm: number;
  /** Depth (µm) of full output. */
  endUm: number;
  /** Switch travel the record was made for (µm, 10–10000). */
  declaredUm: number;
}

export interface GpStick {
  circular: boolean;
  opposition: GpOpposition;
  /** Radial dead zone in 1/10000 of full deflection, 0–9499; a square stick must use 0. */
  deadzone: number;
}

export interface GamepadConfig {
  mode: GpMode;
  transport: GpTransport;
  sticks: [GpStick, GpStick];
  /** 24 records in GP_CONTROLS order. */
  bindings: GpBinding[];
}

/** One reason a configuration cannot be written; `index` is the record (GP_CONTROLS order). */
export type GpIssue =
  | { code: 'mode' }
  | { code: 'transport' }
  | { code: 'bindingCount' }
  | { code: 'stickDeadzone'; stick: number }
  | { code: 'squareDeadzone'; stick: number }
  | { code: 'opposition'; stick: number }
  | { code: 'key'; index: number }
  | { code: 'duplicateKey'; index: number; key: number }
  | { code: 'curve'; index: number }
  | { code: 'declared'; index: number }
  | { code: 'range'; index: number };

export class GamepadConfigError extends Error {
  constructor(readonly issues: readonly GpIssue[], message = `${t('gp.invalid')} (${issues.map((i) => i.code).join(', ')})`) {
    super(message);
    this.name = 'GamepadConfigError';
  }
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/** Every reason the keyboard would refuse this configuration (empty = valid). Mirrors the firmware's decoder. */
export function validateConfig(cfg: GamepadConfig): GpIssue[] {
  const issues: GpIssue[] = [];
  if (!GP_MODES.includes(cfg.mode)) issues.push({ code: 'mode' });
  if (!Object.hasOwn(TRANSPORT_BYTE, cfg.transport)) issues.push({ code: 'transport' });
  cfg.sticks.forEach((s, stick) => {
    if (!GP_OPPOSITIONS.includes(s.opposition)) issues.push({ code: 'opposition', stick });
    if (!isInt(s.deadzone) || s.deadzone < 0 || s.deadzone > GP_DEADZONE_MAX) issues.push({ code: 'stickDeadzone', stick });
    else if (!s.circular && s.deadzone !== 0) issues.push({ code: 'squareDeadzone', stick });
  });
  if (cfg.bindings.length !== GP_BINDING_COUNT) {
    issues.push({ code: 'bindingCount' });
    return issues;
  }
  const owner = new Map<number, number>();
  cfg.bindings.forEach((b, index) => {
    if (b.key !== null) {
      if (!isInt(b.key) || b.key < 0 || b.key >= GP_KEY_COUNT) issues.push({ code: 'key', index });
      else if (owner.has(b.key)) issues.push({ code: 'duplicateKey', index, key: b.key });
      else owner.set(b.key, index);
    }
    if (b.curve !== 'linear' && b.curve !== 'smooth') issues.push({ code: 'curve', index });
    if (!isInt(b.declaredUm) || b.declaredUm < GP_TRAVEL_MIN_UM || b.declaredUm > GP_TRAVEL_MAX_UM) issues.push({ code: 'declared', index });
    else if (!isInt(b.startUm) || !isInt(b.endUm) || b.startUm < 0 || b.startUm >= b.endUm || b.endUm > b.declaredUm) issues.push({ code: 'range', index });
  });
  return issues;
}

/** A record's geometry for a switch of `declaredUm` travel: start 0.5 mm, full 3.5 mm, both inside the travel. */
export function defaultBinding(declaredUm = 4000): GpBinding {
  const declared = Math.min(GP_TRAVEL_MAX_UM, Math.max(GP_TRAVEL_MIN_UM, Math.round(declaredUm)));
  const endUm = Math.min(3500, declared);
  return { key: null, curve: 'linear', startUm: Math.min(500, endUm - 10), endUm, declaredUm: declared };
}

/** No output assigned; controller mode over XInput, round sticks with a 5 % dead zone. */
export function emptyConfig(): GamepadConfig {
  const stick = (): GpStick => ({ circular: true, opposition: 'difference', deadzone: 500 });
  return { mode: 'controller', transport: 'xinput', sticks: [stick(), stick()], bindings: GP_CONTROLS.map(() => defaultBinding()) };
}

export function cloneConfig(cfg: GamepadConfig): GamepadConfig {
  return { mode: cfg.mode, transport: cfg.transport, sticks: [{ ...cfg.sticks[0] }, { ...cfg.sticks[1] }], bindings: cfg.bindings.map((b) => ({ ...b })) };
}

// ------------------------------------------------------------------ CRC-32 and little-endian helpers

/** CRC-32 (IEEE 802.3: reflected polynomial 0xEDB88320, init and final XOR 0xFFFFFFFF). */
export function crc32(bytes: ArrayLike<number>): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] & 0xff;
    for (let b = 0; b < 8; b++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export const u16 = (b: ArrayLike<number>, o: number): number => (b[o] | (b[o + 1] << 8)) & 0xffff;
export const u32 = (b: ArrayLike<number>, o: number): number => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const le16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const le32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const sameBytes = (a: ArrayLike<number>, ao: number, b: readonly number[]): boolean => b.every((v, i) => a[ao + i] === v);

// ------------------------------------------------------------------ AGC1 block

/** The 208-byte block, written field by field. Throws GamepadConfigError when the keyboard would refuse it. */
export function encodeConfig(cfg: GamepadConfig): Uint8Array {
  const issues = validateConfig(cfg);
  if (issues.length) throw new GamepadConfigError(issues);
  const out = new Uint8Array(GP_CONFIG_BYTES);
  out.set(GP_CONFIG_MAGIC, 0);
  out[4] = GP_VERSION;
  out[5] = GP_MODES.indexOf(cfg.mode);
  out[6] = TRANSPORT_BYTE[cfg.transport];
  cfg.sticks.forEach((s, i) => {
    out[7 + i] = (s.circular ? 1 : 0) | (GP_OPPOSITIONS.indexOf(s.opposition) << 1);
    out.set(le16(s.deadzone), 10 + i * 2);
  });
  out[9] = 0;
  out.set(le16(GP_BINDING_COUNT), 14);
  cfg.bindings.forEach((b, i) => {
    const o = 16 + i * 8;
    out[o] = b.key === null ? GP_NO_KEY : b.key;
    out[o + 1] = b.curve === 'smooth' ? 1 : 0;
    out.set(le16(b.startUm), o + 2);
    out.set(le16(b.endUm), o + 4);
    out.set(le16(b.declaredUm), o + 6);
  });
  return out;
}

/** Parse a block read from the keyboard; throws GamepadConfigError on anything the firmware would not accept. */
export function decodeConfig(bytes: ArrayLike<number>): GamepadConfig {
  const bad = (what: string): never => { throw new GamepadConfigError([], `${t('gp.damaged')} (${what})`); };
  if (bytes.length !== GP_CONFIG_BYTES) bad(`length ${bytes.length}`);
  if (!sameBytes(bytes, 0, GP_CONFIG_MAGIC)) bad('magic');
  if (bytes[4] !== GP_VERSION) bad(`version ${bytes[4]}`);
  if (bytes[5] > 2) bad(`mode ${bytes[5]}`);
  if (bytes[6] !== 1 && bytes[6] !== 2) bad(`transport ${bytes[6]}`);
  if (bytes[9] !== 0) bad('reserved byte');
  if (u16(bytes, 14) !== GP_BINDING_COUNT) bad(`binding count ${u16(bytes, 14)}`);
  const sticks = [0, 1].map((i): GpStick => {
    const f = bytes[7 + i];
    if ((f & ~7) !== 0 || f >> 1 > 2) bad(`stick ${i} flags ${f}`);
    return { circular: (f & 1) !== 0, opposition: GP_OPPOSITIONS[f >> 1], deadzone: u16(bytes, 10 + i * 2) };
  }) as [GpStick, GpStick];
  const bindings = GP_CONTROLS.map((_, i): GpBinding => {
    const o = 16 + i * 8;
    const key = bytes[o];
    if (key >= GP_KEY_COUNT && key !== GP_NO_KEY) bad(`record ${i} key ${key}`);
    if (bytes[o + 1] > 1) bad(`record ${i} curve ${bytes[o + 1]}`);
    return {
      key: key === GP_NO_KEY ? null : key,
      curve: bytes[o + 1] === 1 ? 'smooth' : 'linear',
      startUm: u16(bytes, o + 2),
      endUm: u16(bytes, o + 4),
      declaredUm: u16(bytes, o + 6),
    };
  });
  const cfg: GamepadConfig = { mode: GP_MODES[bytes[5]], transport: bytes[6] === 1 ? 'hid' : 'xinput', sticks, bindings };
  const issues = validateConfig(cfg);
  if (issues.length) throw new GamepadConfigError(issues);
  return cfg;
}

/** The transport the block needs from the firmware, or null when its mode is off (any firmware accepts it). */
export function requiredTransportBit(cfg: Pick<GamepadConfig, 'mode' | 'transport'>): number | null {
  if (cfg.mode === 'off') return null;
  return cfg.transport === 'hid' ? GP_CAP.HID : GP_CAP.XINPUT;
}

// ------------------------------------------------------------------ AGP1 frames

export class GamepadReplyError extends Error {
  constructor(detail: string, message = `${t('gp.badReply')} (${detail})`) {
    super(message);
    this.name = 'GamepadReplyError';
  }
}

/** Request payload (header + data; the transport pads it to 64 bytes). */
export function encodeFrame(cmd: number, seq: number, data: ArrayLike<number> = []): number[] {
  if (data.length > GP_MAX_DATA) throw new RangeError(`AGP1 data exceeds ${GP_MAX_DATA} bytes`);
  return [GP_FAMILY, cmd, GP_VERSION, seq & 0xff, ...GP_MAGIC, 0, data.length, ...Array.from(data, (b) => b & 0xff)];
}

/** The full 64-byte report for a request (zero padded), as the firmware receives it. */
export function encodeFrame64(cmd: number, seq: number, data: ArrayLike<number> = []): Uint8Array {
  const out = new Uint8Array(64);
  out.set(encodeFrame(cmd, seq, data));
  return out;
}

/** True when `reply` is the stock firmware's answer to an unknown family-0x10 command. */
export function isStockReply(reply: ArrayLike<number>): boolean {
  return reply[0] === GP_FAMILY && reply[1] === 0xff;
}

/** True when `reply` answers the AGP1 `request`: a stock `10 FF`, or the same command, sequence and magic. */
export function agp1ReplyMatches(request: ArrayLike<number>, reply: ArrayLike<number>): boolean {
  if (reply[0] !== GP_FAMILY) return false;
  if (isStockReply(reply)) return true;
  return reply[1] === request[1] && reply[3] === request[3] && sameBytes(reply, 4, GP_MAGIC);
}

export type GpReply = { stock: true } | { stock: false; status: number; data: number[] };

/** Checks the echoed header; a nonzero status has no data. Throws GamepadReplyError on a malformed reply. */
export function decodeReply(request: ArrayLike<number>, reply: ArrayLike<number>): GpReply {
  if (isStockReply(reply)) return { stock: true };
  for (let i = 0; i < 8; i++) if (reply[i] !== request[i]) throw new GamepadReplyError(`AGP1 reply header byte ${i} does not echo the request`);
  const n = reply[9];
  if (n > GP_MAX_DATA || reply.length < GP_HEADER_BYTES + n) throw new GamepadReplyError(`AGP1 reply length ${n} invalid`);
  const status = reply[8];
  return { stock: false, status, data: status ? [] : Array.from(reply).slice(GP_HEADER_BYTES, GP_HEADER_BYTES + n) };
}

// ------------------------------------------------------------------ command data

export interface GamepadInfo {
  boardId: number;
  /** Raw capability bits (GP_CAP). */
  caps: number;
  transports: { hid: boolean; xinput: boolean };
  /** The configuration survives unplugging. */
  persistent: boolean;
  usbSwitch: boolean;
  usbPersistent: boolean;
  revision: number;
  maxTravelUm: number;
  configBytes: number;
  crc: number;
}

/** INFO data, or null when it is not the gamepad firmware this app knows (board, 24 records, version 1, 208 bytes). */
export function decodeInfo(data: ArrayLike<number>): GamepadInfo | null {
  if (data.length !== 20) return null;
  if (u32(data, 0) !== GP_BOARD_ID || data[5] !== GP_BINDING_COUNT || data[6] !== GP_VERSION || data[7] !== 0) return null;
  if (u16(data, 14) !== GP_CONFIG_BYTES) return null;
  const caps = data[4];
  if ((caps & ~31) !== 0) return null;
  const maxTravelUm = u16(data, 12);
  if (maxTravelUm < GP_TRAVEL_MIN_UM || maxTravelUm > GP_TRAVEL_MAX_UM) return null;
  return {
    boardId: GP_BOARD_ID,
    caps,
    transports: { hid: (caps & GP_CAP.HID) !== 0, xinput: (caps & GP_CAP.XINPUT) !== 0 },
    persistent: (caps & GP_CAP.PERSISTENT) !== 0,
    usbSwitch: (caps & GP_CAP.USB_SWITCH) !== 0,
    usbPersistent: (caps & GP_CAP.USB_PERSISTENT) !== 0,
    revision: u32(data, 8),
    maxTravelUm,
    configBytes: GP_CONFIG_BYTES,
    crc: u32(data, 16),
  };
}

const checkToken = (token: ArrayLike<number>): number[] => {
  if (token.length !== 8) throw new RangeError('AGP1 token must be 8 bytes');
  return Array.from(token, (b) => b & 0xff);
};

export function readData(revision: number, offset: number, count: number): number[] {
  return [...le32(revision), ...le16(offset), count & 0xff];
}

/** READ data: the block bytes, after checking the echoed revision, offset and length. */
export function decodeReadReply(data: ArrayLike<number>, revision: number, offset: number, count: number): number[] {
  if (data.length !== 6 + count || u32(data, 0) !== revision >>> 0 || u16(data, 4) !== offset) {
    throw new GamepadReplyError('READ echo', t('gp.readChanged'));
  }
  return Array.from(data).slice(6);
}

export function beginData(revision: number, crc: number, token: ArrayLike<number>): number[] {
  return [...le32(revision), ...le32(crc), ...le16(GP_CONFIG_BYTES), ...checkToken(token)];
}

export function writeData(token: ArrayLike<number>, offset: number, chunk: ArrayLike<number>): number[] {
  return [...checkToken(token), ...le16(offset), ...Array.from(chunk, (b) => b & 0xff)];
}

export function commitData(token: ArrayLike<number>, crc: number, revision: number): number[] {
  return [...checkToken(token), ...le32(crc), ...le32(revision)];
}

export function abortData(token: ArrayLike<number>): number[] {
  return checkToken(token);
}

/** COMMIT data: the new revision (must be the old one + 1) and whether it survives unplugging. Null when unconfirmed. */
export function decodeCommitReply(data: ArrayLike<number>, oldRevision: number): { revision: number; persistent: boolean } | null {
  if (data.length !== 5 || u32(data, 0) !== ((oldRevision + 1) >>> 0) || data[4] > 1) return null;
  return { revision: u32(data, 0), persistent: data[4] === 1 };
}

export interface GamepadUsbState {
  enabled: boolean;
  targetEnabled: boolean;
  /** 0 idle, 1 acknowledged / preparing, 2 detached. */
  phase: number;
  revision: number;
}

/** USB_STATUS / USB_SET data; throws GamepadReplyError when malformed or inconsistent. */
export function decodeUsbState(data: ArrayLike<number>): GamepadUsbState {
  if (data.length !== 12 || u32(data, 0) !== GP_BOARD_ID || data[4] !== GP_VERSION || data[5] > 1 || data[6] > 1 || data[7] > 2
    || (data[7] === 0 && data[5] !== data[6])) {
    throw new GamepadReplyError('USB state');
  }
  return { enabled: data[5] === 1, targetEnabled: data[6] === 1, phase: data[7], revision: u32(data, 8) };
}

export function usbSetData(enabled: boolean, revision: number): number[] {
  return [...le32(GP_BOARD_ID), enabled ? 1 : 0, 0, ...le32(revision)];
}

/** A USB_SET reply accepts the request: the target is `enabled`, and either nothing changed or a change was queued (phase 1, revision + 1). */
export function usbSetAccepted(state: GamepadUsbState, enabled: boolean, revision: number): boolean {
  if (state.targetEnabled !== enabled) return false;
  const noChange = state.phase === 0 && state.enabled === enabled && state.revision === revision >>> 0;
  return noChange || (state.phase === 1 && state.revision === ((revision + 1) >>> 0));
}

// ------------------------------------------------------------------ output preview

const SMOOTH_X = [0, 3333, 6667, 10000];
const SMOOTH_Y = [0, 2592, 7408, 10000];

/**
 * Output level 0–10000 of a record for a key pressed `depth` deep, the firmware's integer curve. `depth`, `start` and
 * `end` are in the same unit: the firmware uses depths normalised to the key's measured maximum (normalizeTravel).
 */
export function level(b: { curve: GpCurve; start: number; end: number }, depth: number): number {
  if (!Number.isFinite(depth) || depth <= b.start) return 0;
  if (depth >= b.end) return GP_LEVEL_MAX;
  const v = Math.floor(((depth - b.start) * GP_LEVEL_MAX) / (b.end - b.start));
  if (b.curve === 'linear') return v;
  for (let i = 1; i < 4; i++) {
    if (v <= SMOOTH_X[i]) return SMOOTH_Y[i - 1] + Math.floor(((v - SMOOTH_X[i - 1]) * (SMOOTH_Y[i] - SMOOTH_Y[i - 1])) / (SMOOTH_X[i] - SMOOTH_X[i - 1]));
  }
  return GP_LEVEL_MAX;
}

/** A depth in µm as the firmware sees it: 1/10000 of the key's measured maximum travel (rounded down). */
export function normalizeTravel(um: number, maxUm: number): number {
  return Math.floor((um * GP_LEVEL_MAX) / maxUm);
}

/** Why the controller reports nothing at all: mode off, a bound key without a usable maximum, or one pressed past it. */
export type GpNeutralReason = 'off' | 'noTravel' | 'overTravel';

export interface GamepadOutput {
  /** Stick axes, −10000…10000 (+ is right / up). */
  lx: number; ly: number; rx: number; ry: number;
  /** Triggers 0–255. */
  lt: number; rt: number;
  /** Buttons and D-pad directions held, in GP_CONTROLS order. */
  buttons: GpControl[];
  dpad: GpControl[];
  /** Level 0–10000 of every record (GP_CONTROLS order). */
  levels: number[];
  /** Set when the firmware sends a neutral report for this frame (everything above is then 0 / empty). */
  neutral: GpNeutralReason | null;
}

const neutralOutput = (reason: GpNeutralReason | null): GamepadOutput => ({
  lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [], dpad: [], levels: GP_CONTROLS.map(() => 0), neutral: reason,
});

/**
 * What the controller reports for the given key depths (µm), pressed keys and measured maximum travel per key (µm,
 * `04 01` axisRangeMax): a preview that computes like the firmware (gp_physical_update + gp_update). Every bound key
 * needs a maximum of 10–10000 µm and an analog record's full depth must fit in it, otherwise the firmware has no
 * mapping; a bound key deeper than its maximum makes the whole frame neutral. Not modelled (it needs history): after a
 * new configuration or a neutral frame the firmware stays neutral until every bound key is released.
 */
export function evaluate(
  cfg: GamepadConfig,
  travelUm: (key: number) => number,
  pressed: (key: number) => boolean,
  maxUm: (key: number) => number | undefined,
): GamepadOutput {
  if (cfg.mode === 'off') return neutralOutput('off');
  const max = new Map<number, number>();
  for (const [i, b] of cfg.bindings.entries()) {
    if (b.key === null) continue;
    const m = maxUm(b.key);
    if (m === undefined || !isInt(m) || m < GP_TRAVEL_MIN_UM || m > GP_TRAVEL_MAX_UM) return neutralOutput('noTravel');
    if (isAnalogIndex(i) && b.endUm > m) return neutralOutput('noTravel');
    max.set(b.key, m);
  }
  for (const [key, m] of max) if (travelUm(key) > m) return neutralOutput('overTravel');
  const levels = cfg.bindings.map((b, i) => {
    if (!isAnalogIndex(i) || b.key === null) return 0;
    const m = max.get(b.key)!;
    const depth = Math.min(normalizeTravel(Math.max(0, travelUm(b.key)), m), GP_LEVEL_MAX);
    return level({ curve: b.curve, start: normalizeTravel(b.startUm, m), end: normalizeTravel(b.endUm, m) }, depth);
  });
  const out: GamepadOutput = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [], dpad: [], levels, neutral: null };
  const axis = (neg: number, pos: number, policy: GpOpposition): number => {
    const n = levels[neg];
    const p = levels[pos];
    if (policy === 'neutral' && n && p) return 0;
    if (policy === 'deeper') return p === n ? 0 : p > n ? p : -n;
    return p - n;
  };
  for (const s of [0, 1]) {
    const stick = cfg.sticks[s];
    const base = 2 + s * 4;
    let x = axis(base, base + 1, stick.opposition);
    let y = axis(base + 2, base + 3, stick.opposition);
    if (stick.circular) {
      const r = Math.ceil(Math.sqrt(x * x + y * y));
      if (r <= stick.deadzone) {
        x = 0;
        y = 0;
      } else {
        const magnitude = Math.floor(((Math.min(r, GP_LEVEL_MAX) - stick.deadzone) * GP_LEVEL_MAX) / (GP_LEVEL_MAX - stick.deadzone));
        x = Math.trunc((x * magnitude) / r);
        y = Math.trunc((y * magnitude) / r);
      }
    }
    if (s === 0) { out.lx = x; out.ly = y; } else { out.rx = x; out.ry = y; }
  }
  out.lt = Math.floor((levels[0] * 255) / GP_LEVEL_MAX);
  out.rt = Math.floor((levels[1] * 255) / GP_LEVEL_MAX);
  cfg.bindings.forEach((b, i) => {
    if (isAnalogIndex(i) || b.key === null || !pressed(b.key)) return;
    const c = GP_CONTROLS[i];
    (c.kind === 'dpad' ? out.dpad : out.buttons).push(c.id);
  });
  const cancel = (a: GpControl, b: GpControl) => {
    if (out.dpad.includes(a) && out.dpad.includes(b)) out.dpad = out.dpad.filter((d) => d !== a && d !== b);
  };
  cancel('DPAD_UP', 'DPAD_DOWN');
  cancel('DPAD_LEFT', 'DPAD_RIGHT');
  return out;
}

/** The firmware's own report (struct gp_report, before the XInput / HID encoding). */
export interface FirmwareReport {
  /** Stick axes as int16, + is right / up. */
  lx: number; ly: number; rx: number; ry: number;
  lt: number; rt: number;
  /** Bit i = button i of A, B, X, Y, LB, RB, BACK, START, L3, R3 (the firmware's enum, not XInput's masks). */
  buttons: number;
  /** Bits UP 1, DOWN 2, LEFT 4, RIGHT 8. */
  dpad: number;
}

const BUTTON_ORDER = GP_CONTROLS.filter((c) => c.kind === 'button').map((c) => c.id);
const DPAD_ORDER = GP_CONTROLS.filter((c) => c.kind === 'dpad').map((c) => c.id);
const signedAxis = (v: number): number => Math.trunc((v * (v >= 0 ? 32767 : 32768)) / GP_LEVEL_MAX);

/** The preview in the units the firmware reports (signed_axis: ±10000 → int16). */
export function toFirmwareReport(out: GamepadOutput): FirmwareReport {
  const bits = (held: readonly GpControl[], order: readonly GpControl[]) => held.reduce((m, id) => m | (1 << order.indexOf(id)), 0);
  return {
    lx: signedAxis(out.lx) + 0, ly: signedAxis(out.ly) + 0, rx: signedAxis(out.rx) + 0, ry: signedAxis(out.ry) + 0,
    lt: out.lt, rt: out.rt, buttons: bits(out.buttons, BUTTON_ORDER), dpad: bits(out.dpad, DPAD_ORDER),
  };
}

// ------------------------------------------------------------------ travel limits

export type GpTravelIssue =
  | { code: 'noTravel'; index: number; key: number }
  | { code: 'overTravel'; index: number; key: number; limitUm: number };

/**
 * Checks every assigned record against the travel range the keyboard reports for its key (`04 01` axisRangeMax, µm):
 * the range must be known (10–10000 µm) for every assigned key, and an analog record's full-output depth must fit in it.
 */
export function checkTravelLimits(cfg: GamepadConfig, limitUm: (key: number) => number | undefined): GpTravelIssue[] {
  const issues: GpTravelIssue[] = [];
  cfg.bindings.forEach((b, index) => {
    if (b.key === null) return;
    const limit = limitUm(b.key);
    if (limit === undefined || !isInt(limit) || limit < GP_TRAVEL_MIN_UM || limit > GP_TRAVEL_MAX_UM) {
      issues.push({ code: 'noTravel', index, key: b.key });
      return;
    }
    if (isAnalogIndex(index) && b.endUm > limit) issues.push({ code: 'overTravel', index, key: b.key, limitUm: limit });
  });
  return issues;
}

// ------------------------------------------------------------------ Gamepad API view

/** Buttons of the W3C "standard" gamepad layout, in button-index order (16 Home is never pressed by the keyboard). */
const STANDARD_BUTTONS: readonly (GpControl | 'LT_ANALOG' | 'RT_ANALOG' | null)[] = [
  'A', 'B', 'X', 'Y', 'LB', 'RB', 'LT_ANALOG', 'RT_ANALOG', 'BACK', 'START', 'L3', 'R3', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT', null,
];

export interface StandardGamepadState {
  /** [left x, left y, right x, right y], −1…1; y is positive DOWN as in the Gamepad API. */
  axes: number[];
  buttons: { pressed: boolean; touched: boolean; value: number }[];
}

/** The controller output as the browser's Gamepad API reports it ("standard" mapping). */
export function toStandardGamepad(out: GamepadOutput): StandardGamepadState {
  const held = new Set<GpControl>([...out.buttons, ...out.dpad]);
  const axes = [out.lx / GP_LEVEL_MAX, -out.ly / GP_LEVEL_MAX, out.rx / GP_LEVEL_MAX, -out.ry / GP_LEVEL_MAX].map((v) => v + 0); // + 0: no −0
  const buttons = STANDARD_BUTTONS.map((b) => {
    const value = b === 'LT_ANALOG' ? out.lt / 255 : b === 'RT_ANALOG' ? out.rt / 255 : b !== null && held.has(b) ? 1 : 0;
    return { pressed: value > 0, touched: value > 0, value };
  });
  return { axes, buttons };
}
