// Public entry of the protocol layer (contract: contracts/protocol.ts → ProtocolModule).
import type { ProtocolModule } from './types';
import { ALLOWED_BOARDS, HID_FILTERS } from './constants';
import { PHYSICAL_KEYS } from './layout';
import { connectHid, reconnectGrantedHid } from './hid';
import { createMockTransport } from './mock';
import { KEYCODE_GROUPS, keycodeLabel } from './keycodes';

export * from './types';
export * from './constants';
export { PHYSICAL_KEYS, SENSOR_COLUMNS, layoutBounds, keysFromLayoutStyles } from './layout';
export { buildGenericLayout } from './genericLayout';
export type { GenericLayoutResult } from './genericLayout';
export { classify, hasConfigCollection, hasReceiverCollection } from './classify';
export type { ClassifyResult, HidDeviceLike, RefusalReason } from './classify';
export { PUBLIC_BOARD_NAMES, genericDisplayName } from './genericName';
export {
  connectHid, reconnectGrantedHid, rememberDevice, isAe64, matchesPlatform, identityFromHid,
  webHidAvailable, HidTransport, NoDeviceSelectedError,
} from './hid';
export { STRIP_SIDES, STRIP_ORDER } from './ledLayout';
export { createMockTransport, MockTransport } from './mock';
export { GENERIC_MOCK_NAMES, GenericMockTransport, createGenericMock, devMockNameFromSearch, isGenericMockName } from './mockGeneric';
export type { GenericMockName, GenericMockOptions } from './mockGeneric';
export { modelOf, modelName } from './model';
export type { Ae64Model } from './model';
export { KEYCODE_GROUPS, keycodeLabel, COMBO_MODIFIERS, comboKeycode, decodeCombo, isComboTrigger } from './keycodes';
export type { KeycodeEntry, KeycodeGroup } from './keycodes';
export { BaseTransport, TransportTimeoutError, WriteNotAllowedError, ledCount } from './client';
export { UnsafeCommandError, BLOCKED_KEYCODES } from './safety';
export type { CheckFrameOptions } from './safety';
export { mmToUm, umToMm, isRtMode, supportsIntervalRt } from './codec';

// Compile-time check that this module satisfies the pinned ProtocolModule contract.
const _contract: ProtocolModule = {
  ALLOWED_BOARDS, HID_FILTERS, PHYSICAL_KEYS, connectHid, reconnectGrantedHid, createMockTransport, keycodeLabel, KEYCODE_GROUPS,
};
void _contract;
