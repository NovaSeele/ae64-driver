// Key check (part C): turns the live store's per-key peaks and "not back to 0" readings into what the page shows
// (counters, chips, table rows, keycap marks and results). Pure: the page calls it only when the check data or the
// performance settings changed.
import type { Performance, PhysicalKey } from '../../protocol';
import { DEFAULT_RANGE_MM } from '../../stores/performance';
import { FULL_TRAVEL, STUCK_ANNOUNCE_MS } from '../../stores/live';
import type { LiveData } from '../../stores/live';

export type CheckKind = 'ok' | 'short' | 'stuck';

export interface CheckIssue {
  id: number;
  name: string;
  kind: 'short' | 'stuck';
  /** Short: the deepest reading; stuck: where the key stays (restOffMm). */
  mm: number;
  /** The key's switch travel (mm). */
  range: number;
}

export interface CheckRow {
  id: number;
  name: string;
  mm: number;
  /** Deepest reading / switch travel, 0..1. */
  ratio: number;
  kind: CheckKind;
  /** The bar colour: by depth only (a stuck key keeps the colour of its depth; its icon says stuck). */
  bar: 'ok' | 'short';
}

export interface CheckView {
  pressed: number;
  full: number;
  short: number;
  stuck: number;
  total: number;
  /** Stuck first, then short; shallowest first within each. One per key (stuck wins). */
  issues: CheckIssue[];
  /** Pressed keys, deepest first, then by name. */
  rows: CheckRow[];
  /** Some key's switch travel is not read yet: DEFAULT_RANGE_MM stands in. */
  estimated: boolean;
  /** By PhysicalKey.id: the result of a pressed key, undefined for one not pressed. */
  kinds: (CheckKind | undefined)[];
  /** By PhysicalKey.id: the deepest reading as a share of the travel, for pressed keys only. */
  marks: (number | undefined)[];
}

/** A key's switch travel (mm); DEFAULT_RANGE_MM while it is not read. */
export function rangeOf(p: Performance | undefined): number {
  return p && p.axisRangeMax > 0 ? p.axisRangeMax / 1000 : DEFAULT_RANGE_MM;
}

/** Full travel: the deepest reading reached FULL_TRAVEL of the switch travel (3.15 of 3.31 is full, 3.10 is not). */
export function isFull(peakMm: number, range: number): boolean {
  return peakMm >= FULL_TRAVEL * range - 1e-6;
}

export function emptyCheckView(total: number): CheckView {
  return { pressed: 0, full: 0, short: 0, stuck: 0, total, issues: [], rows: [], estimated: false, kinds: [], marks: [] };
}

const sameRow = (a: CheckRow, b: CheckRow) => a.id === b.id && a.name === b.name && a.mm === b.mm && a.ratio === b.ratio && a.kind === b.kind && a.bar === b.bar;
const sameIssue = (a: CheckIssue, b: CheckIssue) => a.id === b.id && a.name === b.name && a.kind === b.kind && a.mm === b.mm && a.range === b.range;
const sameList = <T>(a: readonly T[], b: readonly T[]) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * `name`: what the key is called on screen (the keycap legend). `prev`: the last view; rows and issues that did not
 * change keep their object (the page renders only what changed), and a view equal to `prev` is `prev` itself.
 */
export function summarizeCheck(data: LiveData, keys: PhysicalKey[], values: Record<number, Performance | undefined>, name: (k: PhysicalKey) => string = (k) => k.name, prev?: CheckView): CheckView {
  const view = emptyCheckView(keys.length);
  const oldRow = new Map<number, CheckRow>();
  const oldIssue = new Map<number, CheckIssue>();
  for (const r of prev?.rows ?? []) oldRow.set(r.id, r);
  for (const i of prev?.issues ?? []) oldIssue.set(i.id, i);
  const row = (r: CheckRow) => { const o = oldRow.get(r.id); return o && sameRow(o, r) ? o : r; };
  const issue = (i: CheckIssue) => { const o = oldIssue.get(i.id); return o && sameIssue(o, i) ? o : i; };
  for (const k of keys) {
    const p = values[k.id];
    if (!(p && p.axisRangeMax > 0)) view.estimated = true;
    if (!data.pressedIds.has(k.id)) continue;
    const range = rangeOf(p);
    const mm = data.peakMm[k.id];
    const full = isFull(mm, range);
    const stuck = data.restOffMm[k.id] > 0;
    const kind: CheckKind = stuck ? 'stuck' : full ? 'ok' : 'short';
    const ratio = Math.min(1, mm / range);
    view.pressed++;
    if (full) view.full++;
    else view.short++;
    if (stuck) view.stuck++;
    view.kinds[k.id] = kind;
    view.marks[k.id] = ratio;
    const n = name(k);
    view.rows.push(row({ id: k.id, name: n, mm, ratio, kind, bar: full ? 'ok' : 'short' }));
    if (stuck) view.issues.push(issue({ id: k.id, name: n, kind: 'stuck', mm: data.restOffMm[k.id], range }));
    else if (!full) view.issues.push(issue({ id: k.id, name: n, kind: 'short', mm, range }));
  }
  view.rows.sort((a, b) => b.mm - a.mm || a.name.localeCompare(b.name));
  view.issues.sort((a, b) => (a.kind === b.kind ? a.mm - b.mm || a.name.localeCompare(b.name) : a.kind === 'stuck' ? -1 : 1));
  if (prev && prev.total === view.total && prev.pressed === view.pressed && prev.full === view.full && prev.short === view.short
    && prev.stuck === view.stuck && prev.estimated === view.estimated && sameList(prev.rows, view.rows) && sameList(prev.issues, view.issues)) {
    return prev; // rows equal ⇒ kinds and marks equal (both come from the same pressed keys)
  }
  if (prev && sameList(prev.rows, view.rows)) view.rows = prev.rows;
  if (prev && sameList(prev.issues, view.issues)) view.issues = prev.issues;
  return view;
}

/** How often the page hands the screen reader at most one sentence (DESIGN C §7). */
export const ANNOUNCE_MS = 1500;

/**
 * Screen-reader sentences for the key check (DESIGN C §7), batched: the page calls tick() every ANNOUNCE_MS and puts
 * the result (at most one sentence) in the polite live region. Full keys stay silent, so typing is not read aloud.
 * - Start over: live.restartDone, first.
 * - A key stuck for STUCK_ANNOUNCE_MS or longer (offSince on the ingest clock): live.announceStuck, once per stuck stretch.
 *   A key stuck shorter than that (a finger resting partway) is shown but not read.
 * - Keys released short since the last sentence: live.announceShort with all their names.
 * - Every key pressed: live.announceAll, once until the check starts over.
 */
export class CheckAnnouncer {
  private restartPending = false;
  private stuckSaid = new Set<number>();
  private shortNames: string[] = [];
  private allSaid = false;

  constructor(private readonly stuckMs = STUCK_ANNOUNCE_MS) {}

  restart(): void {
    this.restartPending = true;
    this.stuckSaid.clear();
    this.shortNames = [];
    this.allSaid = false;
  }

  /** Next sentence, or null. `released`: keys that just came back up (store drainReleased()); `names` by key id. */
  tick(data: LiveData, view: CheckView, released: number[], names: (id: number) => string, now: number, t: (key: 'live.restartDone' | 'live.announceStuck' | 'live.announceShort' | 'live.announceAll', p?: Record<string, string | number>) => string): string | null {
    for (const id of released) {
      const name = names(id);
      if (view.kinds[id] === 'short' && !this.shortNames.includes(name)) this.shortNames.push(name);
    }
    for (const id of [...this.stuckSaid]) if (!(data.restOffMm[id] > 0)) this.stuckSaid.delete(id);
    if (view.pressed < view.total) this.allSaid = false;
    if (this.restartPending) {
      this.restartPending = false;
      return t('live.restartDone');
    }
    for (let id = 0; id < data.restOffMm.length; id++) {
      if (data.restOffMm[id] > 0 && data.offSince[id] >= 0 && now - data.offSince[id] >= this.stuckMs && !this.stuckSaid.has(id)) {
        this.stuckSaid.add(id);
        return t('live.announceStuck', { key: names(id), mm: data.restOffMm[id].toFixed(2) });
      }
    }
    if (this.shortNames.length) {
      const keys = this.shortNames.join(', ');
      this.shortNames = [];
      return t('live.announceShort', { keys });
    }
    if (view.total > 0 && view.pressed === view.total && !this.allSaid) {
      this.allSaid = true;
      return t('live.announceAll', { n: view.total });
    }
    return null;
  }
}
