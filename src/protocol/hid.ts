// WebHID transport for the AE64 vendor configuration collection (FFB0:0001, report ID 0, 64 bytes).

import type { Ae64Transport, Bytes } from './types';
import { CONFIG_USAGE, CONFIG_USAGE_PAGE, FW_PROBE_FILTER, HID_FILTERS, REPORT_ID, VENDOR_ID } from './constants';
import { BaseTransport, TransportTimeoutError, replyMatches } from './client';
import type { FwPort } from './fwPort';
import { t as tr } from '../i18n/vi';

/** Quiet period after a timeout: late replies to the timed-out request are dropped before the next one. */
const QUIET_AFTER_TIMEOUT_MS = 100;

interface Pending {
  /** The request frame; replies must match it (replyMatches). */
  frame: Uint8Array;
  resolve: (b: Bytes) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function hasConfigCollection(device: HIDDevice): boolean {
  return device.collections.some((c) => c.usagePage === CONFIG_USAGE_PAGE && c.usage === CONFIG_USAGE);
}

export function isAe64(device: HIDDevice): boolean {
  return HID_FILTERS.some((f) => f.vendorId === device.vendorId && f.productId === device.productId) && hasConfigCollection(device);
}

/** The vendor collection of vendor 1CA6 whatever the product ID (FW_PROBE_FILTER): an AE64 in app mode, or one in its bootloader. */
export function matchesProbe(device: HIDDevice): boolean {
  return device.vendorId === VENDOR_ID && hasConfigCollection(device);
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

export class HidTransport extends BaseTransport {
  readonly kind = 'hid' as const;
  private pending: Pending | null = null;
  private quietUntil = 0;
  private readonly onReport = (e: HIDInputReportEvent) => this.handleReport(e);
  private readonly onHidDisconnect = (e: HIDConnectionEvent) => {
    if (e.device !== this.device) return;
    this.failPending(new Error(tr('error.disconnected')));
    this.teardown();
    this.emitDisconnect();
  };

  /**
   * `probeOnly`: found through FW_PROBE_FILTER, not HID_FILTERS (an unknown product ID, e.g. a bootloader). The device store sends
   * it `01 02` only, and goes on only for an AE64 in its app (isAe64) or a bootloader (rescue).
   */
  readonly probeOnly: boolean;

  constructor(private readonly device: HIDDevice, opts: { probeOnly?: boolean } = {}) {
    super();
    this.probeOnly = opts.probeOnly ?? false;
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
    return this.device.opened;
  }

  async open(): Promise<void> {
    if (!hasConfigCollection(this.device)) throw new Error(tr('error.noConfigEndpoint'));
    if (!this.device.opened) await this.device.open();
    this.device.addEventListener('inputreport', this.onReport);
    navigator.hid.addEventListener('disconnect', this.onHidDisconnect);
  }

  async close(): Promise<void> {
    this.failPending(new Error(tr('error.connectionClosed')));
    this.teardown();
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
  const t = new HidTransport(device, opts);
  try {
    await t.open();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(/open|access|denied/i.test(msg)
      ? tr('error.openFailedOtherApp')
      : msg);
  }
  return t;
}

/** requestDevice + open. Throws readable (Vietnamese) errors. */
export async function connectHid(): Promise<Ae64Transport> {
  if (!webHidAvailable()) throw new Error(tr('error.noWebHid'));
  // FW_PROBE_FILTER too: a keyboard in its bootloader has another product ID (DESIGN FW §3.6). Such a device is probe-only.
  const devices = await navigator.hid.requestDevice({ filters: [...HID_FILTERS, FW_PROBE_FILTER] });
  const device = devices.find(isAe64) ?? devices.find(matchesProbe);
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
export function rememberDevice(productId: number | undefined): void {
  if (productId === undefined) return;
  try {
    localStorage.setItem(LAST_DEVICE_KEY, JSON.stringify({ vendorId: VENDOR_ID, productId }));
  } catch {
    // storage unavailable: the next reconnect simply takes the first granted keyboard
  }
}

/** Re-open an already-granted keyboard (no permission prompt): the remembered model if plugged in, else the first. Null if none. */
export async function reconnectGrantedHid(): Promise<Ae64Transport | null> {
  if (!webHidAvailable()) return null;
  const all = await navigator.hid.getDevices();
  const granted = all.filter(isAe64);
  const last = readLastDevice();
  const device = (last && granted.find((d) => d.vendorId === last.vendorId && d.productId === last.productId)) || granted[0];
  if (device) return openDevice(device);
  // No AE64 in its app: a granted keyboard in its bootloader opens the rescue page (probe-only: `01 02` first, DESIGN FW §3.6).
  const probe = all.find(matchesProbe);
  return probe ? openDevice(probe, { probeOnly: true }) : null;
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
    if (t instanceof HidTransport) this.open.set(t.hidDevice, t);
  }

  private async openAll(devices: HIDDevice[]): Promise<BaseTransport[]> {
    const out: BaseTransport[] = [];
    for (const d of devices) {
      if (!matchesProbe(d)) continue;
      let t = this.open.get(d);
      if (!t || (!t.connected && !d.opened)) {
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
    await t.close().catch(() => undefined);
    return openDevice(d, { probeOnly: t.probeOnly });
  }

  async release(t: BaseTransport): Promise<void> {
    if (!(t instanceof HidTransport) || !this.mine.has(t)) return;
    this.mine.delete(t);
    this.open.delete(t.hidDevice);
    await t.close().catch(() => undefined);
  }
}
