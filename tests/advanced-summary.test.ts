import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { mountPerformance } from './mountPerformance';
import type { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useAdvancedStore } from '../src/stores/advanced';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { t as tr } from '../src/i18n/vi';

describe('Advanced page: the picked key\'s entry summarised in the selection bar', () => {
  let w: VueWrapper | null = null;
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function page() {
    setActivePinia(createPinia());
    clearTuningSnapshots();
    const device = useDeviceStore();
    await device.connectDemo();
    await device.switchProfile(1);
    const adv = useAdvancedStore();
    await adv.load();
    const sel = useSelectionStore();
    const mock = device.transport as MockTransport;
    const writes = [
      vi.spyOn(mock, 'setDks'), vi.spyOn(mock, 'setSocdPair'), vi.spyOn(mock, 'clearAdvanced'),
    ];
    ({ w } = await mountPerformance('advanced'));
    await flushPromises();
    const noWrites = () => writes.forEach((s) => expect(s).not.toHaveBeenCalled());
    return { w, device, adv, sel, noWrites };
  }
  const hint = (w: VueWrapper) => w.find('.sb__hint');
  /** The keycap legend (DESIGN B §3.4); a one-key summary takes its place in the bar's detail slot. */
  const shows = (w: VueWrapper) => w.find('.sb__shows');

  it('one key with an entry: summary text and a Sửa button that opens its editor', async () => {
    const { w, adv, sel, noWrites } = await page();
    const a = adv.assignments.find((x) => x.type === 'SOCD')!;
    sel.selectMany([a.keys[0]]);
    await flushPromises();
    const text = w.find('.sum__text');
    const keys = a.keys.map((id) => useDeviceStore().legend(useDeviceStore().keys[id])).join(' ↔ ');
    expect(text.text()).toMatch(new RegExp(`^SOCD ${keys} · .+ · .+ ms$`));
    expect(text.attributes('title')).toBe(text.text());
    expect(text.attributes('aria-live')).toBeUndefined();
    const live = w.find('.sr-only[aria-live="polite"]');
    expect(live.text()).toBe(text.text()); // persistent region, present before the summary was
    expect(shows(w).classes()).toContain('sb__shows--off'); // the summary stands where the keycap legend was (kept hidden for measuring)
    expect(w.find('.sb__detail .sum').exists()).toBe(true);
    expect(hint(w).text()).toBe(tr('sel.hint')); // the how-to-select line stays (inline or in the (i))
    const btn = w.find('.sum button');
    expect(btn.text()).toBe(tr('advanced.edit'));
    expect(btn.attributes('aria-label')).toBe(tr('advanced.editEntry', { type: 'SOCD', keys }));
    await btn.trigger('click');
    await flushPromises();
    expect(w.find('.ed__title').text()).toContain('SOCD');
    expect(w.find('.sum').exists()).toBe(false); // editor open: the keycap legend is back
    expect(shows(w).text()).toContain(tr('advanced.shows'));
    expect(hint(w).text()).toBe(tr('sel.hint'));
    noWrites();
  });

  it('two keys picked: the hint', async () => {
    const { w, adv, sel, noWrites } = await page();
    const a = adv.assignments.find((x) => x.type === 'SOCD')!;
    sel.selectMany([a.keys[0], a.keys[1]]);
    await flushPromises();
    expect(w.find('.sum').exists()).toBe(false);
    expect(shows(w).text()).toContain(tr('advanced.shows'));
    expect(hint(w).text()).toBe(tr('sel.hint'));
    expect(w.find('.sr-only[aria-live="polite"]').exists()).toBe(true); // the live region stays, empty
    expect(w.find('.sr-only[aria-live="polite"]').text()).toBe('');
    noWrites();
  });

  it('editing a one-key entry (DKS): no summary and no Sửa in the bar while the editor is open', async () => {
    const { w, adv, device, sel, noWrites } = await page();
    const free = device.keys.find((k) => !adv.byKey.has(k.id))!;
    adv.records = { ...adv.records, [free.id]: { mode: 1, row: free.row, col: free.col, type: 'DKS', keycodes: [0x04, 0x2c, 0, 0], travels: [0xff, 0x01, 0, 0], deadzones: [1.2, 2.8] } };
    const a = adv.byKey.get(free.id)!;
    expect(a.type).toBe('DKS');
    sel.selectMany([free.id]);
    await flushPromises();
    await w.find('.sum button').trigger('click');
    await flushPromises();
    expect(sel.ids).toEqual([a.keys[0]]); // still the one key
    expect(w.find('.sum').exists()).toBe(false);
    expect(w.find('.sr-only[aria-live="polite"]').text()).toBe('');
    noWrites();
  });

  it('a key without an entry: the hint and the add panel', async () => {
    const { w, adv, device, sel, noWrites } = await page();
    const free = device.keys.find((k) => !adv.byKey.has(k.id))!;
    sel.selectMany([free.id]);
    await flushPromises();
    expect(w.find('.sum').exists()).toBe(false);
    expect(hint(w).text()).toBe(tr('sel.hint'));
    expect(w.find('.addkey').exists()).toBe(true);
    noWrites();
  });

  it('a read-only entry: no button, and the read-only suffix', async () => {
    const { w, adv, device, sel, noWrites } = await page();
    const free = device.keys.find((k) => !adv.byKey.has(k.id))!;
    adv.records = { ...adv.records, [free.id]: { mode: 3, row: free.row, col: free.col, type: 'MT', keycodes: [4, 5], time: 200 } };
    sel.selectMany([free.id]);
    await flushPromises();
    const text = w.find('.sum__text');
    expect(text.text()).toMatch(new RegExp(` · ${tr('advanced.readOnlySuffix')}$`));
    expect(text.text()).toMatch(/^MT /);
    expect(w.find('.sum button').exists()).toBe(false);
    noWrites();
  });
});
