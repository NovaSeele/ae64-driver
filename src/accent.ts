// Accent colour maths (DESIGN J §3.2): a TS port of the reference design/J-appearance/src/jcalc.js (accentFor, nearest).
// Loaded on demand (import()): the start-up path only copies the cache (src/accentCache.ts, public/theme-boot.js).
import { clamp, contrast, hexToRgb, lin, enc, MIN_CONTRAST, mix, rgbToHex, type Rgb } from './color';
import {
  ACCENT_KEY,
  ACCENT_VARS_KEY,
  accentState,
  applyAccent,
  type AccentCache,
  type AccentVars,
} from './accentCache';
import type { ThemeId } from './theme';

export { applyAccent };
export type { AccentVars };

/** The five swatches (DESIGN J §3.1, §14): blue to pink only, the hues that mean nothing else in the app. */
export const SWATCHES = [
  { id: 'blue', hex: '#4da3ff' },
  { id: 'indigo', hex: '#7c83ff' },
  { id: 'violet', hex: '#b57bff' },
  { id: 'magenta', hex: '#e46cf0' },
  { id: 'pink', hex: '#f472b6' },
] as const;
export type SwatchId = (typeof SWATCHES)[number]['id'];

/**
 * Each theme's own tokens that the accent maths and the "close to a colour that means something" line need, copied from
 * src/styles/themes.css (tests/accent.test.ts compares this table with the CSS, so a new theme without a row turns it red).
 * softPct = --soft-pct / 100; cap* = the keycap faces (Keycap.vue); acc = the theme's own accent; the rest are the colours
 * that mean something else (RT press / release, ok, warn, danger).
 */
export interface ThemeRow {
  scheme: 'dark' | 'light';
  softPct: number;
  bg0: string; bg1: string; bg2: string; sel: string;
  capTop: string; capBottom: string; capHoverTop: string; capHoverBottom: string;
  acc: string;
  mPress: string; mRelease: string; ok: string; warn: string; danger: string;
}
export const THEME_ROWS: Record<ThemeId, ThemeRow> = {
  graphite: { scheme: 'dark', softPct: 0.14, bg0: '#18191b', bg1: '#111213', bg2: '#212325', sel: '#8b80ff', capTop: '#36383b', capBottom: '#2b2d31', capHoverTop: '#404246', capHoverBottom: '#36383b', acc: '#c4bbff', mPress: '#6ed4b3', mRelease: '#ecd478', ok: '#78d693', warn: '#eda86d', danger: '#ea8a88' },
  light: { scheme: 'light', softPct: 0.1, bg0: '#eef0f4', bg1: '#f8f9fb', bg2: '#ffffff', sel: '#8b80ff', capTop: '#ffffff', capBottom: '#eef1f5', capHoverTop: '#ffffff', capHoverBottom: '#e4e8ef', acc: '#6353da', mPress: '#29776f', mRelease: '#886523', ok: '#286e3c', warn: '#934f22', danger: '#b7352f' },
  indigo: { scheme: 'dark', softPct: 0.14, bg0: '#161729', bg1: '#101120', bg2: '#1e2036', sel: '#8b80ff', capTop: '#33364e', capBottom: '#282b45', capHoverTop: '#3e4058', capHoverBottom: '#33364e', acc: '#c4bbff', mPress: '#2cdcaf', mRelease: '#f5d240', ok: '#6fe0a8', warn: '#ffbe6b', danger: '#ff8fa0' },
  'indigo-light': { scheme: 'light', softPct: 0.1, bg0: '#eff0f8', bg1: '#f8f8fd', bg2: '#ffffff', sel: '#8b80ff', capTop: '#ffffff', capBottom: '#eef1f5', capHoverTop: '#ffffff', capHoverBottom: '#e4e8ef', acc: '#6353da', mPress: '#087970', mRelease: '#8e6503', ok: '#0f6e3d', warn: '#9a4a07', danger: '#c2264a' },
  gold: { scheme: 'dark', softPct: 0.14, bg0: '#18191b', bg1: '#111213', bg2: '#212325', sel: '#ad903f', capTop: '#36383b', capBottom: '#2b2d31', capHoverTop: '#404246', capHoverBottom: '#36383b', acc: '#ffd45c', mPress: '#05ebf5', mRelease: '#ff9678', ok: '#4ade80', warn: '#ff9f43', danger: '#ff7a7a' },
  ember: { scheme: 'dark', softPct: 0.14, bg0: '#111111', bg1: '#0b0b0b', bg2: '#1a1a1a', sel: '#ff6a3d', capTop: '#2f2f2f', capBottom: '#242424', capHoverTop: '#3a3a3a', capHoverBottom: '#2f2f2f', acc: '#ff6a3d', mPress: '#05ebf5', mRelease: '#f5d240', ok: '#4ade80', warn: '#ffc53d', danger: '#ff5c5c' },
  aurora: { scheme: 'dark', softPct: 0.14, bg0: '#0a0b10', bg1: '#07080c', bg2: '#14161e', sel: '#ff7a45', capTop: '#292c3a', capBottom: '#1e2130', capHoverTop: '#353745', capHoverBottom: '#292c3a', acc: '#ff7a45', mPress: '#05ebf5', mRelease: '#f5d240', ok: '#4ade80', warn: '#fbbf24', danger: '#ff5f6d' },
  mint: { scheme: 'dark', softPct: 0.14, bg0: '#2e2e2e', bg1: '#262626', bg2: '#373737', sel: '#61a182', capTop: '#4b4b4b', capBottom: '#414141', capHoverTop: '#545454', capHoverBottom: '#4b4b4b', acc: '#98fbcb', mPress: '#8cc3fc', mRelease: '#f5d240', ok: '#86efac', warn: '#fcd34d', danger: '#ffa3a3' },
  nord: { scheme: 'dark', softPct: 0.14, bg0: '#2e3440', bg1: '#272c36', bg2: '#323845', sel: '#78afbc', capTop: '#454b5b', capBottom: '#3b4252', capHoverTop: '#4f5563', capHoverBottom: '#454b5b', acc: '#8fd0e0', mPress: '#ccb1fe', mRelease: '#f5d240', ok: '#b4d39b', warn: '#ebcb8b', danger: '#f6b0b6' },
  dracula: { scheme: 'dark', softPct: 0.14, bg0: '#282a36', bg1: '#21222c', bg2: '#2f3141', sel: '#b595e1', capTop: '#444657', capBottom: '#3a3c4e', capHoverTop: '#4e5060', capHoverBottom: '#444657', acc: '#c9a6fa', mPress: '#2cdcaf', mRelease: '#f5d240', ok: '#50fa7b', warn: '#ffb86c', danger: '#ff9696' },
  rose: { scheme: 'dark', softPct: 0.14, bg0: '#1b191a', bg1: '#141213', bg2: '#242122', sel: '#be8e96', capTop: '#393637', capBottom: '#2f2b2c', capHoverTop: '#444041', capHoverBottom: '#393637', acc: '#f4b6c0', mPress: '#8cc3fc', mRelease: '#f5d240', ok: '#8bd5a6', warn: '#f5c27a', danger: '#ff7f8a' },
};

/** What accentFor needs of a theme (§3.2). */
export interface ThemeBase {
  scheme: 'dark' | 'light';
  bg0: Rgb; bg1: Rgb; bg2: Rgb; sel: Rgb;
  softPct: number;
  capTop: Rgb; capBottom: Rgb; capHoverTop: Rgb; capHoverBottom: Rgb;
}
/** The colours that mean something else, for nearest(). */
export interface Semantic { 'm-press': Rgb; 'm-release': Rgb; ok: Rgb; warn: Rgb; danger: Rgb }

export function themeBase(id: ThemeId): ThemeBase {
  const r = THEME_ROWS[id];
  const h = hexToRgb;
  return {
    scheme: r.scheme, bg0: h(r.bg0), bg1: h(r.bg1), bg2: h(r.bg2), sel: h(r.sel), softPct: r.softPct,
    capTop: h(r.capTop), capBottom: h(r.capBottom), capHoverTop: h(r.capHoverTop), capHoverBottom: h(r.capHoverBottom),
  };
}
export function themeSemantic(id: ThemeId): Semantic {
  const r = THEME_ROWS[id];
  return { 'm-press': hexToRgb(r.mPress), 'm-release': hexToRgb(r.mRelease), ok: hexToRgb(r.ok), warn: hexToRgb(r.warn), danger: hexToRgb(r.danger) };
}

// ---- OKLab / OKLCH (Björn Ottosson) ----

export interface Oklch { L: number; C: number; H: number }
export function toOklch(c: Rgb): Oklch {
  const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L, C: Math.hypot(A, B), H: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}
function oklchLinear(L: number, C: number, H: number): [number, number, number] {
  const A = C * Math.cos((H * Math.PI) / 180);
  const B = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (v: readonly number[]): boolean => v.every((x) => x >= -1e-4 && x <= 1 + 1e-4);
/** OKLCH to sRGB 0..255 (not rounded), lowering chroma (same L and hue) until it fits. */
export function fromOklch(L: number, C: number, H: number): Rgb {
  const l0 = clamp(L, 0, 1);
  let v = oklchLinear(l0, C, H);
  if (!inGamut(v)) {
    let lo = 0;
    let hi = C;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(oklchLinear(l0, mid, H))) lo = mid;
      else hi = mid;
    }
    v = oklchLinear(l0, lo, H);
  }
  return [clamp(enc(clamp(v[0], 0, 1)), 0, 255), clamp(enc(clamp(v[1], 0, 1)), 0, 255), clamp(enc(clamp(v[2], 0, 1)), 0, 255)];
}
const round = (c: Rgb): Rgb => [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];

// ---- The accent tokens (§3.2) ----

/** Text on the accent: a dark colour of the same hue (OKLCH L 0.2) or white, whichever has more contrast (dark on a tie). */
export function onAccFor(acc: Rgb, h: number, c: number): Rgb {
  const dark = round(fromOklch(0.2, Math.min(c, 0.05), h));
  const white: Rgb = [255, 255, 255];
  return contrast(dark, acc) >= contrast(white, acc) ? dark : white;
}
/** The 6 surfaces where --acc is text: bg-0, bg-1, bg-2, then --acc-soft (the accent itself at softPct) on each. */
export function accSurfaces(acc: Rgb, base: ThemeBase): Rgb[] {
  const p = base.softPct;
  return [base.bg0, base.bg1, base.bg2, mix(base.bg0, acc, p), mix(base.bg1, acc, p), mix(base.bg2, acc, p)];
}
/** The 4 keycap faces where --m-actuation is text, with the .cap__fill tint of the same colour (4 % top, 16 % foot). */
export function capSurfaces(m: Rgb, base: ThemeBase): Rgb[] {
  return [mix(base.capTop, m, 0.04), mix(base.capBottom, m, 0.16), mix(base.capHoverTop, m, 0.04), mix(base.capHoverBottom, m, 0.16)];
}
const worstOn = (c: Rgb, list: Rgb[]): number => Math.min(...list.map((s) => contrast(c, s)));
export const accWorst = (acc: Rgb, base: ThemeBase): number => worstOn(acc, accSurfaces(acc, base));
export const capWorst = (m: Rgb, base: ThemeBase): number => worstOn(m, capSurfaces(m, base));

/** Steps OKLCH L from `start` (hue h, chroma c of the picked colour) towards the passing side until ok(). */
function walk(start: Rgb, base: ThemeBase, h: number, c: number, ok: (x: Rgb) => boolean): [Rgb, boolean] {
  if (ok(start)) return [start, false];
  const end = base.scheme === 'dark' ? 1 : 0;
  const step = base.scheme === 'dark' ? 0.005 : -0.005;
  let l = toOklch(start).L;
  let out = start;
  // steps of 0.005 L: lands on the first passing L, the one closest to the start
  for (let i = 0; i < 220; i++) {
    l += step;
    if ((step > 0 && l > end) || (step < 0 && l < end)) l = end;
    out = round(fromOklch(l, c, h));
    if (ok(out) || l === end) break;
  }
  return [out, true];
}

export interface AccentResult { picked: string; adjusted: boolean; vars: AccentVars }

/** The five root tokens of a picked colour on one theme (§3.2). `adjusted`: --acc had to move in lightness. */
export function accentFor(hex: string, base: ThemeBase): AccentResult {
  const picked = hexToRgb(hex);
  const { C, H } = toOklch(picked);
  const [acc, adjusted] = walk(picked, base, H, C, (x) => accWorst(x, base) >= MIN_CONTRAST && contrast(onAccFor(x, H, C), x) >= MIN_CONTRAST);
  const [act] = walk(acc, base, H, C, (x) => capWorst(x, base) >= MIN_CONTRAST);
  const a = toOklch(acc);
  const hover = round(fromOklch(a.L + (base.scheme === 'dark' ? 0.06 : -0.06), a.C, a.H));
  const onAcc = onAccFor(acc, H, C);
  const s0 = toOklch(base.sel);
  const sel = C < 0.03 ? base.sel : round(fromOklch(s0.L, clamp(C, 0.06, 0.2), H));
  return {
    picked: rgbToHex(picked),
    adjusted,
    vars: { '--acc': rgbToHex(acc), '--acc-hover': rgbToHex(hover), '--on-acc': rgbToHex(onAcc), '--sel': rgbToHex(sel), '--m-actuation': rgbToHex(act) },
  };
}

/** The token sets of one picked colour for all 11 themes (what ae64.accentVars caches). */
export function accentVarsAllThemes(hex: string): Record<ThemeId, AccentVars> {
  const out = {} as Record<ThemeId, AccentVars>;
  for (const id of Object.keys(THEME_ROWS) as ThemeId[]) out[id] = accentFor(hex, themeBase(id)).vars;
  return out;
}

// ---- "Too close to a colour that means something else" (§3.1, review fix 6) ----

export function oklabDist(a: Rgb, b: Rgb): number {
  const x = toOklch(a);
  const y = toOklch(b);
  const r = Math.PI / 180;
  return Math.hypot(x.L - y.L, x.C * Math.cos(x.H * r) - y.C * Math.cos(y.H * r), x.C * Math.sin(x.H * r) - y.C * Math.sin(y.H * r));
}
export const NEAR = 0.08;
export type SemanticKey = keyof Semantic;
export interface Nearest { d: number; key: SemanticKey | ''; from: '--acc' | '--m-actuation' | '' }
const NEAR_PAIRS: readonly [Nearest['from'], readonly SemanticKey[]][] = [
  ['--acc', ['m-press', 'm-release', 'ok', 'warn', 'danger']],
  ['--m-actuation', ['m-press', 'm-release']],
];
/** The closest pair of (--acc vs RT press / release, ok, warn, danger) and (--m-actuation vs RT press / release). */
export function nearest(vars: AccentVars, sem: Semantic): Nearest {
  let best: Nearest = { d: Infinity, key: '', from: '' };
  for (const [from, keys] of NEAR_PAIRS) {
    for (const key of keys) {
      const d = oklabDist(hexToRgb(vars[from as '--acc']), sem[key]);
      if (d < best.d) best = { d, key, from };
    }
  }
  return best;
}

// ---- Saving (§3.3) ----

/**
 * Picks an accent (or null: the theme's own). Writes ae64.accent and its cache, and updates the state theme.ts applies from
 * (same frame, no reload, no command to the keyboard). Returns false when the browser refused to store it (it still applies
 * for this session).
 */
export function setAccent(hex: string | null): boolean {
  const h = hex === null ? null : rgbToHex(hexToRgb(hex));
  const cache: AccentCache | null = h ? { v: 1, hex: h, themes: accentVarsAllThemes(h) } : null;
  accentState.value = { hex: h, cache };
  try {
    if (h && cache) {
      localStorage.setItem(ACCENT_KEY, h);
      localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify(cache));
    } else {
      localStorage.removeItem(ACCENT_KEY);
      localStorage.removeItem(ACCENT_VARS_KEY);
    }
    return true;
  } catch {
    return false;
  }
}

/** Applies a colour while it is being dragged in the picker, without storing it (the next setAccent or a restore ends it). */
export function previewAccent(hex: string): void {
  const h = rgbToHex(hexToRgb(hex));
  accentState.value = { hex: h, cache: { v: 1, hex: h, themes: accentVarsAllThemes(h) } };
}

/** Start-up repair: ae64.accent is set but its cache is missing or stale. Rebuilds and stores it. */
export function rebuildAccentCache(hex: string): void {
  if (accentState.value.hex !== hex) return;
  setAccent(hex);
}
