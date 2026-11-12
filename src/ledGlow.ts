// LED colour → glow for the Lighting page (DESIGN A §3.2, §3.3): one helper for the keys and the edge strip.
// A colour read from the keyboard already carries its brightness (25 % red is #400000). Mixed straight into a keycap that
// darkens and greys the key; on the real board it is a faint red glow. So the colour is split into the same hue at full
// brightness (`led`, brightest channel 255) and its brightness (`level` = brightest channel / 255), and the keycap tints
// by `level`. Under 8/255 the LED counts as off and the key looks normal.

/** A lit LED: the colour at full brightness and its brightness 0..1. */
export type LedGlow = { led: string; level: number };

/** Brightest channel below this (0..255) is an LED that is off. */
export const LED_OFF_BELOW = 8;

const hex2 = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0');

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  // CSS Color 4 hsl → sRGB, channels 0..255 (unrounded)
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    return 255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4)];
}

/** `#rgb`, `#rrggbb`, `rgb(…)` or `hsl(…)` (space or comma syntax) → 0..255 channels; anything else (e.g. `var(--x)`) → null. */
export function parseLedColor(color: string): [number, number, number] | null {
  const c = color.trim().toLowerCase();
  let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(c);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map((x) => x + x).join('') : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
  }
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)\s*(?:[,/][^)]*)?\)$/.exec(c);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /^hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%\s*(?:[,/][^)]*)?\)$/.exec(c);
  if (m) {
    const h = ((Number(m[1]) % 360) + 360) % 360;
    return hslToRgb(h, Math.min(1, Number(m[2]) / 100), Math.min(1, Number(m[3]) / 100));
  }
  return null;
}

/** undefined = off (no colour, not a colour, or brightest channel under 8/255). Otherwise `led` is a `#rrggbb` hex. */
export function ledGlow(color: string | undefined): LedGlow | undefined {
  if (!color) return undefined;
  const rgb = parseLedColor(color);
  if (!rgb) return undefined;
  const m = Math.max(...rgb);
  if (!(m >= LED_OFF_BELOW)) return undefined;
  const k = 255 / m;
  return { led: `#${rgb.map((v) => hex2(v * k)).join('')}`, level: Math.round((m / 255) * 1000) / 1000 };
}

/** One edge-strip LED for the band: its position 0..1 along its side (as `stripRing()` gives it) and its glow. */
export type BandLed = { pos: number; glow: LedGlow | undefined };
export type RingSide = 'top' | 'right' | 'bottom' | 'left';

/** A band stop's colour: the LED at its brightness over transparent; an LED that is off is transparent. */
export function bandStopColor(glow: LedGlow | undefined): string {
  return glow ? `color-mix(in srgb, ${glow.led} ${Math.round(glow.level * 1000) / 10}%, transparent)` : 'transparent';
}

/**
 * The blurred band under one side of the ring: a gradient through that side's LED colours in place order. The band
 * spans the LED segment [--inset, 100% − --inset], so a stop sits at the LED's position on it. Bottom and left run
 * backwards like `.led--bottom` / `.led--left`. undefined when no LED on the side is lit (no band is drawn).
 */
export function bandGradient(side: RingSide, leds: readonly BandLed[]): string | undefined {
  if (!leds.some((l) => l.glow)) return undefined;
  const reverse = side === 'bottom' || side === 'left';
  const stops = leds
    .map((l) => ({ at: reverse ? 1 - l.pos : l.pos, color: bandStopColor(l.glow) }))
    .sort((a, b) => a.at - b.at)
    .map((s) => `${s.color} ${Math.round(s.at * 10000) / 100}%`);
  const dir = side === 'top' || side === 'bottom' ? '90deg' : '180deg';
  return `linear-gradient(${dir}, ${stops.join(', ')})`;
}
