import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { PhysicalKey } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

let w: VueWrapper | null = null;

function card(ids: number[]) {
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }, { path: '/switch', component: { template: '<i />' } }] });
  w = mount(SwitchCard, { props: { ids }, global: { plugins: [router] }, attachTo: document.body });
  return w;
}

/** The status lives in the board-wide "Switch trên bàn phím" card of the page, not in the selected-keys card. */
async function page() {
  ({ w } = await mountPerformance('switch'));
  return w;
}
const status = () => w!.find('.swp__recal');

/** The board sets the flag itself when a calibration ends; poke the mock's record byte 16 like the firmware does. */
function setFlag(mock: MockTransport, key: PhysicalKey, v: number) {
  const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number };
  m.profiles[m.active].perf.get(`${key.row}:${key.col}`)![16] = v;
}

describe('switch change resets calibration', () => {
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

  it('shows the board state: after apply, over undo, until calibrated again', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const mock = device.transport as MockTransport;
    const perf = usePerformanceStore();
    await perf.load();
    const apollo = findSwitch(perf.catalog, 4208)!;
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const wrapper = await page();
    await flushPromises();
    expect(perf.uncalibrated).toEqual([]);
    expect(status().exists()).toBe(false);

    perf.applySwitch([W.id], apollo);
    await useSyncStore().flush();
    await flushPromises();
    expect(setPerf.mock.calls[0][1].calibrate).toBe(1); // copied from the last fresh read, as before
    expect((await mock.getPerformance(W)).calibrate).toBe(0);
    expect(perf.values[W.id].calibrate).toBe(0);
    expect(perf.uncalibrated).toEqual([W.id]);
    expect(status().exists()).toBe(true);
    expect(status().attributes('role')).toBe('status');
    expect(status().text()).toContain('1 phím chưa được hiệu chuẩn: W. Hành trình đo chưa đúng cho tới khi hiệu chuẩn lại.');
    expect(status().text()).toContain('Hiệu chuẩn ngay');
    expect(status().find('.swp__recal-x').exists()).toBe(false); // no Hide
    expect(status().element.closest('.card')?.textContent).toContain('Switch trên bàn phím');
    expect(wrapper.find('.swc__recal').exists()).toBe(false); // not in the selected-keys card

    useHistoryStore().undo();
    await useSyncStore().flush();
    await flushPromises();
    expect(setPerf.mock.calls[1][1].calibrate).toBe(0); // newest fresh read
    expect(perf.uncalibrated).toEqual([W.id]);
    expect(status().exists()).toBe(true);
    wrapper.unmount();
    await page();
    await flushPromises();
    expect(status().exists()).toBe(true);

    // Calibrated again, then the store re-reads (the calibration store's reload does this).
    setFlag(mock, W, 1);
    await perf.load(true);
    await flushPromises();
    expect(perf.uncalibrated).toEqual([]);
    expect(status().exists()).toBe(false);
  });

  it('a key uncalibrated at load is included, board-wide', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    setFlag(device.transport as MockTransport, A, 0);
    const perf = usePerformanceStore();
    await perf.load();
    expect(perf.uncalibrated).toEqual([A.id]);
    // The selection holds another key: the status is still shown, and names the uncalibrated one.
    await page();
    await flushPromises();
    expect(status().text()).toContain('1 phím chưa được hiệu chuẩn: A.');
  });

  it('names the first 8 uncalibrated keys in board order, then +m', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const keys = device.keys.slice(0, 10);
    keys.forEach((k) => setFlag(device.transport as MockTransport, k, 0));
    const perf = usePerformanceStore();
    await perf.load(true);
    await page();
    await flushPromises();
    expect(perf.uncalibrated).toHaveLength(10);
    const first8 = keys.slice(0, 8).map((k) => device.legend(k)).join(', ');
    expect(status().text()).toContain(`10 phím chưa được hiệu chuẩn: ${first8} +2. Hành trình`);
  });

  it('a non-switch edit does not add a key', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const perf = usePerformanceStore();
    await perf.load();
    perf.apply([A.id], () => ({ normalPress: 1.5 }), 'x');
    await useSyncStore().flush();
    expect(perf.uncalibrated).toEqual([]);
  });

  describe('picker summary', () => {
    const body = () => document.body;
    const opt = (name: string) => [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === name)!;
    const warns = () => [...body().querySelectorAll('.swp__warn')].map((p) => p.textContent);

    async function open(ids: number[]) {
      const device = useDeviceStore();
      await device.connectDemo();
      await usePerformanceStore().load();
      card(ids);
      (w!.find('.swc__foot button').element as HTMLElement).click();
      await flushPromises();
    }

    it('names the keys whose triple changes', async () => {
      await open([W.id, A.id]);
      [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes('Gateron'))!.click();
      await flushPromises();
      opt('Apollo').click();
      await flushPromises();
      expect(warns()).toContain('Đổi switch sẽ xoá hiệu chuẩn của 2 phím. Cần hiệu chuẩn lại sau đó; hoàn tác không khôi phục được hiệu chuẩn.');
    });

    it('does not show it when no triple changes', async () => {
      await open([W.id]);
      opt('UR Ice HE-Ex').click(); // the switch already in use
      await flushPromises();
      expect(warns()).toEqual([]);
    });
  });
});
