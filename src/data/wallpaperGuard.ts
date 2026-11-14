// The wallpaper guard (DESIGN J §3.6): the smallest --bg-0 veil and panel opacity that keep every text colour at its target
// on every colour the image layer can show. A port of wallFloors in design/J-appearance/src/jcalc.js.
import { contrast, hexToRgb, lum, MIN_CONTRAST, mix, type Rgb } from '../color';
import type { ColourBox } from './wallpaperStore';

/** The theme's surfaces and text colours. page: text straight on the image (the page heading set); all: every text token. */
export interface GuardTokens { bg0: Rgb; bg2: Rgb; page: Rgb[]; all: Rgb[] }
export interface Floors { overlay: number; panel: number; overlayOk: boolean }

/** Text drawn straight on .main: the page heading and lines like the travel bar (§3.5). */
export const PAGE_TEXT = ['--fg-1', '--fg-2', '--fg-3', '--acc'] as const;
const HUES = ['yellow', 'orange', 'red', 'pink', 'purple', 'indigo', 'blue', 'cyan', 'green'].map((h) => `--hue-${h}`);
/** Every token that is ever a text colour: on panels (cards, page panels, .sb) and on the top bar glass. */
export const ALL_TEXT = ['--fg-1', '--fg-2', '--fg-3', '--fg-4', '--acc', '--ok', '--warn', '--danger', '--info', '--m-press', '--m-release', ...HUES] as const;
/** The top bar: --glass = bg-0 at 82 %. */
export const GLASS = 0.82;

/**
 * Contrast is V-shaped in background luminance: over the luminances y0..y1 the worst value is 1 when the text's own
 * luminance is inside, else the contrast at the nearer end.
 */
export function worstIn(c: Rgb, y0: number, y1: number): number {
  const y = lum(c);
  if (y >= y0 && y <= y1) return 1;
  const e = y < y0 ? y0 : y1;
  return (Math.max(y, e) + 0.05) / (Math.min(y, e) + 0.05);
}

/**
 * Every surface is a per-channel gamma mix of the pixel with fixed colours (a positive share of the pixel), and luminance
 * rises with each channel, so over the box a surface takes exactly the luminances between surf(lo) and surf(hi). Target
 * per colour: 4.5:1, or what it already has on the plain surface when the theme itself is below that (never worse than
 * today), so o = 1 and a = 1 always pass.
 */
export function wallFloors(box: ColourBox, t: GuardTokens): Floors {
  const okOn = (list: Rgb[], surf: (p: Rgb) => Rgb, plain: Rgb): boolean => {
    const y0 = lum(surf(box.lo));
    const y1 = lum(surf(box.hi));
    return list.every((c) => worstIn(c, y0, y1) >= Math.min(MIN_CONTRAST, contrast(c, plain)) - 1e-9);
  };
  const pageOk = (o: number): boolean =>
    okOn(t.page, (p) => mix(p, t.bg0, o), t.bg0) && okOn(t.all, (p) => mix(mix(p, t.bg0, o), t.bg0, GLASS), t.bg0);
  let o = 0;
  while (o < 1 && !pageOk(o)) o = Math.round((o + 0.01) * 100) / 100;
  let a = 0.75;
  while (a < 1 && !okOn(t.all, (p) => mix(mix(p, t.bg0, o), t.bg2, a), t.bg2)) a = Math.round((a + 0.01) * 100) / 100;
  return { overlay: o, panel: a, overlayOk: pageOk(o) };
}

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * Reads the text tokens with getPropertyValue (theme tokens and a custom accent are plain hex). A token that is not hex (a
 * future theme with color-mix) is resolved by a probe element with its transition off: under reduced motion base.css gives
 * every element a 0.01 ms transition, and a probe read right after a change would give the old colour (DESIGN J §3.6).
 */
export function readGuardTokens(el: Element = document.documentElement, overrides: Partial<Record<string, string>> = {}): GuardTokens {
  const cs = getComputedStyle(el);
  let probe: HTMLElement | null = null;
  const read = (k: string): Rgb => {
    const v = (overrides[k] ?? cs.getPropertyValue(k)).trim();
    if (HEX.test(v)) return hexToRgb(v);
    if (!probe) {
      probe = document.createElement('span');
      probe.style.setProperty('transition', 'none', 'important');
      probe.style.setProperty('position', 'absolute');
      probe.style.setProperty('visibility', 'hidden');
      el.appendChild(probe);
    }
    probe.style.color = '';
    probe.style.color = v || `var(${k})`;
    const m = getComputedStyle(probe).color.match(/[\d.]+/g)?.map(Number) ?? [0, 0, 0];
    return [m[0], m[1], m[2]];
  };
  try {
    return { bg0: read('--bg-0'), bg2: read('--bg-2'), page: PAGE_TEXT.map(read), all: ALL_TEXT.map(read) };
  } finally {
    (probe as HTMLElement | null)?.remove();
  }
}
