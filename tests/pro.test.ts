// AE64 Pro support: model detection, two keyboards at once, demo Pro, and nothing of one keyboard surviving on another.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, createMockTransport, modelName, modelOf } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useDiagnosticsStore } from '../src/stores/diagnostics';
import { useHistoryStore } from '../src/stores/history';
import { useLightingStore } from '../src/stores/lighting';
import { useLiveStore } from '../src/stores/live';
import { usePerformanceStore } from '../src/stores/performance';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { t } from '../src/i18n/vi';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { PHYSICAL_KEYS } from '../src/protocol';
import { findSwitch, isCatalogTriple, switchCatalogFor } from '../src/protocol/switches';
import { switchName } from '../src/data/switchDisplay';

// Backups are thousands of exchanges: answer them on the next microtask (same replies, as in diagnostics.test.ts).
vi.mock('../src/protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/protocol')>();
  class InstantMock extends actual.MockTransport {
    protected override exchange(frame: Uint8Array): Promise<Uint8Array> {
      return Promise.resolve((this as unknown as { handle(req: number[]): Uint8Array }).handle(Array.from(frame)));
    }
  }
  return { ...actual, createMockTransport: (o?: { seed?: 'max' | 'pro' }) => new InstantMock({ seed: o?.seed }) };
});

type Listener = (e: unknown) => void;

/** A HIDDevice stand-in whose reports are answered by the demo emulator of the same model. */
function fakeDevice(model: 'max' | 'pro') {
  const emulator = new MockTransport({ latencyMs: 0, seed: model }) as unknown as { handle(req: number[]): Uint8Array };
  const listeners: Listener[] = [];
  const dev = {
    opened: false,
    productName: model === 'pro' ? 'AE64 Pro' : 'AE64 Max',
    vendorId: 0x1ca6,
    productId: model === 'pro' ? 0x300a : 0x300d,
    collections: [{ usagePage: 0xffb0, usage: 1 }],
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

/** navigator.hid with these granted devices; `fireDisconnect` delivers an unplug to the listeners the transport registered. */
function stubHid(granted: ReturnType<typeof fakeDevice>[]) {
  const disconnectListeners: Listener[] = [];
  vi.stubGlobal('navigator', {
    hid: {
      getDevices: async () => granted,
      addEventListener: (_: string, cb: Listener) => { disconnectListeners.push(cb); },
      removeEventListener: (_: string, cb: Listener) => { disconnectListeners.splice(disconnectListeners.indexOf(cb), 1); },
    },
  });
  return { fireDisconnect: (device: unknown) => disconnectListeners.slice().forEach((cb) => cb({ device })) };
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('model', () => {
  it('maps both boards and both product IDs, and nothing else', () => {
    // One place decides which keyboard this is; an unknown board must not pass for a Max.
    expect(modelOf({ boardIdHex: '0030000d' })).toBe('max');
    expect(modelOf({ boardIdHex: '0030000A' })).toBe('pro');
    expect(modelOf({ productId: 0x300d })).toBe('max');
    expect(modelOf({ productId: 0x300a })).toBe('pro');
    expect(modelOf({ boardIdHex: '0030000d', productId: 0x300a })).toBe('max'); // the board wins over the USB id
    expect(modelOf({ boardIdHex: '00300008', productId: 0x1234 })).toBeNull();
    expect(modelOf({})).toBeNull();
    expect(modelOf({ boardIdHex: null })).toBeNull();
    expect(modelName('max')).toBe('AE64 Max');
    expect(modelName('pro')).toBe('AE64 Pro');
  });

  it('the Pro demo reports board 0030000a, firmware 0.1.0.0, PID 0x300a; the Max demo is unchanged', async () => {
    // The demo Pro must look like a Pro to every board-gated path; the Max seed keeps its old bytes.
    const pro = createMockTransport({ seed: 'pro' });
    const max = createMockTransport({ seed: 'max' });
    const proInfo = await pro.getDeviceInfo();
    expect(proInfo.boardIdHex).toBe('0030000a');
    expect(proInfo.firmware).toBe('0.1.0.0');
    expect(pro.productId).toBe(0x300a);
    expect(pro.productName).toBe('AE64 Pro (demo)');
    const maxInfo = await max.getDeviceInfo();
    expect(maxInfo.boardIdHex).toBe('0030000d');
    expect(maxInfo.firmware).toBe('0.0.4.0');
    expect(max.productId).toBe(0x300d);
    expect(proInfo.serial).toBe(maxInfo.serial);
  });

  it('the Pro demo has the four profile names of the real keyboard (trailing space kept), the Max keeps its own', async () => {
    const pro = createMockTransport({ seed: 'pro' });
    const max = createMockTransport({ seed: 'max' });
    const names = await Promise.all([0, 1, 2, 3].map((i) => pro.getProfileName(i)));
    expect(names).toEqual(['配置一 ', '配置二 ', '配置三 ', '配置四 ']);
    expect(await Promise.all([0, 1, 2, 3].map((i) => max.getProfileName(i)))).toEqual(['Default', 'FPS', 'Typing', 'Profile 4']);
  });

  it('every Pro demo key, in every profile, reports 14544 / 3400 / 17664, which the Pro catalog knows', async () => {
    const pro = createMockTransport({ seed: 'pro' });
    const catalog = switchCatalogFor('0030000a')!;
    await pro.getDeviceInfo(); // allows the board (setActiveProfile is a write)
    for (let profile = 0; profile < 4; profile++) {
      await pro.setActiveProfile(profile);
      for (const k of PHYSICAL_KEYS) {
        const p = await pro.getPerformance({ row: k.row, col: k.col });
        expect([p.axisV2Id, p.axisRangeMax, p.axisCoefficient]).toEqual([14544, 3400, 17664]);
        expect(isCatalogTriple(catalog, p)).toBe(true);
      }
    }
  }, 30000);

  it('the switch card shows White Wukong on the demo Pro and the selector is enabled', async () => {
    const device = useDeviceStore();
    await device.connectDemo('pro');
    const perf = usePerformanceStore();
    await perf.load();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    const w = mount(SwitchCard, { props: { ids: PHYSICAL_KEYS.map((k) => k.id) }, global: { plugins: [router] } });
    await flushPromises();
    expect(w.find('.swc__name').text()).toBe(switchName(findSwitch(perf.catalog!, 14544)!));
    expect(w.find('.swc__foot button').attributes('disabled')).toBeUndefined();
    w.unmount();
  });

  it('device.model / modelName follow the connected board', async () => {
    // The device card and the aria label read these.
    const device = useDeviceStore();
    expect(device.modelName).toBeNull();
    await device.connectDemo('pro');
    expect(device.model).toBe('pro');
    expect(device.modelName).toBe('AE64 Pro');
    expect(device.boardAllowed).toBe(true);
    await device.connectDemo();
    expect(device.modelName).toBe('AE64 Max');
  });
});

describe('two granted keyboards', () => {
  it('reconnect prefers the remembered model, in both directions', async () => {
    // With Max and Pro both granted the choice must be the last one used, not the order the browser lists them.
    const max = fakeDevice('max');
    const pro = fakeDevice('pro');
    stubHid([max, pro]);
    for (const [remembered, expected, other] of [[0x300a, pro, max], [0x300d, max, pro]] as const) {
      setActivePinia(createPinia());
      localStorage.setItem('ae64.lastDevice', JSON.stringify({ vendorId: 0x1ca6, productId: remembered }));
      max.opens = pro.opens = 0;
      const device = useDeviceStore();
      expect(await device.tryAutoReconnect()).toBe(true);
      expect(device.transport?.productId).toBe(remembered);
      expect(expected.opens).toBe(1);
      expect(other.opens).toBe(0); // never two devices
      await device.disconnect({ flush: false });
    }
  });

  it('takes the first granted keyboard when nothing, garbage, or an unplugged model is remembered', async () => {
    // A missing or broken pref must not stop the reconnect.
    const max = fakeDevice('max');
    const pro = fakeDevice('pro');
    stubHid([pro, max]);
    for (const stored of [null, 'not json', '{"vendorId":"x"}', JSON.stringify({ vendorId: 0x1ca6, productId: 0x9999 })]) {
      setActivePinia(createPinia());
      localStorage.clear();
      if (stored !== null) localStorage.setItem('ae64.lastDevice', stored);
      max.opens = pro.opens = 0;
      const device = useDeviceStore();
      expect(await device.tryAutoReconnect()).toBe(true);
      expect(device.transport?.productId).toBe(0x300a);
      expect(max.opens).toBe(0);
      await device.disconnect({ flush: false });
    }
  });

  it('a throwing localStorage does not break reconnect', async () => {
    // Private mode / blocked storage: the pref is optional.
    stubHid([fakeDevice('max'), fakeDevice('pro')]);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const device = useDeviceStore();
    expect(await device.tryAutoReconnect()).toBe(true);
    expect(device.transport?.productId).toBe(0x300d);
    expect(device.status).toBe('connected');
  });

  it('remembers a real keyboard after init, and never a demo', async () => {
    // Only a successful real connection writes the pref; the polling-rate reconnect relies on it.
    stubHid([fakeDevice('pro'), fakeDevice('max')]);
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(localStorage.getItem('ae64.lastDevice')).toBeNull();
    await device.disconnect({ flush: false });
    expect(await device.tryAutoReconnect()).toBe(true); // the first granted: the Pro
    expect(JSON.parse(localStorage.getItem('ae64.lastDevice')!)).toEqual({ vendorId: 0x1ca6, productId: 0x300a });
  });

  it('a disconnect event of the other keyboard leaves the open one connected', async () => {
    // The browser tells every listener about every unplug; only our own device may end the session.
    const max = fakeDevice('max');
    const pro = fakeDevice('pro');
    const hid = stubHid([max, pro]);
    localStorage.setItem('ae64.lastDevice', JSON.stringify({ vendorId: 0x1ca6, productId: 0x300d }));
    const device = useDeviceStore();
    await device.tryAutoReconnect();
    const transport = device.transport;
    hid.fireDisconnect(pro);
    expect(device.status).toBe('connected');
    expect(device.transport).toBe(transport);
    expect(max.opened).toBe(true);
    hid.fireDisconnect(max);
    expect(device.status).toBe('idle');
  });
});

describe('changing keyboard', () => {
  it('Demo Max → Demo Pro: history, queue and live state are gone, and an undo writes nothing to the Pro', async () => {
    // Undo after a switch must never replay a Max edit onto the Pro.
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load();
    const key = device.keys.find((k) => k.name === 'W')!.id;
    perf.apply([key], () => ({ normalPress: 1.7 }), 'edit');
    const history = useHistoryStore();
    const sync = useSyncStore();
    const live = useLiveStore();
    live.setFocus(key);
    live.markUiPressed([key]);
    useSelectionStore().select(key);
    expect(history.canUndo).toBe(true);
    expect(sync.pendingCount()).toBeGreaterThan(0);

    await device.connectDemo('pro');
    const pro = device.transport as MockTransport;
    const out: number[][] = [];
    pro.onPacket((e) => { if (e.dir === 'out') out.push(e.bytes); });

    expect(device.model).toBe('pro');
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(sync.pendingCount()).toBe(0);
    expect(live.focusId).toBeNull();
    expect(live.data.travel.every((v) => v === 0)).toBe(true);
    expect(useSelectionStore().count).toBe(0);

    history.undo();
    history.redo();
    await sync.flush();
    await new Promise((r) => setTimeout(r, 400)); // past the sync debounce
    expect(out).toEqual([]); // no frame at all, so certainly no write
  });

  it('refuses to switch when the flush fails, and keeps the connection', async () => {
    // Unsaved edits must not be dropped silently by "change keyboard".
    const device = useDeviceStore();
    await device.connectDemo('max');
    const transport = device.transport;
    vi.spyOn(useSyncStore(), 'flush').mockRejectedValue(new Error('write failed'));
    await device.changeKeyboard();
    expect(device.status).toBe('connected');
    expect(device.transport).toBe(transport);
  });

  it('refuses to switch while sync is in the error state', async () => {
    // flush() may resolve with failed jobs still held: sync.state says so.
    const device = useDeviceStore();
    await device.connectDemo('max');
    const sync = useSyncStore();
    vi.spyOn(sync, 'flush').mockImplementation(async () => { sync.state = 'error'; });
    await device.changeKeyboard();
    expect(device.status).toBe('connected');
  });

  it('a demo returns to the connect screen; a real one opens the chooser, and an expired activation ends idle', async () => {
    // requestDevice needs user activation, which an awaited flush may have used up.
    const device = useDeviceStore();
    await device.connectDemo('pro');
    await device.changeKeyboard();
    expect(device.status).toBe('idle');
    expect(device.transport).toBeNull();

    const max = fakeDevice('max');
    stubHid([max]);
    setActivePinia(createPinia()); // hidAvailable is read when the store is created
    const real = useDeviceStore();
    await real.tryAutoReconnect();
    expect(real.connected).toBe(true);
    const requestDevice = vi.fn().mockRejectedValue(new DOMException('Must be handling a user gesture', 'SecurityError'));
    (navigator.hid as unknown as { requestDevice: unknown }).requestDevice = requestDevice;
    await real.changeKeyboard();
    expect(requestDevice).toHaveBeenCalledOnce();
    expect(max.opened).toBe(false); // the old keyboard was released
    expect(real.status).toBe('idle');
    expect(real.error).toBeNull();
  });
});

describe('backups across models', () => {
  it('a Max backup is refused on the Pro seed and a Pro backup on the Max seed', async () => {
    // Writing one model's records to the other could damage it: the real import path must refuse.
    const device = useDeviceStore();
    const diag = useDiagnosticsStore();
    await device.connectDemo('max');
    const maxBackup = JSON.stringify(await diag.generateBackup());
    await device.connectDemo('pro');
    await expect(diag.parseAndDiffBackup(maxBackup)).rejects.toThrow('invalid_board_mismatch:0030000D:0030000A');
    const proBackup = JSON.stringify(await diag.generateBackup());
    expect(JSON.parse(proBackup).boardIdHex).toBe('0030000a');
    await device.connectDemo('max');
    await expect(diag.parseAndDiffBackup(proBackup)).rejects.toThrow('invalid_board_mismatch:0030000A:0030000D');
  }, 30000);
});

describe('lighting modes', () => {
  it('the Pro seed lists 20 modes for area 0, the Max 19, and the count is re-read on every connection', async () => {
    // The Max's 19 must not survive onto the Pro (or the reverse).
    const device = useDeviceStore();
    const lighting = useLightingStore();
    await device.connectDemo('pro');
    await lighting.load();
    expect(lighting.area0ModeCount).toBe(20);
    await device.connectDemo('max');
    expect(lighting.area0ModeCount).toBe(19);
    await lighting.load();
    expect(lighting.area0ModeCount).toBe(19);
    await device.connectDemo('pro');
    expect(lighting.area0ModeCount).toBe(19); // default until this keyboard's 02 08 00 is read
    await lighting.load();
    expect(lighting.area0ModeCount).toBe(20);
  });

  it('mode 19 (the 20th) can be selected, has a label, and previews without throwing', async () => {
    // Effect buttons and the LED preview are generic by index: the 20th must not fall off a table.
    const device = useDeviceStore();
    const lighting = useLightingStore();
    await device.connectDemo('pro');
    await lighting.load();
    lighting.applyBase(0, { mode: 19 }, 'mode');
    expect(lighting.area0Base.mode).toBe(19);
    expect(t('lighting.effectN', { n: 20 })).toMatch(/20/);
    const leds = await device.withTransport((tr) => tr.readLedMatrix(0));
    expect(leds).toHaveLength(126);
    expect(leds.every((l) => Number.isFinite(l.r) && Number.isFinite(l.g) && Number.isFinite(l.b))).toBe(true);
  });
});
