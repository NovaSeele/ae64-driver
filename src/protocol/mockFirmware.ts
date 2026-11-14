// The demo's USB bus for the firmware page (DESIGN FW §3.9): the demo AE64 Pro, its bootloader after `08 01`, and the keyboard
// back after `08 04`, as strict as a real bootloader should be. Demo and tests only: the real path is HidFwPort (hid.ts).
//
// Reviewers drive the failure branches from the console: `device.transport.fwMock.flags` (FwMockFlags below), and read
// `fwMock.received` (every command each device got), `fwMock.violations` (must stay empty) and `fwMock.writes` (the `08 02` frames).
import type { Bytes } from './types';
import { BaseTransport, TransportTimeoutError, replyMatches } from './client';
import { MockTransport } from './mock';
import type { DemoSeed } from './mock';
import type { FwPort } from './fwPort';
import { FW_HEADER_BYTES, FW_MAX_FILE, FW_SIGNATURE, fwCrc32, knownFw } from './firmware';

export interface FwMockFlags {
  /** This `08 02` packet (index) is answered with a wrong reply (`08 7F`): the app takes it as no reply. One-shot. */
  wrongEchoAt: number | null;
  /** This packet's reply comes after `ms` (2500 passes, 3100 is too late). One-shot. The bootloader is busy meanwhile. */
  delayAt: { packet: number; ms: number } | null;
  /** `08 03` reports a bad image whatever was written. */
  verifyFail: boolean;
  /** `08 03` is never answered (the app waits 10 s). */
  verifySilent: boolean;
  /** Byte 2 of the `08 03` reply, whatever was written (only 1 means verified; 2, 0xFF… do not). */
  verifyStatus: number | null;
  /** The bootloader is unplugged when `08 03` arrives (no reply), and plugged back in after 1.5 s. One-shot. */
  unplugAtVerify: boolean;
  /** The bootloader is unplugged right after answering this packet (lost), and plugged back in after 1.5 s. */
  unplugAt: number | null;
  /** After unplugAt / unplugAtVerify the keyboard comes back running its app (run mode 0), not in its bootloader. */
  lostIntoApp: boolean;
  /** After `08 04` the keyboard comes back in its bootloader again (run mode 255), not in its app. */
  restartIntoBoot: boolean;
  /** After `08 04` the keyboard never comes back. */
  notFound: boolean;
  /** After `08 04` `01 02` reports this version instead of the file's. */
  version: string | null;
  /** After an XInput file: INFO answers `10 FF` (no gamepad firmware). */
  noGamepad: boolean;
  /** After an official file: INFO still answers AGP1 (the old XInput build still runs). */
  staleGamepad: boolean;
  /** The bootloader's `01 02` reports board 0 / no serial (all 0). */
  bootNoBoard: boolean;
  bootNoSerial: boolean;
  /** `08 01` is not answered: the keyboard leaves USB at once. */
  enterSilent: boolean;
  /** `08 01` does nothing: the keyboard keeps running its app (run mode 0). */
  enterFail: boolean;
  /** With enterFail: the keyboard does not answer this many `01 02` after `08 01` (busy copying its flash). */
  enterQuiet: number;
  /** `08 01`: the keyboard leaves USB and comes back running its app (a new connection), not in its bootloader. */
  enterBounce: boolean;
  /** The bootloader is not allowed yet: only "Allow the keyboard in update mode" (request) shows it. */
  bootNeedsPermission: boolean;
  /** What the chooser of request() returns. */
  choose: 'boot' | 'max' | 'cancel';
  /** ms from `08 01` to the bootloader on USB, and from `08 04` to the keyboard back in its app. */
  bootDelayMs: number;
  appDelayMs: number;
  /**
   * Other devices on the bus: an AE64 Max; an AE64 Pro whose serial differs but reads the same as decimals; a second bootloader
   * (after `08 01`); a bootloader of board 0030000D without a serial, and a bootloader of the Pro board with another serial (both
   * plugged in and allowed from the start).
   */
  extra: ('max' | 'pro-twin' | 'boot-twin' | 'boot-max' | 'boot-other')[];
}

export const defaultFwMockFlags = (): FwMockFlags => ({
  wrongEchoAt: null, delayAt: null, verifyFail: false, verifySilent: false, verifyStatus: null, unplugAtVerify: false,
  unplugAt: null, lostIntoApp: false, restartIntoBoot: false, notFound: false, version: null, noGamepad: false,
  staleGamepad: false, bootNoBoard: false, bootNoSerial: false, enterSilent: false, enterFail: false, enterQuiet: 0,
  enterBounce: false, bootNeedsPermission: false, choose: 'boot', bootDelayMs: 2000, appDelayMs: 1500, extra: [],
});

const PRO_BOARD = [0x00, 0x30, 0x00, 0x0a];
const MAX_BOARD = [0x00, 0x30, 0x00, 0x0d];
const hex2 = (b: number) => b.toString(16).padStart(2, '0');

/** 12 bytes with the same decimal concatenation as `serial` (`[1, 11]` and `[11, 1]` both read "111"), or null when none exists. */
export function twinSerial(serial: readonly number[]): number[] | null {
  const s = serial.join('');
  const out: number[] = [];
  const walk = (i: number): boolean => {
    if (out.length === 12) return i === s.length && out.some((b, k) => b !== serial[k]);
    for (let n = 1; n <= 3 && i + n <= s.length; n++) {
      const part = s.slice(i, i + n);
      if (part.length > 1 && part[0] === '0') break;
      const v = Number(part);
      if (v > 255) break;
      out.push(v);
      if (walk(i + n)) return true;
      out.pop();
    }
    return false;
  };
  return walk(0) ? out.slice() : null;
}

/** A keyboard in its bootloader (run mode 255). Answers `01 02`, `08 02`, `08 03`, `08 04` only; anything else is a violation. */
export class MockBootloader extends BaseTransport {
  readonly kind = 'mock' as const;
  readonly productName = 'AE64 Pro (update mode, demo)';
  readonly productId = 0x0000;
  private plugged = true;
  private pending: { frame: Uint8Array; resolve: (b: Bytes) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private busyUntil = 0;
  private readonly image = new Uint8Array(FW_MAX_FILE);
  private expected = 0;
  private verified = false;

  constructor(
    readonly bus: MockFwBus, readonly serial: readonly number[], readonly label: 'boot' | 'boot-twin' | 'boot-max' | 'boot-other',
    private readonly board: readonly number[] = PRO_BOARD,
  ) {
    super();
  }

  get connected(): boolean {
    return this.plugged;
  }

  async close(): Promise<void> {
    // closing a HID device does not unplug it: the bus still lists it
  }

  /** The bus unplugs it. */
  unplug(): void {
    if (!this.plugged) return;
    this.plugged = false;
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(new Error('disconnected'));
    }
    this.emitDisconnect();
  }

  protected exchange(frame: Uint8Array, timeoutMs: number): Promise<Bytes> {
    return new Promise<Bytes>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        reject(new TransportTimeoutError(Array.from(frame)));
      }, timeoutMs);
      this.pending = { frame, resolve, reject, timer };
      this.receive(frame);
    });
  }

  /** The device side: processed in order (a busy bootloader answers later); the reply is a report that may arrive late. */
  private receive(frame: Uint8Array): void {
    const bus = this.bus;
    const f = bus.flags;
    const now = bus.now();
    const start = Math.max(now, this.busyUntil);
    let delay = bus.latencyMs;
    let reply: number[] | null = null;
    const cmd = `${hex2(frame[0])} ${hex2(frame[1])}`;
    if (frame[0] === 0x01 && frame[1] === 0x02) {
      bus.log(this.label, cmd);
      const noSerial = f.bootNoSerial && this.label !== 'boot-other';
      reply = bus.deviceInfo(f.bootNoBoard ? [0, 0, 0, 0] : [...this.board], noSerial ? new Array(12).fill(0) : this.serial, 255, [0, 0, 0, 0]);
    } else if (frame[0] === 0x08 && frame[1] === 0x02) {
      const off = (frame[2] | (frame[3] << 8) | (frame[4] << 16) | (frame[5] << 24)) >>> 0;
      const len = frame[6] | (frame[7] << 8);
      bus.log(this.label, cmd, off, len);
      bus.writes.push(frame.slice());
      if (off === 0) { this.expected = 0; this.verified = false; this.image.fill(0); }
      const index = Math.floor(off / 56);
      if (off !== this.expected || len === 0 || len > 56 || off + len > FW_MAX_FILE || frame.subarray(8 + len).some((b) => b !== 0)) {
        bus.violation(`08 02 offset ${off} length ${len}: expected offset ${this.expected}, 1–56 bytes, zero padding`);
        return; // like a hung keyboard: no reply
      }
      this.image.set(frame.subarray(8, 8 + len), off);
      this.expected = off + len;
      if (f.delayAt && f.delayAt.packet === index) { delay = f.delayAt.ms; f.delayAt = null; }
      reply = [0x08, 0x02, 0x00, frame[2], frame[3], frame[4], frame[5]];
      if (f.wrongEchoAt === index) { reply = [0x08, 0x7f]; f.wrongEchoAt = null; }
      if (f.unplugAt === index) {
        f.unplugAt = null;
        bus.later(start - now + delay + 5, () => bus.lose(this));
      }
    } else if (frame[0] === 0x08 && frame[1] === 0x03) {
      bus.log(this.label, cmd);
      if (f.unplugAtVerify) {
        f.unplugAtVerify = false;
        bus.later(5, () => bus.lose(this));
        return;
      }
      if (f.verifySilent) return; // no reply: the app gives up after 10 s
      const len = this.expected;
      const img = this.image;
      const declared = FW_HEADER_BYTES + ((img[12] | (img[13] << 8) | (img[14] << 16) | (img[15] << 24)) >>> 0);
      const crc = (img[16] | (img[17] << 8) | (img[18] << 16) | (img[19] << 24)) >>> 0;
      this.verified = !f.verifyFail && len > FW_HEADER_BYTES && len === declared && FW_SIGNATURE.every((b, i) => img[i] === b)
        && fwCrc32(img, FW_HEADER_BYTES, len) === crc;
      if (f.verifyStatus !== null && f.verifyStatus !== 1) this.verified = false;
      reply = [0x08, 0x03, f.verifyStatus ?? (this.verified ? 1 : 0)];
    } else if (frame[0] === 0x08 && frame[1] === 0x04) {
      bus.log(this.label, cmd);
      if (!this.verified) bus.violation('08 04 before the image was verified');
      reply = [0x08, 0x04];
      const image = this.image.slice(0, this.expected);
      bus.later(start - now + delay + 20, () => bus.restartIntoApp(this, image));
    } else {
      bus.log(this.label, cmd);
      bus.violation(`${cmd} sent to the bootloader (only 01 02, 08 02, 08 03, 08 04 are)`);
      return;
    }
    this.busyUntil = start + delay;
    const out = new Uint8Array(64);
    out.set(reply.slice(0, 64));
    bus.later(start - now + delay, () => this.deliver(out, frame));
  }

  private deliver(report: Uint8Array, forFrame: Uint8Array): void {
    if (!this.plugged) return;
    const p = this.pending;
    if (!p || !replyMatches(p.frame, report)) {
      this.bus.dropped++;
      return;
    }
    if (p.frame !== forFrame) {
      this.bus.violation(`a reply to ${hex2(forFrame[0])} ${hex2(forFrame[1])} @${forFrame[2] | (forFrame[3] << 8) | (forFrame[4] << 16)} was taken as the reply to @${p.frame[2] | (p.frame[3] << 8) | (p.frame[4] << 16)}`);
    }
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(report);
  }
}

/**
 * The demo USB bus of one AE64 Pro (and the extra devices of FwMockFlags.extra). Implements FwPort for the firmware store.
 * Timers go through setTimeout, so tests drive it with fake timers.
 */
export class MockFwBus implements FwPort {
  readonly flags: FwMockFlags = defaultFwMockFlags();
  /** Every command a device on this bus got: `app` (the keyboard in its app), `boot`, `boot-twin`, `max`, `pro-twin`. */
  readonly received: { dev: string; cmd: string; offset?: number; len?: number }[] = [];
  /** Anything a real bootloader would not accept, or a reply taken as another request's. Must stay empty. */
  readonly violations: string[] = [];
  /** Every `08 02` frame the bootloaders got (64 bytes each). */
  readonly writes: Uint8Array[] = [];
  dropped = 0;
  latencyMs = 1;
  private devices: BaseTransport[] = [];
  private granted = new WeakSet<BaseTransport>();
  private readonly connectListeners = new Set<() => void>();
  /** The extra devices already plugged in (FwMockFlags.extra is read again at attach and at `08 01`). */
  private readonly extrasPlugged = new Set<string>();
  /** `01 02` the keyboard still leaves unanswered after `08 01` (FwMockFlags.enterQuiet). */
  private quiet = 0;

  constructor(readonly serial: readonly number[], private readonly opts: { fastLedReplies?: boolean } = {}) {}

  now(): number {
    return Date.now();
  }

  later(ms: number, fn: () => void): void {
    setTimeout(fn, Math.max(0, ms));
  }

  log(dev: string, cmd: string, offset?: number, len?: number): void {
    this.received.push(offset === undefined ? { dev, cmd } : { dev, cmd, offset, len });
  }

  violation(msg: string): void {
    this.violations.push(msg);
  }

  /** A `01 02` reply: board (big-endian bytes), serial, run mode, firmware version bytes. */
  deviceInfo(board: number[], serial: readonly number[], runMode: number, firmware: number[]): number[] {
    const out = new Array(45).fill(0);
    out.splice(0, 4, 0x01, 0x02, 0x01, 0x00);
    out.splice(4, 4, ...board);
    out.splice(8, 4, ...firmware);
    out.splice(12, 4, 0x01, 0x00, 0x00, 0x00);
    out[16] = runMode;
    out.splice(17, 12, ...serial);
    return out;
  }

  /** The demo keyboard (its app) joins the bus. */
  attach(app: MockTransport): void {
    if (!this.devices.includes(app)) this.devices.push(app);
    this.granted.add(app);
    this.plugExtras();
  }

  private plugExtras(): void {
    for (const e of this.flags.extra) {
      if (this.extrasPlugged.has(e) || e === 'boot-twin') continue;
      this.extrasPlugged.add(e);
      if (e === 'boot-max') this.plug(new MockBootloader(this, new Array(12).fill(0), 'boot-max', MAX_BOARD));
      if (e === 'boot-other') this.plug(new MockBootloader(this, this.serial.map((b) => b ^ 0x5a), 'boot-other'));
      if (e === 'max') this.plug(new MockTransport({ seed: 'max', fastLedReplies: this.opts.fastLedReplies, fwLabel: 'max', fwBus: this }));
      if (e === 'pro-twin') {
        const twin = twinSerial(this.serial);
        if (twin) this.plug(new MockTransport({ seed: 'pro', serial: twin, fastLedReplies: this.opts.fastLedReplies, fwLabel: 'pro-twin', fwBus: this }));
      }
    }
  }

  plug(t: BaseTransport, granted = true): void {
    this.devices.push(t);
    if (granted) this.granted.add(t);
    for (const cb of [...this.connectListeners]) cb();
  }

  unplug(t: BaseTransport): void {
    this.devices = this.devices.filter((d) => d !== t);
    if (t instanceof MockBootloader || t instanceof MockTransport) t.unplug();
  }

  /** `08 01` reached the demo keyboard. Returns false when the keyboard does not answer (enterSilent). */
  entered(app: MockTransport): boolean {
    const f = this.flags;
    this.plugExtras();
    if (f.enterFail) {
      this.quiet = f.enterQuiet;
      return true;
    }
    if (f.enterBounce) {
      this.later(30, () => this.unplug(app));
      this.later(f.bootDelayMs, () => this.plug(new MockTransport({ ...app.initOpts, fwBus: this })));
      return true;
    }
    if (f.enterSilent) this.unplug(app);
    else this.later(30, () => this.unplug(app));
    this.later(f.bootDelayMs, () => {
      this.plug(new MockBootloader(this, this.serial, 'boot'), !f.bootNeedsPermission);
      if (f.extra.includes('boot-twin')) {
        this.plug(new MockBootloader(this, f.bootNoSerial ? this.serial : (twinSerial(this.serial) ?? this.serial.map((b) => b ^ 1)), 'boot-twin'), !f.bootNeedsPermission);
      }
    });
    return !f.enterSilent;
  }

  /** The bootloader was unplugged mid-write; it comes back after 1.5 s (still in its bootloader, or in its app: lostIntoApp). */
  lose(boot: MockBootloader): void {
    this.unplug(boot);
    this.later(1500, () => this.plug(this.flags.lostIntoApp
      ? new MockTransport({ seed: 'pro', serial: [...this.serial], fastLedReplies: this.opts.fastLedReplies, fwBus: this })
      : new MockBootloader(this, this.serial, 'boot')));
  }

  /** The keyboard in its app does not answer this `01 02` (FwMockFlags.enterQuiet, after `08 01`). */
  swallow(t: MockTransport): boolean {
    if (t.fwLabel !== 'app' || this.quiet <= 0) return false;
    this.quiet--;
    return true;
  }

  /** `08 04`: the bootloader leaves USB and the keyboard comes back running `image` (unless notFound). */
  restartIntoApp(boot: MockBootloader, image: Uint8Array): void {
    this.unplug(boot);
    for (const d of this.devices.filter((x) => x instanceof MockBootloader)) this.unplug(d);
    const f = this.flags;
    if (f.notFound) return;
    if (f.restartIntoBoot) {
      this.later(f.appDelayMs, () => this.plug(new MockBootloader(this, this.serial, 'boot')));
      return;
    }
    const known = knownFw(fwCrc32(image, FW_HEADER_BYTES));
    const version = (f.version ?? known?.appVersion ?? '0.1.0.0').split('.').map((n) => Number(n) & 0xff);
    const xinput = known ? (known.gamepad ? !f.noGamepad : f.staleGamepad) : false;
    const seed: DemoSeed = xinput ? 'pro-xinput' : 'pro';
    this.later(f.appDelayMs, () => this.plug(new MockTransport({
      seed, serial: [...this.serial], firmware: version, fastLedReplies: this.opts.fastLedReplies, fwBus: this,
    })));
  }

  /** Demo helper: the keyboard is unplugged and comes back in its bootloader (rescue mode). */
  replugAsBootloader(): void {
    for (const d of this.devices.filter((x) => x instanceof MockTransport && x.fwLabel === 'app')) this.unplug(d);
    this.later(800, () => this.plug(new MockBootloader(this, this.serial, 'boot')));
  }

  // ---------------------------------------------------------------- FwPort

  async list(): Promise<BaseTransport[]> {
    return this.devices.filter((d) => d.connected && this.granted.has(d));
  }

  async request(): Promise<BaseTransport[]> {
    const live = this.devices.filter((d) => d.connected);
    const pick = this.flags.choose === 'cancel' ? []
      : this.flags.choose === 'max' ? live.filter((d) => d instanceof MockTransport && d.fwLabel === 'max')
        : live.filter((d) => d instanceof MockBootloader);
    for (const d of pick) this.granted.add(d);
    return pick;
  }

  onConnect(cb: () => void): () => void {
    this.connectListeners.add(cb);
    return () => this.connectListeners.delete(cb);
  }

  async release(): Promise<void> {
    // a demo device stays on the bus
  }

  keep(): void {
    // the bus never closes a device
  }

  /** The same demo keyboard on a new connection (its edits of this session are not kept). */
  async reopen(t: BaseTransport): Promise<BaseTransport> {
    if (!(t instanceof MockTransport)) throw new Error('not a demo keyboard');
    const fresh = new MockTransport({ ...t.initOpts, fwBus: this });
    this.devices = this.devices.map((d) => (d === t ? fresh : d));
    this.granted.add(fresh);
    t.unplug();
    return fresh;
  }
}
