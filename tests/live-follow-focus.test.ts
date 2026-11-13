import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import { PHYSICAL_KEYS } from '../src/protocol';
import { mountPerformance } from './mountPerformance';
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

  it('undoes a Tab that was already released (navigation, never a test)', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    set(TAB, 0, 1120);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
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

  it('a Shift+Tab walk longer than the capped log still returns to the root key W, with its stroke', () => {
    strokeW();
    set(SHIFT, 1, 1200); // Shift held lightly: each Tab hops Shift → Tab → Shift (2 links per Tab)
    let t = 1300;
    for (let i = 0; i < 40; i++) {
      set(TAB, 2, (t += 20));
      set(TAB, 0, (t += 20));
    }
    expect(live.focusId).toBe(SHIFT.id);
    set(TAB, 2, (t += 20)); // the Tab onto the graph, still held; W → Shift fell out of the 64-link log long ago
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    expect(ringMax()).toBeCloseTo(3, 1);
  });

  it('chains past a released Shift: W, Shift tap, Tab held → W with its stroke', () => {
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(SHIFT, 1, 1200); // W → Shift
    set(SHIFT, 0, 1300); // Shift released
    set(TAB, 2, 1400); // Shift → Tab
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  // The root.id === restore guard cannot be reached with a non-root restore any more: a restore other than the
  // stash's key needs a walk that stops at a Tab/Shift link, and those are always undone. This pins W's data.
  it('W, Shift released, Tab held: restores W with its stroke (not Shift\'s empty buffer)', () => {
    strokeW();
    expect(live.data.count).toBe(1);
    set(SHIFT, 1, 1200); // W → Shift, W stashed
    set(SHIFT, 0, 1300); // Shift released
    set(TAB, 3.3, 1400); // Shift → Tab
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(ringMax()).toBeCloseTo(3, 1);
    expect(live.data.count).toBe(1);
    expect(live.data.touched).toBe(true);
  });

  it('W, a Shift tap, then Tab onto the graph (no keys): W, count 1, stroke present', () => {
    strokeW();
    set(SHIFT, 1, 1200);
    set(SHIFT, 0, 1250);
    set(TAB, 3.3, 1400);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    expect(ringMax()).toBeCloseTo(3, 1);
    expect(live.follow).toBe(true);
  });

  it('W, Shift held with Shift+Tab ×2, all released, then a Tab held: W', () => {
    strokeW();
    set(SHIFT, 1, 1200); // W → Shift
    set(TAB, 3.3, 1300); // Shift → Tab
    set(TAB, 0, 1400);
    set(TAB, 3.3, 1500); // Tab → Tab again; Shift still held
    set(TAB, 0, 1600);
    set(SHIFT, 0, 1700); // everything released
    set(TAB, 3.3, 2500); // a further Tab
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(live.data.count).toBe(1);
    expect(ringMax()).toBeCloseTo(3, 1);
  });

  it('nothing followed, a Shift tap, then Tab: false, focus/data/follow unchanged', () => {
    set(SHIFT, 1, 1000); // null → Shift
    set(SHIFT, 0, 1050);
    set(TAB, 3.3, 1200); // Shift → Tab
    expect(live.focusId).toBe(TAB.id);
    const { ring, count, version, epoch } = live.data;
    const size = ring.size;
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
    expect(live.follow).toBe(true);
    expect(live.data.ring).toBe(ring);
    expect(live.data.ring.size).toBe(size);
    expect(live.data.count).toBe(count);
    expect(live.data.version).toBe(version);
    expect(live.data.epoch).toBe(epoch);
  });

  it('regression: W, X, Tab → X; W, A held, Tab → A', () => {
    const X = key('X');
    const A = key('A');
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(X, 2, 3000);
    set(X, 0, 3100);
    set(TAB, 3.3, 9000);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(X.id);
    live.reset();
    depth.clear();
    set(W, 2, 20000);
    set(W, 0, 20100);
    set(A, 2, 20200); // W → A, held
    set(TAB, 3.3, 20300); // A → Tab
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(A.id);
  });

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

  /** Standard mode, press and release at 1.2 mm, for W. */
  function standardW() {
    Object.assign(usePerformanceStore().values[W.id], { mode: 0, normalPress: 1.2, normalRelease: 1.2, pressDeadStroke: 0, releaseDeadStroke: 0 });
  }

  describe('stale stash model', () => {
    it('W released while Tab was followed: the undo emits no fake release at 0 mm; later strokes still work', () => {
      standardW();
      live.reset();
      set(W, 1.2, 1000);
      set(W, 3.3, 1020);
      set(W, 2.4, 1040); // still actuated
      expect(live.data.model!.actuated).toBe(true);
      const lastRelease = live.data.lastRelease;
      set(TAB, 3.5, 1500); // deeper than W: W is stashed while actuated
      expect(live.focusId).toBe(TAB.id);
      set(W, 0.08, 1600); // W fully released, unseen by its model
      set(TAB, 0.16, 1700);
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.focusId).toBe(W.id);
      live.setFollow(false);
      const events = live.data.events.length;
      set(W, 0.08, 1800);
      set(W, 0.05, 1820);
      expect(live.data.events.length).toBe(events);
      expect(live.data.events.some((e) => e.kind === 'release' && e.depth < 0.5)).toBe(false);
      expect(live.data.lastRelease).toBe(lastRelease);
      expect(live.data.lastRelease).not.toBe(0);
      expect(live.data.count).toBe(1);
      set(W, 1.5, 1900);
      set(W, 0.8, 1920);
      const tail = live.data.events.slice(events);
      expect(tail.map((e) => e.kind)).toEqual(['press', 'release']);
      expect(tail[0].depth).toBeCloseTo(1.5, 2);
      expect(tail[1].depth).toBeCloseTo(0.8, 2);
      expect(live.data.count).toBe(2);
    });

    it('a key still pressed at the undo stays actuated and emits no second press', () => {
      standardW();
      live.reset();
      set(W, 3, 1000);
      set(TAB, 3.5, 1500);
      set(W, 2.5, 1600);
      expect(live.undoAutoFollow()).toBe(true);
      live.setFollow(false);
      const events = live.data.events.length;
      set(W, 2.6, 1700);
      expect(live.data.events.length).toBe(events);
      expect(live.data.model!.actuated).toBe(true);
    });

    it('RT model: sync primes armed/peak/trough at the current depth and emits nothing', () => {
      const perf = usePerformanceStore();
      Object.assign(perf.values[W.id], { mode: 1, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.3, pressDeadStroke: 0, releaseDeadStroke: 0 });
      live.reset();
      set(W, 2, 1000);
      set(W, 3, 1020);
      set(TAB, 3.5, 1500);
      set(W, 0.08, 1600); // fully up unseen
      set(TAB, 0.16, 1700);
      expect(live.undoAutoFollow()).toBe(true);
      live.setFollow(false);
      const events = live.data.events.length;
      set(W, 0.08, 1800);
      expect(live.data.events.length).toBe(events);
      expect(live.data.model!.actuated).toBe(false);
      set(W, 2, 1900); // continuous RT: still armed, re-actuates rtPress below the trough
      expect(live.data.events.slice(events).map((e) => e.kind)).toEqual(['press']);
    });

    it('RT at rest: the restore resets the model; the next press happens at rtFirstTouch, not trough + rtPress', () => {
      const perf = usePerformanceStore();
      Object.assign(perf.values[W.id], { mode: 1, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.8, pressDeadStroke: 0.1, releaseDeadStroke: 0 });
      live.reset();
      set(W, 2, 1000);
      expect(live.data.model!.armed).toBe(true);
      set(TAB, 3.5, 1500); // W → Tab while W is armed and actuated
      set(W, 0.03, 1600); // W back at rest (a few hundredths of a mm), unseen by its model
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.focusId).toBe(W.id);
      live.setFollow(false);
      expect(live.data.model!.armed).toBe(false);
      expect(live.data.model!.actuated).toBe(false);
      const events = live.data.events.length;
      let t = 1700;
      for (let mm = 0.03; mm < 1.5; mm += 0.05) set(W, mm, (t += 5));
      const tail = live.data.events.slice(events);
      expect(tail.map((e) => e.kind)).toEqual(['press']);
      expect(tail[0].depth).toBeGreaterThanOrEqual(0.99);
      expect(tail[0].depth).toBeLessThanOrEqual(1.06);
    });

    it('RT mid-press: the restore takes peak and trough from the current depth, not the stale peak', () => {
      const perf = usePerformanceStore();
      Object.assign(perf.values[W.id], { mode: 1, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.5, pressDeadStroke: 0, releaseDeadStroke: 0 });
      live.reset();
      set(W, 2, 1000);
      set(W, 3.3, 1020); // peak 3.3
      set(TAB, 3.5, 1500); // W → Tab, stashed at peak 3.3
      set(W, 2, 1600); // W partly released, unseen
      expect(live.undoAutoFollow()).toBe(true);
      live.setFollow(false);
      expect(live.data.model!.peak).toBeCloseTo(2, 5);
      expect(live.data.model!.trough).toBeCloseTo(2, 5);
      const events = live.data.events.length;
      set(W, 2, 1700);
      set(W, 1.8, 1720);
      set(W, 1.6, 1740); // 3.3 − 0.5 = 2.8 and 2.0 − 0.5 = 1.5: the stale peak would already have released
      expect(live.data.events.length).toBe(events);
      set(W, 1.4, 1760);
      const tail = live.data.events.slice(events);
      expect(tail.map((e) => e.kind)).toEqual(['release']);
      expect(tail[0].depth).toBeCloseTo(1.4, 2);
    });

    it('standard mode: held past the press point while the stale model was released, the restore emits no press', () => {
      standardW();
      live.reset();
      set(W, 1.5, 1000); // press
      set(W, 0.5, 1020); // release
      expect(live.data.count).toBe(1);
      expect(live.data.model!.actuated).toBe(false);
      set(TAB, 3.5, 1500); // W → Tab, stashed as released
      set(W, 2.5, 1600); // W pressed unseen
      expect(live.undoAutoFollow()).toBe(true);
      live.setFollow(false);
      expect(live.data.model!.actuated).toBe(true);
      const events = live.data.events.length;
      set(W, 2.6, 1700);
      set(W, 2, 1720);
      set(W, 1.3, 1740);
      expect(live.data.events.length).toBe(events);
      expect(live.data.count).toBe(1);
      set(W, 1.1, 1760);
      set(W, 0.9, 1780);
      const tail = live.data.events.slice(events);
      expect(tail.map((e) => e.kind)).toEqual(['release']);
      expect(tail[0].depth).toBeCloseTo(1.1, 2);
      expect(live.data.count).toBe(1);
    });

    it('settings edited between the stash and the restore give the model the new settings', () => {
      standardW();
      live.reset();
      strokeW();
      set(TAB, 2, 1500);
      usePerformanceStore().values[W.id].normalPress = 2.7;
      usePerformanceStore().values[W.id].normalRelease = 2.7;
      expect(live.undoAutoFollow()).toBe(true);
      expect(live.data.model!.settings.normalPress).toBe(2.7);
      expect(live.data.model!.settings.normalRelease).toBe(2.7);
    });
  });

  it('a user Clear drops the stash: undo returns false and W keeps nothing of its old stroke', () => {
    strokeW();
    set(TAB, 3.3, 1500); // W → Tab, stash W
    live.clear();
    expect(live.undoAutoFollow()).toBe(false);
    expect(live.focusId).toBe(TAB.id);
    expect(live.data.ring.size).toBe(0);
    expect(live.data.count).toBe(0);
  });

  it('a firmware-held key with travel just below FOLLOW_MIN still counts as held', () => {
    strokeW();
    set(TAB, 2, 1500); // W → Tab
    set(TAB, 0.1, 1600); // below FOLLOW_MIN
    live.ingest('keyStatus', TAB.row, PHYSICAL_KEYS.filter((p) => p.row === TAB.row).reduce((a, p) => { a[p.col] = p.id === TAB.id ? 1 : 0; return a; }, [] as number[]).map((v) => v ?? 0), 1610);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  it('a Tab below FOLLOW_MIN with no firmware status is still undone (focus-moving, held or not)', () => {
    strokeW();
    set(TAB, 2, 1500);
    set(TAB, 0.1, 1600);
    expect(live.undoAutoFollow()).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

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
    const { w } = await mountPerformance('test');
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
