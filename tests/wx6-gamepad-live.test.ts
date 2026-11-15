// WX6 U-15 / U-17: the Gamepad page while "read key travel" is on: no keyboard render while no key moves; a failed read
// retries after 1 s (up to 3 times running), then the switch turns off and says why.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import GamepadPage from '../src/pages/GamepadPage.vue';
import { useDeviceStore } from '../src/stores/device';
import { useGamepadStore } from '../src/stores/gamepad';
import { useLiveStore } from '../src/stores/live';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
let w: VueWrapper | null = null;
let frames: FrameRequestCallback[] = [];
let clock = 10_000;
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'en';
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
  w?.unmount();
  w = null;
  useLiveStore().stop();
  await flushPromises();
  document.body.innerHTML = '';
  locale.value = 'vi';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  const device = useDeviceStore();
  await device.connectDemo('pro-xinput');
  const legend = vi.fn(device.legend);
  (device as unknown as { legend: typeof device.legend }).legend = legend;
  w = mount(GamepadPage, { global: { plugins: [router()] }, attachTo: document.body });
  await flushPromises();
  const gp = useGamepadStore();
  await vi.waitFor(() => expect(gp.travelKnown && w!.find('.gpo').exists()).toBe(true), { timeout: 10000 });
  const sw = () => w!.findAll('button[role="switch"]').find((b) => b.attributes('aria-label') === tr('gp.appRead'))!;
  await sw().trigger('click');
  await flushPromises();
  return { device, gp, live: useLiveStore(), legend, sw };
}
/** Run the page's newest `sample` animation frame, 50 ms after the one before. */
async function frame(): Promise<boolean> {
  const cb = [...frames].reverse().find((f) => f.name === 'sample');
  if (!cb) return false;
  clock += 50;
  cb(clock);
  await flushPromises();
  return true;
}

describe('WX6 U-17: no render at rest', () => {
  it('no keyboard render on a frame while no key moves (the poller reads on)', async () => {
    const { live, legend } = await open();
    expect(live.running).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    await frame();
    const perFrame: number[] = [];
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const before = legend.mock.calls.length;
      expect(await frame()).toBe(true);
      perFrame.push(legend.mock.calls.length - before);
    }
    expect(perFrame).toEqual(Array(10).fill(0));
  });

  it('a key that goes down renders once; a change 10 ms later waits for the next 33 ms window', async () => {
    const { device, live, legend } = await open();
    live.stop(); // the demo poller would read the keys back to rest
    await frame();
    const D = device.keys.find((k) => k.name === 'D')!;
    const status = (v: number) => { const vals = new Array(16).fill(0); vals[D.col] = v; live.ingest('keyStatus', D.row, vals, 0); };
    const run = async (at: number) => {
      const before = legend.mock.calls.length;
      [...frames].reverse().find((f) => f.name === 'sample')!(at);
      await flushPromises();
      return legend.mock.calls.length - before;
    };
    status(1);
    clock += 50;
    expect(await run(clock)).toBeGreaterThan(0); // D down: one render
    status(0);
    expect(await run(clock + 10)).toBe(0); // within 33 ms of the last render: waits
    expect(await run(clock + 40)).toBeGreaterThan(0); // the next window: D up
  });
});

describe('WX6 U-15: a failed read', () => {
  it('one failed read: the poller starts again after 1 s, the switch stays on', async () => {
    const { device, live, sw } = await open();
    const t = device.transport!;
    const real = t.getAxisData.bind(t);
    let failed = false;
    vi.spyOn(t, 'getAxisData').mockImplementation((type, row) => {
      if (!failed) { failed = true; return Promise.reject(new Error('timeout')); }
      return real(type, row);
    });
    await vi.waitFor(() => expect(live.running).toBe(false), { timeout: 5000 });
    await vi.waitFor(() => expect(live.running).toBe(true), { timeout: 3000 });
    const sent: number[][] = [];
    t.onPacketRaw((dir, b) => { if (dir === 'out') sent.push([b[0], b[1]]); });
    await new Promise((r) => setTimeout(r, 200));
    expect(sw().attributes('aria-checked')).toBe('true');
    expect(sent.filter((p) => p[0] === 4 && p[1] === 3).length).toBeGreaterThan(0);
    expect(w!.find('[data-test="gp-read-error"]').exists()).toBe(false);
  });

  it('every read fails: three retries, then the switch is off and says why; nothing more is read', async () => {
    const { device, live, sw } = await open();
    const t = device.transport!;
    let calls = 0;
    vi.spyOn(t, 'getAxisData').mockImplementation(() => { calls++; return Promise.reject(new Error('timeout')); });
    await vi.waitFor(() => expect(sw().attributes('aria-checked')).toBe('false'), { timeout: 8000 });
    expect(calls).toBe(4); // the first read and three retries
    expect(live.running).toBe(false);
    expect(w!.find('[data-test="gp-read-error"]').text()).toBe(tr('gp.readStopped', { msg: 'timeout' }));
    await new Promise((r) => setTimeout(r, 1300));
    expect(calls).toBe(4);
  });
});

describe('WX7 0a: read retry edges (GP1, GP3, GP5)', () => {
  it('four failures, each followed by good reads: the switch stays on (a good read resets the count)', async () => {
    const { device, live, sw } = await open();
    const t = device.transport!;
    const real = t.getAxisData.bind(t);
    let failNext = false;
    vi.spyOn(t, 'getAxisData').mockImplementation((type, row) => {
      if (failNext) { failNext = false; return Promise.reject(new Error('timeout')); }
      return real(type, row);
    });
    for (let i = 0; i < 4; i++) {
      failNext = true;
      await vi.waitFor(() => expect(live.running).toBe(false), { timeout: 5000 });
      await vi.waitFor(() => expect(live.running).toBe(true), { timeout: 3000 });
      await new Promise((r) => setTimeout(r, 80)); // good reads
      expect(await frame()).toBe(true); // the page sees them
    }
    expect(sw().attributes('aria-checked')).toBe('true');
    expect(w!.find('[data-test="gp-read-error"]').exists()).toBe(false);
  });

  it('stopped with the error, turned on again, then off by hand: no error text', async () => {
    const { device, live, sw } = await open();
    const t = device.transport!;
    const spy = vi.spyOn(t, 'getAxisData').mockImplementation(() => Promise.reject(new Error('timeout')));
    await vi.waitFor(() => expect(sw().attributes('aria-checked')).toBe('false'), { timeout: 8000 });
    expect(w!.find('[data-test="gp-read-error"]').exists()).toBe(true);
    spy.mockRestore();
    await sw().trigger('click');
    await flushPromises();
    expect(live.running).toBe(true);
    await sw().trigger('click');
    await flushPromises();
    expect(sw().attributes('aria-checked')).toBe('false');
    expect(w!.find('[data-test="gp-read-error"]').exists()).toBe(false);
  });

  it('two failures, off and on: three retries are still available', async () => {
    const { device, sw } = await open();
    const t = device.transport!;
    let calls = 0;
    vi.spyOn(t, 'getAxisData').mockImplementation(() => { calls++; return Promise.reject(new Error('timeout')); });
    await vi.waitFor(() => expect(calls).toBe(2), { timeout: 5000 });
    await flushPromises();
    await sw().trigger('click'); // off by hand
    await flushPromises();
    const from = calls;
    await sw().trigger('click'); // on again
    await flushPromises();
    await vi.waitFor(() => expect(sw().attributes('aria-checked')).toBe('false'), { timeout: 8000 });
    expect(calls - from).toBe(4); // the first read and three retries again
  });
});
