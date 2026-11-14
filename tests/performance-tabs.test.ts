// DESIGN E §11: the Performance page and its five tabs (Hành trình · Phím nâng cao · Switch · Hiệu chuẩn · Kiểm tra phím).
// Old links, the ?tab= normalisation, history, the calibration lock, the Advanced draft guard, kept-alive tabs (selection,
// Esc, overlays, reads, profile changes), the sidebar, the titles and the tab row's keyboard and description.
// Demo keyboard only: switching tabs sends nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import type { RouteLocationRaw, Router } from 'vue-router';
import { IconBolt } from '@tabler/icons-vue';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { mountAt, perfRouter } from './mountPerformance';
import { NAV, PERF_TABS } from '../src/router';
import type { PerfTab } from '../src/router';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { useAdvancedStore } from '../src/stores/advanced';
import { useCalibrationStore } from '../src/stores/calibration';
import { useHistoryStore } from '../src/stores/history';
import { useLiveStore } from '../src/stores/live';
import { useSyncStore } from '../src/stores/sync';
import { clearTuningSnapshots } from '../src/stores/tuning';
import Sidebar from '../src/components/shell/Sidebar.vue';
import FeatureSwitch from '../src/components/switch/FeatureSwitch.vue';
import GamepadDetail from '../src/components/gamepad/GamepadDetail.vue';
import { physKey } from '../src/components/gamepad/outputs';
import { isAnalogIndex } from '../src/protocol/gamepad';
import { useGamepadStore } from '../src/stores/gamepad';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import type { MessageKey } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
let pinia: Pinia;
let router: Router;

const TITLE: Record<PerfTab, MessageKey> = {
  travel: 'ptab.travel', advanced: 'page.advanced', switch: 'swp.tabSwitch', calibration: 'swp.tabCalibration', test: 'ptab.test',
};

/** Connect the demo keyboard (once per pinia) and mount the app's RouterView at `to`, with this test's own pinia. */
async function at(to: RouteLocationRaw) {
  const device = useDeviceStore();
  if (!device.connected) await device.connectDemo();
  const m = await mountAt(to, { plugins: [pinia] });
  w = m.w;
  router = m.router;
  await idle();
  return { device, mock: device.transport as MockTransport };
}
const tabEl = (id: string) => w!.find(`[role="tab"][data-id="${id}"]`);
const selected = () => w!.findAll('[role="tab"]').filter((x) => x.attributes('aria-selected') === 'true').map((x) => x.attributes('data-id'));
const settle = async () => { for (let i = 0; i < 8; i++) await flushPromises(); };
/** The 64-key reads a tab started (Travel / Switch: performance, Advanced: advanced records) are done. */
async function idle() {
  await vi.waitFor(() => {
    expect(usePerformanceStore().loading).toBe(false);
    expect(useAdvancedStore().loading).toBe(false);
  }, { timeout: 15000, interval: 5 });
  await settle();
}
/** Click a tab in the tab row and let the (preloaded) tab render. */
async function click(id: PerfTab) {
  await tabEl(id).trigger('click');
  await settle();
  await idle();
}
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
const keyId = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!.id;

/** Every write of the protocol client (Save, Apply, calibration, advanced, profile …) spied; the mock's own demo helpers
 *  (setTravelTicker …) are not HID commands. `except`: writes the test makes itself. */
function spyWrites(mock: MockTransport, except: string[] = []) {
  const names = new Set<string>();
  for (let p: object | null = Object.getPrototypeOf(MockTransport.prototype); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (/^(set|commit|clear|write|reset|factory|start|calib)/i.test(n) && !except.includes(n)) names.add(n);
  }
  return [...names].filter((n) => typeof (mock as unknown as Record<string, unknown>)[n] === 'function')
    .map((n) => [n, vi.spyOn(mock as unknown as Record<string, () => unknown>, n)] as const);
}
const called = (spies: ReturnType<typeof spyWrites>) => spies.filter(([, s]) => s.mock.calls.length).map(([n]) => n);
/** Every HID frame the mock answers. */
const spyExchange = (mock: MockTransport) => vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> }, 'exchange');
/** The command bytes of each frame sent, e.g. "05 03". */
const sent = (spy: ReturnType<typeof spyExchange>) => spy.mock.calls.map(([f]) => [...f.slice(0, 2)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
/** Entries the router writes to its history. */
function spyHistory() {
  return { push: vi.spyOn(router.options.history, 'push'), replace: vi.spyOn(router.options.history, 'replace') };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  clearTuningSnapshots();
  locale.value = 'vi';
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  useCalibrationStore().phase = 'idle'; // unmounting a running session would cancel it
  await useSyncStore().flush();
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Performance tabs: links and history', () => {
  it('1. every old link opens its tab and keeps key / check; /switch without a tab is the Switch tab', async () => {
    const cases: [string, Record<string, string>][] = [
      ['/advanced', { tab: 'advanced' }],
      ['/switch', { tab: 'switch' }],
      ['/switch?tab=switch', { tab: 'switch' }],
      ['/switch?tab=calibration', { tab: 'calibration' }],
      ['/calibration', { tab: 'calibration' }],
      ['/live', { tab: 'test' }],
      ['/live?key=5', { tab: 'test', key: '5' }],
      ['/live?check=1', { tab: 'test', check: '1' }],
      ['/live?check=1&key=12', { tab: 'test', check: '1', key: '12' }],
    ];
    for (const [link, query] of cases) {
      const r = perfRouter();
      await r.push(link);
      expect(r.currentRoute.value.path, link).toBe('/performance');
      expect(r.currentRoute.value.query, link).toEqual(query);
    }
    // and the page opens on that tab
    await at('/advanced');
    expect(selected()).toEqual(['advanced']);
    expect(w!.find('.advtab').exists()).toBe(true);
    w!.unmount();
    await at('/live?key=5');
    expect(selected()).toEqual(['test']);
    expect(router.currentRoute.value.query).toEqual({ tab: 'test', key: '5' });
  });

  it('2. /performance without a valid tab is normalised by the router (stored tab, else Travel), in one history entry; the page never sees a missing tab', async () => {
    const r = perfRouter();
    const seen: unknown[] = [];
    r.afterEach((to) => { if (to.path === '/performance') seen.push(to.query.tab); });
    await r.push('/performance'); // first navigation
    expect(r.currentRoute.value.query).toEqual({ tab: 'travel' });
    localStorage.setItem('ae64.perfTab', 'switch');
    const push = vi.spyOn(r.options.history, 'push');
    const replace = vi.spyOn(r.options.history, 'replace');
    await r.push('/performance?tab=abc');
    expect(r.currentRoute.value.query).toEqual({ tab: 'switch' });
    expect(push).toHaveBeenCalledTimes(1); // one navigation, one entry (no redirect entry, no replace afterwards)
    expect(replace).not.toHaveBeenCalled();
    expect(seen).toEqual(['travel', 'switch']); // never a /performance without its tab
    localStorage.clear();

    // mounted: the page renders the normalised tab directly
    localStorage.setItem('ae64.perfTab', 'calibration');
    await at('/performance');
    expect(router.currentRoute.value.query).toEqual({ tab: 'calibration' });
    expect(selected()).toEqual(['calibration']);
  });

  it('2. on ?tab=switch, push(\'/performance\') (the sidebar item) adds no history entry and stays on Switch', async () => {
    await at('/performance?tab=switch');
    const h = spyHistory();
    await router.push('/performance');
    await settle();
    expect(router.currentRoute.value.query).toEqual({ tab: 'switch' });
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
    expect(selected()).toEqual(['switch']);
  });

  it('3. a tab click is a pushed history entry, Back returns to the tab before; clicking the open tab adds nothing', async () => {
    await at('/performance?tab=travel');
    const h = spyHistory();
    await click('switch');
    expect(router.currentRoute.value.query).toEqual({ tab: 'switch' });
    expect(h.push).toHaveBeenCalledTimes(1);
    expect(h.replace).not.toHaveBeenCalled();
    await click('switch');
    expect(h.push).toHaveBeenCalledTimes(1);
    router.back();
    await vi.waitFor(() => expect(router.currentRoute.value.query.tab).toBe('travel'));
    await settle();
    expect(selected()).toEqual(['travel']);
  });

  it('4. opening another tab drops the open tab\'s own query (key, check)', async () => {
    await at('/performance?tab=test&key=5');
    expect(router.currentRoute.value.query).toEqual({ tab: 'test', key: '5' });
    await click('travel');
    expect(router.currentRoute.value.query).toEqual({ tab: 'travel' });
    w!.unmount();
    await at('/performance?tab=advanced&key=7&check=1');
    await click('switch');
    expect(router.currentRoute.value.query).toEqual({ tab: 'switch' });
  });

  it('5. while calibrating, the four other tabs are disabled, a push to another tab is refused and the lock line shows', async () => {
    await at('/performance?tab=calibration');
    const cal = useCalibrationStore();
    cal.phase = 'running';
    await settle();
    for (const id of ['travel', 'advanced', 'switch', 'test']) expect(tabEl(id).attributes('disabled'), id).toBeDefined();
    expect(tabEl('calibration').attributes('disabled')).toBeUndefined();
    await router.push({ query: { tab: 'switch' } });
    await settle();
    expect(router.currentRoute.value.query).toEqual({ tab: 'calibration' });
    expect(selected()).toEqual(['calibration']);
    expect(w!.find('.ph__lock').text()).toBe(t('ptab.locked'));
  });
});

describe('Performance tabs: the Advanced draft', () => {
  /** Profile 1 has a SOCD pair on A/D: edit it and move A to W (unsaved work). */
  async function dirtyDraft() {
    const device = useDeviceStore();
    await device.connectDemo();
    await device.switchProfile(1);
    await useAdvancedStore().load();
    const env = await at('/performance?tab=advanced');
    await w!.find('.item__main').trigger('click');
    await settle();
    expect(w!.find('.editor').exists()).toBe(true);
    useSelectionStore().selectMany([keyId('W')]);
    await settle();
    expect(useHistoryStore().suspended).toBe(true); // dirty: undo is off
    return env;
  }
  /** Count the dialogs that open (each adds its .dlg to body). */
  function countOpens() {
    let n = 0;
    const mo = new MutationObserver((rs) => {
      for (const r of rs) for (const x of r.addedNodes) if (x instanceof HTMLElement && x.matches('.dlg')) n++;
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return { get n() { return n; }, stop: () => mo.disconnect() };
  }
  const button = (key: MessageKey) => [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === t(key))!;

  it('6. a dirty draft + the Switch tab asks first: "Tiếp tục sửa" stays, "Bỏ thay đổi" opens Switch with the draft dropped (one dialog)', async () => {
    const { mock } = await dirtyDraft();
    const writes = spyWrites(mock);
    const confirm = vi.spyOn(window, 'confirm');
    const opens = countOpens();
    await click('switch');
    expect(dialogs()).toBe(1);
    expect(router.currentRoute.value.query).toEqual({ tab: 'advanced' });
    expect(selected()).toEqual(['advanced']);
    button('advanced.discardKeep').click();
    await settle();
    await vi.waitFor(() => expect(dialogs()).toBe(0));
    expect(router.currentRoute.value.query).toEqual({ tab: 'advanced' });
    expect(w!.find('.editor').exists()).toBe(true); // still editing

    await click('switch');
    expect(dialogs()).toBe(1);
    button('advanced.discardDo').click();
    await settle();
    await vi.waitFor(() => expect(dialogs()).toBe(0));
    expect(router.currentRoute.value.query).toEqual({ tab: 'switch' });
    expect(selected()).toEqual(['switch']);
    expect(opens.n).toBe(2); // once per ask: "Bỏ thay đổi" does not ask again
    opens.stop();
    expect(useHistoryStore().suspended).toBe(false);
    await click('advanced');
    expect(w!.find('.editor').exists()).toBe(false); // the draft is gone
    expect(called(writes)).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('6. the same for leaving the page (/keymap); no window.confirm', async () => {
    const { mock } = await dirtyDraft();
    const writes = spyWrites(mock);
    const confirm = vi.spyOn(window, 'confirm');
    const opens = countOpens();
    await router.push('/keymap');
    await settle();
    expect(dialogs()).toBe(1);
    expect(router.currentRoute.value.path).toBe('/performance');
    button('advanced.discardKeep').click();
    await settle();
    expect(router.currentRoute.value.path).toBe('/performance');
    expect(w!.find('.editor').exists()).toBe(true);

    await router.push('/keymap');
    await settle();
    button('advanced.discardDo').click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/keymap'));
    await settle();
    expect(opens.n).toBe(2);
    opens.stop();
    expect(useHistoryStore().suspended).toBe(false);
    expect(called(writes)).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('Performance tabs: kept-alive tabs', () => {
  it('7. the selection is kept through Travel → Switch → Calibration → Travel', async () => {
    await at('/performance?tab=travel');
    const sel = useSelectionStore();
    const ids = [keyId('Q'), keyId('W'), keyId('E')];
    sel.selectMany(ids);
    for (const id of ['switch', 'calibration', 'travel'] as const) {
      await click(id);
      expect(selected()).toEqual([id]);
      expect(sel.ids, id).toEqual(ids);
    }
  });

  it('7. a clean Advanced draft does not take the selection of the other tabs, keeps undo on, and is gone on return', async () => {
    await at('/performance?tab=advanced');
    await settle();
    const sel = useSelectionStore();
    await w!.find('.type[data-type="DKS"]').trigger('click');
    await settle();
    sel.selectMany([keyId('W')]);
    await settle();
    expect(w!.find('.ed__host b').text()).toBe('W'); // W picked: still a clean draft
    expect(useHistoryStore().suspended).toBe(false);
    await click('travel');
    expect(dialogs()).toBe(0);
    expect(selected()).toEqual(['travel']);
    const five = ['A', 'S', 'D', 'F', 'G'].map(keyId);
    sel.selectMany(five);
    await settle();
    expect(sel.ids).toEqual(five);
    expect(useHistoryStore().suspended).toBe(false);
    await click('advanced');
    expect(w!.find('.editor').exists()).toBe(false);
    expect(sel.ids).toEqual(five);
  });

  it('7. Esc in another tab is not handled by the hidden keyboards: three keys picked in Travel are still picked', async () => {
    await at('/performance?tab=travel');
    const sel = useSelectionStore();
    const ids = [keyId('Q'), keyId('W'), keyId('E')];
    sel.selectMany(ids);
    await click('advanced'); // two hidden selectable keyboards once on Calibration
    sel.selectMany(ids);
    await click('calibration');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await settle();
    expect(sel.ids).toEqual(ids);
    await click('travel');
    expect(sel.ids).toEqual(ids); // not "all 64 keys"
  });

  describe('7b. an overlay of a hidden tab is closed', () => {
    type Opener = (mock: MockTransport) => Promise<void>;
    const OVERLAYS: { tab: PerfTab; what: string; before: PerfTab; open: Opener }[] = [
      {
        tab: 'travel', what: 'the preset save dialog', before: 'switch',
        open: async () => {
          const perf = usePerformanceStore();
          const v = { ...perf.values };
          for (const k of PHYSICAL_KEYS) v[k.id] = { ...v[k.id], mode: 1, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 };
          perf.values = v;
          useSelectionStore().selectMany([]);
          await settle();
          document.body.querySelector<HTMLButtonElement>('.presets__save button')!.click();
        },
      },
      {
        tab: 'advanced', what: 'the delete dialog', before: 'travel',
        open: async () => {
          w!.find(`.item button[aria-label="${t('advanced.delete')}"]`).element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        },
      },
      {
        tab: 'switch', what: 'the switch picker', before: 'travel',
        open: async () => {
          useSelectionStore().selectMany([keyId('Q'), keyId('W')]);
          await settle();
          const btn = w!.findAll('button').find((b) => b.text() === t('sw.change'))!;
          expect(btn.attributes('disabled')).toBeUndefined();
          await btn.trigger('click');
        },
      },
    ];
    for (const o of OVERLAYS) {
      for (const exit of ['back', 'push'] as const) {
        it(`${o.tab}: ${o.what}, then ${exit === 'back' ? 'Back' : 'another tab'}: no dialog left, nothing written`, async () => {
          const device = useDeviceStore();
          await device.connectDemo();
          await device.switchProfile(1); // an advanced item to delete
          await useAdvancedStore().load();
          const { mock } = await at(`/performance?tab=${o.before}`);
          await click(o.tab);
          const writes = spyWrites(mock);
          await o.open(mock);
          await settle();
          expect(dialogs()).toBe(1);
          if (exit === 'back') router.back();
          else await click(o.tab === 'switch' ? 'calibration' : 'switch');
          await vi.waitFor(() => expect(router.currentRoute.value.query.tab).not.toBe(o.tab));
          await settle();
          await vi.waitFor(() => expect(dialogs()).toBe(0));
          expect(called(writes)).toEqual([]);
        });
      }
    }
  });

  it('8. Travel is kept: coming back reads nothing (no forced load, no HID frame) and keeps its metric chip', async () => {
    const { mock } = await at('/performance?tab=travel');
    const chip = (n: number) => document.body.querySelectorAll<HTMLButtonElement>('.ph__tools .chips .chip')[n];
    chip(1).click();
    await settle();
    expect(chip(1).getAttribute('aria-checked')).toBe('true');
    await click('switch');
    await click('advanced');
    await settle();
    const perf = usePerformanceStore();
    const load = vi.spyOn(perf, 'load');
    const frames = spyExchange(mock);
    await click('travel');
    expect(load.mock.calls.filter((c) => c[0] === true)).toEqual([]);
    expect(sent(frames)).toEqual([]);
    expect(chip(1).getAttribute('aria-checked')).toBe('true');
    expect(chip(0).getAttribute('aria-checked')).toBe('false');
  });

  it('9. leaving Key test stops the live poller: no HID frame after 500 ms', async () => {
    const { mock } = await at('/performance?tab=travel');
    const live = useLiveStore();
    const stop = vi.spyOn(live, 'stop');
    await click('test');
    await vi.waitFor(() => expect(live.running).toBe(true));
    await click('travel');
    expect(stop).toHaveBeenCalled();
    expect(live.running).toBe(false);
    await new Promise((r) => setTimeout(r, 100)); // a frame in flight ends
    const frames = spyExchange(mock);
    await new Promise((r) => setTimeout(r, 500));
    expect(sent(frames)).toEqual([]);
  });

  it('10. a hidden tab does not listen: on Switch, the window has the same keydown listeners whether or not Travel and Advanced were opened', async () => {
    const live = new Set<EventListenerOrEventListenerObject>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | AddEventListenerOptions) => {
      if (type === 'keydown') live.add(fn);
      add(type, fn, o);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, o?: boolean | EventListenerOptions) => {
      if (type === 'keydown') live.delete(fn);
      remove(type, fn, o);
    });
    await at('/performance?tab=switch');
    const alone = live.size;
    w!.unmount();
    await at('/performance?tab=travel');
    await click('advanced');
    await click('switch');
    expect(live.size).toBe(alone);
    // and Esc on Switch reaches neither: a draft of Advanced would have asked, Travel would not prevent it
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    await settle();
    expect(e.defaultPrevented).toBe(false);
    expect(dialogs()).toBe(0);
  });

  it('10. a profile change with Travel and Switch both opened reads the 64 keys once, also after returning to Travel', async () => {
    const { device, mock } = await at('/performance?tab=travel');
    await click('switch');
    await settle();
    const reads = vi.spyOn(mock, 'getPerformance');
    await device.switchProfile(2);
    await idle();
    expect(reads).toHaveBeenCalledTimes(64);
    await click('travel');
    expect(reads).toHaveBeenCalledTimes(64); // onActivated's load() uses what Switch just read
  });
});

describe('Performance tabs: sidebar, titles, the tab row', () => {
  it('11. the sidebar has three groups with their items in order; Performance is the current page on every tab', async () => {
    expect(NAV.map((g) => g.group)).toEqual(['nav.groupKeyboard', 'nav.groupCustomize', 'nav.groupDevice']);
    expect(NAV.map((g) => g.items.map((i) => i.path))).toEqual([
      ['/performance'], ['/keymap', '/macro', '/lighting', '/gamepad'], ['/settings', '/diagnostics'],
    ]);
    const r = perfRouter();
    const s = mount(Sidebar, { global: { plugins: [r, pinia], stubs: { teleport: true } } });
    expect(s.findAll('.side__label').map((x) => x.text())).toEqual([t('nav.groupKeyboard'), t('nav.groupCustomize'), t('nav.groupDevice')]);
    expect(s.findAll('.side__group').map((g) => g.findAll('.side__link').map((l) => l.text()))).toEqual([
      [t('page.performance')], [t('page.keymap'), t('page.macro'), t('page.lighting'), t('page.gamepad')], [t('page.settings'), t('page.diagnostics')],
    ]);
    for (const tab of PERF_TABS) {
      await r.push({ path: '/performance', query: { tab } });
      await flushPromises();
      const on = s.findAll('.side__link').filter((l) => l.attributes('aria-current') === 'page');
      expect(on.map((l) => l.text()), tab).toEqual([t('page.performance')]);
    }
    s.unmount();
  });

  it('12. document.title is "{tab} · Hiệu năng · AE64 Control" and the h1 is "Hiệu năng"', async () => {
    await at('/performance?tab=travel');
    for (const tab of ['travel', 'advanced', 'switch', 'calibration', 'test', 'travel'] as const) {
      if (tab !== selected()[0]) await click(tab);
      expect(document.title).toBe(`${t(TITLE[tab])} · Hiệu năng · AE64 Control`);
      expect(w!.find('h1').text()).toBe('Hiệu năng');
    }
  });

  const ITEMS = [
    { id: 'a', title: 'Alpha', sub: 'First one', icon: IconBolt, tone: 'red', scope: 'Scope A' },
    { id: 'b', title: 'Beta', sub: 'Second one', icon: IconBolt, tone: 'red', scope: 'Scope B', disabled: true, hint: 'Locked' },
    { id: 'c', title: 'Gamma', sub: 'Third one', icon: IconBolt, tone: 'red', scope: 'Scope C' },
  ];
  const opt = (s: VueWrapper, id: string) => s.find(`[data-id="${id}"]`);

  it('13. FeatureSwitch manual: arrows move the focus only (skipping a locked option); Enter / click opens', async () => {
    const s = mount(FeatureSwitch, { props: { modelValue: 'a', items: ITEMS, label: 'L', compact: true, manual: true, idPrefix: 'x' }, attachTo: document.body });
    (opt(s, 'a').element as HTMLElement).focus();
    await opt(s, 'a').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(opt(s, 'c').element); // b is locked
    expect(s.emitted('update:modelValue')).toBeUndefined();
    await opt(s, 'c').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(opt(s, 'a').element);
    await opt(s, 'a').trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(opt(s, 'c').element);
    expect(s.emitted('update:modelValue')).toBeUndefined();
    await opt(s, 'c').trigger('click'); // what Enter / Space do on a button
    expect(s.emitted('update:modelValue')).toEqual([['c']]);
    s.unmount();

    // without manual: the old behaviour, arrows open
    const auto = mount(FeatureSwitch, { props: { modelValue: 'a', items: ITEMS, label: 'L' }, attachTo: document.body });
    await opt(auto, 'a').trigger('keydown', { key: 'ArrowRight' });
    expect(auto.emitted('update:modelValue')).toEqual([['c']]);
    auto.unmount();
  });

  it('13. on the page the tab row is manual: arrows only move the focus, the URL stays', async () => {
    await at('/performance?tab=travel');
    const h = spyHistory();
    (tabEl('travel').element as HTMLElement).focus();
    await tabEl('travel').trigger('keydown', { key: 'ArrowRight' });
    await settle();
    expect(document.activeElement).toBe(tabEl('advanced').element);
    expect(router.currentRoute.value.query).toEqual({ tab: 'travel' });
    expect(h.push).not.toHaveBeenCalled();
  });

  it('14. each tab is described by "{description}. {scope}."; its name does not include the description', async () => {
    const { device } = await at('/performance?tab=travel');
    const name = device.profileNames[device.activeProfile];
    const want: Record<PerfTab, string> = {
      travel: `${t('ptab.travelSub')}. ${t('ptab.scopeProfile', { name })}.`,
      advanced: `${t('ptab.advancedSub')}. ${t('ptab.scopeProfile', { name })}.`,
      switch: `${t('swp.tabSwitchSub')}. ${t('ptab.scopeProfile', { name })}.`,
      calibration: `${t('swp.tabCalibrationSub')}. ${t('ptab.scopeBoard')}.`,
      test: `${t('ptab.testSub')}. ${t('ptab.scopeRead')}.`,
    };
    for (const id of PERF_TABS) {
      const tab = tabEl(id);
      const ref = tab.attributes('aria-describedby')!;
      expect(ref).toBe(`ptab-${id}-d`);
      expect(document.getElementById(ref)!.textContent).toBe(want[id]);
      expect(tab.attributes('id')).toBe(`ptab-${id}`);
      expect(tab.text()).toBe(t(TITLE[id]));
      expect(tab.text()).not.toContain(want[id].split('.')[0]);
    }
    expect(w!.find('#ptab-panel').attributes('aria-labelledby')).toBe('ptab-travel');
  });

  it('15. Key test puts "Theo dõi phím" and its switches in the scope line (named by the visible label); the hint and key lock stay under the keyboard', async () => {
    await at('/performance?tab=test');
    const tools = w!.find('.ph__tools');
    const group = tools.find('.ktools [role="radiogroup"]');
    expect(group.exists()).toBe(true);
    expect(group.attributes('aria-label')).toBeUndefined();
    expect(document.getElementById(group.attributes('aria-labelledby')!)!.textContent).toBe(t('live.follow'));
    expect(w!.find('#ptab-panel .ktools').exists()).toBe(false);
    expect(w!.find('#ptab-panel .ktrow .hint').text()).toBe(t('live.followAutoHint'));
    expect(w!.find('#ptab-panel .ktrow .klock').exists()).toBe(true);
    // Ghim: "Tất cả phím" joins the tools, the hint under the keyboard follows
    expect(tools.text()).not.toContain(t('live.allKeys'));
    await group.findAll('[role="radio"]')[1].trigger('click');
    await settle();
    expect(tools.text()).toContain(t('live.allKeys'));
    expect(w!.find('#ptab-panel .ktrow .hint').text()).toBe(t('live.followPinnedHint'));
    // another tab: the tools leave the scope line
    await click('travel');
    expect(tools.find('.ktools').exists()).toBe(false);
  });
});

describe('Performance tabs: review of r109 (E-TEST-1, E-TEST-2, E-BUG-1)', () => {
  it('E-TEST-1a. a profile change on Advanced: Travel reads the 64 keys on return; a change on Calibration: Advanced reads its 64 records of the new profile', async () => {
    const { device, mock } = await at('/performance?tab=travel');
    await click('switch');
    await click('advanced');
    const reads = vi.spyOn(mock, 'getPerformance');
    await device.switchProfile(2);
    await idle();
    expect(reads).not.toHaveBeenCalled(); // Travel and Switch are hidden: they do not listen
    await click('travel');
    expect(reads).toHaveBeenCalledTimes(64);
    expect(usePerformanceStore().loadedProfile).toBe(2);

    await click('calibration');
    const adv = useAdvancedStore();
    const advReads = vi.spyOn(mock, 'getAdvanced');
    await device.switchProfile(1);
    await idle();
    expect(advReads).not.toHaveBeenCalled();
    await click('advanced');
    expect(advReads).toHaveBeenCalledTimes(64);
    expect(adv.loadedProfile).toBe(1);
    const want: Record<number, unknown> = {};
    for (const k of device.keys) want[k.id] = await mock.getAdvanced(k); // the new profile's list, read straight
    expect(adv.records).toEqual(want);
  });

  it('E-TEST-1b. a profile change on Advanced, then Switch first: Switch reads the 64 keys; Travel afterwards reads nothing more', async () => {
    const { device, mock } = await at('/performance?tab=travel');
    await click('switch');
    await click('advanced');
    const reads = vi.spyOn(mock, 'getPerformance');
    await device.switchProfile(3);
    await idle();
    await click('switch');
    expect(reads).toHaveBeenCalledTimes(64);
    expect(usePerformanceStore().loadedProfile).toBe(3);
    await click('travel');
    expect(reads).toHaveBeenCalledTimes(64);
  });

  it('E-TEST-1c. Travel → Switch → Travel: the keyboard listens again (Esc returns to all keys)', async () => {
    await at('/performance?tab=travel');
    await click('switch');
    await click('travel');
    const sel = useSelectionStore();
    sel.selectMany([keyId('Q'), keyId('W'), keyId('E')]);
    await settle();
    const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    await settle();
    expect(sel.ids).toEqual([]);
  });

  it('E-TEST-2a. Travel "Thử ngay" opens Key test on the picked key: ?tab=test&key=N, that key is followed', async () => {
    await at('/performance?tab=travel');
    const id = keyId('E');
    useSelectionStore().selectMany([id]);
    await settle();
    const btn = document.body.querySelector<HTMLButtonElement>('.wb__try')!;
    expect(btn.disabled).toBe(false);
    btn.click();
    await settle();
    await vi.waitFor(() => expect(selected()).toEqual(['test']));
    expect(router.currentRoute.value.query).toEqual({ tab: 'test', key: String(id) });
    expect(useLiveStore().focusId).toBe(id);
  });

  it('E-TEST-2b. Key test "Sửa cài đặt phím" opens the Travel tab (not the stored tab) with the followed key picked', async () => {
    localStorage.setItem('ae64.perfTab', 'test');
    await at('/performance?tab=test');
    const id = keyId('R');
    useSelectionStore().select(id);
    await settle();
    expect(useLiveStore().focusId).toBe(id);
    useSelectionStore().selectMany([]); // the button picks the key itself
    await settle();
    const btn = w!.findAll('button').find((b) => b.text() === t('live.editKey'))!;
    expect(btn.attributes('disabled')).toBeUndefined();
    await btn.trigger('click');
    await settle();
    await idle();
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=travel');
    expect(selected()).toEqual(['travel']);
    expect(useSelectionStore().ids).toEqual([id]);
  });

  it('E-TEST-2c. clicking the open tab at ?tab=test&key=12 changes nothing: same fullPath, no history entry', async () => {
    await at('/performance?tab=test&key=12');
    const before = router.currentRoute.value.fullPath;
    const h = spyHistory();
    await click('test');
    expect(router.currentRoute.value.fullPath).toBe(before);
    expect(h.push).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  });

  it('E-TEST-2d. a window resize while Travel is hidden: on return the grid measures itself again', async () => {
    const unobserved: Element[] = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      unobserve(el: Element) { unobserved.push(el); }
      disconnect() {}
    });
    await at('/performance?tab=travel');
    await click('switch');
    const width = window.innerWidth;
    vi.stubGlobal('innerWidth', width + 200);
    window.dispatchEvent(new Event('resize')); // nobody on Travel hears it: the tab is hidden
    await settle();
    unobserved.length = 0;
    await click('travel');
    await settle();
    const grid = document.body.querySelector('.editors > .grid');
    expect(unobserved.length).toBeGreaterThan(0);
    expect(unobserved).toContain(grid);
  });

  it('E-BUG-1. Gamepad "Mở tab Hành trình" on a digital output opens the Travel tab (stored tab Key test) with its key picked', async () => {
    localStorage.setItem('ae64.perfTab', 'test');
    const device = useDeviceStore();
    await device.connectDemo('pro-xinput');
    const gp = useGamepadStore();
    await gp.load();
    const index = gp.config!.bindings.findIndex((b, i) => !isAnalogIndex(i) && b.key !== null);
    expect(index).toBeGreaterThanOrEqual(0);
    const pk = physKey(device.keys, gp.config!.bindings[index].key!)!;
    router = perfRouter();
    await router.push('/gamepad');
    w = mount(GamepadDetail, {
      props: { current: [index], selectedKeys: [], depthUm: () => null },
      global: { plugins: [router, pinia] },
      attachTo: document.body,
    });
    await settle();
    const btn = w.findAll('button').find((b) => b.text() === t('gp.openTravel'))!;
    expect(t('gp.openTravel')).toBe('Mở tab Hành trình');
    await btn.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/performance'));
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=travel');
    expect(useSelectionStore().ids).toEqual([pk.id]);
  });
});
