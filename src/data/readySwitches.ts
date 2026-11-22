// Shipped ready-made custom switches and incompatible (S-pole down) switches (DESIGN CSW §5.6, §4.4).
// Data comes from static src/data/ready-switches.json (never fetched at runtime, never edited by hand).
import raw from './ready-switches.json';

export type ReadyNote = 'multiMagnet' | 'polarityUnknown' | 'travelConflict' | 'rangeClamped' | 'lowConfidence' | 'samePart';

export interface ReadySwitch {
  uid: `r-${string}`;
  maker: string;
  name: string;
  aka?: string;
  travelUm: number;
  rangeUm: number;
  coefficient: number;
  curveFrom: { id: number; name: string; brand: string };
  confidence: 'high' | 'medium' | 'low';
  notes: ReadyNote[];
  travelAlt?: number[];
  source: string;
}

export interface IncompatibleSwitch {
  uid: `x-${string}`;
  maker: string;
  name: string;
  reason: 'sDown';
  source: string;
}

export interface ReadyBounds {
  rMin: number;
  rMax: number;
  cMin: number;
  cMax: number;
}

export interface ReadySwitchesFile {
  schema: 1;
  from: string;
  bounds: ReadyBounds;
  switches: ReadySwitch[];
  incompatible: IncompatibleSwitch[];
}

export const READY_NOTES: readonly ReadyNote[] = Object.freeze([
  'multiMagnet', 'polarityUnknown', 'travelConflict', 'rangeClamped', 'lowConfidence', 'samePart',
]);

const WUQUE = 'Wuque Studio';

/** Display order (§4.4): Wuque Studio first, then maker A–Z, then name. */
function byDisplayOrder(a: { maker: string; name: string }, b: { maker: string; name: string }): number {
  const aw = a.maker === WUQUE ? 0 : 1;
  const bw = b.maker === WUQUE ? 0 : 1;
  return aw - bw
    || a.maker.localeCompare(b.maker, 'en', { sensitivity: 'base' })
    || a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
}

const data = raw as unknown as ReadySwitchesFile;

export const READY_SCHEMA: number = data.schema;
export const READY_FROM: string = data.from;
export const READY_BOUNDS: Readonly<ReadyBounds> = Object.freeze({ ...data.bounds });

export const READY_SWITCHES: readonly ReadySwitch[] = Object.freeze(
  [...data.switches].sort(byDisplayOrder).map((s) => Object.freeze({
    ...s,
    curveFrom: Object.freeze({ ...s.curveFrom }),
    notes: Object.freeze([...s.notes]) as ReadyNote[],
    ...(s.travelAlt ? { travelAlt: Object.freeze([...s.travelAlt]) as number[] } : {}),
  })),
);

export const INCOMPATIBLE_SWITCHES: readonly IncompatibleSwitch[] = Object.freeze(
  [...data.incompatible].sort(byDisplayOrder).map((s) => Object.freeze({ ...s })),
);

export function findReadySwitch(uid: string): ReadySwitch | undefined {
  return READY_SWITCHES.find((s) => s.uid === uid);
}
