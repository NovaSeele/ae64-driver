// How the Lighting page draws its effect buttons (FXP §3): "Tắt" (numbers), "Sơ lược" (icons, the default) or "Chi tiết"
// (moving mini keyboards). Remembered per browser for both tabs and every profile. Display only: never sent to a keyboard.

export type FxView = 'off' | 'lite' | 'detail';
export const FX_VIEW_KEY = 'ae64.lighting.fxView';
const VIEWS: readonly FxView[] = ['off', 'lite', 'detail'];

/** A stored view the page reads as itself (the settings file's rule for FX_VIEW_KEY). */
export const isFxView = (raw: string | null): raw is FxView => VIEWS.includes(raw as FxView);

/** The stored view; nothing stored, an unknown value or a storage error counts as "lite". */
export function readFxView(): FxView {
  try {
    const v = typeof localStorage === 'undefined' ? null : localStorage.getItem(FX_VIEW_KEY);
    return isFxView(v) ? v : 'lite';
  } catch {
    return 'lite';
  }
}

export function writeFxView(v: FxView): void {
  try { localStorage.setItem(FX_VIEW_KEY, v); } catch { /* storage may be blocked: the view still changes */ }
}
