import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport } from '../src/protocol';
import SwitchPage from '../src/pages/SwitchPage.vue';
import { findSwitch } from '../src/protocol/switches';
import { useSyncStore } from '../src/stores/sync';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { useCalibrationStore } from '../src/stores/calibration';
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

describe('Switch page tabs', () => {
  const App = defineComponent({ render: () => h(RouterView) });
  const mountAt = async (url: string) => {
    const device = useDeviceStore();
    await device.connectDemo();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: '/switch', component: SwitchPage },
        { path: '/calibration', redirect: { path: '/switch', query: { tab: 'calibration' } } },
        { path: '/other', component: { template: '<i />' } },
      ],
    });
    await router.push(url);
    w = mount(App, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return { router, device };
  };
  const tabEl = (id: string) => w!.find(`[role="tab"][data-id="${id}"]`);
  const selected = () => w!.findAll('[role="tab"]').filter((x) => x.attributes('aria-selected') === 'true').map((x) => x.attributes('data-id'));

  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    localStorage.clear();
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => {
    useCalibrationStore().phase = 'idle'; // unmounting a running session would cancel it
    w?.unmount(); w = null; document.body.innerHTML = ''; localStorage.clear(); vi.unstubAllGlobals();
  });

  it('opens the tab from ?tab=, then localStorage, then Switch', async () => {
    await mountAt('/switch?tab=calibration');
    expect(selected()).toEqual(['calibration']);
    expect(w!.find('.kbrow').exists()).toBe(true);
    w!.unmount(); w = null;

    localStorage.setItem('ae64.switchTab', 'calibration');
    await mountAt('/switch');
    expect(selected()).toEqual(['calibration']);
    w!.unmount(); w = null;

    localStorage.setItem('ae64.switchTab', 'bogus');
    await mountAt('/switch?tab=nope');
    expect(selected()).toEqual(['switch']);
    expect(w!.find('.swp').exists()).toBe(true);
  });

  it('a tab click saves the choice and replaces the query without adding history, and sends nothing', async () => {
    const { router, device } = await mountAt('/switch?tab=switch');
    const mock = device.transport as MockTransport;
    const writes = [vi.spyOn(mock, 'setPerformance'), vi.spyOn(mock, 'commit')];
    const len = window.history.length;
    await tabEl('calibration').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('calibration');
    expect(localStorage.getItem('ae64.switchTab')).toBe('calibration');
    expect(selected()).toEqual(['calibration']);
    expect(window.history.length).toBe(len);
    for (const s of writes) expect(s).not.toHaveBeenCalled();
  });

  it('/calibration redirects to the Calibration tab', async () => {
    const { router } = await mountAt('/calibration');
    expect(router.currentRoute.value.path).toBe('/switch');
    expect(router.currentRoute.value.query.tab).toBe('calibration');
    expect(selected()).toEqual(['calibration']);
  });

  it('arrow keys skip a disabled tab', async () => {
    await mountAt('/switch?tab=calibration');
    useCalibrationStore().phase = 'running';
    await flushPromises();
    expect(tabEl('switch').attributes('disabled')).toBeDefined();
    await tabEl('calibration').trigger('keydown', { key: 'ArrowLeft' });
    await tabEl('calibration').trigger('keydown', { key: 'ArrowRight' });
    expect(selected()).toEqual(['calibration']);
  });

  it('locks the Switch tab and shows the reason while calibration is busy; Calibration stays reachable', async () => {
    await mountAt('/switch?tab=calibration');
    expect(w!.find('[role="status"].swtabs-row__hint').exists()).toBe(false);
    expect(tabEl('switch').attributes('disabled')).toBeUndefined();
    for (const phase of ['starting', 'running', 'finishing'] as const) {
      useCalibrationStore().phase = phase;
      await flushPromises();
      expect(tabEl('switch').attributes('disabled')).toBeDefined();
      expect(tabEl('calibration').attributes('disabled')).toBeUndefined();
      expect(w!.find('[role="status"].swtabs-row__hint').text()).toBe('Đang hiệu chuẩn. Hoàn tất hoặc huỷ trước khi đổi switch.');
    }
    await tabEl('switch').trigger('click');
    expect(selected()).toEqual(['calibration']);
  });

  it('refuses a route update that resolves to the Switch tab while calibration is busy', async () => {
    const { router } = await mountAt('/switch?tab=calibration');
    useCalibrationStore().phase = 'running';
    await router.push('/switch?tab=switch');
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('calibration');
    expect(selected()).toEqual(['calibration']);
    await router.push('/switch'); // the nav item: no ?tab=, keeps the current tab
    expect(selected()).toEqual(['calibration']);
    await router.push('/switch?tab=calibration');
    expect(router.currentRoute.value.query.tab).toBe('calibration');

    useCalibrationStore().phase = 'idle';
    await router.push('/switch?tab=switch');
    await flushPromises();
    expect(selected()).toEqual(['switch']);
  });
});
