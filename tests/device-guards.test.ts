// Leaving a keyboard: never during calibration (R1), one demo button with a model switch, and a replugged keyboard reconnecting (R3).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useCalibrationStore } from '../src/stores/calibration';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import DeviceCard from '../src/components/shell/DeviceCard.vue';
import ConnectScreen from '../src/components/shell/ConnectScreen.vue';
import { t } from '../src/i18n/vi';

type Listener = (e: unknown) => void;

/** A HIDDevice stand-in whose reports are answered by the demo emulator of the same model. */
function fakeDevice(model: 'max' | 'pro', collections = [{ usagePage: 0xffb0, usage: 1 }]) {
  const emulator = new MockTransport({ latencyMs: 0, seed: model }) as unknown as { handle(req: number[]): Uint8Array };
  const listeners: Listener[] = [];
  const dev = {
    opened: false,
    productName: model === 'pro' ? 'AE64 Pro' : 'AE64 Max',
    vendorId: 0x1ca6,
    productId: model === 'pro' ? 0x300a : 0x300d,
    collections,
    opens: 0,
    open: async () => { dev.opened = true; dev.opens++; },
    close: async () => { dev.opened = false; },
    addEventListener: (_: string, cb: Listener) => { listeners.push(cb); },
    removeEventListener: (_: string, cb: Listener) => { listeners.splice(listeners.indexOf(cb), 1); },
    sendReport: async (_id: number, frame: Uint8Array) => {
      const reply = emulator.handle(Array.from(frame));
      setTimeout(() => { for (const cb of [...listeners]) cb({ data: new DataView(reply.buffer) }); }, 0);
    },
  };
  return dev;
}

/** navigator.hid with an event registry: unplug and plug events are delivered to whoever listens. */
function stubHid(granted: ReturnType<typeof fakeDevice>[], requestDevice?: () => Promise<unknown>) {
  const registry = new Map<string, Listener[]>();
  const on = (type: string) => registry.get(type) ?? [];
  vi.stubGlobal('navigator', {
    hid: {
      getDevices: async () => granted,
      requestDevice,
      addEventListener: (type: string, cb: Listener) => { registry.set(type, [...on(type), cb]); },
      removeEventListener: (type: string, cb: Listener) => { registry.set(type, on(type).filter((l) => l !== cb)); },
    },
  });
  return {
    listeners: (type: string) => on(type).length,
    /** The keyboard is pulled: the device closes and every 'disconnect' listener hears it. */
    unplug: (device: ReturnType<typeof fakeDevice>) => {
      device.opened = false;
      on('disconnect').slice().forEach((cb) => cb({ device }));
    },
    plug: (device: unknown) => on('connect').slice().forEach((cb) => cb({ device })),
  };
}

const toasts = () => useToast().items.value.map((x) => x.text);

beforeEach(() => {
  localStorage.clear();
  useToast().items.value = [];
  setActivePinia(createPinia());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('calibration blocks leaving the keyboard', () => {
  async function calibratingDemo() {
    const device = useDeviceStore();
    await device.connectDemo();
    const cal = useCalibrationStore();
    await cal.start();
    expect(cal.phase).toBe('running');
    return { device, cal, transport: device.transport };
  }

  it('changeKeyboard, the user disconnect and the demo model switch do nothing, and say why', async () => {
    const { device, cal, transport } = await calibratingDemo();
    const stop = vi.spyOn(transport as MockTransport, 'stopCalibration');
    await device.changeKeyboard();
    await device.disconnect({ user: true });
    await device.switchDemoModel('pro');
    expect(device.status).toBe('connected');
    expect(device.transport).toBe(transport);
    expect(device.model).toBe('max');
    expect(cal.phase).toBe('running');
    expect(stop).not.toHaveBeenCalled(); // nothing stops calibration for the user
    expect(toasts()).toContain(t('device.calibrating'));
    await cal.cancel();
  });

  it('a keyboard still locked in calibration mode blocks them even when the session is idle', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    Object.defineProperty(device.transport, 'calibrationLocked', { get: () => true });
    await device.changeKeyboard();
    await device.disconnect({ user: true });
    expect(device.status).toBe('connected');
  });

  it('the internal disconnect (polling-rate reconnect) is not blocked', async () => {
    const { device, cal } = await calibratingDemo();
    await device.disconnect({ flush: false });
    expect(device.status).toBe('idle');
    expect(device.transport).toBeNull();
    await new Promise((r) => setTimeout(r, 200)); // the poll loop ends on its own
    expect(cal.phase).toBe('idle');
  });

  it('a user disconnect outside calibration works', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    await device.disconnect({ user: true });
    expect(device.status).toBe('idle');
  });

  it('the device card disables Change keyboard, Disconnect and the demo toggle while calibrating', async () => {
    const { device, cal } = await calibratingDemo();
    const w = mount(DeviceCard);
    const buttons = w.findAll('button.ibtn');
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b.attributes('disabled')).toBeDefined();
      expect(b.attributes('title')).toBe(t('device.calibrating'));
    }
    expect(w.findAll('.seg__opt').every((o) => o.attributes('disabled') !== undefined)).toBe(true);
    await cal.cancel();
    await flushPromises();
    expect(w.findAll('button.ibtn').every((b) => b.attributes('disabled') === undefined)).toBe(true);
    expect(device.status).toBe('connected');
    w.unmount();
  });

  it('the Disconnect button of the card is a user disconnect', async () => {
    const { device, cal } = await calibratingDemo();
    const w = mount(DeviceCard);
    // A click that gets through the disabled attribute is refused by the store.
    const button = w.findAll('button.ibtn')[1];
    button.element.removeAttribute('disabled');
    await button.trigger('click');
    await flushPromises();
    expect(device.status).toBe('connected');
    await cal.cancel();
    w.unmount();
  });
});

describe('one demo button', () => {
  it('the connect screen has a single demo button', () => {
    const w = mount(ConnectScreen);
    const labels = w.findAll('button').map((b) => b.text());
    expect(labels).toContain(t('connect.demo'));
    expect(labels.filter((l) => /demo/i.test(l))).toEqual([t('connect.demo')]);
    w.unmount();
  });

  it('the toggle switches Max ↔ Pro and leaves no history, queue or old model', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load();
    const key = device.keys.find((k) => k.name === 'W')!.id;
    perf.apply([key], () => ({ normalPress: 1.7 }), 'edit');
    const history = useHistoryStore();
    const first = device.transport;
    const board = device.info?.boardIdHex;
    const w = mount(DeviceCard);
    expect(w.findAll('.seg__opt').map((o) => o.text())).toEqual(['AE64 Max', 'AE64 Pro']);
    await w.findAll('.seg__opt')[1].trigger('click');
    await vi.waitFor(() => expect([device.status, device.model]).toEqual(['connected', 'pro']));
    expect(device.demo).toBe(true);
    expect(device.transport).not.toBe(first);
    expect(device.info?.boardIdHex).not.toBe(board);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(useSyncStore().pendingCount()).toBe(0);
    await w.findAll('.seg__opt')[0].trigger('click');
    await vi.waitFor(() => expect([device.status, device.model]).toEqual(['connected', 'max']));
    expect(device.info?.boardIdHex).toBe(board);
    w.unmount();
  });

  it('the toggle is only there in a demo, and not in the compact card', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    expect(mount(DeviceCard, { props: { compact: true } }).find('.seg').exists()).toBe(false);
    const real = mount(DeviceCard);
    expect(real.find('.seg').exists()).toBe(true);
    await device.disconnect();
    await flushPromises();
    expect(real.find('.seg').exists()).toBe(false);
  });

  it('the model switch refuses when the flush fails, and keeps the connection', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const transport = device.transport;
    vi.spyOn(useSyncStore(), 'flush').mockRejectedValue(new Error('write failed'));
    await device.switchDemoModel('pro');
    expect(device.transport).toBe(transport);
    expect(device.model).toBe('max');
    expect(toasts()).toContain(t('device.changeBlocked'));
  });

  it('the last demo model is remembered and used by the next connectDemo()', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    expect(device.model).toBe('max');
    await device.switchDemoModel('pro');
    expect(localStorage.getItem('ae64.demoModel')).toBe('pro');
    await device.changeKeyboard(); // a demo returns to the connect screen
    expect(device.status).toBe('idle');
    await device.connectDemo();
    expect(device.model).toBe('pro');
    await device.connectDemo('max');
    expect(localStorage.getItem('ae64.demoModel')).toBe('max');
    await device.connectDemo();
    expect(device.model).toBe('max');
  });

  it('garbage or a throwing localStorage falls back to Max', async () => {
    const device = useDeviceStore();
    localStorage.setItem('ae64.demoModel', 'pro2');
    await device.connectDemo();
    expect(device.model).toBe('max');
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await device.connectDemo();
    expect(device.model).toBe('max');
    expect(device.status).toBe('connected');
  });
});

describe('replugging a lost keyboard', () => {
  async function lostKeyboard(model: 'max' | 'pro' = 'max', others: ReturnType<typeof fakeDevice>[] = [], staleProductId?: number) {
    const dev = fakeDevice(model);
    const hid = stubHid([...others, dev]);
    localStorage.setItem('ae64.lastDevice', JSON.stringify({ vendorId: 0x1ca6, productId: dev.productId }));
    setActivePinia(createPinia()); // hidAvailable is read when the store is created
    const device = useDeviceStore();
    expect(await device.tryAutoReconnect()).toBe(true);
    if (staleProductId) localStorage.setItem('ae64.lastDevice', JSON.stringify({ vendorId: 0x1ca6, productId: staleProductId }));
    hid.unplug(dev);
    expect(device.status).toBe('idle');
    return { dev, hid, device };
  }

  it('the same model plugged back in reconnects, once, and the listener is gone', async () => {
    const { dev, hid, device } = await lostKeyboard('max');
    expect(hid.listeners('connect')).toBe(1);
    hid.plug(dev);
    await vi.waitFor(() => expect(device.status).toBe('connected'));
    expect(dev.opens).toBe(2);
    expect(device.transport?.productId).toBe(0x300d);
    expect(hid.listeners('connect')).toBe(0);
    hid.plug(dev);
    await flushPromises();
    expect(dev.opens).toBe(2);
  });

  it('two connect events in a row open one transport', async () => {
    const { dev, hid, device } = await lostKeyboard('max');
    hid.plug(dev);
    hid.plug(dev);
    await vi.waitFor(() => expect(device.status).toBe('connected'));
    await flushPromises();
    expect(dev.opens).toBe(2);
  });

  it('a connect of the other model is ignored and keeps listening; the lost one then reconnects', async () => {
    const pro = fakeDevice('pro');
    const { dev, hid, device } = await lostKeyboard('max', [pro]);
    localStorage.setItem('ae64.lastDevice', JSON.stringify({ vendorId: 0x1ca6, productId: 0x300d }));
    hid.plug(pro);
    await flushPromises();
    expect(device.status).toBe('idle');
    expect(pro.opens).toBe(0);
    expect(hid.listeners('connect')).toBe(1);
    hid.plug(dev);
    await vi.waitFor(() => expect(device.status).toBe('connected'));
    expect(device.transport?.productId).toBe(0x300d);
    expect(pro.opens).toBe(0);
  });

  it('with both models granted the lost one is reconnected, not the first listed', async () => {
    const pro = fakeDevice('pro');
    const { dev, hid, device } = await lostKeyboard('max', [pro], 0x300a); // the Pro is listed first and was remembered
    expect(JSON.parse(localStorage.getItem('ae64.lastDevice')!).productId).toBe(0x300d);
    hid.plug(dev);
    await vi.waitFor(() => expect(device.status).toBe('connected'));
    expect(device.transport?.productId).toBe(0x300d);
    expect(pro.opens).toBe(0);
  });

  it('a device without the config collection is ignored', async () => {
    const { hid, device } = await lostKeyboard('max');
    const other = fakeDevice('max', [{ usagePage: 1, usage: 6 }]);
    hid.plug(other);
    await flushPromises();
    expect(device.status).toBe('idle');
    expect(other.opens).toBe(0);
  });

  it('after a user disconnect it does not reconnect', async () => {
    const dev = fakeDevice('max');
    const hid = stubHid([dev]);
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.tryAutoReconnect();
    await device.disconnect({ user: true });
    expect(hid.listeners('connect')).toBe(0);
    hid.plug(dev);
    await flushPromises();
    expect(device.status).toBe('idle');
    expect(dev.opens).toBe(1);
  });

  it('a later connect and user disconnect leave it disarmed', async () => {
    const { dev, hid, device } = await lostKeyboard('max');
    await device.connectDemo('pro');
    await device.disconnect({ user: true });
    expect(hid.listeners('connect')).toBe(0);
    hid.plug(dev);
    await flushPromises();
    expect(device.status).toBe('idle');
  });

  it('changing keyboard does not arm it', async () => {
    const dev = fakeDevice('max');
    const requestDevice = vi.fn().mockRejectedValue(new DOMException('none', 'NotFoundError'));
    const hid = stubHid([dev], requestDevice);
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.tryAutoReconnect();
    await device.changeKeyboard();
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(hid.listeners('connect')).toBe(0);
    hid.plug(dev);
    await flushPromises();
    expect(device.status).toBe('idle');
  });

  it('a demo started in between disarms it, and the replug does not replace the demo', async () => {
    const { dev, hid, device } = await lostKeyboard('max');
    await device.connectDemo('pro');
    expect(hid.listeners('connect')).toBe(0);
    hid.plug(dev);
    await flushPromises();
    expect(device.demo).toBe(true);
    expect(device.model).toBe('pro');
    expect(dev.opens).toBe(1);
  });

  it('a lost connection while the polling rate restarts the USB is not armed (a connect then does nothing)', async () => {
    const { dev, hid, device } = await lostKeyboard('max');
    const settings = useSettingsStore();
    settings.pollingState = 'reconnecting';
    hid.plug(dev);
    await flushPromises();
    expect(device.status).toBe('idle');
    expect(dev.opens).toBe(1);
  });

  it('a lost connection during the polling-rate restart is not armed', async () => {
    const dev = fakeDevice('max');
    const hid = stubHid([dev]);
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.tryAutoReconnect();
    useSettingsStore().pollingState = 'applying';
    hid.unplug(dev);
    expect(hid.listeners('connect')).toBe(0);
  });

  it('a connect with a transport already open does nothing', async () => {
    const { dev, hid, device } = await lostKeyboard('max');
    device.transport = new MockTransport({ latencyMs: 0 }); // something else is already open
    hid.plug(dev);
    await flushPromises();
    expect(dev.opens).toBe(1);
  });
});
