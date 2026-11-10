import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import LiveTravelPage from '../src/pages/LiveTravelPage.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
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

  it('D. the graph-focus call without keys still refuses a released Tab', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0, 1520);
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
  });

  it('7. the listener is removed on unmount', () => {
    const el = button();
    w!.unmount(); // the detached root still holds its children, so a leftover listener would fire
    w = null;
    keydown(el, ' ', 'Space');
    expect(undo).not.toHaveBeenCalled();
  });
});
