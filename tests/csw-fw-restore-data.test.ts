// OFU v1.10 addendum §2, §8: pure tests for axisBackup.ts (record cap, expiry, board check, compare order),
// Test 10 (settings export / import / reset), and Test 13 (property-style check that restore / cant / blocked agree
// with checkPerformanceWrite and the triple rule). Kills A2, A3, A5, A6, A10, A11.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AXIS_BACKUP_KEY, AXIS_BACKUP_MAX, AXIS_BACKUP_TTL_MS,
  compare, isBackupExpired, loadBackup, parseAxisBackupMap, removeBackup, saveBackup,
} from '../src/data/axisBackup';
import type { AxisBackup, AxisBackupMap, RestoreCheck, Triple } from '../src/data/axisBackup';
import { buildExport, parseImport, resetKeys } from '../src/data/appSettings';
import { FW_BOARD_MAX, FW_BOARD_PRO } from '../src/protocol/firmware';
import { checkPerformanceWrite } from '../src/protocol/safety';
import { FW_AXIS, isCatalogTriple, isCustomTriple, switchCatalogFor } from '../src/protocol/switches';
import type { Performance } from '../src/protocol/types';

const SERIAL_A = '360812504339463536051657';
const SERIAL_B = '11223344556677889900aabb';
const SERIAL_C = '22334455667788990011bbcc';
const SERIAL_D = '33445566778899001122ccdd';
const SERIAL_E = '44556677889900112233ddee';

function perf(o: Partial<Performance> = {}): Performance {
  return {
    mode: 1,
    normalPress: 2.0,
    normalRelease: 2.0,
    rtFirstTouch: 1.0,
    rtPress: 0.3,
    rtRelease: 0.3,
    pressDeadStroke: 0.1,
    releaseDeadStroke: 0.1,
    axis: 0,
    calibrate: 0,
    axisV2Id: 0,
    axisRangeMax: 0,
    axisCoefficient: 0,
    ...o,
  };
}

function backup(o: Partial<AxisBackup> = {}): AxisBackup {
  return {
    v: 1,
    serialHex: SERIAL_A,
    board: FW_BOARD_MAX,
    fwBefore: '0.0.4.0',
    takenAt: 1_700_000_000_000,
    keys: { 0: [12432, 3310, 20500] },
    ...o,
  };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { localStorage.clear(); });

describe('axisBackup storage helpers: cap, expiry, board/serial matching, validation', () => {
  it('saveBackup replaces the same serial only and caps at 4 keyboards (oldest takenAt goes)', () => {
    let all: AxisBackupMap = {};
    all = saveBackup(all, backup({ serialHex: SERIAL_A, takenAt: 1000 }));
    all = saveBackup(all, backup({ serialHex: SERIAL_B, takenAt: 2000 }));
    all = saveBackup(all, backup({ serialHex: SERIAL_C, takenAt: 3000 }));
    all = saveBackup(all, backup({ serialHex: SERIAL_D, takenAt: 4000 }));
    expect(Object.keys(all)).toHaveLength(AXIS_BACKUP_MAX);

    // Replacing SERIAL_A updates only SERIAL_A and keeps all 4
    all = saveBackup(all, backup({ serialHex: SERIAL_A, takenAt: 5000, fwBefore: '0.0.5.0' }));
    expect(Object.keys(all).sort()).toEqual([SERIAL_A, SERIAL_B, SERIAL_C, SERIAL_D].sort());
    expect(all[SERIAL_A].fwBefore).toBe('0.0.5.0');

    // Adding a 5th drops SERIAL_B (now the oldest takenAt = 2000)
    all = saveBackup(all, backup({ serialHex: SERIAL_E, takenAt: 6000 }));
    expect(Object.keys(all).sort()).toEqual([SERIAL_A, SERIAL_C, SERIAL_D, SERIAL_E].sort());
    expect(all[SERIAL_B]).toBeUndefined();
  });

  it('loadBackup requires matching serial and board (kills A5) and enforces 30-day expiry', () => {
    const t0 = 1_700_000_000_000;
    const all = saveBackup({}, backup({ serialHex: SERIAL_A, board: FW_BOARD_MAX, takenAt: t0 }));
    expect(loadBackup(all, SERIAL_A, FW_BOARD_MAX, t0 + AXIS_BACKUP_TTL_MS - 1)).not.toBeNull();
    // Different serial
    expect(loadBackup(all, SERIAL_B, FW_BOARD_MAX, t0 + 1000)).toBeNull();
    // Same serial, different board (Pro vs Max)
    expect(loadBackup(all, SERIAL_A, FW_BOARD_PRO, t0 + 1000)).toBeNull();
    // Expired at 30 days
    expect(isBackupExpired(all[SERIAL_A], t0 + AXIS_BACKUP_TTL_MS)).toBe(true);
    expect(loadBackup(all, SERIAL_A, FW_BOARD_MAX, t0 + AXIS_BACKUP_TTL_MS)).toBeNull();
    // Remove
    expect(removeBackup(all, SERIAL_A)).toEqual({});
  });

  it('parseAxisBackupMap ignores malformed entries while preserving crafted triples for compare', () => {
    const valid = backup({
      keys: {
        0: [12432, 3310, 20500],
        1: [9999, 6000, 1000], // out-of-bounds triple stays intact so compare classifies it as cant
        2: [0, 0, 0],          // lost triple stays intact so compare classifies it as lostBefore
      },
    });
    const raw = JSON.stringify({
      [SERIAL_A]: valid,
      '000000000000000000000000': { ...valid, serialHex: '000000000000000000000000' }, // unreadable serial
      [SERIAL_B]: { v: 2, serialHex: SERIAL_B, board: FW_BOARD_MAX, fwBefore: '0', takenAt: 1, keys: {} }, // bad version
      [SERIAL_C]: { v: 1, serialHex: SERIAL_C, board: 0x12345678, fwBefore: '0', takenAt: 1, keys: {} }, // unknown board
    });
    const parsed = parseAxisBackupMap(raw);
    expect(Object.keys(parsed)).toEqual([SERIAL_A]);
    expect(parsed[SERIAL_A]).toEqual(valid);
    expect(parseAxisBackupMap('not json')).toEqual({});
  });
});

describe('Test 10 (storage half): ae64.fw.axisBackup never enters settings export (kills A6)', () => {
  it('excluded from buildExport, refused by parseImport, kept by resetKeys', () => {
    const stored = JSON.stringify({ [SERIAL_A]: backup() });
    localStorage.setItem(AXIS_BACKUP_KEY, stored);
    localStorage.setItem('ae64.locale', 'vi');
    const exp = buildExport();
    expect(exp.json).not.toContain(AXIS_BACKUP_KEY);
    expect(JSON.parse(exp.json).data).toEqual({ 'ae64.locale': 'vi' });
    expect(parseImport(JSON.stringify({ app: 'ae64-control', data: { [AXIS_BACKUP_KEY]: stored } }), 500)).toEqual({
      ok: false, error: 'errKeys', keys: AXIS_BACKUP_KEY,
    });
    expect(resetKeys()).not.toContain(AXIS_BACKUP_KEY);
  });
});

describe('Test 13: compare lists agree with checkPerformanceWrite and the triple rule (kills A2, A3, A10, A11)', () => {
  it('crafted backup across listed, custom, out-of-bounds, lost, unknown-mode, deep values and changedSince', () => {
    const boardIdHex = '0030000d';
    const catalog = switchCatalogFor(boardIdHex)!;
    const seenMap = new Map<number, Performance[]>();

    // Craft 16 keys covering every category and edge case
    const cases: { id: number; saved: Triple; cur: Performance; after?: Triple; expectBucket: 'same' | 'lostBefore' | 'changedSince' | 'cant' | 'blocked' | 'restore'; expectFitted?: boolean }[] = [
      // 0: listed switch identical → same
      { id: 0, saved: [12432, 3310, 20500], cur: perf({ axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 }), expectBucket: 'same' },
      // 1: listed switch after wipe (0/0/0) → restore
      { id: 1, saved: [12432, 3310, 20500], cur: perf(), after: [0, 0, 0], expectBucket: 'restore', expectFitted: false },
      // 2: custom triple (valid list id 12432, WS Flux R=3500, c=17536) after wipe → restore
      { id: 2, saved: [12432, 3500, 17536], cur: perf(), after: [0, 0, 0], expectBucket: 'restore', expectFitted: false },
      // 3: Max catalog Star Eye (id 2128 < 0x1000, exact catalog triple 3600/20224) → restore via isCatalogTriple
      { id: 3, saved: [2128, 3600, 20224], cur: perf(), after: [0, 0, 0], expectBucket: 'restore', expectFitted: false },
      // 4: Star Eye id 2128 with modified R (not exact catalog triple, id < 0x1000 fails isCustomTriple) → cant
      { id: 4, saved: [2128, 3500, 20224], cur: perf(), after: [0, 0, 0], expectBucket: 'cant' },
      // 5: unlisted id 0x2222 not equal to key's current id 0 → cant
      { id: 5, saved: [0x2222, 3400, 20000], cur: perf(), after: [0, 0, 0], expectBucket: 'cant' },
      // 6: R above catalog max (4016 > 4015) → cant
      { id: 6, saved: [12432, 4016, 20000], cur: perf(), after: [0, 0, 0], expectBucket: 'cant' },
      // 7: R below catalog min (3129 < 3130, >= 1000) → cant
      { id: 7, saved: [12432, 3129, 20000], cur: perf(), after: [0, 0, 0], expectBucket: 'cant' },
      // 8: c below catalog min (13299 < 13300) → cant
      { id: 8, saved: [12432, 3400, 13299], cur: perf(), after: [0, 0, 0], expectBucket: 'cant' },
      // 9: c above catalog max (26801 > 26800) → cant
      { id: 9, saved: [12432, 3400, 26801], cur: perf(), after: [0, 0, 0], expectBucket: 'cant' },
      // 10: saved lost triple (R = 0 < 1000) → lostBefore (never sent, kills A3)
      { id: 10, saved: [0, 0, 0], cur: perf({ axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 }), after: [12432, 3310, 20500], expectBucket: 'lostBefore' },
      // 11: saved lost triple (R = 999 < 1000) → lostBefore (never sent, kills A3)
      { id: 11, saved: [12432, 999, 20500], cur: perf(), after: [0, 0, 0], expectBucket: 'lostBefore' },
      // 12: unknown mode 7 with valid listed triple → blocked (NOT cant, kills A11)
      { id: 12, saved: [4128, 3390, 20000], cur: perf({ mode: 7 as unknown as Performance['mode'] }), after: [0, 0, 0], expectBucket: 'blocked' },
      // 13: deep normalPress (3.6) and deep pressDeadStroke (3.5) with saved R=3390 → restore + fitted (kills A10)
      { id: 13, saved: [4128, 3390, 20000], cur: perf({ normalPress: 3.6, normalRelease: 3.6, pressDeadStroke: 3.5 }), after: [0, 0, 0], expectBucket: 'restore', expectFitted: true },
      // 14: 4015 switch with actuation 4.01 (> MAX_TRAVEL_MM = 4.0) → fitted to 4.0 and passes guard
      { id: 14, saved: [4416, 4015, 13300], cur: perf({ normalPress: 4.01, normalRelease: 4.01 }), after: [0, 0, 0], expectBucket: 'restore', expectFitted: true },
      // 15: user changed key after the update (cur differs from after) → changedSince
      { id: 15, saved: [12432, 3310, 20500], cur: perf({ axisV2Id: 4128, axisRangeMax: 3390, axisCoefficient: 20000 }), after: [0, 0, 0], expectBucket: 'changedSince' },
      // 16: mode 1 with rtFirstTouch=0 and deep rtPress=3.6 (fitTravel lowers rtPress → rtChanged → RT > 0 guard rule fails) → blocked (NOT cant)
      { id: 16, saved: [4128, 3390, 20000], cur: perf({ mode: 1, rtFirstTouch: 0, rtPress: 3.6 }), after: [0, 0, 0], expectBucket: 'blocked' },
      // 17: key with current valid id 0x5555 (not in list, >= 0x1000) and saved custom triple keeping that same id 0x5555 → restore via isCustomTriple
      { id: 17, saved: [0x5555, 3500, 17536], cur: perf({ axisV2Id: 0x5555, axisRangeMax: 3400, axisCoefficient: 20000 }), after: [0x5555, 3400, 20000], expectBucket: 'restore', expectFitted: false },
    ];

    const keys: Record<number, Triple> = {};
    const after: Record<number, Triple> = {};
    const now: Record<number, Performance> = {};
    for (const c of cases) {
      keys[c.id] = c.saved;
      if (c.after) after[c.id] = c.after;
      now[c.id] = c.cur;
      seenMap.set(c.id, [c.cur]);
    }

    const b = backup({ keys, after });
    const check: RestoreCheck = {
      tripleOk: (keyId, t) => {
        const cur = now[keyId];
        if (!cur || t[1] < FW_AXIS.rangeMin || t[2] < FW_AXIS.coefMin) return false;
        const triple = { axisV2Id: t[0], axisRangeMax: t[1], axisCoefficient: t[2] };
        return isCatalogTriple(catalog, triple) || isCustomTriple(catalog, triple, cur.axisV2Id);
      },
      write: (keyId, next) => checkPerformanceWrite(next, seenMap.get(keyId) ?? [], { intervalRt: true, boardIdHex }),
    };

    const cmp = compare(b, now, check);

    // Exact bucket expectations
    for (const c of cases) {
      const inBucket = (name: typeof c.expectBucket) => cmp[name].includes(c.id);
      expect(inBucket(c.expectBucket), `key ${c.id} expected in ${c.expectBucket}`).toBe(true);
      for (const other of ['same', 'lostBefore', 'changedSince', 'cant', 'blocked', 'restore'] as const) {
        if (other !== c.expectBucket) expect(cmp[other], `key ${c.id} not in ${other}`).not.toContain(c.id);
      }
      if (c.expectFitted !== undefined) {
        expect(cmp.fitted.includes(c.id), `key ${c.id} fitted=${c.expectFitted}`).toBe(c.expectFitted);
      }
    }

    // Property-style invariant of Test 13:
    // For every offered key (restore ∪ cant ∪ blocked):
    //   restore ⇔ checkPerformanceWrite(next, seen) is null (and tripleOk true)
    //   cant    ⇔ tripleOk refuses
    //   blocked ⇔ tripleOk accepts and ONLY another rule of checkPerformanceWrite refuses
    for (const c of cases) {
      if (cmp.same.includes(c.id) || cmp.lostBefore.includes(c.id) || cmp.changedSince.includes(c.id)) {
        expect(cmp.next[c.id]).toBeUndefined();
        continue;
      }
      const tOk = check.tripleOk(c.id, c.saved);
      if (cmp.restore.includes(c.id)) {
        const nxt = cmp.next[c.id];
        expect(nxt).toBeDefined();
        expect(tOk).toBe(true);
        expect(checkPerformanceWrite(nxt, seenMap.get(c.id)!, { intervalRt: true, boardIdHex })).toBeNull();
        // Distances never raised
        for (const f of ['normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke'] as const) {
          expect(nxt[f]).toBeLessThanOrEqual(c.cur[f] + 1e-9);
        }
      } else if (cmp.cant.includes(c.id)) {
        expect(tOk).toBe(false);
        expect(cmp.next[c.id]).toBeUndefined();
      } else if (cmp.blocked.includes(c.id)) {
        expect(tOk).toBe(true);
        expect(cmp.next[c.id]).toBeUndefined();
        // Verify checkPerformanceWrite fails specifically for a non-triple reason
        const probeNext: Performance = { ...c.cur, axisV2Id: c.saved[0], axisRangeMax: c.saved[1], axisCoefficient: c.saved[2] };
        const why = checkPerformanceWrite(probeNext, seenMap.get(c.id)!, { intervalRt: true, boardIdHex });
        expect(why).not.toBeNull();
        expect(why).not.toContain('switch fields axisV2Id');
      }
    }

    // Verify specific fitted values for key 13 (R=3390: normalPress→3.39, pressDeadStroke→1.0) and key 14 (R=4015: normalPress→4.0)
    expect(cmp.next[13].normalPress).toBe(3.39);
    expect(cmp.next[13].pressDeadStroke).toBe(1.0);
    expect(cmp.next[14].normalPress).toBe(4.0);
    // Without fitTravel (mutant A10), key 13 is refused by the guard
    const unfitted13: Performance = { ...now[13], axisV2Id: 4128, axisRangeMax: 3390, axisCoefficient: 20000 };
    expect(checkPerformanceWrite(unfitted13, seenMap.get(13)!, { intervalRt: true, boardIdHex })).not.toBeNull();
  });
});
