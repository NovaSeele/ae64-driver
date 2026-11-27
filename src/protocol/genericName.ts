// Public display names for non-AE64 boards (DESIGN MKB §7).
// Pure functions: table lookup by board ID -> sanitised raw identity.productName -> fallback VID:PID.

import type { TransportIdentity } from './types';

/** Public board name table (DESIGN MKB §7). Only entries with a public source or owner export belong here. */
export const PUBLIC_BOARD_NAMES: Readonly<Record<string, string>> = Object.freeze({
  '00300002': 'Everglide SU75 Pro', // HallJoy EVERGLIDE_SU75_REVISIONS
  '00300007': 'Everglide SU75 Ultra', // HallJoy EVERGLIDE_SU75_REVISIONS
  '001b0010': 'Wuque BABAO60 HE', // OpenMouse src/wuque/device.ts
});

const MAX_PRODUCT_NAME_CHARS = 40;

/** Strips unprintable/control/separator characters, trims, and caps at 40 characters; returns empty string if nothing remains. */
function sanitiseProductName(raw: string): string {
  const cleaned = raw.replace(/[\p{C}\p{Zl}\p{Zp}]/gu, '').trim();
  if (!cleaned) return '';
  return Array.from(cleaned).slice(0, MAX_PRODUCT_NAME_CHARS).join('').trim();
}

const hex4 = (n: number): string => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');

/**
 * Display name for a generic board (DESIGN MKB §7):
 * 1. PUBLIC_BOARD_NAMES by board ID (when known);
 * 2. sanitised raw `identity.productName` (trimmed, printable only, ≤ 40 chars, skipped if empty);
 * 3. `Bàn phím {VID}:{PID}` (vi) or `Keyboard {VID}:{PID}` (en) in upper-case hex.
 */
export function genericDisplayName(
  identity: Pick<TransportIdentity, 'vendorId' | 'productId' | 'productName'>,
  boardIdHex?: string | null,
  locale: 'vi' | 'en' = 'vi',
): string {
  const board = boardIdHex?.toLowerCase();
  if (board && Object.hasOwn(PUBLIC_BOARD_NAMES, board)) return PUBLIC_BOARD_NAMES[board];
  const product = sanitiseProductName(identity.productName ?? '');
  if (product) return product;
  const prefix = locale === 'en' ? 'Keyboard' : 'Bàn phím';
  return `${prefix} ${hex4(identity.vendorId)}:${hex4(identity.productId)}`;
}
