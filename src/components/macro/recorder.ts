import { MACRO_MAX_DELAY_MS } from '../../protocol';
import type { MacroAction } from '../../protocol';
// Browser KeyboardEvent.code → HID usage, ported from reference macro.js macroKeyboardEventKeycode.
const DIRECT: Record<string, number> = {
  Enter: 40, Escape: 41, Backspace: 42, Tab: 43, Space: 44, Minus: 45, Equal: 46,
  BracketLeft: 47, BracketRight: 48, Backslash: 49, IntlHash: 50, Semicolon: 51,
  Quote: 52, Backquote: 53, Comma: 54, Period: 55, Slash: 56, CapsLock: 57,
  PrintScreen: 70, ScrollLock: 71, Pause: 72, Insert: 73, Home: 74, PageUp: 75,
  Delete: 76, End: 77, PageDown: 78, ArrowRight: 79, ArrowLeft: 80, ArrowDown: 81,
  ArrowUp: 82, NumLock: 83, NumpadDivide: 84, NumpadMultiply: 85, NumpadSubtract: 86,
  NumpadAdd: 87, NumpadEnter: 88, NumpadDecimal: 99, IntlBackslash: 100, ContextMenu: 101,
  ControlLeft: 224, ShiftLeft: 225, AltLeft: 226, MetaLeft: 227,
  ControlRight: 228, ShiftRight: 229, AltRight: 230, MetaRight: 231,
};

export function hidUsageOf(code: string): number | null {
  if (/^Key[A-Z]$/.test(code)) return 4 + code.charCodeAt(3) - 65;
  if (/^Digit[0-9]$/.test(code)) return code === 'Digit0' ? 39 : 29 + Number(code.slice(5));
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) {
    const n = Number(code.slice(1));
    return n <= 12 ? 57 + n : 91 + n;
  }
  if (/^Numpad[0-9]$/.test(code)) return code === 'Numpad0' ? 98 : 88 + Number(code.slice(6));
  return DIRECT[code] ?? null;
}

/** Browser code that stops the recorder (it is not recorded; add Esc by hand with the key picker). */
export const RECORD_STOP_CODE = 'Escape';

export interface RecordEvent { code: string; type: 'keydown' | 'keyup'; repeat: boolean }
export interface RecordResult {
  /** Action to append to the sequence. */
  action?: MacroAction;
  /** The recorder must stop now (the caller then appends finish()). */
  stop?: 'escape' | 'limit';
}

/**
 * Pure recorder state: which keys are held, delays between events and the action limit.
 * Room for one release per held key is always kept, so stopping can never leave a key (e.g. Alt) pressed.
 */
export class MacroRecorder {
  private held = new Map<string, number>();
  private lastAt = 0;

  constructor(readonly limit: number) {}

  get heldCount(): number {
    return this.held.size;
  }

  private delaySince(now: number): number {
    return this.lastAt ? Math.round(Math.min(MACRO_MAX_DELAY_MS, Math.max(1, now - this.lastAt))) : 1;
  }

  /** `count` = actions already in the sequence. */
  handle(e: RecordEvent, count: number, now: number): RecordResult {
    if (e.code === RECORD_STOP_CODE && e.type === 'keydown') return { stop: 'escape' };
    if (e.repeat) return {};
    const keycode = hidUsageOf(e.code);
    if (!keycode) return {};
    const down = e.type === 'keydown';
    if (down === this.held.has(e.code)) return {};
    // A press needs room for itself plus the releases of everything held (including itself).
    if (down && count + 2 + this.held.size > this.limit) return { stop: 'limit' };
    const action: MacroAction = { keycode, down, delay: this.delaySince(now) };
    if (down) this.held.set(e.code, keycode); else this.held.delete(e.code);
    this.lastAt = now;
    return { action };
  }

  /** Releases for every key still held (window blur, Stop, limit); empties the held set. */
  finish(now: number): MacroAction[] {
    const out: MacroAction[] = [];
    for (const keycode of this.held.values()) {
      out.push({ keycode, down: false, delay: this.delaySince(now) });
      this.lastAt = now;
    }
    this.held.clear();
    return out;
  }
}
