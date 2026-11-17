// DESIGN TIP §3 and §5: a tooltip bubble stays inside what the user can see. jsdom has no layout, so the trigger, the
// bubble and a clipping ancestor get stubbed rectangles; the bubble's width follows its text and its inline max-width.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { readFileSync } from 'node:fs';
import Tooltip from '../src/components/ui/Tooltip.vue';

interface Rect { left: number; top: number; width: number; height: number }
interface Scene {
  vw: number;
  vh: number;
  trigger: Rect;
  /** The bubble's natural size for a text (before any max-width). */
  bubble: (text: string) => { w: number; h: number };
  /** The ancestor `.clip`; it clips only when the test gives it an overflow. */
  clip: Rect;
}

let scene: Scene;
let w: VueWrapper | null = null;

const domRect = (r: Rect) => ({ ...r, x: r.left, y: r.top, right: r.left + r.width, bottom: r.top + r.height, toJSON() {} }) as DOMRect;
/** A trigger 22 px square whose centre is at (cx, cy). */
const at = (cx: number, cy = 400): Rect => ({ left: cx - 11, top: cy - 11, width: 22, height: 22 });

beforeEach(() => {
  scene = { vw: 1366, vh: 900, trigger: at(600), bubble: (t) => ({ w: Math.min(t.length * 6, 400), h: 40 }), clip: { left: 0, top: 0, width: 1366, height: 900 } };
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, get: () => scene.vw });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, get: () => scene.vh });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('tip')) return domRect(scene.trigger);
    if (this.classList.contains('clip')) return domRect(scene.clip);
    if (this.classList.contains('tip__bubble')) {
      const max = parseFloat(this.style.maxWidth) || 260; // the CSS max-width, or the inline one
      const n = scene.bubble(this.textContent ?? '');
      const width = Math.min(n.w, max);
      return domRect({ left: 0, top: 0, width, height: n.h * Math.ceil(n.w / width) });
    }
    return domRect({ left: 0, top: 0, width: 0, height: 0 });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (document.documentElement as unknown as Record<string, unknown>).clientWidth;
  delete (document.documentElement as unknown as Record<string, unknown>).clientHeight;
});

const text = ref('');
function mountTip(o: { text?: string; placement?: 'top' | 'bottom'; clips?: boolean; transition?: boolean } = {}) {
  text.value = o.text ?? 'x'.repeat(50); // 300 px natural, so 260 wide
  const Host = defineComponent({
    setup: () => () => h('div', { class: 'clip', style: o.clips ? 'overflow-x: hidden' : '' }, [
      h(Tooltip, { text: text.value, placement: o.placement ?? 'top' }, () => h('button', { class: 'trg' }, 'i')),
    ]),
  });
  w = mount(Host, { attachTo: document.body, global: { stubs: o.transition ? { transition: false } : {} } });
  const clip = w.get('.clip').element as HTMLElement;
  Object.defineProperty(clip, 'clientWidth', { configurable: true, get: () => scene.clip.width });
  Object.defineProperty(clip, 'clientHeight', { configurable: true, get: () => scene.clip.height });
}
/** Opens the bubble the way a user does (focus, then the 350 ms delay) and lets the DOM update once. */
async function open() {
  await w!.get('.tip').trigger('focusin');
  vi.advanceTimersByTime(350);
  await nextTick();
}
async function close() {
  await w!.get('.tip').trigger('focusout');
  await nextTick();
}
const bubbleEl = () => w!.find('.tip__bubble').element as HTMLElement;
const dx = () => parseFloat(bubbleEl().style.getPropertyValue('--tip-dx'));
const side = () => (bubbleEl().classList.contains('tip__bubble--bottom') ? 'bottom' : 'top');
const maxW = () => bubbleEl().style.maxWidth;
/** The bubble's left and right edges on screen: centred on the trigger, then moved by dx. */
const edges = () => {
  const t = scene.trigger;
  const b = bubbleEl().getBoundingClientRect();
  const left = t.left + t.width / 2 - b.width / 2 + dx();
  return { left, right: left + b.width };
};

describe('TIP: sideways', () => {
  it('a bubble that fits stays centred, on the asked side', async () => {
    mountTip();
    await open();
    expect(dx()).toBe(0);
    expect(side()).toBe('top');
  });

  it('a bubble 74 px past the right edge moves in until its right edge is 8 px inside', async () => {
    scene.trigger = at(1310); // centred: 1180 … 1440, 74 px past 1366
    mountTip();
    await open();
    expect(edges().right).toBe(1366 - 8);
    expect(dx()).toBe(-82);
  });

  it('a bubble past the left edge moves in until its left edge is 8 px inside', async () => {
    scene.trigger = at(50); // centred: −80 … 180
    mountTip();
    await open();
    expect(edges().left).toBe(8);
    expect(dx()).toBe(88);
  });

  it('a clipping ancestor (left at 248, narrower than the viewport) bounds the bubble, not the viewport', async () => {
    scene.clip = { left: 248, top: 0, width: 900, height: 900 };
    scene.trigger = at(260); // centred: 130 … 390, inside the viewport but 118 px left of the ancestor
    mountTip({ clips: true });
    await open();
    expect(edges().left).toBe(248 + 8);
    scene.trigger = at(1140); // centred: 1010 … 1270; the ancestor ends at 1148
    await close();
    await open();
    expect(edges().right).toBe(1148 - 8);
  });
});

describe('TIP: up or down', () => {
  it('no room on the asked side and room on the other: the other side', async () => {
    scene.trigger = at(600, 30); // above: 19 − 16 = 3 px of room for a 40 px bubble
    mountTip({ placement: 'top' });
    await open();
    expect(side()).toBe('bottom');
  });

  it('no room on either side: the asked side', async () => {
    scene.vh = 100;
    scene.trigger = at(600, 45); // above: 34 − 16 = 18; below: 100 − 8 − 64 = 28
    mountTip({ placement: 'top' });
    await open();
    expect(side()).toBe('top');
  });

  it('room on the asked side: the asked side, even when the other side has more room', async () => {
    scene.trigger = at(600, 140); // above: 129 − 16 = 113 for an 80 px bubble (two lines); below: about 740
    mountTip({ placement: 'top' });
    await open();
    expect(side()).toBe('top');
    await close();
    scene.trigger = at(600, 760); // below: 900 − 8 − 779 = 113; above: about 740
    w!.unmount();
    mountTip({ placement: 'bottom' });
    await open();
    expect(side()).toBe('bottom');
  });

  it('6b, the boundary: room above counts the 8 px gap and the 8 px edge (40 px bubble: 34 px of room flips, 40 stays)', async () => {
    const short = 'x'.repeat(40); // 240 px wide, one 40 px line
    scene.trigger = at(600, 61); // top 50: above = 50 − 8 − 8 = 34 < 40; below has room
    mountTip({ placement: 'top', text: short });
    await open();
    expect(side()).toBe('bottom');
    w!.unmount();
    scene.trigger = at(600, 67); // top 56: above = 56 − 8 − 8 = 40, just enough
    mountTip({ placement: 'top', text: short });
    await open();
    expect(side()).toBe('top');
  });
});

describe('TIP: a narrow box, reset and order', () => {
  it('a 200 px box gives a max width of 184', async () => {
    scene.clip = { left: 0, top: 0, width: 200, height: 900 };
    scene.trigger = at(100);
    mountTip({ clips: true });
    await open();
    expect(maxW()).toBe('184px');
    expect(edges().left).toBeGreaterThanOrEqual(8);
    expect(edges().right).toBeLessThanOrEqual(192);
  });

  it('the shift is worked out from the width the bubble has after the max width is on it', async () => {
    scene.clip = { left: 0, top: 0, width: 200, height: 900 };
    scene.trigger = at(180); // 184 wide: 88 … 272 → moved to 8 … 192 (dx −80); measured at 260 it would be dx −118
    mountTip({ clips: true });
    await open();
    expect(maxW()).toBe('184px');
    expect(dx()).toBe(-80);
  });

  it('nothing carries over: narrow, close, then wide gives no max width and a fresh shift and side', async () => {
    scene.clip = { left: 0, top: 0, width: 200, height: 900 };
    scene.trigger = at(180, 30);
    mountTip({ clips: true });
    await open();
    expect([maxW(), dx(), side()]).toEqual(['184px', -80, 'bottom']);
    await close();
    scene.clip = { left: 0, top: 0, width: 1366, height: 900 };
    scene.trigger = at(600, 400);
    await open();
    expect([maxW(), dx(), side()]).toEqual(['', 0, 'top']);
  });
});

describe('TIP: when it is measured', () => {
  it('the shift is on the bubble in the first DOM update after it opens, not a frame later', async () => {
    scene.trigger = at(1310);
    mountTip({ transition: true });
    await w!.get('.tip').trigger('focusin');
    vi.advanceTimersByTime(350);
    await nextTick();
    expect(bubbleEl().classList.contains('tip-enter-from')).toBe(true); // still before the fade-in starts
    expect(dx()).toBe(-82);
  });

  it('a text that changes while open is measured again: a short text near the right edge becomes a long one', async () => {
    scene.trigger = at(1340);
    mountTip({ text: 'ok' }); // 12 px wide: fits, no shift
    await open();
    expect(dx()).toBe(0);
    text.value = 'x'.repeat(50); // 260 px wide: 1210 … 1470
    await nextTick();
    await nextTick();
    expect(edges().right).toBe(1366 - 8);
  });

  it('while leaving, the bubble keeps its shift (no slide out), and the leave rule carries it', async () => {
    scene.trigger = at(1310);
    mountTip({ transition: true });
    await open();
    expect(dx()).toBe(-82);
    await w!.get('.tip').trigger('focusout');
    await nextTick();
    const el = w!.find('.tip__bubble');
    expect(el.exists()).toBe(true); // leaving: still in the DOM
    expect(el.classes()).toContain('tip-leave-active');
    expect(parseFloat((el.element as HTMLElement).style.getPropertyValue('--tip-dx'))).toBe(-82);
    const css = readFileSync('src/components/ui/Tooltip.vue', 'utf8').replace(/\s+/g, ' ');
    expect(css).toMatch(/\.tip-enter-from, \.tip-leave-to \{[^}]*transform: translate\(calc\(-50% \+ var\(--tip-dx, 0px\)\), 3px\)/);
    expect(css).toMatch(/\.tip__bubble \{[^}]*transform: translateX\(calc\(-50% \+ var\(--tip-dx, 0px\)\)\)/);
  });
});
