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
    const { w, sel, id } = await page(0);
    sel.selectMany([id('Fn')]);
    await flushPromises();
    const chip = (t: string) => w.find(`[data-add="${t}"]`);
    expect(chip('DKS').attributes('disabled')).toBeDefined();
    expect(chip('DKS').attributes('title')).toBe(tr('advanced.hostIneligible', { type: tr('advanced.typeDKS') }));
    expect(chip('MPT').attributes('disabled')).toBeDefined();
    expect(chip('MPT').attributes('title')).toBe(tr('advanced.hostIneligible', { type: tr('advanced.typeMPT') }));
    expect(chip('SOCD').attributes('disabled')).toBeUndefined();
    expect(chip('RS').attributes('disabled')).toBeUndefined();
    sel.selectMany([id('W')]);
    await flushPromises();
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
