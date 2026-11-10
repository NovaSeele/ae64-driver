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
