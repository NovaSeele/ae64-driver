// While a toast is open the page scroller gets a bottom spacer (toastSafeTarget = stack height + 16 px; 0 when none); it never drops while on screen. 0 HID.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ToastHost from '../src/components/ui/Toast.vue';
import { createSafePad, toastSafeTarget, useToast } from '../src/components/ui/toast';

let cb: ResizeObserverCallback | null = null;
let w: VueWrapper | null = null;
const report = (h: number): void => cb?.([{ contentRect: { height: h } } as ResizeObserverEntry], {} as ResizeObserver);

describe('toast host publishes the target', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { constructor(c: ResizeObserverCallback) { cb = c; } observe() {} disconnect() {} unobserve() {} });
    w = mount(ToastHost, { attachTo: document.body });
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    useToast().items.value = [];
    vi.unstubAllGlobals();
  });

  it('is 0 with no toast', () => {
    expect(toastSafeTarget.value).toBe(0);
  });
  it('is the stack height + 16 px while a toast is open, and 0 once dismissed', async () => {
    const { show, dismiss } = useToast();
    const id = show('Đã lưu');
    await nextTick();
    report(56);
    expect(toastSafeTarget.value).toBe(72);
    dismiss(id);
    await nextTick();
    report(0);
    expect(toastSafeTarget.value).toBe(0);
  });
  it('mounts without ResizeObserver', () => {
    vi.unstubAllGlobals();
    w?.unmount();
    w = mount(ToastHost, { attachTo: document.body });
    expect(toastSafeTarget.value).toBe(0);
  });
});

describe('scroller pad', () => {
  const PAD = 72;
  let el: HTMLDivElement;
  let applied: number[];
  let sp: ReturnType<typeof createSafePad>;
  const geom = (scrollTop: number, pad: number): void => {
    // content 1000 + pad, view 400
    Object.defineProperty(el, 'scrollTop', { value: scrollTop, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 1000 + pad, configurable: true });
  };
  const last = (): number => applied[applied.length - 1];
  const scrollTo = (top: number, pad: number): void => { geom(top, pad); el.dispatchEvent(new Event('scroll')); };

  beforeEach(() => {
    el = document.createElement('div');
    applied = [];
    sp = createSafePad(() => el, (px) => applied.push(px));
  });

  it('(a) a toast opens: pad = height + 16 at once', () => {
    sp.setTarget(PAD);
    expect(last()).toBe(PAD);
  });
  it('(b) closing at the bottom keeps the pad, so the content moves 0 px', () => {
    sp.setTarget(PAD);
    geom(1000 + PAD - 400, PAD); // at the bottom
    sp.setTarget(0);
    expect(last()).toBe(PAD);
  });
  it('(c) scrolling up by the pad brings it to the target and drops the listener', () => {
    const rm = vi.spyOn(el, 'removeEventListener');
    sp.setTarget(PAD);
    geom(1000 + PAD - 400, PAD);
    sp.setTarget(0);
    scrollTo(1000 + PAD - 400 - 30, PAD); // 30 px up: 42 px of the pad still on screen
    expect(last()).toBe(42);
    scrollTo(1000 + PAD - 400 - 80, 42); // past the pad
    expect(last()).toBe(0);
    expect(rm).toHaveBeenCalledWith('scroll', expect.any(Function));
    const n = applied.length;
    scrollTo(0, 0);
    expect(applied.length).toBe(n);
  });
  it('(d) closing far from the bottom goes straight to the target', () => {
    sp.setTarget(PAD);
    geom(100, PAD);
    sp.setTarget(0);
    expect(last()).toBe(0);
  });
  it('a shrinking stack keeps a target above 0 as the floor', () => {
    sp.setTarget(PAD + 40);
    geom(1000 + PAD + 40 - 400, PAD + 40);
    sp.setTarget(PAD);
    expect(last()).toBe(PAD + 40);
    scrollTo(0, PAD + 40);
    expect(last()).toBe(PAD);
  });
  it('a new, smaller toast while a held pad is on screen keeps the held pad (no pull either way)', () => {
    sp.setTarget(PAD + 40);
    geom(1000 + PAD + 40 - 400, PAD + 40); // at the bottom
    sp.setTarget(0); // closed: held at PAD + 40
    expect(last()).toBe(PAD + 40);
    sp.setTarget(PAD); // another toast opens before the user scrolls
    expect(last()).toBe(PAD + 40);
  });
  it('a page shorter than the view (content 705, view 712): keeps what scrollTop needs, and 0 at the top', () => {
    const short = (top: number, pad: number): void => {
      Object.defineProperty(el, 'scrollTop', { value: top, configurable: true });
      Object.defineProperty(el, 'clientHeight', { value: 712, configurable: true });
      Object.defineProperty(el, 'scrollHeight', { value: Math.max(712, 705 + pad), configurable: true });
    };
    sp.setTarget(62);
    short(55, 62); // scrolled to the bottom of 767
    sp.setTarget(0);
    expect(last()).toBe(62); // 705 + 62 - 712 = 55: anything less clamps scrollTop
    short(0, 62);
    el.dispatchEvent(new Event('scroll'));
    expect(last()).toBe(0);
  });
  it('(e) a route change sets the target at once', () => {
    sp.setTarget(PAD);
    geom(1000 + PAD - 400, PAD);
    sp.setTarget(0);
    expect(last()).toBe(PAD);
    sp.reset();
    expect(last()).toBe(0);
    const n = applied.length;
    scrollTo(0, 0);
    expect(applied.length).toBe(n);
  });
});
