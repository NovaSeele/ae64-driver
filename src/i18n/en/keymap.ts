// English strings for the keymap area. Must have exactly the keys of keymapVi (../keymap.ts).
import type { keymapVi } from '../keymap';

export const keymapEn: Record<keyof typeof keymapVi, string> = {
  'keymap.layerMain': 'Main',
  'keymap.layerFn1': 'Fn1',
  'keymap.layerFn2': 'Fn2',
  'keymap.layerFn3': 'Fn3',
  'keymap.layerTab': 'Layer {name}',
  'keymap.keyLabel': 'Keymap {layer} · {key}',
  'keymap.restoreDefault': 'Restore default layer',
  'keymap.restoreDefaultTitle': 'Restore default layer',
  'keymap.restoreDefaultBody': 'This will restore {n} key(s) on layer {layer} to factory defaults. Are you sure you want to proceed?',
  'keymap.restoreDefaultConfirm': 'Restore {n} keys',
  'keymap.restoreDefaultCancel': 'Cancel',
  'keymap.restoreDefaultSuccess': 'Restored {n} key(s) to default.',
  'keymap.restoreDefaultNone': 'This layer is already set to defaults.',
  'keymap.fnRuleNote': 'Fn rule: When assigning an Fn switch key (Fn1–Fn3), the same key on higher layers is automatically set to Transparent (0001) so releasing it returns to the proper layer.',
  'keymap.fnGuardedApplied': 'Automatically set higher layers to Transparent for this Fn key.',
  'keymap.transparentHint': '▽ Transparent key: Inherits keycode from lower layer ({inherited}).',
  'keymap.emptyHint': 'Empty key (no action assigned).',
  'keymap.editLabel': 'Remap ({n} keys)',
  'keymap.selectKeyPrompt': 'Select one or more keys to assign an action.',
};
