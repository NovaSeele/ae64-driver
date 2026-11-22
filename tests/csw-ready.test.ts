// CSW step 2: ready-made custom switches file and loader rules (DESIGN §5.6, §4.4, §19 Test 4).
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  INCOMPATIBLE_SWITCHES, READY_BOUNDS, READY_FROM, READY_NOTES, READY_SCHEMA, READY_SWITCHES, findReadySwitch,
} from '../src/data/readySwitches';
import { coefBounds, rangeBounds, switchCatalogFor } from '../src/protocol/switches';

const MAX_CATALOG = switchCatalogFor('0030000d')!;
const PRO_CATALOG = switchCatalogFor('0030000a')!;

describe('ready-switches.json and readySwitches.ts — CSW Test 4', () => {
  it('bounds equal rangeBounds and coefBounds of both shipped board lists', () => {
    expect(READY_SCHEMA).toBe(1);
    expect(READY_FROM.length).toBeGreaterThan(0);
    for (const cat of [MAX_CATALOG, PRO_CATALOG]) {
      const rb = rangeBounds(cat)!;
      const cb = coefBounds(cat)!;
      expect(READY_BOUNDS).toEqual({ rMin: rb.min, rMax: rb.max, cMin: cb.min, cMax: cb.max });
    }
  });

  it('has 53 ready-made and 5 incompatible entries, in display order (Wuque Studio first, then maker A–Z, then name)', () => {
    expect(READY_SWITCHES).toHaveLength(53);
    expect(INCOMPATIBLE_SWITCHES).toHaveLength(5);

    const wuques = READY_SWITCHES.filter((s) => s.maker === 'Wuque Studio');
    expect(wuques).toHaveLength(9);
    expect(READY_SWITCHES.slice(0, wuques.length).every((s) => s.maker === 'Wuque Studio')).toBe(true);

    const checkOrder = (list: readonly { maker: string; name: string }[]) => {
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        const aw = a.maker === 'Wuque Studio' ? 0 : 1;
        const bw = b.maker === 'Wuque Studio' ? 0 : 1;
        const cmp = aw - bw
          || a.maker.localeCompare(b.maker, 'en', { sensitivity: 'base' })
          || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
        expect(cmp, `${a.maker} ${a.name} before ${b.maker} ${b.name}`).toBeLessThanOrEqual(0);
      }
    };
    checkOrder(READY_SWITCHES);
    checkOrder(INCOMPATIBLE_SWITCHES);
  });

  it('enforces every §5.6 invariant on every ready-made and incompatible entry', () => {
    const validNotes = new Set<string>(READY_NOTES);
    const catalogIds = new Set([...MAX_CATALOG, ...PRO_CATALOG].map((e) => e.id));
    const allUids = new Set<string>();
    const readyMakerNames = new Set<string>();

    for (const s of READY_SWITCHES) {
      expect(s.uid.startsWith('r-'), s.uid).toBe(true);
      expect(allUids.has(s.uid), `duplicate uid ${s.uid}`).toBe(false);
      allUids.add(s.uid);

      expect(s.maker.trim().length, s.uid).toBeGreaterThan(0);
      expect(s.name.trim().length, s.uid).toBeGreaterThan(0);
      const mk = `${s.maker.toLowerCase()}::${s.name.toLowerCase()}`;
      expect(readyMakerNames.has(mk), `duplicate maker+name ${mk}`).toBe(false);
      readyMakerNames.add(mk);

      expect(Number.isInteger(s.travelUm) && s.travelUm >= 1000 && s.travelUm <= 6000, `${s.uid} travelUm`).toBe(true);
      expect(Number.isInteger(s.rangeUm) && s.rangeUm >= READY_BOUNDS.rMin && s.rangeUm <= READY_BOUNDS.rMax, `${s.uid} rangeUm`).toBe(true);
      expect(Number.isInteger(s.coefficient) && s.coefficient >= READY_BOUNDS.cMin && s.coefficient <= READY_BOUNDS.cMax, `${s.uid} coef`).toBe(true);

      expect(['high', 'medium', 'low']).toContain(s.confidence);
      expect(catalogIds.has(s.curveFrom.id), `${s.uid} curveFrom ${s.curveFrom.id}`).toBe(true);
      expect(s.curveFrom.name.length > 0 && s.curveFrom.brand.length > 0, `${s.uid} curveFrom text`).toBe(true);

      expect(s.notes.length, `${s.uid} notes cap`).toBeLessThanOrEqual(2);
      expect(new Set(s.notes).size, `${s.uid} unique notes`).toBe(s.notes.length);
      for (const n of s.notes) expect(validNotes.has(n), `${s.uid} note ${n}`).toBe(true);

      const hasConflict = s.notes.includes('travelConflict');
      if (hasConflict) {
        expect(Array.isArray(s.travelAlt) && s.travelAlt.length > 0, `${s.uid} travelAlt required`).toBe(true);
        for (const alt of s.travelAlt!) expect(Number.isInteger(alt) && alt >= 1000 && alt <= 6000, `${s.uid} alt ${alt}`).toBe(true);
      } else {
        expect(s.travelAlt, `${s.uid} unexpected travelAlt`).toBeUndefined();
      }

      expect(new URL(s.source).protocol, `${s.uid} source`).toBe('https:');
    }

    const badMakerNames = new Set<string>();
    for (const s of INCOMPATIBLE_SWITCHES) {
      expect(s.uid.startsWith('x-'), s.uid).toBe(true);
      expect(allUids.has(s.uid), `duplicate uid ${s.uid}`).toBe(false);
      allUids.add(s.uid);

      expect(s.maker.trim().length > 0 && s.name.trim().length > 0, s.uid).toBe(true);
      const mk = `${s.maker.toLowerCase()}::${s.name.toLowerCase()}`;
      expect(badMakerNames.has(mk), `duplicate incompatible ${mk}`).toBe(false);
      badMakerNames.add(mk);

      expect(s.reason).toBe('sDown');
      expect(new URL(s.source).protocol, `${s.uid} source`).toBe('https:');
    }

    expect(findReadySwitch('r-wuque-ws-flux-clacky')?.name).toBe('WS Flux');
    expect(findReadySwitch('x-kailh-flame-he')).toBeUndefined();
    expect(findReadySwitch('r-does-not-exist')).toBeUndefined();
  });

  it.skipIf(!process.env.AE64_CSW_DIR)('repo ready-switches.json equals <AE64_CSW_DIR>/design/data/ready-switches.json byte for byte', () => {
    const repoCopy = readFileSync(resolve('src/data/ready-switches.json'), 'latin1');
    const designCopy = readFileSync(join(process.env.AE64_CSW_DIR!, 'design', 'data', 'ready-switches.json'), 'latin1');
    expect(repoCopy).toBe(designCopy);
  });
});
