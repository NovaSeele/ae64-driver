// Lighting effect names as recorded on a real AE64 Max (framebuffer captures, palette 0 and 1). The UI number is the
// firmware mode + 1. Only `sure` names are shown: a provisional or unknown effect keeps its number alone, and so does the
// Pro's #20 (never captured). Display only; nothing here is ever written to the keyboard.
import type { Locale } from '../i18n/locale';

export interface LedEffect {
  /** UI number (mode + 1). */
  n: number;
  vi?: string;
  en?: string;
  /** Extra tooltip line, [vi, en]. */
  hint?: [string, string];
  sure: boolean;
}

/** Lighting area: 0 = keys, 1 = edge strip. */
export type LedEffectArea = 0 | 1;

const reactive: Pick<LedEffect, 'vi' | 'en' | 'hint' | 'sure'> = {
  vi: 'Phản hồi khi gõ', en: 'Reactive', hint: ['Sáng khi bạn gõ phím', 'Lights up as you type'], sure: true,
};

const KEYS: LedEffect[] = [
  { n: 1, vi: 'Tĩnh', en: 'Static', sure: true },
  { n: 2, vi: 'Sóng ngang', en: 'Horizontal wave', sure: true },
  { n: 3, vi: 'Sóng dọc', en: 'Vertical wave', sure: true },
  { n: 4, vi: 'Gợn sóng', en: 'Ripple', sure: true },
  { n: 5, vi: 'Xoáy', en: 'Spiral', sure: true },
  { n: 6, sure: false },
  { n: 7, sure: false },
  { n: 8, vi: 'Thở', en: 'Breathing', sure: true },
  { n: 9, sure: false },
  { n: 10, vi: 'Quét màu', en: 'Color wipe', sure: true },
  { n: 11, vi: 'Sóng cong', en: 'Arc wave', sure: true },
  { n: 12, vi: 'Sóng sin', en: 'Sine wave', sure: true },
  { n: 13, vi: 'Màu ngẫu nhiên', en: 'Random colors', sure: true },
  { n: 14, vi: 'Lấp lánh', en: 'Twinkle', sure: true },
  { n: 15, vi: 'Sao sáng', en: 'Starlight', sure: true },
  { n: 16, vi: 'Giọt nước', en: 'Raindrop', sure: true },
  { n: 17, ...reactive },
  { n: 18, ...reactive },
  { n: 19, ...reactive },
];

const STRIP: LedEffect[] = [
  { n: 1, vi: 'Tĩnh', en: 'Static', sure: true },
  { n: 2, vi: 'Chạy vòng', en: 'Chase', sure: true },
  { n: 3, vi: 'Thở', en: 'Breathing', sure: true },
  { n: 4, vi: 'Sóng đối xứng', en: 'Mirrored wave', sure: true },
  { n: 5, vi: 'Đuổi đối xứng', en: 'Mirrored chase', sure: true },
];

/** Per board ID (hex, as in 01 02) and area. The Pro's #1–19 are taken to match the Max; its #20 is unknown. */
export const LED_EFFECTS: Readonly<Record<string, Readonly<Record<LedEffectArea, readonly LedEffect[]>>>> = {
  '0030000d': { 0: KEYS, 1: STRIP },
  '0030000a': { 0: [...KEYS, { n: 20, sure: false }], 1: STRIP },
};

function find(boardIdHex: string | undefined, area: LedEffectArea, n: number): LedEffect | undefined {
  const e = LED_EFFECTS[(boardIdHex ?? '').toLowerCase()]?.[area].find((x) => x.n === n);
  return e?.sure ? e : undefined;
}

/** The recorded name of effect `n` (UI number), or null when it is not sure or unknown. */
export function effectName(boardIdHex: string | undefined, area: LedEffectArea, n: number, locale: Locale): string | null {
  const e = find(boardIdHex, area, n);
  return (locale === 'vi' ? e?.vi : e?.en) ?? null;
}

/** The extra tooltip line of effect `n`, or null. */
export function effectHint(boardIdHex: string | undefined, area: LedEffectArea, n: number, locale: Locale): string | null {
  return find(boardIdHex, area, n)?.hint?.[locale === 'vi' ? 0 : 1] ?? null;
}
