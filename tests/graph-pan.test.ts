import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GraphHistoryModule from '../src/components/live/graphHistory';
import { mount } from '@vue/test-utils';
import { GraphHistory } from '../src/components/live/graphHistory';
import TravelGraph from '../src/components/live/TravelGraph.vue';
import { TravelRing } from '../src/stores/live';
import type { LiveData } from '../src/stores/live';

// Lets one test give the graph a small history (the default holds ~39 s at the real rate).
const hist = vi.hoisted(() => ({ cap: 0 }));
vi.mock('../src/components/live/graphHistory', async (orig) => {
  const m = await orig<typeof GraphHistoryModule>();
  return { GraphHistory: class extends m.GraphHistory { constructor(c?: number) { super(hist.cap || c); } } };
});

describe('GraphHistory', () => {
  const collect = (h: GraphHistory, from: number, to: number) => {
    const out: number[] = [];
    h.forEach(from, to, (t) => out.push(t));
    return out;
  };

  it('is empty: NaN ends, size 0', () => {
    const h = new GraphHistory(4);
    expect(h.size).toBe(0);
    expect(h.oldestT()).toBeNaN();
    expect(h.newestT()).toBeNaN();
    expect(collect(h, -Infinity, Infinity)).toEqual([]);
  });

  it('wraps at capacity, keeping the newest samples in order', () => {
    const h = new GraphHistory(4);
    for (let t = 1; t <= 10; t++) h.push(t, t / 10);
    expect(h.size).toBe(4);
    expect(h.oldestT()).toBe(7);
    expect(h.newestT()).toBe(10);
    expect(collect(h, -Infinity, Infinity)).toEqual([7, 8, 9, 10]);
    const mms: number[] = [];
    h.forEach(9, 10, (_t, mm) => mms.push(mm));
    expect(mms[0]).toBeCloseTo(0.9, 5);
  });

  it('ignores a time that is not after the newest', () => {
    const h = new GraphHistory(8);
    h.push(5, 1);
    h.push(5, 2);
    h.push(4, 3);
    h.push(6, 4);
    expect(collect(h, -Infinity, Infinity)).toEqual([5, 6]);
  });

  it('forEach visits from ≤ t ≤ to only', () => {
    const h = new GraphHistory(16);
    for (let t = 0; t < 10; t++) h.push(t, 0);
    expect(collect(h, 3, 6)).toEqual([3, 4, 5, 6]);
    expect(collect(h, 3.5, 6.5)).toEqual([4, 5, 6]);
    expect(collect(h, 20, 30)).toEqual([]);
  });

  it('clear() empties it and accepts older times again', () => {
    const h = new GraphHistory(4);
    h.push(100, 1);
    h.clear();
    expect(h.size).toBe(0);
    h.push(1, 1);
    expect(h.oldestT()).toBe(1);
  });
});

describe('TravelGraph pan', () => {
  let rafCb: FrameRequestCallback | null = null;
  /** [x, y, 1 for lineTo / 0 for moveTo] */
  let pts: [number, number, number][] = [];
  /** [fillStyle at each fill that directly follows an arc] */
  let arcFills: string[] = [];
  let arcs: [number, number][] = [];
  const Y_1_5MM = 10 + (1.5 / 3.5) * 200;
  const Y_2_1MM = 10 + (2.1 / 3.5) * 200;
  const Y_MARK = 10 + (0.1 / 3.5) * 200; // the oldest test sample (0.1 mm)
  const strokePoints = () => pts.filter(([x, y]) => x > 35 && x < 589 && y > Y_1_5MM + 1 && y <= Y_2_1MM
    && Math.abs(y - Math.round(y) - 0.5) > 1e-6).length;
  /** x of the marker sample (0.1 mm), or null when it is not drawn. */
  const markerX = () => pts.find(([, y]) => Math.abs(y - Y_MARK) < 1e-6)?.[0] ?? null;

  beforeEach(() => {
    rafCb = null;
    arcFills = [];
    arcs = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCb = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    pts = [];
    let fillStyle = '';
    let afterArc = false;
    const ctx = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'clearRect') return () => { pts = []; arcs = []; };
        if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => { pts.push([x, y, k === 'lineTo' ? 1 : 0]); };
        if (k === 'arc') return (x: number, y: number) => { afterArc = true; arcs.push([x, y]); };
        if (k === 'fill') return () => { if (afterArc) arcFills.push(fillStyle); afterArc = false; };
        return () => {};
      },
      set: (_t, k, v) => { if (k === 'fillStyle') fillStyle = v as string; return true; },
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(220);
    // jsdom drops var()/color-mix(): the probe gets a plain style object, echoed back as its computed colour
    const realStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')!.get!;
    const probeStyle = { color: '' };
    vi.spyOn(HTMLElement.prototype, 'style', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('probe') ? (probeStyle as unknown as CSSStyleDeclaration) : realStyle.call(this);
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((() => ({ color: probeStyle.color })) as unknown as typeof getComputedStyle);
  });
  afterEach(() => { hist.cap = 0; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const frame = (t: number) => { const cb = rafCb!; rafCb = null; cb(t); };
  const make = (ring: TravelRing, events: LiveData['events'] = []) => {
    const data = { ring, events, version: 0, epoch: 0 } as unknown as LiveData;
    const w = mount(TravelGraph, { props: { data, settings: null, range: 3.5, paused: false, label: 'g' } });
    return { data, w, pans: () => (w.emitted('pan') ?? []).map((a) => a[0]), holds: () => (w.emitted('hold') ?? []).map((a) => a[0]) };
  };
  /** 10 s of 1 ms samples at rest; the first one (t = 0) is 0.1 mm so it can be told apart. Then a frame at t = 10000. */
  const tenSeconds = () => {
    const m = make(new TravelRing(16384));
    for (let t = 0; t < 10_000; t++) m.data.ring.push(t, t === 0 ? 0.1 : 0.05);
    frame(10_000);
    return m;
  };

  const ptr = (el: Element, type: string, x: number) => {
    const Ctor = (globalThis as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
    el.dispatchEvent(new Ctor(type, { clientX: x, button: 0, bubbles: true }));
  };
  const key = (el: Element, k: string, shiftKey = false) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, shiftKey, bubbles: true }));
  const drag = (el: Element, from: number, to: number) => { ptr(el, 'pointerdown', from); ptr(el, 'pointermove', to); };

  it('dragging far right (grab: back in time) stops at the oldest sample; dragging left past 0 stays at 0', () => {
    const { w, pans } = tenSeconds();
    const el = w.find('canvas').element;
    expect(markerX()).toBeNull(); // live: the 0.1 mm sample is 10 s old
    drag(el, 500, 100_000);
    frame(10_010);
    expect(markerX()).toBeCloseTo(34, 5); // view from == oldestT: the oldest sample sits at the left edge
    expect(pans().at(-1)).toBe(7);
    ptr(el, 'pointerup', 100_000);
    expect(pans().at(-1)).toBe(7); // stays panned

    drag(el, 0, -100_000);
    frame(10_020);
    expect(pans().at(-1)).toBe(0);
    ptr(el, 'pointerup', -100_000);
    expect(pans().at(-1)).toBeNull(); // dragged left past 0 → clamped to 0 → pointerup leaves the pan
    w.unmount();
  });

  it('a plain click (dx < 4) does not pan', () => {
    const { w, pans } = tenSeconds();
    const el = w.find('canvas').element;
    ptr(el, 'pointerdown', 300);
    ptr(el, 'pointermove', 303);
    ptr(el, 'pointerup', 303);
    frame(10_010);
    expect(pans()).toEqual([]);
    w.unmount();
  });

  it('pointerup at panMs 0 leaves the pan', () => {
    const { w, pans } = tenSeconds();
    const el = w.find('canvas').element;
    drag(el, 300, 400); // 100 px right ≈ 540 ms back
    frame(10_010);
    expect(pans()).toEqual([0.5]);
    ptr(el, 'pointermove', 300); // back left by the same distance → exactly 0
    ptr(el, 'pointerup', 300);
    expect(pans()).toEqual([0.5, null]);
    w.unmount();
  });

  it('a double-click, End and Escape leave the pan; ← starts a 500 ms pan, Shift+← 2000 ms', () => {
    const { w, pans } = tenSeconds();
    const el = w.find('canvas').element;
    key(el, 'ArrowLeft');
    frame(10_010);
    expect(pans()).toEqual([0.5]);
    el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    expect(pans()).toEqual([0.5, null]);

    key(el, 'ArrowLeft', true);
    frame(10_020);
    expect(pans().at(-1)).toBe(2);
    key(el, 'ArrowRight');
    frame(10_025);
    expect(pans().at(-1)).toBe(1.5);
    key(el, 'End');
    expect(pans().at(-1)).toBeNull();

    key(el, 'ArrowLeft');
    key(el, 'Home');
    frame(10_030);
    expect(pans().at(-1)).toBe(7);
    key(el, 'Escape');
    expect(pans().at(-1)).toBeNull();
    key(el, 'ArrowRight'); // not panned: nothing
    expect(pans().at(-1)).toBeNull();
    w.unmount();
  });

  it('while panned a new press does not unfreeze or change the pan, and the hold chip stays off', () => {
    const { data, w, pans, holds } = tenSeconds();
    const el = w.find('canvas').element;
    key(el, 'ArrowLeft');
    frame(10_010);
    const before = [pans().length, holds().length];
    data.ring.push(10_100, 1);
    frame(10_110);
    expect([pans().length, holds().length]).toEqual(before);
    expect(pans()).toEqual([0.5]);
    expect(holds().at(-1)).not.toBe(true);
    // leaving the pan returns to live: the pressed sample is back in the history
    key(el, 'End');
    frame(10_120);
    expect(pans().at(-1)).toBeNull();
    w.unmount();
  });

  it('a panned view never moves: samples, hold, release and rest after the pan starts change nothing drawn', () => {
    const events: LiveData['events'] = [{ t: 3900, kind: 'press', depth: 1.2 }];
    const m = make(new TravelRing(8192), events);
    const dt = 1000 / 1670;
    const level = (t: number) => (t < 6000 ? 0.6 + 1.4 * Math.abs(Math.sin(t / 400)) : t < 6100 ? 0.1 : 0.05);
    let t = 0;
    let nextFrame = 0;
    const el = m.w.find('canvas').element;
    let panned = false;
    let reference = '';
    const seen = new Set<string>();
    for (; t < 7500; t += dt) {
      m.data.ring.push(t, level(t));
      m.data.version++;
      if (t >= 5100 && t < 5110) events.push({ t, kind: 'release', depth: 1 });
      if (t >= nextFrame) {
        frame(t);
        nextFrame += 1000 / 60;
        if (!panned && t >= 4000) {
          key(el, 'ArrowLeft'); // mid-stroke: the key is still moving
          key(el, 'ArrowLeft');
          panned = true;
        } else if (panned) {
          const drawn = JSON.stringify([pts, arcs]);
          if (!reference) reference = drawn;
          seen.add(drawn === reference ? 'same' : 'moved');
        }
      }
    }
    expect(panned).toBe(true);
    expect(m.pans().at(-1)).toBe(1);
    expect([...seen]).toEqual(['same']);
    m.w.unmount();
  });

  /** Real-hardware shape: 1,670 Hz, TravelRing(8192) (~4.9 s), version bumped per sample, ~60 fps frames. */
  function realRate(restMm: (t: number) => number, restMs: number) {
    const m = make(new TravelRing(8192));
    const dt = 1000 / 1670;
    let nextFrame = 0;
    let t = 0;
    const advance = (until: number, mm: (t: number) => number) => {
      for (; t < until; t += dt) {
        m.data.ring.push(t, mm(t));
        m.data.version++;
        if (t >= nextFrame) { frame(t); nextFrame += 1000 / 60; }
      }
    };
    advance(300, (x) => 2 * Math.sin((x / 300) * Math.PI)); // 0 → 2.0 → 0
    advance(300 + restMs, restMm);
    frame(t);
    return { ...m, t };
  }

  it('real rate: panning back past the ring still shows a stroke that is long gone from it', () => {
    // rests at 0.2 mm (never "holds"), so the view stays live and the history keeps growing
    const { w, data, pans } = realRate(() => 0.2 + Math.random() * 0.05, 8000);
    expect(data.ring.size).toBe(8192);
    expect(strokePoints()).toBe(0); // live: the stroke is 8 s old
    const el = w.find('canvas').element;
    drag(el, 500, 100_000); // as far back as the history goes
    frame(data.ring.t[(data.ring.head - 1 + 8192) % 8192] + 1);
    expect(pans().at(-1)).toBeGreaterThan(5);
    expect(strokePoints()).toBeGreaterThan(0);
    w.unmount();
  });

  it('real rate: a view held for 45 s still has its stroke (the frozen history does not grow)', () => {
    const { w, holds } = realRate(() => Math.random() * 0.05, 45_000);
    expect(holds().at(-1)).toBe(true);
    expect(strokePoints()).toBeGreaterThan(0);
    w.unmount();
  }, 60_000);

  /** 1,670 Hz stepper over a real TravelRing(8192): push(level) per sample, a frame at ~60 fps, optional per-sample hook. */
  function stepper(events: LiveData['events'] = []) {
    const m = make(new TravelRing(8192), events);
    const dt = 1000 / 1670;
    let nextFrame = 0;
    let t = 0;
    const run = (until: number, mm: (t: number) => number) => {
      for (; t < until; t += dt) {
        m.data.ring.push(t, mm(t));
        m.data.version++;
        if (t >= nextFrame) { frame(t); nextFrame += 1000 / 60; }
      }
    };
    return { ...m, run, now: () => t, el: m.w.find('canvas').element };
  }
  const stroke300 = (t0: number) => (t: number) => 2 * Math.sin(((t - t0) / 300) * Math.PI);

  for (const variant of ['pan', 'pause'] as const) {
    it(`a stroke made while frozen (${variant}) for longer than the ring still reaches the history`, async () => {
      const ev: LiveData['events'] = [{ t: 6150, kind: 'press', depth: 1.5 }];
      const s = stepper(ev);
      s.run(6000, () => 0.05 + Math.random() * 0.02);
      if (variant === 'pan') key(s.el, 'ArrowLeft');
      else await s.w.setProps({ paused: true });
      s.run(6300, stroke300(6000));
      s.run(12_300, () => 0.05 + Math.random() * 0.02); // 6 s: the stroke is long gone from the 4.9 s ring
      if (variant === 'pan') key(s.el, 'End');
      else await s.w.setProps({ paused: false });
      frame(s.now());
      key(s.el, 'ArrowLeft');
      frame(s.now() + 16);
      expect(strokePoints()).toBeGreaterThan(0);
      expect(arcs.length).toBe(1); // the press dot has its trace under it
      s.w.unmount();
    }, 30_000);
  }

  it('a hole in the history is drawn as a break: no line and no event dot across it', async () => {
    hist.cap = 10_000; // ~6 s: a long freeze fills it and appending stops, so the backfill leaves a gap
    const ev: LiveData['events'] = [{ t: 12_150, kind: 'press', depth: 1.5 }];
    const s = stepper(ev);
    const rest = () => 0.2;
    s.run(8000, rest);
    await s.w.setProps({ paused: true });
    s.run(12_000, rest);
    s.run(12_300, (t) => 0.2 + (stroke300(12_000)(t) * 0.9)); // inside the hole
    s.run(17_900, rest);
    await s.w.setProps({ paused: false });
    frame(s.now());
    key(s.el, 'ArrowLeft', true);
    key(s.el, 'ArrowLeft', true);
    key(s.el, 'ArrowLeft'); // 4.5 s back: window ≈ 10.4 s … 13.4 s, the hole (≈ 10.9 … 13.0 s) inside
    frame(s.now() + 16);
    expect(strokePoints()).toBe(0);
    expect(arcs).toEqual([]); // the press at 12.15 s falls in the hole
    const Y_REST = 10 + (0.2 / 3.5) * 200;
    const trace = pts.filter(([, y]) => Math.abs(y - Y_REST) < 1e-6);
    expect(trace.length).toBeGreaterThan(500);
    const jumps = trace.filter(([, , line], i) => line === 1 && trace[i - 1] && Math.abs(trace[i][0] - trace[i - 1][0]) > 5);
    expect(jumps).toEqual([]); // no lineTo bridges the hole
    expect(trace.filter(([, , line]) => line === 0)).toHaveLength(2); // two segments: before and after the hole
    s.w.unmount();
  }, 60_000);

  it('a frozen picture stays identical while the full history keeps growing behind it', async () => {
    hist.cap = 6000; // ~3.6 s at 1,670 Hz: full long before the pause, so appending evicts old samples
    const s = stepper([{ t: 5350, kind: 'press', depth: 1.5 }]);
    const rest = () => 0.2; // never "holds", so only the manual pause freezes the view
    s.run(5200, rest);
    s.run(5500, (t) => 0.2 + stroke300(5200)(t) * 0.9); // a stroke inside the last 3 s
    s.run(8000, rest);
    await s.w.setProps({ paused: true });
    frame(s.now() - 0.1); // the pause clock sits just before the next sample, which must stay off screen
    const first = JSON.stringify([pts, arcs]);
    expect(strokePoints()).toBeGreaterThan(0);
    expect(arcs).toHaveLength(1);
    s.run(18_000, rest); // 10 s more: the ring and the history roll on
    frame(s.now());
    expect(JSON.stringify([pts, arcs])).toBe(first);
    s.w.unmount();
  }, 60_000);

  it('real rate: after an auto hold, ← pans from the held clock (the stroke), not from real time', () => {
    const s = stepper();
    s.run(4000, () => Math.random() * 0.05);
    s.run(4300, stroke300(4000));
    s.run(9300, () => Math.random() * 0.05); // auto hold at ≈ 4.7 s, then 5 s of rest
    frame(s.now());
    expect(s.holds().at(-1)).toBe(true);
    key(s.el, 'ArrowLeft');
    frame(s.now() + 16);
    expect(s.pans()).toEqual([0.5]);
    expect(strokePoints()).toBeGreaterThan(0);
    s.w.unmount();
  });

  it("emits 'review' for panned-or-focused, exactly when that changes", () => {
    const { w, data, pans } = tenSeconds();
    const el = w.find('canvas').element as HTMLCanvasElement;
    const reviews = () => (w.emitted('review') ?? []).map((a) => a[0]);
    el.dispatchEvent(new FocusEvent('focus'));
    expect(reviews()).toEqual([true]); // a: focused
    key(el, 'ArrowLeft');
    frame(10_010);
    expect(pans().at(-1)).toBe(0.5);
    expect(reviews()).toEqual([true]); // b: panned while focused, no change
    key(el, 'End');
    expect(pans().at(-1)).toBeNull();
    frame(10_020);
    expect(reviews()).toEqual([true]); // c: left the pan, still focused
    el.dispatchEvent(new FocusEvent('blur'));
    expect(reviews()).toEqual([true, false]); // d
    drag(el, 300, 400); // e: unfocused drag back in time
    expect(reviews()).toEqual([true, false, true]);
    ptr(el, 'pointermove', 300);
    ptr(el, 'pointerup', 300); // f: back to 0 → pan left
    expect(reviews()).toEqual([true, false, true, false]);
    drag(el, 300, 400);
    expect(reviews().at(-1)).toBe(true);
    (w.vm as unknown as { toLive: () => void }).toLive(); // g
    expect(reviews()).toEqual([true, false, true, false, true, false]);
    drag(el, 300, 400);
    frame(10_030);
    expect(reviews().at(-1)).toBe(true);
    data.ring.clear(); // h: an epoch bump drops the pan
    data.epoch++;
    frame(10_040);
    expect(reviews()).toEqual([true, false, true, false, true, false, true, false]);
    w.unmount();
  });

  it('an epoch bump drops the old samples: nothing to pan into, none drawn', () => {
    const m = make(new TravelRing(8192));
    for (let t = 0; t < 6000; t++) m.data.ring.push(t, 0.1);
    frame(6000);
    const el = m.w.find('canvas').element;
    key(el, 'Home');
    frame(6010);
    expect(m.pans().at(-1)).toBe(3);
    m.data.ring.clear();
    m.data.epoch++;
    m.data.ring.push(7000, 0.05);
    frame(7000);
    expect(m.pans().at(-1)).toBeNull();
    expect(markerX()).toBeNull(); // the old 0.1 mm samples are not drawn
    key(el, 'Home');
    frame(7010);
    expect(m.pans().at(-1)).toBeNull();
    expect(m.pans()).toHaveLength(2);
    m.w.unmount();
  });

  it('while panned no hold is emitted, and events after the frozen clock are not drawn', () => {
    const events: LiveData['events'] = [{ t: 9000, kind: 'press', depth: 1 }, { t: 9900, kind: 'press', depth: 1 }];
    const m = make(new TravelRing(16384), events);
    for (let t = 0; t < 10_000; t++) m.data.ring.push(t, 0.05);
    frame(10_000);
    key(m.w.find('canvas').element, 'ArrowLeft'); // view ends at 9500
    frame(10_010);
    expect(arcs).toHaveLength(1); // 9000 is in view, 9900 is after the right edge
    for (let t = 10_000; t < 10_900; t++) m.data.ring.push(t, t < 10_300 ? 1.5 : 0.05); // a stroke, then 600 ms of rest
    frame(10_900);
    frame(11_000);
    expect(m.holds()).not.toContain(true);
    expect(arcs).toHaveLength(1);
    m.w.unmount();
  });

  it('an epoch bump clears the history and emits pan = null', () => {
    const { data, w, pans } = tenSeconds();
    const el = w.find('canvas').element;
    key(el, 'Home');
    frame(10_010);
    expect(markerX()).not.toBeNull();
    data.ring.clear();
    data.epoch++;
    frame(10_020);
    expect(pans().at(-1)).toBeNull();
    expect(markerX()).toBeNull();
    // the pan is gone too: live again, empty
    data.ring.push(20_000, 0.05);
    frame(20_010);
    expect(pans().at(-1)).toBeNull();
    w.unmount();
  });

  it('the press marker is filled with the press colour, not the actuation colour', () => {
    const m = make(new TravelRing(1024), [{ t: 500, kind: 'press', depth: 1 }, { t: 600, kind: 'release', depth: 0.5 }]);
    for (let t = 0; t < 1000; t++) m.data.ring.push(t, 0.05);
    frame(1000);
    // event order: the press fill first, then the release marker's bg-2 fill
    expect(arcFills).toEqual(['var(--m-press)', 'var(--bg-2)']);
    m.w.unmount();
  });
});
