import { computed, ref, watch, type Ref } from 'vue';
import { ACCENT_KEY, ACCENT_VARS_KEY, accentState, accentVarsFor, applyAccent, initAccentState, readAccentState } from './accentCache';

export type ThemeId = 'graphite' | 'light' | 'indigo' | 'indigo-light' | 'gold' | 'ember' | 'aurora' | 'mint' | 'nord' | 'dracula' | 'rose';
export type ThemeChoice = 'auto' | ThemeId;

/** Picker order. */
export const THEMES: readonly ThemeId[] = ['graphite', 'light', 'indigo', 'indigo-light', 'gold', 'ember', 'aurora', 'mint', 'nord', 'dracula', 'rose'];

const STORAGE_KEY = 'ae64.theme';
const DEFAULT_CHOICE: ThemeChoice = 'auto';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

// Saved choices from before the rename.
const LEGACY: Record<string, ThemeId> = { seele: 'indigo', 'seele-light': 'indigo-light' };

/** A stored theme value the app reads as itself: 'auto', a theme id, or an old name. Shared with the settings import
 *  (DESIGN H §3.5). `hasOwnProperty`, not `in`: "constructor", "toString" or "__proto__" must not pass. */
export function isThemeChoice(v: unknown): v is string {
  return typeof v === 'string'
    && (v === 'auto' || (THEMES as readonly string[]).includes(v) || Object.prototype.hasOwnProperty.call(LEGACY, v));
}

export function parseThemeChoice(v: unknown): ThemeChoice {
  if (!isThemeChoice(v)) return DEFAULT_CHOICE;
  return Object.prototype.hasOwnProperty.call(LEGACY, v) ? LEGACY[v] : (v as ThemeChoice);
}

function readStored(): ThemeChoice {
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(STORAGE_KEY);
      const choice = parseThemeChoice(raw);
      if (raw !== null && Object.prototype.hasOwnProperty.call(LEGACY, raw)) localStorage.setItem(STORAGE_KEY, choice);
      return choice;
    }
  } catch {
    // localStorage may be disabled or throw
  }
  return DEFAULT_CHOICE;
}

const media: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(LIGHT_QUERY) : null;
const osLight = ref(media?.matches ?? false);
media?.addEventListener?.('change', (e) => {
  osLight.value = e.matches;
});

export const themeChoice: Ref<ThemeChoice> = ref(readStored());

/** What is applied now: `auto` resolved against the OS scheme (live). */
export const resolvedTheme = computed<ThemeId>(() =>
  themeChoice.value === 'auto' ? (osLight.value ? 'light' : 'graphite') : themeChoice.value,
);

function setMeta(name: string, content: string): void {
  let el = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  if (!el) {
    el = document.createElement('meta');
    el.name = name;
    document.head.appendChild(el);
  }
  el.content = content;
}

function applyTheme(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme.value;
  // A custom accent: copy this theme's cached token set (DESIGN J §3.3); no maths here.
  applyAccent(accentVarsFor(resolvedTheme.value));
  const cs = getComputedStyle(root);
  const scheme = cs.colorScheme.includes('light') ? 'light' : 'dark';
  setMeta('color-scheme', scheme);
  const bg = cs.getPropertyValue('--bg-1').trim();
  if (bg) setMeta('theme-color', bg);
}

initAccentState(THEMES);
watch([resolvedTheme, accentState], applyTheme, { flush: 'sync' });
applyTheme();

/**
 * ae64.accent set but its cache missing or stale (an imported settings file, an older build): rebuild it with the maths
 * chunk, loaded only now. No ae64.accent but a cache left: remove the cache.
 */
function repairAccentCache(): void {
  const st = accentState.value;
  if (st.hex && !st.cache) {
    const hex = st.hex;
    void import('./accent').then((m) => m.rebuildAccentCache(hex)).catch(() => { /* stays on the theme's accent */ });
  } else if (!st.hex) {
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem(ACCENT_VARS_KEY) !== null) localStorage.removeItem(ACCENT_VARS_KEY);
    } catch {
      // ignore storage error
    }
  }
}
repairAccentCache();

export function setTheme(choice: ThemeChoice): void {
  themeChoice.value = parseThemeChoice(choice);
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, themeChoice.value);
  } catch {
    // ignore storage error
  }
}

// Other open tabs follow a change (key is null when storage was cleared).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY || e.key === null) themeChoice.value = parseThemeChoice(e.newValue);
    // Another tab picked an accent: follow once its colour and cache agree (it writes both; never write from here).
    if (e.key === ACCENT_KEY || e.key === ACCENT_VARS_KEY || e.key === null) {
      const st = readAccentState();
      if (!st.hex || st.cache) accentState.value = st;
    }
  });
}
