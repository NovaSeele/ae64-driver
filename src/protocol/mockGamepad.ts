// Demo / test emulation of the experimental AE64 Pro XInput firmware's AGP1 handler (family 0x10). It follows the
// firmware's handler step by step (staging by token, 5 s expiry, revision, CRC, statuses 0–8) and validates the block with
// its own copy of the firmware's rules, not with gamepad.ts's decoder, so a mistake there does not hide here.
// USB_STATUS / USB_SET emulate the Xbox USB switch; a queued change completes USB_SWITCH_MS later (no real re-enumeration), and
// until then every 0x21–0x35 command conflicts, as in the firmware. Checked byte for byte against the v0.8.1 sources (wasm oracle).

import { GP_BOARD_ID, GP_CAP, GP_CMD, GP_CONFIG_BYTES, GP_MAGIC, GP_STATUS, GP_TRANSACTION_TIMEOUT_MS, crc32, u16, u32 } from './gamepad';

const KEY_COUNT = 64;
const NONE = 255;
/** A queued Xbox USB change detaches and comes back this long after USB_SET (demo only). */
export const USB_SWITCH_MS = 300;

export interface MockGamepadOptions {
  /** Capability bits (GP_CAP); default 30, what firmware v0.8.1 reports (XInput, persistent, USB switch, USB persistent; no HID). */
  caps?: number;
  revision?: number;
  /** Initial active block (208 bytes, must be valid). */
  block: Uint8Array;
  /** The key's calibrated full stroke (µm) the firmware validates against. */
  maxTravelUm: (key: number) => number;
  /** Clock in ms (default Date.now). */
  now?: () => number;
  usbEnabled?: boolean;
}

const p16 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff];
const p32 = (v: number): number[] => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const isMagic = (b: ArrayLike<number>, o: number, m: string): boolean => [...m].every((c, i) => b[o + i] === c.charCodeAt(0));

/** The firmware's block check (wire decode + the per-key calibrated stroke check). */
export function firmwareAccepts(w: ArrayLike<number>, maxUm: (key: number) => number): boolean {
  if (!isMagic(w, 0, 'AGC1') || w[4] !== 1 || w[5] > 2 || w[6] < 1 || w[6] > 2 || w[9] !== 0 || u16(w, 14) !== 24) return false;
  for (let s = 0; s < 2; s++) {
    const f = w[7 + s];
    const dead = u16(w, 10 + s * 2);
    if ((f & ~7) !== 0 || f >> 1 > 2 || dead >= 9500 || (!(f & 1) && dead !== 0)) return false;
  }
  let assigned = 0n;
  const bound = new Set<number>();
  for (let i = 0; i < 24; i++) {
    const o = 16 + i * 8;
    const key = w[o];
    const curve = w[o + 1];
    const start = u16(w, o + 2);
    const end = u16(w, o + 4);
    const declared = u16(w, o + 6);
    if ((key >= KEY_COUNT && key !== NONE) || curve > 1 || declared < 10 || declared > 10000 || start >= end || end > declared) return false;
    if (key !== NONE) {
      const bit = 1n << BigInt(key);
      if (assigned & bit) return false;
      assigned |= bit;
      bound.add(key);
      if (i < 10) {
        const max = maxUm(key);
        if (!(max >= 10 && max <= 10000) || end > max) return false;
      }
    }
  }
  for (const key of bound) {
    const max = maxUm(key);
    if (!(max >= 10 && max <= 10000)) return false;
  }
  return true;
}

export class MockGamepadFirmware {
  active: Uint8Array;
  revision: number;
  readonly caps: number;
  now: () => number;
  readonly maxTravelUm: (key: number) => number;
  private staging = new Uint8Array(GP_CONFIG_BYTES);
  private received = new Uint8Array(GP_CONFIG_BYTES);
  private stagingActive = false;
  private stagedRevision = 0;
  private stagedCrc = 0;
  private token: number[] = [];
  private lastActivity = 0;
  /** Test hook: the next install fails (status 8, nothing changes). */
  failInstall = false;
  usb: { enabled: boolean; target: boolean; phase: number; revision: number; queuedAt: number };

  constructor(o: MockGamepadOptions) {
    this.active = Uint8Array.from(o.block);
    this.revision = o.revision ?? 1;
    this.caps = o.caps ?? (GP_CAP.XINPUT | GP_CAP.PERSISTENT | GP_CAP.USB_SWITCH | GP_CAP.USB_PERSISTENT);
    this.now = o.now ?? (() => Date.now());
    this.maxTravelUm = o.maxTravelUm;
    const en = o.usbEnabled ?? true;
    this.usb = { enabled: en, target: en, phase: 0, revision: 1, queuedAt: 0 };
  }

  /** Whether an upload is staged (tests). */
  get staged(): boolean {
    return this.stagingActive;
  }

  /**
   * The 64-byte reply, or null when the frame falls through to the stock dispatcher. Same order as the firmware's
   * board_dispatch_hook: USB_STATUS / USB_SET; then, while a USB switch is pending, CONFLICT for every 0x21–0x35 command
   * whatever its content; then the FNR1 range 0x30–0x35 (a separate Fn-colour protocol, not emulated: FORMAT without
   * the "FNR1" magic, UNSUPPORTED otherwise); then AGP1 0x20–0x25.
   */
  handle(req: ArrayLike<number>): number[] | null {
    if (req[0] !== 0x10) return null;
    const cmd = req[1];
    const agp1 = GP_MAGIC.every((b, i) => req[4 + i] === b);
    const now = this.now() >>> 0;
    if (this.stagingActive && ((now - this.lastActivity) >>> 0) > GP_TRANSACTION_TIMEOUT_MS) this.stagingActive = false;
    this.settleUsb(now);
    const reply = new Array<number>(64).fill(0);
    for (let i = 0; i < 8; i++) reply[i] = req[i];
    let status: number;
    let data: number[] = [];
    const usbCmd = cmd === GP_CMD.USB_STATUS || cmd === GP_CMD.USB_SET;
    if (usbCmd && agp1) {
      const want = cmd === GP_CMD.USB_STATUS ? 0 : 10;
      if (!(this.caps & GP_CAP.USB_SWITCH)) status = GP_STATUS.UNSUPPORTED;
      else if (req[2] !== 1 || req[8] !== 0 || req[9] !== want) status = GP_STATUS.FORMAT;
      else [status, data] = this.process(cmd, Array.from({ length: want }, (_, i) => req[10 + i]), now);
    } else if (this.usb.phase !== 0 && cmd >= 0x21 && cmd <= 0x35) {
      status = GP_STATUS.CONFLICT;
    } else if (cmd >= 0x30 && cmd <= 0x35) {
      reply[2] = 1;
      [0x46, 0x4e, 0x52, 0x31].forEach((b, i) => { reply[4 + i] = b; }); // "FNR1"
      const fnr1 = req[4] === 0x46 && req[5] === 0x4e && req[6] === 0x52 && req[7] === 0x31;
      status = req[2] !== 1 || !fnr1 || req[8] !== 0 || req[9] > 54 ? GP_STATUS.FORMAT : GP_STATUS.UNSUPPORTED;
    } else if (cmd < GP_CMD.INFO || cmd > GP_CMD.READ || !agp1) {
      return null;
    } else if (req[2] !== 1 || req[8] !== 0 || req[9] > 54) {
      status = GP_STATUS.FORMAT;
    } else {
      [status, data] = this.process(cmd, Array.from({ length: req[9] }, (_, i) => req[10 + i]), now);
    }
    reply[8] = status;
    if (status === GP_STATUS.OK) {
      reply[9] = data.length;
      data.forEach((b, i) => { reply[10 + i] = b; });
    }
    return reply;
  }

  private settleUsb(now: number): void {
    const u = this.usb;
    if (u.phase !== 0 && now - u.queuedAt >= USB_SWITCH_MS) {
      u.enabled = u.target;
      u.phase = 0;
    }
  }

  private usbState(): number[] {
    const u = this.usb;
    return [...p32(GP_BOARD_ID), 1, u.enabled ? 1 : 0, u.target ? 1 : 0, u.phase, ...p32(u.revision)];
  }

  private process(cmd: number, p: number[], now: number): [number, number[]] {
    const n = p.length;
    const tokenIs = (o: number) => this.token.length === 8 && this.token.every((b, i) => p[o + i] === b);
    switch (cmd) {
      case GP_CMD.INFO:
        if (n) return [GP_STATUS.FORMAT, []];
        return [GP_STATUS.OK, [...p32(GP_BOARD_ID), this.caps, 24, 1, 0, ...p32(this.revision), ...p16(10000), ...p16(GP_CONFIG_BYTES), ...p32(crc32(this.active))]];
      case GP_CMD.READ: {
        if (n !== 7 || p[6] > 48 || !p[6] || u16(p, 4) + p[6] > GP_CONFIG_BYTES) return [GP_STATUS.FORMAT, []];
        if (u32(p, 0) !== this.revision) return [GP_STATUS.CONFLICT, []];
        const off = u16(p, 4);
        return [GP_STATUS.OK, [...p32(this.revision), ...p16(off), ...this.active.slice(off, off + p[6])]];
      }
      case GP_CMD.ABORT:
        if (n !== 8) return [GP_STATUS.FORMAT, []];
        if (this.stagingActive && !tokenIs(0)) return [GP_STATUS.CONFLICT, []];
        this.stagingActive = false;
        return [GP_STATUS.OK, []];
      case GP_CMD.BEGIN:
        if (n !== 18 || u16(p, 8) !== GP_CONFIG_BYTES || p.slice(10, 18).every((b) => b === 0)) return [GP_STATUS.FORMAT, []];
        if (u32(p, 0) !== this.revision) return [GP_STATUS.CONFLICT, []];
        if (this.stagingActive) {
          if (!tokenIs(10) || u32(p, 4) !== this.stagedCrc || u32(p, 0) !== this.stagedRevision) return [GP_STATUS.CONFLICT, []];
          this.lastActivity = now;
          return [GP_STATUS.OK, []];
        }
        this.stagingActive = true;
        this.stagedRevision = u32(p, 0);
        this.stagedCrc = u32(p, 4);
        this.token = p.slice(10, 18);
        this.lastActivity = now;
        this.received.fill(0);
        return [GP_STATUS.OK, []];
      case GP_CMD.WRITE: {
        if (!this.stagingActive) return [GP_STATUS.CONFLICT, []];
        if (n < 11 || n > 54 || u16(p, 8) + n - 10 > GP_CONFIG_BYTES) return [GP_STATUS.FORMAT, []];
        if (!tokenIs(0)) return [GP_STATUS.CONFLICT, []];
        this.lastActivity = now;
        const start = u16(p, 8);
        for (let i = 0; i < n - 10; i++) {
          this.staging[start + i] = p[10 + i];
          this.received[start + i] = 1;
        }
        return [GP_STATUS.OK, []];
      }
      case GP_CMD.COMMIT: {
        if (n !== 16) return [GP_STATUS.FORMAT, []];
        if (!this.stagingActive || this.stagedRevision !== this.revision || !tokenIs(0) || u32(p, 8) !== this.stagedCrc || u32(p, 12) !== this.revision) {
          return [GP_STATUS.CONFLICT, []];
        }
        if (this.received.some((b) => !b)) return [GP_STATUS.INCOMPLETE, []];
        if (crc32(this.staging) !== this.stagedCrc) return [GP_STATUS.CRC, []];
        if (!firmwareAccepts(this.staging, this.maxTravelUm)) return [GP_STATUS.CONFIG, []];
        const transport = this.staging[6];
        if (this.staging[5] !== 0 && !(this.caps & transport)) return [GP_STATUS.BACKEND, []];
        if (this.failInstall) {
          this.failInstall = false;
          return [GP_STATUS.STORAGE, []];
        }
        this.active = Uint8Array.from(this.staging);
        this.revision = (this.revision + 1) >>> 0;
        this.stagingActive = false;
        return [GP_STATUS.OK, [...p32(this.revision), this.caps & GP_CAP.PERSISTENT ? 1 : 0]];
      }
      case GP_CMD.USB_STATUS:
        return [GP_STATUS.OK, this.usbState()];
      case GP_CMD.USB_SET: {
        if (u32(p, 0) !== GP_BOARD_ID || p[4] > 1 || p[5] !== 0) return [GP_STATUS.FORMAT, []];
        const u = this.usb;
        if (u.phase !== 0 || u32(p, 6) !== u.revision || this.stagingActive) return [GP_STATUS.CONFLICT, []];
        const want = p[4] === 1;
        if (want !== u.enabled) {
          u.target = want;
          u.phase = 1;
          u.revision = (u.revision + 1) >>> 0;
          u.queuedAt = now;
        }
        return [GP_STATUS.OK, this.usbState()];
      }
      default: // unreachable: handle() routes only 0x20–0x27 here
        return [GP_STATUS.UNSUPPORTED, []];
    }
  }
}
