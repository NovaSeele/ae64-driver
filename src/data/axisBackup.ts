// Switch-values backup across a firmware update (DESIGN OFU v1.10, ADDENDUM-switch-restore.md §2).
// Pure data module: record format, 4-keyboard LRU cap, 30-day expiry, and the per-key compare with fitTravel.
// Never sends HID and never widens the write guard (callbacks tripleOk and write come from the store).
import type { Performance } from '../protocol/types';
import { FW_AXIS } from '../protocol/switches';
import { isFwBoard, serialReadable } from '../protocol/firmware';
import { fitTravel, pickEdit } from '../stores/performance';

/** localStorage key holding per-serial backups (NOT_EXPORTED: never leaves this browser). */
export const AXIS_BACKUP_KEY = 'ae64.fw.axisBackup';
/** Maximum keyboards kept in storage (the oldest by takenAt is dropped). */
export const AXIS_BACKUP_MAX = 4;
/** Backups expire after 30 days (checked on load). */
export const AXIS_BACKUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Backups older than 24 hours show the fw.ax.old warning (§5). */
export const AXIS_BACKUP_OLD_MS = 24 * 60 * 60 * 1000;

export type Triple = [id: number, rangeUm: number, coef: number];

export interface AxisBackup {
  v: 1;
  serialHex: string;
  board: number;
  fwBefore: string;
  takenAt: number;
  keys: Record<number, Triple>;
  after?: Record<number, Triple>;
}

export type AxisBackupMap = Record<string, AxisBackup>;

export interface RestoreCheck {
  /** Guard's triple rule on the NEW list (catalog or isCustomTriple, R >= 1000, c >= 4096); never treats a saved triple as "reported". */
  tripleOk: (keyId: number, t: Triple) => boolean;
  /** checkPerformanceWrite with this connection's `seen`; null = accepted. */
  write: (keyId: number, next: Performance) => string | null;
}

export interface Compare {
  same: number[];
  restore: number[];
  fitted: number[];
  cant: number[];
  blocked: number[];
  lostBefore: number[];
  changedSince: number[];
  next: Record<number, Performance>;
}

const KEY_ID_RE = /^(?:0|[1-9]|[1-5][0-9]|6[0-3])$/;
const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseTriple(raw: unknown): Triple | null {
  if (!Array.isArray(raw) || raw.length !== 3) return null;
  const [id, r, c] = raw;
  if (typeof id !== 'number' || !Number.isFinite(id) || typeof r !== 'number' || !Number.isFinite(r) || typeof c !== 'number' || !Number.isFinite(c)) {
    return null;
  }
  return [id, r, c];
}

function parseKeyMap(raw: unknown): Record<number, Triple> | null {
  if (!isPlain(raw)) return null;
  const out: Record<number, Triple> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KEY_ID_RE.test(k)) return null;
    const t = parseTriple(v);
    if (!t) return null;
    out[Number(k)] = t;
  }
  return out;
}

function parseEntry(serialKey: string, raw: unknown): AxisBackup | null {
  if (!serialReadable(serialKey) || !isPlain(raw)) return null;
  if (raw.v !== 1 || raw.serialHex !== serialKey) return null;
  if (typeof raw.board !== 'number' || !Number.isInteger(raw.board) || !isFwBoard(raw.board)) return null;
  if (typeof raw.fwBefore !== 'string') return null;
  if (typeof raw.takenAt !== 'number' || !Number.isFinite(raw.takenAt) || raw.takenAt < 0) return null;
  const keys = parseKeyMap(raw.keys);
  if (!keys) return null;
  let after: Record<number, Triple> | undefined;
  if (raw.after !== undefined) {
    const parsed = parseKeyMap(raw.after);
    if (!parsed) return null;
    after = parsed;
  }
  return after ? { v: 1, serialHex: raw.serialHex, board: raw.board, fwBefore: raw.fwBefore, takenAt: raw.takenAt, keys, after }
    : { v: 1, serialHex: raw.serialHex, board: raw.board, fwBefore: raw.fwBefore, takenAt: raw.takenAt, keys };
}

/** Parses and validates a JSON string of stored backups; ignores malformed entries. */
export function parseAxisBackupMap(raw: string): AxisBackupMap {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isPlain(parsed)) return {};
  const out: AxisBackupMap = {};
  for (const [serial, entry] of Object.entries(parsed)) {
    const clean = parseEntry(serial, entry);
    if (clean) out[serial] = clean;
  }
  return out;
}

/** True when the backup has reached the 30-day expiry window. */
export function isBackupExpired(b: AxisBackup, now = Date.now()): boolean {
  return now - b.takenAt >= AXIS_BACKUP_TTL_MS;
}

/** Stores `b` under `b.serialHex` (replacing any older backup of that serial), keeping at most 4 keyboards (oldest takenAt goes). */
export function saveBackup(all: AxisBackupMap, b: AxisBackup): AxisBackupMap {
  const next: AxisBackupMap = { ...all, [b.serialHex]: b };
  const entries = Object.entries(next);
  if (entries.length <= AXIS_BACKUP_MAX) return next;
  const kept = entries
    .map(([serial, entry], idx) => ({ serial, entry, idx }))
    .sort((a, c) => (c.serial === b.serialHex ? 1 : 0) - (a.serial === b.serialHex ? 1 : 0) || c.entry.takenAt - a.entry.takenAt || c.idx - a.idx)
    .slice(0, AXIS_BACKUP_MAX);
  return Object.fromEntries(kept.map((x) => [x.serial, x.entry]));
}

/** Returns the backup for `(serialHex, board)`, or null when missing, board differs, or expired (30 days). */
export function loadBackup(
  all: AxisBackupMap,
  serialHex: string | null | undefined,
  board: number | null | undefined,
  now = Date.now(),
): AxisBackup | null {
  if (!serialReadable(serialHex) || typeof board !== 'number') return null;
  const b = all[serialHex];
  if (!b || b.board !== board || isBackupExpired(b, now)) return null;
  return b;
}

/** Returns a new map with `serialHex` removed. */
export function removeBackup(all: AxisBackupMap, serialHex: string): AxisBackupMap {
  if (!(serialHex in all)) return all;
  const next = { ...all };
  delete next[serialHex];
  return next;
}

const sameTriple = (p: Performance, t: Triple): boolean =>
  p.axisV2Id === t[0] && p.axisRangeMax === t[1] && p.axisCoefficient === t[2];

/**
 * Classifies every backed-up key against the current performance read in ADDENDUM §2's exact order:
 * equal → same; saved R < 1000 → lostBefore; differs from after → changedSince;
 * build next (current key + saved triple + fitTravel(pickEdit(current), saved R) + calibrate/axis as read);
 * tripleOk false → cant; write(next) non-null → blocked; else restore (and fitted if fitTravel lowered anything).
 */
export function compare(b: AxisBackup, now: Record<number, Performance>, check: RestoreCheck): Compare {
  const same: number[] = [];
  const restore: number[] = [];
  const fitted: number[] = [];
  const cant: number[] = [];
  const blocked: number[] = [];
  const lostBefore: number[] = [];
  const changedSince: number[] = [];
  const next: Record<number, Performance> = {};

  const ids = Object.keys(b.keys).map(Number).sort((a, c) => a - c);
  for (const keyId of ids) {
    const cur = now[keyId];
    if (!cur) continue;
    const saved = b.keys[keyId];
    const [savedId, savedR, savedC] = saved;

    // 1. equal → same
    if (sameTriple(cur, saved)) {
      same.push(keyId);
      continue;
    }
    // 2. saved R < 1000 → lostBefore (never written)
    if (!(savedR >= FW_AXIS.rangeMin)) {
      lostBefore.push(keyId);
      continue;
    }
    // 3. differs from after → changedSince (user changed it after the update; not offered)
    const afterTriple = b.after?.[keyId];
    if (afterTriple && !sameTriple(cur, afterTriple)) {
      changedSince.push(keyId);
      continue;
    }
    // 4. build next: key as read, saved triple, fitTravel on edit fields, calibrate & axis as read
    const fittedEdit = fitTravel(pickEdit(cur), savedR);
    const candidate: Performance = {
      ...cur,
      ...fittedEdit.edit,
      axisV2Id: savedId,
      axisRangeMax: savedR,
      axisCoefficient: savedC,
      calibrate: cur.calibrate,
      axis: cur.axis,
    };
    // 5. tripleOk false → cant
    if (!check.tripleOk(keyId, saved)) {
      cant.push(keyId);
      continue;
    }
    // 6. write(next) not null → blocked
    if (check.write(keyId, candidate) !== null) {
      blocked.push(keyId);
      continue;
    }
    // 7. restore (and fitted when fitTravel lowered any distance)
    restore.push(keyId);
    if (fittedEdit.clamped.length > 0) fitted.push(keyId);
    next[keyId] = candidate;
  }

  return { same, restore, fitted, cant, blocked, lostBefore, changedSince, next };
}

/** Reads all valid backups from localStorage; returns {} if storage is unavailable or unreadable. */
export function readAllBackups(): AxisBackupMap {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(AXIS_BACKUP_KEY);
    return raw === null ? {} : parseAxisBackupMap(raw);
  } catch {
    return {};
  }
}

/** Persists the backup map to localStorage (removes key when empty). Propagates storage errors so callers can report saveFailed. */
export function writeAllBackups(all: AxisBackupMap): void {
  if (typeof localStorage === 'undefined') throw new Error('localStorage unavailable');
  if (!Object.keys(all).length) {
    localStorage.removeItem(AXIS_BACKUP_KEY);
  } else {
    localStorage.setItem(AXIS_BACKUP_KEY, JSON.stringify(all));
  }
}
