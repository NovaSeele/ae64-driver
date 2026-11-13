// Visual calibration, page side (DESIGN D §3.2–§3.7, §7, §11): % on the keys and the raw-ADC switch, the four counters,
// "Check keys now", the "Save calibration?" dialog and the session ending while it is open (review D P1), focus, the key
// lock, the green line, and the % switched off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import CalibrationView from '../src/components/calibration/CalibrationView.vue';
import { RECHECK_ROUTE } from '../src/components/calibration/recheck';
import { useToast } from '../src/components/ui/toast';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
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
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let w: VueWrapper | null = null;
let router: Router;
let mock: MockTransport;
let cal: ReturnType<typeof useCalibrationStore>;

async function open() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/cal', component: CalibrationView }, { path: '/live', component: { template: '<i />' } }] });
  await router.push('/cal');
  w = mount({ template: '<RouterView />' }, { global: { plugins: [router] }, attachTo: document.body });
  await until(() => cal.loaded);
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
  await until(() => cal.frame.route[id] === um);
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
  setActivePinia(createPinia());
  locale.value = 'vi';
  vi.stubGlobal('ResizeObserver', RO);
  localStorage.removeItem(ADC_KEY);
  useToast().items.value = [];
  const device = useDeviceStore();
  await device.connectDemo();
  mock = device.transport as MockTransport;
  cal = useCalibrationStore();
});
afterEach(async () => {
  for (const k of [W, A, S, D]) mock.simulatePress(k.id, 0);
  w?.unmount();
  w = null;
  await until(() => cal.phase === 'idle');
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
    expect(router.currentRoute.value.fullPath).toBe(RECHECK_ROUTE);
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
    ['a lost connection', () => { vi.spyOn(useDeviceStore(), 'withTransport').mockRejectedValue(new Error('not connected')); }],
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
