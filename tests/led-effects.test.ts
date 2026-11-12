import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { effectHint, effectName } from '../src/data/ledEffects';
import { setLocale } from '../src/i18n/locale';
import { useDeviceStore } from '../src/stores/device';
import { useLightingStore } from '../src/stores/lighting';
import LightingPage from '../src/pages/LightingPage.vue';

const MAX = '0030000d';
const PRO = '0030000a';

describe('effect names', () => {
  it('shows the recorded names in vi and en', () => {
    expect(effectName(MAX, 0, 3, 'vi')).toBe('Sóng dọc');
    expect(effectName(MAX, 0, 3, 'en')).toBe('Vertical wave');
    expect(effectName(MAX, 0, 16, 'en')).toBe('Raindrop');
    expect(effectName(MAX, 1, 4, 'vi')).toBe('Sóng đối xứng');
    expect(effectName(PRO, 0, 4, 'en')).toBe('Ripple');
  });

  it('has numbers only for 6, 7, 9 and the Pro 20, and for unknown boards', () => {
    for (const n of [6, 7, 9]) expect(effectName(MAX, 0, n, 'vi')).toBeNull();
    expect(effectName(PRO, 0, 20, 'en')).toBeNull();
    expect(effectName(MAX, 0, 20, 'en')).toBeNull();
    expect(effectName('deadbeef', 0, 3, 'en')).toBeNull();
    expect(effectName(undefined, 0, 3, 'en')).toBeNull();
    expect(effectName(MAX, 1, 6, 'en')).toBeNull();
  });

  it('17–19 are all Reactive, with a hint in the title', () => {
    for (const n of [17, 18, 19]) {
      expect(effectName(MAX, 0, n, 'vi')).toBe('Phản hồi khi gõ');
      expect(effectName(MAX, 0, n, 'en')).toBe('Reactive');
      expect(effectHint(MAX, 0, n, 'vi')).toBe('Sáng khi bạn gõ phím');
      expect(effectHint(MAX, 0, n, 'en')).toBe('Lights up as you type');
    }
    expect(effectHint(MAX, 0, 3, 'en')).toBeNull();
  });
});

describe('Lighting page: effect names', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale('en'); });

  async function mountPage(seed: 'max' | 'pro' = 'max') {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo(seed);
    (device.transport as any).latencyMs = 0;
    const lighting = useLightingStore();
    await lighting.load();
    const page = mount(LightingPage, { global: { plugins: [getActivePinia()!], stubs: { teleport: true } } });
    await flushPromises();
    return { page, lighting };
  }

  it('labels the buttons and the column head readout; the grid stays numeric', async () => {
    setLocale('vi');
    const { page, lighting } = await mountPage();
    const btns = () => page.findAll('.effect-btn');
    expect(btns()[2].attributes('aria-label')).toBe('Hiệu ứng 3 · Sóng dọc');
    expect(btns()[2].attributes('title')).toBe('Hiệu ứng 3 · Sóng dọc');
    expect(btns()[2].text()).toBe('3');
    expect(btns()[8].attributes('aria-label')).toBe('Hiệu ứng 9');
    expect(btns()[16].attributes('title')).toBe('Hiệu ứng 17 · Phản hồi khi gõ — Sáng khi bạn gõ phím');

    const readout = () => page.find('[data-testid="effect-readout"]');
    lighting.area0Base.mode = 2;
    await flushPromises();
    expect(readout().text()).toBe('3 · Sóng dọc');
    expect(readout().attributes('title')).toBe('Hiệu ứng 3 · Sóng dọc');
    lighting.area0Base.mode = 8;
    await flushPromises();
    expect(readout().text()).toBe('9');

    setLocale('en');
    lighting.area0Base.mode = 2;
    await flushPromises();
    expect(btns()[2].attributes('aria-label')).toBe('Effect 3 · Vertical wave');
    expect(readout().text()).toBe('3 · Vertical wave');
    page.unmount();
  });

  it('the Pro shows only the number on 20', async () => {
    setLocale('en');
    const { page } = await mountPage('pro');
    const btns = page.findAll('.effect-btn');
    expect(btns).toHaveLength(20);
    expect(btns[19].attributes('aria-label')).toBe('Effect 20');
    expect(btns[3].attributes('aria-label')).toBe('Effect 4 · Ripple');
    page.unmount();
  });
});
