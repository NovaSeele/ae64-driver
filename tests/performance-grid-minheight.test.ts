import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import PerformancePage from '../src/pages/PerformancePage.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { t } from '../src/i18n/vi';

const E = PHYSICAL_KEYS.find((k) => k.name === 'E')!.id;

/** Fake ResizeObserver: tests report a height through report(). */
let observers: FakeRO[] = [];
class FakeRO {
  targets = new Set<Element>();
  constructor(private cb: (entries: unknown[]) => void) {
    observers.push(this);
  }
  observe(el: Element) { this.targets.add(el); }
  unobserve(el: Element) { this.targets.delete(el); }
  disconnect() { this.targets.clear(); }
  report(h: number, w = 0) {
    for (const target of [...this.targets]) this.cb([{ target, borderBoxSize: [{ blockSize: h, inlineSize: w }], contentRect: { height: h, width: w } }]);
  }
}
const report = (h: number, w = 0) => observers.forEach((o) => o.report(h, w));
const grid = () => document.body.querySelector<HTMLElement>('.grid')!;
const seg = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.trim() === label)!;

let w: VueWrapper | null = null;
async function setup() {
  const device = useDeviceStore();
  await device.connectDemo();
  await usePerformanceStore().load();
  useSelectionStore().selectMany([E]);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(PerformancePage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
  await flushPromises();
}

describe('Performance grid never gets shorter', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    observers = [];
    vi.stubGlobal('ResizeObserver', FakeRO);
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('rises with a larger height, holds against a smaller one', async () => {
    await setup();
    expect(grid().style.minHeight).toBe('');
    report(500);
    await flushPromises();
    expect(grid().style.minHeight).toBe('500px');
    report(400);
    await flushPromises();
    expect(grid().style.minHeight).toBe('500px');
    report(620);
    await flushPromises();
    expect(grid().style.minHeight).toBe('620px');
  });

  it('is not reset by a mode change', async () => {
    await setup();
    report(500);
    await flushPromises();
    seg(t('perf.modeStandard')).click();
    await flushPromises();
    expect(grid().style.minHeight).toBe('500px');
  });

  it('resets on a width change, not on a height-only resize', async () => {
    await setup();
    report(500);
    await flushPromises();
    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(grid().style.minHeight).toBe('500px');
    const prev = window.innerWidth;
    vi.stubGlobal('innerWidth', prev + 100);
    window.dispatchEvent(new Event('resize'));
    await flushPromises();
    expect(grid().style.minHeight).toBe('');
    report(300);
    await flushPromises();
    expect(grid().style.minHeight).toBe('300px');
  });
  it('resets when the grid itself gets wider or narrower (folding the sidebar keeps the window width)', async () => {
    await setup();
    report(829, 1000);
    await flushPromises();
    expect(grid().style.minHeight).toBe('829px');
    report(829, 1000); // the same width: still held
    await flushPromises();
    expect(grid().style.minHeight).toBe('829px');
    report(829, 1176); // sidebar folded: wider grid, old height is stale
    await new Promise((r) => requestAnimationFrame(() => r(null))); // the reset runs on the next frame
    await flushPromises();
    expect(grid().style.minHeight).toBe('');
    report(683, 1176); // fresh measurement at the new width
    await flushPromises();
    expect(grid().style.minHeight).toBe('683px');
    report(600, 1176);
    await flushPromises();
    expect(grid().style.minHeight).toBe('683px'); // held again
  });
});
