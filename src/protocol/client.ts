// Shared implementation of the Ae64Transport API on top of a single `exchange(frame)` primitive.
// HidTransport (WebHID) and MockTransport (byte-level device emulator) only implement `exchange`,
// so every request — demo or real — goes through the same codecs, queue, safety checks and stats.

import type {
  AdvancedRecord, Ae64Transport, AxisDataType, AxisRow, Bytes, DeviceInfo, FeatureBitmap, KeyPos,
  LedRecord, LightingAreas, LightingBase, MacroAction, MacroMeta, PacketLogEntry, PaletteEntry,
  Performance, ProtocolVersion, SaveGroup, TransportStats,
} from './types';
import {
  ALLOWED_BOARDS, AXIS_DATA_TYPE, FAMILY, FIRMWARE_FAMILY, LED_MATRIX_COLS, LED_MATRIX_ROWS,
  LED_RECORDS_PER_PACKET, LED_STRIP_COUNT, REPORT_LENGTH, REQUEST_TIMEOUT_MS,
} from './constants';
import * as c from './codec';
import { checkFrame, checkPerformanceWrite, isWriteCommand, UnsafeCommandError } from './safety';
import { t } from '../i18n/vi';

export class TransportTimeoutError extends Error {
  constructor(command: number[]) {
    super(t('error.transportTimeout', { cmd: command.slice(0, 2).map((b) => b.toString(16).padStart(2, '0')).join(':') }));
    this.name = 'TransportTimeoutError';
  }
}

export class WriteNotAllowedError extends Error {
  constructor() {
    super(t('error.boardNotAllowed'));
    this.name = 'WriteNotAllowedError';
  }
}

/** Zero-padded 64-byte report. Rejects firmware-family packets and anything not on the safety allow-list. */
export function frameOf(payload: number[]): Uint8Array {
  if (payload[0] === FIRMWARE_FAMILY) throw new Error(t('error.firmwareBlocked'));
  checkFrame(payload);
  if (payload.length > REPORT_LENGTH) throw new RangeError(t('error.hidLength', { max: REPORT_LENGTH }));
  const frame = new Uint8Array(REPORT_LENGTH);
  payload.forEach((b, i) => { frame[i] = c.byte(b, `byte ${i}`); });
  return frame;
}

/** Number of LED records for a lighting area: keyboard matrix 6×21, strip 38. */
export function ledCount(area: number): number {
  return area === 0 ? LED_MATRIX_ROWS * LED_MATRIX_COLS : LED_STRIP_COUNT;
}

/**
 * Request parameters the firmware echoes back at the same offsets (the decoders read data after them).
 * A reply only answers a request when these bytes match too, so a late reply to an earlier read
 * (e.g. Q's performance record after Q timed out) is never taken as the answer for another key.
 */
const ECHOED: readonly { prefix: readonly [number, number]; at: readonly number[] }[] = [
  { prefix: [0x03, 0x01], at: [2, 3] }, // layer, row
  { prefix: [0x03, 0x03], at: [2, 3, 4] }, // layer, row, col
  { prefix: [0x04, 0x01], at: [2, 3] }, // row, col
  { prefix: [0x04, 0x03], at: [2, 3] }, // axis data type, row
  { prefix: [0x05, 0x01], at: [2, 3] }, // area, kind
  { prefix: [0x05, 0x03], at: [2, 3] }, // area, LED page
  { prefix: [0x06, 0x01], at: [2, 3] }, // row, col
  { prefix: [0x07, 0x01], at: [2] }, // macro id
  { prefix: [0x07, 0x03], at: [2, 3] }, // macro id, page
];

/** True when `reply` answers `request`: same family/command and, for the reads above, the same echoed parameters. */
export function replyMatches(request: ArrayLike<number>, reply: ArrayLike<number>): boolean {
  if (reply[0] !== request[0] || reply[1] !== request[1]) return false;
  const rule = ECHOED.find((r) => r.prefix[0] === request[0] && r.prefix[1] === request[1]);
  return !rule || rule.at.every((i) => reply[i] === request[i]);
}

/** 02 06 00 (enter) / 02 06 01 (leave calibration): the only writes allowed while calibration is locked. */
const isCalibrationControl = (p: readonly number[]): boolean => p[0] === FAMILY.GLOBAL && p[1] === 0x06 && (p[2] === 0x00 || p[2] === 0x01);

export abstract class BaseTransport implements Ae64Transport {
  abstract readonly kind: 'hid' | 'mock';
  abstract readonly productName: string;
  abstract get connected(): boolean;

  readonly stats: TransportStats = { lastLatencyMs: 0, avgLatencyMs: 0, requests: 0, timeouts: 0 };
  /** Set by getDeviceInfo(): writes are refused until the board ID is in ALLOWED_BOARDS. */
  boardAllowed = false;
  /**
   * True from the moment `02 06 00` is sent until `02 06 01` was acknowledged: while the keyboard is in
   * calibration mode every write except "stop calibration" is refused (history shortcuts, profile switch,
   * sync retries, restores…), whichever store sends it.
   */
  private calibrationLock = false;

  private queue: Promise<unknown> = Promise.resolve();
  private readonly disconnectListeners = new Set<() => void>();
  private readonly packetListeners = new Set<(e: PacketLogEntry) => void>();

  /** Send one frame and resolve with the reply whose bytes 0–1 match; reject with TransportTimeoutError on timeout. */
  protected abstract exchange(frame: Uint8Array, timeoutMs: number): Promise<Bytes>;
  abstract close(): Promise<void>;

  onDisconnect(cb: () => void): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  onPacket(cb: (e: PacketLogEntry) => void): () => void {
    this.packetListeners.add(cb);
    return () => this.packetListeners.delete(cb);
  }

  protected emitDisconnect(): void {
    for (const cb of [...this.disconnectListeners]) cb();
  }

  private log(dir: 'out' | 'in', bytes: Uint8Array, note?: string): void {
    if (!this.packetListeners.size) return;
    const entry: PacketLogEntry = { t: Date.now(), dir, bytes: Array.from(bytes), note };
    for (const cb of this.packetListeners) cb(entry);
  }

  /** Serialised request: one in flight at a time, replies matched on bytes 0–1. */
  protected request(payload: number[], timeoutMs = REQUEST_TIMEOUT_MS): Promise<Bytes> {
    const run = async (): Promise<Bytes> => {
      if (!this.connected) throw new Error(t('error.notConnected'));
      if (!this.boardAllowed && isWriteCommand(payload)) throw new WriteNotAllowedError();
      if (this.calibrationLock && isWriteCommand(payload) && !isCalibrationControl(payload)) {
        throw new UnsafeCommandError(payload, 'the keyboard is calibrating; only "stop calibration" may be sent');
      }
      const frame = frameOf(payload);
      this.log('out', frame);
      const t0 = performance.now();
      let reply: Bytes;
      try {
        reply = await this.exchange(frame, timeoutMs);
      } catch (err) {
        if (err instanceof TransportTimeoutError) this.stats.timeouts++;
        this.log('in', new Uint8Array(0), err instanceof Error ? err.message : String(err));
        throw err;
      }
      const ms = performance.now() - t0;
      const s = this.stats;
      s.requests++;
      s.lastLatencyMs = ms;
      s.avgLatencyMs = s.requests === 1 ? ms : s.avgLatencyMs * 0.95 + ms * 0.05;
      this.log('in', reply);
      return reply;
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private write(payload: number[]): Promise<Bytes> {
    if (!this.boardAllowed) return Promise.reject(new WriteNotAllowedError());
    return this.request(payload);
  }

  /** Diagnostics only. Family 08 is always refused; on a non-allowed board only family 01 reads pass. */
  raw(payload: number[], timeoutMs?: number): Promise<Bytes> {
    if (!this.boardAllowed && payload[0] !== FAMILY.DEVICE) return Promise.reject(new WriteNotAllowedError());
    try {
      checkFrame(payload, { readOnly: true });
    } catch (err) {
      return Promise.reject(err);
    }
    return this.request(payload, timeoutMs);
  }

  // ------------------------------------------------------------------ 01 device

  /** Last protocol version read on this connection; gates performance mode 2 in the write guard. */
  private protocol: ProtocolVersion | null = null;

  async getProtocolVersion(): Promise<ProtocolVersion> {
    this.protocol = c.decodeProtocolVersion(await this.request([FAMILY.DEVICE, 0x01]));
    return this.protocol;
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const info = c.decodeDeviceInfo(await this.request([FAMILY.DEVICE, 0x02]));
    this.boardAllowed = ALLOWED_BOARDS.includes(info.boardIdHex);
    return info;
  }

  async getFeatures(): Promise<FeatureBitmap> {
    return c.decodeFeatures(await this.request([FAMILY.DEVICE, 0x03]));
  }

  // ------------------------------------------------------------------ 02 global

  async commit(group: SaveGroup): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x02, group]);
  }

  async getProfileCount(): Promise<number> {
    return (await this.request([FAMILY.GLOBAL, 0x03, 0x00]))[3];
  }

  async getActiveProfile(): Promise<number> {
    return (await this.request([FAMILY.GLOBAL, 0x03, 0x01]))[3];
  }

  async setActiveProfile(index: number): Promise<number> {
    return (await this.write([FAMILY.GLOBAL, 0x03, 0x02, index]))[3];
  }

  async getProfileName(index: number): Promise<string> {
    return c.decodeProfileName(await this.request([FAMILY.GLOBAL, 0x03, 0x03, index]));
  }

  async setProfileName(index: number, name: string): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x03, 0x04, index, ...c.encodeProfileName(name)]);
  }

  async getSystemMode(): Promise<number> {
    return (await this.request([FAMILY.GLOBAL, 0x04, 0x01]))[3];
  }

  async setSystemMode(mode: number): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x04, 0x02, mode]);
  }

  async getPollingRates(): Promise<number[]> {
    return c.decodeByteList(await this.request([FAMILY.GLOBAL, 0x05, 0x00]));
  }

  async getPollingRate(): Promise<number> {
    return (await this.request([FAMILY.GLOBAL, 0x05, 0x01]))[3];
  }

  async setPollingRate(value: number): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x05, 0x02, value]);
  }

  async startCalibration(): Promise<void> {
    // Locked before sending: if the reply is lost the keyboard may still have entered calibration.
    this.calibrationLock = true;
    await this.write([FAMILY.GLOBAL, 0x06, 0x00]);
  }

  /** Stays locked if this fails: the keyboard may still be calibrating (reconnecting clears it). */
  async stopCalibration(): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x06, 0x01]);
    this.calibrationLock = false;
  }

  get calibrationLocked(): boolean {
    return this.calibrationLock;
  }

  async getLightingAreas(): Promise<LightingAreas> {
    return c.decodeLightingAreas(await this.request([FAMILY.GLOBAL, 0x08, 0x00]));
  }

  async getRtPrecision(): Promise<number> {
    return (await this.request([FAMILY.GLOBAL, 0x0c, 0x00]))[3] / 1000;
  }

  async getRgbSleep(): Promise<number> {
    return c.read16(await this.request([FAMILY.GLOBAL, 0x0d, 0x01]), 3);
  }

  async setRgbSleep(minutes: number): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x0d, 0x00, ...c.le16(minutes, 'minutes')]);
  }

  async getMacroSpace(): Promise<{ count: number; capacity: number }> {
    const d = await this.request([FAMILY.GLOBAL, 0x0e, 0x00]);
    return { count: d[3], capacity: c.read16(d, 4) };
  }

  async getShakeOptimization(): Promise<boolean> {
    return (await this.request([FAMILY.GLOBAL, 0x10, 0x01]))[3] === 1;
  }

  async setShakeOptimization(on: boolean): Promise<void> {
    await this.write([FAMILY.GLOBAL, 0x10, 0x00, on ? 1 : 0]);
  }

  // ------------------------------------------------------------------ 03 layout

  async getLayoutStyle(row: number): Promise<{ y: number; x: number; ratio: number }[]> {
    return c.decodeLayoutStyle(await this.request([FAMILY.LAYOUT, 0x05, row]));
  }

  async getKeymapRow(layer: number, row: number): Promise<number[]> {
    return c.decodeKeycodeRow(await this.request([FAMILY.LAYOUT, 0x01, layer, row]));
  }

  async getKeycode(pos: KeyPos, layer: number): Promise<number> {
    return c.read16(await this.request([FAMILY.LAYOUT, 0x03, layer, pos.row, pos.col]), 5);
  }

  async setKeycode(pos: KeyPos, keycode: number, layer: number): Promise<void> {
    await this.write([FAMILY.LAYOUT, 0x04, layer, pos.row, pos.col, ...c.le16(keycode, 'keycode')]);
  }

  async getDefaultKeymapRow(system: number, layer: number, row: number): Promise<number[]> {
    return c.decodeKeycodeRow(await this.request([FAMILY.LAYOUT, 0x06, ((system & 15) << 4) | (layer & 15), row]));
  }

  // ------------------------------------------------------------------ 04 performance

  /** Performance records read from each key during this connection (newest last), for the write guard. */
  private readonly perfSeen = new Map<string, Performance[]>();

  async getPerformance(pos: KeyPos): Promise<Performance> {
    const d = await this.request([FAMILY.PERFORMANCE, 0x01, pos.row, pos.col]);
    // Never record another key's sensor fields as this key's (they feed the write guard below).
    if (d[2] !== pos.row || d[3] !== pos.col) throw new Error(`performance reply for ${d[2]},${d[3]} does not match key ${pos.row},${pos.col}`);
    const p = c.decodePerformance(d);
    const k = `${pos.row}:${pos.col}`;
    const seen = this.perfSeen.get(k) ?? [];
    seen.push({ ...p });
    if (seen.length > 8) seen.splice(0, seen.length - 8);
    this.perfSeen.set(k, seen);
    return p;
  }

  /** Refused unless the key was read first and the sensor fields stay as the device reported them. */
  async setPerformance(pos: KeyPos, p: Performance): Promise<void> {
    const payload = c.encodePerformance(pos, p);
    const why = checkPerformanceWrite(p, this.perfSeen.get(`${pos.row}:${pos.col}`) ?? [], {
      intervalRt: c.supportsIntervalRt(this.protocol),
    });
    if (why) throw new UnsafeCommandError(payload, why);
    await this.write(payload);
  }

  async getAxisData(type: AxisDataType, row: number): Promise<AxisRow> {
    const r = c.decodeAxisRow(await this.request([FAMILY.PERFORMANCE, 0x03, AXIS_DATA_TYPE[type], row]));
    // A stray reply for another matrix or row must never be shown (or calibrated against) as this one.
    if (r.type !== AXIS_DATA_TYPE[type] || r.row !== row) {
      throw new Error(`axis data reply for type ${r.type} row ${r.row}, expected type ${AXIS_DATA_TYPE[type]} row ${row}`);
    }
    return r;
  }

  // ------------------------------------------------------------------ 05 lighting

  async getLightingBase(area: number): Promise<LightingBase> {
    return c.decodeLightingBase(await this.request([FAMILY.LIGHTING, 0x01, area, 0x00]));
  }

  async setLightingBase(base: LightingBase): Promise<void> {
    await this.write(c.encodeLightingBase(base));
  }

  async getPalette(area: number): Promise<PaletteEntry[]> {
    return c.decodePalette(await this.request([FAMILY.LIGHTING, 0x01, area, 0x01]));
  }

  async setPalette(area: number, colors: PaletteEntry[]): Promise<void> {
    await this.write(c.encodePalette(area, colors));
  }

  async readLedMatrix(area: number): Promise<LedRecord[]> {
    const n = ledCount(area);
    const out: LedRecord[] = [];
    for (let p = 0; p * LED_RECORDS_PER_PACKET < n; p++) {
      out.push(...c.decodeColors(await this.request([FAMILY.LIGHTING, 0x03, area, p])));
    }
    return out.slice(0, n);
  }

  async writeLedMatrix(area: number, leds: LedRecord[]): Promise<void> {
    const n = ledCount(area);
    for (let p = 0; p * LED_RECORDS_PER_PACKET < n; p++) {
      const slice = leds.slice(p * LED_RECORDS_PER_PACKET, Math.min(n, (p + 1) * LED_RECORDS_PER_PACKET));
      await this.write([FAMILY.LIGHTING, 0x04, area, p, ...c.encodeColors(slice)]);
    }
  }

  // ------------------------------------------------------------------ 06 advanced

  async getAdvanced(pos: KeyPos): Promise<AdvancedRecord> {
    return c.decodeAdvanced(await this.request([FAMILY.ADVANCED, 0x01, pos.row, pos.col, 0x00]));
  }

  async clearAdvanced(pos: KeyPos): Promise<void> {
    await this.write(c.encodeClearAdvanced(pos));
  }

  async setDks(a: { pos: KeyPos; keycodes: number[]; travels: number[]; dbs: [number, number] }): Promise<AdvancedRecord> {
    return c.decodeAdvanced(await this.write(c.encodeDks(a)));
  }

  async setMpt(a: { pos: KeyPos; keycodes: number[]; depths: number[] }): Promise<AdvancedRecord> {
    return c.decodeAdvanced(await this.write(c.encodeMpt(a)));
  }

  async setSocdPair(a: { first: KeyPos; second: KeyPos; keycodes: [number, number]; delay: number; mode: 0 | 1 | 2 | 3 }): Promise<[AdvancedRecord, AdvancedRecord]> {
    const [p1, p2] = c.encodeSocdPair(a);
    const r1 = c.decodeAdvanced(await this.write(p1));
    const r2 = c.decodeAdvanced(await this.write(p2));
    return [r1, r2];
  }

  async setRappySnappyPair(a: { first: KeyPos; second: KeyPos; keycodes: [number, number]; delay: number }): Promise<[AdvancedRecord, AdvancedRecord]> {
    const [p1, p2] = c.encodeRappySnappyPair(a);
    const r1 = c.decodeAdvanced(await this.write(p1));
    const r2 = c.decodeAdvanced(await this.write(p2));
    return [r1, r2];
  }

  // ------------------------------------------------------------------ 07 macro

  async getMacroMeta(id: number): Promise<MacroMeta> {
    return c.decodeMacroMeta(await this.request([FAMILY.MACRO, 0x01, id]));
  }

  async setMacroMeta(m: MacroMeta): Promise<void> {
    await this.write(c.encodeMacroMeta(m));
  }

  async readMacroActions(id: number, count: number): Promise<MacroAction[]> {
    const out: MacroAction[] = [];
    for (let p = 0; p < c.macroPageCount(count); p++) {
      out.push(...c.decodeMacroPage(await this.request([FAMILY.MACRO, 0x03, id, p])));
    }
    return out.slice(0, count);
  }

  async writeMacroActions(id: number, actions: MacroAction[]): Promise<void> {
    for (const page of c.encodeMacroPages(id, actions)) await this.write(page);
  }
}
