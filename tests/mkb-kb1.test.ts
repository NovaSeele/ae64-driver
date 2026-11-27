// MKB-V narrow-window keyboard (DESIGN MKB §8.8 KB1, §16.2):
// - minimum unit 24 px on generic (no 12 px shrink), still capped at MAX_UNIT (72 px)
// - horizontal scroll container rendered on generic only, leaving AE64 DOM unchanged
// - touch-action: pan-x pan-y on .kb, scroller, plate and keys while overflowing; none when not overflowing
// - Esc from a NumberField scrolls only the keyboard scroller horizontally, never the page
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { compileStyle, parse } from '@vue/compiler-sfc';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import NumberField from '../src/components/ui/NumberField.vue';
import { layoutBounds } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';

const rect = (left: number, top: number, width: number, height: number): DOMRect =>
  ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

let resizeWidth = 400;
let resizeCbs: Array<(entries: Array<{ contentRect: { width: number } }>) => void> = [];

function triggerResize(w: number) {
  resizeWidth = w;
  for (const cb of resizeCbs) cb([{ contentRect: { width: w } }]);
}

/** Compile KeyboardView.vue's scoped CSS with the element's actual data-v-* scope id and inject it into document.head. */
function injectKeyboardStyles(scopeId: string): HTMLStyleElement {
  const src = readFileSync(resolve('src/components/keyboard/KeyboardView.vue'), 'utf8');
  const { descriptor } = parse(src);
  const scoped = descriptor.styles.find((s) => s.scoped);
  if (!scoped) throw new Error('KeyboardView.vue missing scoped style');
  const compiled = compileStyle({
    source: scoped.content,
    filename: 'src/components/keyboard/KeyboardView.vue',
    id: scopeId,
    scoped: true,
  });
  expect(compiled.errors).toEqual([]);
  const styleEl = document.createElement('style');
  styleEl.textContent = compiled.code;
  document.head.appendChild(styleEl);
  return styleEl;
}

const mounted: VueWrapper[] = [];
const injectedStyles: HTMLStyleElement[] = [];

beforeEach(() => {
  setActivePinia(createPinia());
  resizeWidth = 400;
  resizeCbs = [];
  vi.stubGlobal('ResizeObserver', class {
    private cb: (entries: Array<{ contentRect: { width: number } }>) => void;
    constructor(cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
      this.cb = cb;
      resizeCbs.push(cb);
    }
    observe() {
      this.cb([{ contentRect: { width: resizeWidth } }]);
    }
    disconnect() {
      resizeCbs = resizeCbs.filter((fn) => fn !== this.cb);
    }
  });
});

afterEach(async () => {
  while (mounted.length) mounted.pop()!.unmount();
  while (injectedStyles.length) injectedStyles.pop()!.remove();
  await useDeviceStore().disconnect({ flush: false }).catch(() => undefined);
  await flushPromises();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MKB-V KB1: narrow-window generic keyboard', () => {
  it('keeps minimum unit at 24 px on generic g75 and still caps wide boxes at MAX_UNIT (72 px)', async () => {
    const device = useDeviceStore();
    await device.connectGenericMock('g75', { latencyMs: 0 });
    expect(device.support).toBe('generic');
    const bounds = layoutBounds(device.keys);
    expect(bounds.width).toBe(16);

    // Box width such that width / bounds.width < 24 (e.g. 300 / 16 = 18.75) -> clamped to 24 px (kills MK1).
    resizeWidth = 300;
    const w = mount(KeyboardView, { props: { keys: device.keys, selectable: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();

    const plate = w.find('.kb__plate').element as HTMLElement;
    expect(plate.style.getPropertyValue('--u')).toBe('24px');
    expect(plate.style.width).toBe(`${bounds.width * 24}px`);

    // Mid width (800 / 16 = 50 px) scales linearly.
    triggerResize(800);
    await nextTick();
    expect(plate.style.getPropertyValue('--u')).toBe('50px');
    expect(plate.style.width).toBe(`${bounds.width * 50}px`);

    // Wide box (1600 / 16 = 100 px) stays capped at MAX_UNIT = 72 px.
    triggerResize(1600);
    await nextTick();
    expect(plate.style.getPropertyValue('--u')).toBe('72px');
    expect(plate.style.width).toBe(`${bounds.width * 72}px`);
  });

  it('renders the horizontal scroller only on generic, with safe centring and overflow-y: hidden', async () => {
    const device = useDeviceStore();
    await device.connectGenericMock('g75', { latencyMs: 0 });
    resizeWidth = 300;
    const w = mount(KeyboardView, { props: { keys: device.keys, selectable: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();

    const root = w.find('.kb').element as HTMLElement;
    const scroller = w.find('.kb__scroll');
    expect(scroller.exists()).toBe(true);
    const scrollerEl = scroller.element as HTMLElement;
    const plateEl = w.find('.kb__plate').element as HTMLElement;
    expect(scrollerEl.parentElement).toBe(root);
    expect(plateEl.parentElement).toBe(scrollerEl);

    // Scoped CSS applies to .kb__scroll (has the same data-v-* scope id as .kb).
    const scopeId = Array.from(root.attributes).find((a) => a.name.startsWith('data-v-'))?.name;
    expect(scopeId).toBeTruthy();
    expect(scrollerEl.hasAttribute(scopeId!)).toBe(true);

    injectedStyles.push(injectKeyboardStyles(scopeId!));
    const scrollerStyle = getComputedStyle(scrollerEl);
    expect(scrollerStyle.display).toBe('flex');
    expect(scrollerStyle.overflowX).toBe('auto');
    expect(scrollerStyle.overflowY).toBe('hidden');
    expect(parseFloat(scrollerStyle.paddingTop)).toBeGreaterThanOrEqual(5);
    expect(parseFloat(scrollerStyle.paddingBottom)).toBeGreaterThanOrEqual(5);
    expect(getComputedStyle(plateEl).marginInline).toBe('auto');
  });

  it('toggles touch-action: pan-x pan-y across .kb, scroller, plate and keys only while overflowing', async () => {
    const device = useDeviceStore();
    await device.connectGenericMock('g75', { latencyMs: 0 });
    resizeWidth = 300;
    const w = mount(KeyboardView, { props: { keys: device.keys, selectable: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();

    const root = w.find('.kb').element as HTMLElement;
    const scrollerEl = w.find('.kb__scroll').element as HTMLElement;
    const plateEl = w.find('.kb__plate').element as HTMLElement;
    const keyEl = w.find('.kb__key').element as HTMLElement;
    const scopeId = Array.from(root.attributes).find((a) => a.name.startsWith('data-v-'))!.name;
    injectedStyles.push(injectKeyboardStyles(scopeId));

    let stubScrollWidth = 404;
    let stubClientWidth = 314;
    Object.defineProperty(scrollerEl, 'scrollWidth', { get: () => stubScrollWidth, configurable: true });
    Object.defineProperty(scrollerEl, 'clientWidth', { get: () => stubClientWidth, configurable: true });

    // Overflowing (scrollWidth > clientWidth): whole path computes touch-action: pan-x pan-y (KB1b: vertical swipes chain to the page).
    triggerResize(294);
    await nextTick();
    expect(root.classList.contains('kb--overflow')).toBe(true);
    expect(getComputedStyle(root).touchAction).toBe('pan-x pan-y');
    expect(getComputedStyle(scrollerEl).touchAction).toBe('pan-x pan-y');
    expect(getComputedStyle(plateEl).touchAction).toBe('pan-x pan-y');
    expect(getComputedStyle(keyEl).touchAction).toBe('pan-x pan-y');
    expect(getComputedStyle(scrollerEl).getPropertyValue('overscroll-behavior-x')).toBe('contain');

    // While overflowing: mouse box-drag still draws .kb__box; touch drag does not.
    root.setPointerCapture = () => undefined;
    plateEl.getBoundingClientRect = () => rect(10, 10, 384, 144);
    const dispatchPointer = async (type: string, clientX: number, clientY: number, pointerType: string) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY });
      Object.defineProperty(ev, 'pointerType', { value: pointerType });
      Object.defineProperty(ev, 'pointerId', { value: 1 });
      root.dispatchEvent(ev);
      await nextTick();
    };
    await dispatchPointer('pointerdown', 12, 12, 'touch');
    await dispatchPointer('pointermove', 60, 40, 'touch');
    expect(w.find('.kb__box').exists()).toBe(false);
    await dispatchPointer('pointerup', 60, 40, 'touch');

    await dispatchPointer('pointerdown', 12, 12, 'mouse');
    await dispatchPointer('pointermove', 60, 40, 'mouse');
    expect(w.find('.kb__box').exists()).toBe(true);
    await dispatchPointer('pointerup', 60, 40, 'mouse');
    expect(w.find('.kb__box').exists()).toBe(false);

    // Without overflow (scrollWidth === clientWidth): reverts to .kb touch-action: none.
    stubScrollWidth = 926;
    stubClientWidth = 926;
    triggerResize(906);
    await nextTick();
    expect(root.classList.contains('kb--overflow')).toBe(false);
    expect(getComputedStyle(root).touchAction).toBe('none');
    // The scroller is a scroll container, which would turn panning back on: it must be none too (touch box-drag).
    expect(getComputedStyle(scrollerEl).touchAction).toBe('none');
  });

  it('Esc from a NumberField scrolls only the keyboard scroller horizontally and calls no page scroll', async () => {
    const device = useDeviceStore();
    await device.connectGenericMock('g75', { latencyMs: 0 });
    resizeWidth = 294;

    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });

    try {
      const value = ref(1);
      const w = mount(defineComponent({
        setup: () => () => h('div', { class: 'main__scroll' }, [
          h('div', { class: 'wb__board' }, [h(KeyboardView, { keys: device.keys, selectable: true })]),
          h(NumberField, {
            modelValue: value.value,
            min: 0.1,
            max: 4,
            label: 'Act',
            'onUpdate:modelValue': (v: number) => { value.value = v; },
          }),
        ]),
      }), { attachTo: document.body });
      mounted.push(w);
      await nextTick();

      const pageScroller = w.find('.main__scroll').element as HTMLElement;
      const kbScroller = w.find('.kb__scroll').element as HTMLElement;
      const field = w.find('input').element as HTMLInputElement;
      const leftKey = w.find(`[data-key="${device.keys[0].id}"]`).element as HTMLElement;
      const rightKey = w.find(`[data-key="${device.keys[13].id}"]`).element as HTMLElement;

      pageScroller.getBoundingClientRect = () => rect(0, 0, 360, 600);
      pageScroller.scrollTop = 120;
      pageScroller.scrollLeft = 0;

      Object.defineProperty(kbScroller, 'clientWidth', { value: 314, configurable: true });
      Object.defineProperty(kbScroller, 'scrollWidth', { value: 404, configurable: true });
      kbScroller.getBoundingClientRect = () => rect(20, 80, 314, 164);

      // Case 1: scroller at right end, tab-stop key scrolled off to the left.
      kbScroller.scrollLeft = 90;
      leftKey.getBoundingClientRect = () => rect(-60, 90, 24, 24);
      useSelectionStore().select(device.keys[0].id, 'replace');
      leftKey.focus();
      field.focus();
      await nextTick();

      const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await nextTick();

      expect(document.activeElement).toBe(leftKey);
      const focusIdx = focusSpy.mock.contexts.indexOf(leftKey);
      expect(focusIdx).toBeGreaterThan(-1);
      expect(focusSpy.mock.calls[focusIdx][0]).toEqual({ preventScroll: true });
      // Scroller moved left so leftKey (was at -60, scroller left 20) becomes visible (90 + (-60 - 20) = 10).
      expect(kbScroller.scrollLeft).toBe(10);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(pageScroller.scrollTop).toBe(120);
      expect(pageScroller.scrollLeft).toBe(0);

      // Case 2: scroller at left end, tab-stop key scrolled off to the right.
      kbScroller.scrollLeft = 0;
      rightKey.getBoundingClientRect = () => rect(380, 90, 24, 24);
      rightKey.focus();
      field.focus();
      await nextTick();

      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      await nextTick();

      expect(document.activeElement).toBe(rightKey);
      // Scroller moved right so rightKey (right edge 404, scroller right 334) becomes visible (0 + (404 - 334) = 70).
      expect(kbScroller.scrollLeft).toBe(70);
      expect(scrollIntoView).not.toHaveBeenCalled();
      expect(pageScroller.scrollTop).toBe(120);
      expect(pageScroller.scrollLeft).toBe(0);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('Arrow navigation on generic explicitly reveals a partially clipped key in the scroller with its padding margin', async () => {
    const device = useDeviceStore();
    await device.connectGenericMock('g75', { latencyMs: 0 });
    resizeWidth = 222;

    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', { value: scrollIntoView, configurable: true, writable: true });

    try {
      const w = mount(KeyboardView, { props: { keys: device.keys, selectable: true }, attachTo: document.body });
      mounted.push(w);
      await nextTick();

      const root = w.find('.kb').element as HTMLElement;
      const kbScroller = w.find('.kb__scroll').element as HTMLElement;
      const scopeId = Array.from(root.attributes).find((a) => a.name.startsWith('data-v-'))!.name;
      injectedStyles.push(injectKeyboardStyles(scopeId));

      const padRight = parseFloat(getComputedStyle(kbScroller).paddingRight);
      const padLeft = parseFloat(getComputedStyle(kbScroller).paddingLeft);
      expect(padRight).toBe(10);
      expect(padLeft).toBe(10);

      // Reproduce Chromium 360 px geometry: visible scroller [77..319] (clientWidth 242), scrollLeft 122.
      Object.defineProperty(kbScroller, 'clientWidth', { value: 242, configurable: true });
      Object.defineProperty(kbScroller, 'scrollWidth', { value: 404, configurable: true });
      kbScroller.getBoundingClientRect = () => rect(77, 80, 242, 164);

      const row0 = device.keys.filter((k) => k.uiRow === 0).sort((a, b) => a.x - b.x);
      const key11 = w.find(`[data-key="${row0[11].id}"]`).element as HTMLElement;
      const key12 = w.find(`[data-key="${row0[12].id}"]`).element as HTMLElement;

      // Key 12's right edge (323) is 4 px past visible right (319).
      kbScroller.scrollLeft = 122;
      key12.getBoundingClientRect = () => rect(299, 90, 24, 24);
      key11.focus();
      key11.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      await nextTick();

      expect(document.activeElement).toBe(key12);
      expect(kbScroller.scrollLeft).toBeGreaterThanOrEqual(122 + 4 + padRight);
      expect(kbScroller.scrollLeft).toBe(136);
      expect(scrollIntoView).not.toHaveBeenCalled();

      // ArrowLeft back onto a key whose left edge (73) is 4 px past visible left (77).
      kbScroller.scrollLeft = 136;
      key11.getBoundingClientRect = () => rect(73, 90, 24, 24);
      key12.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true }));
      await nextTick();

      expect(document.activeElement).toBe(key11);
      expect(kbScroller.scrollLeft).toBeLessThanOrEqual(136 - (4 + padLeft));
      expect(kbScroller.scrollLeft).toBe(122);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('leaves AE64 demo DOM root and plate markup unchanged (no scroller, no extra classes or attributes)', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(device.support).toBe('ae64');
    resizeWidth = 900;

    const w = mount(KeyboardView, { props: { keys: device.keys, selectable: true }, attachTo: document.body });
    mounted.push(w);
    await nextTick();

    const root = w.find('.kb').element as HTMLElement;
    const plate = w.find('.kb__plate').element as HTMLElement;
    const bounds = layoutBounds(device.keys);
    const expectedU = Math.max(24, Math.min(72, 900 / bounds.width));

    expect(w.find('.kb__scroll').exists()).toBe(false);
    expect(Array.from(root.classList)).toEqual(['kb', 'kb--selectable']);
    expect(root.children).toHaveLength(1);
    expect(root.firstElementChild).toBe(plate);
    expect(Array.from(plate.classList)).toEqual(['kb__plate']);
    expect(plate.hasAttribute('wrap')).toBe(false);
    expect(plate.style.getPropertyValue('--u')).toBe(`${expectedU}px`);
    expect(plate.style.width).toBe(`${bounds.width * expectedU}px`);
    expect(plate.style.height).toBe(`${bounds.height * expectedU}px`);
    expect(w.findAll('.kb__key')).toHaveLength(64);

    // Even at a narrow width (300 px), AE64 never gets a scroller or kb--overflow.
    triggerResize(300);
    await nextTick();
    expect(w.find('.kb__scroll').exists()).toBe(false);
    expect(Array.from(root.classList)).toEqual(['kb', 'kb--selectable']);
    expect(plate.style.getPropertyValue('--u')).toBe('24px');
  });
});
