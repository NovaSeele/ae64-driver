// Pinned contract (contracts/protocol.ts), copied verbatim. Do not rename or change signatures.
// Distances in this API are MILLIMETRES (number); the codec converts to/from µm on the wire.

import type { GamepadInfo, GamepadUsbState } from './gamepad';

export type Bytes = Uint8Array;

export interface KeyPos { row: number; col: number } // firmware row 1–5, sparse firmware column

export interface PhysicalKey {
  id: number;            // 0..63, stable order: row-major as in foundation.js layout
  uiRow: number;         // 0..4
  row: number;           // firmware row 1..5
  col: number;           // firmware (sensor) column
  x: number; y: number;  // position in key units (from 03 05 or fallback table)
  w: number;             // width in units (1, 1.25, 1.5, 1.75, 2, 2.25, 6.25)
  name: string;          // physical fallback legend ("Esc", "Q", "Space"...)
}

export interface DeviceInfo {
  type: number; subType: number; boardId: number; boardIdHex: string;
  firmware: string; pcb: string; runMode: number; serial: string; timestamp: string;
  /** The 12 UID bytes 17–28 as fixed two-digit hex (lower case): the identity a firmware session compares (`serial` is for display). */
  serialHex: string;
}
export interface ProtocolVersion { main: number; sub: number; hardware: number; software: number }
export interface FeatureBitmap {
  axis: { mechanical: boolean; magnetic: boolean; optical: boolean; inductive: boolean; magnetic3D: boolean };
  connection: { usb: boolean; wireless24: boolean; bluetooth: boolean; usb3: boolean };
  basic: { rgb: boolean; knob: boolean };
  extended: Record<string, boolean>;
  raw: number[];
}

/**
 * 0 standard, 1 Rapid Trigger with Continuous RT (factory driver `RT`), 2 Rapid Trigger without
 * Continuous RT (factory driver `IntervalRT`; protocol ≥ 1.3.0.0). Decoded raw: an unknown value is
 * kept as read so it is never silently rewritten.
 */
export type PerfMode = 0 | 1 | 2;
export interface Performance {
  mode: PerfMode;
  normalPress: number; normalRelease: number;
  rtFirstTouch: number; rtPress: number; rtRelease: number;
  pressDeadStroke: number; releaseDeadStroke: number;   // top / bottom dead zone
  axis: number; calibrate: number; axisV2Id: number; axisRangeMax: number; axisCoefficient: number; // preserved raw
}

export type AxisDataType = 'adc' | 'route' | 'calibration' | 'keyStatus';
export interface AxisRow { type: number; row: number; values: number[] } // 15+ uint16, index = firmware col

export interface LightingBase {
  area: number; open: boolean; openMode: number; mode: number;
  brightness: number; speed: number; direction: number; paletteIndex: number;
}
export interface Rgb { r: number; g: number; b: number }
export interface PaletteEntry extends Rgb { hue: number }
export interface LedRecord extends Rgb { custom: boolean }
export interface LightingAreas { count: number; areas: { modes: number; leds?: number }[]; raw: number[] }

export type AdvancedRecord =
  | { mode: 0; row: number; col: number; type: 'NONE' }
  | { mode: 1; row: number; col: number; type: 'DKS'; keycodes: [number, number, number, number]; travels: [number, number, number, number]; deadzones: [number, number] }
  | { mode: 2; row: number; col: number; type: 'MPT'; keycodes: [number, number, number]; depths: [number, number, number] }
  | { mode: 3; row: number; col: number; type: 'MT'; keycodes: [number, number]; time: number }
  | { mode: 4; row: number; col: number; type: 'TGL'; keycode: number; time: number }
  | { mode: 5; row: number; col: number; type: 'END'; keycodes: [number, number]; delay: number }
  | { mode: 6; row: number; col: number; type: 'SOCD'; pairedRow: number; pairedCol: number; keycodes: [number, number]; delay: number; socdMode: number }
  | { mode: 7; row: number; col: number; type: 'RS'; pairedRow: number; pairedCol: number; keycodes: [number, number]; delay: number }
  | { mode: number; row: number; col: number; type: 'UNKNOWN'; raw: number[] };

export interface MacroMeta { id: number; valid: boolean; actionCount: number; repeatCount: number; mode: number }
export interface MacroAction { down: boolean; delay: number; keycode: number } // delay 1..32767 ms

export const SAVE_GROUP = { ALL: 0, CALIBRATION: 1, PERFORMANCE: 2, LIGHTING: 3, LAYOUT: 4, ADVANCED: 5, MACRO: 6, AXIS: 7 } as const;
export type SaveGroup = typeof SAVE_GROUP[keyof typeof SAVE_GROUP];

export interface TransportStats { lastLatencyMs: number; avgLatencyMs: number; requests: number; timeouts: number }
/** `repeat`/`tEnd`: set on a row that stands for `repeat` consecutive live-travel polls (first at `t`, last at `tEnd`; `bytes` is the first). */
export interface PacketLogEntry { t: number; dir: 'out' | 'in'; bytes: number[]; note?: string; repeat?: number; tEnd?: number }

/** Implemented by HidTransport (WebHID) and MockTransport (demo). Requests are serialised. */
export interface Ae64Transport {
  readonly kind: 'hid' | 'mock';
  readonly connected: boolean;
  readonly productName: string;
  /** USB product ID (0x300d Max, 0x300a Pro); undefined if the transport cannot tell. */
  readonly productId?: number;
  readonly stats: TransportStats;
  onDisconnect(cb: () => void): () => void;
  onPacket(cb: (e: PacketLogEntry) => void): () => void;   // diagnostics log
  /** Allocation-free variant of onPacket: `bytes` is the transport's own buffer, valid only during the call (copy to keep). */
  onPacketRaw(cb: (dir: 'out' | 'in', bytes: Uint8Array, note?: string) => void): () => void;
  /** True from "start calibration" until "stop calibration" was acknowledged; writes are refused meanwhile. */
  readonly calibrationLocked: boolean;
  close(): Promise<void>;
  raw(payload: number[], timeoutMs?: number): Promise<Bytes>; // diagnostics only

  // 01 device
  getProtocolVersion(): Promise<ProtocolVersion>;
  getDeviceInfo(): Promise<DeviceInfo>;
  getFeatures(): Promise<FeatureBitmap>;

  // 02 global
  commit(group: SaveGroup): Promise<void>;
  getProfileCount(): Promise<number>;
  getActiveProfile(): Promise<number>;
  setActiveProfile(index: number): Promise<number>;
  getProfileName(index: number): Promise<string>;
  setProfileName(index: number, name: string): Promise<void>;     // UTF-8, ≤ 32 bytes
  getSystemMode(): Promise<number>; setSystemMode(mode: number): Promise<void>;
  getPollingRates(): Promise<number[]>; getPollingRate(): Promise<number>; setPollingRate(value: number): Promise<void>;
  startCalibration(): Promise<void>; stopCalibration(): Promise<void>;
  getLightingAreas(): Promise<LightingAreas>;
  getRtPrecision(): Promise<number>;               // mm, e.g. 0.001
  getRgbSleep(): Promise<number>; setRgbSleep(minutes: number): Promise<void>;
  getMacroSpace(): Promise<{ count: number; capacity: number }>;
  getShakeOptimization(): Promise<boolean>; setShakeOptimization(on: boolean): Promise<void>;

  // 03 layout
  getLayoutStyle(row: number): Promise<{ y: number; x: number; ratio: number }[]>;
  getKeymapRow(layer: number, row: number): Promise<number[]>;       // keycodes by firmware column
  getKeycode(pos: KeyPos, layer: number): Promise<number>;
  setKeycode(pos: KeyPos, keycode: number, layer: number): Promise<void>;
  getDefaultKeymapRow(system: number, layer: number, row: number): Promise<number[]>;

  // 04 performance
  getPerformance(pos: KeyPos): Promise<Performance>;
  setPerformance(pos: KeyPos, p: Performance): Promise<void>;
  getAxisData(type: AxisDataType, row: number): Promise<AxisRow>;

  // 05 lighting
  getLightingBase(area: number): Promise<LightingBase>;
  setLightingBase(base: LightingBase): Promise<void>;
  getPalette(area: number): Promise<PaletteEntry[]>;                  // 8 entries
  setPalette(area: number, colors: PaletteEntry[]): Promise<void>;
  readLedMatrix(area: number, pages?: readonly number[]): Promise<LedRecord[]>; // area0 6×21=126, area1 38; with pages: only those packets, holes elsewhere
  writeLedMatrix(area: number, leds: LedRecord[]): Promise<void>;

  // 06 advanced
  getAdvanced(pos: KeyPos): Promise<AdvancedRecord>;
  clearAdvanced(pos: KeyPos): Promise<void>;
  setDks(a: { pos: KeyPos; keycodes: number[]; travels: number[]; dbs: [number, number] }): Promise<AdvancedRecord>;
  setMpt(a: { pos: KeyPos; keycodes: number[]; depths: number[] }): Promise<AdvancedRecord>;
  setSocdPair(a: { first: KeyPos; second: KeyPos; keycodes: [number, number]; delay: number; mode: 0 | 1 | 2 | 3 }): Promise<[AdvancedRecord, AdvancedRecord]>;
  setRappySnappyPair(a: { first: KeyPos; second: KeyPos; keycodes: [number, number]; delay: number }): Promise<[AdvancedRecord, AdvancedRecord]>;

  // 07 macro
  getMacroMeta(id: number): Promise<MacroMeta>;
  setMacroMeta(m: MacroMeta): Promise<void>;
  readMacroActions(id: number, count: number): Promise<MacroAction[]>;
  writeMacroActions(id: number, actions: MacroAction[]): Promise<void>;

  // 10 gamepad (AGP1, experimental AE64 Pro XInput firmware; never sent to an AE64 Max, see safety.ts checkGamepadFrame)
  /** INFO; null for stock firmware (`10 FF`) or firmware this app does not know. */
  gamepadInfo(): Promise<GamepadInfo | null>;
  gamepadRead(revision: number, offset: number, count: number): Promise<number[]>;
  gamepadBegin(revision: number, crc: number, token: readonly number[]): Promise<void>;
  gamepadWrite(token: readonly number[], offset: number, chunk: readonly number[]): Promise<void>;
  /** The new revision, or null when the reply does not confirm the commit. */
  gamepadCommit(token: readonly number[], crc: number, revision: number): Promise<{ revision: number; persistent: boolean } | null>;
  gamepadAbort(token: readonly number[]): Promise<void>;
  gamepadUsbStatus(): Promise<GamepadUsbState>;
  gamepadUsbSet(enabled: boolean, revision: number): Promise<GamepadUsbState>;
}

/** src/protocol/index.ts exports (besides types above): */
export interface ProtocolModule {
  ALLOWED_BOARDS: readonly string[];                       // ['0030000d', '0030000a']
  HID_FILTERS: readonly HIDDeviceFilter[];                 // VID 0x1ca6, PID 0x300d and 0x300a, usagePage 0xffb0 usage 1
  PHYSICAL_KEYS: readonly PhysicalKey[];                   // fallback 64-key table
  connectHid(): Promise<Ae64Transport>;                    // requestDevice + open; throws readable errors
  reconnectGrantedHid(): Promise<Ae64Transport | null>;    // navigator.hid.getDevices() for auto-reconnect
  createMockTransport(opts?: { seed?: 'max' | 'pro' | 'pro-xinput' }): Ae64Transport; // demo, seeded from device-snapshot.md
  keycodeLabel(code: number): { label: string; group: string; long?: string };
  KEYCODE_GROUPS: readonly { id: string; label: string; codes: { code: number; label: string; long?: string }[] }[];
}
