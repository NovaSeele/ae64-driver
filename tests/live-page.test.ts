import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import LiveTravelPage from '../src/pages/LiveTravelPage.vue';
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
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    const w = mount(LiveTravelPage, { global: { plugins: [router] }, attachTo: document.body });
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
});
