// WX6 U-14: leaving the Key test tab while a profile change reads the new values leaves the 04 03 poller off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
import { locale } from '../src/i18n/locale';

vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'vi';
  localStorage.clear();
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  w?.unmount();
  w = null;
  useLiveStore().stop();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WX6 U-14: Key test tab, a profile change, then leaving the tab', () => {
  it('no 04 03 read after the tab was unmounted', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const perf = usePerformanceStore();
    await perf.load();
    const live = useLiveStore();
    w = (await mountPerformance('test')).w;
    await flushPromises();
    expect(live.running).toBe(true);
    await device.switchProfile(1);
    expect(live.running).toBe(false);
    expect(perf.loading).toBe(true);
    w.unmount();
    w = null;
    await vi.waitFor(() => expect(perf.loading).toBe(false), { timeout: 10000 });
    await flushPromises();
    const sent: number[][] = [];
    device.transport!.onPacketRaw((dir, b) => { if (dir === 'out') sent.push([b[0], b[1]]); });
    await new Promise((r) => setTimeout(r, 200));
    expect(live.running).toBe(false);
    expect(sent.filter((p) => p[0] === 0x04 && p[1] === 0x03).length).toBe(0);
  });

  it('still mounted: the poller starts again after the new profile is read', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    await usePerformanceStore().load();
    const live = useLiveStore();
    w = (await mountPerformance('test')).w;
    await flushPromises();
    await device.switchProfile(1);
    await vi.waitFor(() => expect(live.running).toBe(true), { timeout: 10000 });
  });
});
