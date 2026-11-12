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
    const change = () => w!.find('.swc__foot button');
    expect(w.find('.swc__note').text()).toContain('Chưa chọn phím');
    expect(change().attributes('disabled')).toBeDefined();
    // the change button sits in the footer of the selected-keys card (the right-hand card), not in its header
    expect(w.findAll('.swp > .card')[1].find('.swc__foot button').exists()).toBe(true);
    expect(w.find('.card__actions').exists()).toBe(false);

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

  it('"Hiệu chuẩn ngay" in the uncalibrated status opens the Calibration tab and sends nothing', async () => {
    const { router, device } = await mountAt('/switch?tab=switch');
    const mock = device.transport as MockTransport;
    const writes = [vi.spyOn(mock, 'setPerformance'), vi.spyOn(mock, 'commit')];
    const k = device.keys[0];
    const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number };
    m.profiles[m.active].perf.get(`${k.row}:${k.col}`)![16] = 0; // the board reports the key uncalibrated
    await usePerformanceStore().load(true);
    await flushPromises();
    expect(usePerformanceStore().uncalibrated).toEqual([k.id]);
    await w!.find('.swp__recal-go').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.tab).toBe('calibration');
    expect(selected()).toEqual(['calibration']);
    for (const s of writes) expect(s).not.toHaveBeenCalled();
  });

  it('/calibration redirects to the Calibration tab', async () => {
    const { router } = await mountAt('/calibration');
    expect(router.currentRoute.value.path).toBe('/switch');
    expect(router.currentRoute.value.query.tab).toBe('calibration');
    expect(selected()).toEqual(['calibration']);
  });

  it('arrow keys skip the locked option; Home/End pick an enabled one', async () => {
    await mountAt('/switch?tab=calibration');
    useCalibrationStore().phase = 'running';
    await flushPromises();
    expect(tabEl('switch').attributes('disabled')).toBeDefined();
    for (const key of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) await tabEl('calibration').trigger('keydown', { key });
    expect(selected()).toEqual(['calibration']);
  });

  it('Home, End and arrows move between the two options when idle', async () => {
    await mountAt('/switch?tab=calibration');
    await tabEl('calibration').trigger('keydown', { key: 'Home' });
    await flushPromises();
    expect(selected()).toEqual(['switch']);
    await tabEl('switch').trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(selected()).toEqual(['calibration']);
    await tabEl('calibration').trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(selected()).toEqual(['switch']);
  });

  it('locks the Switch option inside its card while calibration is busy (no hint row); Calibration stays reachable', async () => {
    await mountAt('/switch?tab=calibration');
    expect(tabEl('switch').attributes('disabled')).toBeUndefined();
    expect(tabEl('switch').find('.feat__sub').text()).toBe('Xem và đổi switch của từng phím');
    expect(tabEl('switch').find('.feat__lock').exists()).toBe(false);
    expect(tabEl('switch').attributes('title')).toBeUndefined();
    expect((tabEl('switch').find('.feat__tile').element as HTMLElement).style.getPropertyValue('--f')).toBe('var(--f-switch)');
    for (const phase of ['starting', 'running', 'finishing'] as const) {
      useCalibrationStore().phase = phase;
      await flushPromises();
      expect(tabEl('switch').attributes('disabled')).toBeDefined();
      expect(tabEl('calibration').attributes('disabled')).toBeUndefined();
      expect(tabEl('switch').find('.feat__sub').text()).toBe('Đang khoá trong lúc hiệu chuẩn');
      expect(tabEl('switch').find('.feat__lock svg').exists()).toBe(true);
      expect(tabEl('switch').find('.feat__dot').exists()).toBe(false);
      // the tile turns grey too (an inline --f would otherwise beat the stylesheet)
      expect((tabEl('switch').find('.feat__tile').element as HTMLElement).style.getPropertyValue('--f')).toBe('var(--fg-3)');
      expect(tabEl('switch').attributes('title')).toBe('Đang hiệu chuẩn. Hoàn tất hoặc huỷ trước khi đổi switch.');
      expect(w!.find('.feat-row').element.children).toHaveLength(1); // no hint row
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

  it('calibration: Start sits in the progress card and still opens the confirm, then starts the session', async () => {
    await mountAt('/switch?tab=calibration');
    const cal = useCalibrationStore();
    const start = vi.spyOn(cal, 'start').mockResolvedValue(undefined as never);
    const progress = w!.find('.progress');
    expect(w!.findAll('.grid > .card')[0].find('.actions').exists()).toBe(false);
    const btn = progress.find('.session .actions button');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toContain('Bắt đầu');
    await btn.trigger('click');
    await flushPromises();
    expect(start).not.toHaveBeenCalled(); // the confirm dialog comes first
    const ok = [...document.body.querySelectorAll('button')].filter((b) => b.textContent?.trim().startsWith('Bắt đầu')).pop()!;
    ok.click();
    await flushPromises();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('calibration: Start is disabled on a board that is not allowed', async () => {
    await mountAt('/switch?tab=calibration');
    useDeviceStore().boardAllowed = false;
    await flushPromises();
    const btn = w!.find('.progress .session .actions button');
    expect(btn.text()).toContain('Bắt đầu');
    expect(btn.attributes('disabled')).toBeDefined();
  });
});
