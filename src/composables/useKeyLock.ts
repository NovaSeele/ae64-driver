// Key lock while measuring (DESIGN C §3.8): keys pressed to test them must not scroll the page or press the focused
// button. A keydown/keyup capture listener blocks (preventDefault + stopPropagation) the keys that would, unless focus
// is somewhere typing or a dialog needs them. Used by the live travel page (C) and by calibration (D). A lock whose page
// asks before leaving (calibration, `navEnter`) lets Enter through on a sidebar link: the leave Dialog guards it (L §11.1).
//
// Attached on mount and on KeepAlive activation, detached on unmount and deactivation: from part E the page is a tab kept
// alive, and a hidden tab must not swallow keys. The listener sits on document, not window: capture runs window first,
// so every window capture listener (demoPress, the demo keyboard) has already run, whenever it was attached, and a key
// it simulated arrives here `defaultPrevented` and is left alone. On window the two would run in attach order, and
// switching the demo keyboard on after the page opened would put the lock first.
import { onActivated, onBeforeUnmount, onDeactivated, onMounted } from 'vue';

/** Keys that scroll the page, press the focused control or type into it. */
const BLOCKED = new Set([
  'Space', 'Enter', 'NumpadEnter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
  'PageUp', 'PageDown', 'Home', 'End', 'Backspace',
]);

/** Focus inside these keeps every key: typing boxes and dialogs (a modal traps focus, so blocking there would strand a
 *  keyboard-only user with Esc alone). Not tablists: arrows on a focused tab row are exactly what the lock prevents. */
const EXEMPT = '[data-keytest], input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="dialog"], [role="alertdialog"], dialog';

/** The way out: the lock's own switch (`data-keylock` on it or around it) still toggles with Space. */
const LOCK_SWITCH = '[data-keylock]';

/** Sidebar links (DESIGN L §11.1): Enter there passes only for a lock whose page asks before leaving (calibration). */
const NAV_LINK = '[data-shellnav] a[href]';

export function isLockedCode(code: string): boolean {
  return BLOCKED.has(code) || /^Key[A-Z]$/.test(code) || /^Digit[0-9]$/.test(code) || /^Numpad[0-9]$/.test(code);
}

/** Whether the lock blocks this event (conditions 2–6 of DESIGN C §3.8; condition 1 is the caller's `active()`).
 *  `navEnter`: Enter / NumpadEnter on a sidebar link pass (DESIGN L §11.1); every other key there stays blocked. */
export function lockBlocks(e: KeyboardEvent, opts: { navEnter?: boolean } = {}): boolean {
  if (e.defaultPrevented) return false; // already handled (the demo keyboard simulated it)
  if (e.ctrlKey || e.altKey || e.metaKey) return false; // shortcuts pass; Shift does not exempt (Shift+Space scrolls)
  if (!isLockedCode(e.code)) return false; // Tab, Esc, F-keys…
  const target = e.target instanceof Element ? e.target : null;
  if (target?.closest(EXEMPT)) return false;
  if (target?.closest(LOCK_SWITCH)) return false;
  if (opts.navEnter && (e.code === 'Enter' || e.code === 'NumpadEnter') && target?.closest(NAV_LINK)) return false;
  return true;
}

export function useKeyLock(opts: {
  /** C: the switch is on and the page is measuring. D: the calibration phase is running or finishing. */
  active: () => boolean;
  /** Called for each blocked keydown (not keyup), e.g. to remind a keyboard user why their key did nothing. */
  onBlocked?: (e: KeyboardEvent) => void;
  /** Only for a page that asks before leaving (calibration's leave Dialog): Enter on a sidebar link passes (L §11.1). */
  navEnter?: boolean;
}): void {
  let attached = false;

  function onKey(e: KeyboardEvent): void {
    if (!opts.active() || !lockBlocks(e, { navEnter: opts.navEnter })) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'keydown') opts.onBlocked?.(e);
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKey, true);
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    document.removeEventListener('keydown', onKey, true);
    document.removeEventListener('keyup', onKey, true);
  }

  onMounted(attach);
  onActivated(attach);
  onDeactivated(detach);
  onBeforeUnmount(detach);
}
