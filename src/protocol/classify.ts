// Pure classifier for AE64 vs generic platform devices (DESIGN MKB §3.2, §3.3, §5.1, §5.3).
// Used for WebHID and mocks alike: a mock never presets support; this function decides from identity + replies.

import type { DeviceInfo, ProtocolVersion, SupportLevel } from './types';
import { ALLOWED_BOARDS, CONFIG_USAGE, CONFIG_USAGE_PAGE, HID_FILTERS, RECEIVER_USAGE_PAGE, VENDOR_ID } from './constants';
import { isFwBoard } from './firmware';

/** Structural subset shared by WebHID `HIDDevice` and `TransportIdentity` (DESIGN MKB §3.3). */
export interface HidDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly collections?: readonly { readonly usagePage?: number; readonly usage?: number }[];
}

export type RefusalReason = 'receiver' | 'protocol' | 'version' | 'bootOther' | 'mode';

export type ClassifyResult =
  | { ok: true; support: SupportLevel }
  | { ok: false; reason: RefusalReason };

export function hasConfigCollection(device: Pick<HidDeviceLike, 'collections'>): boolean {
  return (device.collections ?? []).some((c) => c.usagePage === CONFIG_USAGE_PAGE && c.usage === CONFIG_USAGE);
}

export function isAe64(device: HidDeviceLike): boolean {
  return HID_FILTERS.some((f) => f.vendorId === device.vendorId && f.productId === device.productId) && hasConfigCollection(device);
}

/** True when the device exposes the FF80 wireless receiver collection (G0). */
export function hasReceiverCollection(device: Pick<HidDeviceLike, 'collections'>): boolean {
  return (device.collections ?? []).some((c) => c.usagePage === RECEIVER_USAGE_PAGE);
}

/**
 * Classifies a device from its USB identity, `01 02` DeviceInfo, and (for non-AE64 app-mode devices) `01 01` ProtocolVersion.
 * Covers gates G0–G4 (§5.1) and the run-mode-255 table (§5.3).
 */
export function classify(
  identity: HidDeviceLike,
  info: DeviceInfo | null | undefined,
  version?: ProtocolVersion | null,
): ClassifyResult {
  if (isAe64(identity)) {
    if (!info) return { ok: false, reason: 'protocol' };
    if (info.runMode === 0) {
      return {
        ok: true,
        support: ALLOWED_BOARDS.includes(info.boardIdHex.toLowerCase()) ? 'ae64' : 'ae64-unlisted',
      };
    }
    if (info.runMode === 255) return { ok: true, support: 'rescue' };
    return { ok: false, reason: 'mode' };
  }

  // Non-AE64 identity: G0 (FF80 receiver) before any command.
  if (hasReceiverCollection(identity)) return { ok: false, reason: 'receiver' };
  // G1: `01 02` must answer.
  if (!info) return { ok: false, reason: 'protocol' };
  // G2 & §5.3: run mode 255 vs 0 vs unknown.
  if (info.runMode === 255) {
    const board = info.boardId >>> 0;
    const ae64OrBlank = isFwBoard(board) || board === 0 || board === 0xffffffff;
    if (identity.vendorId === VENDOR_ID && ae64OrBlank) return { ok: true, support: 'rescue' };
    return { ok: false, reason: 'bootOther' };
  }
  if (info.runMode !== 0) return { ok: false, reason: 'mode' };
  // G3: board ID not 0 and not FFFFFFFF.
  const board = info.boardId >>> 0;
  if (board === 0 || board === 0xffffffff) return { ok: false, reason: 'protocol' };
  // G4: `01 01` reply with main === 1 (v2 dialect).
  if (!version || version.main !== 1) return { ok: false, reason: 'version' };
  return { ok: true, support: 'generic' };
}
