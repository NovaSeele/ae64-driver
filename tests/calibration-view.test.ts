// Visual calibration, page side (DESIGN D §3.2–§3.7, §7, §11): % on the keys and the raw-ADC switch, the four counters,
// "Check keys now", the "Save calibration?" dialog and the session ending while it is open (review D P1), focus, the key
// lock, the green line, and the % switched off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { defineComponent, nextTick, ref } from 'vue';
import type { Component } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import CalibrationView from '../src/components/calibration/CalibrationView.vue';
import { RECHECK_ROUTE } from '../src/components/calibration/recheck';
import { useToast } from '../src/components/ui/toast';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useCalibrationStore } from '../src/stores/calibration';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

// The demo keyboard (PC keys → simulated presses) would handle Space and the arrows before the key lock sees them, and
// press keys of the session: off here, so the page behaves as with a real keyboard. Presses go through simulatePress.
vi.mock('../src/components/live/demoPress', async (orig) => ({ ...(await orig<object>()), attachDemoPress: () => () => {} }));

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W'), A = key('A'), S = key('S'), D = key('D');
const ADC_KEY = 'ae64.calibration.showAdc';

class RO { observe() {} disconnect() {} }
// Waits for a state, not timing checks: a generous bound costs nothing when the state comes (the full suite runs this
// file beside 84 others). `what` says what was awaited when it never comes.
const until = async (cond: () => boolean, ms = 10_000, what?: () => string) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timeout${what ? `: ${what()}` : ''}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};

let w: VueWrapper | null = null;
let router: Router;
let mock: MockTransport;
let cal: ReturnType<typeof useCalibrationStore>;
// Every store and the mounted page use this test's pinia explicitly. Pinia makes a store's pinia the active one on each
// action call, so an action still running from the previous test (the reload after a save) could otherwise hand this
// test the previous test's stores, polling the previous emulator (seen: 2 full runs in 9, "too-shallow chip").
let pinia: Pinia;

/** Mount the page at /cal. `shell`: another route component around it (KeepAlive); `scroller`: inside a .main__scroll, as
 *  in the app; `waitLoaded: false`: return before the first frame was read. */
async function open(opts: { shell?: Component; scroller?: boolean; waitLoaded?: boolean; transition?: boolean } = {}) {
  router = createRouter({ history: createMemoryHistory(), routes: [
    { path: '/cal', component: opts.shell ?? CalibrationView },
    { path: '/performance', component: { template: '<i />' } },
    // DESIGN L: two more targets, and one that refuses every visit
    { path: '/a', component: { template: '<i />' } }, { path: '/b', component: { template: '<i />' } },
    { path: '/blocked', component: { template: '<i />' }, beforeEnter: () => false },
  ] });
  await router.push('/cal');
  // `transition`: App's out-in page Transition (not stubbed), so a page that is left stays mounted until it has gone
  const view = opts.transition
    ? '<RouterView v-slot="{ Component, route }"><Transition name="page" mode="out-in"><component :is="Component" :key="route.path" /></Transition></RouterView>'
    : '<RouterView />';
  w = mount({ template: opts.scroller ? `<div class="main__scroll">${view}</div>` : view }, { global: { plugins: [router, pinia], stubs: opts.transition ? { transition: false } : {} }, attachTo: document.body });
  if (opts.waitLoaded === false) return;
  await until(() => cal.loaded && usePerformanceStore(pinia).loadedProfile !== null); // the page reads both on open
  await flushPromises();
}
const keyEl = (id: number) => w!.find(`[data-key="${id}"]`);
const sub = (id: number) => keyEl(id).find('.cap__sub');
/** The four counters as seen: a dash for "no session" (its sr-only words left out). */
const counts = () => w!.findAll('.cs dd').map((d) => (d.classes('is-none') ? d.find('[aria-hidden="true"]').text() : d.text()));
const bodyButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === label).pop();
const actionButton = (label: string) => w!.findAll('.ses__top .actions button').find((b) => b.text() === label);
const dialogOpen = () => [...document.body.querySelectorAll('.dlg__title')].some((h) => h.textContent === t('calibration.finishTitle'));
const toasts = () => useToast().items.value.map((x) => x.text);

async function begin() {
  await actionButton(t('calibration.start'))!.trigger('click');
  await flushPromises();
  bodyButton(t('calibration.start'))!.click(); // the start dialog's button
  await until(() => cal.phase === 'running');
  await flushPromises();
}
async function press(id: number, mm: number) {
  mock.simulatePress(id, mm);
  const um = Math.round(mm * 1000);
  await until(() => cal.frame.route[id] === um, undefined, () => `key ${id} at ${um} µm: phase ${cal.phase}, error ${cal.error}, route ${cal.frame.route[id]}`);
  await flushPromises();
}
async function tap(id: number, mm: number) {
  await press(id, mm);
  await press(id, 0);
}
/** Give one key its own switch travel (µm) on the emulated keyboard, so the page's reloads of the performance store
 *  keep it. The emulator caps a press at the travel. */
async function travel(id: number, sw: { axisV2Id: number; axisRangeMax: number; axisCoefficient: number }) {
  const k = PHYSICAL_KEYS[id];
  await mock.setPerformance(k, { ...(await mock.getPerformance(k)), ...sw });
}
/** A switch of the AE64 Max catalog with 3.13 mm of travel (the emulator's guard only lets catalog switches through). */
const SW_313 = { axisV2Id: 4208, axisRangeMax: 3130, axisCoefficient: 24500 };
async function clickFinish() {
  await actionButton(t('calibration.finish'))!.trigger('click');
  await flushPromises();
}
function commitsSent(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter((args: unknown[]) => { const p = args[0] as number[]; return p[0] === 0x02 && (p[1] === 0x02 || p[1] === 0x07); }).length;
}

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  locale.value = 'vi';
  vi.stubGlobal('ResizeObserver', RO);
  localStorage.removeItem(ADC_KEY);
  useToast().items.value = [];
  const device = useDeviceStore(pinia);
  await device.connectDemo();
  mock = device.transport as MockTransport;
  cal = useCalibrationStore(pinia);
});
afterEach(async () => {
  for (const k of [W, A, S, D]) mock.simulatePress(k.id, 0);
  w?.unmount();
  w = null;
  await until(() => cal.phase === 'idle' && !usePerformanceStore(pinia).loading); // incl. the reload after a save
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('keys: % of the deepest travel, or raw ADC', () => {
  it('no number before a session; % during it on pressed keys only; ADC always in the name', async () => {
    await open();
    expect(sub(W.id).exists()).toBe(false);
    expect(keyEl(A.id).attributes('aria-label')).toContain('ADC 2760');
    await begin();
    await tap(W.id, 2.0);
    expect(sub(W.id).text()).toBe('60%'); // 2.00 of 3.31
    expect(sub(A.id).exists()).toBe(false); // not pressed: no "0%"
    expect(keyEl(W.id).attributes('aria-label')).toMatch(/· 60% · chưa đủ sâu · Đã hiệu chuẩn · ADC \d+$/);
    expect(keyEl(W.id).find('.cap__badge--shallow').exists()).toBe(true);
  });

  it('"Show raw ADC" shows the ADC on every key and is remembered; it sends nothing', async () => {
    await open();
    await begin();
    await tap(W.id, 2.0);
    const write = vi.spyOn(mock as unknown as { write(p: number[]): Promise<unknown> }, 'write');
    await w!.find('.aside__adc button[role="switch"]').trigger('click');
    expect(sub(W.id).text()).toBe(String(cal.frame.adc[W.id]));
    expect(sub(A.id).text()).toBe(String(cal.frame.adc[A.id]));
    expect(localStorage.getItem(ADC_KEY)).toBe('1');
    expect(write).not.toHaveBeenCalled();
    expect(w!.find('.kblegend').text()).toContain(t('calibration.keycapAdc'));
    w!.unmount();
    await until(() => cal.phase === 'idle');
    await open();
    expect(sub(A.id).text()).toBe(String(cal.frame.adc[A.id])); // remembered
  });

  it('after Cancel the session\'s % are gone', async () => {
    await open();
    await begin();
    await tap(W.id, 2.0);
    await actionButton(t('calibration.cancel'))!.trigger('click');
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(sub(W.id).exists()).toBe(false);
    expect(counts()).toEqual(['—', '—', '—', '0']);
  });

  it('% not trusted: no % and no ⤓ on the keys, no "too shallow" chip', async () => {
    cal.trustPeaks = false;
    await open();
    await begin();
    await tap(W.id, 2.0);
    expect(sub(W.id).exists()).toBe(false);
    expect(keyEl(W.id).find('.cap__badge--shallow').exists()).toBe(false);
    expect(w!.findAll('.chip--shallow')).toHaveLength(0);
    expect(w!.find('.okline--wait').text()).toBe(t('calibration.waitConfirm', { n: 1 }));
  });
});

describe('the four counters follow the store', () => {
  it('none, running, saved', async () => {
    await open();
    expect(counts()).toEqual(['—', '—', '—', '0']);
    await begin();
    expect(counts()).toEqual(['0/64', '0', '0', '0']);
    await tap(W.id, 3.31);
    await tap(A.id, 2.0);
    expect(counts()).toEqual([`${cal.pressedIds.length}/64`, String(cal.newCount), String(cal.shallowIds.length), String(cal.uncalibratedCount)]);
    expect(counts()).toEqual(['2/64', '1', '1', '0']);
    await clickFinish(); // A is too shallow: asked first
    bodyButton(t('calibration.saveAnyway'))!.click();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(counts()).toEqual(['2/64', '1', '1', '0']); // the saved session stays on screen
    expect(cal.lastSaved).toEqual([W.id]);
  });
});

describe('"Check keys now" after a saved session only', () => {
  it('shown after Finish, goes to the health check; not after Cancel, a failed Finish, or a new start', async () => {
    await open();
    await begin();
    await tap(W.id, 3.31);
    await clickFinish(); // clean: saved at once
    await until(() => cal.phase === 'idle');
    await flushPromises();
    const btn = w!.find('.result button');
    expect(btn.text()).toBe(t('calibration.recheck'));
    expect(w!.find('.result__t').text()).toBe(t('calibration.result', { n: 1 }));
    expect(actionButton(t('calibration.start'))!.classes()).toContain('btn--secondary');
    await btn.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=test&check=1'); // the literal path, not the constant (E: the Key test tab)
  });

  it('not after Cancel, a failed Finish, or once a new session starts', async () => {
    await open();
    await begin();
    await tap(W.id, 3.31);
    await actionButton(t('calibration.cancel'))!.trigger('click');
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(w!.find('.result').exists()).toBe(false);

    await begin();
    await tap(W.id, 3.31);
    vi.spyOn(mock, 'commit').mockRejectedValueOnce(new Error('commit failed'));
    await clickFinish();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(w!.find('.result').exists()).toBe(false);

    await begin();
    await tap(W.id, 3.31);
    await clickFinish();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(w!.find('.result').exists()).toBe(true);
    await begin();
    expect(w!.find('.result').exists()).toBe(false);
  });
});

describe('"Save calibration?" (instead of window.confirm)', () => {
  it('asks when nothing is new; Keep pressing does not save; Save anyway saves once', async () => {
    await open();
    await begin();
    const finish = vi.spyOn(cal, 'finish');
    await clickFinish();
    expect(dialogOpen()).toBe(true);
    expect(document.body.querySelector('.dlg .dlg-body')!.textContent).toBe(t('calibration.confirmEmpty'));
    expect(document.activeElement?.textContent?.trim()).toBe(t('calibration.keepPressing')); // the safe button first
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
    expect(dialogOpen()).toBe(false);
    expect(finish).not.toHaveBeenCalled();
    expect(cal.phase).toBe('running');
    await clickFinish();
    const write = vi.spyOn(mock as unknown as { write(p: number[]): Promise<unknown> }, 'write');
    bodyButton(t('calibration.saveAnyway'))!.click();
    await until(() => cal.phase === 'idle');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(commitsSent(write)).toBe(1); // the counter the P1 cases rely on does see a commit
  });

  it('asks when a key is too shallow (and names it); not when everything is clean', async () => {
    await open();
    await begin();
    await tap(A.id, 2.0);
    await tap(W.id, 3.31);
    await clickFinish();
    expect(dialogOpen()).toBe(true);
    expect(document.body.querySelector('.dlg .dlg-body')!.textContent).toBe(t('calibration.finishBody', { list: t('calibration.finishShallow', { n: 1 }) }));
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
    await tap(A.id, 3.31); // now deep enough: clean
    const finish = vi.spyOn(cal, 'finish');
    await clickFinish();
    expect(dialogOpen()).toBe(false);
    await until(() => cal.phase === 'idle');
    expect(finish).toHaveBeenCalledTimes(1);
    expect(toasts()).toContain(t('calibration.saved'));
  });

  for (const [name, fail] of [
    ['a failed read', () => { vi.spyOn(mock, 'getAxisData').mockRejectedValueOnce(new Error('poll failed')); }],
    ['a lost connection', () => { vi.spyOn(useDeviceStore(pinia), 'withTransport').mockRejectedValue(new Error('not connected')); }],
    ['a failed read whose stop fails too (stopFailed)', () => {
      vi.spyOn(mock, 'getAxisData').mockRejectedValue(new Error('poll failed'));
      vi.spyOn(mock, 'stopCalibration').mockRejectedValue(new Error('usb gone'));
    }],
  ] as const) {
    it(`the session ends while the dialog is open (${name}): it closes, nothing is saved, no "saved" toast (review D P1)`, async () => {
      await open();
      await begin();
      await tap(A.id, 2.0);
      await clickFinish();
      expect(dialogOpen()).toBe(true);
      const write = vi.spyOn(mock as unknown as { write(p: number[]): Promise<unknown> }, 'write');
      fail();
      await until(() => cal.phase === 'idle');
      await flushPromises();
      expect(dialogOpen()).toBe(false); // closed as soon as the phase left running
      expect(commitsSent(write)).toBe(0);
      expect(toasts()).not.toContain(t('calibration.saved'));
      expect(cal.lastSaved).toBe(null);
      expect(w!.find('.result').exists()).toBe(false);
      expect(w!.find('.ses__notes .alert').exists()).toBe(true);
      expect(document.activeElement?.textContent?.trim()).toBe(t('calibration.start')); // the session ended: Start
      vi.restoreAllMocks();
    });
  }

  it('Save anyway pressed as the session ends (before the dialog closes): finish is not called', async () => {
    await open();
    await begin();
    await tap(A.id, 2.0);
    await clickFinish();
    const finish = vi.spyOn(cal, 'finish');
    const save = bodyButton(t('calibration.saveAnyway'))!;
    cal.phase = 'idle'; // the session just ended; the dialog's own watch has not run yet
    save.click();
    await flushPromises();
    expect(finish).not.toHaveBeenCalled();
    expect(toasts()).not.toContain(t('calibration.saved'));
    cal.phase = 'running';
    await cal.cancel();
  });

  it('"saved" follows lastSaved, not what finish() returns', async () => {
    await open();
    await begin();
    await tap(W.id, 3.31);
    vi.spyOn(cal, 'finish').mockResolvedValue(true); // says true, committed nothing
    await clickFinish();
    await flushPromises();
    expect(cal.lastSaved).toBe(null);
    expect(toasts()).not.toContain(t('calibration.saved'));
    vi.restoreAllMocks();
    await cal.cancel();
  });
});

describe('focus (DESIGN D §7)', () => {
  it('start → the status line; Keep pressing and Esc → the status line, not Finish; saved → Check keys now', async () => {
    await open();
    await begin();
    expect(document.activeElement).toBe(w!.find('.running').element);
    await clickFinish();
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
    await nextTick();
    expect(document.activeElement).toBe(w!.find('.running').element);
    await clickFinish();
    document.body.querySelector('.dlg__panel')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    await nextTick();
    expect(dialogOpen()).toBe(false);
    expect(document.activeElement).toBe(w!.find('.running').element);
    await tap(W.id, 3.31);
    await clickFinish();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(document.activeElement).toBe(w!.find('.result button').element);
  });

  it('the session ends on a failed read (no dialog): focus goes to Start, not to body', async () => {
    await open();
    await begin();
    expect(document.activeElement).toBe(w!.find('.running').element);
    vi.spyOn(mock, 'getAxisData').mockRejectedValueOnce(new Error('poll failed'));
    await until(() => cal.phase === 'idle');
    await flushPromises();
    await nextTick();
    expect(document.activeElement?.textContent?.trim()).toBe(t('calibration.start'));
  });
});

describe('key lock during the session (review D P2-b)', () => {
  const keydown = (code: string, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it('running and finishing: Space, PageDown and arrows are blocked, Tab is not; not in the dialog; idle and saved: nothing', async () => {
    await open();
    expect(keydown('Space')).toBe(false);
    await begin();
    expect(keydown('Space')).toBe(true);
    expect(keydown('PageDown')).toBe(true);
    expect(keydown('ArrowDown')).toBe(true);
    expect(keydown('Tab')).toBe(false);
    await clickFinish(); // nothing new: the dialog
    expect(keydown('Space', document.body.querySelector('.dlg__panel button')!)).toBe(false);
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
    // finishing: the stop is still on its way
    let release!: () => void;
    const stop = mock.stopCalibration.bind(mock);
    vi.spyOn(mock, 'stopCalibration').mockImplementation(() => new Promise<void>((r) => { release = r; }).then(stop));
    await tap(W.id, 3.31);
    await clickFinish();
    await until(() => cal.phase === 'finishing' && !!release);
    expect(keydown('Space')).toBe(true);
    release();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect([cal.lastSaved, cal.error, cal.newCount]).toEqual([[W.id], null, 0]);
    expect(w!.find('.result').exists()).toBe(true);
    expect(keydown('Space')).toBe(false); // saved: free again
    expect(keydown('PageDown')).toBe(false);
  });

  it('leaving the tab takes the lock off', async () => {
    await open();
    await begin();
    w!.unmount();
    w = null;
    await until(() => cal.phase === 'idle');
    expect(keydown('Space')).toBe(false);
  });
});

describe('the green line only when the firmware confirmed every pressed key (review D P2-c)', () => {
  it('a key deep enough but not confirmed: "waiting for 1 key"; confirmed: the green line', async () => {
    await travel(D.id, SW_313); // 95 % = 2.97 mm, and the emulator says 2 only past 3.0 mm
    await open();
    await begin();
    await tap(W.id, 3.31);
    await tap(A.id, 3.31);
    await tap(D.id, 3.0);
    expect(w!.find('.okline').classes()).toContain('okline--wait');
    expect(w!.find('.okline').text()).toBe(t('calibration.waitConfirm', { n: 1 }));
    await tap(D.id, 3.05);
    expect(w!.find('.okline').classes()).not.toContain('okline--wait');
    expect(w!.find('.okline').text()).toBe(t('calibration.allDeep'));
  });

  it('saved with a pressed key the session did not calibrate: "kept their previous calibration"', async () => {
    await travel(D.id, SW_313); // a new switch leaves the key uncalibrated (as the firmware does): calibrate it first
    await open();
    await begin();
    await tap(D.id, 3.1);
    await clickFinish();
    await until(() => cal.phase === 'idle' && cal.frame.status[D.id] === 1);
    await begin();
    await tap(W.id, 3.31);
    await tap(D.id, 3.0); // deep enough for its 3.13 mm, but the emulator says 2 only past 3.0 mm
    await clickFinish(); // clean of chips: D is not too shallow, only waiting
    expect(dialogOpen()).toBe(false);
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(cal.lastSaved).toEqual([W.id]);
    expect(w!.find('.okline--wait').text()).toBe(t('calibration.keptOld', { n: 1 }));
  });
});

describe('needs attention', () => {
  it('a too-shallow chip marks its key on the board; pressing it again unmarks', async () => {
    await open();
    await begin();
    await tap(A.id, 2.0);
    const chip = w!.find('.chip--shallow');
    expect(chip.text()).toBe(t('calibration.chipShallow', { key: 'A', mm: '2.00', range: '3.31' }));
    expect(chip.attributes('aria-label')).toBe(`${t('calibration.announceShallow', { key: 'A', mm: '2.00', range: '3.31' })} ${t('calibration.markHint')}`);
    await chip.trigger('click');
    expect(w!.find('.chip--shallow').attributes('aria-pressed')).toBe('true');
    expect(keyEl(A.id).find('.cap').classes()).toContain('cap--sel');
    expect(keyEl(A.id).attributes('aria-pressed')).toBeUndefined(); // marked, not selected
    await w!.find('.chip--shallow').trigger('click');
    expect(keyEl(A.id).find('.cap').classes()).not.toContain('cap--sel');
  });
});

// ---- Review D r107 (D-TEST-1, D-ROUND-1, D-LEGEND-1): the mutants that survived the first round, by their number.
describe('review D r107', () => {
  const live = () => w!.find('.progress p[aria-live]').text();
  const chips = () => w!.findAll('.chip');
  const shallowSentence = (name: string, mm: string, range = '3.31') => t('calibration.announceShallow', { key: name, mm, range });

  it('D-ROUND-1: % is rounded down: 94.6 % reads "94%", next to its "too shallow" chip', async () => {
    await travel(D.id, SW_313);
    await open();
    await begin();
    await tap(D.id, 2.961); // 2.961 / 3.130 = 94.6 %
    expect(sub(D.id).text()).toBe('94%');
    expect(w!.find('.chip--shallow').text()).toBe(t('calibration.chipShallow', { key: 'D', mm: '2.96', range: '3.13' }));
  });

  it('D-LEGEND-1: the ⤓ legend item stays for the whole session and after saving, chips or not', async () => {
    const legend = () => w!.find('.kblegend').text().includes(t('calibration.keycapShallow'));
    await open();
    expect(legend()).toBe(false); // no session: nothing on the keys to explain
    await begin();
    expect(cal.shallowIds).toEqual([]);
    expect(legend()).toBe(true);
    await tap(A.id, 2.0);
    expect(legend()).toBe(true);
    await tap(A.id, 3.31);
    expect(cal.shallowIds).toEqual([]);
    expect(legend()).toBe(true);
    await clickFinish();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(w!.find('.result').exists()).toBe(true);
    expect(legend()).toBe(true);
  });

  it('#31 Finish asks when every pressed key is new but a key outside the session is still not calibrated', async () => {
    await travel(D.id, SW_313); // a new switch: D is not calibrated
    await open();
    await begin();
    await tap(W.id, 3.31);
    expect([cal.newCount, cal.shallowIds.length, cal.uncalibratedCount]).toEqual([1, 0, 1]);
    await clickFinish();
    expect(dialogOpen()).toBe(true);
    expect(document.body.querySelector('.dlg .dlg-body')!.textContent).toBe(t('calibration.finishBody', { list: t('calibration.finishUncal', { n: 1 }) }));
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
  });

  it('#34 while running, a key both not calibrated and too shallow keeps its "too shallow" chip', async () => {
    await travel(D.id, SW_313);
    await open();
    await begin();
    await tap(D.id, 2.0);
    expect(cal.frame.status[D.id]).toBe(0);
    expect(w!.findAll('.chip--shallow').map((c) => c.text())).toEqual([t('calibration.chipShallow', { key: 'D', mm: '2.00', range: '3.13' })]);
  });

  it('#37 leaving the tab (KeepAlive) unmarks the key', async () => {
    const show = ref(true);
    const Shell = defineComponent({
      components: { CalibrationView, Other: { template: '<p>other</p>' } },
      setup: () => ({ show }),
      template: '<KeepAlive><CalibrationView v-if="show" /><Other v-else /></KeepAlive>',
    });
    await travel(D.id, SW_313);
    await open({ shell: Shell });
    await w!.find('.chip--uncal').trigger('click');
    expect(keyEl(D.id).find('.cap').classes()).toContain('cap--sel');
    show.value = false;
    await nextTick();
    show.value = true;
    await nextTick();
    expect(keyEl(D.id).find('.cap').classes()).not.toContain('cap--sel');
    expect(w!.find('.chip--uncal').attributes('aria-pressed')).toBe('false');
  });

  it('#36 starting a session unmarks the key marked before it', async () => {
    await travel(D.id, SW_313); // a new switch: D is not calibrated, so it has a chip before any session
    await open();
    await w!.find('.chip--uncal').trigger('click');
    expect(keyEl(D.id).find('.cap').classes()).toContain('cap--sel');
    await begin();
    expect(keyEl(D.id).find('.cap').classes()).not.toContain('cap--sel');
    w!.findAll('.chip').forEach((c) => expect(c.attributes('aria-pressed')).toBe('false'));
  });

  it('#38 #39 during a session the chips keep their arrow keys (not swallowed by the key lock); PageDown does not scroll', async () => {
    await open();
    await begin();
    await tap(A.id, 2.0);
    await tap(S.id, 2.0);
    const [first, second] = chips().map((c) => c.element as HTMLElement);
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(second);
    const pgdn = new KeyboardEvent('keydown', { key: 'PageDown', code: 'PageDown', bubbles: true, cancelable: true });
    second.dispatchEvent(pgdn);
    expect(pgdn.defaultPrevented).toBe(true);
  });

  it('#40 the screen reader gets at most one sentence every 2 s', async () => {
    await open();
    await begin();
    await tap(A.id, 2.0);
    await until(() => live() === shallowSentence('A', '2.00'));
    const said = Date.now();
    await tap(S.id, 2.0);
    expect(cal.shallowIds).toEqual([A.id, S.id]);
    // S waits for its turn (checked only while the turn can't have come: under load the tap itself can take 2 s)
    if (Date.now() - said < 1800) expect(live()).toBe(shallowSentence('A', '2.00'));
    await until(() => live() === shallowSentence('S', '2.00'));
    expect(Date.now() - said).toBeGreaterThanOrEqual(1900);
  });

  it('#47 once the last "too shallow" key is pressed deep enough, the screen reader says so', async () => {
    await open();
    await begin();
    await tap(A.id, 2.0);
    await tap(A.id, 3.31);
    expect(cal.shallowIds).toEqual([]);
    await until(() => live() === t('calibration.allDeep'));
  });

  it('#41 no key glows before the first frame was read (every status would read 0, "not calibrated")', async () => {
    let go!: () => void;
    const gate = new Promise<void>((r) => { go = r; });
    const read = mock.getAxisData.bind(mock);
    vi.spyOn(mock, 'getAxisData').mockImplementation(async (type, row) => { await gate; return read(type, row); });
    await open({ waitLoaded: false });
    await flushPromises();
    expect(cal.loaded).toBe(false);
    expect(w!.findAll('.cap--glow')).toHaveLength(0);
    go();
    await until(() => cal.loaded);
    await flushPromises();
    expect(w!.findAll('.cap--glow').length).toBe(64);
  });

  it('#42 after saving, the keys the session calibrated stay "just calibrated" although the frame now says 1', async () => {
    await open();
    await begin();
    await tap(W.id, 3.31);
    await clickFinish();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(cal.frame.status[W.id]).toBe(1);
    expect(keyEl(W.id).attributes('aria-label')).toContain(`${t('calibration.legendNew')} · ADC`);
    expect(keyEl(A.id).attributes('aria-label')).toContain(`${t('calibration.legendDone')} · ADC`);
  });

  it('#44 saving scrolls the whole card into view, by the same rule as Start', async () => {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, height, left: 0, right: 0, width: 0, x: 0, y: top, toJSON: () => ({}) }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.classList.contains('main__scroll')) return rect(0, 700);
      if (this.classList.contains('board')) return rect(300, 336);
      if (this.classList.contains('progress')) return rect(650, 250); // bottom 900, under the 700 px view
      return rect(0, 0);
    });
    await open({ scroller: true });
    const to: number[] = [];
    (w!.find('.main__scroll').element as HTMLElement).scrollTo = ((o: ScrollToOptions) => { to.push(o.top!); }) as HTMLElement['scrollTo'];
    await begin();
    expect(to).toEqual([216]); // card bottom + 16 − 700; the keyboard top would allow 292
    await tap(W.id, 3.31);
    await clickFinish();
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(to).toEqual([216, 216]);
  });

  it('#45 % is capped at 100 when the peak passes the key\'s travel', async () => {
    await open();
    await begin();
    const perf = usePerformanceStore(pinia);
    perf.values = { ...perf.values, [W.id]: { ...perf.values[W.id], axisRangeMax: 3000 } };
    await tap(W.id, 3.31);
    expect(sub(W.id).text()).toBe('100%');
  });

  it('#48 Cancel moves focus to Start', async () => {
    await open();
    await begin();
    await actionButton(t('calibration.cancel'))!.trigger('click');
    await until(() => cal.phase === 'idle');
    await flushPromises();
    await nextTick();
    expect(document.activeElement?.textContent?.trim()).toBe(t('calibration.start'));
  });

  it('#51 a failed start shows the error as a toast', async () => {
    vi.spyOn(mock, 'startCalibration').mockRejectedValueOnce(new Error('start refused'));
    await open();
    await actionButton(t('calibration.start'))!.trigger('click');
    await flushPromises();
    bodyButton(t('calibration.start'))!.click();
    await until(() => cal.phase === 'idle' && cal.error !== null);
    await flushPromises();
    expect(toasts().some((x) => x.includes('start refused'))).toBe(true);
  });

  it('#52 "Check keys now" goes to the health check: /performance?tab=test&check=1 (the literal path)', () => {
    expect(RECHECK_ROUTE).toBe('/performance?tab=test&check=1');
  });

  it('#54 the keyboard is described by the keycap legend (aria-describedby)', async () => {
    await open();
    const id = w!.find('.kblegend').attributes('id');
    expect(id).toBeTruthy();
    expect(w!.find('.kb').attributes('aria-describedby')).toBe(id);
  });
});

// ---- Review D r108 (D-TEST-2): the chips are kept as the same array only while every chip reads the same.
describe('review D r108', () => {
  it('#63 a key pressed deeper but still too shallow: its chip follows the new peak, and the language', async () => {
    const chip = () => w!.find('.chip--shallow');
    const p1 = { key: 'A', mm: '1.60', range: '3.31' }, p2 = { key: 'A', mm: '2.40', range: '3.31' };
    await open();
    await begin();
    await tap(A.id, 1.6);
    expect(chip().text()).toBe(t('calibration.chipShallow', p1));
    await tap(A.id, 2.4);
    expect(w!.findAll('.chip--shallow')).toHaveLength(1);
    expect(chip().text()).toBe(t('calibration.chipShallow', p2));
    expect(chip().attributes('aria-label')).toContain('2.40');
    const inVi = chip().text();
    locale.value = 'en';
    await nextTick();
    expect(chip().text()).toBe(t('calibration.chipShallow', p2));
    expect(chip().text()).not.toBe(inVi);
  });
});

describe('leave dialog (DESIGN L)', () => {
  const panelOf = (title: string) => [...document.body.querySelectorAll<HTMLElement>('.dlg__panel')].find((p) => p.querySelector('.dlg__title')?.textContent === title);
  const leaveDlg = () => panelOf(t('calibration.leaveTitle'));
  const dlgs = () => document.body.querySelectorAll('.dlg').length;
  const route = () => router.currentRoute.value.fullPath;
  const runningEl = () => w!.find('.running').element;
  const stopSpy = () => vi.spyOn(mock, 'stopCalibration');
  const writeSpy = () => vi.spyOn(mock as unknown as { write(p: number[]): Promise<unknown> }, 'write');
  const keydown = (code: string, target: EventTarget = document.body) => {
    const e = new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };
  /** Every Dialog root (`.dlg`) put into the page: one ask = one open. */
  function countOpens() {
    let n = 0;
    const mo = new MutationObserver((recs) => {
      for (const r of recs) for (const x of r.addedNodes) if (x instanceof HTMLElement && (x.matches('.dlg') || x.querySelector('.dlg'))) n++;
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return { get n() { return n; }, stop: () => mo.disconnect() };
  }
  async function ask(to: string) {
    await router.push(to);
    await flushPromises();
  }
  /** A stand-in sidebar link outside the view, focused before the push: the Dialog gives focus back to it (review L-P2). */
  function fromLink() {
    const a = document.createElement('a');
    a.href = '#/performance';
    a.textContent = 'Keymap';
    document.body.appendChild(a);
    a.focus();
    return a;
  }
  async function running() {
    await open();
    await begin();
    await tap(W.id, 3.31);
    await until(() => cal.newCount === 1);
  }
  let confirm: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { confirm = vi.spyOn(window, 'confirm').mockImplementation(() => true); });
  afterEach(() => { expect(confirm).not.toHaveBeenCalled(); });

  it('L1. running: a push opens one dialog and stays; title, body with the live count; focus on "Tiếp tục hiệu chuẩn"', async () => {
    await running();
    await ask('/performance');
    expect(dlgs()).toBe(1);
    expect(route()).toBe('/cal');
    const body = leaveDlg()!.querySelector('.dlg__body')!.textContent!;
    expect(body).toContain(t('calibration.leaveBody'));
    expect(body).toContain(t('calibration.leaveCount', { n: 1 }));
    expect(document.activeElement?.textContent?.trim()).toBe(t('calibration.leaveStay'));
  });

  it('L2. "Tiếp tục hiệu chuẩn": closed, still /cal and running, nothing stopped or saved, focus on the status line', async () => {
    await running();
    const link = fromLink();
    await ask('/performance');
    const stop = stopSpy();
    const write = writeSpy();
    bodyButton(t('calibration.leaveStay'))!.click();
    await flushPromises();
    expect(leaveDlg()).toBeUndefined();
    expect([route(), cal.phase]).toEqual(['/cal', 'running']);
    expect(stop).not.toHaveBeenCalled();
    expect(commitsSent(write)).toBe(0);
    expect(document.activeElement).toBe(runningEl());
    expect(document.activeElement).not.toBe(link);
  });

  for (const [how, close] of [
    ['Esc', () => { keydown('Escape', document.activeElement!); }],
    ['the backdrop', () => { document.body.querySelector('.dlg')!.dispatchEvent(new Event('pointerdown', { bubbles: true })); }],
    ['X', () => { document.body.querySelector<HTMLButtonElement>('.dlg__close')!.click(); }],
  ] as const) {
    it(`L3. ${how} is "stay": closed, running, focus on the status line`, async () => {
      await running();
      const link = fromLink();
      await ask('/performance');
      const stop = stopSpy();
      close();
      await flushPromises();
      expect(leaveDlg()).toBeUndefined();
      expect([route(), cal.phase]).toEqual(['/cal', 'running']);
      expect(stop).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(runningEl());
      expect(document.activeElement).not.toBe(link);
    });
  }

  it('L4. "Dừng và rời trang": leaves, one stop (the cancel of the unmount), no commit, the dialog opened once', async () => {
    await running();
    const opens = countOpens();
    const stop = stopSpy();
    const write = writeSpy();
    await ask('/performance');
    bodyButton(t('calibration.leaveGo'))!.click();
    await until(() => route() === '/performance' && cal.phase === 'idle');
    await flushPromises();
    opens.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(commitsSent(write)).toBe(0);
    expect(opens.n).toBe(1);
    expect(dlgs()).toBe(0);
  });

  it('L5. idle: a push leaves at once, no dialog', async () => {
    await open();
    await ask('/performance');
    expect([route(), dlgs()]).toEqual(['/performance', 0]);
  });

  it('L5. finishing (the stop on its way): a push is refused with a toast and no dialog; once idle it leaves', async () => {
    await open();
    await begin();
    let release!: () => void;
    const stop = mock.stopCalibration.bind(mock);
    vi.spyOn(mock, 'stopCalibration').mockImplementation(() => new Promise<void>((r) => { release = r; }).then(stop));
    const ending = cal.cancel();
    await until(() => cal.phase === 'finishing' && !!release);
    await ask('/performance');
    expect([route(), dlgs()]).toEqual(['/cal', 0]);
    expect(toasts()).toContain(t('calibration.leaveFinishing'));
    release();
    await ending;
    await ask('/performance');
    expect([route(), dlgs()]).toEqual(['/performance', 0]);
  });

  it('L6. the session ends while the dialog is open (a failed read): closed, stays, focus on Start; the next push leaves', async () => {
    await running();
    await ask('/performance');
    expect(leaveDlg()).toBeTruthy();
    vi.spyOn(mock, 'getAxisData').mockRejectedValueOnce(new Error('poll failed'));
    await until(() => cal.phase === 'idle');
    await flushPromises();
    expect(leaveDlg()).toBeUndefined();
    expect(route()).toBe('/cal');
    expect(document.activeElement?.textContent?.trim()).toBe(t('calibration.start'));
    await ask('/performance');
    expect([route(), dlgs()]).toEqual(['/performance', 0]);
  });

  it('L7. a second push while the dialog is open: still one dialog, the latest target wins', async () => {
    await running();
    await ask('/a');
    await ask('/b');
    expect(dlgs()).toBe(1);
    bodyButton(t('calibration.leaveGo'))!.click();
    await until(() => route() === '/b');
  });

  it('L8. "Lưu hiệu chuẩn?" is open: a push opens no second dialog and stays', async () => {
    await open();
    await begin();
    await clickFinish(); // nothing new: the finish dialog
    expect(dialogOpen()).toBe(true);
    await ask('/performance');
    expect(dlgs()).toBe(1);
    expect(dialogOpen()).toBe(true);
    expect(leaveDlg()).toBeUndefined();
    expect(route()).toBe('/cal');
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
  });

  it('L9. the key lock lets the dialog work: Space and Enter on its buttons are not blocked', async () => {
    await running();
    await ask('/performance');
    expect(keydown('Space')).toBe(true); // the lock is on outside the dialog
    const stay = bodyButton(t('calibration.leaveStay'))!;
    expect(keydown('Space', stay)).toBe(false);
    expect(keydown('Enter', stay)).toBe(false);
    expect(keydown('Space', bodyButton(t('calibration.leaveGo'))!)).toBe(false);
  });

  it('L10. the count is live: a key calibrated while the dialog is open shows in it', async () => {
    await running();
    await ask('/performance');
    await tap(A.id, 3.31);
    await until(() => cal.newCount === 2);
    await flushPromises();
    expect(leaveDlg()!.textContent).toContain(t('calibration.leaveCount', { n: 2 }));
  });

  it('L11. the body describes the dialog (aria-describedby), both paragraphs; a Dialog without `describe` has none', async () => {
    await open();
    await begin();
    // control: "Lưu hiệu chuẩn?" (nothing new yet) has no `describe`
    await clickFinish();
    const finish = panelOf(t('calibration.finishTitle'))!;
    expect(finish.hasAttribute('aria-describedby')).toBe(false);
    expect(finish.querySelector('.dlg__body')!.hasAttribute('id')).toBe(false);
    bodyButton(t('calibration.keepPressing'))!.click();
    await flushPromises();
    await ask('/performance');
    const panel = leaveDlg()!;
    const body = panel.querySelector('.dlg__body')!;
    expect(body.id).not.toBe('');
    expect(panel.getAttribute('aria-describedby')).toBe(body.id);
    expect(body.querySelectorAll('p')).toHaveLength(2);
  });

  it('L12. "Dừng và rời trang" to a target that refuses: stays, still running, nothing stopped, focus on the status line; the next push asks again', async () => {
    await running();
    const stop = stopSpy();
    const link = fromLink();
    await ask('/blocked');
    bodyButton(t('calibration.leaveGo'))!.click();
    await flushPromises();
    expect([route(), cal.phase]).toEqual(['/cal', 'running']);
    expect(stop).not.toHaveBeenCalled();
    expect(leaveDlg()).toBeUndefined();
    expect(document.activeElement).toBe(runningEl());
    expect(document.activeElement).not.toBe(link);
    await ask('/performance');
    expect(leaveDlg()).toBeTruthy();
    expect(route()).toBe('/cal');
  });

  it('L13. "Dừng và rời trang" that goes through, under the out-in page Transition: the leaving page does not take focus', async () => {
    await open({ transition: true });
    await begin();
    const el = runningEl();
    const link = fromLink();
    await ask('/performance');
    // the leaving page is still mounted for a moment (out-in): it must not take focus then (it would drop to body after)
    let focused = 0;
    el.addEventListener('focus', () => { focused++; });
    bodyButton(t('calibration.leaveGo'))!.click();
    await until(() => route() === '/performance' && !el.isConnected);
    await flushPromises();
    expect(focused).toBe(0);
    expect(document.activeElement).toBe(link); // where the Dialog gave it back, not body
    await until(() => cal.phase === 'idle');
  });
});
