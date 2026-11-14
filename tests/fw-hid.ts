// A fake WebHID (navigator.hid) over the demo USB bus (FW review FW-TEST-1). Each device of the bus (the keyboard in its app, a
// bootloader, the extras) shows up as a HIDDevice: `opened`, `open`/`close`, `sendReport` (the bus device answers it; the reply
// arrives as an `inputreport` event, late if the bus delays it), `collections`; plugging and unplugging fire `connect` and
// `disconnect`. So HidTransport and HidFwPort run on the same bootloader model as the demo, and the bus still records every
// command and every violation. Stray devices (another vendor, another collection) have no bus device behind them.
import { vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { CONFIG_USAGE, CONFIG_USAGE_PAGE, VENDOR_ID } from '../src/protocol/constants';
import type { BaseTransport } from '../src/protocol/client';
import type { HidTransport } from '../src/protocol/hid';
import { MockTransport } from '../src/protocol/mock';
import type { Bytes } from '../src/protocol/types';
import type { FwMockFlags, MockFwBus } from '../src/protocol/mockFirmware';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { FAKE } from './fw-helpers';

type Collection = { usagePage: number; usage: number };
const CONFIG: Collection[] = [{ usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE }];

/** Reaches the bus device's own exchange (what the keyboard does with a report). */
type Inner = BaseTransport & { exchange(frame: Uint8Array, timeoutMs: number): Promise<Bytes> };

function hidEvent(type: string, props: Record<string, unknown>): Event {
  const e = new Event(type);
  for (const [k, v] of Object.entries(props)) Object.defineProperty(e, k, { value: v });
  return e;
}

export class FakeHidDevice extends EventTarget {
  opened = false;
  /** Still plugged in. */
  present = true;
  opens = 0;
  closes = 0;
  /** Every report sent, as the app built it. */
  readonly sends: Uint8Array[] = [];
  /** `open()` throws this (another app holds the device). */
  openError: Error | null = null;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string;
  readonly collections: Collection[];

  constructor(
    private readonly hid: FakeHid, readonly inner: BaseTransport | null,
    o: { vendorId?: number; productId: number; productName: string; collections?: Collection[] },
  ) {
    super();
    this.vendorId = o.vendorId ?? VENDOR_ID;
    this.productId = o.productId;
    this.productName = o.productName;
    this.collections = o.collections ?? CONFIG;
  }

  /** The bus label of the device behind it (`app`, `boot`, `boot-max`…), or `stray`. */
  get label(): string {
    const i = this.inner as unknown as { fwLabel?: string; label?: string } | null;
    return i?.fwLabel ?? i?.label ?? 'stray';
  }

  async open(): Promise<void> {
    if (this.openError) throw this.openError;
    if (!this.present) throw new DOMException('The device was disconnected.', 'NotFoundError');
    this.opens++;
    this.hid.log.push(`open ${this.label}`);
    this.opened = true;
  }

  async close(): Promise<void> {
    this.closes++;
    this.hid.log.push(`close ${this.label}`);
    this.opened = false;
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    if (!this.opened) throw new DOMException('The device must be opened first.', 'InvalidStateError');
    if (reportId !== 0) throw new Error(`report ID ${reportId}`);
    const view = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const frame = Uint8Array.from(view);
    this.sends.push(frame);
    if (!this.inner) return;
    // The bus device answers in its own time (latency, a busy bootloader, a delayed packet); never on its own timeout.
    (this.inner as Inner).exchange(frame, 600_000).then((reply) => {
      if (!this.opened || !this.present) return;
      const out = new Uint8Array(64);
      out.set(Array.from(reply).slice(0, 64));
      this.dispatchEvent(hidEvent('inputreport', { data: new DataView(out.buffer), device: this, reportId: 0 }));
    }, () => undefined);
  }

  /** The bus unplugged the device behind it. */
  gone(): void {
    if (!this.present) return;
    this.present = false;
    this.opened = false;
    this.hid.log.push(`unplug ${this.label}`);
    this.hid.dispatchEvent(hidEvent('disconnect', { device: this }));
  }
}

export class FakeHid extends EventTarget {
  readonly wrappers = new Map<BaseTransport, FakeHidDevice>();
  /** Devices without a bus device behind them (always granted, never answer). */
  readonly strays: FakeHidDevice[] = [];
  /** The filters of every requestDevice call. */
  readonly requests: { filters: HIDDeviceFilter[] }[] = [];
  /** opens, closes, plugs and unplugs in order: `open boot`, `close app`… */
  readonly log: string[] = [];
  /** What the next chooser returns (once): a pick over the plugged devices, or 'cancel'. Without it: the bus's own choice. */
  next: ((all: FakeHidDevice[]) => FakeHidDevice[]) | 'cancel' | null = null;
  /** Every chooser throws this (no user activation…). */
  requestError: Error | null = null;

  constructor(readonly bus: MockFwBus) {
    super();
    this.sync();
    bus.onConnect(() => this.sync());
  }

  private get busDevices(): BaseTransport[] {
    return (this.bus as unknown as { devices: BaseTransport[] }).devices;
  }

  private grant(t: BaseTransport): void {
    (this.bus as unknown as { granted: WeakSet<BaseTransport> }).granted.add(t);
  }

  /** The HIDDevice of a bus device. */
  of(t: BaseTransport): FakeHidDevice {
    let w = this.wrappers.get(t);
    if (!w) {
      const pid = (t as unknown as { productId: number }).productId;
      w = new FakeHidDevice(this, t, { productId: pid, productName: (t as unknown as { productName: string }).productName });
      this.wrappers.set(t, w);
      const dev = w;
      t.onDisconnect(() => dev.gone());
    }
    return w;
  }

  /** Every bus device plugged in now (granted or not). */
  plugged(): FakeHidDevice[] {
    return this.busDevices.filter((d) => d.connected).map((d) => this.of(d));
  }

  /** The device of this bus label plugged in now (`app`, `boot`…), if any. */
  find(label: string): FakeHidDevice | undefined {
    return this.plugged().find((d) => d.label === label);
  }

  private sync(): void {
    for (const d of this.busDevices) {
      if (this.wrappers.has(d) || !d.connected) continue;
      const w = this.of(d);
      this.log.push(`plug ${w.label}`);
      this.dispatchEvent(hidEvent('connect', { device: w }));
    }
  }

  addStray(o: { vendorId?: number; productId: number; collections?: Collection[]; name?: string }): FakeHidDevice {
    const d = new FakeHidDevice(this, null, { ...o, productName: o.name ?? 'stray' });
    this.strays.push(d);
    return d;
  }

  async getDevices(): Promise<FakeHidDevice[]> {
    return [...(await this.bus.list()).map((d) => this.of(d)), ...this.strays.filter((d) => d.present)];
  }

  async requestDevice(o: { filters: HIDDeviceFilter[] }): Promise<FakeHidDevice[]> {
    this.requests.push({ filters: o.filters.map((f) => ({ ...f })) });
    if (this.requestError) throw this.requestError;
    const next = this.next;
    this.next = null;
    if (next === 'cancel') return [];
    if (next) {
      const pick = next([...this.plugged(), ...this.strays.filter((d) => d.present)]);
      for (const d of pick) if (d.inner) this.grant(d.inner);
      return pick;
    }
    return (await this.bus.request()).map((d) => this.of(d));
  }
}

let installed = false;

export function installFakeHid(bus: MockFwBus): FakeHid {
  const hid = new FakeHid(bus);
  Object.defineProperty(navigator, 'hid', { value: hid, configurable: true, writable: true });
  installed = true;
  return hid;
}

export function removeFakeHid(): void {
  if (!installed) return;
  delete (navigator as unknown as { hid?: unknown }).hid;
  installed = false;
}

/**
 * A real-mode AE64 Pro: the demo keyboard behind the fake WebHID, connected through the device store's Connect button (the
 * chooser returns it), then fake timers. `bus.received` starts empty; `t` is the store's HidTransport.
 */
export async function hidKeyboard(flags: Partial<FwMockFlags> = {}) {
  vi.useRealTimers();
  const app = new MockTransport({ seed: 'pro' });
  const bus = app.fwMock as MockFwBus;
  Object.assign(bus.flags, flags);
  const hid = installFakeHid(bus);
  setActivePinia(createPinia());
  const device = useDeviceStore();
  hid.next = (all) => all.filter((d) => d.inner === app);
  await device.connect();
  const t = device.transport as HidTransport;
  const fw = useFirmwareStore();
  bus.received.length = 0;
  hid.log.length = 0;
  // performance too: HidTransport measures its quiet time with performance.now (the fake clock must move it).
  vi.useFakeTimers({ toFake: [...FAKE.toFake, 'performance'] });
  return { device, t, bus, fw, hid, app, appDev: hid.of(app) };
}
