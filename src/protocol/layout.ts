// Physical 64-key layout of the AE64 (identical on Max and Pro). Firmware rows are 1–5 and firmware
// columns are sparse (sensorColumns). `03 05` layout discovery is the source of truth when it answers;
// this table is the fallback.

import type { PhysicalKey } from './types';
import { RATIO_UNITS } from './constants';
import type { LayoutStyleEntry } from './codec';

const ROWS: readonly (readonly (string | [string, number])[])[] = [
  ['Esc', '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', ['Backspace', 2]],
  [['Tab', 1.5], 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '[', ']', ['\\', 1.5]],
  [['Caps', 1.75], 'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ';', "'", ['Enter', 2.25]],
  [['Shift', 2], 'Z', 'X', 'C', 'V', 'B', 'N', 'M', ',', '.', '/', 'Shift', '↑', 'Del'],
  [['Ctrl', 1.25], ['Win', 1.25], ['Alt', 1.25], ['Space', 6.25], 'Alt', 'Fn', '←', '↓', '→'],
];

export const SENSOR_COLUMNS: readonly (readonly number[])[] = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13],
  [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14],
  [0, 1, 2, 6, 9, 10, 12, 13, 14],
];

export const PHYSICAL_KEYS: readonly PhysicalKey[] = Object.freeze(
  ROWS.flatMap((row, uiRow) => {
    let x = 0;
    return row.map((entry, i) => {
      const [name, w] = typeof entry === 'string' ? [entry, 1] : entry;
      const key = { uiRow, row: uiRow + 1, col: SENSOR_COLUMNS[uiRow][i], x, y: uiRow, w, name };
      x += w;
      return key;
    });
  }).map((k, id) => Object.freeze({ id, ...k })),
);

/** Overall keyboard size in key units. */
export function layoutBounds(keys: readonly PhysicalKey[]): { width: number; height: number } {
  let width = 0;
  let height = 0;
  for (const k of keys) {
    width = Math.max(width, k.x + k.w);
    height = Math.max(height, k.y + 1);
  }
  return { width, height };
}

/**
 * Merge `03 05` layout styles (index 0 = firmware row 1) into the fallback table. Discovery is
 * accepted only if every firmware row exposes exactly the expected sensor columns; otherwise the
 * fallback table is returned unchanged.
 */
export function keysFromLayoutStyles(styles: LayoutStyleEntry[][]): PhysicalKey[] {
  const fallback = PHYSICAL_KEYS.map((k) => ({ ...k }));
  if (styles.length !== SENSOR_COLUMNS.length) return fallback;
  for (let r = 0; r < styles.length; r++) {
    const present = styles[r].map((s, col) => (s.ratio > 0 ? col : -1)).filter((c) => c >= 0);
    if (present.join() !== SENSOR_COLUMNS[r].join()) return fallback;
  }
  // Normalise the origin so the board always starts at (0, 0) whatever base the firmware uses.
  const used = fallback.map((k) => styles[k.uiRow][k.col]);
  const minX = Math.min(...used.map((s) => s.x));
  const minY = Math.min(...used.map((s) => s.y));
  return fallback.map((k, i) => {
    const s = used[i];
    return { ...k, x: s.x - minX, y: s.y - minY, w: RATIO_UNITS[s.ratio] ?? k.w };
  });
}
