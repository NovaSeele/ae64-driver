import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { mountPerformance } from './mountPerformance';
import TravelGraph from '../src/components/live/TravelGraph.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
import { locale } from '../src/i18n/locale';

describe('Live travel page wiring', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("passes the graph's review signal to live.suspendFollow, and lifts it on unmount", async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    await usePerformanceStore().load();
    const live = useLiveStore();
    const suspend = vi.spyOn(live, 'suspendFollow');
    const { w } = await mountPerformance('test');
    await flushPromises();

    const graph = w.findComponent(TravelGraph);
    expect(graph.exists()).toBe(true);
    graph.vm.$emit('review', true);
    expect(suspend.mock.calls).toEqual([[true]]);
    graph.vm.$emit('review', false);
    expect(suspend.mock.calls).toEqual([[true], [false]]);

    graph.vm.$emit('review', true);
    suspend.mockClear();
    w.unmount();
    expect(suspend).toHaveBeenCalledWith(false);
  });

  it('keeps the mismatch alert inside the simulation card and the sampling rate in its footer', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    await usePerformanceStore().load();
    const live = useLiveStore();
    let frame: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frame = cb; return 1; });
    const { w } = await mountPerformance('test');
    await flushPromises();
    // the page reads live.data once per animation frame: run one frame with the mismatch flag set
    live.data.mismatch = true;
    frame!(1000);
    await flushPromises();

    const sim = w.find('.simcard');
    expect(sim.find('.mismatch').exists()).toBe(true);
    expect(w.find('.readcard .mismatch').exists()).toBe(false);
    const foot = sim.find('.ratefoot');
    expect(foot.text()).toContain('Tốc độ đo');
    expect(foot.text()).toContain('Hz');
    expect(w.find('.stats').text()).not.toContain('Hz');
    expect(w.findAll('.stats > div')).toHaveLength(4);
  });
});
