import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import AdvancedPage from '../src/pages/AdvancedPage.vue';
import type { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useAdvancedStore } from '../src/stores/advanced';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { t as tr } from '../src/i18n/vi';

describe('Advanced page: key-first entry', () => {
  let w: VueWrapper | null = null;
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function page(profile = 1) {
    setActivePinia(createPinia());
    clearTuningSnapshots();
    const device = useDeviceStore();
    await device.connectDemo();
    if (profile) await device.switchProfile(profile);
    const adv = useAdvancedStore();
    await adv.load();
    const sel = useSelectionStore();
    const id = (name: string) => device.keys.find((k) => k.name === name)!.id;
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(AdvancedPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return { w, device, adv, sel, id, mock: device.transport as MockTransport };
  }

  it('shows the panel with 4 buttons for one key without an advanced key', async () => {
    const { w, sel, id } = await page();
    expect(w.find('.addkey').exists()).toBe(false);
    sel.selectMany([id('W')]);
    await flushPromises();
    const panel = w.find('.addkey');
    expect(panel.text()).toContain(tr('advanced.addForKey', { key: 'W' }));
    const btns = panel.findAll('button');
    expect(btns.map((b) => b.text())).toEqual(['+ DKS', '+ MPT', '+ SOCD', '+ RS']);
    expect(btns[0].attributes('aria-label')).toBe(tr('advanced.addTypeForKey', { type: 'DKS', key: 'W' }));
  });

  it('+ DKS opens the DKS editor with W as host and writes nothing', async () => {
    const { w, sel, id, mock } = await page();
    const writes = vi.spyOn(mock, 'setDks');
    const clear = vi.spyOn(mock, 'clearAdvanced');
    sel.selectMany([id('W')]);
    await flushPromises();
    await w.find('[data-add="DKS"]').trigger('click');
    await flushPromises();
    expect(w.find('.ed__title').text()).toContain('Dynamic Keystroke');
    expect(w.find('.ed__host b').text()).toBe('W');
    expect(w.find('.addkey').exists()).toBe(false); // an open editor hides the panel
    expect(writes).not.toHaveBeenCalled();
    expect(clear).not.toHaveBeenCalled();
  });

  it('+ SOCD puts W in slot A, leaves B empty and asks for B', async () => {
    const { w, sel, id, mock } = await page(0);
    const writes = vi.spyOn(mock, 'setSocdPair');
    sel.selectMany([id('W')]);
    await flushPromises();
    await w.find('[data-add="SOCD"]').trigger('click');
    await flushPromises();
    expect(w.find('.ed__title').text()).toContain('SOCD');
    expect(w.find('.ed__hint').text()).toContain(tr('advanced.pickPairB'));
    const slots = w.findAll('.side__select');
    expect(slots).toHaveLength(2);
    expect(slots[0].attributes('aria-label')).toBe(`${tr('advanced.keyA')}: W`);
    expect(slots[1].attributes('aria-label')).toBe(`${tr('advanced.keyB')}: ${tr('advanced.notChosen')}`);
    expect(slots[0].attributes('aria-pressed')).toBe('false');
    expect(slots[1].attributes('aria-pressed')).toBe('true');
    expect(writes).not.toHaveBeenCalled();
  });

  it('a key that already has an entry shows no panel and its entry is highlighted', async () => {
    const { w, sel, id } = await page(1);
    sel.selectMany([id('A')]);
    await flushPromises();
    expect(w.find('.addkey').exists()).toBe(false);
    expect(w.find('.item').classes()).toContain('item--hl');
  });

  /** A page inside a `.main__scroll` (0–768) whose list box scrolls like a real one: the scroll clamps to the real maximum. */
  async function scrolled(box: { top: number; bottom: number; rows: number; rowH: number }) {
    const ctx = await page(1);
    const main = document.createElement('div');
    main.className = 'main__scroll';
    document.body.append(main);
    main.append(ctx.w.element);
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
    const el = ctx.w.find('.cfg').element as HTMLElement;
    const max = box.rows * box.rowH - (box.bottom - box.top);
    let scroll = 0;
    Object.defineProperty(el, 'scrollHeight', { get: () => box.rows * box.rowH, configurable: true });
    Object.defineProperty(el, 'clientHeight', { get: () => box.bottom - box.top, configurable: true });
    Object.defineProperty(el, 'scrollTop', { get: () => scroll, set: (v: number) => { scroll = Math.max(0, Math.min(v, el.scrollHeight - el.clientHeight)); }, configurable: true });
    main.getBoundingClientRect = () => rect(0, 768);
    el.getBoundingClientRect = () => rect(box.top, box.bottom);
    const items = ctx.w.findAll('.item');
    // The list's rows end at the content's end (box.rows rows), and move with the box's scroll.
    const first = box.top + (box.rows - items.length) * box.rowH;
    items.forEach((it, i) => {
      (it.element as HTMLElement).getBoundingClientRect = () => rect(first + i * box.rowH - scroll, first + (i + 1) * box.rowH - scroll);
    });
    return { ...ctx, main, scroll: () => scroll, max, lastBottom: () => first + items.length * box.rowH - scroll, last: ctx.adv.assignments[ctx.adv.assignments.length - 1] };
  }

  it('the LAST entry of a capped card is scrolled fully on screen, and the page does not scroll', async () => {
    // Card capped at 272 (1366×768): the box ends above the fold, 561–720.
    const { sel, main, scroll, lastBottom, last } = await scrolled({ top: 561, bottom: 720, rows: 12, rowH: 70 });
    sel.selectMany([last.keys[0]]);
    await flushPromises();
    expect(scroll()).toBeGreaterThan(0);
    expect(lastBottom()).toBeLessThanOrEqual(720); // inside the box, so on screen (< 768)
    expect(main.scrollTop).toBe(0);
  });

  it('a box that still runs past the fold: the scroll clips as far as it can', async () => {
    // Box 561–1009 on a 0–768 scroller: the last entry cannot be reached by the box alone; it ends up at the maximum scroll.
    const { sel, scroll, max, last } = await scrolled({ top: 561, bottom: 1009, rows: 12, rowH: 70 });
    sel.selectMany([last.keys[0]]);
    await flushPromises();
    expect(scroll()).toBe(max);
  });

  it('two columns: the card gets an inline max-height from the scroller height and its own top; one column has none', async () => {
    const cbs: Array<() => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (e: unknown[]) => void) { cbs.push(() => cb([{ contentRect: { width: 900 } }])); }
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal('innerWidth', 1366);
    const main = document.createElement('div');
    main.className = 'main__scroll';
    document.body.append(main);
    Object.defineProperty(main, 'clientHeight', { get: () => 768, configurable: true });
    const real = HTMLElement.prototype.getBoundingClientRect;
    const rect = (top: number, bottom: number) => ({ top, bottom, left: 0, right: 100, width: 100, height: bottom - top, x: 0, y: top, toJSON() {} }) as DOMRect;
    let cardTop = 480;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this === main) return rect(0, 768);
      if (this.classList.contains('card') && this.previousElementSibling !== null) return rect(cardTop, cardTop + 520);
      return real.call(this);
    });
    setActivePinia(createPinia());
    clearTuningSnapshots();
    const device = useDeviceStore();
    await device.connectDemo();
    await device.switchProfile(1);
    await useAdvancedStore().load();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(AdvancedPage, { global: { plugins: [router] }, attachTo: main });
    await flushPromises();
    const card = w.findAll('.cols > .card')[1].element as HTMLElement; // the configured card, right column
    expect(card.style.maxHeight).toBe('272px');
    // The page scrolled by 100: the card's top on screen moved, its top in content coordinates did not.
    main.scrollTop = 100;
    cardTop = 380;
    cbs.forEach((cb) => cb());
    expect(card.style.maxHeight).toBe('272px');
    // A narrower window (one column): the inline cap goes away.
    vi.stubGlobal('innerWidth', 900);
    cbs.forEach((cb) => cb());
    expect(card.style.maxHeight).toBe('');
    main.remove();
  });

  it('the panel stays outside the scrolling list box', async () => {
    const { w, sel, id } = await page(0);
    sel.selectMany([id('W')]);
    await flushPromises();
    const cfg = w.find('.cfg');
    cfg.element.scrollTop = 9999;
    await cfg.trigger('scroll');
    sel.selectMany([id('S')]);
    await flushPromises();
    expect(w.find('.addkey').exists()).toBe(true);
    expect(cfg.element.contains(w.find('.addkey').element)).toBe(false);
    expect(w.find('.addkey').element.parentElement).toBe(cfg.element.parentElement);
  });

  it('Fn cannot host DKS or MPT: those chips are disabled with the reason, SOCD and RS stay on', async () => {
    const { w, sel, id, device } = await page(0);
    sel.selectMany([id('Fn')]);
    await flushPromises();
    const chip = (t: string) => w.find(`[data-add="${t}"]`);
    expect(chip('DKS').attributes('disabled')).toBeDefined();
    expect(chip('DKS').attributes('title')).toBe(tr('advanced.hostIneligible', { type: tr('advanced.typeDKS') }));
    expect(chip('MPT').attributes('disabled')).toBeDefined();
    expect(chip('MPT').attributes('title')).toBe(tr('advanced.hostIneligible', { type: tr('advanced.typeMPT') }));
    expect(chip('SOCD').attributes('disabled')).toBeUndefined();
    expect(chip('RS').attributes('disabled')).toBeUndefined();
    const why = w.find('.addkey__why');
    const fn = id('Fn');
    expect(why.text()).toBe(tr('advanced.cannotHost', { key: device.legend(device.keys[fn]), types: `DKS ${tr('advanced.listLast')} MPT` }));
    expect(chip('DKS').attributes('aria-describedby')).toBe(why.attributes('id'));
    expect(chip('MPT').attributes('aria-describedby')).toBe(why.attributes('id'));
    expect(chip('SOCD').attributes('aria-describedby')).toBeUndefined();
    sel.selectMany([id('W')]);
    await flushPromises();
    expect(w.find('.addkey__why').exists()).toBe(false);
    expect(chip('DKS').attributes('disabled')).toBeUndefined();
    expect(chip('DKS').attributes('title')).toBeUndefined();
  });

  it('two keys selected: no panel', async () => {
    const { w, sel, id } = await page(0);
    sel.selectMany([id('W'), id('S')]);
    await flushPromises();
    expect(w.find('.addkey').exists()).toBe(false);
  });
});
