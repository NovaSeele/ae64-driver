// WX6 item 9: the Key test keycap's result title and "deepest" text follow a language switch at once.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
import { locale, setLocale } from '../src/i18n/locale';
import { en } from '../src/i18n/en';
import { vi as viTable } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

let frames: FrameRequestCallback[] = [];
let w: VueWrapper | null = null;
let clock = 1000;
async function frame(): Promise<void> {
  clock += 100;
  frames.find((f) => f.name === 'frame')!(clock);
  await flushPromises();
}
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'vi';
  localStorage.clear();
  localStorage.setItem('ae64.live.colorByResult', '1');
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
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
  locale.value = 'vi';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('WX6: Key test tab and a language switch', () => {
  it('the keycap result title and "deepest" text switch to English with no key pressed', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    await usePerformanceStore().load();
    const live = useLiveStore();
    w = (await mountPerformance('test')).w;
    await flushPromises();
    live.stop();
    const W = device.keys.find((k) => k.name === 'W')!;
    const vals = new Array(16).fill(0);
    vals[W.col] = 3310;
    live.ingest('route', W.row, vals, 0);
    await frame();
    const cap = () => w!.find(`[data-key="${W.id}"]`).attributes('aria-label')!;
    expect(cap()).toContain(viTable['live.cFull']);
    expect(cap()).toContain('sâu nhất');

    setLocale('en');
    await flushPromises();
    expect(cap()).toContain(en['live.cFull']);
    expect(cap()).not.toContain(viTable['live.cFull']);
    expect(cap()).not.toContain('sâu nhất');
    expect(cap()).toContain(en['live.keyPeak'].split('{')[0].trim());
    expect(w!.text()).toContain(en['live.check']);
  });
});
