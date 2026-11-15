// WX6 item 10: a brightness / speed slider draft does not outlive the dock (unmounted mid-drag): the next arrow key steps
// from the stored value. Demo keyboard only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { setLocale } from '../src/i18n/locale';
import { useDeviceStore } from '../src/stores/device';
import { useLightingStore } from '../src/stores/lighting';
import { useSyncStore } from '../src/stores/sync';
import LightingPage from '../src/pages/LightingPage.vue';

vi.setConfig({ testTimeout: 30000 });

let page: VueWrapper | null = null;
afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
  page?.unmount();
  page = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  setLocale('vi');
});

describe('WX6: Lighting slider draft', () => {
  it('unmount the dock mid-drag, mount it again: an arrow steps from the stored value', async () => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('max');
    (device.transport as unknown as { latencyMs: number }).latencyMs = 0;
    const lighting = useLightingStore();
    await lighting.load();
    page = mount(LightingPage, { global: { plugins: [getActivePinia()!], stubs: { teleport: true } }, attachTo: document.body });
    await flushPromises();
    lighting.stopLivePolling();
    const stored = lighting.area0Base.brightness;
    const target = stored >= 50 ? 10 : 90; // far from the stored value
    const track = () => page!.find('.col--tune .sl').element as HTMLElement;
    const el = track();
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 10, right: 100, bottom: 10, x: 0, y: 0, toJSON: () => ({}) });
    el.setPointerCapture = () => undefined;
    el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: target, clientY: 5 }));
    await flushPromises();
    expect(page.find('.col--tune .field-val').text()).toBe(`${target}%`); // the draft shows
    // the dock goes away mid-drag (a reload of the lighting values) and comes back
    lighting.loading = true;
    await flushPromises();
    expect(page.find('.col--tune').exists()).toBe(false);
    lighting.loading = false;
    await flushPromises();
    expect(page.find('.col--tune .field-val').text()).toBe(`${stored}%`);
    await page.find('.col--tune [role="slider"]').trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(lighting.area0Base.brightness).toBe(Math.min(100, stored + 1));
  });
});
