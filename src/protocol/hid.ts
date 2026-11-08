// WebHID transport for the AE64 vendor configuration collection (FFB0:0001, report ID 0, 64 bytes).

import type { Ae64Transport, Bytes } from './types';
import { CONFIG_USAGE, CONFIG_USAGE_PAGE, HID_FILTERS, REPORT_ID } from './constants';
import { BaseTransport, TransportTimeoutError, replyMatches } from './client';
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

function isAe64(device: HIDDevice): boolean {
  return HID_FILTERS.some((f) => f.vendorId === device.vendorId && f.productId === device.productId) && hasConfigCollection(device);
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

  constructor(private readonly device: HIDDevice) {
    super();
  }

  get productName(): string {
    return this.device.productName || 'AE64';
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

async function openDevice(device: HIDDevice): Promise<HidTransport> {
  const t = new HidTransport(device);
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
  const devices = await navigator.hid.requestDevice({ filters: [...HID_FILTERS] });
  const device = devices.find(isAe64);
  if (!device) throw new NoDeviceSelectedError();
  return openDevice(device);
}

/** Re-open an already-granted keyboard (no permission prompt). Null if none is available. */
export async function reconnectGrantedHid(): Promise<Ae64Transport | null> {
  if (!webHidAvailable()) return null;
  const device = (await navigator.hid.getDevices()).find(isAe64);
  return device ? openDevice(device) : null;
}
