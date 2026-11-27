// Read-only keyboard info export (DESIGN MKB §13) and refused-connect USB facts formatter (§5.4).
// Safety: sends ONLY typed read commands from the §13 list inside `withTransport(..., { exclusive: true })`,
// never uses `raw()`, never sends any write, drops serial bytes 17–28 of `01 02` before storing anything,
// never reads profile names (`02 03 03`), macros (`07 xx`) or LED colours (`05 03`), and makes no network call.

import {
  FIRMWARE_ROWS, GENERIC_ROWS, LAYER_COUNT, LED_MATRIX_COLS,
} from '../protocol';
import type {
  AdvancedRecord, DeviceInfo, FeatureBitmap, LightingAreas, LightingBase,
  PaletteEntry, Performance, ProtocolVersion, SupportLevel, TransportIdentity,
} from '../protocol';
import { encodeLayoutStyleEntry } from '../protocol/codec';
import type { LayoutStyleEntry } from '../protocol/codec';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from '../stores/device';
import type { ConnectRefusal } from '../stores/device';
import { useLiveStore } from '../stores/live';

export const KEYBOARD_EXPORT_SCHEMA = 'mkb-export/1' as const;
export const GITHUB_KEYBOARD_INFO_ISSUE_URL = 'https://github.com/NovaSeele/ae64-driver/issues/new?template=keyboard-info.yml';

export interface SerializedCollection {
  usagePage: number;
  usagePageHex: string;
  usage: number;
  usageHex: string;
  inputReports: number[];
  outputReports: number[];
}

export interface SerializedIdentity {
  vendorId: number;
  vendorIdHex: string;
  productId: number;
  productIdHex: string;
  productName: string;
  collections: SerializedCollection[];
}

export type SafeDeviceInfo = Omit<DeviceInfo, 'serial' | 'serialHex'>;

export interface ExportRead<T> {
  hex: string;
  value: T;
}

export interface ExportLayoutStyleRow {
  row: number;
  hex: string;
  entriesHex: string[];
  entries: LayoutStyleEntry[];
  hasPadding: boolean;
}

export interface ExportDefaultKeymapRow {
  system: number;
  layer: number;
  row: number;
  hex: string;
  codes: number[];
}

export interface ExportKeymapRow {
  row: number;
  hex: string;
  codes: number[];
}

export interface ExportKeyRecord<T> {
  row: number;
  col: number;
  hex: string;
  value: T;
}

export interface ExportLightingArea {
  area: number;
  base: ExportRead<LightingBase>;
  palette?: ExportRead<PaletteEntry[]>;
}

export interface KeyboardExportReads {
  deviceInfo?: ExportRead<SafeDeviceInfo>;
  protocolVersion?: ExportRead<ProtocolVersion>;
  features?: ExportRead<FeatureBitmap>;
  profileStart?: ExportRead<number>;
  profileCount?: ExportRead<number>;
  systemMode?: ExportRead<number>;
  pollingRates?: ExportRead<number[]>;
  pollingRate?: ExportRead<number>;
  lightingAreas?: ExportRead<LightingAreas>;
  rtPrecision?: ExportRead<number>;
  macroSpace?: ExportRead<{ count: number; capacity: number }>;
  rgbSleep?: ExportRead<number>;
  shakeOptimization?: ExportRead<boolean>;
  layoutStyle: ExportLayoutStyleRow[];
  defaultKeymap: ExportDefaultKeymapRow[];
  layer0: ExportKeymapRow[];
  performance: ExportKeyRecord<Performance>[];
  advanced: ExportKeyRecord<AdvancedRecord>[];
  lighting: ExportLightingArea[];
  profileEnd?: ExportRead<number>;
}

export interface KeyboardExportPayload {
  schema: typeof KEYBOARD_EXPORT_SCHEMA;
  appVersion: string;
  exportedAt: string;
  name: string;
  support: SupportLevel | null;
  rows: number[];
  identity: SerializedIdentity;
  layoutPadding: number[];
  profileChanged: boolean;
  pressedCells: { row: number; col: number }[];
  reads: KeyboardExportReads;
  stoppedAt?: string;
  error?: string;
}

export interface KeyboardExportResult {
  payload: KeyboardExportPayload;
  fileName: string;
  json: string;
}

const pad2 = (n: number): string => String(n).padStart(2, '0');
const hex2 = (b: number): string => (b & 0xff).toString(16).padStart(2, '0');
const hex4 = (n: number): string => (n & 0xffff).toString(16).toUpperCase().padStart(4, '0');
const bytesToHex = (bytes: ArrayLike<number>): string => Array.from(bytes, hex2).join(' ');

/** Zeroes bytes 17–28 (12-byte serial) of a `01 02` reply copy before anything is stored (DESIGN §13 item 2). */
function sanitizeReplyBytes(bytes: Uint8Array): Uint8Array {
  const copy = Uint8Array.from(bytes);
  if (copy[0] === 0x01 && copy[1] === 0x02 && copy.length >= 29) {
    copy.fill(0, 17, 29);
  }
  return copy;
}

/** Keeps only non-serial fields of `DeviceInfo` (never `serial` or `serialHex`). */
function stripSerial(info: DeviceInfo): SafeDeviceInfo {
  return {
    type: info.type,
    subType: info.subType,
    boardId: info.boardId,
    boardIdHex: info.boardIdHex,
    firmware: info.firmware,
    pcb: info.pcb,
    runMode: info.runMode,
    timestamp: info.timestamp,
  };
}

function serializeIdentity(id: TransportIdentity): SerializedIdentity {
  return {
    vendorId: id.vendorId,
    vendorIdHex: hex4(id.vendorId),
    productId: id.productId,
    productIdHex: hex4(id.productId),
    productName: id.productName,
    collections: id.collections.map((c) => ({
      usagePage: c.usagePage,
      usagePageHex: hex4(c.usagePage),
      usage: c.usage,
      usageHex: hex4(c.usage),
      inputReports: [...c.inputReports],
      outputReports: [...c.outputReports],
    })),
  };
}

/** `ae64control-keyboard-<board>-<YYYYMMDD-HHMM>.json` (DESIGN §13). */
export function keyboardExportFileName(boardIdHex: string | null | undefined, now = new Date()): string {
  const board = (boardIdHex || 'unknown').toLowerCase().replace(/[^0-9a-z_-]/g, '') || 'unknown';
  const date = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `ae64control-keyboard-${board}-${date}-${time}.json`;
}

/** Saves the exported JSON as a local browser download (no network call). */
export function downloadKeyboardExport(fileName: string, json: string): void {
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

/** Formats the USB facts of a refused connect for "Sao chép thông tin thiết bị" (DESIGN §5.4). Sends 0 HID commands. */
export function formatRefusalInfo(refusal: ConnectRefusal): string {
  const { identity, reason, version } = refusal;
  const cols = identity.collections.length
    ? identity.collections
        .map((c) => `0x${hex4(c.usagePage)}:0x${hex4(c.usage)} (in:[${c.inputReports.join(',')}] out:[${c.outputReports.join(',')}])`)
        .join(', ')
    : '—';
  const lines = [
    `VID: 0x${hex4(identity.vendorId)}`,
    `PID: 0x${hex4(identity.productId)}`,
    `Product: ${identity.productName || '—'}`,
    `Collections: ${cols}`,
    `Reason: ${reason}`,
  ];
  if (version) {
    lines.push(`Protocol: ${version.main}.${version.sub}.${version.hardware}.${version.software}`);
  }
  return lines.join('\n');
}

/**
 * Runs the read-only §13 keyboard export inside `device.withTransport(..., { exclusive: true })`.
 * Stops at the first timeout, disconnect or guard error, returning the partial file with `stoppedAt` and `error`.
 */
export async function exportKeyboardInfo(opts: { now?: Date } = {}): Promise<KeyboardExportResult> {
  const device = useDeviceStore();
  const live = useLiveStore();
  const now = opts.now ?? new Date();

  return device.withTransport(async (t) => {
    const support = device.support ?? t.support ?? null;
    const name = device.displayName;
    const exportRows = [...device.rows];
    const exportKeys = device.keys.map((k) => ({ id: k.id, row: k.row, col: k.col }));
    const identity = serializeIdentity(t.identity);
    const fallbackBoard = device.info?.boardIdHex;

    // Item 13 (no command): (row, col) cells seen pressed in Key test during this connection.
    const keyById = new Map(exportKeys.map((k) => [k.id, k]));
    const pressedCells = [...live.data.pressedIds]
      .map((id) => keyById.get(id))
      .filter((k): k is { id: number; row: number; col: number } => k !== undefined)
      .map((k) => ({ row: k.row, col: k.col }))
      .sort((a, b) => a.row - b.row || a.col - b.col);

    const reads: KeyboardExportReads = {
      layoutStyle: [],
      defaultKeymap: [],
      layer0: [],
      performance: [],
      advanced: [],
      lighting: [],
    };
    const layoutPadding: number[] = [];
    let profileChanged = false;
    let stoppedAt: string | undefined;
    let error: string | undefined;

    let waitingReply = false;
    let lastReplyHex = '';
    const off = t.onPacketRaw((dir, bytes) => {
      if (dir === 'out') {
        waitingReply = true;
        lastReplyHex = '';
      } else if (dir === 'in' && waitingReply && bytes.length > 0) {
        lastReplyHex = bytesToHex(sanitizeReplyBytes(bytes));
        waitingReply = false;
      }
    });

    let currentCmd = '';
    async function step<T>(cmd: readonly number[], fn: () => Promise<T>): Promise<ExportRead<T>> {
      currentCmd = bytesToHex(cmd);
      waitingReply = false;
      lastReplyHex = '';
      const value = await fn();
      return { hex: lastReplyHex, value };
    }

    try {
      // #2: 01 02 (serial bytes dropped before storing; never changes boardAllowed)
      const di = await step([0x01, 0x02], () => t.getDeviceInfo());
      reads.deviceInfo = { hex: di.hex, value: stripSerial(di.value) };

      // #3: 01 01, 01 03
      reads.protocolVersion = await step([0x01, 0x01], () => t.getProtocolVersion());
      reads.features = await step([0x01, 0x03], () => t.getFeatures());

      // #4: 02 03 01 (start), 02 03 00, 02 04 01, 02 05 00, 02 05 01
      reads.profileStart = await step([0x02, 0x03, 0x01], () => t.getActiveProfile());
      reads.profileCount = await step([0x02, 0x03, 0x00], () => t.getProfileCount());
      reads.systemMode = await step([0x02, 0x04, 0x01], () => t.getSystemMode());
      reads.pollingRates = await step([0x02, 0x05, 0x00], () => t.getPollingRates());
      reads.pollingRate = await step([0x02, 0x05, 0x01], () => t.getPollingRate());

      // #5: 02 08 00, 02 0C 00, 02 0E 00, 02 0D 01, 02 10 01
      reads.lightingAreas = await step([0x02, 0x08, 0x00], () => t.getLightingAreas());
      reads.rtPrecision = await step([0x02, 0x0c, 0x00], () => t.getRtPrecision());
      reads.macroSpace = await step([0x02, 0x0e, 0x00], () => t.getMacroSpace());
      reads.rgbSleep = await step([0x02, 0x0d, 0x01], () => t.getRgbSleep());
      reads.shakeOptimization = await step([0x02, 0x10, 0x01], () => t.getShakeOptimization());

      // #6: 03 05 r (rows 1–5 on AE64 kinds, 0–5 on generic; all 30 entries in hex; entries 21–29 flagged)
      const layoutRows = support === 'generic' ? GENERIC_ROWS : FIRMWARE_ROWS;
      for (const r of layoutRows) {
        const res = await step([0x03, 0x05, r], () => t.getLayoutStyle(r));
        const entriesHex = res.value.map((e) => encodeLayoutStyleEntry(e).toString(16).padStart(4, '0'));
        const hasPadding = res.value.slice(LED_MATRIX_COLS).some((e) => e.x !== 0 || e.y !== 0 || e.ratio !== 0);
        if (hasPadding) layoutPadding.push(r);
        reads.layoutStyle.push({ row: r, hex: res.hex, entriesHex, entries: res.value, hasPadding });
      }

      // #7: 03 06 (system<<4 | layer) r, current system, layers 0–3, rows of device.rows
      const sys = reads.systemMode.value;
      for (let layer = 0; layer < LAYER_COUNT; layer++) {
        for (const r of exportRows) {
          const res = await step(
            [0x03, 0x06, ((sys & 15) << 4) | (layer & 15), r],
            () => t.getDefaultKeymapRow(sys, layer, r),
          );
          reads.defaultKeymap.push({ system: sys, layer, row: r, hex: res.hex, codes: res.value });
        }
      }

      // #8: 03 01 0 r, rows of device.rows
      for (const r of exportRows) {
        const res = await step([0x03, 0x01, 0x00, r], () => t.getKeymapRow(0, r));
        reads.layer0.push({ row: r, hex: res.hex, codes: res.value });
      }

      // #9: 04 01 r c for every key in the layout
      for (const key of exportKeys) {
        const res = await step([0x04, 0x01, key.row, key.col], () => t.getPerformance({ row: key.row, col: key.col }));
        reads.performance.push({ row: key.row, col: key.col, hex: res.hex, value: res.value });
      }

      // #10: 06 01 r c 00 for every key
      for (const key of exportKeys) {
        const res = await step([0x06, 0x01, key.row, key.col, 0x00], () => t.getAdvanced({ row: key.row, col: key.col }));
        reads.advanced.push({ row: key.row, col: key.col, hex: res.hex, value: res.value });
      }

      // #11: 05 01 a 00, 05 01 a 01 for each area a < min(listed areas, 2)
      const areaCount = Math.min(reads.lightingAreas.value.areas.length, 2);
      for (let a = 0; a < areaCount; a++) {
        const base = await step([0x05, 0x01, a, 0x00], () => t.getLightingBase(a));
        const areaEntry: ExportLightingArea = { area: a, base };
        reads.lighting.push(areaEntry);
        areaEntry.palette = await step([0x05, 0x01, a, 0x01], () => t.getPalette(a));
      }

      // #12: 02 03 01 (end)
      reads.profileEnd = await step([0x02, 0x03, 0x01], () => t.getActiveProfile());
      profileChanged = reads.profileEnd.value !== reads.profileStart.value;
    } catch (err) {
      stoppedAt = currentCmd;
      error = err instanceof Error ? err.message : String(err);
    } finally {
      off();
    }

    const payload: KeyboardExportPayload = {
      schema: KEYBOARD_EXPORT_SCHEMA,
      appVersion: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
      exportedAt: now.toISOString(),
      name,
      support,
      rows: exportRows,
      identity,
      layoutPadding,
      profileChanged,
      pressedCells,
      reads,
      ...(stoppedAt !== undefined ? { stoppedAt, error } : {}),
    };

    const fileName = keyboardExportFileName(reads.deviceInfo?.value.boardIdHex ?? fallbackBoard, now);
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    return { payload, fileName, json };
  }, { exclusive: true, what: tr('mkb.export.what') });
}
