// Text helpers of the Firmware page (DESIGN FW §14, DESIGN OFU §9). A message of the store is translated when shown: the locale
// may change. Every number uses the locale: vi "155,0 KiB", "262.144 byte"; en "155.0 KiB", "262,144 bytes".
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';
import type { FwMessage } from '../../stores/firmware';

export function fwText(m: FwMessage | null): string {
  if (!m) return '';
  const params: Record<string, string | number> = { ...m.params };
  for (const [k, key] of Object.entries(m.paramKeys ?? {})) params[k] = t(key, m.params);
  return t(m.key, params);
}

const numLocale = (): string => (locale.value === 'vi' ? 'vi-VN' : 'en-US');

/** KiB with one decimal, in the locale's format ("155,0" in vi, "155.0" in en). */
export const kib = (bytes: number): string =>
  (bytes / 1024).toLocaleString(numLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** A whole number in the locale's format ("158.672" in vi, "158,672" in en). */
export const num = (n: number): string => n.toLocaleString(numLocale());

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** A list date (YYYY-MM-DD) as people read it: vi "12/10/2026", en "12 Oct 2026". */
export function fwDate(d: string): string {
  const [y, m, dd] = d.split('-');
  return locale.value === 'vi' ? `${dd}/${m}/${y}` : `${Number(dd)} ${MONTHS[Number(m) - 1] ?? m} ${y}`;
}

/** The first and last 4 hex digits of a SHA-256 ("d587…2fd1"). */
export const shaShort = (h: string): string => `${h.slice(0, 4)}…${h.slice(-4)}`;

/** Whole percent of the write, from packets sent. */
export const percent = (sent: number, total: number): number => (total > 0 ? Math.floor((sent / total) * 100) : 0);
