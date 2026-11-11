// Static switch catalogs of the AE64 Max (board 0030000d) and the AE64 Pro (board 0030000a), snapshots of the vendor's axis lists.
// Never fetched at runtime. The switch triple comes from the `detail_*` columns, not the top-level range.
import maxData from '../data/switches-0030000D.json';
import proData from '../data/switches-0030000A.json';
import type { Performance } from './types';

export type SwitchTriple = Pick<Performance, 'axisV2Id' | 'axisRangeMax' | 'axisCoefficient'>;

export interface SwitchEntry {
  /** detail_axis_id (= Performance.axisV2Id). */
  id: number;
  /** axis_name, shown as-is. */
  name: string;
  group: 'JIANGWAN' | 'GATERON' | 'TTC' | 'Other' | 'WuqueStudio';
  /** detail_axis_range_max (µm). */
  rangeMax: number;
  /** detail_axis_coefficient. */
  coefficient: number;
  /** axis_color; '' when empty. */
  color: string;
}

type Group = SwitchEntry['group'];

interface CatalogData { row_fields: string[]; groups: (string | number)[][]; rows: unknown }

function buildCatalog(data: CatalogData): readonly SwitchEntry[] {
  const col = (name: string): number => {
    const i = data.row_fields.indexOf(name);
    if (i < 0) throw new Error(`switch catalog: column ${name} missing`);
    return i;
  };
  const C = {
    group: col('group_type_id'), name: col('axis_name'), color: col('axis_color'),
    id: col('detail_axis_id'), range: col('detail_axis_range_max'), coef: col('detail_axis_coefficient'),
  };
  // groups rows: [group_type_id, Chinese name, English name, …]
  const groupOf = new Map<number, Group>(data.groups.map((g) => [g[0] as number, g[2] as Group]));
  const out: SwitchEntry[] = [];
  const ids = new Set<number>();
  for (const row of data.rows as (string | number)[][]) {
    const id = row[C.id] as number;
    if (ids.has(id)) continue; // keep the first occurrence
    const group = groupOf.get(row[C.group] as number);
    if (!group) throw new Error(`switch catalog: unknown group ${String(row[C.group])}`);
    ids.add(id);
    out.push(Object.freeze({
      id, name: row[C.name] as string, group,
      rangeMax: row[C.range] as number, coefficient: row[C.coef] as number,
      color: (row[C.color] as string) || '',
    }));
  }
  return Object.freeze(out);
}

/** Group order of the Max catalog. */
export const SWITCH_GROUPS: readonly Group[] = maxData.groups.map((g) => g[2] as Group);

const MAX_CATALOG = buildCatalog(maxData);
const PRO_CATALOG = buildCatalog(proData);

/** The catalog for a board ('0030000d' Max, '0030000a' Pro, case-insensitive), or null for any other board. */
export function switchCatalogFor(boardIdHex: string | null | undefined): readonly SwitchEntry[] | null {
  switch (boardIdHex?.toLowerCase()) {
    case '0030000d': return MAX_CATALOG;
    case '0030000a': return PRO_CATALOG;
    default: return null;
  }
}

export function findSwitch(catalog: readonly SwitchEntry[] | null, axisV2Id: number): SwitchEntry | undefined {
  return catalog?.find((e) => e.id === axisV2Id);
}

/** True when the triple equals one catalog entry exactly (id, rangeMax and coefficient). */
export function isCatalogTriple(catalog: readonly SwitchEntry[] | null, t: SwitchTriple): boolean {
  const e = findSwitch(catalog, t.axisV2Id);
  return !!e && e.rangeMax === t.axisRangeMax && e.coefficient === t.axisCoefficient;
}
