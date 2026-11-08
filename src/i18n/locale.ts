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
