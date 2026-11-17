// The online firmware list (DESIGN OFU §3.2, §4.1, §7): parse and check `/firmware/manifest.json`, compare versions, and say
// what the status card and step 2 show. Pure functions: nothing is fetched here (fwDownload.ts) and nothing is sent to a keyboard.
//
// Fail closed: one bad field refuses the whole list (§7.3). The list comes from the same origin and release as the code.
import { FW_HEADER_BYTES, FW_MAX_FILE, KNOWN_FW, boardHex, isFwBoard, thirdPartyVersions } from './firmware';
import type { KnownFw } from './firmware';

/** The list's fixed, relative URL: no query string, ever. */
export const FW_LIST_URL = '/firmware/manifest.json';
/** The list is at most this many bytes. */
export const FW_LIST_MAX_BYTES = 65_536;
/** The only host a build's `url` may name (answer (a), §2): the maker's file server, matched exactly. */
export const FW_FILE_HOST = 'hub.xsyd.top';
/** The only path a build's `url` may start with (DESIGN OFU v1.4 §7.3, §8): the CSP source is scoped to it. */
export const FW_FILE_PATH = '/storage/firmware/';
const NOTES_MAX = 280;

export interface FwBuild {
  board: number;
  name: string;
  version: string;
  appVersion: string;
  /** YYYY-MM-DD */
  date: string;
  kind: 'official';
  file: string;
  size: number;
  /** 64 lower-case hex digits */
  sha256: string;
  crc32: number;
  url: string;
  /** false: the app offers the maker's link and the picker instead of a download (§3.2). */
  fetch: boolean;
  notes: { vi: string; en: string };
}

export interface FwList {
  updated: string;
  /** Every build of the list, boards the app does not write included (they are kept out of every view). */
  builds: FwBuild[];
}

export type FwListParse = { ok: true; list: FwList } | { ok: false; why: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const VERSION = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** A version of four dot-separated numbers 0–255, as numbers; null otherwise. */
export function versionParts(v: unknown): number[] | null {
  if (typeof v !== 'string') return null;
  const m = VERSION.exec(v);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** Compares two versions part by part as numbers (`0.0.10.0` > `0.0.9.0`): < 0, 0, > 0. Both must parse. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a);
  const y = versionParts(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function validDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A build's URL: https, the maker's host exactly (no subdomain, port or user info), no query or fragment, a `.bin` path. */
export function allowedFileUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.username !== '' || u.password !== '' || u.port !== '') return false;
  if (u.hostname !== FW_FILE_HOST || u.host !== FW_FILE_HOST) return false;
  if (u.search !== '' || u.hash !== '' || v.includes('?') || v.includes('#')) return false;
  // the path as the CSP sees it: under /storage/firmware/, plain segments only (no dot segments, no escapes)
  const p = u.pathname;
  if (!p.startsWith(FW_FILE_PATH) || !/^[A-Za-z0-9._/-]+$/.test(p) || p.split('/').some((s) => s === '.' || s === '..')) return false;
  // written exactly as the browser will request it (no case, dot-segment or escape rewriting between the check and the fetch)
  if (u.href !== v) return false;
  return /\.bin$/.test(p);
}

function parseBuild(b: unknown, i: number): FwBuild | string {
  const at = `builds[${i}]`;
  if (!isObj(b)) return `${at} is not an object`;
  if (typeof b.board !== 'string' || !/^[0-9A-F]{8}$/.test(b.board)) return `${at}.board`;
  if (typeof b.name !== 'string' || b.name.trim() === '' || b.name.length > 80) return `${at}.name`;
  if (!versionParts(b.version)) return `${at}.version`;
  if (!versionParts(b.appVersion)) return `${at}.appVersion`;
  if (!validDate(b.date)) return `${at}.date`;
  if (b.kind !== 'official') return `${at}.kind`; // schema 1 lists only official builds
  if (typeof b.file !== 'string' || !/^[\w.-]{1,200}\.bin$/.test(b.file)) return `${at}.file`;
  if (typeof b.size !== 'number' || !Number.isInteger(b.size) || b.size <= FW_HEADER_BYTES || b.size > FW_MAX_FILE) return `${at}.size`;
  if (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256)) return `${at}.sha256`;
  if (typeof b.crc32 !== 'string' || !/^[0-9a-f]{8}$/.test(b.crc32)) return `${at}.crc32`;
  if (!allowedFileUrl(b.url)) return `${at}.url`;
  if (typeof b.fetch !== 'boolean') return `${at}.fetch`;
  let notes = { vi: '', en: '' };
  if (b.notes !== undefined) {
    if (!isObj(b.notes)) return `${at}.notes`;
    for (const k of Object.keys(b.notes)) if (k !== 'vi' && k !== 'en') return `${at}.notes.${k}`;
    for (const k of ['vi', 'en'] as const) {
      const n = b.notes[k];
      if (n !== undefined && (typeof n !== 'string' || n.length > NOTES_MAX)) return `${at}.notes.${k}`;
    }
    notes = { vi: (b.notes.vi as string | undefined) ?? '', en: (b.notes.en as string | undefined) ?? '' };
  }
  return {
    board: parseInt(b.board, 16) >>> 0, name: b.name, version: b.version as string, appVersion: b.appVersion as string, date: b.date,
    kind: 'official', file: b.file, size: b.size, sha256: b.sha256, crc32: parseInt(b.crc32, 16) >>> 0, url: b.url, fetch: b.fetch, notes,
  };
}

/**
 * The checks of DESIGN OFU §7.3 on the list's text. Any failure refuses the whole list (`ok: false`): nothing of it is used.
 * A build whose CRC-32 is in KNOWN_FW must agree with it (board, name, version, appVersion, kind).
 */
export function parseFwList(text: string): FwListParse {
  if (text.length > FW_LIST_MAX_BYTES) return { ok: false, why: 'too long' };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, why: 'not JSON' };
  }
  if (!isObj(data)) return { ok: false, why: 'not an object' };
  if (data.schema !== 1) return { ok: false, why: 'schema' };
  if (!validDate(data.updated)) return { ok: false, why: 'updated' };
  if (!Array.isArray(data.builds) || data.builds.length < 1 || data.builds.length > 64) return { ok: false, why: 'builds' };
  const builds: FwBuild[] = [];
  for (let i = 0; i < data.builds.length; i++) {
    const b = parseBuild(data.builds[i], i);
    if (typeof b === 'string') return { ok: false, why: b };
    builds.push(b);
  }
  const shas = new Set<string>();
  const ids = new Set<string>();
  for (const b of builds) {
    const id = `${b.board}:${b.version}`;
    if (shas.has(b.sha256) || ids.has(id)) return { ok: false, why: `duplicate ${boardHex(b.board)} ${b.version}` };
    shas.add(b.sha256);
    ids.add(id);
    const k = KNOWN_FW.find((x) => x.crc === b.crc32);
    if (k && (k.board !== b.board || k.name !== b.name || k.version !== b.version || k.appVersion !== b.appVersion || k.kind !== b.kind)) {
      return { ok: false, why: `${boardHex(b.board)} ${b.version} disagrees with the app's table` };
    }
  }
  return { ok: true, list: { updated: data.updated, builds } };
}

/** The listed builds for a board the app writes, newest first; none for any other board. */
export function buildsFor(list: FwList | null, board: number | null): FwBuild[] {
  if (!list || !isFwBoard(board)) return [];
  return list.builds.filter((b) => b.board === board >>> 0).sort((a, b) => compareVersions(b.version, a.version));
}

/** A listed build as the app's table entry (it is then recognised by its CRC-32 for this page's life). */
export const asKnown = (b: FwBuild): KnownFw => ({
  board: b.board, crc: b.crc32, name: b.name, version: b.version, kind: 'official', appVersion: b.appVersion, gamepad: null,
});

/** What the keyboard runs on a Pro, from the gamepad INFO (DESIGN OFU §3.2): null while it is being read. */
export type FwKind = 'stock' | 'agp1' | 'unknown';

/** The status card's states (DESIGN OFU §3.2). */
export type FwStatus =
  | 'loading' | 'newer' | 'uptodate' | 'ahead' | 'third' | 'rescue' | 'noVersion' | 'kindUnknown' | 'none' | 'offline' | 'invalid';

export type FwListState = 'idle' | 'loading' | 'ok' | 'offline' | 'invalid';

export interface FwStatusInput {
  listState: FwListState;
  list: FwList | null;
  board: number | null;
  rescue: boolean;
  /** The version the keyboard reports from its app (`01 02`); null when unknown. */
  current: string | null;
  /** A Pro's kind; null while it is being read (Max and rescue: not asked). */
  kind: FwKind | null;
}

/** True when the Pro's version is one a third-party build also reports, and INFO did not say which it is. */
function kindUnknownAt(i: { board: number | null; current: string | null; kind: FwKind | null }): boolean {
  return i.kind === 'unknown' && i.current !== null && thirdPartyVersions(i.board).includes(i.current);
}

/** The status card and the build it offers (the newest official build for the board). */
export function fwStatus(i: FwStatusInput): { status: FwStatus; newest: FwBuild | null } {
  if (i.listState === 'idle' || i.listState === 'loading') return { status: 'loading', newest: null };
  if (i.listState === 'offline') return { status: 'offline', newest: null };
  if (i.listState === 'invalid' || !i.list) return { status: 'invalid', newest: null };
  const newest = buildsFor(i.list, i.board)[0] ?? null;
  if (!newest) return { status: 'none', newest: null };
  if (i.rescue) return { status: 'rescue', newest };
  if (!versionParts(i.current)) return { status: 'noVersion', newest };
  const asksKind = thirdPartyVersions(i.board).length > 0; // a Pro: INFO tells the official build from XInput
  if (asksKind && i.kind === null) return { status: 'loading', newest: null };
  if (i.kind === 'agp1' && asksKind) return { status: 'third', newest };
  if (kindUnknownAt(i)) return { status: 'kindUnknown', newest };
  const c = compareVersions(newest.appVersion, i.current!);
  return { status: c > 0 ? 'newer' : c === 0 ? 'uptodate' : 'ahead', newest };
}

/** How a known build stands against the keyboard (DESIGN OFU §4.1); null: no version line and no box. */
export type FwRelation = 'newer' | 'same' | 'older' | 'third' | 'kindUnknown';

/**
 * An official build against the keyboard. Null for a third-party or unknown file, an unknown keyboard version or rescue mode.
 * "Official over a third-party build" and "kind unknown" replace the compare for any official build: the version an XInput
 * build reports says nothing about the official builds' order. `kind` null (not read) counts as unknown here.
 */
export function fwRelation(k: KnownFw | null, i: { board: number | null; current: string | null; kind: FwKind | null; rescue: boolean }): FwRelation | null {
  if (!k || k.kind !== 'official' || i.rescue || !versionParts(i.current) || !versionParts(k.appVersion)) return null;
  const asksKind = thirdPartyVersions(i.board).length > 0;
  if (asksKind && i.kind === 'agp1') return 'third';
  if (asksKind && kindUnknownAt({ ...i, kind: i.kind ?? 'unknown' })) return 'kindUnknown';
  const c = compareVersions(k.appVersion, i.current!);
  return c > 0 ? 'newer' : c < 0 ? 'older' : 'same';
}
