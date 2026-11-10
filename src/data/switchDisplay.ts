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

const DISPLAY: Record<string, string> = { JIANGWAN: 'Everglide', GATERON: 'Gateron' };

/** Display name of a catalog group (internal key unchanged): the driver files Everglide under 江湾, romanised JIANGWAN. */
export function groupName(group: string): string {
  return DISPLAY[group] ?? group;
}
