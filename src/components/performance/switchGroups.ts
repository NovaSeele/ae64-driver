// Shared by SwitchCard, SwitchPicker and SwitchTab: keys grouped by resolved switch identity (DESIGN CSW §9.3, §9.4).
import type { CustomSwitch } from '../../data/customSwitch';
import type { SwitchEntry } from '../../protocol/switches';
import type { KeySwitch } from '../../stores/performance';

export interface KeyGroup {
  /** Stable identity key: lost, custom:{uid}, catalog:{id}, unnamed:{R}:{c}, unknown:{id}:{R}:{c}. */
  key: string;
  identity: KeySwitch;
  /** Travel range (µm) reported by the keys in this group. */
  rangeMax: number;
  ids: number[];
}

export interface SwatchProps {
  color: string;
  id?: number;
  custom?: boolean;
  lost?: boolean;
}

export function switchIdentityKey(ks: KeySwitch): string {
  switch (ks.kind) {
    case 'lost': return 'lost';
    case 'custom': return `custom:${ks.custom.uid}`;
    case 'catalog': return `catalog:${ks.entry.id}`;
    case 'unnamed': return `unnamed:${ks.triple.axisRangeMax}:${ks.triple.axisCoefficient}`;
    case 'unknown': return `unknown:${ks.triple.axisV2Id}:${ks.triple.axisRangeMax}:${ks.triple.axisCoefficient}`;
  }
}

export function switchRangeUm(ks: KeySwitch): number {
  return ks.kind === 'catalog' ? ks.entry.rangeMax : ks.triple.axisRangeMax;
}

/** Order tie-breaker for switch groups: catalog entries in list order, then custom, unnamed, unknown, lost. */
export function identityOrder(ks: KeySwitch, catalog: readonly SwitchEntry[] | null): number {
  if (ks.kind === 'catalog') {
    const i = catalog?.findIndex((e) => e.id === ks.entry.id) ?? -1;
    return i < 0 ? 1000 : i;
  }
  if (ks.kind === 'custom') return 1001;
  if (ks.kind === 'unnamed') return 1002;
  if (ks.kind === 'unknown') return 1003;
  return 1004;
}

/** Groups `ids` by resolved KeySwitch identity (§9.3), largest first; ties keep `order` (smaller first). */
export function groupKeys(
  ids: number[],
  keySwitch: (id: number) => KeySwitch | undefined,
  order: (ks: KeySwitch) => number = () => 0,
): KeyGroup[] {
  const map = new Map<string, KeyGroup>();
  for (const id of ids) {
    const ks = keySwitch(id);
    if (!ks) continue;
    const key = switchIdentityKey(ks);
    const g = map.get(key);
    if (g) g.ids.push(id);
    else map.set(key, { key, identity: ks, rangeMax: switchRangeUm(ks), ids: [id] });
  }
  return [...map.values()].sort(
    (a, b) => b.ids.length - a.ids.length || order(a.identity) - order(b.identity) || a.key.localeCompare(b.key),
  );
}

/** Resolves SwitchSwatch props for any KeySwitch identity (§9.4). */
export function swatchForKeySwitch(ks: KeySwitch | undefined, customSwitches: readonly CustomSwitch[]): SwatchProps {
  if (!ks) return { color: '' };
  switch (ks.kind) {
    case 'lost': return { color: '', lost: true };
    case 'custom': {
      const user = customSwitches.find((u) => u.uid === ks.custom.uid);
      return { color: user?.color ?? '', custom: true };
    }
    case 'catalog': return { color: ks.entry.color, id: ks.entry.id };
    case 'unnamed': return { color: '', custom: true };
    case 'unknown': return { color: '', id: ks.triple.axisV2Id };
  }
}
