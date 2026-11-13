// Key check on the live travel page (DESIGN C §3.3–§3.9, §11): keycap marks and results, the check row, the key lock,
// the ?check=1 entry, the remembered switches, and no new HID traffic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import LiveTravelPage from '../src/pages/LiveTravelPage.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
import { useSelectionStore } from '../src/stores/selection';
import type { PhysicalKey } from '../src/protocol';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

let frames: FrameRequestCallback[] = [];
let device: ReturnType<typeof useDeviceStore>;
let live: ReturnType<typeof useLiveStore>;
let w: VueWrapper | null = null;
const key = (name: string): PhysicalKey => device.keys.find((k) => k.name === name)!;
function route(k: PhysicalKey, mm: number, now: number): void {
  const vals = new Array(16).fill(0);
  vals[k.col] = Math.round(mm * 1000);
  live.ingest('route', k.row, vals, now);
}
function status(k: PhysicalKey, st: number, now: number): void {
  const vals = new Array(16).fill(0);
  vals[k.col] = st;
  live.ingest('keyStatus', k.row, vals, now);
}
/** Run the page's animation frame (it redraws the check at most every 33 ms). */
let clock = 1000;
async function frame(): Promise<void> {
  clock += 100;
  frames.find((f) => f.name === 'frame')!(clock);
  await flushPromises();
}

async function open(path = '/') {
  device = useDeviceStore();
  if (!device.connected) await device.connectDemo(); // a second connect would be a new keyboard (and reset the check)
  await usePerformanceStore().load();
  live = useLiveStore();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  await router.push(path);
  w = mount(LiveTravelPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  return router;
}

beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'vi';
  localStorage.clear();
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** W full and stuck at 0.42, A short at 2.81, S full: the "issues" scene. */
function issues() {
  live.stop(); // the demo poller would read the keys back to rest
  const W = key('W'), A = key('A'), S = key('S');
  route(A, 2.81, 0); route(S, 3.31, 0);
  route(W, 3.31, 0); status(W, 1, 1); status(W, 0, 2); route(W, 0.42, 10); route(W, 0.42, 900);
  return { W, A, S };
}

describe('key check on the live page', () => {
  it('starts empty: zero counters, no chips, the empty table, Start over disabled', async () => {
    await open();
    await frame();
    const hc = w!.find('.hc');
    expect(hc.findAll('.hc__stats dd').map((d) => d.text())).toEqual(['0/64', '0', '0', '0']);
    expect(hc.find('.hc__empty').text()).toBe(t('live.checkEmpty'));
    expect(hc.find('.card__actions button').attributes('disabled')).toBeDefined();
    expect(w!.find('.pt__empty').text()).toBe(t('live.peaksEmpty'));
    expect(w!.find('.pt .card__sub').text()).toContain(t('live.peaksSince'));
  });

  it('shows the counters, the chips (stuck first), the table and the deepest-reading line', async () => {
    await open();
    const { W, A, S } = issues();
    await frame();
    expect(w!.findAll('.hc__stats dd').map((d) => d.text())).toEqual(['3/64', '2', '1', '1']);
    const chips = w!.findAll('.hc__chip');
    expect(chips.map((c) => c.text())).toEqual(['W dừng ở 0.42 mm', 'A đạt 2.81 / 3.31 mm']);
    expect(chips[0].attributes('aria-label')).toBe(t('live.chipStuckLabel', { key: 'W', mm: '0.42' }));
    expect(chips.map((c) => c.attributes('tabindex'))).toEqual(['0', '-1']);
    expect(w!.findAll('.pt__row').map((r) => r.find('.pt__key span').text())).toEqual(['S', 'W', 'A']);
    expect(w!.find('.pt__wrap').attributes('style')).toContain(`min-height: ${3 * 29 + 26}px`);
    const capOf = (k: PhysicalKey) => w!.find(`.kb__key[data-key="${k.id}"]`);
    expect(parseFloat(capOf(A).find('.cap__mark').attributes('style')!.split(':')[1])).toBeCloseTo(2.81 / 3.31, 3);
    expect(capOf(S).find('.cap__mark').exists()).toBe(true);
    expect(capOf(key('E')).find('.cap__mark').exists()).toBe(false);
    // colour off: no result glow or icon; the accessible name still has the deepest reading
    expect(capOf(W).find('.cap--glow').exists()).toBe(false);
    expect(capOf(W).attributes('aria-label')).toContain(t('live.keyPeak', { mm: '3.31' }));
    expect(capOf(W).attributes('aria-label')).not.toContain(t('live.cStuck'));
  });

  it('colours keys by result when switched on, remembered; the followed key without a result keeps its bar', async () => {
    await open();
    const { W, A, S } = issues();
    await frame();
    const sw = w!.find('.kbfoot [role="switch"]');
    expect(sw.attributes('aria-checked')).toBe('false');
    await sw.trigger('click');
    expect(localStorage.getItem('ae64.live.colorByResult')).toBe('1');
    const cap = (k: PhysicalKey) => w!.find(`.kb__key[data-key="${k.id}"]`);
    expect(cap(W).find('.cap').classes()).toContain('cap--glow');
    expect(cap(W).find('.cap').attributes('style')).toContain('--led: var(--danger)');
    expect(cap(A).find('.cap').attributes('style')).toContain('--led: var(--warn)');
    expect(cap(S).find('.cap').attributes('style')).toContain('--led: var(--ok)');
    expect(cap(W).find('.cap__badge').attributes('aria-label')).toBe(t('live.cStuck'));
    expect(cap(W).attributes('aria-label')).toContain(`${t('live.cStuck')} · ${t('live.keyPeak', { mm: '3.31' })}`);
    expect(w!.find('.kblegend').text()).toContain(t('live.showsStuck'));
    // a key with no result: no glow; the followed one keeps its accent bar
    live.setFollow(true);
    live.setFocus(key('E').id);
    await frame();
    expect(cap(key('E')).find('.cap').classes()).not.toContain('cap--glow');
    expect(cap(key('E')).find('.cap__led').exists()).toBe(true);
    w!.unmount();
    // remembered for the next visit
    await open();
    expect(w!.find('.kbfoot [role="switch"]').attributes('aria-checked')).toBe('true');
  });

  it('a chip or a table row pins its key; Start over empties the check and says so', async () => {
    await open();
    const { W, A } = issues();
    await frame();
    await w!.findAll('.hc__chip')[1].trigger('click');
    expect(useSelectionStore().ids).toEqual([A.id]);
    expect(live.focusId).toBe(A.id);
    await frame();
    expect(w!.findAll('.hc__chip')[1].attributes('aria-current')).toBe('true');
    await w!.findAll('.pt__row')[1].trigger('click');
    expect(live.focusId).toBe(W.id);
    await w!.find('.hc .card__actions button').trigger('click');
    await frame();
    expect(live.data.pressedIds.size).toBe(0);
    expect(w!.findAll('.hc__stats dd')[0].text()).toBe('0/64');
    expect(document.activeElement).toBe(w!.find('.hc__title').element);
    expect(w!.find('.pt .card__sub').text()).toContain(t('live.peaksSinceReset'));
    clock += 2000;
    await frame();
    expect(w!.find('.hc__live').text()).toBe(t('live.restartDone'));
  });

  it('pinned with "All keys" off: the partial note, and its button turns All keys on', async () => {
    await open();
    live.allKeys = false;
    useSelectionStore().select(key('W').id);
    await flushPromises();
    const note = w!.find('.hc__note--warn');
    expect(note.text()).toContain(t('live.checkPartial', { key: 'W' }));
    await note.find('button').trigger('click');
    expect(live.allKeys).toBe(true);
    expect(w!.find('.hc__note--warn').exists()).toBe(false);
  });

  it('?check=1 starts the check over, focuses the card title and leaves the URL without check (key kept)', async () => {
    device = useDeviceStore();
    await device.connectDemo();
    live = useLiveStore();
    route(key('W'), 2, 0); // a reading from before: must be gone
    const reset = vi.spyOn(live, 'resetPeaks');
    const router = await open(`/?check=1&key=${key('A').id}`);
    expect(reset).toHaveBeenCalled();
    expect(live.data.pressedIds.size).toBe(0);
    expect(router.currentRoute.value.query).toEqual({ key: String(key('A').id) });
    // the page waits for the card to stand still (jsdom: always at 0) before it scrolls and focuses: run its frames
    await nextTick();
    let settles = 0;
    for (let at = 0; at < frames.length && at < 200; at++) {
      if (frames[at].name !== 'settle') continue; // other loops (the live frame, a meter's draw) re-queue forever
      frames[at](0);
      settles++;
    }
    expect(settles).toBeGreaterThanOrEqual(3); // it measured until the card stood still two frames running...
    expect(settles).toBeLessThan(10); // ...and stopped there, not at the ~30-frame cap
    expect(document.activeElement).toBe(w!.find('.hc__title').element);
  });

  it('makes no HID request of its own: open, press, Start over, both switches', async () => {
    device = useDeviceStore();
    await device.connectDemo();
    await usePerformanceStore().load();
    // every command goes through exchange(): count the frames that are not the existing `04 03` axis-data read
    const tr = device.transport as unknown as { exchange: (f: Uint8Array) => Promise<unknown> };
    const orig = tr.exchange.bind(tr);
    const frames: string[] = [];
    tr.exchange = (f: Uint8Array) => {
      frames.push(Array.from(f.slice(0, 2), (x) => x.toString(16).padStart(2, '0')).join(' '));
      return orig(f);
    };
    await open();
    route(key('W'), 3.31, 0);
    route(key('W'), 0, 10);
    await frame();
    await w!.find('.hc .card__actions button').trigger('click');
    await w!.find('.kbfoot [role="switch"]').trigger('click');
    await w!.find('.klock [role="switch"]').trigger('click');
    await w!.find('.klock [role="switch"]').trigger('click');
    await w!.find('.kbfoot [role="switch"]').trigger('click');
    await frame();
    expect(frames.length).toBeGreaterThan(0); // the poller ran
    expect(frames.filter((f) => f !== '04 03')).toEqual([]);
  });
});

describe('key lock on the live page', () => {
  /** Space on a page button (focused by keyboard); returns whether it was blocked. */
  function spaceOn(el: Element): boolean {
    const e = new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }

  it('is on by default and blocks Space on a page button; the switch turns it off and is remembered', async () => {
    await open();
    const btn = w!.find('.simcard .card__actions button').element;
    expect(w!.find('.klock__text').text()).toBe(t('live.lockOn'));
    expect(spaceOn(btn)).toBe(true);
    // the switch itself still toggles with Space
    const sw = w!.find('.klock [role="switch"]').element;
    expect(spaceOn(sw)).toBe(false);
    await w!.find('.klock [role="switch"]').trigger('click');
    expect(localStorage.getItem('ae64.live.keyLock')).toBe('0');
    expect(w!.find('.klock').classes()).toContain('klock--off');
    expect(w!.find('.klock__text').text()).toBe(t('live.lockOff'));
    expect(spaceOn(btn)).toBe(false);
  });

  it('a stray stored value falls back to on; "0" is off', async () => {
    localStorage.setItem('ae64.live.keyLock', 'yes');
    localStorage.setItem('ae64.live.colorByResult', 'true');
    await open();
    expect(w!.find('.klock [role="switch"]').attributes('aria-checked')).toBe('true');
    expect(w!.find('.kbfoot [role="switch"]').attributes('aria-checked')).toBe('false');
    w!.unmount();
    localStorage.setItem('ae64.live.keyLock', '0');
    await open();
    expect(w!.find('.klock [role="switch"]').attributes('aria-checked')).toBe('false');
  });

  it('only works while measuring: stopped shows the idle line and lets Space through', async () => {
    await open();
    live.stop();
    await flushPromises();
    expect(w!.find('.klock__text').text()).toBe(t('live.lockIdle'));
    expect(w!.find('.klock').classes()).toContain('klock--idle');
    expect(spaceOn(w!.find('.status button').element)).toBe(false);
  });

  it('inside a dialog Space works; once it is gone the lock blocks again', async () => {
    await open();
    const dlg = document.createElement('div');
    dlg.setAttribute('role', 'dialog');
    const inner = document.createElement('button');
    dlg.append(inner);
    document.body.append(dlg);
    expect(spaceOn(inner)).toBe(false);
    dlg.remove();
    expect(spaceOn(w!.find('.simcard .card__actions button').element)).toBe(true);
  });

  it('a key blocked on a keyboard-focused control lights the banner and says why, at most every 10 s', async () => {
    await open();
    const btn = w!.find('.simcard .card__actions button').element as HTMLElement;
    // jsdom has no keyboard modality: the button counts as keyboard-focused
    const real = Element.prototype.matches;
    vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
      return sel === ':focus-visible' ? this === btn : real.call(this, sel);
    });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    expect(spaceOn(btn)).toBe(true);
    await flushPromises();
    expect(w!.find('.klock').classes()).toContain('klock--nudge');
    expect(w!.find('.klock__live').text()).toBe(t('live.lockNudge'));
    vi.advanceTimersByTime(1200);
    await flushPromises();
    expect(w!.find('.klock').classes()).not.toContain('klock--nudge');
    // a click-focused control (not :focus-visible) or the bare page: no reminder
    expect(spaceOn(document.body)).toBe(true);
    await flushPromises();
    expect(w!.find('.klock').classes()).not.toContain('klock--nudge');
    vi.useRealTimers();
  });
});
