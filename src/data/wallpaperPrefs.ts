// How the wallpaper shows (DESIGN J §3.8): localStorage `ae64.wallpaper`, part of the H settings file. The image itself is in
// IndexedDB (wallpaperStore.ts) and never in the file. Small on purpose: the app shell and the H key table import it.

export const WALLPAPER_KEY = 'ae64.wallpaper';
export const WALL_FITS = ['cover', 'contain', 'center', 'tile'] as const;
export type WallFit = (typeof WALL_FITS)[number];
export interface WallPrefs {
  fit: WallFit;
  /** The --bg-0 veil the user asked for, 0..1 (the applied one is never below the floor of the image on this theme). */
  veil: number;
  /** px, integer 0..20. */
  blur: number;
  /** Panel opacity, 0.75..1. */
  panel: number;
}
export const WALL_DEFAULTS: Readonly<WallPrefs> = { fit: 'cover', veil: 0.3, blur: 0, panel: 0.9 };
export const PANEL_MIN = 0.75;
export const BLUR_MAX = 20;

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isFit = (v: unknown): v is WallFit => typeof v === 'string' && (WALL_FITS as readonly string[]).includes(v);

/**
 * The rule of the key (H key table and the reader): a JSON object with exactly fit, veil, blur and panel; fit one of the four;
 * veil 0..1; blur an integer 0..20; panel 0.75..1.
 */
export function wallpaperPrefsValid(raw: string): boolean {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return false; }
  if (!isPlain(v)) return false;
  const keys = Object.keys(v);
  if (keys.length !== 4 || !['fit', 'veil', 'blur', 'panel'].every((k) => keys.includes(k))) return false;
  return isFit(v.fit)
    && num(v.veil) && v.veil >= 0 && v.veil <= 1
    && num(v.blur) && Number.isInteger(v.blur) && v.blur >= 0 && v.blur <= BLUR_MAX
    && num(v.panel) && v.panel >= PANEL_MIN && v.panel <= 1;
}

/**
 * What the app uses from a stored value: a valid one as it is. One edited by hand is fixed field by field instead of being
 * dropped (a panel of 0.5 shows at 0.75, DESIGN J test 10); an unreadable one gives the defaults.
 */
export function parseWallPrefs(raw: string | null): WallPrefs {
  if (raw === null) return { ...WALL_DEFAULTS };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { ...WALL_DEFAULTS }; }
  if (!isPlain(v)) return { ...WALL_DEFAULTS };
  if (wallpaperPrefsValid(raw)) return { fit: v.fit as WallFit, veil: v.veil as number, blur: v.blur as number, panel: v.panel as number };
  const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
  return {
    fit: isFit(v.fit) ? v.fit : WALL_DEFAULTS.fit,
    veil: num(v.veil) ? clamp(v.veil, 0, 1) : WALL_DEFAULTS.veil,
    blur: num(v.blur) ? clamp(Math.round(v.blur), 0, BLUR_MAX) : WALL_DEFAULTS.blur,
    panel: num(v.panel) ? clamp(v.panel, PANEL_MIN, 1) : WALL_DEFAULTS.panel,
  };
}

export function readWallPrefs(): WallPrefs {
  try { return parseWallPrefs(typeof localStorage === 'undefined' ? null : localStorage.getItem(WALLPAPER_KEY)); } catch { return { ...WALL_DEFAULTS }; }
}
export function writeWallPrefs(p: WallPrefs): void {
  try { localStorage.setItem(WALLPAPER_KEY, JSON.stringify({ fit: p.fit, veil: p.veil, blur: p.blur, panel: p.panel })); } catch { /* not stored */ }
}
