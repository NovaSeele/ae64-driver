import { ref } from 'vue';

export type Locale = 'vi' | 'en';

const STORAGE_KEY = 'ae64.locale';

function getInitialLocale(): Locale {
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved === 'vi' || saved === 'en') return saved;
    }
  } catch {
    // localStorage may be disabled or throw
  }

  if (
    typeof navigator !== 'undefined' &&
    typeof navigator.language === 'string' &&
    navigator.language.toLowerCase().startsWith('vi')
  ) {
    return 'vi';
  }

  return 'en';
}

export const locale = ref<Locale>(getInitialLocale());

if (typeof document !== 'undefined') {
  document.documentElement.lang = locale.value;
}

export function setLocale(l: Locale): void {
  locale.value = l;
  if (typeof document !== 'undefined') {
    document.documentElement.lang = l;
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(STORAGE_KEY, l);
    }
  } catch {
    // ignore storage error
  }
}

/**
 * Plural forms inside a message: `{n|# key|# keys}` → "1 key" / "2 keys" (`#` becomes the number).
 * Forms are `one|other`; Vietnamese has a single form, so its tables may simply use `{n}`.
 * Applied by t() before `{name}` substitution; call directly for strings outside the dictionary.
 */
export function plural(n: number, one: string, other: string, loc: Locale = locale.value): string {
  const form = new Intl.PluralRules(loc).select(n) === 'one' ? one : other;
  return form.replace(/#/g, String(n));
}

export function applyPlurals(s: string, params?: Record<string, string | number>): string {
  if (!params || !s.includes('|')) return s;
  return s.replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (m, k: string, one: string, other: string) => {
    const n = Number(params[k]);
    return Number.isFinite(n) ? plural(n, one, other) : m;
  });
}
