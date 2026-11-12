import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { toastSafeTarget, useToast } from '../src/components/ui/toast';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { locale } from '../src/i18n/locale';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

let w: VueWrapper | null = null;
const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
const body = () => document.body;

describe('SW-FOCUS-1 focus and position after a switch Apply', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    useToast().items.value = [];
    toastSafeTarget.value = 80; // the toast host publishes this; no layout in jsdom
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; toastSafeTarget.value = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('after Apply the trigger is focused and scrolled into view (nearest)', async () => {
    const scroll = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: scroll });
    const device = useDeviceStore();
    await device.connectDemo();
    const perf = usePerformanceStore();
    await perf.load();
    w = mount(SwitchCard, { props: { ids: [W.id] }, global: { plugins: [router()] }, attachTo: document.body });
    const trigger = w.find('.swc__foot button').element as HTMLButtonElement;
    trigger.click();
    await flushPromises();
    [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes('Gateron'))!.click();
    await flushPromises();
    [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === 'Apollo')!.click();
    await flushPromises();
    [...body().querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((b) => b.classList.contains('btn--primary'))!.click();
    await vi.waitFor(() => expect(scroll).toHaveBeenCalled(), { timeout: 2000 });
    expect(scroll.mock.calls.at(-1)![0]).toMatchObject({ block: 'nearest' });
    expect(scroll.mock.instances.at(-1)).toBe(trigger);
    expect(document.activeElement).toBe(trigger);
  }, 10000);

  it('when the trigger is not active after Apply it is focused with preventScroll', async () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', { configurable: true, writable: true, value: vi.fn() });
    const device = useDeviceStore();
    await device.connectDemo();
    await usePerformanceStore().load();
    w = mount(SwitchCard, { props: { ids: [W.id] }, global: { plugins: [router()] }, attachTo: document.body });
    const trigger = w.find('.swc__foot button').element as HTMLButtonElement;
    const focus = vi.spyOn(trigger, 'focus');
    trigger.click();
    await flushPromises();
    [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes('Gateron'))!.click();
    await flushPromises();
    [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === 'Apollo')!.click();
    await flushPromises();
    focus.mockClear();
    // Focus is elsewhere (document.body) when onApplied looks.
    const spy = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(document.body);
    [...body().querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find((b) => b.classList.contains('btn--primary'))!.click();
    await flushPromises();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    spy.mockRestore();
  }, 10000);

  it('the footer is not pinned to the bottom of the card, so its top does not follow the map card', () => {
    // jsdom has no layout: this checks the rule only. The real check is the browser measurement (trigger rect before/after the status appears).
    const src = readFileSync('src/components/performance/SwitchCard.vue', 'utf8');
    const rule = /\.swc__foot\s*\{([^}]*)\}/.exec(src)![1];
    expect(rule).not.toMatch(/margin-top:\s*auto/);
    expect(rule).toMatch(/margin-top:\s*var\(--s-4\)/);
  });
});
