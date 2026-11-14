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
import { checkFirmwareFrame, checkFrame, checkGamepadFrame, checkPerformanceWrite, isWriteCommand, UnsafeCommandError } from './safety';
import type { FwStep, GamepadStaging } from './safety';
import { FW_BOARD_PRO, FW_CHUNK, checkFile, chunks, serialReadable } from './firmware';
import type { FwCheck, KnownFw } from './firmware';
import * as gp from './gamepad';
import type { GamepadInfo, GamepadUsbState } from './gamepad';
import { t } from '../i18n/vi';

type RawPacketListener = (dir: 'out' | 'in', bytes: Uint8Array, note?: string) => void;

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
  // AGP1: the stock firmware's `10 FF`, or the same command, sequence and magic.
  if (request[0] === gp.GP_FAMILY) return gp.agp1ReplyMatches(request, reply);
  if (reply[0] !== request[0] || reply[1] !== request[1]) return false;
  const rule = ECHOED.find((r) => r.prefix[0] === request[0] && r.prefix[1] === request[1]);
  return !rule || rule.at.every((i) => reply[i] === request[i]);
}

/** 02 06 00 (enter) / 02 06 01 (leave calibration): the only writes allowed while calibration is locked. */
const isCalibrationControl = (p: readonly number[]): boolean => p[0] === FAMILY.GLOBAL && p[1] === 0x06 && (p[2] === 0x00 || p[2] === 0x01);

export abstract class BaseTransport implements Ae64Transport {
  abstract readonly kind: 'hid' | 'mock';
  abstract readonly productName: string;
  abstract readonly productId?: number;
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
  private readonly packetListeners = new Set<RawPacketListener>();

  /** Send one frame and resolve with the reply whose bytes 0–1 match; reject with TransportTimeoutError on timeout. */
  protected abstract exchange(frame: Uint8Array, timeoutMs: number): Promise<Bytes>;
  abstract close(): Promise<void>;

  onDisconnect(cb: () => void): () => void {
    this.disconnectListeners.add(cb);
    return () => this.disconnectListeners.delete(cb);
  }

  onPacket(cb: (e: PacketLogEntry) => void): () => void {
    return this.onPacketRaw((dir, bytes, note) => cb({ t: Date.now(), dir, bytes: Array.from(bytes), note }));
  }

  onPacketRaw(cb: RawPacketListener): () => void {
    this.packetListeners.add(cb);
    return () => this.packetListeners.delete(cb);
  }

  protected emitDisconnect(): void {
    for (const cb of [...this.disconnectListeners]) cb();
  }

  private log(dir: 'out' | 'in', bytes: Uint8Array, note?: string): void {
    if (!this.packetListeners.size) return;
    for (const cb of this.packetListeners) cb(dir, bytes, note);
  }

  /** Serialised request: one in flight at a time, replies matched on bytes 0–1. */
  protected request(payload: number[], timeoutMs = REQUEST_TIMEOUT_MS): Promise<Bytes> {
    const run = async (): Promise<Bytes> => {
      if (!this.connected) throw new Error(t('error.notConnected'));
      // A keyboard not running its app (bootloader, or told to restart into it) only ever gets `01 02` (DESIGN FW §3.5).
      if ((this.#runModeSeen !== null || this.#leftApp) && !(payload[0] === FAMILY.DEVICE && payload[1] === 0x02)) {
        throw new UnsafeCommandError(payload, `the keyboard is not running its app (run mode ${this.#runModeSeen ?? 'restarting'}): only 01 02 is sent`);
      }
      if (payload[0] === gp.GP_FAMILY) {
        const why = checkGamepadFrame(payload, { boardIdHex: this.boardIdHex, caps: this.gamepad?.caps ?? null, staging: this.gamepadStaging });
        if (why) throw new UnsafeCommandError(payload, why);
      }
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

  /** Board id read by getDeviceInfo(), lowercase: selects the switch catalog in the performance write guard. */
  private boardIdHex: string | undefined;

  /** `timeoutMs`: a firmware probe waits FW_PROBE_TIMEOUT_MS (or 3 s for the check after `08 01`). */
  async getDeviceInfo(timeoutMs?: number): Promise<DeviceInfo> {
    const info = c.decodeDeviceInfo(await this.request([FAMILY.DEVICE, 0x02], timeoutMs));
    if (info.runMode !== 0) this.#runModeSeen = info.runMode;
    this.boardAllowed = ALLOWED_BOARDS.includes(info.boardIdHex);
    this.boardIdHex = info.boardIdHex.toLowerCase();
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
    // Keep the first read of this connection plus the 7 newest: the key's original record (e.g. its switch before a
    // switch change) stays restorable by undo however many reads follow.
    if (seen.length > 8) seen.splice(1, seen.length - 8);
    this.perfSeen.set(k, seen);
    return p;
  }

  /** Refused unless the key was read first and the sensor fields stay as the device reported them. */
  async setPerformance(pos: KeyPos, p: Performance): Promise<void> {
    const payload = c.encodePerformance(pos, p);
    const why = checkPerformanceWrite(p, this.perfSeen.get(`${pos.row}:${pos.col}`) ?? [], {
      intervalRt: c.supportsIntervalRt(this.protocol),
      boardIdHex: this.boardIdHex,
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

  async readLedMatrix(area: number, pages?: readonly number[]): Promise<LedRecord[]> {
    const n = ledCount(area);
    if (pages) {
      // Only these packets (the live preview reads the ones that hold LEDs): the full length, holes where not read.
      const out: LedRecord[] = new Array(n);
      for (const p of pages) {
        if (!(p >= 0 && p * LED_RECORDS_PER_PACKET < n)) continue;
        const recs = c.decodeColors(await this.request([FAMILY.LIGHTING, 0x03, area, p]));
        for (let i = 0; i < recs.length && p * LED_RECORDS_PER_PACKET + i < n; i++) out[p * LED_RECORDS_PER_PACKET + i] = recs[i];
      }
      return out;
    }
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

  // ------------------------------------------------------------------ 10 gamepad (AGP1, experimental AE64 Pro XInput firmware)
  // Every frame passes checkGamepadFrame (safety.ts) in request(): AE64 Pro only, INFO first, WRITE/COMMIT only for this
  // connection's BEGIN, COMMIT only for a complete, valid block whose output the firmware offers.

  /** INFO that confirmed the gamepad firmware on this connection; null before, or for stock / unknown firmware. */
  private gamepad: GamepadInfo | null = null;
  /** The upload this connection started with BEGIN, until COMMIT or ABORT was sent. */
  private gamepadStaging: GamepadStaging | null = null;
  private gamepadSeq = 0;

  /** One AGP1 request; the data of an OK reply. Throws GamepadUnsupportedError for `10 FF`, GamepadStatusError for a refusal. */
  private async agp1(cmd: number, data: number[] = []): Promise<number[]> {
    this.gamepadSeq = (this.gamepadSeq + 1) & 0xff;
    const payload = gp.encodeFrame(cmd, this.gamepadSeq, data);
    const reply = gp.decodeReply(payload, await this.request(payload));
    if (reply.stock) throw new gp.GamepadUnsupportedError();
    if (reply.status !== gp.GP_STATUS.OK) throw new gp.GamepadStatusError(reply.status, cmd);
    return reply.data;
  }

  /** INFO. Null when the keyboard runs stock firmware (`10 FF`) or firmware this app does not know; GamepadNewerError for a newer AGP1 version. Clears any upload. */
  async gamepadInfo(): Promise<GamepadInfo | null> {
    this.gamepad = null;
    this.gamepadStaging = null;
    let data: number[];
    try {
      data = await this.agp1(gp.GP_CMD.INFO);
    } catch (err) {
      if (err instanceof gp.GamepadUnsupportedError) return null;
      throw err;
    }
    this.gamepad = gp.decodeInfo(data);
    if (!this.gamepad) {
      const newer = gp.newerInfo(data);
      if (newer) throw new gp.GamepadNewerError(newer.version, newer.caps);
    }
    return this.gamepad;
  }

  async gamepadRead(revision: number, offset: number, count: number): Promise<number[]> {
    return gp.decodeReadReply(await this.agp1(gp.GP_CMD.READ, gp.readData(revision, offset, count)), revision, offset, count);
  }

  async gamepadBegin(revision: number, crc: number, token: readonly number[]): Promise<void> {
    this.gamepadStaging = null;
    await this.agp1(gp.GP_CMD.BEGIN, gp.beginData(revision, crc, token));
    const block = new Uint8Array(gp.GP_CONFIG_BYTES);
    this.gamepadStaging = { token: [...token], crc: crc >>> 0, revision: revision >>> 0, block, received: new Uint8Array(gp.GP_CONFIG_BYTES) };
  }

  async gamepadWrite(token: readonly number[], offset: number, chunk: readonly number[]): Promise<void> {
    await this.agp1(gp.GP_CMD.WRITE, gp.writeData(token, offset, chunk));
    const st = this.gamepadStaging;
    if (!st) return;
    st.block.set(chunk, offset);
    st.received.fill(1, offset, offset + chunk.length);
  }

  /** COMMIT: the new revision, or null when the reply does not confirm it (revision + 1, 5 bytes). Ends the upload either way. */
  async gamepadCommit(token: readonly number[], crc: number, revision: number): Promise<{ revision: number; persistent: boolean } | null> {
    try {
      return gp.decodeCommitReply(await this.agp1(gp.GP_CMD.COMMIT, gp.commitData(token, crc, revision)), revision);
    } finally {
      this.gamepadStaging = null;
    }
  }

  async gamepadAbort(token: readonly number[]): Promise<void> {
    try {
      await this.agp1(gp.GP_CMD.ABORT, gp.abortData(token));
    } finally {
      this.gamepadStaging = null;
    }
  }

  async gamepadUsbStatus(): Promise<GamepadUsbState> {
    return gp.decodeUsbState(await this.agp1(gp.GP_CMD.USB_STATUS));
  }

  /** USB_SET: the state the keyboard answered (a queued change is not verified until it reconnects). */
  async gamepadUsbSet(enabled: boolean, revision: number): Promise<GamepadUsbState> {
    return gp.decodeUsbState(await this.agp1(gp.GP_CMD.USB_SET, gp.usbSetData(enabled, revision)));
  }

  // ------------------------------------------------------------------ 08 firmware (DESIGN FW §3.5)
  // Family 08 is built only below (#fwFrame) and sent only through #fwRequest, after checkFirmwareFrame, for a session this
  // module opened (the ticket's state is in `fwSessions`, never handed out). frameOf / checkFrame / raw() refuse 08 always.

  /** Run mode other than 0 read by `01 02` on this connection (sticky); null while the keyboard ran its app. */
  #runModeSeen: number | null = null;
  /** `08 01` was sent here: the keyboard is (or may be) restarting into its bootloader. Only `01 02` from now on. */
  #leftApp = false;

  /** Run mode other than 0 that `01 02` reported on this connection, or null. */
  get runModeSeen(): number | null {
    return this.#runModeSeen;
  }

  /**
   * Opens a firmware session on this connection (the keyboard running its app). Copies `bytes`, checks the copy, then reads a
   * fresh `01 02`: run mode 0, board 0x0030000A equal to the file's, a readable serial. Never takes a check, board or serial
   * from outside. Throws FirmwareSessionError (nothing of family 08 was sent).
   */
  async beginFirmwareSession(bytes: Uint8Array, opts: { officialOnly?: boolean } = {}): Promise<FwTicket> {
    const copy = Uint8Array.from(bytes);
    const pre = checkFile(copy, FW_BOARD_PRO);
    if (!pre.ok) throw new FirmwareSessionError('file');
    if (opts.officialOnly && pre.known?.kind !== 'official') throw new FirmwareSessionError('official');
    const info = await this.getDeviceInfo();
    if (info.runMode !== 0) throw new FirmwareSessionError('mode');
    if (info.boardId !== FW_BOARD_PRO || info.boardId !== pre.header.board) throw new FirmwareSessionError('board', info.boardId);
    if (!serialReadable(info.serialHex)) throw new FirmwareSessionError('serial');
    const check = checkFile(copy, info.boardId);
    if (!check.ok) throw new FirmwareSessionError('file');
    return newSession({ bytes: copy, check, board: info.boardId, serialHex: info.serialHex, step: 'open', app: this, boot: null, rescue: false });
  }

  /**
   * Rescue (DESIGN FW §3.6): a session on this connection, a keyboard already in its bootloader. Like beginFirmwareSession but
   * run mode 255 and a readable board; the session starts attached. `officialOnly` (only ever narrows) also needs an official
   * build of KNOWN_FW. The bootloader's serial, when it reports one, is the session's.
   */
  async beginRescueSession(bytes: Uint8Array, opts: { officialOnly?: boolean } = {}): Promise<FwTicket> {
    const copy = Uint8Array.from(bytes);
    const info = await this.getDeviceInfo();
    if (info.runMode !== 255) throw new FirmwareSessionError('mode');
    if (info.boardId !== FW_BOARD_PRO) throw new FirmwareSessionError('board', info.boardId);
    const check = checkFile(copy, info.boardId);
    if (!check.ok) throw new FirmwareSessionError('file');
    if (opts.officialOnly && check.known?.kind !== 'official') throw new FirmwareSessionError('official');
    const serial = serialReadable(info.serialHex) ? info.serialHex : null;
    return newSession({ bytes: copy, check, board: info.boardId, serialHex: serial, step: 'attached', app: null, boot: this, rescue: true });
  }

  /** `08 01`, once, on the app connection that opened the session. The reply is optional (the keyboard may reset first). */
  async fwEnter(ticket: FwTicket): Promise<void> {
    const st = sessionOf(ticket);
    await this.#fwRequest(st, [FIRMWARE_FAMILY, 0x01], FW_ENTER_TIMEOUT_MS, () => {
      st.step = 'entered';
      this.#leftApp = true;
    }).catch((err: unknown) => {
      if (err instanceof UnsafeCommandError) throw err;
    });
  }

  /**
   * Every `08 02` of the session's file from offset 0, each waiting at most 3 s for an `08 02` reply, never resent. Runs the file
   * check again on the session's copy first. A rewrite (after a failed packet or check) first drops every input report for
   * FW_RETRY_QUIET_MS. Throws FirmwarePacketError (step `packetFail`) at the first packet without a reply.
   */
  async fwWrite(ticket: FwTicket, onProgress?: (sent: number, total: number) => void): Promise<void> {
    const st = sessionOf(ticket);
    if (st.boot !== this) throw new UnsafeCommandError([FIRMWARE_FAMILY, 0x02], 'this connection is not the bootloader of the session');
    if (st.step !== 'attached' && st.step !== 'packetFail' && st.step !== 'verifyFail') {
      throw new UnsafeCommandError([FIRMWARE_FAMILY, 0x02], `08 02 in step ${st.step}`);
    }
    if (!checkFile(st.bytes, st.board).ok) throw new FirmwareSessionError('file');
    if (st.step !== 'attached') await this.drainInput(FW_RETRY_QUIET_MS);
    st.step = 'writing';
    st.nextOffset = 0;
    const list = chunks(st.bytes);
    for (let i = 0; i < list.length; i++) {
      const { offset, data } = list[i];
      const payload = [
        FIRMWARE_FAMILY, 0x02, offset & 0xff, (offset >>> 8) & 0xff, (offset >>> 16) & 0xff, (offset >>> 24) & 0xff,
        data.length & 0xff, (data.length >>> 8) & 0xff, ...data,
      ];
      try {
        await this.#fwRequest(st, payload, FW_PACKET_TIMEOUT_MS);
      } catch (err) {
        if (st.step === 'writing') st.step = 'packetFail';
        if (err instanceof UnsafeCommandError) throw err;
        throw new FirmwarePacketError(i, err);
      }
      st.nextOffset = offset + data.length;
      onProgress?.(i + 1, list.length);
    }
    st.step = 'written';
  }

  /** `08 03` once every packet was acknowledged. True when byte 2 of the reply is 1; false (step `verifyFail`) otherwise or after 10 s. */
  async fwVerify(ticket: FwTicket): Promise<boolean> {
    const st = sessionOf(ticket);
    let ok = false;
    try {
      const reply = await this.#fwRequest(st, [FIRMWARE_FAMILY, 0x03], FW_VERIFY_TIMEOUT_MS);
      ok = reply[2] === 1;
    } catch (err) {
      if (err instanceof UnsafeCommandError) throw err;
    }
    st.step = ok ? 'verified' : 'verifyFail';
    return ok;
  }

  /** `08 04`, only after `08 03` passed. The reply is optional. */
  async fwRestart(ticket: FwTicket): Promise<void> {
    const st = sessionOf(ticket);
    await this.#fwRequest(st, [FIRMWARE_FAMILY, 0x04], FW_RESTART_TIMEOUT_MS, () => { st.step = 'restarted'; }).catch((err: unknown) => {
      if (err instanceof UnsafeCommandError) throw err;
    });
  }

  /** Drops every input report for `ms` before the next request (a late reply must not answer it). The base just waits. */
  protected async drainInput(ms: number): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  /** The 64-byte report of a family-08 payload. Only #fwRequest calls it. */
  #fwFrame(payload: number[]): Uint8Array {
    const frame = new Uint8Array(REPORT_LENGTH);
    payload.forEach((b, i) => { frame[i] = c.byte(b, `byte ${i}`); });
    return frame;
  }

  /**
   * The only path of family 08: checkFirmwareFrame against the session (and this connection's place in it), then `before`
   * (the step change), then the same queue as every other request.
   */
  #fwRequest(st: FwState, payload: number[], timeoutMs: number, before?: () => void): Promise<Bytes> {
    const sender = this === st.app ? 'app' : this === st.boot ? 'boot' : 'other';
    const why = checkFirmwareFrame(payload, { board: st.board, step: st.step, sender, nextOffset: st.nextOffset, size: st.bytes.length });
    if (why) return Promise.reject(new UnsafeCommandError(payload, why));
    if (payload.length > REPORT_LENGTH) return Promise.reject(new UnsafeCommandError(payload, 'longer than one report'));
    const frame = this.#fwFrame(payload);
    before?.();
    const run = async (): Promise<Bytes> => {
      if (!this.connected) throw new Error(t('error.notConnected'));
      this.log('out', frame);
      try {
        const reply = await this.exchange(frame, timeoutMs);
        this.log('in', reply);
        return reply;
      } catch (err) {
        if (err instanceof TransportTimeoutError) this.stats.timeouts++;
        this.log('in', new Uint8Array(0), err instanceof Error ? err.message : String(err));
        throw err;
      }
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

// ---------------------------------------------------------------- firmware sessions (DESIGN FW §3.5)

/** `08 01`: the keyboard may reset before answering (optional reply). */
export const FW_ENTER_TIMEOUT_MS = 10_000;
/** `08 02`: one packet, never resent (USB already retries a NAKed report). */
export const FW_PACKET_TIMEOUT_MS = 3_000;
export const FW_VERIFY_TIMEOUT_MS = 10_000;
export const FW_RESTART_TIMEOUT_MS = 1_000;
/** Input reports dropped before packet 0 of a rewrite. */
export const FW_RETRY_QUIET_MS = 1_000;
/** A probe (`01 02`) of a device while looking for the bootloader or the keyboard. */
export const FW_PROBE_TIMEOUT_MS = 1_500;

/** The key of a session: an empty frozen object. Its state is only in `fwSessions` below. */
export type FwTicket = Readonly<Record<string, never>>;

interface FwState {
  bytes: Uint8Array;
  check: FwCheck;
  board: number;
  /** null: a rescue session whose bootloader reports no serial. */
  serialHex: string | null;
  step: FwStep;
  app: BaseTransport | null;
  boot: BaseTransport | null;
  rescue: boolean;
  nextOffset: number;
  /** Devices that got their one `01 02` while looking for the bootloader / the keyboard, and what they answered. */
  probedBoot: Map<BaseTransport, DeviceInfo | null>;
  probedApp: Map<BaseTransport, DeviceInfo | null>;
}

const fwSessions = new WeakMap<FwTicket, FwState>();

function newSession(s: Omit<FwState, 'nextOffset' | 'probedBoot' | 'probedApp'>): FwTicket {
  const ticket: FwTicket = Object.freeze({});
  fwSessions.set(ticket, { ...s, nextOffset: 0, probedBoot: new Map(), probedApp: new Map() });
  return ticket;
}

function sessionOf(ticket: FwTicket): FwState {
  const st = fwSessions.get(ticket);
  if (!st) throw new UnsafeCommandError([FIRMWARE_FAMILY], 'not a firmware session of this app');
  return st;
}

export type FwSessionReason = 'file' | 'mode' | 'board' | 'serial' | 'official';

export class FirmwareSessionError extends Error {
  constructor(readonly reason: FwSessionReason, readonly board?: number) {
    super(`firmware session refused: ${reason}`);
    this.name = 'FirmwareSessionError';
  }
}

export class FirmwarePacketError extends Error {
  constructor(readonly index: number, readonly reason?: unknown) {
    super(`packet ${index} was not acknowledged`);
    this.name = 'FirmwarePacketError';
  }
}

/** What a session's file is, as the session checked it (for the page: the build, the versions to compare). */
export function sessionFile(ticket: FwTicket): { known: KnownFw | null; size: number; packets: number; rescue: boolean } {
  const st = sessionOf(ticket);
  return { known: st.check.known, size: st.bytes.length, packets: Math.ceil(st.bytes.length / FW_CHUNK), rescue: st.rescue };
}

/** One `01 02` per device until it is unplugged; null when it does not answer. */
async function probe(t: BaseTransport, seen: Map<BaseTransport, DeviceInfo | null>): Promise<DeviceInfo | null> {
  if (seen.has(t)) return seen.get(t)!;
  seen.set(t, null);
  let info: DeviceInfo | null = null;
  try {
    info = await t.getDeviceInfo(FW_PROBE_TIMEOUT_MS);
  } catch {
    info = null;
  }
  seen.set(t, info);
  return info;
}

export type FwAttachResult =
  | { ok: true; transport: BaseTransport }
  | { ok: false; why: 'none' | 'many' | 'wrong' | 'appBack' };

/**
 * Looks for the session's keyboard in its bootloader among `devices` (DESIGN FW §3.3). Each device gets one `01 02` (until it is
 * unplugged); the session's own app connection gets none. A bootloader counts when it reports run mode 255 and the session's
 * board; it is the one when its serial equals the session's, or (no serial reported) when it is the only bootloader plugged in.
 * `appBack`: the session's keyboard answered from its app (same serial and board, run mode 0): it did not enter update mode.
 * `wrong`: something answered, but not the session's bootloader.
 */
export async function fwAttach(ticket: FwTicket, devices: readonly BaseTransport[]): Promise<FwAttachResult> {
  const st = sessionOf(ticket);
  if (st.step !== 'entered') throw new UnsafeCommandError([FIRMWARE_FAMILY, 0x02], `looking for the bootloader in step ${st.step}`);
  for (const d of devices) if (d !== st.app && d.connected) await probe(d, st.probedBoot);
  for (const d of [...st.probedBoot.keys()]) if (!d.connected) st.probedBoot.delete(d);
  const live = [...st.probedBoot];
  const boots = live.filter(([, i]) => i?.runMode === 255 && i.boardId === st.board);
  const same = boots.filter(([, i]) => i!.serialHex === st.serialHex);
  if (same.length > 1) return { ok: false, why: 'many' };
  let pick = same[0]?.[0];
  if (!pick) {
    const noSerial = boots.filter(([, i]) => !serialReadable(i!.serialHex));
    if (noSerial.length === 1 && boots.length === 1) pick = noSerial[0][0];
    else if (noSerial.length > 1) return { ok: false, why: 'many' };
  }
  if (pick) {
    st.boot = pick;
    st.step = 'attached';
    return { ok: true, transport: pick };
  }
  if (live.some(([, i]) => i?.runMode === 0 && i.boardId === st.board && i.serialHex === st.serialHex)) return { ok: false, why: 'appBack' };
  return { ok: false, why: live.length ? 'wrong' : 'none' };
}

export type FwFindResult =
  | { ok: true; transport: BaseTransport; info: DeviceInfo }
  | { ok: false; why: 'none' | 'many' | 'boot' };

/**
 * After `08 04`: the session's keyboard back in its app among `devices` (one `01 02` each): run mode 0, the session's board and
 * serial. A rescue session without a serial takes the only AE64 Pro in app mode; several: `many`. `boot`: the keyboard showed up
 * in its bootloader again.
 */
export async function fwFind(ticket: FwTicket, devices: readonly BaseTransport[]): Promise<FwFindResult> {
  const st = sessionOf(ticket);
  if (st.step !== 'restarted') throw new UnsafeCommandError([FIRMWARE_FAMILY], `looking for the keyboard in step ${st.step}`);
  for (const d of devices) if (d !== st.boot && d.connected) await probe(d, st.probedApp);
  for (const d of [...st.probedApp.keys()]) if (!d.connected) st.probedApp.delete(d);
  const live = [...st.probedApp];
  const apps = live.filter(([, i]) => i?.runMode === 0 && i.boardId === st.board);
  const pickable = st.serialHex ? apps.filter(([, i]) => i!.serialHex === st.serialHex) : apps;
  if (pickable.length === 1) return { ok: true, transport: pickable[0][0], info: pickable[0][1]! };
  if (pickable.length > 1) return { ok: false, why: 'many' };
  const boot = live.some(([, i]) => i?.runMode === 255 && i.boardId === st.board && (!st.serialHex || i.serialHex === st.serialHex));
  return { ok: false, why: boot ? 'boot' : 'none' };
}

/** "Search again": every device gets its `01 02` again. */
export function fwForgetProbes(ticket: FwTicket): void {
  const st = sessionOf(ticket);
  st.probedBoot.clear();
  st.probedApp.clear();
}
