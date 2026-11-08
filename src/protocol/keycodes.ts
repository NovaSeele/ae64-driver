// 16-bit AE64 keycode catalogue (ported from reference foundation.js / mapping.js).
// `label` is the short keycap legend, `long` the full name. Combinations carry a HID modifier mask
// in the high byte and one standard keyboard usage (4–223) in the low byte.
import { t } from '../i18n/vi';

export interface KeycodeEntry { code: number; label: string; long?: string }
export interface KeycodeGroup { id: string; label: string; codes: KeycodeEntry[] }

const e = (code: number, label: string, long?: string): KeycodeEntry => (long && long !== label ? { code, label, long } : { code, label });

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((ch, i) => e(4 + i, ch));
const DIGITS = '1234567890'.split('').map((ch, i) => e(30 + i, ch));

const BASIC: KeycodeEntry[] = [
  ...LETTERS,
  ...DIGITS,
  e(40, 'Enter'), e(41, 'Esc', 'Escape'), e(42, 'Bksp', 'Backspace'), e(43, 'Tab'), e(44, 'Space'),
  e(45, '-', 'Minus -'), e(46, '=', 'Equal ='), e(47, '[', 'Left bracket ['), e(48, ']', 'Right bracket ]'),
  e(49, '\\', 'Backslash \\'), e(50, '#~', 'Non-US # / ~'), e(51, ';', 'Semicolon ;'), e(52, "'", "Quote '"),
  e(53, '`', 'Grave `'), e(54, ',', 'Comma ,'), e(55, '.', 'Period .'), e(56, '/', 'Slash /'),
  e(57, 'Caps', 'Caps Lock'), e(100, '\\|', 'Non-US \\ / |'),
];

const MODIFIERS: KeycodeEntry[] = [
  e(224, 'LCtrl', 'Left Ctrl'), e(225, 'LShift', 'Left Shift'), e(226, 'LAlt', 'Left Alt'), e(227, 'LWin', 'Left Win'),
  e(228, 'RCtrl', 'Right Ctrl'), e(229, 'RShift', 'Right Shift'), e(230, 'RAlt', 'Right Alt'), e(231, 'RWin', 'Right Win'),
];

const FKEYS: KeycodeEntry[] = [
  ...Array.from({ length: 12 }, (_, i) => e(58 + i, `F${i + 1}`)),
  ...Array.from({ length: 12 }, (_, i) => e(104 + i, `F${i + 13}`)),
];

const NAVIGATION: KeycodeEntry[] = [
  e(70, 'PrtSc', 'Print Screen'), e(71, 'ScrLk', 'Scroll Lock'), e(72, 'Pause'), e(73, 'Ins', 'Insert'),
  e(74, 'Home'), e(75, 'PgUp', 'Page Up'), e(76, 'Del', 'Delete'), e(77, 'End'), e(78, 'PgDn', 'Page Down'),
  e(79, '→', 'Right Arrow'), e(80, '←', 'Left Arrow'), e(81, '↓', 'Down Arrow'), e(82, '↑', 'Up Arrow'),
  e(101, 'Menu', 'Application'),
];

const NUMPAD: KeycodeEntry[] = [
  e(83, 'NumLk', 'Num Lock'), e(84, 'N/', 'Numpad /'), e(85, 'N*', 'Numpad *'), e(86, 'N-', 'Numpad -'),
  e(87, 'N+', 'Numpad +'), e(88, 'NEnt', 'Numpad Enter'),
  ...Array.from({ length: 9 }, (_, i) => e(89 + i, `N${i + 1}`, `Numpad ${i + 1}`)),
  e(98, 'N0', 'Numpad 0'), e(99, 'N.', 'Numpad .'),
];

const MEDIA: KeycodeEntry[] = [
  e(0x20cd, 'Play/Ps', 'Play / Pause'), e(0x20b5, 'Next', 'Next Track'), e(0x20b6, 'Prev', 'Previous Track'),
  e(0x20b7, 'Stop'), e(0x20e2, 'Mute'), e(0x20e9, 'Vol +', 'Volume Up'), e(0x20ea, 'Vol -', 'Volume Down'),
  e(0x206f, 'Bright +', 'Display brightness +'), e(0x2070, 'Bright -', 'Display brightness -'),
  e(0x2183, 'Music'), e(0x218a, 'Mail'), e(0x2192, 'Calc', 'Calculator'), e(0x2194, 'PC', 'My Computer'),
  e(0x2223, 'Browser'),
  e(0x1152, 'Ctrl Ctr', 'macOS Control Center'), e(0x1329, 'Task Mgr', 'Windows Task Manager'),
  e(0x1807, 'Desktop', 'Windows Desktop'), e(0x1808, 'Explorer', 'Windows File Explorer'), e(0x1815, 'Run', 'Windows Run'),
];

const MOUSE: KeycodeEntry[] = [
  e(0x4100, 'M Left', 'Mouse Left'), e(0x4200, 'M Right', 'Mouse Right'), e(0x4300, 'M Mid', 'Mouse Middle'),
  e(0x4400, 'M Fwd', 'Mouse Forward'), e(0x4500, 'M Back', 'Mouse Back'),
  e(0x4600, 'M ←', 'Mouse Move Left'), e(0x4700, 'M →', 'Mouse Move Right'),
  e(0x4800, 'M ↑', 'Mouse Move Up'), e(0x4900, 'M ↓', 'Mouse Move Down'),
  e(0x4a01, 'Whl +', 'Mouse Wheel Forward'), e(0x4b01, 'Whl -', 'Mouse Wheel Back'), e(0x4000, 'M Rel', 'Mouse Release'),
];

const LAYER: KeycodeEntry[] = [
  e(0xf100, 'Main', 'Switch main layer'), e(0xf101, 'Fn1', 'Switch Fn1 layer'),
  e(0xf102, 'Fn2', 'Switch Fn2 layer'), e(0xf103, 'Fn3', 'Switch Fn3 layer'),
  e(0xf205, 'P1', 'Switch to profile 1'), e(0xf206, 'P2', 'Switch to profile 2'),
  e(0xf207, 'P3', 'Switch to profile 3'), e(0xf208, 'P4', 'Switch to profile 4'),
];

const MACRO: KeycodeEntry[] = Array.from({ length: 16 }, (_, i) => e(0xf500 + i, `M${i}`, `Macro ${i}`));

const LIGHTING_FN = ['Mode', 'Color', 'Br +', 'Br -', 'Spd +', 'Spd -', 'Prev', 'On/Off', 'Dir'];
const LIGHTING_LONG = ['mode', 'color', 'brightness +', 'brightness -', 'speed +', 'speed -', 'previous mode', 'on / off', 'direction'];
const lightingArea = (area: number, short: string, long: string) =>
  LIGHTING_FN.map((fn, i) => e(0xf300 + area * 0x10 + i, `${short} ${fn}`, `${long} ${LIGHTING_LONG[i]}`));
const LIGHTING: KeycodeEntry[] = [...lightingArea(0, 'RGB', 'Lighting'), ...lightingArea(1, 'D1', 'Decorative lighting')];

const SPECIAL: KeycodeEntry[] = [
  { code: 0x0000, label: 'Empty', get long() { return t('key.emptyDesc'); } }, { code: 0x0001, label: 'Trans', get long() { return t('key.transDesc'); } },
  e(0xf209, 'Win Lock', 'Lock Win key'), e(0xf201, 'Win Mode', 'Switch to Windows layout (hold)'),
  e(0xf202, 'Mac Mode', 'Switch to macOS layout (hold)'), e(0xf203, 'Calibrate', 'Calibrate Hall sensors (hold)'),
];

/** Selectable groups (KeyPicker). Factory reset (F200), wireless and gamepad codes are deliberately not offered. */
export const KEYCODE_GROUPS: readonly KeycodeGroup[] = Object.freeze([
  { id: 'basic', get label() { return t('key.groupBasic'); }, codes: BASIC },
  { id: 'modifier', label: 'Modifier', codes: MODIFIERS },
  { id: 'fkeys', label: 'F-keys', codes: FKEYS },
  { id: 'navigation', get label() { return t('key.groupNavigation'); }, codes: NAVIGATION },
  { id: 'numpad', label: 'Numpad', codes: NUMPAD },
  { id: 'media', label: 'Media', codes: MEDIA },
  { id: 'mouse', get label() { return t('key.groupMouse'); }, codes: MOUSE },
  { id: 'layer', label: 'Layer/Fn', codes: LAYER },
  { id: 'macro', label: 'Macro', codes: MACRO },
  { id: 'lighting', get label() { return t('key.groupLighting'); }, codes: LIGHTING },
  { id: 'special', get label() { return t('key.groupSpecial'); }, codes: SPECIAL },
]);

// Decode-only entries: codes that may already be on the board but are never offered for writing.
const HIDDEN: KeycodeEntry[] = [
  e(0xf200, 'Reset', 'Factory reset (hold)'), e(0xf20a, 'Link', 'Link key'), e(0xf20c, 'FnNum', 'FnNum key'),
  ...lightingArea(2, 'D2', 'Decorative lighting 2'), ...lightingArea(3, 'D3', 'Decorative lighting 3'),
  e(0xf401, 'USB', 'Switch to USB mode'), e(0xf402, '2.4G', 'Switch to 2.4G mode / pair'),
  e(0xf403, 'BT1', 'Bluetooth 1'), e(0xf404, 'BT2', 'Bluetooth 2'), e(0xf405, 'BT3', 'Bluetooth 3'),
  e(0xf406, 'Clear Pair', 'Clear pairing data'), e(0xf407, 'Battery', 'Battery status'),
  e(0x5310, 'Pad A', 'Gamepad A'), e(0x5320, 'Pad B', 'Gamepad B'), e(0x5340, 'Pad X', 'Gamepad X'),
  e(0x5380, 'Pad Y', 'Gamepad Y'), e(0x5210, 'Start', 'Gamepad Start'), e(0x5220, 'Select', 'Gamepad Select'),
  e(0x5304, 'Pad Menu', 'Gamepad Menu'), e(0x5201, 'D-pad ↑', 'Gamepad D-pad Up'), e(0x5202, 'D-pad ↓', 'Gamepad D-pad Down'),
  e(0x5204, 'D-pad ←', 'Gamepad D-pad Left'), e(0x5208, 'D-pad →', 'Gamepad D-pad Right'),
  e(0x5301, 'LB', 'Gamepad Left Bumper'), e(0x5302, 'RB', 'Gamepad Right Bumper'),
  e(0x5400, 'LT', 'Gamepad Left Trigger'), e(0x5500, 'RT', 'Gamepad Right Trigger'),
  e(0x5240, 'LS Press', 'Gamepad Left Stick Press'), e(0x5280, 'RS Press', 'Gamepad Right Stick Press'),
  e(0x5601, 'LS →', 'Gamepad Left Stick Right'), e(0x5602, 'LS ←', 'Gamepad Left Stick Left'),
  e(0x5801, 'LS ↑', 'Gamepad Left Stick Up'), e(0x5802, 'LS ↓', 'Gamepad Left Stick Down'),
  e(0x5a01, 'RS →', 'Gamepad Right Stick Right'), e(0x5a02, 'RS ←', 'Gamepad Right Stick Left'),
  e(0x5c01, 'RS ↑', 'Gamepad Right Stick Up'), e(0x5c02, 'RS ↓', 'Gamepad Right Stick Down'),
];

const BY_CODE = new Map<number, { entry: KeycodeEntry; group: string }>();
for (const g of KEYCODE_GROUPS) for (const entry of g.codes) BY_CODE.set(entry.code, { entry, group: g.id });
for (const entry of HIDDEN) if (!BY_CODE.has(entry.code)) BY_CODE.set(entry.code, { entry, group: 'other' });

/**
 * HID modifier bits for combinations (high byte). The firmware combo format has only the four left
 * modifiers: higher bits collide with media/mouse/system keycodes (e.g. 0xF205 = switch profile).
 */
export const COMBO_MODIFIERS: readonly { bit: number; label: string; short: string }[] = Object.freeze([
  { bit: 0x01, label: 'Left Ctrl', short: 'Ctrl' },
  { bit: 0x02, label: 'Left Shift', short: 'Shift' },
  { bit: 0x04, label: 'Left Alt', short: 'Alt' },
  { bit: 0x08, label: 'Left Win', short: 'Win' },
]);

/** Valid combination trigger: a standard keyboard usage (4–223) known to the catalogue. */
export function isComboTrigger(code: number): boolean {
  return code >= 4 && code < 224 && BY_CODE.has(code);
}

/** True for any code the catalogue knows (offered or decode-only). */
export function isKnownKeycode(code: number): boolean {
  return BY_CODE.has(code);
}

/** Builds a combo keycode; throws RangeError for anything but left modifiers + a plain keyboard key. */
export function comboKeycode(mask: number, trigger: number): number {
  if (!(mask & 0x0f) || mask & ~0x0f) throw new RangeError(t('error.modifierRequired'));
  if (!isComboTrigger(trigger)) throw new RangeError(t('error.comboTriggerStandard'));
  const code = (mask << 8) | trigger;
  if (BY_CODE.has(code)) throw new RangeError(t('error.comboTriggerStandard'));
  return code;
}

/**
 * Decode a combination. Only the left four modifier bits are recognised automatically (as in the
 * reference), because other high bytes are used by media/mouse/firmware functions.
 */
export function decodeCombo(code: number): { mask: number; trigger: number } | null {
  const mask = (code >>> 8) & 0xff;
  const trigger = code & 0xff;
  if (code <= 0xff || !mask || mask & ~0x0f || !isComboTrigger(trigger)) return null;
  return { mask, trigger };
}

export function keycodeLabel(code: number): { label: string; group: string; long?: string } {
  const known = BY_CODE.get(code);
  if (known) return { label: known.entry.label, group: known.group, long: known.entry.long ?? known.entry.label };
  const combo = decodeCombo(code);
  if (combo) {
    const mods = COMBO_MODIFIERS.filter((m) => combo.mask & m.bit);
    const key = BY_CODE.get(combo.trigger)!.entry;
    return {
      label: `${mods.map((m) => m.short).join('+')}+${key.label}`,
      group: 'combo',
      long: `${mods.map((m) => m.label).join(' + ')} + ${key.long ?? key.label}`,
    };
  }
  const hex = `0x${code.toString(16).padStart(4, '0').toUpperCase()}`;
  return { label: hex, group: 'unknown', long: `Keycode ${hex}` };
}
