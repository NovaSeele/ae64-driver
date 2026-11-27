// WebHID transport for the AE64 vendor configuration collection (FFB0:0001, report ID 0, 64 bytes).

import type { Ae64Transport, Bytes, TransportIdentity } from './types';
import { CONNECT_HID_FILTERS, FW_PROBE_FILTER, PLATFORM_VENDOR_IDS, REPORT_ID, VENDOR_ID } from './constants';
import { BaseTransport, TransportTimeoutError, replyMatches } from './client';
import { hasConfigCollection, isAe64 } from './classify';
import type { HidDeviceLike } from './classify';
import type { FwPort } from './fwPort';
import { TabLockedError, deviceLockName, takeLock } from './tabLock';
import { t as tr } from '../i18n/vi';

export { isAe64 };
export type { HidDeviceLike };

/** Quiet period after a timeout: late replies to the timed-out request are dropped before the next one. */
const QUIET_AFTER_TIMEOUT_MS = 100;

interface Pending {
  /** The request frame; replies must match it (replyMatches). */
  frame: Uint8Array;
  resolve: (b: Bytes) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** The vendor collection of vendor 1CA6 whatever the product ID (FW_PROBE_FILTER): an AE64 in app mode, or one in its bootloader. */
export function matchesProbe(device: HIDDevice): boolean {
  return device.vendorId === VENDOR_ID && hasConfigCollection(device);
}

/** Platform vendor IDs (1CA6, 38A6, 36B5) with the FFB0:01 vendor collection (DESIGN MKB §4). Never used by FwPort. */
export function matchesPlatform(device: HidDeviceLike): boolean {
  return PLATFORM_VENDOR_IDS.includes(device.vendorId) && hasConfigCollection(device);
}

function reportByteSize(report: HIDReportInfo): number {
  let bits = 0;
  for (const item of report.items ?? []) {
    bits += (item.reportSize ?? 0) * (item.reportCount ?? 0);
  }
  return bits / 8;
}

/** Null-safe USB identity extracted from a WebHID device (DESIGN MKB §3.1, N6). */
export function identityFromHid(device: HIDDevice): TransportIdentity {
  return {
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName ?? '',
    collections: (device.collections ?? []).map((c) => ({
      usagePage: c.usagePage ?? 0,
      usage: c.usage ?? 0,
      inputReports: (c.inputReports ?? []).map(reportByteSize),
      outputReports: (c.outputReports ?? []).map(reportByteSize),
    })),
  };
}

export class NoDeviceSelectedError extends Error {
  constructor() {
    super(tr('error.noAe64Selected'));
    this.name = 'NoDeviceSelectedError';
  }
}

export function webHidAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'hid' in navigator && Boolean(navigator.hid);
}

/**
 * The connection that opened each device. WebHID's `opened` belongs to the page, not to a connection: closing one HidTransport
 * closes the device under every other HidTransport of it. Only the owner closes it (FW review FW-1).
 */
const owners = new WeakMap<HIDDevice, HidTransport>();
/** Every open connection of each device (W-13): the owner's close hands the device to another one instead of closing it. */
const users = new WeakMap<HIDDevice, Set<HidTransport>>();

export class HidTransport extends BaseTransport {
  readonly kind = 'hid' as const;
  private pending: Pending | null = null;
  private quietUntil = 0;
  /** close() was called: this connection is over, whoever owns the device (W-13). */
  private closed = false;
  /** This connection's share of the page's lock on the device (W-11): released when it closes or the device leaves. */
  private unlock: (() => void) | null = null;
  private readonly onReport = (e: HIDInputReportEvent) => this.handleReport(e);
  private readonly onHidDisconnect = (e: HIDConnectionEvent) => {
    if (e.device !== this.device) return;
    this.failPending(new Error(tr('error.disconnected')));
    this.teardown();
    this.dropLock();
    this.emitDisconnect();
  };

  /**
   * `probeOnly`: found through FW_PROBE_FILTER, not HID_FILTERS (an unknown product ID, e.g. a bootloader). The device store sends
   * it `01 02` only, and goes on only for an AE64 in its app (isAe64) or a bootloader (rescue).
   */
  readonly probeOnly: boolean;
  private readonly _identity: TransportIdentity;

  constructor(private readonly device: HIDDevice, opts: { probeOnly?: boolean } = {}) {
    super();
    this.probeOnly = opts.probeOnly ?? false;
    this._identity = identityFromHid(device);
  }

  override get identity(): TransportIdentity {
    return this._identity;
  }

  /** The WebHID device behind this transport (the firmware port maps devices to transports with it). */
  get hidDevice(): HIDDevice {
    return this.device;
  }

  get productName(): string {
    return this.device.productName || 'AE64';
  }

  get productId(): number {
    return this.device.productId;
  }

  get connected(): boolean {
    return !this.closed && this.device.opened;
  }

  async open(): Promise<void> {
    if (!hasConfigCollection(this.device)) throw new Error(tr('error.noConfigEndpoint'));
    if (!this.device.opened) {
      await this.device.open();
      owners.set(this.device, this);
    } else if (!owners.has(this.device)) {
      owners.set(this.device, this);
    }
    this.closed = false;
    let set = users.get(this.device);
    if (!set) users.set(this.device, (set = new Set()));
    set.add(this);
    this.device.addEventListener('inputreport', this.onReport);
    navigator.hid.addEventListener('disconnect', this.onHidDisconnect);
  }

  /**
   * Stops this connection: from now on it reports `connected === false` and refuses requests at once. The device is closed only
   * when this connection owns it and no other open connection of this page uses it (that one becomes the owner).
   */
  async close(): Promise<void> {
    try {
      await this.closeDevice();
    } finally {
      this.dropLock(); // after the device is closed: another page never opens it while this one still has it open
    }
  }

  /** Keeps the device lock share taken before open() (W-11). */
  holdLock(unlock: () => void): void {
    this.dropLock();
    this.unlock = unlock;
  }

  private dropLock(): void {
    const u = this.unlock;
    this.unlock = null;
    u?.();
  }

  private async closeDevice(): Promise<void> {
    this.closed = true;
    this.failPending(new Error(tr('error.connectionClosed')));
    this.teardown();
    const set = users.get(this.device);
    set?.delete(this);
    if (owners.get(this.device) !== this) return;
    const heir = set ? [...set].find((t) => !t.closed) : undefined;
    if (heir) {
      owners.set(this.device, heir);
      return;
    }
    owners.delete(this.device);
    if (this.device.opened) await this.device.close();
  }

  private teardown(): void {
    this.device.removeEventListener('inputreport', this.onReport);
    navigator.hid.removeEventListener('disconnect', this.onHidDisconnect);
  }

  private failPending(err: Error): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    p.reject(err);
  }

  private handleReport(e: HIDInputReportEvent): void {
    const bytes = new Uint8Array(e.data.buffer.slice(e.data.byteOffset, e.data.byteOffset + e.data.byteLength));
    const p = this.pending;
    if (!p || !replyMatches(p.frame, bytes)) return; // unsolicited, or a late reply to an earlier request
    this.pending = null;
    clearTimeout(p.timer);
    p.resolve(bytes);
  }

  /** Drops every input report for `ms`: nothing is pending meanwhile (handleReport drops it), and the next request waits. */
  protected override async drainInput(ms: number): Promise<void> {
    this.quietUntil = Math.max(this.quietUntil, performance.now() + ms);
    await new Promise((r) => setTimeout(r, ms));
  }

  protected async exchange(frame: Uint8Array, timeoutMs: number): Promise<Bytes> {
    if (this.closed) throw new Error(tr('error.connectionClosed'));
    // After a timeout the keyboard may still answer the old request: let that reply arrive (and be
    // dropped, nothing is pending) before asking anything else.
    const quiet = this.quietUntil - performance.now();
    if (quiet > 0) await new Promise((r) => setTimeout(r, quiet));
    return new Promise<Bytes>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        this.quietUntil = performance.now() + QUIET_AFTER_TIMEOUT_MS;
        reject(new TransportTimeoutError(Array.from(frame)));
      }, timeoutMs);
      this.pending = { frame, resolve, reject, timer };
      this.device.sendReport(REPORT_ID, frame as Uint8Array<ArrayBuffer>).catch((err: unknown) => {
        if (this.pending?.timer !== timer) return;
        this.pending = null;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }
}

async function openDevice(device: HIDDevice, opts: { probeOnly?: boolean } = {}): Promise<HidTransport> {
  // W-11: the page's lock on this USB product first; held by another tab or window, the device is not opened and nothing is sent.
  const unlock = await takeLock(deviceLockName(device.vendorId, device.productId));
  if (!unlock) throw new TabLockedError(device.vendorId, device.productId);
  const t = new HidTransport(device, opts);
  try {
    await t.open();
  } catch (err) {
    unlock();
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/open|access|denied/i.test(msg)
      ? tr('error.openFailedOtherApp')
      : msg);
  }
  t.holdLock(unlock);
  return t;
}

/** requestDevice + open. Throws readable (Vietnamese) errors. */
export async function connectHid(): Promise<Ae64Transport> {
  if (!webHidAvailable()) throw new Error(tr('error.noWebHid'));
  // AE64 PIDs, 1CA6 probe (bootloaders & 1CA6 platform boards), then 38A6 and 36B5 (DESIGN MKB §4).
  const devices = await navigator.hid.requestDevice({ filters: [...CONNECT_HID_FILTERS] });
  const device = devices.find(isAe64) ?? devices.find(matchesPlatform);
  if (!device) throw new NoDeviceSelectedError();
  return openDevice(device, { probeOnly: !isAe64(device) });
}

const LAST_DEVICE_KEY = 'ae64.lastDevice';

function readLastDevice(): { vendorId: number; productId: number } | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LAST_DEVICE_KEY) ?? 'null');
    const o = v as { vendorId?: unknown; productId?: unknown } | null;
    return o && typeof o.vendorId === 'number' && typeof o.productId === 'number' ? { vendorId: o.vendorId, productId: o.productId } : null;
  } catch {
    return null;
  }
}

/** Remember the real keyboard that was just connected (a UI pref: reconnect prefers it when several are granted). */
export function rememberDevice(vendorId: number | undefined, productId: number | undefined): void {
  if (vendorId === undefined || productId === undefined) return;
  try {
    localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify({ vendorId, productId }));
  } catch {
    // storage unavailable: the next reconnect simply takes the first granted keyboard
  }
}

/** Re-open an already-granted keyboard (no permission prompt): AE64 in its app, else 1CA6 probe, else 38A6/36B5 platform (DESIGN MKB §4). */
export async function reconnectGrantedHid(): Promise<Ae64Transport | null> {
  if (!webHidAvailable()) return null;
  const all = await navigator.hid.getDevices();
  const granted = all.filter(isAe64);
  const last = readLastDevice();
  const device = (last && granted.find((d) => d.vendorId === last.vendorId && d.productId === last.productId)) || granted[0];
  if (device) return openDevice(device);
  // No AE64 in its app: a granted 1CA6 device (e.g. an AE64 bootloader) keeps today's exact pick before 38A6/36B5.
  const probe = all.find(matchesProbe);
  if (probe) return openDevice(probe, { probeOnly: true });
  const platform = all.filter(matchesPlatform);
  const remembered = last && platform.find((d) => d.vendorId === last.vendorId && d.productId === last.productId);
  const other = remembered || platform[0];
  return other ? openDevice(other, { probeOnly: true }) : null;
}

/**
 * The firmware session's view of WebHID (DESIGN FW §3.3): every device of FW_PROBE_FILTER, opened once and kept per device until
 * it is unplugged, so each one gets its single probe. The app connection the session started from is adopted, not reopened.
 */
export class HidFwPort implements FwPort {
  private readonly open = new Map<HIDDevice, HidTransport>();
  private readonly mine = new Set<HidTransport>();

  /** The device store's connection (the session's app): known, never opened again or closed here. */
  adopt(t: unknown): void {
    if (!(t instanceof HidTransport)) return;
    this.open.set(t.hidDevice, t);
    this.mine.delete(t);
  }

  keep(t: BaseTransport): void {
    this.adopt(t);
  }

  private async openAll(devices: HIDDevice[]): Promise<BaseTransport[]> {
    const out: BaseTransport[] = [];
    for (const d of devices) {
      if (!matchesProbe(d)) continue;
      let t = this.open.get(d);
      if (!t || !t.connected) {
        // Opened by a connection of this page the port does not know: never a second transport on the same device.
        if (d.opened) continue;
        try {
          t = await openDevice(d, { probeOnly: !isAe64(d) });
        } catch {
          continue; // another app holds it: not ours to probe
        }
        this.open.set(d, t);
        this.mine.add(t);
        t.onDisconnect(() => { if (this.open.get(d) === t) this.open.delete(d); });
      }
      out.push(t);
    }
    return out;
  }

  async list(): Promise<BaseTransport[]> {
    if (!webHidAvailable()) return [];
    return this.openAll(await navigator.hid.getDevices());
  }

  async request(): Promise<BaseTransport[]> {
    if (!webHidAvailable()) return [];
    try {
      return await this.openAll(await navigator.hid.requestDevice({ filters: [FW_PROBE_FILTER] }));
    } catch {
      return []; // cancelled, or refused without a click: the button stays
    }
  }

  onConnect(cb: () => void): () => void {
    if (!webHidAvailable()) return () => undefined;
    const listener = (e: HIDConnectionEvent): void => { if (matchesProbe(e.device)) cb(); };
    navigator.hid.addEventListener('connect', listener);
    return () => navigator.hid.removeEventListener('connect', listener);
  }

  async reopen(t: BaseTransport): Promise<BaseTransport> {
    if (!(t instanceof HidTransport)) throw new Error('not a WebHID connection');
    const d = t.hidDevice;
    this.mine.delete(t);
    if (this.open.get(d) === t) this.open.delete(d);
    // The page keeps its lock on the device between the close and the new open (W-11).
    const bridge = await takeLock(deviceLockName(d.vendorId, d.productId));
    let fresh: HidTransport;
    try {
      await t.close().catch(() => undefined);
      fresh = await openDevice(d, { probeOnly: t.probeOnly });
    } finally {
      bridge?.();
    }
    // The app's connection from now on: list() returns it (no second transport on the device), release() never closes it.
    this.open.set(d, fresh);
    fresh.onDisconnect(() => { if (this.open.get(d) === fresh) this.open.delete(d); });
    return fresh;
  }

  async release(t: BaseTransport): Promise<void> {
    if (!(t instanceof HidTransport) || !this.mine.has(t)) return;
    this.mine.delete(t);
    this.open.delete(t.hidDevice);
    await t.close().catch(() => undefined);
  }
}
