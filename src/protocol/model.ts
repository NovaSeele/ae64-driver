// Which AE64 model a keyboard is: by its board ID (01 02), or by the USB product ID when the board is not known yet.
import { PRODUCT_ID_MAX, PRODUCT_ID_PRO } from './constants';

export type Ae64Model = 'max' | 'pro';

const BY_BOARD: Readonly<Record<string, Ae64Model>> = { '0030000d': 'max', '0030000a': 'pro' };
const BY_PRODUCT: Readonly<Record<number, Ae64Model>> = { [PRODUCT_ID_MAX]: 'max', [PRODUCT_ID_PRO]: 'pro' };

/** The board ID wins; the product ID is only the fallback. Null for anything else. */
export function modelOf(info: { productId?: number; boardIdHex?: string | null }): Ae64Model | null {
  const board = info.boardIdHex?.toLowerCase();
  if (board && Object.hasOwn(BY_BOARD, board)) return BY_BOARD[board];
  if (info.productId !== undefined && Object.hasOwn(BY_PRODUCT, info.productId)) return BY_PRODUCT[info.productId];
  return null;
}

export function modelName(model: Ae64Model): string {
  return model === 'pro' ? 'AE64 Pro' : 'AE64 Max';
}
