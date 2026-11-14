// The accent colour at start-up and on a theme change (DESIGN J §3.3): only copies the cached token set onto :root. The
// OKLCH maths that builds the cache is in src/accent.ts, loaded on demand (import()), so the first paint never waits for it.
import { shallowRef } from 'vue';

/** The picked colour ("#rrggbb", lower case), not the adjusted one. No key = the theme's own accent. */
export const ACCENT_KEY = 'ae64.accent';
/** Derived cache: the five tokens for all 11 themes. Never exported or imported; import and reset remove it. */
export const ACCENT_VARS_KEY = 'ae64.accentVars';
/** The five root tokens a custom accent sets inline on <html>. Every other accent token is derived in themes.css. */
export const ACC_VAR_KEYS = ['--acc', '--acc-hover', '--on-acc', '--sel', '--m-actuation'] as const;
export type AccVarKey = (typeof ACC_VAR_KEYS)[number];
export type AccentVars = Record<AccVarKey, string>;
export interface AccentCache {
  v: 1;
  hex: string;
  themes: Record<string, AccentVars>;
}

const HEX = /^#[0-9a-f]{6}$/;
/** The rule of `ae64.accent`, shared with the settings import (DESIGN H §3.5): "#rrggbb" in lower case. */
export const isAccentHex = (raw: unknown): raw is string => typeof raw === 'string' && HEX.test(raw);

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
export function isAccentVars(v: unknown): v is AccentVars {
  return isPlain(v) && ACC_VAR_KEYS.every((k) => isAccentHex(v[k]));
}

function getItem(key: string): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(key); } catch { return null; }
}

/** The cache when it belongs to `hex` and holds a valid set for every theme in `themeIds`; null otherwise. */
export function parseAccentCache(raw: string | null, hex: string | null, themeIds: readonly string[]): AccentCache | null {
  if (!raw || !hex) return null;
  let c: unknown;
  try { c = JSON.parse(raw); } catch { return null; }
  if (!isPlain(c) || c.v !== 1 || c.hex !== hex || !isPlain(c.themes)) return null;
  const themes = c.themes;
  if (!themeIds.every((id) => Object.prototype.hasOwnProperty.call(themes, id) && isAccentVars(themes[id]))) return null;
  return c as unknown as AccentCache;
}

export interface AccentState {
  /** The picked colour, or null for the theme's own. */
  hex: string | null;
  /** Its token sets, or null while they are missing (being built) or when hex is null. */
  cache: AccentCache | null;
}

/** Ids every cache must cover; set by theme.ts (no import of theme.ts here, so no cycle). */
let themeIds: readonly string[] = [];

export function readAccentState(ids: readonly string[] = themeIds): AccentState {
  const raw = getItem(ACCENT_KEY);
  const hex = isAccentHex(raw) ? raw : null;
  return { hex, cache: parseAccentCache(getItem(ACCENT_VARS_KEY), hex, ids) };
}

export const accentState = shallowRef<AccentState>({ hex: null, cache: null });

export function initAccentState(ids: readonly string[]): void {
  themeIds = ids;
  accentState.value = readAccentState(ids);
}

/** Sets the five tokens inline on `el`, or removes all five (null: the theme's own accent). */
export function applyAccent(vars: AccentVars | null, el: HTMLElement = document.documentElement): void {
  for (const k of ACC_VAR_KEYS) {
    if (vars) el.style.setProperty(k, vars[k]);
    else el.style.removeProperty(k);
  }
}

/** The token set of `themeId` for the current accent, or null (the theme's own). */
export function accentVarsFor(themeId: string, st: AccentState = accentState.value): AccentVars | null {
  return st.hex && st.cache ? st.cache.themes[themeId] ?? null : null;
}
