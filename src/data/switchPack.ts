// Switch pack JSON import, export and template (DESIGN CSW §6.7).
// Pure module: files are untrusted; parsing writes nothing to localStorage or the keyboard.
import {
  CUSTOM_MAKER_MAX, CUSTOM_NAME_MAX, CUSTOM_NOTE_MAX, CUSTOM_SWITCH_MAX, SWITCH_COLOR_HEXES,
  cleanText, coefFromTravel, foldText,
} from './customSwitch';
import type { CustomSwitch } from './customSwitch';
import type { ReadyBounds } from './readySwitches';

export const PACK_FORMAT = 'ae64-switch-pack';
export const PACK_SCHEMA = 1;
export const PACK_MAX_BYTES = 65_536;
export const PACK_MAX_ENTRIES = 200;
export const PACK_TEMPLATE_FILE = 'ae64-switch-pack-template.json';

export type Bounds = ReadyBounds;

export interface PackEntry {
  name: string;
  maker?: string;
  travelMm: number;
  coefficient?: number;
  color?: string;
  note?: string;
}

export interface CleanEntry {
  name: string;
  maker: string;
  travelUm: number;
  rangeUm: number;
  coefficient: number;
  curve: { kind: 'travel' } | { kind: 'manual' };
  color: string;
  note: string;
}

export type SkipReason = 'field' | 'type' | 'name' | 'text' | 'travel' | 'coef' | 'color' | 'nameTaken' | 'dupInFile' | 'full';
export type PackFileError = 'tooBig' | 'json' | 'format' | 'schema' | 'field' | 'switches' | 'tooMany';

export interface PackRow {
  entry: CleanEntry | null;
  name: string;
  status: 'add' | 'skip';
  why?: SkipReason;
  field?: string;
  clamped?: boolean;
}

export type ParsedPack =
  | { ok: true; rows: PackRow[] }
  | { ok: false; why: PackFileError; field?: string; version?: unknown };

const FILE_KEYS = new Set(['format', 'schema', 'exportedAt', 'switches']);
const ENTRY_KEYS = new Set(['name', 'maker', 'travelMm', 'coefficient', 'color', 'note']);
const ENTRY_TYPES: readonly (readonly [keyof PackEntry, 'string' | 'number'])[] = [
  ['name', 'string'],
  ['maker', 'string'],
  ['travelMm', 'number'],
  ['coefficient', 'number'],
  ['color', 'string'],
  ['note', 'string'],
];

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const encoder = new TextEncoder();

/** True when a file's byte size exceeds PACK_MAX_BYTES (checked before reading the file). */
export function packTooBig(bytes: number): boolean {
  return bytes > PACK_MAX_BYTES;
}

function utf8Bytes(text: string): number {
  return text.length > PACK_MAX_BYTES ? text.length : encoder.encode(text).length;
}

/**
 * Parses and validates an untrusted switch-pack JSON string.
 * Whole-file checks run first (including size cap before JSON.parse); per-entry rules 1–8 run in order (§6.7).
 */
export function parsePack(text: string, ctx: { existing: readonly CustomSwitch[]; bounds: Bounds }): ParsedPack {
  if (packTooBig(utf8Bytes(text))) return { ok: false, why: 'tooBig' };
  let file: unknown;
  try { file = JSON.parse(text); } catch { return { ok: false, why: 'json' }; }
  if (!isPlain(file) || file.format !== PACK_FORMAT) return { ok: false, why: 'format' };
  if (file.schema !== PACK_SCHEMA) return { ok: false, why: 'schema', version: file.schema };
  for (const k of Object.keys(file)) {
    if (!FILE_KEYS.has(k)) return { ok: false, why: 'field', field: k };
  }
  if (!Array.isArray(file.switches)) return { ok: false, why: 'switches' };
  if (file.switches.length > PACK_MAX_ENTRIES) return { ok: false, why: 'tooMany' };

  const { existing, bounds } = ctx;
  const existingNames = new Set(existing.map((e) => foldText(e.name)));
  const addedNames = new Set<string>();
  let added = 0;
  const rows: PackRow[] = [];

  for (const raw of file.switches) {
    // Rule 1: not an object, or unknown key.
    if (!isPlain(raw)) {
      rows.push({ entry: null, name: '', status: 'skip', why: 'field', field: '' });
      continue;
    }
    const displayName = typeof raw.name === 'string' ? cleanText(raw.name) : '';
    const badKey = Object.keys(raw).find((k) => !ENTRY_KEYS.has(k));
    if (badKey !== undefined) {
      rows.push({ entry: null, name: displayName, status: 'skip', why: 'field', field: badKey });
      continue;
    }

    // Rule 2: field of the wrong JSON type.
    const badType = ENTRY_TYPES.find(([k, want]) => raw[k] !== undefined && typeof raw[k] !== want);
    if (badType) {
      rows.push({ entry: null, name: displayName, status: 'skip', why: 'type', field: badType[0] });
      continue;
    }

    // Rule 3: text cleaning and length limits.
    const name = raw.name === undefined ? '' : cleanText(raw.name as string);
    if (name.length < 1 || name.length > CUSTOM_NAME_MAX) {
      rows.push({ entry: null, name, status: 'skip', why: 'name' });
      continue;
    }
    const maker = raw.maker === undefined ? '' : cleanText(raw.maker as string);
    const note = raw.note === undefined ? '' : cleanText(raw.note as string);
    if (maker.length > CUSTOM_MAKER_MAX || note.length > CUSTOM_NOTE_MAX) {
      rows.push({ entry: null, name, status: 'skip', why: 'text' });
      continue;
    }

    // Rule 4: travelMm finite and 1–6.
    const travelMm = raw.travelMm as number | undefined;
    if (travelMm === undefined || !Number.isFinite(travelMm) || travelMm < 1 || travelMm > 6) {
      rows.push({ entry: null, name, status: 'skip', why: 'travel' });
      continue;
    }
    const travelUm = Math.round(travelMm * 1000);
    const rangeUm = Math.min(bounds.rMax, Math.max(bounds.rMin, travelUm));
    const clamped = rangeUm !== travelUm;

    // Rule 5: coefficient (if present) integer within bounds — never clamped.
    const rawCoef = raw.coefficient as number | undefined;
    let coefficient: number;
    let curve: { kind: 'travel' } | { kind: 'manual' };
    if (rawCoef !== undefined) {
      if (!Number.isInteger(rawCoef) || rawCoef < bounds.cMin || rawCoef > bounds.cMax) {
        rows.push({ entry: null, name, status: 'skip', why: 'coef' });
        continue;
      }
      coefficient = rawCoef;
      curve = { kind: 'manual' };
    } else {
      coefficient = coefFromTravel(rangeUm, { min: bounds.cMin, max: bounds.cMax });
      curve = { kind: 'travel' };
    }

    // Rule 6: color (if present) one of §9.4's lowercase hexes.
    const rawColor = raw.color as string | undefined;
    if (rawColor !== undefined && !SWITCH_COLOR_HEXES.has(rawColor)) {
      rows.push({ entry: null, name, status: 'skip', why: 'color' });
      continue;
    }
    const color = rawColor ?? '';

    // Rule 7: folded name collision with existing user entry or an earlier added row.
    const folded = foldText(name);
    if (existingNames.has(folded)) {
      rows.push({ entry: null, name, status: 'skip', why: 'nameTaken' });
      continue;
    }
    if (addedNames.has(folded)) {
      rows.push({ entry: null, name, status: 'skip', why: 'dupInFile' });
      continue;
    }

    // Rule 8: 50-entry cap on user switches.
    if (existing.length + added >= CUSTOM_SWITCH_MAX) {
      rows.push({ entry: null, name, status: 'skip', why: 'full' });
      continue;
    }

    added++;
    addedNames.add(folded);
    rows.push({
      entry: { name, maker, travelUm, rangeUm, coefficient, curve, color, note },
      name,
      status: 'add',
      clamped,
    });
  }

  return { ok: true, rows };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function packExportFileName(now = new Date()): string {
  return `ae64-switches-${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}.json`;
}

/**
 * Exports user custom switches as a shareable switch pack: 2-space JSON, LF, trailing LF.
 * Carries switches only — never uid, serial, assignments, or generic declaration (§6.7).
 */
export function exportPack(list: readonly CustomSwitch[], now = new Date()): string {
  const switches: PackEntry[] = list.map((s) => ({
    name: s.name,
    ...(s.maker ? { maker: s.maker } : {}),
    travelMm: s.travelUm / 1000,
    coefficient: s.coefficient,
    ...(s.color ? { color: s.color } : {}),
    ...(s.note ? { note: s.note } : {}),
  }));
  return `${JSON.stringify({ format: PACK_FORMAT, schema: PACK_SCHEMA, exportedAt: now.toISOString(), switches }, null, 2)}\n`;
}

export const PACK_TEMPLATE = [
  '{',
  '  "format": "ae64-switch-pack",',
  '  "schema": 1,',
  '  "switches": [',
  '    { "maker": "Maker", "name": "Switch name", "travelMm": 3.5 },',
  '    { "maker": "Maker", "name": "Another switch", "travelMm": 3.4, "coefficient": 20550, "color": "#9b6cf0", "note": "Optional, up to 120 characters." }',
  '  ]',
  '}',
  '',
].join('\n');
