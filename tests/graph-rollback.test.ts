import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import { PHYSICAL_KEYS } from '../src/protocol';
import TravelGraph from '../src/components/live/TravelGraph.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';

const SPACE = PHYSICAL_KEYS.find((k) => k.name === 'Space')!;

describe('TravelGraph after a live rollback', () => {
  let rafCb: FrameRequestCallback | null = null;
  /** [x, y] of every moveTo / lineTo of the last frame */
  let pts: [number, number][] = [];
  const base = performance.now() + 10_000;
  const frame = (t: number) => { const cb = rafCb!; rafCb = null; cb(base + t); };
  /** Deepest travel (mm) on the trace; horizontal grid lines (y at .5) and the vertical ones and area edges (y 10 and 210) are not part of it. */
  const drawnMax = () => Math.max(...pts.filter(([, y]) => Math.abs((y % 1) - 0.5) > 1e-6 && y !== 10 && y !== 210).map(([, y]) => ((y - 10) / 200) * 3.5));

  beforeEach(() => {
    rafCb = null;
    pts = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { rafCb = cb; return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
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
    // jsdom drops var()/color-mix(): the probe gets a plain style object, echoed back as its computed colour
    const realStyle = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'style')!.get!;
    const probeStyle = { color: '' };
    vi.spyOn(HTMLElement.prototype, 'style', 'get').mockImplementation(function (this: HTMLElement) {
      return this.classList.contains('probe') ? (probeStyle as unknown as CSSStyleDeclaration) : realStyle.call(this);
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((() => ({ color: probeStyle.color })) as unknown as typeof getComputedStyle);
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it('CC19. the graph drops the rolled-back samples: its trace peaks at the genuine stroke, not the UI travel', async () => {
    setActivePinia(createPinia());
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    const live = useLiveStore();
    live.stop();
    live.reset();
    live.setFocus(SPACE.id);
    const row = (mm: number, t: number) => {
      const values: number[] = [];
      for (const p of PHYSICAL_KEYS) if (p.row === SPACE.row) values[p.col] = p.id === SPACE.id ? Math.round(mm * 1000) : 0;
      for (let i = 0; i < values.length; i++) values[i] ??= 0;
      live.ingest('route', SPACE.row, values, base + t);
    };
    const w = mount(TravelGraph, { props: { data: live.data, settings: null, range: 3.5, paused: false, label: 'g' } });

    row(0, 1000);
    row(2.0, 1020); // the genuine stroke peaks at 2.0
    row(0, 1040);
    row(0.6, 1600); // UI stroke on the focused key, ahead of the keydown
    row(3.3, 1620);
    frame(1630);
    expect(drawnMax()).toBeCloseTo(3.3, 1);

    live.markUiPressed([SPACE.id], base + 1640); // rollbackPress
    expect(live.data.peak).toBeCloseTo(2.0, 1);
    row(0, 1650); // the next poll
    frame(1660);
    expect(drawnMax()).toBeCloseTo(2.0, 1);
    w.unmount();
  });
});
