// CSW step 2: switch pack parsing, validation, export and template
// (DESIGN §6.7, §19 Test 18 parse/export half; mutants M16 pack half, M21, M22, M24).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PACK_FORMAT, PACK_MAX_BYTES, PACK_MAX_ENTRIES, PACK_SCHEMA, PACK_TEMPLATE,
  exportPack, packExportFileName, packTooBig, parsePack,
} from '../src/data/switchPack';
import { CUSTOM_SWITCH_MAX, SWITCH_COLORS, cleanText } from '../src/data/customSwitch';
import type { CustomSwitch } from '../src/data/customSwitch';
import { READY_BOUNDS } from '../src/data/readySwitches';

const packOf = (switches: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: PACK_FORMAT, schema: PACK_SCHEMA, switches, ...extra });

const ctx = (existing: readonly CustomSwitch[] = []) => ({ existing, bounds: READY_BOUNDS });

const mkCustom = (i: number, over: Partial<CustomSwitch> = {}): CustomSwitch => ({
  uid: `u-${String(i).padStart(12, '0')}`,
  name: `Custom ${i}`,
  maker: 'Wuque Studio',
  travelUm: 3500,
  rangeUm: 3500,
  coefficient: 19850,
  curve: { kind: 'manual' },
  color: '#9b6cf0',
  note: '',
  ...over,
});

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

describe('PACK_TEMPLATE and exportPack → parsePack round trip — CSW Test 18', () => {
  it('PACK_TEMPLATE imports cleanly into an empty list as two entries', () => {
    expect(PACK_TEMPLATE.endsWith('\n')).toBe(true);
    expect(PACK_TEMPLATE).not.toContain('\r');
    const res = parsePack(PACK_TEMPLATE, ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0]).toEqual({
      name: 'Switch name',
      status: 'add',
      clamped: false,
      entry: {
        name: 'Switch name',
        maker: 'Maker',
        travelUm: 3500,
        rangeUm: 3500,
        coefficient: 19850,
        curve: { kind: 'travel' },
        color: '',
        note: '',
      },
    });
    expect(res.rows[1]).toEqual({
      name: 'Another switch',
      status: 'add',
      clamped: false,
      entry: {
        name: 'Another switch',
        maker: 'Maker',
        travelUm: 3400,
        rangeUm: 3400,
        coefficient: 20550,
        curve: { kind: 'manual' },
        color: '#9b6cf0',
        note: 'Optional, up to 120 characters.',
      },
    });
  });

  it('exportPack writes 2-space LF JSON with trailing LF, carries no uid / serial / assignment / generic, and round-trips (kills M16 pack half)', () => {
    const serial = '360812504339463536051657';
    localStorage.setItem('ae64.switch.assign', JSON.stringify({ v: 1, boards: { [serial]: { at: 100, keys: { 0: 'u-000000000001' } } } }));
    localStorage.setItem('ae64.switch.generic', JSON.stringify({ v: 1, rangeUm: 3800 }));

    const now = new Date('2026-11-22T05:30:00.000Z');
    const three: CustomSwitch[] = [
      mkCustom(1, { name: 'WS Flux Aurora', maker: 'Wuque Studio', travelUm: 3500, rangeUm: 3500, coefficient: 17536, color: '#4f8ef7', note: 'Factory lubed' }),
      mkCustom(2, { name: 'Kiwi HE', maker: '', travelUm: 3400, rangeUm: 3400, coefficient: 20550, curve: { kind: 'travel' }, color: '', note: '' }),
      mkCustom(3, { name: 'Ghost 41', maker: 'Ghost Lab', travelUm: 4100, rangeUm: 4015, coefficient: 15100, color: '#f07ab8', note: 'Long travel' }),
    ];
    const text = exportPack(three, now);
    expect(text).toContain('\n  "format": "ae64-switch-pack"');
    expect(text).not.toContain('\r');
    expect(text.endsWith('\n')).toBe(true);
    expect(packExportFileName(new Date(2026, 10, 22))).toBe('ae64-switches-2026-11-22.json');

    // No uid, serial, assignment or generic declaration anywhere in the export.
    const raw = JSON.parse(text);
    expect(Object.keys(raw).sort()).toEqual(['exportedAt', 'format', 'schema', 'switches']);
    expect(raw.exportedAt).toBe('2026-11-22T05:30:00.000Z');
    expect(text).not.toContain('u-00000000000');
    expect(text).not.toContain(serial);
    expect(text).not.toContain('serial');
    expect(text).not.toContain('assign');
    expect(text).not.toContain('g-generic');
    expect(text).not.toContain('3800');
    for (const sw of raw.switches as Record<string, unknown>[]) {
      expect(sw.uid).toBeUndefined();
      expect(sw.boards).toBeUndefined();
      expect(sw.keys).toBeUndefined();
    }
    // Empty optional fields omitted from export.
    expect(raw.switches[1]).toEqual({ name: 'Kiwi HE', travelMm: 3.4, coefficient: 20550 });

    // Round-trip into an empty list preserves every value.
    const parsed = parsePack(text, ctx());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rows.map((r) => r.status)).toEqual(['add', 'add', 'add']);
    expect(parsed.rows[2].clamped).toBe(true);
    for (let i = 0; i < three.length; i++) {
      const e = parsed.rows[i].entry!;
      expect({
        name: e.name, maker: e.maker, travelUm: e.travelUm, rangeUm: e.rangeUm,
        coefficient: e.coefficient, color: e.color, note: e.note,
      }).toEqual({
        name: three[i].name, maker: three[i].maker, travelUm: three[i].travelUm, rangeUm: three[i].rangeUm,
        coefficient: three[i].coefficient, color: three[i].color, note: three[i].note,
      });
    }
  });
});

describe('parsePack per-entry rules 1–8 in order', () => {
  it('skips unknown entry fields and non-object entries with why: "field" (kills M22)', () => {
    const res = parsePack(packOf([
      null,
      123,
      [],
      { name: 'HasUid', travelMm: 3.5, uid: 'u-1234567890ab' },
      { name: 'HasExtra', travelMm: 3.5, extra: true },
    ]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => [r.status, r.why, r.field])).toEqual([
      ['skip', 'field', ''],
      ['skip', 'field', ''],
      ['skip', 'field', ''],
      ['skip', 'field', 'uid'],
      ['skip', 'field', 'extra'],
    ]);
  });

  it('skips wrong JSON types (including NaN-as-string for travelMm) with why: "type"', () => {
    const res = parsePack(packOf([
      { name: 123, travelMm: 3.5 },
      { name: 'BadMaker', maker: 42, travelMm: 3.5 },
      { name: 'NaNTravel', travelMm: 'NaN' },
      { name: 'StrTravel', travelMm: '3.5' },
      { name: 'StrCoef', travelMm: 3.5, coefficient: '20000' },
      { name: 'NumColor', travelMm: 3.5, color: 123 },
      { name: 'BoolNote', travelMm: 3.5, note: false },
    ]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => [r.status, r.why, r.field])).toEqual([
      ['skip', 'type', 'name'],
      ['skip', 'type', 'maker'],
      ['skip', 'type', 'travelMm'],
      ['skip', 'type', 'travelMm'],
      ['skip', 'type', 'coefficient'],
      ['skip', 'type', 'color'],
      ['skip', 'type', 'note'],
    ]);
  });

  it('enforces name 1–40, maker ≤ 24 and note ≤ 120 after text cleaning', () => {
    const res = parsePack(packOf([
      { travelMm: 3.5 },
      { name: '', travelMm: 3.5 },
      { name: '  \u202E\u0007  ', travelMm: 3.5 },
      { name: 'a'.repeat(41), travelMm: 3.5 },
      { name: 'a'.repeat(40), travelMm: 3.5 },
      { name: 'LongMaker', maker: 'm'.repeat(25), travelMm: 3.5 },
      { name: 'MaxMaker', maker: 'm'.repeat(24), travelMm: 3.5 },
      { name: 'LongNote', note: 'n'.repeat(121), travelMm: 3.5 },
      { name: 'MaxNote', note: 'n'.repeat(120), travelMm: 3.5 },
    ]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => [r.status, r.why])).toEqual([
      ['skip', 'name'],
      ['skip', 'name'],
      ['skip', 'name'],
      ['skip', 'name'],
      ['add', undefined],
      ['skip', 'text'],
      ['add', undefined],
      ['skip', 'text'],
      ['add', undefined],
    ]);
  });

  it('validates travelMm 1–6 and clamps in-range travel to bounds with clamped: true', () => {
    const res = parsePack(packOf([
      { name: 'Missing' },
      { name: 'TooShort', travelMm: 0.9 },
      { name: 'TooLong', travelMm: 6.1 },
      { name: 'ClampLow', travelMm: 1.0 },
      { name: 'ClampHigh', travelMm: 4.1 },
      { name: 'ClampMax', travelMm: 6.0 },
      { name: 'Exact', travelMm: 3.5 },
    ]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.slice(0, 3).map((r) => [r.status, r.why])).toEqual([
      ['skip', 'travel'],
      ['skip', 'travel'],
      ['skip', 'travel'],
    ]);
    expect(res.rows[3]).toMatchObject({ status: 'add', clamped: true, entry: { travelUm: 1000, rangeUm: 3130 } });
    expect(res.rows[4]).toMatchObject({ status: 'add', clamped: true, entry: { travelUm: 4100, rangeUm: 4015, coefficient: 15100 } });
    expect(res.rows[5]).toMatchObject({ status: 'add', clamped: true, entry: { travelUm: 6000, rangeUm: 4015 } });
    expect(res.rows[6]).toMatchObject({ status: 'add', clamped: false, entry: { travelUm: 3500, rangeUm: 3500, coefficient: 19850 } });
  });

  it('skips coefficient outside bounds or non-integer instead of clamping (kills M21)', () => {
    const res = parsePack(packOf([
      { name: 'LowC', travelMm: 3.5, coefficient: 13299 },
      { name: 'HighC', travelMm: 3.5, coefficient: 26801 },
      { name: 'FracC', travelMm: 3.5, coefficient: 20000.5 },
      { name: 'MinC', travelMm: 3.5, coefficient: 13300 },
      { name: 'MaxC', travelMm: 3.5, coefficient: 26800 },
    ]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => [r.status, r.why])).toEqual([
      ['skip', 'coef'],
      ['skip', 'coef'],
      ['skip', 'coef'],
      ['add', undefined],
      ['add', undefined],
    ]);
    expect(res.rows[3].entry?.curve).toEqual({ kind: 'manual' });
  });

  it('accepts only the 10 lowercase §9.4 colour hexes when color is present', () => {
    const paletteHexes = SWITCH_COLORS.map((c) => c.hex).filter((h) => h !== '');
    const entries = [
      { name: 'BadHex', travelMm: 3.5, color: '#123456' },
      { name: 'UpperHex', travelMm: 3.5, color: '#9B6CF0' },
      { name: 'EmptyStr', travelMm: 3.5, color: '' },
      ...paletteHexes.map((hex, i) => ({ name: `Col${i}`, travelMm: 3.5, color: hex })),
    ];
    const res = parsePack(packOf(entries), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.slice(0, 3).map((r) => [r.status, r.why])).toEqual([
      ['skip', 'color'],
      ['skip', 'color'],
      ['skip', 'color'],
    ]);
    expect(res.rows.slice(3).every((r) => r.status === 'add')).toBe(true);
  });

  it('enforces nameTaken, dupInFile (only against added rows) and the 50-entry full cap', () => {
    const existing = [mkCustom(1, { name: 'WS Flux' })];
    const res = parsePack(packOf([
      { name: 'ws flúx', travelMm: 3.5 },                 // folded collision with existing → nameTaken
      { name: 'Retry', travelMm: 3.5, coefficient: 999 }, // skipped (coef) — does NOT reserve "Retry"
      { name: 'Retry', travelMm: 3.5 },                   // valid → added
      { name: 'RETRY', travelMm: 3.5 },                   // folded collision with added Retry → dupInFile
    ]), ctx(existing));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows.map((r) => [r.status, r.why])).toEqual([
      ['skip', 'nameTaken'],
      ['skip', 'coef'],
      ['add', undefined],
      ['skip', 'dupInFile'],
    ]);

    // 49 existing + 2 valid entries → 50th added, 51st skipped with 'full'.
    const fortyNine = Array.from({ length: CUSTOM_SWITCH_MAX - 1 }, (_, i) => mkCustom(i));
    const capRes = parsePack(packOf([
      { name: 'Fifty', travelMm: 3.5 },
      { name: 'FiftyOne', travelMm: 3.5 },
    ]), ctx(fortyNine));
    expect(capRes.ok).toBe(true);
    if (!capRes.ok) return;
    expect(capRes.rows.map((r) => [r.status, r.why])).toEqual([
      ['add', undefined],
      ['skip', 'full'],
    ]);
  });

  it('applies the eight per-entry rules in strict order (first failing rule wins)', () => {
    const existing = [mkCustom(1, { name: 'Taken' })];
    // Fails rules 1 (unknown field), 2 (wrong type), 3 (empty name), 4 (bad travel), 5 (bad coef), 6 (bad color) → rule 1 wins.
    const r1 = parsePack(packOf([{ name: '', travelMm: 'bad', coefficient: 1, color: '#000', nope: 1 }]), ctx(existing));
    expect(r1.ok && r1.rows[0]).toMatchObject({ status: 'skip', why: 'field', field: 'nope' });

    // Fails rules 2 (wrong type on maker) and 3 (empty name) → rule 2 wins.
    const r2 = parsePack(packOf([{ name: '', maker: 9, travelMm: 0.1 }]), ctx(existing));
    expect(r2.ok && r2.rows[0]).toMatchObject({ status: 'skip', why: 'type', field: 'maker' });

    // Fails rules 5 (bad coef) and 7 (nameTaken) → rule 5 wins.
    const r5 = parsePack(packOf([{ name: 'Taken', travelMm: 3.5, coefficient: 5 }]), ctx(existing));
    expect(r5.ok && r5.rows[0]).toMatchObject({ status: 'skip', why: 'coef' });
  });

  it('strips control and bidi direction-override characters, normalises NFC and keeps HTML text literal; writes 0 localStorage', () => {
    const nfd = 'Cafe\u0301'; // NFD Café
    const dirtyName = `\u202E  \u0000${nfd}\u0007\u007F\u0085\u200E\u200F\u202A\u2066\u2069  `;
    expect(cleanText(dirtyName)).toBe('Café');

    const xss = '<img src=x onerror=alert(1)>';
    const res = parsePack(packOf([
      { name: dirtyName, maker: '\u202EBrand\u001F', travelMm: 3.5, note: 'Line1\nLine2\u2067' },
      { name: xss, travelMm: 3.4 },
    ]), ctx());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.rows[0].entry).toMatchObject({ name: 'Café', maker: 'Brand', note: 'Line1Line2' });
    expect(res.rows[1].entry?.name).toBe(xss);
    expect(localStorage.length).toBe(0);
  });
});

describe('parsePack whole-file refusals and size cap', () => {
  it('refuses a 65 537-byte file before JSON.parse and accepts 65 536 bytes (kills M24)', () => {
    expect(packTooBig(PACK_MAX_BYTES)).toBe(false);
    expect(packTooBig(PACK_MAX_BYTES + 1)).toBe(true);

    const spy = vi.spyOn(JSON, 'parse');
    const overAscii = ' '.repeat(PACK_MAX_BYTES + 1);
    expect(parsePack(overAscii, ctx())).toEqual({ ok: false, why: 'tooBig' });
    expect(spy).not.toHaveBeenCalled();

    // Multi-byte UTF-8: fewer than 65 536 UTF-16 code units, yet > 65 536 UTF-8 bytes.
    const overUtf8 = 'é'.repeat(PACK_MAX_BYTES / 2 + 1); // 32 769 chars = 65 538 UTF-8 bytes
    expect(overUtf8.length).toBeLessThan(PACK_MAX_BYTES);
    expect(parsePack(overUtf8, ctx())).toEqual({ ok: false, why: 'tooBig' });
    expect(spy).not.toHaveBeenCalled();

    // Exactly 65 536 bytes of valid JSON parses.
    const base = packOf([{ name: 'Exact', travelMm: 3.5 }]);
    const exact64k = base + ' '.repeat(PACK_MAX_BYTES - base.length);
    expect(new TextEncoder().encode(exact64k).length).toBe(PACK_MAX_BYTES);
    const ok = parsePack(exact64k, ctx());
    expect(ok.ok).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('returns the exact PackFileError for every broken file shape', () => {
    expect(parsePack('{bad', ctx())).toEqual({ ok: false, why: 'json' });
    expect(parsePack('[]', ctx())).toEqual({ ok: false, why: 'format' });
    expect(parsePack(JSON.stringify({ format: 'other', schema: 1, switches: [] }), ctx())).toEqual({ ok: false, why: 'format' });
    expect(parsePack(JSON.stringify({ format: PACK_FORMAT, schema: 2, switches: [] }), ctx())).toEqual({ ok: false, why: 'schema', version: 2 });
    expect(parsePack(JSON.stringify({ format: PACK_FORMAT, schema: 1, extra: 1, switches: [] }), ctx())).toEqual({ ok: false, why: 'field', field: 'extra' });
    expect(parsePack('{"format":"ae64-switch-pack","schema":1,"__proto__":{},"switches":[]}', ctx())).toEqual({ ok: false, why: 'field', field: '__proto__' });
    expect(parsePack(JSON.stringify({ format: PACK_FORMAT, schema: 1 }), ctx())).toEqual({ ok: false, why: 'switches' });
    expect(parsePack(JSON.stringify({ format: PACK_FORMAT, schema: 1, switches: {} }), ctx())).toEqual({ ok: false, why: 'switches' });

    const tooMany = Array.from({ length: PACK_MAX_ENTRIES + 1 }, (_, i) => ({ name: `S${i}`, travelMm: 3.5 }));
    expect(parsePack(packOf(tooMany), ctx())).toEqual({ ok: false, why: 'tooMany' });
    const atLimit = Array.from({ length: PACK_MAX_ENTRIES }, (_, i) => ({ name: `S${i}`, travelMm: 3.5 }));
    expect(parsePack(packOf(atLimit), ctx()).ok).toBe(true);
  });
});
