// Wire-level constants for the AE64 vendor HID protocol (reference docs/AE64_PROTOCOL.md).

export const REPORT_ID = 0;
export const REPORT_LENGTH = 64;
export const REQUEST_TIMEOUT_MS = 1500;

export const VENDOR_ID = 0x1ca6;
export const PRODUCT_ID_MAX = 0x300d;
export const PRODUCT_ID_PRO = 0x300a;
export const CONFIG_USAGE_PAGE = 0xffb0;
export const CONFIG_USAGE = 0x01;

/** Board IDs (lower-case hex, as decoded from 01 02) that may receive writes. */
export const ALLOWED_BOARDS: readonly string[] = Object.freeze(['0030000d', '0030000a']);

export const HID_FILTERS: readonly HIDDeviceFilter[] = Object.freeze([
  { vendorId: VENDOR_ID, productId: PRODUCT_ID_MAX, usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE },
  { vendorId: VENDOR_ID, productId: PRODUCT_ID_PRO, usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE },
]);

/**
 * The vendor collection without a product ID (DESIGN FW §3.6): the bootloader's product ID is not known. Matches every AE64 in app
 * mode too, so a device found through it only ever gets `01 02` until its run mode and board are known. Never FF80 (the wireless
 * dongle). Only the firmware page and the connect screen's probe use it; HID_FILTERS stays the normal path.
 */
export const FW_PROBE_FILTER: Readonly<HIDDeviceFilter> = Object.freeze({ vendorId: VENDOR_ID, usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE });

/** Command families. Family 08 (firmware upgrade) is deliberately absent and refused by the transport. */
export const FAMILY = Object.freeze({
  DEVICE: 0x01,
  GLOBAL: 0x02,
  LAYOUT: 0x03,
  PERFORMANCE: 0x04,
  LIGHTING: 0x05,
  ADVANCED: 0x06,
  MACRO: 0x07,
});
export const FIRMWARE_FAMILY = 0x08;

export const AXIS_DATA_TYPE = Object.freeze({ adc: 0, route: 1, calibration: 2, keyStatus: 3 });

/** SOCD UI mode → (localModeA, localModeB) reciprocal mode bytes. */
export const SOCD_PAIR_MODES: readonly (readonly [number, number])[] = [[0, 0], [1, 2], [2, 1], [3, 3]];

export const LAYER_COUNT = 4;
export const FIRMWARE_ROWS = [1, 2, 3, 4, 5] as const;

/** Keyboard LED address space (area 0) is 6 × 21; the strip (area 1) is 1 × 38. */
export const LED_MATRIX_ROWS = 6;
export const LED_MATRIX_COLS = 21;
export const LED_STRIP_COUNT = 38;
export const LED_RECORDS_PER_PACKET = 15;
export const PALETTE_SIZE = 8;

export const MACRO_ACTIONS_PER_PAGE = 15;
export const MACRO_MAX_DELAY_MS = 32767;
export const MACRO_SLOTS = 16;

/** 03 05 ratio code → key width in units (codes measured on the Max). */
export const RATIO_UNITS: Readonly<Record<number, number>> = Object.freeze({
  1: 1, 2: 1.25, 3: 1.5, 4: 1.75, 5: 2, 6: 2.25, 9: 6.25,
});

/** Polling-rate enum is reverse ordered: 0 = 8000 Hz … 5 = 250 Hz. */
export const POLLING_RATE_HZ: Readonly<Record<number, number>> = Object.freeze({
  0: 8000, 1: 4000, 2: 2000, 3: 1000, 4: 500, 5: 250,
});
