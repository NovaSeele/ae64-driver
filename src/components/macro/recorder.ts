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
