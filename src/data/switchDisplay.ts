// Display layer for the switch catalog: English names (the user's choice, shown in every locale). Only what is
// shown comes from here; the firmware triple stays in src/protocol/switches.ts and the write guard never reads this.
// Source: the reviewer's switch-display.json (name sources and confidence kept in the spec workspace).
import display from './switch-display.json';

const NAMES: Readonly<Record<string, { name: string; brand: string }>> = display;

/** The English name of a catalog switch (falls back to the catalog name if one is ever missing). */
export function switchName(entry: { id: number; name: string }): string {
  return NAMES[String(entry.id)]?.name ?? entry.name;
}

// Maker photos (128 px webp, background removed), hashed into /assets by Vite. The CSP allows only same-origin images.
const IMAGES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(import.meta.glob<string>('../assets/switches/*.webp', { eager: true, query: '?url', import: 'default' }))
    .map(([path, url]) => [path.replace(/^.*\/(\d+)\.webp$/, '$1'), url]),
);

/** URL of the switch's photo, or undefined when the build has none (the drawn swatch is shown). */
export function switchImage(id: number): string | undefined {
  return IMAGES[String(id)];
}

/** The maker to show, or null when it is unknown. */
export function switchBrand(id: number): string | null {
  const b = NAMES[String(id)]?.brand;
  return b && b !== 'Unknown' ? b : null;
}

/** A maker gets its own picker tab from this many switches in the catalog; the rest share the Other tab. */
export const MAKER_TAB_MIN = 5;
export const OTHER_TAB = 'other';

const MAKER_ALIAS: Readonly<Record<string, string>> = { 'KTEK (TTC)': 'TTC' };
const makerKey = (id: number): string | null => {
  const b = switchBrand(id);
  return b ? (MAKER_ALIAS[b] ?? b) : null;
};

/** Picker tabs grouped by display maker. Entries are the catalog's own objects (never copied). label null = the Other tab. */
export function makerTabs<E extends { id: number }>(catalog: readonly E[]): { id: string; label: string | null; entries: E[] }[] {
  const byMaker = new Map<string, E[]>();
  for (const e of catalog) {
    const k = makerKey(e.id);
    if (k) byMaker.set(k, [...(byMaker.get(k) ?? []), e]);
  }
  const makers = [...byMaker].filter(([, es]) => es.length >= MAKER_TAB_MIN)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const tabbed = new Set(makers.map(([k]) => k));
  const other = catalog
    .map((e, i) => ({ e, i, k: makerKey(e.id) }))
    .filter((x) => !x.k || !tabbed.has(x.k))
    .sort((a, b) => (a.k === null ? 1 : 0) - (b.k === null ? 1 : 0)
      || (a.k && b.k ? a.k.toLowerCase().localeCompare(b.k.toLowerCase()) : 0) || a.i - b.i)
    .map((x) => x.e);
  const tabs = makers.map(([k, entries]) => ({ id: k, label: k as string | null, entries }));
  if (other.length) tabs.push({ id: OTHER_TAB, label: null, entries: other });
  return tabs;
}

/** The id of the tab that holds this switch, or '' when the catalog does not list it. */
export function makerTabOf(tabs: readonly { id: string; entries: readonly { id: number }[] }[], id: number): string {
  return tabs.find((t) => t.entries.some((e) => e.id === id))?.id ?? '';
}

const DISPLAY: Record<string, string> = { JIANGWAN: 'Everglide', GATERON: 'Gateron' };

/** Display name of a catalog group (internal key unchanged): the driver files Everglide under 江湾, romanised JIANGWAN. */
export function groupName(group: string): string {
  return DISPLAY[group] ?? group;
}
