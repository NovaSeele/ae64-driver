// Summary numbers of the active profile for the Overview page's tiles (DESIGN F §3.3). Pure: the page passes the loaded
// records; nothing here reads the keyboard.
import { isRtMode } from '../protocol';
import type { Performance } from '../protocol';
import { actuationOf, isKnownMode } from '../stores/performance';

export interface ActuationStats {
  min: number;
  max: number;
  /** The most common value; a tie goes to the smaller value. */
  mode: number;
  modeCount: number;
  /** Keys with a known mode (the ones counted). */
  count: number;
}

/**
 * Actuation points over the keys with a known mode (0/1/2), each the keycap's value (RT: first touch, Standard: press).
 * Values are rounded to `decimals` before grouping, so 0.30000000004 and 0.3 are one value. null when no key has a known
 * mode.
 */
export function actuationStats(values: Record<number, Performance>, decimals: number): ActuationStats | null {
  const scale = 10 ** decimals;
  const counts = new Map<number, number>();
  let min = Infinity;
  let max = -Infinity;
  let count = 0;
  for (const p of Object.values(values)) {
    if (!isKnownMode(p.mode)) continue;
    const v = Math.round(actuationOf(p) * scale) / scale;
    counts.set(v, (counts.get(v) ?? 0) + 1);
    if (v < min) min = v;
    if (v > max) max = v;
    count++;
  }
  if (!count) return null;
  let mode = min;
  let modeCount = 0;
  for (const [v, c] of [...counts].sort((a, b) => a[0] - b[0])) {
    if (c > modeCount) {
      mode = v;
      modeCount = c;
    }
  }
  return { min, max, mode, modeCount, count };
}

/** Keys in Rapid Trigger (mode 1 or 2). */
export function rtCount(values: Record<number, Performance>): number {
  return Object.values(values).filter((p) => isRtMode(p.mode)).length;
}
