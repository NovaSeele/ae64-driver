import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import type { PerfMode } from '../src/protocol';
import PerformancePage from '../src/pages/PerformancePage.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { releasePoint, settingsFrom } from '../src/stores/live';
import { t } from '../src/i18n/vi';

const id = (n: string) => PHYSICAL_KEYS.find((k) => k.name === n)!.id;
const Q = id('Q');
const W = id('W');

type Perf = ReturnType<typeof usePerformanceStore>;

/** matchMedia stub: the viewport width decides '(min-width: Npx)'. */
function stubWidth(width: number) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: width >= Number(/min-width:\s*(\d+)px/.exec(q)?.[1] ?? Infinity), // other queries (reduced motion…) never match
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

let w: VueWrapper | null = null;
function teardown() {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
}
const setModeOf = (perf: Perf, keys: number[], mode: PerfMode) => {
  const values = { ...perf.values };
  for (const k of keys) values[k] = { ...values[k], mode };
  perf.values = values;
};
/** Keys in the store only (no write): Q and W Standard by default, with the given fields. */
async function setup(select: number[], tweak?: (perf: Perf) => void) {
  const device = useDeviceStore();
  await device.connectDemo();
  const perf = usePerformanceStore();
  await perf.load();
  setModeOf(perf, [Q, W], 0);
  tweak?.(perf);
  useSelectionStore().selectMany(select);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(PerformancePage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
  await flushPromises();
  return perf;
}
function nameOf(c: Element): string {
  return ['act', 'rt', 'std', 'dead'].find((n) => c.classList.contains(`pcol--${n}`)) ?? '?';
}
/** Column names of the editor dock, in order. */
const layout = () => [...document.body.querySelectorAll('.dock__cols > .pcol')].map(nameOf);
const seg = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.trim() === label)!;

describe('Performance editor dock', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('RT: columns Actuation | Rapid Trigger | Deadzone; the stacking under 1100px is CSS only (always three columns)', async () => {
    for (const width of [1440, 1280, 760]) {
      stubWidth(width);
      await setup([W], (p) => setModeOf(p, [W], 1));
      expect(layout()).toEqual(['act', 'rt', 'dead']);
      teardown();
    }
  }, 30000);

  it('Standard: the Standard diagram takes the Rapid Trigger column', async () => {
    stubWidth(1440);
    await setup([Q]);
    expect(layout()).toEqual(['act', 'std', 'dead']);
  });

  it('the Standard card shows exactly when every key in scope is Standard', async () => {
    stubWidth(1440);
    const perf = await setup([Q, W]);
    expect(document.body.querySelector('.std')).not.toBeNull();
    expect(document.body.querySelector('.pcol--rt')).toBeNull();
    setModeOf(perf, [W], 1); // mixed Standard + RT: the RT column shows for W, no Standard card
    await flushPromises();
    expect(document.body.querySelector('.std')).toBeNull();
    expect(document.body.querySelector('.pcol--rt')).not.toBeNull();
    setModeOf(perf, [Q, W], 1);
    await flushPromises();
    expect(document.body.querySelector('.std')).toBeNull();
  });

  it('a selection of only unknown-mode keys shows no editor columns, only the note', async () => {
    stubWidth(1440);
    await setup([Q], (p) => setModeOf(p, [Q], 7 as PerfMode));
    expect(document.body.querySelector('.std')).toBeNull();
    expect(document.body.querySelector('.pcol--rt')).toBeNull();
    // no editors (they would act on 0 keys and toast a false "saved"); the note stands alone
    expect(document.body.querySelectorAll('.dock .pcol').length).toBe(0);
    expect(document.body.querySelector('.dock .seg')).toBeNull();
    expect(document.body.querySelector('.dock .unknown')).not.toBeNull();
  });

  it('its text uses releasePoint (release shallower than the press point)', async () => {
    stubWidth(1440);
    const perf = await setup([Q], (p) => {
      p.values = { ...p.values, [Q]: { ...p.values[Q], normalPress: 2, rtFirstTouch: 2, normalRelease: 1.2 } };
    });
    expect(releasePoint(settingsFrom(perf.values[Q]))).toBe(1.2);
    const card = document.body.querySelector('.std')!;
    expect(card.textContent).toContain(t('perf.stdCycleHint', { a: '2.0', r: '1.2' }));
    expect(card.querySelectorAll('.std__line').length).toBe(2); // actuation and release lines (r ≠ a)
  });

  it('release equal to actuation draws one line; a mixed selection shows min–max and follows the edit', async () => {
    stubWidth(1440);
    const perf = await setup([Q, W], (p) => {
      p.values = {
        ...p.values,
        [Q]: { ...p.values[Q], normalPress: 1, rtFirstTouch: 1, normalRelease: 0 },
        [W]: { ...p.values[W], normalPress: 2, rtFirstTouch: 2, normalRelease: 0 },
      };
    });
    const card = () => document.body.querySelector('.std')!;
    expect(card().textContent).toContain('1.0–2.0 mm');
    expect(card().querySelectorAll('.std__line').length).toBe(1);
    const before = card().querySelector('.std__line--act')!.getAttribute('y1');
    perf.values = { ...perf.values, [Q]: { ...perf.values[Q], normalPress: 0.5, rtFirstTouch: 0.5 } };
    await flushPromises();
    expect(card().textContent).toContain('0.5–2.0 mm');
    expect(card().querySelector('.std__line--act')!.getAttribute('y1')).not.toBe(before);
  });

  it('the Mode control stays in the dock header (same place) when Standard ↔ RT swaps the middle column', async () => {
    stubWidth(1440);
    await setup([Q]);
    const inHead = () => document.body.querySelector('.dock__head .seg') !== null;
    expect(inHead()).toBe(true);
    seg(t('perf.modeRt')).click();
    await flushPromises();
    expect(layout()).toEqual(['act', 'rt', 'dead']);
    expect(inHead()).toBe(true);
    seg(t('perf.modeStandard')).click();
    await flushPromises();
    expect(layout()).toEqual(['act', 'std', 'dead']);
    expect(inHead()).toBe(true);
  });
});
