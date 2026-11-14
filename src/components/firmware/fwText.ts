// Text helpers of the Firmware page (DESIGN FW §14). A message of the store is translated when shown: the locale may change.
import { t } from '../../i18n/vi';
import type { FwMessage } from '../../stores/firmware';

export function fwText(m: FwMessage | null): string {
  if (!m) return '';
  const params: Record<string, string | number> = { ...m.params };
  for (const [k, key] of Object.entries(m.paramKeys ?? {})) params[k] = t(key, m.params);
  return t(m.key, params);
}

/** KiB with one decimal, as the progress line shows it ("42.9"). */
export const kib = (bytes: number): string => (bytes / 1024).toFixed(1);

/** Whole percent of the write, from packets sent. */
export const percent = (sent: number, total: number): number => (total > 0 ? Math.floor((sent / total) * 100) : 0);
