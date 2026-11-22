// Pure data module for custom switches, the generic switch, curve estimation, custom triples and browser storage
// (DESIGN CSW §5.7, §6, §7.1, §9.1, §9.4, §9.5, §10.1, §13). No Vue, no Pinia, no transport, no HID.
import { FW_AXIS, coefBounds, findSwitch, rangeBounds } from '../protocol/switches';
import type { SwitchEntry, SwitchTriple } from '../protocol/switches';
import { serialReadable } from '../protocol/firmware';
import { makerTabs, switchBrand } from './switchDisplay';
import { READY_BOUNDS, READY_SWITCHES } from './readySwitches';
import type { ReadySwitch } from './readySwitches';

export const CUSTOM_SWITCHES_KEY = 'ae64.switch.custom';
export const GENERIC_SWITCH_KEY = 'ae64.switch.generic';
export const SWITCH_ASSIGN_KEY = 'ae64.switch.assign';
export const SWITCH_RECAL_KEY = 'ae64.switch.recal';
export const SWITCH_CAPS_KEY = 'ae64.switch.caps';

export const CUSTOM_SWITCH_MAX = 50;
export const ASSIGN_BOARD_MAX = 8;
export const CUSTOM_NAME_MAX = 40;
export const CUSTOM_MAKER_MAX = 24;
export const CUSTOM_NOTE_MAX = 120;
export const TRAVEL_UM_MIN = 1000;
export const TRAVEL_UM_MAX = 6000;
export const FW_COEF_MAX = 65535;
const KEY_ID_MAX = 63;

export const GENERIC_UID = 'g-generic';

/** The measured classes (n ≥ 4), µm → c. 3.80 is not a point: it falls on the line between 3.60 and 4.00 (§5.7). */
export const COEF_POINTS = [[3200, 25728], [3400, 20550], [3500, 19850], [3600, 18750], [4000, 15100]] as const;
/** The generic switch's classes, in the order shown (§5.7). */
export const GENERIC_CLASSES = [3200, 3400, 3500, 3600, 3800, 4000] as const;
export const GENERIC_START = 3400;

/** Stem colours offered in the form (§9.4); 'none' stores ''. */
export const SWITCH_COLORS = [
  { id: 'none', hex: '' },
  { id: 'white', hex: '#f1f1ee' },
  { id: 'black', hex: '#2a2b2e' },
  { id: 'red', hex: '#e0524f' },
  { id: 'orange', hex: '#f08c3a' },
  { id: 'yellow', hex: '#f2c94c' },
  { id: 'green', hex: '#5cc27a' },
  { id: 'cyan', hex: '#4fc3d9' },
  { id: 'blue', hex: '#4f8ef7' },
  { id: 'purple', hex: '#9b6cf0' },
  { id: 'pink', hex: '#f07ab8' },
] as const;

export const SWITCH_COLOR_HEXES: ReadonlySet<string> = new Set(
  SWITCH_COLORS.map((c) => c.hex).filter((h) => h !== ''),
);

export type CustomCurve =
  | { kind: 'like'; id: number; name: string }
  | { kind: 'travel' }
  | { kind: 'manual' };

export interface CustomSwitch {
  uid: `u-${string}`;
  name: string;
  maker: string;
  travelUm: number;
  rangeUm: number;
  coefficient: number;
  curve: CustomCurve;
  color: string;
  note: string;
}

export interface CustomLike {
  uid: string;
  name: string;
  maker: string;
  rangeUm: number;
  coefficient: number;
  curveFrom?: { id: number };
}

export interface GenericDecl {
  rangeUm: number;
}

export interface BoardAssignments {
  at: number;
  keys: Record<string, string>;
}

export interface SwitchAssignData {
  v: 1;
  boards: Record<string, BoardAssignments>;
}

export interface SwitchRecalData {
  v: 1;
  boards: Record<string, number[]>;
}

export type SwitchCapsView = 'photo' | 'travel';
export type BoardRef = string | { serialHex?: string | null; boardIdHex?: string | null } | null | undefined;

// ---- Text cleaning and folding (§6.2, §6.4, §6.7 rule 3) ----

// Control chars (C0, DEL, C1) and bidi direction controls / isolates.
const UNSAFE_TEXT_RE = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** NFC, control and direction-override characters removed, trimmed (shared with switch packs, §6.7 rule 3). */
export function cleanText(s: string): string {
  return s.normalize('NFC').replace(UNSAFE_TEXT_RE, '').trim();
}

/** Accent- and case-insensitive key for comparing switch names and maker names (§6.2, §6.4). */
export function foldText(s: string): string {
  return cleanText(s).normalize('NFD').replace(/\p{Diacritic}/gu, '').replace(/[đĐ]/g, 'd').toLowerCase();
}

// ---- Conversions to CustomLike ----

export function readyToCustomLike(r: ReadySwitch): CustomLike {
  return {
    uid: r.uid,
    name: r.name,
    maker: r.maker,
    rangeUm: r.rangeUm,
    coefficient: r.coefficient,
    curveFrom: { id: r.curveFrom.id },
  };
}

export function userToCustomLike(u: CustomSwitch): CustomLike {
  return {
    uid: u.uid,
    name: u.name,
    maker: u.maker,
    rangeUm: u.rangeUm,
    coefficient: u.coefficient,
    ...(u.curve.kind === 'like' ? { curveFrom: { id: u.curve.id } } : {}),
  };
}

function clampInt(v: number, b: { min: number; max: number }): number {
  return Math.min(b.max, Math.max(b.min, Math.round(v)));
}

/** c from a travel: straight lines between COEF_POINTS, flat outside 3200–4000, rounded, then clamped to the bounds (§5.7). */
export function coefFromTravel(
  rangeUm: number,
  b: { min: number; max: number } = { min: READY_BOUNDS.cMin, max: READY_BOUNDS.cMax },
): number {
  let c: number;
  const first = COEF_POINTS[0];
  const last = COEF_POINTS[COEF_POINTS.length - 1];
  if (rangeUm <= first[0]) {
    c = first[1];
  } else if (rangeUm >= last[0]) {
    c = last[1];
  } else {
    c = last[1];
    for (let i = 0; i < COEF_POINTS.length - 1; i++) {
      const [x0, y0] = COEF_POINTS[i];
      const [x1, y1] = COEF_POINTS[i + 1];
      if (rangeUm <= x1) {
        c = y0 + ((rangeUm - x0) / (x1 - x0)) * (y1 - y0);
        break;
      }
    }
  }
  return clampInt(c, b);
}

/** The generic switch as a CustomLike: uid 'g-generic', R = declared travel (default 3400), c = coefFromTravel(R) (§5.7). */
export function genericSwitch(decl: GenericDecl | null, catalog: readonly SwitchEntry[] | null): CustomLike {
  const rb = rangeBounds(catalog) ?? { min: READY_BOUNDS.rMin, max: READY_BOUNDS.rMax };
  const cb = coefBounds(catalog) ?? { min: READY_BOUNDS.cMin, max: READY_BOUNDS.cMax };
  const rangeUm = clampInt(decl?.rangeUm ?? GENERIC_START, rb);
  return {
    uid: GENERIC_UID,
    name: '',
    maker: '',
    rangeUm,
    coefficient: coefFromTravel(rangeUm, cb),
  };
}

// ---- Picker order, fallbackId, customTriple, suggestCurve (§6.4, §7.1) ----

function inPickerOrder<E extends { id: number }>(catalog: readonly E[]): E[] {
  return makerTabs(catalog).flatMap((t) => t.entries);
}

function nearestBy<T>(items: readonly T[], dist: (x: T) => number): T | null {
  let best: T | null = null;
  let bestD = Infinity;
  for (const item of items) {
    const d = dist(item);
    if (d < bestD) {
      bestD = d;
      best = item;
    }
  }
  return best;
}

/** The id a custom write uses on a key whose id is not a usable list id (§7.1). */
export function fallbackId(catalog: readonly SwitchEntry[], c: CustomLike, rangeUm: number): number {
  const usable = inPickerOrder(catalog).filter((e) => e.id >= FW_AXIS.idMin);
  const from = c.curveFrom && usable.find((e) => e.id === c.curveFrom!.id);
  const picked = from ?? nearestBy(usable, (e) => Math.abs(e.rangeMax - rangeUm));
  if (!picked) throw new Error('switch catalog has no usable id >= 0x1000');
  return picked.id;
}

/** One key's triple for a custom choice, or null on a board without a list (§7.1). */
export function customTriple(
  c: CustomLike,
  current: SwitchTriple,
  catalog: readonly SwitchEntry[] | null,
): { triple: SwitchTriple; idKept: boolean } | null {
  const rb = rangeBounds(catalog), cb = coefBounds(catalog);
  if (!catalog || !rb || !cb) return null;
  const R = clampInt(c.rangeUm, rb);
  const C = clampInt(c.coefficient, cb);
  const keep = Number.isInteger(current.axisV2Id) && current.axisV2Id >= FW_AXIS.idMin && !!findSwitch(catalog, current.axisV2Id);
  if (!keep && !catalog.some((e) => e.id >= FW_AXIS.idMin)) return null;
  return {
    triple: {
      axisV2Id: keep ? current.axisV2Id : fallbackId(catalog, c, R),
      axisRangeMax: R,
      axisCoefficient: C,
    },
    idKept: keep,
  };
}

/** The suggested curve source: the board-list entry nearest in range, among the maker's own entries first (§6.4). */
export function suggestCurve(catalog: readonly SwitchEntry[], rangeUm: number, maker: string): SwitchEntry | null {
  if (!catalog.length || !Number.isFinite(rangeUm)) return null;
  const ordered = inPickerOrder(catalog);
  const fm = foldText(maker);
  const same = fm
    ? ordered.filter((e) => {
        const b = switchBrand(e.id);
        return b !== null && foldText(b) === fm;
      })
    : [];
  const pool = same.length ? same : ordered;
  return nearestBy(pool, (e) => Math.abs(e.rangeMax - rangeUm));
}

// ---- UID generation ----

/** New user-switch uid: 'u-' + 12 lowercase hex chars from crypto.getRandomValues (§13). */
export function newCustomUid(): `u-${string}` {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `u-${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

// ---- Validation and localStorage helpers (§9.1, §10.1, §13) ----

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isIntIn = (v: unknown, lo: number, hi: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
const exactKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean => {
  const ks = Object.keys(o);
  return ks.length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(o, k));
};

const USER_UID_RE = /^u-[0-9a-zA-Z_-]{1,64}$/;
const ASSIGN_UID_RE = /^[ru]-[0-9a-zA-Z_-]{1,80}$/;
const KEY_ID_RE = /^(?:0|[1-9]|[1-5][0-9]|6[0-3])$/;
const RECAL_BOARD_RE = /^board:[0-9a-f]{8}$/;

function isAssignableUid(v: unknown): v is string {
  return typeof v === 'string' && (v === GENERIC_UID || ASSIGN_UID_RE.test(v));
}

function isRecalBoardKey(k: string): boolean {
  return serialReadable(k) || RECAL_BOARD_RE.test(k);
}

function parseJson(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

function getStorage(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}

function setStorage(key: string, value: string): void {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function removeStorage(key: string): void {
  try { localStorage.removeItem(key); } catch { /* storage unavailable */ }
}

const CUSTOM_KEYS = new Set(['uid', 'name', 'maker', 'travelUm', 'rangeUm', 'coefficient', 'curve', 'color', 'note']);

function parseCurve(raw: unknown): CustomCurve | null {
  if (!isPlain(raw)) return null;
  if (raw.kind === 'travel' && exactKeys(raw, ['kind'])) return { kind: 'travel' };
  if (raw.kind === 'manual' && exactKeys(raw, ['kind'])) return { kind: 'manual' };
  if (
    raw.kind === 'like'
    && exactKeys(raw, ['kind', 'id', 'name'])
    && isIntIn(raw.id, 1, 0xffff)
    && typeof raw.name === 'string'
    && raw.name.length >= 1
    && raw.name.length <= 100
    && cleanText(raw.name) === raw.name
  ) {
    return { kind: 'like', id: raw.id, name: raw.name };
  }
  return null;
}

function parseCustomEntry(raw: unknown): CustomSwitch | null {
  if (!isPlain(raw)) return null;
  for (const k of Object.keys(raw)) if (!CUSTOM_KEYS.has(k)) return null;
  if (typeof raw.uid !== 'string' || !USER_UID_RE.test(raw.uid)) return null;
  if (typeof raw.name !== 'string' || raw.name.length < 1 || raw.name.length > CUSTOM_NAME_MAX || cleanText(raw.name) !== raw.name) return null;
  if (typeof raw.maker !== 'string' || raw.maker.length > CUSTOM_MAKER_MAX || cleanText(raw.maker) !== raw.maker) return null;
  if (!isIntIn(raw.travelUm, TRAVEL_UM_MIN, TRAVEL_UM_MAX)) return null;
  if (!isIntIn(raw.rangeUm, FW_AXIS.rangeMin, FW_AXIS.rangeMax)) return null;
  if (!isIntIn(raw.coefficient, FW_AXIS.coefMin, FW_COEF_MAX)) return null;
  const curve = parseCurve(raw.curve);
  if (!curve) return null;
  if (typeof raw.color !== 'string' || (raw.color !== '' && !SWITCH_COLOR_HEXES.has(raw.color))) return null;
  // A stored entry without `note` reads as `note: ''` (§13).
  let note = '';
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string' || raw.note.length > CUSTOM_NOTE_MAX || cleanText(raw.note) !== raw.note) return null;
    note = raw.note;
  }
  return {
    uid: raw.uid as `u-${string}`,
    name: raw.name,
    maker: raw.maker,
    travelUm: raw.travelUm,
    rangeUm: raw.rangeUm,
    coefficient: raw.coefficient,
    curve,
    color: raw.color,
    note,
  };
}

function parseCustomStore(raw: string): CustomSwitch[] | null {
  const v = parseJson(raw);
  if (!isPlain(v) || !exactKeys(v, ['v', 'list']) || v.v !== 1 || !Array.isArray(v.list) || v.list.length > CUSTOM_SWITCH_MAX) {
    return null;
  }
  const out: CustomSwitch[] = [];
  const uids = new Set<string>();
  for (const item of v.list) {
    const e = parseCustomEntry(item);
    if (!e || uids.has(e.uid)) return null;
    uids.add(e.uid);
    out.push(e);
  }
  return out;
}

export function customValid(raw: string): boolean {
  return parseCustomStore(raw) !== null;
}

export function readCustomSwitches(): CustomSwitch[] {
  const raw = getStorage(CUSTOM_SWITCHES_KEY);
  return raw === null ? [] : parseCustomStore(raw) ?? [];
}

export function writeCustomSwitches(list: readonly CustomSwitch[]): void {
  const clean = list.slice(0, CUSTOM_SWITCH_MAX).map((s) => ({
    uid: s.uid,
    name: cleanText(s.name),
    maker: cleanText(s.maker),
    travelUm: Math.round(s.travelUm),
    rangeUm: Math.round(s.rangeUm),
    coefficient: Math.round(s.coefficient),
    curve: s.curve.kind === 'like' ? { kind: 'like' as const, id: s.curve.id, name: cleanText(s.curve.name) } : { kind: s.curve.kind },
    color: SWITCH_COLOR_HEXES.has(s.color) ? s.color : '',
    note: cleanText(s.note ?? ''),
  }));
  setStorage(CUSTOM_SWITCHES_KEY, JSON.stringify({ v: 1, list: clean }));
}

function parseGenericStore(raw: string): GenericDecl | null {
  const v = parseJson(raw);
  if (!isPlain(v) || !exactKeys(v, ['v', 'rangeUm']) || v.v !== 1) return null;
  if (!isIntIn(v.rangeUm, FW_AXIS.rangeMin, FW_AXIS.rangeMax)) return null;
  return { rangeUm: v.rangeUm };
}

export function genericValid(raw: string): boolean {
  return parseGenericStore(raw) !== null;
}

export function readGenericDecl(): GenericDecl | null {
  const raw = getStorage(GENERIC_SWITCH_KEY);
  return raw === null ? null : parseGenericStore(raw);
}

export function readGenericRangeUm(): number {
  return readGenericDecl()?.rangeUm ?? GENERIC_START;
}

export function writeGenericDecl(rangeUm: number): void {
  const clamped = clampInt(rangeUm, { min: FW_AXIS.rangeMin, max: FW_AXIS.rangeMax });
  setStorage(GENERIC_SWITCH_KEY, JSON.stringify({ v: 1, rangeUm: clamped }));
}

function parseAssignStore(raw: string): SwitchAssignData | null {
  const v = parseJson(raw);
  if (!isPlain(v) || !exactKeys(v, ['v', 'boards']) || v.v !== 1 || !isPlain(v.boards)) return null;
  const entries = Object.entries(v.boards);
  if (entries.length > ASSIGN_BOARD_MAX) return null;
  const boards: Record<string, BoardAssignments> = {};
  for (const [serial, board] of entries) {
    if (!serialReadable(serial) || !isPlain(board) || !exactKeys(board, ['at', 'keys'])) return null;
    if (typeof board.at !== 'number' || !Number.isFinite(board.at) || board.at < 0) return null;
    if (!isPlain(board.keys)) return null;
    const keys: Record<string, string> = {};
    for (const [keyId, uid] of Object.entries(board.keys)) {
      if (!KEY_ID_RE.test(keyId) || !isAssignableUid(uid)) return null;
      keys[keyId] = uid;
    }
    boards[serial] = { at: board.at, keys };
  }
  return { v: 1, boards };
}

export function assignValid(raw: string): boolean {
  return parseAssignStore(raw) !== null;
}

function readAssignStore(): SwitchAssignData {
  const raw = getStorage(SWITCH_ASSIGN_KEY);
  return raw === null ? { v: 1, boards: {} } : parseAssignStore(raw) ?? { v: 1, boards: {} };
}

function persistAssignStore(data: SwitchAssignData): void {
  if (!Object.keys(data.boards).length) removeStorage(SWITCH_ASSIGN_KEY);
  else setStorage(SWITCH_ASSIGN_KEY, JSON.stringify(data));
}

function trimAssignBoards(boards: Record<string, BoardAssignments>, keepSerial: string): Record<string, BoardAssignments> {
  const entries = Object.entries(boards);
  if (entries.length <= ASSIGN_BOARD_MAX) return boards;
  // Keep the written board and the most recently used others up to ASSIGN_BOARD_MAX.
  const keep = entries
    .map(([serial, b], idx) => ({ serial, b, idx }))
    .sort((a, b) => (b.serial === keepSerial ? 1 : 0) - (a.serial === keepSerial ? 1 : 0) || b.b.at - a.b.at || b.idx - a.idx)
    .slice(0, ASSIGN_BOARD_MAX);
  return Object.fromEntries(keep.map((x) => [x.serial, x.b]));
}

/** All known custom-switch uids: generic, shipped ready-made entries, and stored user entries. */
export function knownCustomUids(customs: readonly CustomSwitch[] = readCustomSwitches()): Set<string> {
  const set = new Set<string>([GENERIC_UID]);
  for (const r of READY_SWITCHES) set.add(r.uid);
  for (const u of customs) set.add(u.uid);
  return set;
}

/**
 * Assignments for a board (keyId → uid), ignoring entries whose uid is not in `knownUids` (§9.1).
 * Always empty when the board's serial is not readable.
 */
export function readAssignments(
  serialHex: string | null | undefined,
  knownUids: ReadonlySet<string> = knownCustomUids(),
): Record<number, string> {
  if (!serialReadable(serialHex)) return {};
  const board = readAssignStore().boards[serialHex];
  if (!board) return {};
  const out: Record<number, string> = {};
  for (const [k, uid] of Object.entries(board.keys)) {
    if (knownUids.has(uid)) out[Number(k)] = uid;
  }
  return out;
}

/**
 * Sets or removes per-key assignments for a board with a readable serial.
 * Drops pre-existing assignments on this board whose uid is not in `knownUids` (§9.1), and enforces the 8-board LRU cap.
 */
export function applyAssignments(
  serialHex: string | null | undefined,
  changes: Record<number, string | null>,
  opts: { knownUids?: ReadonlySet<string>; now?: number } = {},
): void {
  if (!serialReadable(serialHex)) return;
  const data = readAssignStore();
  const prev = data.boards[serialHex];
  const entries = Object.entries(changes);
  if (!prev && !entries.some(([, v]) => v !== null)) return;
  const known = opts.knownUids ?? knownCustomUids();
  const keys: Record<string, string> = {};
  if (prev) {
    for (const [k, uid] of Object.entries(prev.keys)) {
      if (known.has(uid)) keys[k] = uid;
    }
  }
  for (const [kStr, uid] of entries) {
    const id = Number(kStr);
    if (!Number.isInteger(id) || id < 0 || id > KEY_ID_MAX) continue;
    if (uid === null) delete keys[String(id)];
    else if (isAssignableUid(uid)) keys[String(id)] = uid;
  }
  if (!Object.keys(keys).length) {
    delete data.boards[serialHex];
  } else {
    delete data.boards[serialHex];
    data.boards[serialHex] = { at: opts.now ?? Date.now(), keys };
    data.boards = trimAssignBoards(data.boards, serialHex);
  }
  persistAssignStore(data);
}

export function setAssignments(
  serialHex: string | null | undefined,
  keys: Iterable<number>,
  uid: string,
  opts: { knownUids?: ReadonlySet<string>; now?: number } = {},
): void {
  if (!isAssignableUid(uid)) return;
  const changes: Record<number, string | null> = {};
  for (const id of keys) changes[id] = uid;
  applyAssignments(serialHex, changes, opts);
}

export function removeAssignments(
  serialHex: string | null | undefined,
  keys: Iterable<number>,
  opts: { knownUids?: ReadonlySet<string>; now?: number } = {},
): void {
  const changes: Record<number, string | null> = {};
  for (const id of keys) changes[id] = null;
  applyAssignments(serialHex, changes, opts);
}

/** "Quên" (§11.2): removes assignments for the given keys on this board (0 HID). */
export const forgetAssignments = removeAssignments;

/** Removes all assignments pointing to `uid` across every stored board (when a user switch is deleted, §9.1). */
export function forgetUid(uid: string): void {
  const data = readAssignStore();
  let changed = false;
  for (const [serial, board] of Object.entries(data.boards)) {
    for (const [k, v] of Object.entries(board.keys)) {
      if (v === uid) {
        delete board.keys[k];
        changed = true;
      }
    }
    if (!Object.keys(board.keys).length) delete data.boards[serial];
  }
  if (changed) persistAssignStore(data);
}

/** Removes all assignments for one board. */
export function forgetBoard(serialHex: string | null | undefined): void {
  if (!serialReadable(serialHex)) return;
  const data = readAssignStore();
  if (!data.boards[serialHex]) return;
  delete data.boards[serialHex];
  persistAssignStore(data);
}

// ---- Recalibration list (`ae64.switch.recal`, §10.1, §13) ----

/** Storage key for a board's recal list: `serialHex` when readable, else `board:{boardIdHex}` (§13). */
export function recalBoardKey(board: BoardRef): string | null {
  if (!board) return null;
  if (typeof board === 'string') return isRecalBoardKey(board) ? board : null;
  if (serialReadable(board.serialHex)) return board.serialHex;
  if (board.boardIdHex && /^[0-9a-f]{8}$/i.test(board.boardIdHex)) return `board:${board.boardIdHex.toLowerCase()}`;
  return null;
}

function parseRecalStore(raw: string): SwitchRecalData | null {
  const v = parseJson(raw);
  if (!isPlain(v) || !exactKeys(v, ['v', 'boards']) || v.v !== 1 || !isPlain(v.boards)) return null;
  const boards: Record<string, number[]> = {};
  for (const [bk, list] of Object.entries(v.boards)) {
    if (!isRecalBoardKey(bk) || !Array.isArray(list) || list.length > KEY_ID_MAX + 1) return null;
    const seen = new Set<number>();
    const out: number[] = [];
    for (const id of list) {
      if (!isIntIn(id, 0, KEY_ID_MAX) || seen.has(id)) return null;
      seen.add(id);
      out.push(id);
    }
    boards[bk] = out;
  }
  return { v: 1, boards };
}

export function recalValid(raw: string): boolean {
  return parseRecalStore(raw) !== null;
}

function readRecalStore(): SwitchRecalData {
  const raw = getStorage(SWITCH_RECAL_KEY);
  return raw === null ? { v: 1, boards: {} } : parseRecalStore(raw) ?? { v: 1, boards: {} };
}

function persistRecalStore(data: SwitchRecalData): void {
  if (!Object.keys(data.boards).length) removeStorage(SWITCH_RECAL_KEY);
  else setStorage(SWITCH_RECAL_KEY, JSON.stringify(data));
}

export function readRecalKeys(board: BoardRef): number[] {
  const bk = recalBoardKey(board);
  if (!bk) return [];
  return [...(readRecalStore().boards[bk] ?? [])].sort((a, b) => a - b);
}

export function addRecalKeys(board: BoardRef, keys: Iterable<number>): number[] {
  const bk = recalBoardKey(board);
  if (!bk) return [];
  const data = readRecalStore();
  const set = new Set<number>(data.boards[bk] ?? []);
  for (const id of keys) {
    if (isIntIn(id, 0, KEY_ID_MAX)) set.add(id);
  }
  const next = [...set].sort((a, b) => a - b);
  if (next.length) {
    data.boards[bk] = next;
    persistRecalStore(data);
  }
  return next;
}

export function clearRecalKeys(board: BoardRef, keys: Iterable<number>): number[] {
  const bk = recalBoardKey(board);
  if (!bk) return [];
  const data = readRecalStore();
  const cur = data.boards[bk];
  if (!cur) return [];
  const drop = new Set<number>(keys);
  const next = cur.filter((id) => !drop.has(id)).sort((a, b) => a - b);
  if (next.length) data.boards[bk] = next;
  else delete data.boards[bk];
  persistRecalStore(data);
  return next;
}

// ---- Keycap view display setting (`ae64.switch.caps`, §9.5) ----

export const isSwitchCaps = (raw: string | null): raw is SwitchCapsView => raw === 'photo' || raw === 'travel';

/** Switch tab keycap view: 'photo' (default) or 'travel'. Display only, 0 HID. */
export function switchCaps(): SwitchCapsView {
  const v = getStorage(SWITCH_CAPS_KEY);
  return isSwitchCaps(v) ? v : 'photo';
}

export function writeSwitchCaps(v: SwitchCapsView): void {
  setStorage(SWITCH_CAPS_KEY, v);
}
