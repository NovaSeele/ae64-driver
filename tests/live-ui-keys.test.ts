import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import LiveTravelPage from '../src/pages/LiveTravelPage.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
import { useSelectionStore } from '../src/stores/selection';
import { locale } from '../src/i18n/locale';

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const Q = key('Q');
const SPACE = key('Space');
const ENTER = key('Enter');

describe('Space/Enter that operates a control is not a test press', () => {
  let live: ReturnType<typeof useLiveStore>;
  let undo: ReturnType<typeof vi.spyOn>;
  let w: ReturnType<typeof mount> | null = null;
  const depth = new Map<number, number>();
  const base = performance.now() + 10_000; // ingest clock, ahead of anything the page itself stamps

  /** Set one key's travel (mm) and feed its whole row, like a poll does. */
  function set(k: { id: number; row: number }, mm: number, now: number) {
    depth.set(k.id, mm);
    const values: number[] = [];
    for (const p of PHYSICAL_KEYS) if (p.row === k.row) values[p.col] = Math.round((depth.get(p.id) ?? 0) * 1000);
    for (let i = 0; i < values.length; i++) values[i] ??= 0;
    live.ingest('route', k.row, values, base + now);
  }

  function strokeW() {
    set(W, 1, 1000);
    set(W, 3, 1020);
    set(W, 2, 1040);
    set(W, 0, 1060);
  }

  function ringMax(): number {
    let m = 0;
    live.data.ring.forEach(-Infinity, (_t, mm) => { m = Math.max(m, mm); });
    return m;
  }

  function keydown(target: Element, k: string, code: string) {
    const e = new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true });
    target.dispatchEvent(e);
  }

  beforeEach(async () => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    depth.clear();
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    live = useLiveStore();
    undo = vi.spyOn(live, 'undoAutoFollow');
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(LiveTravelPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    useDeviceStore().demo = false; // the demo's window keydown capture would swallow the keystroke
    await flushPromises();
    live.stop(); // no background polling: the tests feed ingest themselves
    live.reset();
    undo.mockClear();
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const button = () => w!.find('.graphcard button').element;

  it('1. Space on a button undoes the W → Space switch and restores W with its data', () => {
    strokeW();
    set(SPACE, 2, 1500);
    expect(live.focusId).toBe(SPACE.id);
    keydown(button(), ' ', 'Space');
    expect(undo).toHaveBeenCalledTimes(1);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    expect(ringMax()).toBeCloseTo(3, 1);
    set(SPACE, 2.1, 1520); // Space is still held: not followed again
    expect(live.focusId).toBe(W.id);
  });

  it('2. Enter keydown before its travel: no switch; after release a deliberate Enter is followed', () => {
    strokeW();
    vi.spyOn(performance, 'now').mockReturnValue(base + 1400); // the page stamps the mark on the ingest clock
    keydown(button(), 'Enter', 'Enter');
    expect(live.focusId).toBe(W.id);
    set(ENTER, 0, 1500); // stale rest sample must not end the mark
    set(ENTER, 1, 1520);
    set(ENTER, 3, 1540);
    expect(live.focusId).toBe(W.id);
    set(ENTER, 0, 1600);
    set(ENTER, 2, 2000);
    expect(live.focusId).toBe(ENTER.id);
  });

  it('3. Space in the typing box is not intercepted and is followed', () => {
    strokeW();
    keydown(w!.find('textarea[data-keytest]').element, ' ', 'Space');
    expect(undo).not.toHaveBeenCalled();
    set(SPACE, 2, 1500);
    expect(live.focusId).toBe(SPACE.id);
  });

  it('4. a held UI-pressed Space never blocks a real test: W is followed', () => {
    strokeW();
    keydown(button(), ' ', 'Space');
    set(SPACE, 3, 1500);
    expect(live.focusId).toBe(W.id);
    const X = key('X');
    set(X, 1, 1600); // a real press while Space is held
    expect(live.focusId).toBe(X.id);
  });

  it('5. remap: the Space keystroke uses the key holding 0x2C; the physical Space position is a normal key', () => {
    const dev = useDeviceStore();
    const l0 = dev.layer0.slice();
    l0[Q.id] = 0x2c;
    l0[SPACE.id] = 0x04;
    dev.layer0 = l0;
    strokeW();
    set(Q, 2, 1500);
    expect(live.focusId).toBe(Q.id);
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(W.id);
    set(Q, 0, 1600);
    set(SPACE, 2, 2000);
    expect(live.focusId).toBe(SPACE.id);
  });

  it('6. Space on the graph canvas is not intercepted', () => {
    strokeW();
    set(SPACE, 2, 1500);
    keydown(w!.find('canvas.graph').element, ' ', 'Space');
    expect(undo).not.toHaveBeenCalled();
    expect(live.focusId).toBe(SPACE.id);
  });

  const TAB = key('Tab');

  it('A. W, Tab (released), Space travel, Space keydown on a button: W with its data', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0, 1520);
    set(SPACE, 2, 1600); // Tab → Space
    expect(live.focusId).toBe(SPACE.id);
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    expect(ringMax()).toBeCloseTo(3, 1);
  });

  it('B. W, Tab (released), Enter keydown before its travel: W; Enter travel ignored; a later Enter is followed', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0, 1520);
    expect(live.focusId).toBe(TAB.id);
    vi.spyOn(performance, 'now').mockReturnValue(base + 1550);
    keydown(button(), 'Enter', 'Enter');
    expect(live.focusId).toBe(W.id);
    expect(ringMax()).toBeCloseTo(3, 1);
    set(ENTER, 1, 1560);
    set(ENTER, 3, 1580);
    expect(live.focusId).toBe(W.id);
    set(ENTER, 0, 1700);
    set(ENTER, 2, 2000);
    expect(live.focusId).toBe(ENTER.id);
  });

  it('C. W, three Tabs pressed and released, Space travel, Space keydown on a button: W', () => {
    strokeW();
    for (let i = 0; i < 3; i++) {
      set(TAB, 2, 1500 + i * 200);
      set(TAB, 0, 1560 + i * 200);
    }
    set(SPACE, 2, 2200);
    expect(live.focusId).toBe(SPACE.id);
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
  });

  it('D. the graph-focus call without keys also undoes a released Tab (one rule for both paths)', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0, 1520);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
  });

  const RIGHT = key('→');

  it('E. W, Tab, → travels, ArrowRight on the Auto radio: focus is back on W and the pin pins W', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0, 1520);
    set(RIGHT, 2, 1600);
    expect(live.focusId).toBe(RIGHT.id);
    const radio = w!.find('[role=radio]').element;
    keydown(radio, 'ArrowRight', 'ArrowRight');
    expect(undo).toHaveBeenCalledTimes(1);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    expect(ringMax()).toBeCloseTo(3, 1);
    const sel = useSelectionStore();
    sel.select(live.focusId!); // what the Segmented's setFollow('pin') does
    expect(live.focusId).toBe(W.id);
    expect(ringMax()).toBeCloseTo(3, 1);
    set(RIGHT, 2.1, 1620); // → is still held: not followed again
    expect(live.focusId).toBe(W.id);
  });

  it('F. ArrowRight on a plain button does not undo: follow stays on →', () => {
    strokeW();
    set(RIGHT, 2, 1500);
    keydown(button(), 'ArrowRight', 'ArrowRight');
    expect(undo).not.toHaveBeenCalled();
    expect(live.focusId).toBe(RIGHT.id);
  });

  it('Z3. only the arrow actually pressed is marked: ↓ travelling right after ArrowRight on the radio is followed', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0, 1520);
    set(RIGHT, 2, 1600);
    keydown(w!.find('[role=radio]').element, 'ArrowRight', 'ArrowRight');
    expect(live.focusId).toBe(W.id);
    set(key('↓'), 2, 1650); // within 400 ms of the mark, so only the per-key mark lets it through
    expect(live.focusId).toBe(key('↓').id);
  });

  it('Y6. a mark whose key never travels expires after 400 ms: a later real Space is followed', () => {
    strokeW();
    vi.spyOn(performance, 'now').mockReturnValue(base + 1100);
    keydown(button(), ' ', 'Space'); // Space pressed on another keyboard: the AE64 Space never moves
    set(SPACE, 0, 1200);
    set(SPACE, 0, 1300);
    set(SPACE, 0, 1700); // > 400 ms after the mark, still no travel: the mark ends
    set(SPACE, 2, 1800);
    expect(live.focusId).toBe(SPACE.id);
  });

  it('Y2. the focused key being UI-pressed counts as depth 0: W at 2.5 mm beats a held Space at 3.3 mm', () => {
    live.setFocus(SPACE.id); // Space is the focus with no auto-follow chain behind it
    set(TAB, 2, 1600); // Tab hop stashes Space
    expect(live.focusId).toBe(TAB.id);
    set(TAB, 0, 1650);
    set(SPACE, 2, 1700); // AE64 Space travels while Space is pressed on a button
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(SPACE.id); // undo returns to Space, now focused and UI-pressed
    set(SPACE, 3.3, 1800);
    set(W, 2.5, 1850); // below Space + FOLLOW_MARGIN, but Space counts as 0
    expect(live.focusId).toBe(W.id);
  });

  it('Y2b. a Space tested in the typing box, then Tab, then Space on Pause: back to the tested Space, not past it to W', () => {
    strokeW();
    set(SPACE, 3.3, 1200); // a real Space test (typing box): W → Space
    set(SPACE, 0, 1300);
    expect(live.focusId).toBe(SPACE.id);
    expect(live.data.count).toBe(1);
    set(TAB, 2, 1600); // Tab to Pause: Space stashed
    set(TAB, 0, 1650);
    set(SPACE, 2, 1700); // AE64 Space travels as it presses Pause: Tab → Space
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(SPACE.id);
    expect(live.data.count).toBe(1); // the tested Space stroke is back
    set(SPACE, 3.3, 1800);
    set(W, 2.5, 1850); // Space is UI-pressed and focused, so it counts as 0: W is followed
    expect(live.focusId).toBe(W.id);
  });

  it('Y2c. the UI stroke of the focused Space leaves no press, count or ring trace; the next real Space press counts', () => {
    strokeW();
    set(SPACE, 2.5, 1200); // real Space test (peak 2.5, below the UI stroke's 3.3)
    set(SPACE, 0, 1300);
    set(TAB, 2, 1600);
    set(TAB, 0, 1650);
    set(SPACE, 1.4, 1700); // travel seen before the keydown
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(SPACE.id);
    const events = live.data.events.length;
    const ring = live.data.ring.size;
    const top = ringMax();
    set(SPACE, 3.3, 1750); // the UI stroke goes on to the bottom and back
    set(SPACE, 1, 1800);
    set(SPACE, 0, 1850);
    expect(live.data.count).toBe(1);
    expect(live.data.events.length).toBe(events);
    expect(live.data.ring.size).toBeLessThanOrEqual(ring + 1); // only the rest sample once the mark ends
    expect(ringMax()).toBe(top);
    set(SPACE, 3.3, 2000); // a real press after the key came back to rest
    expect(live.data.count).toBe(2);
  });

  const kinds = () => live.data.events.map((e) => e.kind);
  const undone = () => undo.mock.results[0].value as boolean;

  it('Y2d. Tab → Space link with the focus already Space: the stashed genuine stroke comes back, not the UI stroke', () => {
    strokeW();
    set(SPACE, 3.3, 1200); // genuine Space test: press@3.3
    set(SPACE, 0, 1300); // release@0
    set(TAB, 2, 1600); // Space stashed as the chain root
    set(TAB, 0, 1650);
    set(SPACE, 2, 1700); // Tab → Space with a fresh ring (the UI stroke)
    expect(live.data.ring.size).toBe(1);
    keydown(button(), ' ', 'Space');
    expect(undone()).toBe(true);
    expect(live.focusId).toBe(SPACE.id);
    expect(kinds()).toEqual(['press', 'release']);
    expect(ringMax()).toBeCloseTo(3.3, 1);
    expect(live.data.count).toBe(1);
  });

  /** A genuine test of `k` (peak 3.3) with no switch since: the focus is `k`, at rest, count 1. */
  function testedThenUiStroke(k: { id: number; row: number }, target: () => Element, kk: string, code: string) {
    strokeW();
    set(k, 3.3, 1200);
    set(k, 0, 1300);
    expect(live.focusId).toBe(k.id);
    set(k, 0.6, 1600); // the UI stroke starts; no Tab, so no switch link of this press
    set(k, 1.4, 1620);
    expect(live.data.count).toBe(2);
    keydown(target(), kk, code);
    expect(undone()).toBe(false);
    expect(live.focusId).toBe(k.id);
    expect(live.data.count).toBe(1);
    expect(kinds()).toEqual(['press', 'release']);
    expect(ringMax()).toBeCloseTo(3.3, 1);
    set(k, 3.3, 1700); // the stroke goes on: still ignored
    expect(live.data.count).toBe(1);
    set(k, 0, 1800);
    expect(live.data.count).toBe(1);
    expect(kinds()).toEqual(['press', 'release']);
    set(k, 3.3, 2000); // a real press after rest
    expect(live.data.count).toBe(2);
  }

  it('B2a. Space tested, Pause clicked, Space pressed: travel before the keydown is rolled back', () => {
    testedThenUiStroke(SPACE, button, ' ', 'Space');
  });

  it('B2b. the same with Enter', () => {
    testedThenUiStroke(ENTER, button, 'Enter', 'Enter');
  });

  it('B2c. the same with ArrowRight on the radio', () => {
    testedThenUiStroke(RIGHT, () => w!.find('[role=radio]').element, 'ArrowRight', 'ArrowRight');
  });

  it('B2d. keydown first: Space tested, keydown on the button, then the travel: nothing recorded', () => {
    strokeW();
    set(SPACE, 3.3, 1200);
    set(SPACE, 0, 1300);
    vi.spyOn(performance, 'now').mockReturnValue(base + 1400);
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(SPACE.id);
    set(SPACE, 1.4, 1500);
    set(SPACE, 3.3, 1520);
    set(SPACE, 0, 1600);
    expect(live.focusId).toBe(SPACE.id);
    expect(live.data.count).toBe(1);
    expect(kinds()).toEqual(['press', 'release']);
    expect(ringMax()).toBeCloseTo(3.3, 1);
  });

  /** Times (ingest clock) of every ring sample at or after `from`. */
  function ringSince(from: number): number[] {
    const out: number[] = [];
    live.data.ring.forEach(from, (t) => { out.push(t); });
    return out;
  }

  it('B3. events at the cap: rolling back the UI stroke drops its press, not an older genuine event', () => {
    live.setFocus(SPACE.id);
    for (let i = 0; i < 110; i++) {
      set(SPACE, 3.3, 1000 + i * 20);
      set(SPACE, 0, 1010 + i * 20);
    }
    expect(live.data.count).toBe(110);
    expect(live.data.events.length).toBe(200); // EVENT_CAP
    set(SPACE, 0.6, 5000); // the UI stroke starts; no Tab, so no switch link
    set(SPACE, 1.4, 5020);
    expect(live.data.count).toBe(111);
    keydown(button(), ' ', 'Space');
    expect(live.data.count).toBe(110);
    const last = live.data.events[live.data.events.length - 1];
    expect(last.kind).toBe('release');
    expect(last.t).toBe(base + 1010 + 109 * 20);
    expect(live.data.events.every((e) => e.t < base + 5000)).toBe(true);
  });

  it('CC7/CC14/CC15. the rollback takes the UI stroke out of the ring and restores peak and lastActuation', () => {
    strokeW();
    set(SPACE, 3.3, 1200);
    set(SPACE, 0, 1300);
    expect(live.focusId).toBe(SPACE.id);
    const size = live.data.ring.size;
    const newest = 1300 + base;
    const act = live.data.lastActuation;
    expect(act).toBeCloseTo(3.3, 1);
    set(SPACE, 0.6, 1600);
    set(SPACE, 1.4, 1620);
    expect(live.data.peak).toBeCloseTo(1.4, 1);
    expect(live.data.lastActuation).toBeCloseTo(1.4, 1);
    keydown(button(), ' ', 'Space');
    expect(live.data.ring.size).toBe(size); // CC7
    expect(ringSince(base + 1600)).toEqual([]);
    expect(ringSince(-Infinity).at(-1)).toBe(newest);
    expect(live.data.peak).toBeCloseTo(3.3, 1); // CC14
    expect(live.data.lastActuation).toBe(act); // CC15
  });

  it('CC9. a snapshot is dropped at rest: a keydown-first UI press after a second genuine stroke keeps both strokes', () => {
    strokeW();
    set(SPACE, 3.3, 1200); // W → Space follow switch: the first genuine stroke
    set(SPACE, 0, 1300);
    expect(live.focusId).toBe(SPACE.id);
    set(SPACE, 3.3, 1400); // second genuine stroke from rest: takes a snapshot (count 1)
    set(SPACE, 0, 1450); // back at rest: the snapshot is dropped
    expect(live.data.count).toBe(2);
    vi.spyOn(performance, 'now').mockReturnValue(base + 1500);
    keydown(button(), ' ', 'Space'); // keydown before the travel: nothing to roll back
    set(SPACE, 1.4, 1520);
    set(SPACE, 3.3, 1540);
    set(SPACE, 0, 1600);
    expect(live.data.count).toBe(2);
    expect(kinds()).toEqual(['press', 'release', 'press', 'release']);
  });

  it('CC10. the user Clear drops the snapshot: a UI mark afterwards does not bring back pre-clear data', () => {
    live.setFocus(SPACE.id);
    set(SPACE, 3.3, 1200);
    set(SPACE, 0, 1300);
    set(SPACE, 3.3, 1400); // second press mid-stroke: snapshot with count 1
    expect(live.data.count).toBe(2);
    live.clear();
    expect(live.data.count).toBe(0);
    keydown(button(), ' ', 'Space');
    expect(live.data.count).toBe(0);
    expect(live.data.events.length).toBe(0);
  });

  it('CC18. the rollback restores `touched`: after the user Clear, a UI stroke that is rolled back leaves it false', () => {
    live.setFocus(SPACE.id);
    set(SPACE, 3.3, 1000);
    set(SPACE, 0, 1100);
    live.clear();
    expect(live.data.touched).toBe(false);
    set(SPACE, 0.6, 1600); // no Tab: the mouse path, the travel arrives ahead of the keydown
    set(SPACE, 1.4, 1620);
    expect(live.data.touched).toBe(true);
    keydown(button(), ' ', 'Space');
    expect(live.data.touched).toBe(false);
  });

  it('AA4. a UI mark ending at rest resyncs only the focused key: W held mid-press gets no spurious release/press', () => {
    set(W, 2, 1000); // W focused, held, actuated
    expect(live.data.count).toBe(1);
    vi.spyOn(performance, 'now').mockReturnValue(base + 1050);
    keydown(button(), ' ', 'Space'); // marks Space; W is not Space
    set(SPACE, 3, 1100);
    set(SPACE, 0, 1200); // the mark ends at rest
    expect(live.focusId).toBe(W.id);
    set(W, 2, 1300);
    expect(live.data.count).toBe(1);
    expect(kinds()).toEqual(['press']);
  });

  it('AA5/AA6. the focused key under a UI mark: current follows its depth and the model is synced, nothing is recorded', () => {
    strokeW();
    set(SPACE, 3.3, 1200);
    set(SPACE, 0, 1300);
    vi.spyOn(performance, 'now').mockReturnValue(base + 1400);
    keydown(button(), ' ', 'Space');
    set(SPACE, 3.3, 1500);
    expect(live.data.current).toBeCloseTo(3.3, 1); // AA6
    expect(live.data.model!.actuated).toBe(true); // AA5
    set(SPACE, 0.2, 1550); // above rest: the mark holds
    expect(live.data.current).toBeCloseTo(0.2, 1);
    expect(live.data.model!.actuated).toBe(false);
    expect(live.data.count).toBe(1);
    set(SPACE, 0, 1600);
    set(SPACE, 3.3, 1700);
    expect(live.data.count).toBe(2);
    expect(live.data.lastActuation).toBeCloseTo(3.3, 1);
  });

  it('Y7. stop() clears the marks: a real Space right after is followed', () => {
    strokeW();
    live.markUiPressed([SPACE.id], base + 1000);
    live.stop();
    set(SPACE, 2, 1100); // within UI_MARK_MS of the mark, so only the clear can rescue it
    expect(live.focusId).toBe(SPACE.id);
  });

  it('Y8. with an empty layer0 the physical Space name is used: Space keydown undoes and marks it', () => {
    useDeviceStore().layer0 = [];
    strokeW();
    set(SPACE, 2, 1500);
    expect(live.focusId).toBe(SPACE.id);
    keydown(button(), ' ', 'Space');
    expect(live.focusId).toBe(W.id);
    set(SPACE, 2.1, 1520); // marked: not followed again
    expect(live.focusId).toBe(W.id);
  });

  it('7. the listener is removed on unmount', () => {
    const el = button();
    w!.unmount(); // the detached root still holds its children, so a leftover listener would fire
    w = null;
    keydown(el, ' ', 'Space');
    expect(undo).not.toHaveBeenCalled();
  });
});

describe('demo: Space on a focused control is not a test press, even tapped repeatedly', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('three Space taps on the Pause button leave focus on W and its count at 1', async () => {
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    vi.useFakeTimers();
    const live = useLiveStore();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    const w = mount(LiveTravelPage, { global: { plugins: [router] }, attachTo: document.body });
    await vi.advanceTimersByTimeAsync(200);
    const fire = (target: Element, type: 'keydown' | 'keyup', code: string, k: string) =>
      target.dispatchEvent(new KeyboardEvent(type, { key: k, code, bubbles: true, cancelable: true }));

    fire(document.body, 'keydown', 'KeyW', 'w');
    await vi.advanceTimersByTimeAsync(30);
    fire(document.body, 'keyup', 'KeyW', 'w');
    await vi.advanceTimersByTimeAsync(1500);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);

    const pause = w.find('.graphcard button').element as HTMLButtonElement;
    pause.focus();
    for (let i = 0; i < 3; i++) {
      fire(pause, 'keydown', 'Space', ' ');
      await vi.advanceTimersByTimeAsync(30);
      fire(pause, 'keyup', 'Space', ' ');
      await vi.advanceTimersByTimeAsync(70);
    }
    await vi.advanceTimersByTimeAsync(3000);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    w.unmount();
  }, 30_000);
});
