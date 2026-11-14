// The colour picker's recent colours, kept in this browser's localStorage (never sent to the keyboard).
// Here and not in ColorPicker.vue so the settings import (DESIGN H §3.5) checks a stored value with the same key and limit.

export const RECENT_KEY = 'ae64.recentColors';
export const RECENT_MAX = 12;

/** What the picker reads: the strings of a stored array, at most RECENT_MAX; anything unreadable is no colours. */
export function loadRecent(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** A stored value an import may write: a JSON array of at most RECENT_MAX "#rrggbb" strings (what `remember()` writes). */
export function recentValid(raw: string): boolean {
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return false; }
  return Array.isArray(v) && v.length <= RECENT_MAX && v.every((x) => typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x));
}
