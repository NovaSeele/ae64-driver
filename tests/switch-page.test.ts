import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport } from '../src/protocol';
import SwitchPage from '../src/pages/SwitchPage.vue';
import { findSwitch } from '../src/protocol/switches';
import { useSyncStore } from '../src/stores/sync';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { groupKeys } from '../src/components/performance/switchGroups';
import { locale } from '../src/i18n/locale';

let w: VueWrapper | null = null;

describe('Switch page', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('lists each switch group, selects its keys on click, shows a swatch on every cap, and writes nothing', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore();
    await perf.load();
    // The demo board has one switch: fit another in three keys (before the write spies start) so there are two groups.
    perf.applySwitch([0, 1, 2], findSwitch(perf.catalog, 4208)!);
    await useSyncStore().flush();
    await perf.load(true);
    const writes = [vi.spyOn(mock, 'setPerformance'), vi.spyOn(mock, 'commit')];
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(SwitchPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();

    const expected = groupKeys(device.keys.map((k) => k.id), perf.values, (id) => perf.catalog?.findIndex((e) => e.id === id) ?? Infinity);
    const rows = w.findAll('.swp__row');
    expect(rows).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThan(1);
    rows.forEach((r, i) => expect(r.find('.swp__count').text()).toBe(`${expected[i].ids.length} phím`));

    // every keycap has a swatch in .cap__extra
    expect(w.findAll('.cap')).toHaveLength(device.keys.length);
    expect(w.findAll('.cap__extra .swatch')).toHaveLength(device.keys.length);

    // nothing selected: the card says so and its button is disabled
    const change = () => w!.find('.card__actions button');
    expect(w.find('.swc__note').text()).toContain('Chưa chọn phím');
    expect(change().attributes('disabled')).toBeDefined();

    await rows[1].trigger('click');
    expect(useSelectionStore().ids).toEqual([...expected[1].ids].sort((a, b) => a - b));
    expect(rows[1].attributes('aria-pressed')).toBe('true');
    expect(rows[0].attributes('aria-pressed')).toBe('false');
    expect(change().attributes('disabled')).toBeUndefined();

    for (const s of writes) expect(s).not.toHaveBeenCalled();
  });
});
