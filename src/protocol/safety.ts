// Last line of defence between the app and the keyboard. Every frame passes `checkFrame` before it is
// sent: only commands this app is known to need are allowed, with their arguments range-checked.
// Anything else (firmware family 08, unknown commands, out-of-range indexes) is refused here, no matter
// which page or store built it. Performance writes are additionally checked against the record last
// read from the device, so the sensor calibration fields can never be changed (see BaseTransport).

import type { Performance } from './types';
import { decodeCombo, isKnownKeycode } from './keycodes';
import { isCatalogTriple, switchCatalogFor } from './switches';
import {
  GP_BOARD_HEX, GP_BOARD_ID, GP_CAP, GP_CMD, GP_CONFIG_BYTES, GP_MAGIC, GP_MAX_DATA, GP_READ_CHUNK, GP_VERSION, crc32, decodeConfig,
  requiredTransportBit, u16, u32,
} from './gamepad';

export class UnsafeCommandError extends Error {
  constructor(readonly payload: readonly number[], readonly reason: string) {
    super(`Blocked unsafe command ${hex(payload.slice(0, 4))}: ${reason}`);
    this.name = 'UnsafeCommandError';
  }
}

function hex(bytes: readonly number[]): string {
  return bytes.map((b) => (b & 0xff).toString(16).padStart(2, '0')).join(' ');
}

const inRange = (v: number | undefined, lo: number, hi: number): boolean => v !== undefined && v >= lo && v <= hi;

/** Firmware rows 1–5 (row 0 does not exist on the wire), columns 0–20. */
const keyPos = (p: readonly number[], i: number): string | null =>
  inRange(p[i], 1, 5) && inRange(p[i + 1], 0, 20) ? null : `key position ${p[i]},${p[i + 1]} out of range`;

const oneOf = (v: number | undefined, allowed: readonly number[], what: string): string | null =>
  v !== undefined && allowed.includes(v) ? null : `${what} ${v} not allowed`;

const range = (v: number | undefined, lo: number, hi: number, what: string): string | null =>
  inRange(v, lo, hi) ? null : `${what} ${v} out of range ${lo}–${hi}`;

/**
 * Keycodes the app never writes to a key: factory reset, wireless mode/pairing switches and the Link key.
 * They may already be on the board (decode-only in keycodes.ts) but are never assigned by this app.
 */
export const BLOCKED_KEYCODES: ReadonlySet<number> = new Set([
  0xf200, // factory reset (hold)
  0xf20a, // Link
  0xf401, 0xf402, 0xf403, 0xf404, 0xf405, // USB / 2.4G / BT1–3 mode switches
  0xf406, // clear pairing data
  0xf407, // battery status
]);

/**
 * True when `checkFrame` accepts this keycode in a write. A non-zero high byte is a firmware function,
 * so only catalogue codes or left-modifier combos pass; blocked codes never do.
 */
export function isWritableKeycode(code: number): boolean {
  return !BLOCKED_KEYCODES.has(code) && (code <= 0xff || isKnownKeycode(code) || decodeCombo(code) !== null);
}

/** Little-endian uint16 keycodes at the given payload offsets must not be blocked. */
const keycodesAt = (p: readonly number[], offsets: readonly number[]): string | null => {
  for (const o of offsets) {
    const code = (p[o] ?? 0) | ((p[o + 1] ?? 0) << 8);
    const h = code.toString(16).toUpperCase().padStart(4, '0');
    if (BLOCKED_KEYCODES.has(code)) return `keycode ${h} is never written by this app`;
    if (!isWritableKeycode(code)) return `keycode ${h} is not a known keycode or modifier combo`;
  }
  return null;
};

/** Keycode offsets of an advanced-key write `06 02 row col type …`. */
function advancedKeycodes(p: readonly number[]): string | null {
  if (p[4] === 1) return keycodesAt(p, [5, 7, 9, 11]); // DKS
  if (p[4] === 2) return keycodesAt(p, [5, 7, 9]); // MPT
  if (p[4] === 6 || p[4] === 7) return keycodesAt(p, [7, 9]); // SOCD / Rappy Snappy
  return null;
}

/**
 * Header and length checks of an AGP1 request (family 10, experimental AE64 Pro gamepad firmware): protocol 1, magic "AGP1",
 * status 0, a data length that is the payload's own length (≤ 54), then the command's own check on (payload, length).
 * The conditions that depend on the connection (board, INFO, staging) are in checkGamepadFrame.
 */
const agp1 = (check: (p: readonly number[], n: number) => string | null) => (p: readonly number[]): string | null => {
  if (p[2] !== GP_VERSION) return `AGP1 protocol ${p[2]} not allowed`;
  if (!GP_MAGIC.every((b, i) => p[4 + i] === b)) return 'AGP1 magic missing';
  if (p[8] !== 0) return 'AGP1 request status must be 0';
  const n = p[9] ?? -1;
  if (n < 0 || n > GP_MAX_DATA || p.length !== 10 + n) return `AGP1 data length ${p[9]} does not match the payload`;
  return check(p, n);
};
const agpLength = (want: number) => (_: readonly number[], n: number): string | null => (n === want ? null : `AGP1 data length ${n}, expected ${want}`);

interface Rule {
  /** Matched against the first bytes of the payload. */
  prefix: readonly number[];
  write: boolean;
  /** Extra argument checks; returns a reason to refuse, or null. */
  check?: (p: readonly number[]) => string | null;
}

/** Every command the app sends. Keep in sync with client.ts; anything missing here is refused. */
const RULES: readonly Rule[] = [
  // 01 device (read)
  { prefix: [0x01, 0x01], write: false },
  { prefix: [0x01, 0x02], write: false },
  { prefix: [0x01, 0x03], write: false },
  // 02 global
  { prefix: [0x02, 0x02], write: true, check: (p) => range(p[2], 0, 7, 'save group') },
  { prefix: [0x02, 0x03, 0x00], write: false },
  { prefix: [0x02, 0x03, 0x01], write: false },
  { prefix: [0x02, 0x03, 0x02], write: true, check: (p) => range(p[3], 0, 3, 'profile') },
  { prefix: [0x02, 0x03, 0x03], write: false, check: (p) => range(p[3], 0, 3, 'profile') },
  { prefix: [0x02, 0x03, 0x04], write: true, check: (p) => range(p[3], 0, 3, 'profile') },
  { prefix: [0x02, 0x04, 0x01], write: false },
  { prefix: [0x02, 0x04, 0x02], write: true, check: (p) => oneOf(p[3], [0, 1], 'system mode') },
  { prefix: [0x02, 0x05, 0x00], write: false },
  { prefix: [0x02, 0x05, 0x01], write: false },
  { prefix: [0x02, 0x05, 0x02], write: true, check: (p) => range(p[3], 0, 5, 'polling rate') },
  { prefix: [0x02, 0x06, 0x00], write: true }, // calibration start
  { prefix: [0x02, 0x06, 0x01], write: true }, // calibration stop
  { prefix: [0x02, 0x08, 0x00], write: false },
  { prefix: [0x02, 0x0c, 0x00], write: false },
  { prefix: [0x02, 0x0d, 0x00], write: true }, // RGB sleep minutes (uint16)
  { prefix: [0x02, 0x0d, 0x01], write: false },
  { prefix: [0x02, 0x0e, 0x00], write: false },
  { prefix: [0x02, 0x10, 0x00], write: true, check: (p) => oneOf(p[3], [0, 1], 'shake optimization') },
  { prefix: [0x02, 0x10, 0x01], write: false },
  // 03 layout
  { prefix: [0x03, 0x01], write: false, check: (p) => range(p[2], 0, 3, 'layer') ?? range(p[3], 1, 5, 'row') },
  { prefix: [0x03, 0x03], write: false, check: (p) => range(p[2], 0, 3, 'layer') ?? keyPos(p, 3) },
  { prefix: [0x03, 0x04], write: true, check: (p) => range(p[2], 0, 3, 'layer') ?? keyPos(p, 3) ?? keycodesAt(p, [5]) },
  { prefix: [0x03, 0x05], write: false, check: (p) => range(p[2], 1, 5, 'row') },
  { prefix: [0x03, 0x06], write: false, check: (p) => range(p[2] & 15, 0, 3, 'layer') ?? range(p[3], 1, 5, 'row') },
  // 04 performance
  { prefix: [0x04, 0x01], write: false, check: (p) => keyPos(p, 2) },
  // Mode 2 (RT without Continuous RT) is further gated by protocol version in checkPerformanceWrite.
  { prefix: [0x04, 0x02], write: true, check: (p) => keyPos(p, 2) ?? oneOf(p[4], [0, 1, 2], 'mode') },
  { prefix: [0x04, 0x03], write: false, check: (p) => range(p[2], 0, 3, 'axis data type') ?? range(p[3], 1, 5, 'row') },
  // 05 lighting
  { prefix: [0x05, 0x01], write: false, check: (p) => range(p[2], 0, 1, 'area') ?? range(p[3], 0, 1, 'kind') },
  { prefix: [0x05, 0x02], write: true, check: (p) => range(p[2], 0, 1, 'area') ?? range(p[3], 0, 1, 'kind') },
  { prefix: [0x05, 0x03], write: false, check: (p) => range(p[2], 0, 1, 'area') ?? range(p[3], 0, 8, 'LED page') },
  { prefix: [0x05, 0x04], write: true, check: (p) => range(p[2], 0, 1, 'area') ?? range(p[3], 0, 8, 'LED page') },
  // 06 advanced
  { prefix: [0x06, 0x01], write: false, check: (p) => keyPos(p, 2) },
  {
    prefix: [0x06, 0x02], write: true,
    check: (p) => keyPos(p, 2) ?? oneOf(p[4], [0, 1, 2, 6, 7], 'advanced type')
      ?? (p[4] === 6 || p[4] === 7 ? keyPos(p, 5) : null) ?? advancedKeycodes(p),
  },
  // 07 macro
  { prefix: [0x07, 0x01], write: false, check: (p) => range(p[2], 0, 15, 'macro id') },
  // Macro meta: the reference only ever writes valid = 1 ("Clear Data" is valid + 0 actions), modes 0–5, ≤ 960 actions.
  {
    prefix: [0x07, 0x02],
    write: true,
    check: (p) =>
      range(p[2], 0, 15, 'macro id') ??
      (p[3] === 1 ? null : 'macro valid flag must be 1') ??
      range((p[4] ?? 0) | ((p[5] ?? 0) << 8), 0, 64 * 15, 'macro action count') ??
      range(p[8], 0, 5, 'macro mode'),
  },
  { prefix: [0x07, 0x03], write: false, check: (p) => range(p[2], 0, 15, 'macro id') ?? range(p[3], 0, 63, 'macro page') },
  { prefix: [0x07, 0x04], write: true, check: (p) => range(p[2], 0, 15, 'macro id') ?? range(p[3], 0, 63, 'macro page') },
  // 10 gamepad (AGP1). Only to board 0030000A, and everything but INFO only after INFO confirmed the firmware: checkGamepadFrame.
  { prefix: [0x10, GP_CMD.INFO], write: false, check: agp1(agpLength(0)) },
  {
    prefix: [0x10, GP_CMD.READ], write: false,
    check: agp1((p, n) => agpLength(7)(p, n) ?? range(p[16], 1, GP_READ_CHUNK, 'READ count')
      ?? (u16(p, 14) + p[16] <= GP_CONFIG_BYTES ? null : `READ ${u16(p, 14)}+${p[16]} beyond the ${GP_CONFIG_BYTES}-byte block`)),
  },
  { prefix: [0x10, GP_CMD.USB_STATUS], write: false, check: agp1(agpLength(0)) },
  {
    prefix: [0x10, GP_CMD.BEGIN], write: true,
    check: agp1((p, n) => agpLength(18)(p, n) ?? (u16(p, 18) === GP_CONFIG_BYTES ? null : `BEGIN length ${u16(p, 18)}, expected ${GP_CONFIG_BYTES}`)
      ?? (p.slice(20, 28).some((b) => b !== 0) ? null : 'BEGIN token must not be zero')),
  },
  {
    prefix: [0x10, GP_CMD.WRITE], write: true,
    check: agp1((p, n) => (n >= 11 ? null : `WRITE data length ${n} below 11`)
      ?? (u16(p, 18) + n - 10 <= GP_CONFIG_BYTES ? null : `WRITE ${u16(p, 18)}+${n - 10} beyond the ${GP_CONFIG_BYTES}-byte block`)),
  },
  { prefix: [0x10, GP_CMD.COMMIT], write: true, check: agp1(agpLength(16)) },
  { prefix: [0x10, GP_CMD.ABORT], write: true, check: agp1(agpLength(8)) },
  {
    prefix: [0x10, GP_CMD.USB_SET], write: true,
    check: agp1((p, n) => agpLength(10)(p, n) ?? (u32(p, 10) === GP_BOARD_ID ? null : 'USB_SET board must be 0030000A')
      ?? oneOf(p[14], [0, 1], 'USB_SET enabled') ?? (p[15] === 0 ? null : 'USB_SET reserved byte must be 0')),
  },
];

function ruleFor(p: readonly number[]): Rule | undefined {
  return RULES.find((r) => r.prefix.every((b, i) => p[i] === b));
}

/** Throws UnsafeCommandError unless the payload is an allowed command with valid arguments. */
export function checkFrame(payload: readonly number[], opts: { readOnly?: boolean } = {}): void {
  if (payload[0] === 0x08) throw new UnsafeCommandError(payload, 'firmware family 08 is never sent');
  const rule = ruleFor(payload);
  if (!rule) throw new UnsafeCommandError(payload, 'command is not on the allow-list');
  if (opts.readOnly && rule.write) throw new UnsafeCommandError(payload, 'write command on a read-only path');
  const why = rule.check?.(payload);
  if (why) throw new UnsafeCommandError(payload, why);
}

export function isWriteCommand(payload: readonly number[]): boolean {
  return ruleFor(payload)?.write ?? false;
}

/** An upload this connection started with BEGIN: what WRITE and COMMIT must match, and the bytes acknowledged so far. */
export interface GamepadStaging {
  token: readonly number[];
  crc: number;
  revision: number;
  /** The 208-byte block as written so far, and which of its bytes were acknowledged. */
  block: Uint8Array;
  received: Uint8Array;
}

/** What a family-10 frame is checked against: kept by the transport for its connection. */
export interface GamepadGuard {
  /** Board read by `01 02` on this connection (lowercase), undefined before. */
  boardIdHex?: string;
  /** Capability bits of the INFO that confirmed the gamepad firmware on this connection; null until then. */
  caps: number | null;
  staging: GamepadStaging | null;
}

/**
 * The conditions of a family-10 frame that depend on the connection. Returns a reason to refuse, or null.
 * - Only to board 0030000A (AE64 Pro): an AE64 Max, or a keyboard whose board was not read, never gets family 10.
 * - INFO is the only command before INFO confirmed the gamepad firmware (stock firmware only ever gets INFO).
 * - USB_STATUS / USB_SET need the USB switch capability.
 * - WRITE and COMMIT need this connection's BEGIN and its token. COMMIT also needs its CRC and revision, every byte of the block
 *   written, the bytes to match the CRC, a valid AGC1 block, and an output (HID / XInput) the INFO advertised unless the mode is off.
 */
export function checkGamepadFrame(p: readonly number[], g: GamepadGuard): string | null {
  if (p[0] !== 0x10) return null;
  if (g.boardIdHex?.toLowerCase() !== GP_BOARD_HEX) return `family 10 (gamepad) is only sent to an AE64 Pro, board 0030000A (board ${g.boardIdHex ?? 'not read'})`;
  const cmd = p[1];
  if (cmd === GP_CMD.INFO) return null;
  if (g.caps === null) return 'gamepad command before INFO confirmed the gamepad firmware';
  if (cmd === GP_CMD.USB_STATUS || cmd === GP_CMD.USB_SET) return g.caps & GP_CAP.USB_SWITCH ? null : 'the gamepad firmware has no Xbox USB switch';
  if (cmd !== GP_CMD.WRITE && cmd !== GP_CMD.COMMIT) return null;
  const st = g.staging;
  if (!st) return `${cmd === GP_CMD.WRITE ? 'WRITE' : 'COMMIT'} without a BEGIN on this connection`;
  if (!st.token.every((b, i) => p[10 + i] === b)) return 'token differs from the BEGIN';
  if (cmd === GP_CMD.WRITE) return null;
  if (u32(p, 18) !== st.crc || u32(p, 22) !== st.revision) return 'COMMIT CRC or revision differs from the BEGIN';
  if (st.received.some((b) => b === 0)) return 'COMMIT before every byte of the block was written';
  if (crc32(st.block) !== st.crc) return 'the written block does not match the BEGIN CRC';
  let bit: number | null;
  try {
    bit = requiredTransportBit(decodeConfig(st.block));
  } catch {
    return 'the written block is not a valid AGC1 configuration';
  }
  if (bit !== null && !(g.caps & bit)) return 'the firmware does not offer the output (HID / XInput) of this configuration';
  return null;
}

/** Sensor fields that are never changed by this app (the switch triple is checked separately). */
const PRESERVED: readonly (keyof Performance)[] = ['axis'];

/** The three fields that together identify the switch under a key. */
const TRIPLE: readonly (keyof Performance)[] = ['axisV2Id', 'axisRangeMax', 'axisCoefficient'];
const sameTriple = (a: Performance, b: Performance): boolean => TRIPLE.every((f) => a[f] === b[f]);

/** Upper bound for any travel distance (mm): the key's range, or 4.0 mm if the range is unknown. */
const MAX_TRAVEL_MM = 4.0;

/**
 * Checks a performance write against the records read from the same key during this connection
 * (`seen`, newest last). `axis` must equal a value the device reported for it: the firmware itself may change it
 * (advanced-key assignment), and restoring an earlier value is allowed. `calibrate` must equal the LATEST record
 * read from the key: the firmware resets it to 0 when the switch triple changes, so an older 1 is stale.
 * The switch triple (axisV2Id, axisRangeMax, axisCoefficient) is checked as one unit: it must equal the triple
 * of a record the device reported, or one exact entry of the catalog of the connected board (`boardIdHex`).
 * When the triple changes, every distance must fit the new range, changed or not.
 * Mode 2 (Rapid Trigger without Continuous RT) is written only when the firmware advertises it
 * (`intervalRt`: protocol ≥ 1.3.0.0, like the factory driver) or the key itself already reported mode 2.
 * Returns a reason to refuse, or null when the write is safe.
 */
export function checkPerformanceWrite(
  next: Performance,
  seen: readonly Performance[],
  opts: { intervalRt?: boolean; boardIdHex?: string } = {},
): string | null {
  if (!seen.length) return 'performance must be read from the key before it is written';
  const current = seen[seen.length - 1];
  for (const f of PRESERVED) {
    if (!seen.some((s) => s[f] === next[f])) return `sensor field ${f} would change (${current[f]} → ${next[f]})`;
  }
  if (next.calibrate !== current.calibrate) {
    return `sensor field calibrate would change (${current.calibrate} → ${next.calibrate}): must equal the latest read`;
  }
  const tripleChanged = !sameTriple(next, current);
  if (tripleChanged && !seen.some((s) => sameTriple(s, next)) && !isCatalogTriple(switchCatalogFor(opts.boardIdHex), next)) {
    return `switch fields axisV2Id/axisRangeMax/axisCoefficient would change (${current.axisV2Id}/${current.axisRangeMax}/${current.axisCoefficient}`
      + ` → ${next.axisV2Id}/${next.axisRangeMax}/${next.axisCoefficient}): not a triple the key reported or a catalog switch of this board`;
  }
  if (next.mode !== 0 && next.mode !== 1 && next.mode !== 2) return `mode ${String(next.mode)} invalid`;
  if (next.mode === 2 && !opts.intervalRt && !seen.some((s) => s.mode === 2)) {
    return 'mode 2 (Rapid Trigger without Continuous RT) needs protocol 1.3.0.0 or later';
  }
  if (tripleChanged && !(next.axisRangeMax > 0)) return `axisRangeMax ${next.axisRangeMax} must be above 0`;
  const max = tripleChanged
    ? Math.min(next.axisRangeMax / 1000, MAX_TRAVEL_MM)
    : current.axisRangeMax > 0 ? Math.min(current.axisRangeMax / 1000, MAX_TRAVEL_MM) : MAX_TRAVEL_MM;
  const dist: (keyof Performance)[] = ['normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke'];
  for (const f of dist) {
    const v = next[f] as number;
    if (!tripleChanged && v === current[f]) continue; // unchanged from what the device reported
    if (!Number.isFinite(v) || v < 0 || v > max + 1e-9) return `${f} ${v} mm outside 0–${max} mm`;
  }
  if (next.normalPress <= 0 && next.normalPress !== current.normalPress) return 'actuation point must be above 0 mm';
  const rtChanged = next.mode !== current.mode || next.rtFirstTouch !== current.rtFirstTouch
    || next.rtPress !== current.rtPress || next.rtRelease !== current.rtRelease;
  if ((next.mode === 1 || next.mode === 2) && rtChanged && (next.rtFirstTouch <= 0 || next.rtPress <= 0 || next.rtRelease <= 0)) {
    return 'Rapid Trigger distances must be above 0 mm';
  }
  return null;
}
