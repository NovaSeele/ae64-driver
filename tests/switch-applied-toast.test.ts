import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import { findSwitch } from '../src/protocol/switches';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import SwitchPage from '../src/pages/SwitchPage.vue';
import { useToast } from '../src/components/ui/toast';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { switchName } from '../src/data/switchDisplay';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

let w: VueWrapper | null = null;
const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }, { path: '/switch', component: { template: '<i />' } }] });
const body = () => document.body;
const opt = (name: string) => [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === name)!;
const lastToast = () => useToast().items.value.at(-1)?.text;

async function pickAndApply(ids: number[], tabText: string, name: string) {
  w = mount(SwitchCard, { props: { ids }, global: { plugins: [router()] }, attachTo: document.body });
  (w.find('.swc__foot button').element as HTMLElement).click();
  await flushPromises();
  if (tabText) [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes(tabText))!.click();
  await flushPromises();
  opt(name).click();
  await flushPromises();
  [...body().querySelectorAll<HTMLButtonElement>('.dialog button, [role=dialog] button')].find((b) => b.classList.contains('btn--primary') || /Áp dụng|Apply/.test(b.textContent ?? ''))!.click();
  await flushPromises();
}

describe('Apply toast says whether recalibration is needed', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    useToast().items.value = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('a changed triple asks for recalibration', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const perf = usePerformanceStore();
    await perf.load();
    const apollo = findSwitch(perf.catalog, 4208)!;
    await pickAndApply([W.id], 'Gateron', 'Apollo');
    expect(lastToast()).toBe(t('sw.appliedUncal', { n: 1, name: switchName(apollo) }));
  });

  it('a key that keeps its triple and stays calibrated gets the plain text', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const perf = usePerformanceStore();
    await perf.load();
    expect(perf.uncalibrated).toEqual([]);
    // Same switch, but a travel value above its range: the key is clamped, the triple is unchanged.
    const cur = perf.switchOf(W.id)!;
    perf.values[W.id] = { ...perf.values[W.id], normalPress: cur.rangeMax / 1000 + 1 };
    await pickAndApply([W.id], '', switchName(cur));
    expect(lastToast()).toBe(t('sw.applied', { n: 1, name: switchName(cur) }));
  });

  it('the recalibration status comes before the key list in the card', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const perf = usePerformanceStore();
    await perf.load();
    perf.uncalibrated = [W.id];
    w = mount(SwitchPage, { global: { plugins: [router()] }, attachTo: document.body });
    await flushPromises();
    const recal = w.find('.swp__recal').element;
    const list = w.find('.swp__list').element;
    expect(recal.parentElement).toBe(list.parentElement);
    expect(recal.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
