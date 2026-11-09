import { computed, ref, watch, type Ref } from 'vue';

export type ThemeId = 'graphite' | 'light' | 'seele' | 'seele-light' | 'gold' | 'ember' | 'aurora' | 'mint' | 'nord' | 'dracula' | 'rose';
export type ThemeChoice = 'auto' | ThemeId;

/** Picker order. */
export const THEMES: readonly ThemeId[] = ['graphite', 'light', 'seele', 'seele-light', 'gold', 'ember', 'aurora', 'mint', 'nord', 'dracula', 'rose'];

const STORAGE_KEY = 'ae64.theme';
const DEFAULT_CHOICE: ThemeChoice = 'auto';
const LIGHT_QUERY = '(prefers-color-scheme: light)';

export function parseThemeChoice(v: unknown): ThemeChoice {
  return THEMES.find((id) => id === v) ?? DEFAULT_CHOICE;
}

function readStored(): ThemeChoice {
  try {
    if (typeof localStorage !== 'undefined') return parseThemeChoice(localStorage.getItem(STORAGE_KEY));
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
  const cs = getComputedStyle(root);
  const scheme = cs.colorScheme.includes('light') ? 'light' : 'dark';
  setMeta('color-scheme', scheme);
  const bg = cs.getPropertyValue('--bg-1').trim();
  if (bg) setMeta('theme-color', bg);
}

watch(resolvedTheme, applyTheme, { flush: 'sync' });
applyTheme();

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
  });
}
