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
  if (c.classList.contains('c-mode')) return 'mode';
  if (c.classList.contains('c-rt')) return 'rt';
  if (c.classList.contains('c-dead')) return 'dead';
  if (c.classList.contains('std')) return 'std';
  return c.querySelector('.act') ? 'act' : 'presets';
}
/** Card names per column, in order. */
const layout = () => [...document.body.querySelectorAll('.grid > .pcol')].map((col) => [...col.children].map(nameOf));
const growing = () => [...document.body.querySelectorAll('.pcol > .grow')].map(nameOf).sort();
const seg = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.trim() === label)!;

describe('Performance columns', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('1440 (RT): [Act] [Mode, RT] [Dead, Presets]; Act, Mode + RT and Presets grow', async () => {
    stubWidth(1440);
    await setup([W], (p) => setModeOf(p, [W], 1));
    expect(layout()).toEqual([['act'], ['mode', 'rt'], ['dead', 'presets']]);
    expect(growing()).toEqual(['act', 'mode', 'presets', 'rt']);
  });

  it('1280 (RT): [Act, Dead] [Mode, RT, Presets]; Dead, Mode + RT grow', async () => {
    stubWidth(1280);
    await setup([W], (p) => setModeOf(p, [W], 1));
    expect(layout()).toEqual([['act', 'dead'], ['mode', 'rt', 'presets']]);
    expect(growing()).toEqual(['dead', 'mode', 'rt']);
  });

  it('760: one column in the order Act, Mode, RT, Dead, Presets, no growers', async () => {
    stubWidth(760);
    await setup([W], (p) => setModeOf(p, [W], 1));
    expect(layout()).toEqual([['act', 'mode', 'rt', 'dead', 'presets']]);
    expect(growing()).toEqual([]);
  });

  it('breakpoints: 1361 is 3 columns, 1360 and 761 are 2, 760 is 1', async () => {
    for (const [width, n] of [[1361, 3], [1360, 2], [761, 2], [760, 1]] as const) {
      stubWidth(width);
      await setup([W]);
      expect(layout().length).toBe(n);
      teardown();
    }
  }, 30000);

  it('Standard: the Standard card takes the RT slot and is the only grower of the middle column', async () => {
    stubWidth(1440);
    await setup([Q]);
    expect(layout()).toEqual([['act'], ['mode', 'std'], ['dead', 'presets']]);
    expect(growing()).toEqual(['act', 'presets', 'std']);
    teardown();
    stubWidth(1280);
    await setup([Q]);
    expect(layout()).toEqual([['act', 'dead'], ['mode', 'std', 'presets']]);
    expect(growing()).toEqual(['dead', 'std']);
  });

  it('the Standard card shows exactly when every selected key is Standard', async () => {
    stubWidth(1440);
    const perf = await setup([Q, W]);
    expect(document.body.querySelector('.std')).not.toBeNull();
    expect(document.body.querySelector('.c-rt')).toBeNull();
    setModeOf(perf, [W], 1); // mixed Standard + RT: the RT card shows for W, no Standard card
    await flushPromises();
    expect(document.body.querySelector('.std')).toBeNull();
    expect(document.body.querySelector('.c-rt')).not.toBeNull();
    setModeOf(perf, [Q, W], 1);
    await flushPromises();
    expect(document.body.querySelector('.std')).toBeNull();
  });

  it('a selection of only unknown-mode keys shows neither card', async () => {
    stubWidth(1440);
    await setup([Q], (p) => setModeOf(p, [Q], 7 as PerfMode));
    expect(document.body.querySelector('.std')).toBeNull();
    expect(document.body.querySelector('.c-rt')).toBeNull();
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

  it('Mode keeps its column and index when Standard ↔ RT toggles, at 3 and 2 columns', async () => {
    for (const width of [1440, 1280]) {
      stubWidth(width);
      await setup([Q]);
      const where = () => {
        const cols = layout();
        const c = cols.findIndex((col) => col.includes('mode'));
        return [c, cols[c].indexOf('mode')];
      };
      const before = where();
      seg(t('perf.modeRt')).click();
      await flushPromises();
      expect(document.body.querySelector('.c-rt')).not.toBeNull();
      expect(where()).toEqual(before);
      seg(t('perf.modeStandard')).click();
      await flushPromises();
      expect(document.body.querySelector('.std')).not.toBeNull();
      expect(where()).toEqual(before);
      teardown();
    }
  });
});
