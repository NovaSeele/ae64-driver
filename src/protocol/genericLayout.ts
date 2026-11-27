// Pure layout builder for generic (non-AE64) keyboards from `03 05` rows 0–5 (DESIGN MKB §8.1–§8.6).
// Never imports or falls back to PHYSICAL_KEYS.

import type { PhysicalKey } from './types';
import type { LayoutStyleEntry } from './codec';
import { GENERIC_ROWS, LED_MATRIX_COLS, RATIO_UNITS } from './constants';

const OVERLAP_THRESHOLD = 0.25;
const MIN_GAP_UNITS = 1;
const MAX_GAP_UNITS = 7;

export interface GenericLayoutResult {
  keys: PhysicalKey[];
  /** Sorted firmware rows (0–5) that contain at least one key. */
  rows: number[];
  /** Firmware rows (0–5) that did not answer `03 05`. */
  missingRows: number[];
  /** Firmware rows (0–5) with any non-zero entry in columns 21–29 (ignored as keys, flagged for export). */
  layoutPadding: number[];
  /** True when any two keys overlap by more than 0.25 units (§8.4). */
  hasOverlap: boolean;
}

interface RawKey {
  row: number;
  col: number;
  x: number;
  y: number;
  ratio: number;
}

/**
 * Builds a generic keyboard layout from `03 05` rows 0–5.
 * - Uses only columns 0–20 (`LED_MATRIX_COLS`); entries 21–29 are ignored and flagged in `layoutPadding` if non-zero.
 * - Ratio 0 means no key.
 * - Unknown ratio codes take width from the gap to the next key on the same `y` if in [1, 7] units, else 1u, and set `unknownRatio`.
 * - Origin is normalised to (0, 0); `uiRow` is the index of distinct `y`; `id` runs 0..N-1 in row-then-col order.
 * - Never falls back to AE64 `PHYSICAL_KEYS`.
 */
export function buildGenericLayout(
  rowStyles: readonly (readonly LayoutStyleEntry[] | null | undefined)[],
): GenericLayoutResult {
  const raw: RawKey[] = [];
  const missingRows: number[] = [];
  const layoutPadding: number[] = [];
  const presentRows = new Set<number>();

  for (const r of GENERIC_ROWS) {
    const entries = rowStyles[r];
    if (!entries) {
      missingRows.push(r);
      continue;
    }
    const limit = Math.min(entries.length, LED_MATRIX_COLS);
    for (let col = 0; col < limit; col++) {
      const e = entries[col];
      if (!e || e.ratio === 0) continue;
      raw.push({ row: r, col, x: e.x, y: e.y, ratio: e.ratio });
      presentRows.add(r);
    }
    for (let col = LED_MATRIX_COLS; col < entries.length; col++) {
      const e = entries[col];
      if (e && (e.x !== 0 || e.y !== 0 || e.ratio !== 0)) {
        layoutPadding.push(r);
        break;
      }
    }
  }

  if (!raw.length) {
    return { keys: [], rows: [], missingRows, layoutPadding, hasOverlap: false };
  }

  const minX = Math.min(...raw.map((k) => k.x));
  const minY = Math.min(...raw.map((k) => k.y));
  const distinctY = [...new Set(raw.map((k) => k.y - minY))].sort((a, b) => a - b);
  const uiRowOf = new Map(distinctY.map((y, idx) => [y, idx]));

  // Group x positions by normalised y to measure gaps for unknown ratio codes.
  const xsByY = new Map<number, number[]>();
  for (const k of raw) {
    const ny = k.y - minY;
    const list = xsByY.get(ny);
    if (list) list.push(k.x - minX);
    else xsByY.set(ny, [k.x - minX]);
  }
  for (const list of xsByY.values()) list.sort((a, b) => a - b);

  const keys: PhysicalKey[] = raw.map((k, id) => {
    const x = k.x - minX;
    const y = k.y - minY;
    const known = Object.hasOwn(RATIO_UNITS, k.ratio) ? RATIO_UNITS[k.ratio] : undefined;
    let w: number;
    let unknownRatio: number | undefined;
    if (known !== undefined) {
      w = known;
    } else {
      unknownRatio = k.ratio;
      const xs = xsByY.get(y)!;
      const nextX = xs.find((ox) => ox > x);
      const gap = nextX !== undefined ? nextX - x : 0;
      w = gap >= MIN_GAP_UNITS && gap <= MAX_GAP_UNITS ? gap : 1;
    }
    const key: PhysicalKey = {
      id,
      uiRow: uiRowOf.get(y)!,
      row: k.row,
      col: k.col,
      x,
      y,
      w,
      name: `R${k.row}·C${k.col}`,
    };
    if (unknownRatio !== undefined) key.unknownRatio = unknownRatio;
    return key;
  });

  let hasOverlap = false;
  for (let i = 0; i < keys.length && !hasOverlap; i++) {
    const a = keys[i];
    for (let j = i + 1; j < keys.length; j++) {
      const b = keys[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + 1, b.y + 1) - Math.max(a.y, b.y);
      if (ox > OVERLAP_THRESHOLD && oy > OVERLAP_THRESHOLD) {
        hasOverlap = true;
        break;
      }
    }
  }

  return {
    keys,
    rows: [...presentRows].sort((a, b) => a - b),
    missingRows,
    layoutPadding,
    hasOverlap,
  };
}
