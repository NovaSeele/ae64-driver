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
const TAB = key('Tab');
const SHIFT = key('Left Shift') ?? PHYSICAL_KEYS.find((k) => /shift/i.test(k.name))!;

describe('undoAutoFollow', () => {
  let live: ReturnType<typeof useLiveStore>;
  const depth = new Map<number, number>();

  /** Set one key's travel (mm) and feed its whole row, like a poll does. */
  function set(k: { id: number; row: number }, mm: number, now: number) {
    depth.set(k.id, mm);
    const values: number[] = [];
    for (const p of PHYSICAL_KEYS) if (p.row === k.row) values[p.col] = Math.round((depth.get(p.id) ?? 0) * 1000);
    for (let i = 0; i < values.length; i++) values[i] ??= 0;
    live.ingest('route', k.row, values, now);
  }

  beforeEach(async () => {
    setActivePinia(createPinia());
    depth.clear();
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    live = useLiveStore();
    live.reset();
  });

  it('restores the key followed before a Tab pressed while it was released', () => {
    set(W, 2, 1000);
    expect(live.focusId).toBe(W.id);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(live.follow).toBe(true);
  });

  it('Shift+Tab: undoes both switches and restores W', () => {
    set(W, 2, 1000);
    set(W, 0, 1020);
    set(SHIFT, 1, 1050);
    set(TAB, 2, 1100);
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  it('does nothing when the Tab was already released', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    set(TAB, 0, 1120);
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
  });

  // typing box → Pause → Clear → graph: only the first Tab switches (W → Tab); later Tabs find Tab already followed
  for (const gap of [250, 400, 600, 1000]) {
    it(`three Tabs ${gap} ms apart onto the graph restore W (no age limit)`, () => {
      set(W, 2, 1000);
      set(W, 0, 1100);
      let t = 1500;
      for (let i = 0; i < 3; i++) {
        set(TAB, 3.3, t);
        expect(live.focusId).toBe(TAB.id);
        if (i < 2) set(TAB, 0, t + 120);
        t += gap;
      }
      expect(live.undoAutoFollow()).toBe(true); // the third Tab is still held as the graph gets focus
      expect(live.focusId).toBe(W.id);
      expect(live.follow).toBe(true);
    });
  }

  it('W, then Shift held with several Tabs onto the graph restores W', () => {
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(SHIFT, 1, 1200); // W → Shift
    for (let i = 0; i < 6; i++) {
      set(TAB, 3.3, 1300 + i * 300); // Shift → Tab
      if (i < 5) set(TAB, 0, 1400 + i * 300); // Tab → Shift (Shift still held)
    }
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  it('W, then X pressed and released, then Tab onto the graph keeps X (the deliberate test)', () => {
    const X = key('X');
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(X, 2, 3000);
    set(X, 0, 3100);
    set(TAB, 3.3, 9000);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(X.id);
  });

  it('does nothing after pin()', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    live.pin(TAB.id);
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.follow).toBe(false);
  });

  it('does nothing after a manual setFocus', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    live.setFocus(W.id);
    live.setFocus(TAB.id);
    expect(live.undoAutoFollow()).toBe(false);
  });

  it('restores W when the Tab came long after W was released', () => {
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(TAB, 2, 1700);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  it('does not chain past a key that was released before the undo', () => {
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(SHIFT, 1, 1200); // W → Shift
    set(SHIFT, 0, 1300); // Shift released
    set(TAB, 2, 1400); // Shift → Tab
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(SHIFT.id);
  });

  function ringMax(): number {
    let m = 0;
    live.data.ring.forEach(-Infinity, (_t, mm) => { m = Math.max(m, mm); });
    return m;
  }

  /** W pressed to ~3 mm and released (standard-mode demo: it actuates). */
  function strokeW() {
    set(W, 1, 1000);
    set(W, 3, 1020);
    set(W, 2, 1040);
    set(W, 0, 1060);
  }

  it('restores the data of the key followed before, not only its name', () => {
    strokeW();
    const { peak, lastActuation, lastRelease } = live.data;
    expect(live.data.count).toBe(1);
    const epoch = live.data.epoch;
    set(TAB, 2, 1500);
    expect(ringMax()).toBeCloseTo(2, 1); // Tab's own buffers
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(ringMax()).toBeCloseTo(3, 1);
    expect(live.data.ring.size).toBeGreaterThan(0);
    expect(live.data.count).toBe(1);
    expect(live.data.peak).toBe(peak);
    expect(live.data.lastActuation).toBe(lastActuation);
    expect(live.data.lastRelease).toBe(lastRelease);
    expect(live.data.lastRelease).not.toBeNull();
    expect(live.data.events.length).toBe(2);
    expect(live.data.touched).toBe(true);
    expect(live.data.epoch).not.toBe(epoch);
    expect(live.data.model).not.toBeNull();
    expect(live.data.model!.actuated).toBe(false);
  });

  it('slow path: three Tabs 600 ms apart, the last held, restores the same data', () => {
    strokeW();
    let t = 1500;
    for (let i = 0; i < 3; i++) {
      set(TAB, 3.3, t);
      if (i < 2) set(TAB, 0, t + 120);
      t += 600;
    }
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(ringMax()).toBeCloseTo(3, 1);
    expect(live.data.count).toBe(1);
  });

  it('Shift held with several Tabs still restores W with its data', () => {
    strokeW();
    set(SHIFT, 1, 1200);
    for (let i = 0; i < 4; i++) {
      set(TAB, 3.3, 1300 + i * 300);
      if (i < 3) set(TAB, 0, 1400 + i * 300);
    }
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(ringMax()).toBeCloseTo(3, 1);
    expect(live.data.count).toBe(1);
  });

  it('keeps a key the user is holding on purpose (W released, A held, Tab held without a switch)', () => {
    const A = key('A');
    strokeW();
    set(A, 3, 2000); // W → A
    expect(live.focusId).toBe(A.id);
    set(TAB, 3.05, 2100); // not deeper than A + margin: no switch
    expect(live.focusId).toBe(A.id);
    const ring = live.data.ring;
    const size = ring.size;
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(A.id);
    expect(live.data.ring).toBe(ring);
    expect(live.data.ring.size).toBe(size);
  });

  it('never restores to "nothing followed yet"', () => {
    expect(live.focusId).toBeNull();
    set(TAB, 3, 1000); // null → Tab
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
  });

  describe('focus-moving keys by layer-0 keycode', () => {
    const Q = key('Q');
    const A = key('A');
    function remap() {
      const dev = useDeviceStore();
      expect(dev.layer0.length).toBeGreaterThan(0);
      const l0 = dev.layer0.slice();
      l0[TAB.id] = 0x04; // physical Tab now types 'A'
      l0[Q.id] = 0x2b; // physical Q now types Tab
      dev.layer0 = l0;
    }

    it('a remapped Tab position is not undone; the position holding 0x2B is', () => {
      remap();
      strokeW();
      set(Q, 2, 1500); // W → Q (Tab code)
      expect(live.focusId).toBe(Q.id);
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.focusId).toBe(W.id);
      expect(ringMax()).toBeCloseTo(3, 1);
      expect(live.data.count).toBe(1);
    });

    it('the physical Tab position holding another code returns false', () => {
      remap();
      strokeW();
      set(TAB, 2, 1500); // W → physical Tab, now 'A'
      expect(live.focusId).toBe(TAB.id);
      expect(live.undoAutoFollow()).toBe(false);
      expect(live.focusId).toBe(TAB.id);
    });

    it('follows layer0 changes after the store was created', () => {
      strokeW();
      remap();
      set(TAB, 2, 1500);
      expect(live.undoAutoFollow()).toBe(false);
      useDeviceStore().layer0 = [];
      expect(live.undoAutoFollow()).toBe(true); // fallback: physical Tab again
      expect(live.focusId).toBe(W.id);
    });

    it('layer0 empty: the physical Tab and Shift still work', () => {
      useDeviceStore().layer0 = [];
      strokeW();
      set(SHIFT, 1, 1200);
      set(TAB, 3.3, 1300);
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.focusId).toBe(W.id);
      expect(ringMax()).toBeCloseTo(3, 1);
    });

    it('0xE5 (right shift) counts as focus-moving', () => {
      const dev = useDeviceStore();
      const l0 = dev.layer0.slice();
      l0[A.id] = 0xe5;
      dev.layer0 = l0;
      strokeW();
      set(A, 2, 1500);
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.focusId).toBe(W.id);
    });
  });

  it('one stash: a new chain root X replaces W; undo gives X its own data back', () => {
    const X = key('X');
    strokeW(); // W peak 3
    set(TAB, 2, 1500); // W → Tab, stash W
    set(TAB, 0, 1520);
    set(X, 1, 2000); // Tab → X (inside the chain: W stays root)
    set(X, 2.5, 2020);
    set(X, 0, 2040);
    set(TAB, 2, 2500); // X → Tab: X is the new root, W dropped
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(X.id);
    expect(ringMax()).toBeCloseTo(2.5, 1);
  });

  for (const how of ['pin', 'setFocus', 'stop', 'reset'] as const) {
    it(`${how} drops the stash: a later undo returns the key without W's data`, () => {
      strokeW();
      set(TAB, 2, 1500); // W → Tab, stash W
      if (how === 'pin') live.pin(SHIFT.id);
      else if (how === 'setFocus') live.setFocus(SHIFT.id);
      else if (how === 'stop') { live.stop(); live.setFocus(SHIFT.id); }
      else { live.reset(); depth.clear(); live.setFocus(SHIFT.id); }
      live.setFollow(true);
      set(SHIFT, 1, 3000);
      set(SHIFT, 0, 3020);
      set(TAB, 3.3, 3040); // Shift → Tab
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.focusId).toBe(SHIFT.id);
      expect(ringMax()).toBeLessThan(2.5);
      expect(live.data.count).toBe(0);
    });
  }

  it('stop() clears the switch log', () => {
    strokeW();
    set(TAB, 2, 1500);
    live.stop();
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
  });

  it('reset() clears the switch log', () => {
    strokeW();
    set(TAB, 2, 1500);
    live.reset();
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
  });
});

describe('graph keyboard focus', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function mountPage() {
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    const live = useLiveStore();
    const undo = vi.spyOn(live, 'undoAutoFollow');
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    const w = mount(LiveTravelPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return { w, undo, live };
  }

  it('undoes auto-follow once when :focus-visible matches', async () => {
    const { w, undo } = await mountPage();
    const canvas = w.find('canvas.graph').element as HTMLCanvasElement;
    vi.spyOn(canvas, 'matches').mockImplementation((s: string) => s === ':focus-visible');
    canvas.focus();
    await flushPromises();
    expect(undo).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('leaves auto-follow alone on pointer focus', async () => {
    const { w, undo } = await mountPage();
    const canvas = w.find('canvas.graph').element as HTMLCanvasElement;
    vi.spyOn(canvas, 'matches').mockReturnValue(false);
    canvas.focus();
    await flushPromises();
    expect(undo).not.toHaveBeenCalled();
    w.unmount();
  });

  it('does not undo when the page is pinned', async () => {
    const { w, undo, live } = await mountPage();
    live.pin(W.id);
    const canvas = w.find('canvas.graph').element as HTMLCanvasElement;
    vi.spyOn(canvas, 'matches').mockReturnValue(true);
    canvas.focus();
    await flushPromises();
    expect(undo).not.toHaveBeenCalled();
    w.unmount();
  });
});
