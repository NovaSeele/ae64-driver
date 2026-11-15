// WX6 U-15: the "an assigned key may not be calibrated" hint is judged on the chosen pad (with none picked: on every pad),
// not on index 0.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { useDeviceStore } from '../src/stores/device';
import { useGamepadStore } from '../src/stores/gamepad';
import { locale } from '../src/i18n/locale';

vi.setConfig({ testTimeout: 30000 });

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
const btn = (pressed = false, value = 0) => ({ pressed, touched: pressed, value });
const idle = { index: 0, id: 'Some other controller (STANDARD GAMEPAD)', connected: true, axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => btn()) };
const ae64 = { index: 1, id: 'Xbox 360 Controller (XInput STANDARD GAMEPAD)', connected: true, axes: [0.8, 0, 0, 0], buttons: Array.from({ length: 17 }, () => btn()) };

let w: VueWrapper | null = null;
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'en';
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  Object.defineProperty(navigator, 'getGamepads', { value: () => [idle, ae64, null, null], configurable: true });
});
afterEach(async () => {
  w?.unmount();
  w = null;
  await flushPromises();
  document.body.innerHTML = '';
  locale.value = 'vi';
  delete (navigator as unknown as { getGamepads?: unknown }).getGamepads;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ZERO = { lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, buttons: [] as string[] };
async function mountTest() {
  const device = useDeviceStore();
  await device.connectDemo('pro-xinput');
  await useGamepadStore().load();
  device.demo = false; // a real keyboard: the browser's Gamepad API is the source
  const { default: GamepadTest } = await import('../src/components/gamepad/GamepadTest.vue');
  w = mount(GamepadTest, {
    props: { reading: true, appState: ZERO, modeOff: false, 'onUpdate:reading': () => undefined },
    global: { plugins: [router()] },
    attachTo: document.body,
  });
  await flushPromises();
  const loop = async () => { frames[frames.length - 1](performance.now()); await flushPromises(); };
  await loop();
  return { loop };
}
const radios = () => w!.findAll('.gpt__pick [role="radio"]');

describe('WX6 U-15: calibration hint with two controllers', () => {
  it('none picked, the AE64 pad (index 1) moves as computed: no hint (judged on every pad, not index 0)', async () => {
    const { loop } = await mountTest();
    expect(radios().length).toBe(2);
    expect(radios().map((r) => r.attributes('aria-checked'))).toEqual(['false', 'false']);
    await w!.setProps({ appState: { ...ZERO, lx: 0.8 } });
    await new Promise((r) => setTimeout(r, 1650));
    await loop();
    expect(w!.find('.gpt__cal').exists()).toBe(false);
  });

  it('the idle pad picked: the hint shows after 1.5 s; picking the AE64 pad takes it back', async () => {
    const { loop } = await mountTest();
    await radios()[0].trigger('click');
    await w!.setProps({ appState: { ...ZERO, lx: 0.8 } });
    await new Promise((r) => setTimeout(r, 1650));
    await loop();
    expect(w!.find('.gpt__cal').exists()).toBe(true);
    await radios()[1].trigger('click');
    await flushPromises();
    expect(radios().map((r) => r.attributes('aria-checked'))).toEqual(['false', 'true']);
    expect(w!.find('.gpt__cal').exists()).toBe(false);
    await new Promise((r) => setTimeout(r, 1650));
    await loop();
    expect(w!.find('.gpt__cal').exists()).toBe(false);
  });
});
