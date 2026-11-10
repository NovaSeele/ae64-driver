import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { HOLD_MS, HoldTracker, RESUME_MM } from '../src/components/live/graphHold';
import TravelGraph from '../src/components/live/TravelGraph.vue';
import { TravelRing } from '../src/stores/live';
import type { LiveData } from '../src/stores/live';

/** Feed 1 ms-spaced samples from t0 (exclusive of t0+n) with mm from fn(i). */
function feed(tr: HoldTracker, t0: number, n: number, fn: (i: number) => number): number {
  for (let i = 0; i < n; i++) tr.feed(t0 + i, fn(i));
  return t0 + n - 1;
}
/** 0 → 2.0 → 0 over 200 ms; returns the time of the last sample ≥ RESUME_MM. */
const stroke = (i: number) => (i < 100 ? (i / 100) * 2 : Math.max(0, 2 - ((i - 100) / 100) * 2));

describe('HoldTracker', () => {
  it('never holds an untouched rest', () => {
    const tr = new HoldTracker();
    const last = feed(tr, 0, 5000, () => 0);
    expect(tr.frozenAt(last)).toBeNull();
    expect(tr.frozenAt(last + 10_000)).toBeNull();
  });

  it('holds 400 ms after the last active sample, frozen at lastActiveT + 400', () => {
    const tr = new HoldTracker();
    const last = feed(tr, 1000, 200, stroke);
    // stroke() is ≥ 0.15 up to i = 192 (2 - 2*(i-100)/100 ≥ 0.15)
    let lastActive = 1000;
    for (let i = 0; i < 200; i++) if (stroke(i) >= RESUME_MM) lastActive = 1000 + i;
    feed(tr, last + 1, 600, () => 0);
    expect(tr.frozenAt(lastActive + HOLD_MS - 1)).toBeNull();
    expect(tr.frozenAt(lastActive + HOLD_MS)).toBe(lastActive + HOLD_MS);
    expect(tr.frozenAt(lastActive + 9000)).toBe(lastActive + HOLD_MS);
  });

  it('rest jitter below 0.15 does not resume', () => {
    const tr = new HoldTracker();
    const last = feed(tr, 0, 200, stroke);
    let lastActive = 0;
    for (let i = 0; i < 200; i++) if (stroke(i) >= RESUME_MM) lastActive = i;
    feed(tr, last + 1, 2000, (i) => (i % 2 ? 0.12 : 0));
    expect(tr.frozenAt(last + 2000)).toBe(lastActive + HOLD_MS);
  });

  it('a sample at 0.2 mm resumes', () => {
    const tr = new HoldTracker();
    const last = feed(tr, 0, 200, stroke);
    feed(tr, last + 1, 600, () => 0);
    expect(tr.frozenAt(last + 600)).not.toBeNull();
    tr.feed(last + 601, 0.2);
    expect(tr.frozenAt(last + 601)).toBeNull();
    expect(tr.frozenAt(last + 5000)).toBeNull();
  });

  it('a board resting at 0.2 mm never holds', () => {
    const tr = new HoldTracker();
    const last = feed(tr, 0, 5000, () => 0.2);
    expect(tr.frozenAt(last + 10_000)).toBeNull();
  });

  it('reset() forgets the stroke', () => {
    const tr = new HoldTracker();
    const last = feed(tr, 0, 200, stroke);
    feed(tr, last + 1, 600, () => 0);
    expect(tr.frozenAt(last + 600)).not.toBeNull();
    tr.reset();
    feed(tr, last + 601, 600, () => 0);
    expect(tr.frozenAt(last + 1200)).toBeNull();
    const l2 = feed(tr, last + 1201, 200, stroke);
    feed(tr, l2 + 1, 600, () => 0);
    expect(tr.frozenAt(l2 + 600)).not.toBeNull();
  });
});

describe('TravelGraph hold emit', () => {
  let rafCb: FrameRequestCallback | null = null;
  /** x, y of every moveTo/lineTo in the last frame (cleared by clearRect). Y(1.5 mm) = 10 + 1.5/3.5*200. */
  let pts: [number, number][] = [];
  const Y_1_5MM = 10 + (1.5 / 3.5) * 200;
  const Y_2_1MM = 10 + (2.1 / 3.5) * 200;
  /** Trace points of the stroke only: inside the plot (x0 = 34, x1 = 590), 1.5–2.1 mm deep, not on a 0.5 px grid line. */
  const strokePoints = () => pts.filter(([x, y]) => x > 35 && x < 589 && y > Y_1_5MM + 1 && y <= Y_2_1MM
    && Math.abs(y - Math.round(y) - 0.5) > 1e-6).length;

  beforeEach(() => {
    rafCb = null;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCb = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    pts = [];
    const ctx = new Proxy({}, {
      get: (_t, k) => {
        if (k === 'clearRect') return () => { pts = []; };
        if (k === 'moveTo' || k === 'lineTo') return (x: number, y: number) => { pts.push([x, y]); };
        return () => {};
      },
      set: () => true,
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(220);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  const frame = (t: number) => { const cb = rafCb!; rafCb = null; cb(t); };

  it('emits true after stroke + 400 ms, false on a new press and on an epoch bump', async () => {
    const data = { ring: new TravelRing(8192), events: [], version: 0, epoch: 0 } as unknown as LiveData;
    const w = mount(TravelGraph, { props: { data, settings: null, range: 3.5, paused: false, label: 'g' } });
    const holds = () => (w.emitted('hold') ?? []).map((a) => a[0]);

    for (let i = 0; i < 200; i++) data.ring.push(i, stroke(i));
    frame(210);
    expect(holds()).toEqual([]);
    for (let i = 200; i < 700; i++) data.ring.push(i, 0);
    frame(700);
    expect(holds()).toEqual([true]);
    frame(5000); // far later: still holding, no re-emit
    expect(holds()).toEqual([true]);

    data.ring.push(9000, 1);
    frame(9001);
    expect(holds()).toEqual([true, false]);

    for (let i = 0; i < 600; i++) data.ring.push(9002 + i, 0);
    frame(9700);
    expect(holds()).toEqual([true, false, true]);
    data.ring.clear();
    data.epoch++;
    frame(9800);
    expect(holds()).toEqual([true, false, true, false]);
    w.unmount();
  });

  it('manual pause wins: no hold emitted while paused, and a press does not unfreeze', async () => {
    const data = { ring: new TravelRing(8192), events: [], version: 0, epoch: 0 } as unknown as LiveData;
    const w = mount(TravelGraph, { props: { data, settings: null, range: 3.5, paused: false, label: 'g' } });
    for (let i = 0; i < 200; i++) data.ring.push(i, stroke(i));
    for (let i = 200; i < 700; i++) data.ring.push(i, 0);
    frame(700);
    await w.setProps({ paused: true });
    frame(710);
    expect((w.emitted('hold') ?? []).map((a) => a[0])).toEqual([true, false]);
    data.ring.push(800, 1);
    frame(801);
    expect((w.emitted('hold') ?? []).map((a) => a[0])).toEqual([true, false]);
    w.unmount();
  });

  /** Real-hardware shape: 1,670 Hz, ring 8192 (~4.9 s), version bumped on every pushed sample, ~60 fps frames. */
  async function scenario(pauseAfterStroke: boolean, extra?: (w: ReturnType<typeof mount>, data: LiveData, t: number) => Promise<void>) {
    const data = { ring: new TravelRing(8192), events: [], version: 0, epoch: 0 } as unknown as LiveData;
    const w = mount(TravelGraph, { props: { data, settings: null, range: 3.5, paused: false, label: 'g' } });
    const dt = 1000 / 1670;
    let nextFrame = 0;
    let t = 0;
    let paused = false;
    const advance = async (until: number, mm: (t: number) => number) => {
      for (; t < until; t += dt) {
        data.ring.push(t, mm(t));
        data.version++;
        if (t >= nextFrame) { frame(t); nextFrame += 1000 / 60; }
      }
    };
    await advance(300, (x) => 2 * Math.sin((x / 300) * Math.PI)); // 0 → 2.0 → 0
    if (pauseAfterStroke) { await w.setProps({ paused: true }); paused = true; }
    await advance(12_300, () => Math.random() * 0.05);
    frame(t);
    if (extra) await extra(w, data, t);
    return { w, data, paused, holds: () => (w.emitted('hold') ?? []).map((a) => a[0]) };
  }

  it('real rate: the hold and the stroke are still there 12 s after release', async () => {
    const { w, holds } = await scenario(false);
    expect(holds().at(-1)).toBe(true);
    expect(strokePoints()).toBeGreaterThan(0); // the stroke itself, not the grid
    w.unmount();
  });

  it('real rate: a manual pause keeps the stroke for 12 s too', async () => {
    const { w, holds } = await scenario(true);
    expect(holds()).not.toContain(true);
    expect(strokePoints()).toBeGreaterThan(0);
    w.unmount();
  });

  it('real rate: an epoch bump (clear) exits the hold; a settings change does not', async () => {
    const { w, data, holds } = await scenario(false);
    await w.setProps({ settings: { mode: 0, normalPress: 1, normalRelease: 0, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0, releaseDeadStroke: 0, range: 3.5 } });
    data.version++;
    frame(13_000);
    expect(holds().at(-1)).toBe(true);
    expect(strokePoints()).toBeGreaterThan(0);
    data.ring.clear();
    data.epoch++;
    frame(13_100);
    expect(holds().at(-1)).toBe(false);
    w.unmount();
  });
});
