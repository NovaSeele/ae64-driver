// One-use flag for the toast after an app-settings import or reset reloads the page (DESIGN H §3.6). Kept apart from
// appSettings.ts so App.vue reads it without pulling the whole settings module into the main bundle.
// sessionStorage: it never sits in localStorage, so it is never exported, imported or reset.

export const APPCFG_DONE_KEY = 'ae64.appcfg.done';
export type AppcfgDone = 'import' | 'reset';

/** Reads and clears the flag. */
export function takeAppcfgDone(): AppcfgDone | null {
  try {
    const v = sessionStorage.getItem(APPCFG_DONE_KEY);
    if (v === null) return null;
    sessionStorage.removeItem(APPCFG_DONE_KEY);
    return v === 'import' || v === 'reset' ? v : null;
  } catch {
    return null;
  }
}

export function setAppcfgDone(kind: AppcfgDone): void {
  try { sessionStorage.setItem(APPCFG_DONE_KEY, kind); } catch { /* no toast after the reload, nothing else lost */ }
}
