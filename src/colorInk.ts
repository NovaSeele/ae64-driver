// Readable ink for text drawn on an arbitrary colour (e.g. a user-chosen LED swatch).
// Picks whichever of the two inks gives the higher WCAG contrast, so every colour gets at least ~4.29:1.

export const DARK_INK = '#111318';
export const LIGHT_INK = '#ffffff';

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB colour (0..255 channels). */
export function luminance(r: number, g: number, b: number): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two luminances. */
export function contrast(l1: number, l2: number): number {
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const DARK_L = luminance(0x11, 0x13, 0x18);

/** 'dark' when #111318 contrasts more with the colour than white does, else 'light'. */
export function inkFor(r: number, g: number, b: number): 'dark' | 'light' {
  const l = luminance(r, g, b);
  return contrast(l, DARK_L) > contrast(l, 1) ? 'dark' : 'light';
}
