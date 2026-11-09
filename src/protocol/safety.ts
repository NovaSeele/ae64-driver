// Last line of defence between the app and the keyboard. Every frame passes `checkFrame` before it is
// sent: only commands this app is known to need are allowed, with their arguments range-checked.
// Anything else (firmware family 08, unknown commands, out-of-range indexes) is refused here, no matter
// which page or store built it. Performance writes are additionally checked against the record last
// read from the device, so the sensor calibration fields can never be changed (see BaseTransport).

import type { Performance } from './types';
import { decodeCombo, isKnownKeycode } from './keycodes';
import { isCatalogTriple, switchCatalogFor } from './switches';

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

/** Sensor fields that are never changed by this app (the switch triple is checked separately). */
const PRESERVED: readonly (keyof Performance)[] = ['axis', 'calibrate'];

/** The three fields that together identify the switch under a key. */
const TRIPLE: readonly (keyof Performance)[] = ['axisV2Id', 'axisRangeMax', 'axisCoefficient'];
const sameTriple = (a: Performance, b: Performance): boolean => TRIPLE.every((f) => a[f] === b[f]);

/** Upper bound for any travel distance (mm): the key's range, or 4.0 mm if the range is unknown. */
const MAX_TRAVEL_MM = 4.0;

/**
 * Checks a performance write against the records read from the same key during this connection
 * (`seen`, newest last). `axis` and `calibrate` must equal a value the device reported for them: the firmware
 * itself may change them (calibration, advanced-key assignment), and restoring an earlier value is allowed.
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
