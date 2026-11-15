// WX4 (connection and calibration): W-11 one page per keyboard (Web Locks), W-12 calibration left running by an earlier page,
// the W-14 items, and the P3 calibration shortcuts and Switch tab load error. Demo, the fake WebHID (tests/fw-hid.ts) and an
// in-memory lock manager only; no real keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../src/App.vue';
import ConnectScreen from '../src/components/shell/ConnectScreen.vue';
import DeviceCard from '../src/components/shell/DeviceCard.vue';
import CalibrationView from '../src/components/calibration/CalibrationView.vue';
import SwitchTab from '../src/components/switch/SwitchTab.vue';
import DiagnosticsPage from '../src/pages/DiagnosticsPage.vue';
import FirmwarePage from '../src/pages/FirmwarePage.vue';
import PerformancePage from '../src/pages/PerformancePage.vue';
import { routes } from '../src/router';
import { BaseTransport } from '../src/protocol/client';
import { MockTransport } from '../src/protocol/mock';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { UnsafeCommandError } from '../src/protocol/safety';
import { FIRMWARE_LOCK, deviceLockName } from '../src/protocol/tabLock';
import { CLOSE_BLOCKED_EVENT, desktopShell, installDesktopCloseGuard } from '../src/data/desktopClose';
import { readCalibrationFlag } from '../src/data/calibrationFlag';
import { useDeviceStore } from '../src/stores/device';
import { useCalibrationStore } from '../src/stores/calibration';
import { useFirmwareStore } from '../src/stores/firmware';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { setLocale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';
import { CRC, fileOf, makeFw } from './fw-helpers';
import { installFakeHid, removeFakeHid } from './fw-hid';
import type { FakeHidDevice } from './fw-hid';

const FLAG_KEY = 'ae64.calibrating';
let wrappers: VueWrapper[] = [];
const keep = <T extends VueWrapper>(w: T): T => { wrappers.push(w); return w; };

/** navigator.locks in memory. `other(name)` is another page holding `name` until its release. */
class FakeLocks {
  readonly held = new Map<string, 'page' | 'other'>();
  readonly asked: string[] = [];
  constructor(private readonly order: string[] = []) {}
  async request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown> {
    this.asked.push(name);
    this.order.push(`lock ${name}`);
    if (!opts.ifAvailable) throw new Error('the app always asks ifAvailable');
    if (this.held.has(name)) return cb(null);
    this.held.set(name, 'page');
    try {
      return await cb({ name, mode: 'exclusive' });
    } finally {
      this.held.delete(name);
    }
  }
  async query() {
    return { held: [...this.held.keys()].map((name) => ({ name, mode: 'exclusive' })), pending: [] };
  }
  other(name: string): () => void {
    this.held.set(name, 'other');
    return () => { if (this.held.get(name) === 'other') this.held.delete(name); };
  }
}
function installLocks(order: string[] = []): FakeLocks {
  const locks = new FakeLocks(order);
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true, writable: true });
  return locks;
}
function removeLocks(): void {
  delete (navigator as unknown as { locks?: unknown }).locks;
}

const toasts = () => useToast().items.value;
/** Every frame sent by any transport from now on, as "ff cc xx" (read with `()`; `.mark()` starts again from now). */
function outFrames(): (() => string[]) & { mark(): void } {
  const spy = vi.spyOn(BaseTransport.prototype as unknown as { log: (d: string, b: Uint8Array) => void }, 'log');
  let from = spy.mock.calls.length;
  const list = () => spy.mock.calls.slice(from).filter((c) => c[0] === 'out')
    .map((c) => [...(c[1] as Uint8Array).slice(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join(' '));
  return Object.assign(list, { mark: () => { from = spy.mock.calls.length; } });
}
function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  localStorage.clear();
  useToast().items.value = [];
  setActivePinia(createPinia());
  setLocale('vi');
});
afterEach(async () => {
  for (const w of wrappers) { try { w.unmount(); } catch { /* already gone */ } }
  wrappers = [];
  // the page's locks live in the module (tabLock): a connection left open would keep its share into the next test
  await useDeviceStore().disconnect().catch(() => undefined);
  await flushPromises();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  removeFakeHid();
  removeLocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('W-11: one page per keyboard (Web Locks)', () => {
  /** The demo Pro behind the fake WebHID, not connected yet; `order` logs locks, opens and sends in turn. */
  function realPro() {
    const order: string[] = [];
    const locks = installLocks(order);
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    const hid = installFakeHid(bus);
    const dev = hid.of(app);
    const open = dev.open.bind(dev);
    dev.open = async () => { order.push('open'); return open(); };
    const send = dev.sendReport.bind(dev);
    dev.sendReport = async (id: number, data: BufferSource) => {
      const v = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      order.push(`send ${v[0]} ${v[1]}`);
      return send(id, data);
    };
    hid.next = (all) => all.filter((d) => d.inner === app);
    return { order, locks, app, bus, hid, dev, name: deviceLockName(dev.vendorId, dev.productId), device: useDeviceStore() };
  }

  it('another page holds the keyboard: no open, no 01 02, the message; it lets go → "Try again" connects', async () => {
    const s = realPro();
    const release = s.locks.other(s.name);
    await s.device.connect();
    expect(s.device.connected).toBe(false);
    expect(s.device.otherTab).toBe(true);
    expect(s.device.error).toBe(tr('device.otherTab'));
    expect(s.dev.opens).toBe(0);
    expect(s.dev.sends).toEqual([]);
    expect(s.order).toEqual([`lock ${s.name}`]);
    const w = keep(mount(ConnectScreen, { attachTo: document.body }));
    await flushPromises();
    const box = w.find('[data-test="other-tab"]');
    expect(box.exists()).toBe(true);
    expect(box.text()).toContain(tr('device.otherTab'));
    expect(box.attributes('role')).toBe('alert');
    // still held there: "Try again" opens nothing
    await w.find('[data-test="other-tab-retry"]').trigger('click');
    await flushPromises();
    expect(s.device.connected).toBe(false);
    expect(s.dev.opens).toBe(0);
    expect(s.dev.sends).toEqual([]);
    // the first page disconnects (its lock goes): "Try again" connects, no chooser
    release();
    const choosers = s.hid.requests.length;
    await w.find('[data-test="other-tab-retry"]').trigger('click');
    await vi.waitFor(() => expect(s.device.connected).toBe(true), { timeout: 10000 });
    expect(s.hid.requests.length).toBe(choosers);
    expect(s.device.otherTab).toBe(false);
    expect(s.locks.held.get(s.name)).toBe('page');
    await flushPromises();
    expect(w.find('[data-test="other-tab"]').exists()).toBe(false);
  });

  it('the auto-reconnect at start-up says it too (status error, the message)', async () => {
    const s = realPro();
    await s.device.connect(); // grants the keyboard
    await s.device.disconnect();
    s.locks.other(s.name);
    expect(await s.device.tryAutoReconnect()).toBe(false);
    expect(s.device.otherTab).toBe(true);
    expect(s.device.status).toBe('error');
    expect(s.dev.opens).toBe(1); // the first connection only
  });

  it('the lock is asked before the first command, and released on disconnect and when the keyboard is unplugged', async () => {
    const s = realPro();
    await s.device.connect();
    expect(s.device.connected).toBe(true);
    expect(s.order.slice(0, 3)).toEqual([`lock ${s.name}`, 'open', 'send 1 2']);
    expect(s.locks.held.get(s.name)).toBe('page');
    await s.device.disconnect();
    await flushPromises();
    expect(s.locks.held.has(s.name)).toBe(false);
    // again, then pulled out
    await s.device.tryAutoReconnect();
    expect(s.device.connected).toBe(true);
    expect(s.locks.held.get(s.name)).toBe('page');
    s.dev.gone();
    await flushPromises();
    expect(s.locks.held.has(s.name)).toBe(false);
  });

  it('a Max and a Pro have their own locks (two models may be open in two tabs)', () => {
    expect(deviceLockName(0x1ca6, 0x300d)).not.toBe(deviceLockName(0x1ca6, 0x300a));
  });

  it('the demo never asks for a lock (device, and a firmware session on the demo)', async () => {
    const locks = installLocks();
    const device = useDeviceStore();
    await device.connectDemo('max');
    await device.switchDemoModel('pro');
    const fw = useFirmwareStore();
    fw.setEnabled(true);
    await fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    fw.typed = 'AE64 Pro';
    const started = fw.start();
    await vi.waitFor(() => expect(fw.phase).not.toBe('preflight'), { timeout: 10000 });
    expect(fw.active).toBe(true);
    expect(locks.asked).toEqual([]);
    void started;
  });

  it('no Web Locks: a real keyboard connects as before, and Diagnostics says once that the check is not there', async () => {
    const s = realPro();
    removeLocks();
    await s.device.connect();
    expect(s.device.connected).toBe(true);
    const router = makeRouter();
    await router.push('/diagnostics');
    const w = keep(mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(w.findAll('[data-test="no-tab-lock"]').length).toBe(1);
    expect(w.find('[data-test="no-tab-lock"]').text()).toBe(tr('diagnostics.noTabLock'));
    w.unmount();
    wrappers = [];
    installLocks();
    const w2 = keep(mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(w2.find('[data-test="no-tab-lock"]').exists()).toBe(false);
  });

  it('firmware: another window holds ae64-firmware → no "Bắt đầu"; a start that loses the race sends no 08', async () => {
    const s = realPro();
    await s.device.connect();
    const fw = useFirmwareStore();
    fw.setEnabled(true);
    const release = s.locks.other(FIRMWARE_LOCK);
    const router = makeRouter();
    await router.push('/firmware');
    const w = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    await fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    fw.typed = 'AE64 Pro';
    await flushPromises();
    expect(fw.otherWindow).toBe(true);
    expect(fw.canStart).toBe(false);
    const buttons = () => w.findAll('button').map((b) => b.text());
    expect(buttons()).not.toContain(tr('fw.s2.start'));
    expect(w.find('[data-test="fw-other-window"]').text()).toContain(tr('fw.otherWindow'));
    // the check said free, then the other window took it: start() refuses at the press, before anything is sent
    fw.otherWindow = false;
    expect(fw.canStart).toBe(true);
    s.bus.received.length = 0;
    await fw.start();
    expect(fw.phase).toBe('preflightFail');
    expect(fw.error?.key).toBe('fw.err.otherWindow');
    expect(fw.active).toBe(false);
    expect(s.bus.received.filter((r) => r.cmd.startsWith('08'))).toEqual([]);
    // free again: "Thử lại" brings the button back
    release();
    await w.find('[data-test="fw-other-window"] button').trigger('click');
    await flushPromises();
    expect(fw.otherWindow).toBe(false);
  });

  it('firmware rescue mode without ae64-firmware: rescue opens view-only, no "Ghi firmware"; the lock free → the write is offered', async () => {
    const order: string[] = [];
    const locks = installLocks(order);
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    bus.plug(new MockBootloader(bus, bus.serial, 'boot'));
    const hid = installFakeHid(bus);
    const release = locks.other(FIRMWARE_LOCK);
    const device = useDeviceStore();
    const fw = useFirmwareStore();
    fw.setEnabled(true);
    hid.next = (all) => all.filter((d) => d.label === 'boot');
    await device.connect();
    await flushPromises();
    expect(fw.rescue).toBe(true);
    expect(fw.otherWindow).toBe(true);
    await fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    await flushPromises();
    expect(fw.canRescueWrite).toBe(false);
    const router = makeRouter();
    await router.push({ path: '/firmware', query: { rescue: '1' } });
    const w = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(w.findAll('button').map((b) => b.text())).not.toContain(tr('fw.rescue.write'));
    expect(w.find('[data-test="fw-other-window"]').text()).toContain(tr('fw.otherWindow'));
    const boot = hid.find('boot') as FakeHidDevice;
    const sent = boot.sends.length;
    await fw.rescueWrite();
    expect(boot.sends.length).toBe(sent); // nothing written
    // the other window is done: "Thử lại" takes the lock, the write is offered
    release();
    await w.find('[data-test="fw-other-window"] button').trigger('click');
    await flushPromises();
    expect(fw.otherWindow).toBe(false);
    expect(locks.held.get(FIRMWARE_LOCK)).toBe('page');
    expect(fw.canRescueWrite).toBe(true);
    expect(w.findAll('button').map((b) => b.text())).toContain(tr('fw.rescue.write'));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('W-12: calibration left running by an earlier page', () => {
  async function demoSerial(seed: 'max' | 'pro' = 'max'): Promise<string> {
    const device = useDeviceStore();
    await device.connectDemo(seed);
    const s = device.info!.serialHex;
    await device.disconnect();
    setActivePinia(createPinia());
    useToast().items.value = [];
    return s;
  }
  const seed = (serial: string) => localStorage.setItem(FLAG_KEY, JSON.stringify({ serial, at: 1 }));

  it('the flag names this keyboard: 02 06 01 right after 01 02 (no commit), then the toast; the flag is cleared; writes go', async () => {
    const serial = await demoSerial();
    seed(serial);
    const out = outFrames();
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(out()[0].startsWith('01 02')).toBe(true);
    expect(out()[1]).toBe('02 06 01');
    expect(out().filter((x) => x.startsWith('02 06')).length).toBe(1);
    expect(out().some((x) => x.startsWith('02 02'))).toBe(false); // no commit
    expect(toasts().map((x) => [x.kind, x.text])).toContainEqual(['warn', tr('calibration.leftStopped')]);
    expect(localStorage.getItem(FLAG_KEY)).toBeNull();
    expect(device.calibrationLocked()).toBe(false);
    expect(device.staleCalibration).toBe(false);
    const mock = device.transport as MockTransport;
    await mock.setKeycode(device.keys[20], 4, 0); // not refused
  });

  it('a flag for another keyboard: nothing sent, the flag kept', async () => {
    await demoSerial();
    seed('0123456789abcdef01234567');
    const out = outFrames();
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(out().filter((x) => x.startsWith('02 06'))).toEqual([]);
    expect(readCalibrationFlag()?.serial).toBe('0123456789abcdef01234567');
    expect(toasts().some((x) => x.text === tr('calibration.leftStopped'))).toBe(false);
  });

  it('the stop fails: the flag kept, writes refused, the message with a retry; the Performance tabs stay locked; Try again stops it', async () => {
    const serial = await demoSerial();
    seed(serial);
    const stop = vi.spyOn(MockTransport.prototype, 'stopCalibration').mockRejectedValueOnce(new Error('no reply'));
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(device.connected).toBe(true);
    expect(device.staleCalibration).toBe(true);
    expect(device.calibrationLocked()).toBe(true);
    expect(readCalibrationFlag()?.serial).toBe(serial);
    const failed = toasts().find((x) => x.text === tr('calibration.leftStopFailed'))!;
    expect(failed.kind).toBe('error');
    expect(failed.action?.label).toBe(tr('calibration.leftRetry'));
    const mock = device.transport as MockTransport;
    await expect(mock.setKeycode(device.keys[20], 4, 0)).rejects.toThrow(UnsafeCommandError);
    // the Performance tabs: all but Calibration locked (reader A: the transport's lock, not only cal.phase)
    const cal = useCalibrationStore();
    expect(cal.phase).toBe('idle');
    const router = makeRouter();
    await router.push({ path: '/performance', query: { tab: 'calibration' } });
    const page = keep(mount(PerformancePage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    const tabBtn = (title: string) => page.findAll('button').find((b) => b.text().includes(title))!;
    expect(tabBtn(tr('ptab.travel')).attributes('disabled')).toBeDefined();
    expect(page.text()).toContain(tr('ptab.locked'));
    // the device card offers the retry too
    const card = keep(mount(DeviceCard, { attachTo: document.body }));
    expect(card.find('[data-test="stale-calibration"]').exists()).toBe(true);
    await card.find('[data-test="stale-calibration"] button').trigger('click');
    await vi.waitFor(() => expect(device.staleCalibration).toBe(false), { timeout: 5000 });
    expect(stop).toHaveBeenCalledTimes(2);
    expect(device.calibrationLocked()).toBe(false);
    expect(localStorage.getItem(FLAG_KEY)).toBeNull();
    await flushPromises();
    expect(card.find('[data-test="stale-calibration"]').exists()).toBe(false);
    expect(tabBtn(tr('ptab.travel')).attributes('disabled')).toBeUndefined();
    await mock.setKeycode(device.keys[20], 4, 0);
  });

  it('02 06 00 writes the flag; Finish / Cancel / a stop answered clears it', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const cal = useCalibrationStore();
    await cal.start();
    expect(cal.phase).toBe('running');
    expect(readCalibrationFlag()?.serial).toBe(device.info!.serialHex);
    expect(await cal.cancel()).toBe(true);
    expect(readCalibrationFlag()).toBeNull();
  });

  it('pagehide while calibrating: 02 06 01, no commit, the flag cleared', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const cal = useCalibrationStore();
    await cal.start();
    const out = outFrames();
    cal.onPageHide();
    await vi.waitFor(() => expect(cal.phase).toBe('idle'), { timeout: 5000 });
    expect(out()).toContain('02 06 01');
    expect(out().some((x) => x.startsWith('02 02'))).toBe(false);
    expect(readCalibrationFlag()).toBeNull();
    // idle and unlocked: pagehide sends nothing
    out.mark();
    cal.onPageHide();
    await flushPromises();
    expect(out()).toEqual([]);
  });

  it('the desktop window holds its close while calibrating (and a blocked close says why, never force-closes)', async () => {
    const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
    vi.spyOn(desktopShell, 'get').mockReturnValue({ invoke });
    const device = useDeviceStore();
    await device.connectDemo('max');
    const cal = useCalibrationStore();
    const fw = useFirmwareStore();
    const remove = installDesktopCloseGuard(() => fw.active || cal.holdsWindow);
    const holds = () => invoke.mock.calls.filter((c) => c[0] === 'hold_close').map((c) => (c[1] as { on: boolean }).on);
    expect(holds()).toEqual([false]);
    await cal.start();
    await flushPromises();
    expect(holds()).toEqual([false, true]);
    const onBlocked = () => cal.onCloseBlocked();
    window.addEventListener(CLOSE_BLOCKED_EVENT, onBlocked);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    expect(invoke.mock.calls.some((c) => c[0] === 'force_close')).toBe(false);
    expect(toasts().some((x) => x.text === tr('calibration.closeBlocked'))).toBe(true);
    await cal.cancel();
    await flushPromises();
    expect(holds()).toEqual([false, true, false]);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    expect(invoke.mock.calls.filter((c) => c[0] === 'force_close').length).toBe(1);
    window.removeEventListener(CLOSE_BLOCKED_EVENT, onBlocked);
    remove();
  });

  it('main.ts holds on calibration too, and installs the pagehide stop', async () => {
    const { readFileSync } = await import('node:fs');
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain('installDesktopCloseGuard(() => useFirmwareStore(pinia).active || useCalibrationStore(pinia).holdsWindow);');
    expect(main).toContain("window.addEventListener('pagehide', () => useCalibrationStore(pinia).onPageHide());");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('W-14', () => {
  it('a disconnect while the polling rate is being applied (the USB restart beat the reply): no "keyboard lost" toast', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const settings = useSettingsStore();
    settings.pollingState = 'applying';
    (device.transport as MockTransport).unplug();
    await flushPromises();
    expect(device.status).toBe('idle');
    expect(toasts().some((x) => x.kind === 'error')).toBe(false);
    // the same disconnect outside a polling change does say it
    settings.pollingState = 'idle';
    await device.connectDemo('max');
    (device.transport as MockTransport).unplug();
    await flushPromises();
    expect(toasts().map((x) => x.text)).toContain(tr('device.lost'));
  });

  it('App mounts with a localStorage that throws (the sidebar state is not remembered)', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError'); });
    const router = makeRouter();
    await router.push('/overview');
    const w = keep(mount(App, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(w.find('.cs').exists()).toBe(true); // the connect screen
    // the sidebar toggle writes the state: storage throws, nothing breaks
    const errors: unknown[] = [];
    w.vm.$.appContext.config.errorHandler = (e) => { errors.push(e); };
    const toggle = w.findAll('button').find((b) => b.attributes('aria-label') === tr('nav.collapse'))!;
    await toggle.trigger('click');
    await flushPromises();
    expect(w.find('.side--compact').exists()).toBe(true);
    expect(errors).toEqual([]);
  });

  it('calibration.start(): the flush before 02 06 00 fails → no 02 06 01 (nothing to stop)', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const out = outFrames();
    vi.spyOn(useSyncStore(), 'flush').mockRejectedValueOnce(new Error('queue failed'));
    const cal = useCalibrationStore();
    await cal.start();
    expect(cal.phase).toBe('idle');
    expect(cal.error).toBe('queue failed');
    expect(out().filter((x) => x.startsWith('02 06'))).toEqual([]);
    expect(cal.stopFailed).toBe(false);
    expect(readCalibrationFlag()).toBeNull();
  });

  it('calibration.start(): 02 06 00 sent and its reply lost → the stop is still sent', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const out = outFrames();
    const orig = MockTransport.prototype.startCalibration;
    vi.spyOn(MockTransport.prototype, 'startCalibration').mockImplementationOnce(async function (this: MockTransport) {
      await orig.call(this);
      throw new Error('lost reply');
    });
    const cal = useCalibrationStore();
    await cal.start();
    expect(out().filter((x) => x.startsWith('02 06'))).toEqual(['02 06 00', '02 06 01']);
    expect(readCalibrationFlag()).toBeNull(); // the stop was answered
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('P3', () => {
  async function calibrating() {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const router = makeRouter();
    await router.push({ path: '/performance', query: { tab: 'calibration' } });
    const w = keep(mount(CalibrationView, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    const cal = useCalibrationStore();
    await cal.start();
    await flushPromises();
    return { device, cal, w };
  }
  const key = (el: Element, code: string, o: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent('keydown', { code, key: code === 'Backspace' ? 'Backspace' : 'Enter', bubbles: true, cancelable: true, ...o });
    el.dispatchEvent(e);
    return e;
  };

  it('calibration: Enter on the focused Finish does nothing; Ctrl+Enter finishes (asks first); the hint is shown', async () => {
    const { cal, w } = await calibrating();
    expect(cal.phase).toBe('running');
    expect(w.find('[data-test="cal-shortcuts"]').text()).toBe(tr('calibration.shortcuts'));
    const finish = w.findAll('button').find((b) => b.text() === tr('calibration.finish'))!;
    expect(finish.attributes('aria-keyshortcuts')).toBe('Control+Enter');
    (finish.element as HTMLButtonElement).focus();
    const plain = key(finish.element, 'Enter');
    expect(plain.defaultPrevented).toBe(true); // the key lock
    await flushPromises();
    expect(cal.phase).toBe('running');
    expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    const chord = key(finish.element, 'Enter', { ctrlKey: true });
    expect(chord.defaultPrevented).toBe(true);
    await flushPromises();
    // nothing new yet: Finish asks first, as the button does
    expect(document.body.textContent).toContain(tr('calibration.confirmEmpty'));
    expect(cal.phase).toBe('running');
    await cal.cancel();
  });

  it('calibration: Ctrl+Backspace cancels (nothing saved); no hint outside a session', async () => {
    const { cal, w } = await calibrating();
    const out = outFrames();
    const cancel = w.findAll('button').find((b) => b.text() === tr('calibration.cancel'))!;
    expect(cancel.attributes('aria-keyshortcuts')).toBe('Control+Backspace');
    key(document.body, 'Backspace', { ctrlKey: true });
    await vi.waitFor(() => expect(cal.phase).toBe('idle'), { timeout: 5000 });
    expect(out()).toContain('02 06 01');
    expect(out().some((x) => x.startsWith('02 02'))).toBe(false);
    expect(toasts().map((x) => x.text)).toContain(tr('calibration.cancelled'));
    await flushPromises();
    expect(w.find('[data-test="cal-shortcuts"]').exists()).toBe(false);
    // outside a session the chords do nothing
    const idle = key(document.body, 'Enter', { ctrlKey: true });
    await flushPromises();
    expect(idle.defaultPrevented).toBe(false);
    expect(cal.phase).toBe('idle');
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it('Switch tab: the read fails → the load-error card; Try again → the map', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const read = vi.spyOn(MockTransport.prototype, 'getPerformance').mockRejectedValue(new Error('no reply'));
    const router = makeRouter();
    await router.push({ path: '/performance', query: { tab: 'switch' } });
    const w = keep(mount(SwitchTab, { global: { plugins: [router] }, attachTo: document.body }));
    const perf = usePerformanceStore();
    await vi.waitFor(() => expect(perf.loadError).not.toBeNull(), { timeout: 10000 });
    await flushPromises();
    const card = w.find('[data-test="switch-load-error"]');
    expect(card.exists()).toBe(true);
    expect(card.text()).toContain(tr('perf.loadFailed'));
    expect(w.find('.swp__list').exists()).toBe(false);
    read.mockRestore();
    await card.find('button').trigger('click');
    await vi.waitFor(() => expect(perf.loadError).toBeNull(), { timeout: 15000 });
    await vi.waitFor(() => expect(perf.loading).toBe(false), { timeout: 15000 });
    await flushPromises();
    expect(w.find('[data-test="switch-load-error"]').exists()).toBe(false);
    expect(w.findAll('.swp__list li').length).toBeGreaterThan(0);
  }, 30000);
});
