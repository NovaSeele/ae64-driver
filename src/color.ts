// Colour maths shared by the accent colour (src/accent.ts) and the wallpaper guard (src/data/wallpaperGuard.ts), DESIGN J
// §3.2 / §3.6. A port of the reference design/J-appearance/src/jcalc.js: colours are [r, g, b] in 0..255 (gamma-encoded sRGB).
// Pure: no DOM, usable in Node tests.

export type Rgb = readonly [number, number, number];

export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));

/** "#rrggbb" (any case, optional #) to [r, g, b]; anything else is black. */
export function hexToRgb(h: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(h).trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const rgbToHex = (c: Rgb): string =>
  '#' + c.map((x) => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0')).join('');

/** sRGB transfer: 0..255 to linear 0..1, and linear 0..1 to 0..255 (not rounded). */
export const lin = (c: number): number => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const enc = (c: number): number => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** WCAG relative luminance and contrast ratio. */
export const lum = (c: Rgb): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
export function contrast(a: Rgb, b: Rgb): number {
  const x = lum(a);
  const y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Gamma-space mix, what alpha compositing and color-mix(in srgb) do. `t` is the share of `b`. */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] * (1 - t) + b[0] * t, a[1] * (1 - t) + b[1] * t, a[2] * (1 - t) + b[2] * t];

/** The contrast target: 4.5:1 for every text colour. */
export const MIN_CONTRAST = 4.5;
