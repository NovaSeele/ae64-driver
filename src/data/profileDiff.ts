// Compare two profiles key by key (DESIGN G §3.6). Pure: the Profiles page passes the records it has (the active
// profile's live values, the others' snapshots); nothing here reads the keyboard.
import { isRtMode } from '../protocol';
import type { Performance } from '../protocol';
import { actuationOf, isKnownMode } from '../stores/performance';

export type DiffField = 'mode' | 'actuation' | 'rtPress' | 'rtRelease' | 'continuous' | 'deadTop' | 'deadBottom' | 'switch';
/** mode: 'std' (0) / 'rt' (1, 2); continuous: boolean; switch: axisV2Id; the rest: mm. */
export type DiffValue = number | boolean | 'std' | 'rt';
export interface DiffRow { id: number; field: DiffField; a: DiffValue; b: DiffValue }
export interface TopChange { field: DiffField; a: DiffValue; b: DiffValue; keys: number }

/** The order of the rows of one key (and the tie-break of topChanges). */
export const DIFF_FIELDS: readonly DiffField[] = ['mode', 'actuation', 'rtPress', 'rtRelease', 'continuous', 'deadTop', 'deadBottom', 'switch'];
/** Two mm values closer than this are the same (= the store's sameEdit, 0.5 µm). */
export const MM_TOLERANCE = 0.0005;

/** Fields compared only where both sides use Rapid Trigger (a Standard key has no RT sensitivity). */
const RT_ONLY: ReadonlySet<DiffField> = new Set(['rtPress', 'rtRelease', 'continuous']);
const MM_FIELDS: ReadonlySet<DiffField> = new Set(['actuation', 'rtPress', 'rtRelease', 'deadTop', 'deadBottom']);

function valueOf(p: Performance, field: DiffField): DiffValue {
  switch (field) {
    case 'mode': return isRtMode(p.mode) ? 'rt' : 'std';
    case 'actuation': return actuationOf(p);
    case 'rtPress': return p.rtPress;
    case 'rtRelease': return p.rtRelease;
    case 'continuous': return p.mode === 1;
    case 'deadTop': return p.pressDeadStroke;
    case 'deadBottom': return p.releaseDeadStroke;
    case 'switch': return p.axisV2Id;
  }
}

function differs(field: DiffField, a: DiffValue, b: DiffValue): boolean {
  return MM_FIELDS.has(field) ? Math.abs((a as number) - (b as number)) > MM_TOLERANCE : a !== b;
}

/**
 * The settings that differ between A and B, key by key in `ids` order, and within a key in DIFF_FIELDS order.
 * A key missing on either side, or in a mode the app does not know (not 0/1/2) on either side, has no row.
 */
export function diffProfiles(a: Record<number, Performance>, b: Record<number, Performance>, ids: readonly number[]): DiffRow[] {
  const rows: DiffRow[] = [];
  for (const id of ids) {
    const pa = a[id];
    const pb = b[id];
    if (!pa || !pb || !isKnownMode(pa.mode) || !isKnownMode(pb.mode)) continue;
    const bothRt = isRtMode(pa.mode) && isRtMode(pb.mode);
    for (const field of DIFF_FIELDS) {
      if (RT_ONLY.has(field) && !bothRt) continue;
      const va = valueOf(pa, field);
      const vb = valueOf(pb, field);
      if (differs(field, va, vb)) rows.push({ id, field, a: va, b: vb });
    }
  }
  return rows;
}

/** A value as a grouping key: mm on the 0.001 grid, so float noise does not split a group. */
const keyOf = (field: DiffField, v: DiffValue) => (MM_FIELDS.has(field) ? (v as number).toFixed(3) : String(v));

/**
 * The most common identical changes (same field, same A value, same B value) on at least 2 keys: by number of keys
 * (most first), a tie by DIFF_FIELDS order, at most `max`.
 */
export function topChanges(rows: DiffRow[], max = 3): TopChange[] {
  const groups = new Map<string, TopChange>();
  for (const r of rows) {
    const k = `${r.field}|${keyOf(r.field, r.a)}|${keyOf(r.field, r.b)}`;
    const g = groups.get(k);
    if (g) g.keys++;
    else groups.set(k, { field: r.field, a: r.a, b: r.b, keys: 1 });
  }
  return [...groups.values()]
    .filter((g) => g.keys >= 2)
    .sort((x, y) => y.keys - x.keys || DIFF_FIELDS.indexOf(x.field) - DIFF_FIELDS.indexOf(y.field))
    .slice(0, max);
}
