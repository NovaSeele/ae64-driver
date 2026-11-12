// Quick-select groups of the selection bar (DESIGN B §3.1): which keys are letters, digits, modifiers and WASD.
// A key belongs to a group by what it does on the Main layer (device.layer0), because that is what its keycap shows
// (device.legend). On the user's board id 52 (the right-Shift position) is Delete and id 54 is PrintScreen, so neither is
// a modifier. Until the keymap has been read the keycaps show the physical names, and so do the groups ('position').
import { isFnSwitch } from '../protocol/keycodes';
import type { PhysicalKey } from '../protocol';

export type KeyGroup = 'wasd' | 'letters' | 'digits' | 'mods';
export interface KeyGroups {
  wasd: number[];
  letters: number[];
  digits: number[];
  mods: number[];
  /** 'keymap' = by the Main layer keycodes; 'position' = by the physical names (keymap not read). */
  source: 'keymap' | 'position';
}

const W = 0x1a;
const A = 0x04;
const S = 0x16;
const D = 0x07;
const WASD_CODES = [W, A, S, D];
const isLetter = (c: number) => c >= 0x04 && c <= 0x1d;
const isDigit = (c: number) => c >= 0x1e && c <= 0x27;
/** Left/right Ctrl, Shift, Alt, GUI, and the Fn1–Fn3 layer keys. */
const isModifier = (c: number) => (c >= 0xe0 && c <= 0xe7) || isFnSwitch(c);

const POS_LETTERS = new Set('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split(''));
const POS_DIGITS = new Set('1234567890'.split(''));
const POS_MODS = new Set(['Shift', 'Ctrl', 'Win', 'Alt', 'Fn']); // layout.ts names both Shifts and both Alts alike

/** Every id is ordered by id, except WASD: W, A, S, D first by function, then by id (two keys mapped to W both count). */
export function keyGroups(keys: readonly PhysicalKey[], layer0: readonly number[]): KeyGroups {
  const byId = [...keys].sort((a, b) => a.id - b.id);
  if (layer0.length === keys.length && keys.length > 0) {
    const code = (k: PhysicalKey) => layer0[k.id] ?? 0;
    return {
      wasd: WASD_CODES.flatMap((c) => byId.filter((k) => code(k) === c).map((k) => k.id)),
      letters: byId.filter((k) => isLetter(code(k))).map((k) => k.id),
      digits: byId.filter((k) => isDigit(code(k))).map((k) => k.id),
      mods: byId.filter((k) => isModifier(code(k))).map((k) => k.id),
      source: 'keymap',
    };
  }
  return {
    wasd: ['W', 'A', 'S', 'D'].flatMap((n) => byId.filter((k) => k.name === n).map((k) => k.id)),
    letters: byId.filter((k) => POS_LETTERS.has(k.name)).map((k) => k.id),
    digits: byId.filter((k) => POS_DIGITS.has(k.name)).map((k) => k.id),
    mods: byId.filter((k) => POS_MODS.has(k.name)).map((k) => k.id),
    source: 'position',
  };
}
