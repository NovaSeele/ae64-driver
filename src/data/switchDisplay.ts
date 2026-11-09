// Display layer for the switch catalog: English names (the user's choice, shown in every locale). Only what is
// shown comes from here; the firmware triple stays in src/protocol/switches.ts and the write guard never reads this.
// Source: the reviewer's switch-display.json (name sources and confidence kept in the spec workspace).
import display from './switch-display.json';

const NAMES: Readonly<Record<string, { name: string; brand: string }>> = display;

/** The English name of a catalog switch (falls back to the catalog name if one is ever missing). */
export function switchName(entry: { id: number; name: string }): string {
  return NAMES[String(entry.id)]?.name ?? entry.name;
}
