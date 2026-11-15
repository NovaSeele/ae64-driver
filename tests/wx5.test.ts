// WX5 item 0 (carried from the WX4 review): locks that free as Chrome does and the one retry (0a), the reviewer's surviving
// mutants (0b), the firmware "another window" note before a file is picked (0c), and the calibration finish question that
// could read "Cần chú ý: ." (0d). Demo, the fake WebHID (tests/fw-hid.ts) and an in-memory lock manager only; no real keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import CalibrationView from '../src/components/calibration/CalibrationView.vue';
import FirmwarePage from '../src/pages/FirmwarePage.vue';
import { routes } from '../src/router';
import { BaseTransport } from '../src/protocol/client';
import { HidFwPort, HidTransport } from '../src/protocol/hid';
import { MockTransport } from '../src/protocol/mock';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { FIRMWARE_LOCK, deviceLockName, takeLock } from '../src/protocol/tabLock';
import { useDeviceStore } from '../src/stores/device';
import { useCalibrationStore } from '../src/stores/calibration';
import { useFirmwareStore } from '../src/stores/firmware';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { setLocale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';
import { CRC, fileOf, makeFw, run, startWith } from './fw-helpers';
import { hidKeyboard, installFakeHid, removeFakeHid } from './fw-hid';
import { installLocks, removeLocks } from './fake-locks';

const FLAG_KEY = 'ae64.calibrating';
let wrappers: VueWrapper[] = [];
const keep = <T extends VueWrapper>(w: T): T => { wrappers.push(w); return w; };
const toasts = () => useToast().items.value;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });
/** Every frame sent by any transport from now on, as "ff cc xx". */
function outFrames(): () => string[] {
  const spy = vi.spyOn(BaseTransport.prototype as unknown as { log: (d: string, b: Uint8Array) => void }, 'log');
  const from = spy.mock.calls.length;
  return () => spy.mock.calls.slice(from).filter((c) => c[0] === 'out')
    .map((c) => [...(c[1] as Uint8Array).slice(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join(' '));
}
/** A demo keyboard's serial, without leaving it connected. */
async function demoSerial(seed: 'max' | 'pro' = 'max'): Promise<string> {
  const device = useDeviceStore();
  await device.connectDemo(seed);
  const s = device.info!.serialHex;
  await device.disconnect();
  setActivePinia(createPinia());
  useToast().items.value = [];
  return s;
}
/** A real AE64 Pro over the fake WebHID, with the in-memory locks (real timers). */
function realPro() {
  const order: string[] = [];
  const locks = installLocks(order);
  const app = new MockTransport({ seed: 'pro' });
  const bus = app.fwMock as MockFwBus;
  const hid = installFakeHid(bus);
  const dev = hid.of(app);
  hid.next = (all) => all.filter((d) => d.inner === app);
  return { order, locks, app, bus, hid, dev, name: deviceLockName(dev.vendorId, dev.productId), device: useDeviceStore() };
}
/** Another page asks for `name` (ifAvailable): true when it gets it. */
const otherPageGets = (name: string) => (navigator as unknown as { locks: { request: (n: string, o: object, cb: (l: unknown) => boolean) => Promise<boolean> } })
  .locks.request(name, { ifAvailable: true }, (l) => !!l);

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
  vi.useRealTimers();
  await useDeviceStore().disconnect().catch(() => undefined);
  await flushPromises();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  removeFakeHid();
  removeLocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------------------------------------------------
describe('0a: locks freed as Chrome frees them, and the one retry (N-WX4-1)', () => {
  it('the fake frees like Chrome: a lock released is refused in the same task and after a microtask, free after a macrotask', async () => {
    const locks = installLocks();
    let free!: () => void;
    const held = new Promise<void>((r) => { free = r; });
    void locks.request('x', { ifAvailable: true }, () => held);
    await flushPromises();
    free();
    await Promise.resolve();
    await Promise.resolve();
    expect(await locks.request('x', { ifAvailable: true }, (l) => !!l)).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    expect(await locks.request('x', { ifAvailable: true }, (l) => !!l)).toBe(true);
  });

  it('a lock this page released and asks for again at once is granted, through the retry after setTimeout(0)', async () => {
    const order: string[] = [];
    installLocks(order);
    const first = await takeLock('ae64-test');
    expect(first).not.toBeNull();
    first!();
    const again = await takeLock('ae64-test');
    expect(again).not.toBeNull(); // 7aa0a2f: null ("another tab") for this page's own lock
    // asked, released, asked at once (refused: not free yet in Chrome), asked again after setTimeout(0) (granted)
    expect(order.filter((x) => x === 'lock ae64-test').length).toBe(3);
    expect(order).toContain('free ae64-test');
    again!();
    await new Promise((r) => setTimeout(r, 0));
  });

  it('reopen keeps the device lock across the close and the new open: never freed, never asked again (the bridge)', async () => {
    const s = realPro();
    await s.device.connect();
    const t = s.device.transport as HidTransport;
    expect(s.locks.held.get(s.name)).toBe('page');
    const port = new HidFwPort();
    port.adopt(t);
    const mark = s.order.length;
    const fresh = await port.reopen(t) as HidTransport;
    expect(fresh.connected).toBe(true);
    // without the bridge the close frees the lock and the open asks for it again (in Chrome: refused in the same task)
    expect(s.order.slice(mark)).toEqual([]);
    expect(s.locks.held.get(s.name)).toBe('page');
    await fresh.close();
    await vi.waitFor(() => expect(s.locks.held.has(s.name)).toBe(false));
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('0b: the WX4 reviewer mutants that survived', () => {
  it('H2: device.open() throws → the product lock is free again for another page', async () => {
    const s = realPro();
    s.dev.openError = new DOMException('Failed to open the device.', 'NotAllowedError');
    await s.device.connect();
    expect(s.device.connected).toBe(false);
    await vi.waitFor(() => expect(s.locks.held.has(s.name)).toBe(false));
    expect(await otherPageGets(s.name)).toBe(true);
  });

  it('V7: a disconnect during the polling-rate restart with unsaved edits lost still says device.unsavedLost', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load();
    const id = device.keys[20].id;
    expect(perf.apply([id], (p) => ({ normalPress: Math.round((p.normalPress + 0.2) * 100) / 100 }), 'test')).toBe(1);
    useSettingsStore().pollingState = 'applying';
    (device.transport as MockTransport).unplug();
    await flushPromises();
    expect(toasts().map((x) => [x.kind, x.text])).toContainEqual(['error', tr('device.unsavedLost', { n: 1 })]);
  });

  it('C3: the flag is in localStorage when 02 06 00 goes out, not after its reply', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    let atSend: string | null | undefined;
    vi.spyOn(BaseTransport.prototype as unknown as { log: (d: string, b: Uint8Array) => void }, 'log')
      .mockImplementation((dir: string, b: Uint8Array) => {
        if (dir === 'out' && b[0] === 2 && b[1] === 6 && b[2] === 0) atSend = localStorage.getItem(FLAG_KEY);
      });
    const cal = useCalibrationStore();
    await cal.start();
    expect(cal.phase).toBe('running');
    expect(atSend).toBeDefined();
    expect(JSON.parse(atSend!).serial).toBe(device.info!.serialHex);
    await cal.cancel();
  });

  it('C8: pagehide sends 02 06 01 while idle with the transport still locked after a failed stop', async () => {
    const serial = await demoSerial();
    localStorage.setItem(FLAG_KEY, JSON.stringify({ serial, at: Date.now() }));
    vi.spyOn(MockTransport.prototype, 'stopCalibration').mockRejectedValueOnce(new Error('no reply'));
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(device.calibrationLocked()).toBe(true);
    const cal = useCalibrationStore();
    expect(cal.phase).toBe('idle');
    const out = outFrames();
    cal.onPageHide();
    await vi.waitFor(() => expect(out()).toContain('02 06 01'));
    expect(out().some((x) => x.startsWith('02 02'))).toBe(false);
  });

  it('C8: pagehide sends 02 06 01 while the session is starting', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    let go!: () => void;
    vi.spyOn(useSyncStore(), 'flush').mockImplementationOnce(() => new Promise<void>((r) => { go = r; }));
    const cal = useCalibrationStore();
    const started = cal.start();
    expect(cal.phase).toBe('starting');
    const out = outFrames();
    cal.onPageHide();
    await vi.waitFor(() => expect(out()).toContain('02 06 01'));
    go();
    await started;
    await cal.cancel();
  });

  it('F4: a failed preflight releases ae64-firmware: another page can take it', async () => {
    const s = realPro();
    await s.device.connect();
    const fw = useFirmwareStore();
    fw.setEnabled(true);
    await fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    fw.typed = 'AE64 Pro';
    expect(fw.canStart).toBe(true);
    vi.spyOn(useSyncStore(), 'flush').mockRejectedValueOnce(new Error('queue failed'));
    await fw.start();
    expect(fw.phase).toBe('preflightFail');
    expect(s.order).toContain(`lock ${FIRMWARE_LOCK}`); // it was taken first
    await vi.waitFor(() => expect(s.locks.held.has(FIRMWARE_LOCK)).toBe(false));
    expect(await otherPageGets(FIRMWARE_LOCK)).toBe(true);
  });

  describe('F5: a finished session releases ae64-firmware', { timeout: 60_000 }, () => {
    async function until(pred: () => boolean, max = 60_000) {
      let ms = 0;
      while (!pred() && ms < max) { await run(250); ms += 250; }
    }
    it('verified (done)', async () => {
      const s = await hidKeyboard();
      const locks = installLocks();
      await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
      expect(locks.held.get(FIRMWARE_LOCK)).toBe('page');
      await until(() => !s.fw.active);
      expect(s.fw.phase).toBe('done');
      await run(10);
      expect(locks.held.has(FIRMWARE_LOCK)).toBe(false);
      vi.useRealTimers();
    });
    it('not adopted (the keyboard cannot be opened again after a failed enter)', async () => {
      const s = await hidKeyboard({ enterFail: true });
      const locks = installLocks();
      await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
      expect(locks.held.get(FIRMWARE_LOCK)).toBe('page');
      await run(2000);
      s.appDev.openError = new DOMException('Failed to open the device.', 'NotAllowedError');
      await until(() => !s.fw.active);
      expect(s.fw.phase).toBe('enterFail');
      expect(s.device.connected).toBe(false);
      await run(10);
      expect(locks.held.has(FIRMWARE_LOCK)).toBe(false);
      vi.useRealTimers();
    });
  });

  it('CV5: with the finish question open, Ctrl+Backspace does not cancel (the session runs on, no 02 06 01)', async () => {
    const { cal } = await calibrating();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).not.toBeNull();
    const out = outFrames();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Backspace', key: 'Backspace', ctrlKey: true, bubbles: true, cancelable: true }));
    await flushPromises();
    await new Promise((r) => setTimeout(r, 200));
    expect(cal.phase).toBe('running');
    expect(out()).not.toContain('02 06 01');
    await cal.cancel();
  });
});

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

// ---------------------------------------------------------------------------------------------------------------------
describe('0c: the firmware "another window" note from the first step (N-WX4-2)', () => {
  it('otherWindow and no file → the note and its "Thử lại" are on the page; Start is not', async () => {
    const s = realPro();
    await s.device.connect();
    const fw = useFirmwareStore();
    fw.setEnabled(true);
    const release = s.locks.other(FIRMWARE_LOCK);
    const router = makeRouter();
    await router.push('/firmware');
    const w = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await vi.waitFor(() => expect(fw.otherWindow).toBe(true));
    await flushPromises();
    expect(fw.file).toBeNull();
    const note = w.find('[data-test="fw-other-window"]');
    expect(note.exists()).toBe(true);
    expect(note.attributes('role')).toBe('alert');
    expect(note.text()).toContain(tr('fw.otherWindow'));
    expect(note.find('button').text()).toBe(tr('fw.otherWindowRetry'));
    expect(w.findAll('[data-test="fw-other-window"]').length).toBe(1);
    expect(w.findAll('button').map((b) => b.text())).not.toContain(tr('fw.s2.start'));
    // the other window is done: "Thử lại" clears it
    release();
    await note.find('button').trigger('click');
    await vi.waitFor(() => expect(fw.otherWindow).toBe(false));
    await flushPromises();
    expect(w.find('[data-test="fw-other-window"]').exists()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe('0d: the finish question closes when its reason goes away (N-WX4-3)', () => {
  it('opened with nothing new; a key gets calibrated meanwhile → no dialog with an empty list, the session runs on', async () => {
    const { device, cal } = await calibrating();
    expect(cal.newCount).toBe(0);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.body.textContent).toContain(tr('calibration.confirmEmpty'));
    // the demo presses a key to the bottom, as a user would while the question is open
    (device.transport as MockTransport).simulatePress(device.keys[20].id, 3.6);
    await vi.waitFor(() => expect(cal.newCount).toBeGreaterThan(0), { timeout: 5000 });
    await flushPromises();
    expect(cal.shallowIds.length + cal.uncalibratedCount).toBe(0);
    expect(document.body.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    expect(document.body.textContent).not.toContain(tr('calibration.finishBody', { list: '' }));
    expect(cal.phase).toBe('running');
    await cal.cancel();
  });
});
