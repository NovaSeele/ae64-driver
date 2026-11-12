// Names, groups and colours of the 24 controller outputs on the Gamepad page (DESIGN K-gamepad §3).
import { GP_CONTROLS, controlIndex, keyIndexOf, keyPosOf } from '../../protocol/gamepad';
import type { PhysicalKey } from '../../protocol';
import type { GpControl } from '../../protocol/gamepad';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';

export type GpGroup = 'lstick' | 'rstick' | 'trigger' | 'button' | 'dpad';

/** Short name on tiles and keycaps. */
export const SHORT: Readonly<Record<GpControl, string>> = {
  LT: 'LT', RT: 'RT',
  'LX-': 'LS←', 'LX+': 'LS→', 'LY-': 'LS↓', 'LY+': 'LS↑',
  'RX-': 'RS←', 'RX+': 'RS→', 'RY-': 'RS↓', 'RY+': 'RS↑',
  A: 'A', B: 'B', X: 'X', Y: 'Y', LB: 'LB', RB: 'RB', BACK: 'Back', START: 'Start', L3: 'L3', R3: 'R3',
  DPAD_UP: 'D↑', DPAD_DOWN: 'D↓', DPAD_LEFT: 'D←', DPAD_RIGHT: 'D→',
};

export function groupOf(id: GpControl): GpGroup {
  if (/^L[XY]/.test(id) || id === 'L3') return 'lstick';
  if (/^R[XY]/.test(id) || id === 'R3') return 'rstick';
  if (id === 'LT' || id === 'RT') return 'trigger';
  if (id.startsWith('DPAD_')) return 'dpad';
  return 'button';
}

export const toneOf = (id: GpControl): string => `var(--g-${groupOf(id)})`;
export const toneOfIndex = (index: number): string => toneOf(GP_CONTROLS[index].id);

const DIR: Partial<Record<GpControl, 'up' | 'down' | 'left' | 'right'>> = {
  'LY+': 'up', 'LY-': 'down', 'LX-': 'left', 'LX+': 'right',
  'RY+': 'up', 'RY-': 'down', 'RX-': 'left', 'RX+': 'right',
  DPAD_UP: 'up', DPAD_DOWN: 'down', DPAD_LEFT: 'left', DPAD_RIGHT: 'right',
};
const GROUP_TITLE: Record<GpGroup, MessageKey> = {
  lstick: 'gp.gLeft', rstick: 'gp.gRight', trigger: 'gp.gTriggers', button: 'gp.gButtons', dpad: 'gp.gDpad',
};
export const groupTitle = (g: GpGroup): string => t(GROUP_TITLE[g]);

/** Full name ("Cần trái · lên", "Cò trái (LT)", "A"). */
export function longName(id: GpControl): string {
  const own = `gp.out.${id}` as MessageKey;
  const dir = DIR[id];
  if (dir) return t('gp.dir', { group: groupTitle(groupOf(id)), dir: t(`gp.${dir}`) });
  const v = t(own);
  return v === own ? id : v;
}
export const longNameOf = (index: number): string => longName(GP_CONTROLS[index].id);

/** Output tiles by group, in the order of the cross / diamond layout (`area` places a tile in a 3×3 cross). */
export interface TileSpec { index: number; cap: string; area?: 'u' | 'l' | 'c' | 'r' | 'd' }
const tile = (id: GpControl, cap: string, area?: TileSpec['area']): TileSpec => ({ index: controlIndex(id), cap, area });
export const GROUPS: readonly { group: GpGroup; layout: 'cross' | 'pair' | 'buttons'; tiles: TileSpec[] }[] = [
  { group: 'lstick', layout: 'cross', tiles: [tile('LY+', '↑', 'u'), tile('LX-', '←', 'l'), tile('L3', 'L3', 'c'), tile('LX+', '→', 'r'), tile('LY-', '↓', 'd')] },
  { group: 'rstick', layout: 'cross', tiles: [tile('RY+', '↑', 'u'), tile('RX-', '←', 'l'), tile('R3', 'R3', 'c'), tile('RX+', '→', 'r'), tile('RY-', '↓', 'd')] },
  { group: 'trigger', layout: 'pair', tiles: [tile('LT', 'LT'), tile('RT', 'RT')] },
  {
    group: 'button', layout: 'buttons', tiles: [
      tile('Y', 'Y', 'u'), tile('X', 'X', 'l'), tile('B', 'B', 'r'), tile('A', 'A', 'd'),
      tile('LB', 'LB'), tile('RB', 'RB'), tile('BACK', 'Back'), tile('START', 'Start'),
    ],
  },
  { group: 'dpad', layout: 'cross', tiles: [tile('DPAD_UP', 'D↑', 'u'), tile('DPAD_LEFT', 'D←', 'l'), tile('DPAD_RIGHT', 'D→', 'r'), tile('DPAD_DOWN', 'D↓', 'd')] },
];

/** µm → "3.40" (mm, two decimals). */
export const mm = (um: number): string => (um / 1000).toFixed(2);

/** The keyboard key of a record key index (by its firmware row and column). */
export function physKey(keys: readonly PhysicalKey[], index: number): PhysicalKey | undefined {
  const pos = keyPosOf(index);
  return pos ? keys.find((k) => k.row === pos.row && k.col === pos.col) : undefined;
}

/** The record key index of a keyboard key. */
export const indexOfKey = (k: PhysicalKey): number | null => keyIndexOf(k.row, k.col);

/** Legend of a record key index on the current layer 0 ("#n" when the keyboard has no such key). */
export function keyLegend(device: { keys: readonly PhysicalKey[]; legend: (k: PhysicalKey) => string }, index: number): string {
  const k = physKey(device.keys, index);
  return k ? device.legend(k) : `#${index}`;
}
