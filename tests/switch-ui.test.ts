import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';

const ALL = PHYSICAL_KEYS.map((k) => k.id);
const named = (n: string) => PHYSICAL_KEYS.find((k) => k.name === n)!.id;

let w: VueWrapper | null = null;

async function setup() {
  const device = useDeviceStore();
  await device.connectDemo();
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }, { path: '/calibration', component: { template: '<i />' } }] });
  w = mount(SwitchCard, { props: { ids: ALL }, global: { plugins: [router] }, attachTo: document.body });
  return { device, mock, perf };
}
const body = () => document.body;
const btn = (text: string) => [...body().querySelectorAll('button')].find((b) => b.textContent?.trim().startsWith(text)) as HTMLButtonElement | undefined;
const opt = (name: string) => [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === name)!;
async function openDialog() {
  (w!.find('.card__actions button').element as HTMLElement).click();
  await flushPromises();
}

describe('switch selector UI', () => {
  beforeEach(() => { setActivePinia(createPinia()); locale.value = 'vi'; });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; });

  it('card shows the current switch of all keys in demo', async () => {
    await setup();
    expect(w!.find('.swc__name').text()).toBe('UR Ice HE-Ex');
    expect(w!.find('.swc__meta').text()).toBe('Ur Studio · 64 phím');
    expect(w!.find('.swc__mm').text()).toBe('3.31mm');
    expect(w!.find('.card__actions button').attributes('disabled')).toBeUndefined();
  });

  it('dialog opens on the in-use tab with counts 1/31/19/25', async () => {
    await setup();
    await openDialog();
    const tabs = [...body().querySelectorAll('[role=tab]')];
    expect(tabs.map((x) => x.querySelector('.tabs__n')?.textContent)).toEqual(['1', '31', '19', '25']);
    expect(body().querySelector('[role=tab][aria-selected=true]')?.textContent).toContain('Khác');
    expect(opt('UR Ice HE-Ex').querySelector('.sw-opt__tag')?.textContent).toBe('Đang dùng');
  });

  it('choosing writes nothing; clamp warning, Apply to N keys, then exactly those keys are written', async () => {
    const { mock, perf } = await setup();
    const three = [named('Esc'), named('Q'), named('Tab')];
    perf.apply(three, () => ({ mode: 0, normalPress: 3.2 }), 'long');
    await useSyncStore().flush();
    const setPerf = vi.spyOn(mock, 'setPerformance');
    const commit = vi.spyOn(mock, 'commit');

    await openDialog();
    [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes('GATERON'))!.click();
    await flushPromises();
    opt('Apollo').click();
    await flushPromises();
    expect(body().querySelector('.swp__warn')?.textContent).toBe('3 phím có actuation lớn hơn 3.13 mm sẽ được hạ về 3.13 mm.');
    expect(btn('Áp dụng')!.textContent?.trim()).toBe('Áp dụng cho 64 phím');
    // Enter on an option must not apply
    opt('Apollo').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    await useSyncStore().flush();
    expect(setPerf).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();

    btn('Áp dụng cho')!.click();
    await flushPromises();
    expect(body().querySelector('[role=dialog]')).toBeNull();
    await useSyncStore().flush();
    expect(setPerf).toHaveBeenCalledTimes(64);
    expect(new Set(setPerf.mock.calls.map((c) => `${c[0].row}:${c[0].col}`))).toEqual(new Set(PHYSICAL_KEYS.map((k) => `${k.row}:${k.col}`)));
    expect(perf.switchOf(ALL[0])?.name).toBe('阿波罗轴');
    expect(w!.find('.swc__name').text()).toBe('Apollo');
    expect(w!.find('.swc__recal').exists()).toBe(true);
  });

  it('choosing the current switch disables Apply', async () => {
    await setup();
    await openDialog();
    opt('UR Ice HE-Ex').click();
    await flushPromises();
    expect(body().querySelector('.swp__idle')?.textContent).toBe('Các phím đã dùng switch này.');
    const apply = btn('Áp dụng')!;
    expect(apply.disabled).toBe(true);
    expect(apply.textContent?.trim()).toBe('Áp dụng');
  });

  it('a null catalog renders read-only', async () => {
    const { device } = await setup();
    device.info = { ...device.info!, boardIdHex: '0030000a' };
    await flushPromises();
    const change = w!.find('.card__actions button');
    expect(change.attributes('disabled')).toBeDefined();
    expect(change.attributes('title')).toContain('0030000A');
    expect(w!.find('.swc__name').text()).toBe('Không rõ');
    expect(w!.find('.swc__meta').text()).toBe('id 12432 · 64 phím');
    expect(w!.find('.swc__note').text()).toContain('0030000A');
  });
});
