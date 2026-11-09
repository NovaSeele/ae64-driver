// Shared by SwitchCard and SwitchPicker: the selected keys grouped by the switch they report.
import type { Performance } from '../../protocol';

export interface KeyGroup { axisV2Id: number; rangeMax: number; ids: number[] }

/** Groups `ids` by switch triple (axisV2Id + axisRangeMax), largest first; ties keep the order `order` gives (smaller first). */
export function groupKeys(ids: number[], values: Record<number, Performance>, order: (axisV2Id: number) => number): KeyGroup[] {
  const map = new Map<string, KeyGroup>();
  for (const id of ids) {
    const p = values[id];
    if (!p) continue;
    const k = `${p.axisV2Id}:${p.axisRangeMax}`;
    const g = map.get(k);
    if (g) g.ids.push(id);
    else map.set(k, { axisV2Id: p.axisV2Id, rangeMax: p.axisRangeMax, ids: [id] });
  }
  return [...map.values()].sort((a, b) => b.ids.length - a.ids.length || order(a.axisV2Id) - order(b.axisV2Id));
}
