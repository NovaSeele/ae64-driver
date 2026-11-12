import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

let w: VueWrapper | null = null;

function card(ids: number[]) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }, { path: '/switch', component: { template: '<i />' } }] });
  w = mount(SwitchCard, { props: { ids }, global: { plugins: [router] }, attachTo: document.body });
  return w;
}

describe('switch change resets calibration', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; });

  it('tracks the key from the board read-back, over undo and until it is calibrated again', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore();
    await perf.load();
    const apollo = findSwitch(perf.catalog, 4208)!;
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const wrapper = card([W.id]);
    expect(wrapper.find('.swc__recal').exists()).toBe(false);

    perf.applySwitch([W.id], apollo);
    await useSyncStore().flush();
    await flushPromises();
    expect(setPerf.mock.calls[0][1].calibrate).toBe(1); // copied from the last fresh read, as before
    expect((await mock.getPerformance(W)).calibrate).toBe(0);
    expect(perf.values[W.id].calibrate).toBe(0);
    expect(perf.recalKeys).toEqual([W.id]);
    expect(wrapper.find('.swc__recal').exists()).toBe(true);

    useHistoryStore().undo();
    await useSyncStore().flush();
    await flushPromises();
    expect(setPerf.mock.calls[1][1].calibrate).toBe(0); // newest fresh read
    expect(perf.recalKeys).toEqual([W.id]);
    wrapper.unmount();
    expect(card([W.id]).find('.swc__recal').exists()).toBe(true);

    // Hide lasts until a new key joins recalKeys.
    await w!.find('.swc__recal-x').trigger('click');
    expect(w!.find('.swc__recal').exists()).toBe(false);

    // Calibrated again (as the calibration tab does), then the store re-reads.
    await mock.setPerformance(W, { ...(await mock.getPerformance(W)), calibrate: 1 });
    await perf.load(true);
    await flushPromises();
    expect(perf.recalKeys).toEqual([]);
    expect(w!.find('.swc__recal').exists()).toBe(false);
  });

  it('a non-switch edit does not add a key', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const perf = usePerformanceStore();
    await perf.load();
    perf.apply([A.id], () => ({ normalPress: 1.5 }), 'x');
    await useSyncStore().flush();
    expect(perf.recalKeys).toEqual([]);
  });
});
