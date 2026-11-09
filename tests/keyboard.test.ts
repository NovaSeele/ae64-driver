import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import { useSelectionStore } from '../src/stores/selection';
import type { PhysicalKey } from '../src/protocol';

const key = (id: number, x: number): PhysicalKey => ({ id, uiRow: 0, row: 1, col: id, x, y: 0, w: 1, name: `K${id}` });
const rect = (left: number, top: number, width: number, height: number) => () => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

describe('KeyboardView box select', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  // Case 400 px wide, plate 2 keys · 58 px = 116 px centred: plate starts 142 px into the case (16 px padding included in the case rect).
  async function setup() {
    const w = mount(KeyboardView, { props: { keys: [key(0, 0), key(1, 1)], selectable: true }, attachTo: document.body });
    const root = w.find('.kb').element as HTMLElement;
    root.getBoundingClientRect = rect(0, 0, 400, 90);
    root.setPointerCapture = () => undefined;
    (w.find('.kb__plate').element as HTMLElement).getBoundingClientRect = rect(142, 16, 116, 58);
    const fire = async (type: string, clientX: number, clientY: number) => {
      root.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY }));
      await w.vm.$nextTick();
    };
    return { w, fire };
  }

  it('draws the box under the pointer and selects what it covers when the plate is centred', async () => {
    const { w, fire } = await setup();
    await fire('pointerdown', 144, 18); // plate (2, 2)
    await fire('pointermove', 200, 50); // plate (58, 34)
    const box = w.find('.kb__box').element as HTMLElement;
    expect(box.style.left).toBe('2px');
    expect(box.style.top).toBe('2px');
    expect(box.style.width).toBe('56px');
    // Box ends at 58 px = right edge of key 0: only key 0 is lit, key 1 starts at 58.
    expect(w.findAll('.kb__key').map((k) => k.attributes('aria-pressed'))).toEqual(['true', 'false']);
    await fire('pointerup', 200, 50);
    expect(useSelectionStore().ids).toEqual([0]);
    w.unmount();
  });

  it('ends the box when the pointer capture is lost', async () => {
    const { w, fire } = await setup();
    await fire('pointerdown', 144, 18);
    await fire('pointermove', 200, 50);
    expect(w.find('.kb__box').exists()).toBe(true);
    await fire('lostpointercapture', 0, 0);
    expect(w.find('.kb__box').exists()).toBe(false);
    await fire('pointermove', 250, 60);
    expect(w.find('.kb__box').exists()).toBe(false);
    w.unmount();
  });
});

describe('KeyboardView accessible status', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('appends the status text to each key name, with no badge on the key', () => {
    const w = mount(KeyboardView, {
      props: { keys: [key(0, 0), key(1, 1)], color: () => 'red', status: (k: PhysicalKey) => (k.id === 0 ? 'Chưa hiệu chuẩn' : 'Vừa hiệu chuẩn') },
    });
    const labels = w.findAll('[data-key]').map((e) => e.attributes('aria-label'));
    expect(labels).toEqual(['K0 · Chưa hiệu chuẩn', 'K1 · Vừa hiệu chuẩn']);
    expect(w.find('.cap__badge').exists()).toBe(false);
    w.unmount();
  });

  it('Escape keydown on a textarea does not clear the selection store', () => {
    const sel = useSelectionStore();
    sel.select(0);
    expect(sel.ids).toEqual([0]);

    const w = mount(KeyboardView, {
      props: { keys: [key(0, 0), key(1, 1)], selectable: true },
      attachTo: document.body,
    });

    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();

    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    textarea.dispatchEvent(ev);
    expect(sel.ids).toEqual([0]);

    const escBody = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    document.body.dispatchEvent(escBody);
    expect(sel.ids).toEqual([]);

    textarea.remove();
    w.unmount();
  });
});
