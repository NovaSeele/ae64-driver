// Part B (DESIGN B §11.7): quick-select groups by what each key does on the Main layer, replace / add, the empty group,
// the bar's layout choice, and each page's keycap legend. Selecting is UI state only: no button talks to the keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import type { MockTransport, PerfMode } from '../src/protocol';
import { keyGroups } from '../src/data/keyGroups';
import { FIT_CLASSES, pickFit } from '../src/components/keyboard/selectionFit';
import type { FitInput } from '../src/components/keyboard/selectionFit';
import SelectionBar from '../src/components/keyboard/SelectionBar.vue';
import { GLOW_BADGE_TONE } from '../src/components/keyboard/Keycap.vue';
import PerformancePage from '../src/pages/PerformancePage.vue';
import SwitchPage from '../src/pages/SwitchPage.vue';
import LightingPage from '../src/pages/LightingPage.vue';
import KeymapPage from '../src/pages/KeymapPage.vue';
import AdvancedPage from '../src/pages/AdvancedPage.vue';
import GamepadPage from '../src/pages/GamepadPage.vue';
import PageLayout from '../src/components/shell/PageLayout.vue';
import { useAdvancedStore } from '../src/stores/advanced';
import { useGamepadStore } from '../src/stores/gamepad';
import { useKeymapStore } from '../src/stores/keymap';
import { findSwitch } from '../src/protocol/switches';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { useLightingStore } from '../src/stores/lighting';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
// The mock board's Main layer (the user's board): letters on 15–24, 29–37, 42–48; 1–0 on 1–10; id 52 (the right-Shift
// position) is Delete and id 54 is PrintScreen, so the modifiers are 41, 55, 56, 57, 59, 60.
const LETTERS = [...range(15, 24), ...range(29, 37), ...range(42, 48)];
const DIGITS = range(1, 10);
const MODS = [41, 55, 56, 57, 59, 60];
const WASD = [16, 29, 30, 31];

let w: VueWrapper | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'vi';
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(async () => {
  w?.unmount();
  w = null;
  await flushPromises();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function demo(model: 'max' | 'pro' | 'pro-xinput' = 'max') {
  const device = useDeviceStore();
  await device.connectDemo(model);
  return device;
}
/** The Main layer with some keys changed (store only: nothing is written). */
function remap(device: ReturnType<typeof useDeviceStore>, changes: Record<number, number>) {
  const next = [...device.layer0];
  for (const [id, code] of Object.entries(changes)) next[Number(id)] = code;
  device.layer0 = next;
}

describe('keyGroups (§3.1)', () => {
  it('groups the mock Main layer by keycode, the same on Max and Pro', async () => {
    for (const model of ['max', 'pro'] as const) {
      setActivePinia(createPinia());
      const device = await demo(model);
      expect(device.layer0).toHaveLength(device.keys.length);
      const g = keyGroups(device.keys, device.layer0);
      expect(g.source).toBe('keymap');
      expect(g.letters).toEqual(LETTERS);
      expect(g.letters).toHaveLength(26);
      expect(g.digits).toEqual(DIGITS);
      expect(g.mods).toEqual(MODS);
      expect(g.wasd).toEqual(WASD);
      for (const id of [52, 54]) expect([...g.letters, ...g.digits, ...g.mods, ...g.wasd]).not.toContain(id);
    }
  });

  it('falls back to the physical names while the keymap is unread (layer0 = [])', () => {
    const g = keyGroups(PHYSICAL_KEYS, []);
    expect(g.source).toBe('position');
    expect(g.letters).toHaveLength(26);
    expect(g.digits).toEqual(DIGITS);
    expect(g.mods).toEqual([41, 52, 55, 56, 57, 59, 60]); // both Shifts by position, Del is not one
    expect(g.wasd).toEqual(WASD);
    // a Main layer of the wrong length is not trusted either
    expect(keyGroups(PHYSICAL_KEYS, [0x04]).source).toBe('position');
  });

  it('follows a remapped Main layer', async () => {
    const device = await demo();
    remap(device, { 52: 0xe5, 1: 0x3a, 17: 0x1a }); // id 52 → Right Shift, id 1 → F1, id 17 (E) → W
    const g = keyGroups(device.keys, device.layer0);
    expect(g.mods).toEqual([41, 52, 55, 56, 57, 59, 60]);
    expect(g.digits).toEqual(range(2, 10));
    expect(g.wasd).toEqual([16, 17, 29, 30, 31]); // the W keys first (by id), then A, S, D
    expect(g.letters).toContain(17);
  });

  it('WASD is ordered W, A, S, D by function, not by id: W anchors the next Shift-click', async () => {
    const device = await demo();
    remap(device, { 40: 0x1a, 16: 0x05 }); // W moves to id 40, above A (29), S (30) and D (31); the old W is B
    expect(keyGroups(device.keys, device.layer0).wasd).toEqual([40, 29, 30, 31]);
    const sel = useSelectionStore();
    sel.wasd();
    expect(sel.ids).toEqual([29, 30, 31, 40]);
    expect(sel.focused).toBe(40);
  });

  it('Fn1–Fn3 layer keys count as modifiers', async () => {
    const device = await demo();
    remap(device, { 54: 0xf101, 52: 0xf103 });
    expect(keyGroups(device.keys, device.layer0).mods).toEqual([41, 52, 54, 55, 56, 57, 59, 60]);
    remap(device, { 54: 0xf104 });
    expect(keyGroups(device.keys, device.layer0).mods).not.toContain(54);
    // the ends of the HID modifier range: Left Ctrl 0xE0 and Right GUI 0xE7 count, 0xDF and 0xE8 do not
    remap(device, { 52: 0xe0, 54: 0xe7 });
    expect(keyGroups(device.keys, device.layer0).mods).toEqual([41, 52, 54, 55, 56, 57, 59, 60]);
    remap(device, { 52: 0xdf, 54: 0xe8 });
    expect(keyGroups(device.keys, device.layer0).mods).toEqual(MODS);
  });

  it('the selection store recomputes its groups when layer0 changes', async () => {
    const device = await demo();
    const sel = useSelectionStore();
    expect(sel.groups.digits).toEqual(DIGITS);
    remap(device, Object.fromEntries(DIGITS.map((id, i) => [id, 0x3a + i]))); // every digit key → F1…F10
    expect(sel.groups.digits).toEqual([]);
    device.layer0 = [];
    expect(sel.groups.source).toBe('position');
    expect(sel.groups.digits).toEqual(DIGITS);
  });
});

describe('selection store: replace and add (§5)', () => {
  it('replace makes the selection exactly the group; add is the union; an empty group changes nothing', async () => {
    const device = await demo();
    const sel = useSelectionStore();
    sel.selectMany([5, 52]);
    sel.wasd();
    expect(sel.ids).toEqual(WASD);
    sel.wasd(); // pressing it again does not toggle
    expect(sel.ids).toEqual(WASD);
    sel.digits('add');
    expect(sel.ids).toEqual([...DIGITS, ...WASD].sort((a, b) => a - b));
    sel.modifiers('replace');
    expect(sel.ids).toEqual(MODS);
    expect(sel.focused).toBe(MODS[0]); // the group's first key anchors the next Shift-click
    sel.letters('add');
    expect(sel.ids).toEqual([...LETTERS, ...MODS].sort((a, b) => a - b));
    expect(sel.focused).toBe(LETTERS[0]);
    remap(device, Object.fromEntries(DIGITS.map((id) => [id, 0x3a])));
    const before = [...sel.ids];
    sel.digits();
    sel.digits('add');
    expect(sel.ids).toEqual(before);
  });
});

describe('SelectionBar quick-select buttons', () => {
  async function bar() {
    const device = await demo();
    const mock = device.transport as MockTransport;
    // every command of the transport goes through exchange(): selecting keys must never reach it
    const exchange = vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> }, 'exchange');
    w = mount(SelectionBar, { attachTo: document.body });
    await flushPromises();
    const sel = useSelectionStore();
    const btn = (g: string) => w!.find(`[data-group="${g}"]`);
    const desc = (g: string) => document.getElementById(btn(g).attributes('aria-describedby')!)!.textContent;
    return { device, sel, btn, desc, exchange };
  }

  it('tooltips count the real group sizes: 26 / 10 / 6 / 4', async () => {
    const { btn, desc } = await bar();
    expect(desc('letters')).toBe(`${tr('sel.tipLetters', { n: 26 })} ${tr('sel.addHint')}`);
    expect(desc('digits')).toBe(`${tr('sel.tipDigits', { n: 10 })} ${tr('sel.addHint')}`);
    expect(desc('mods')).toBe(`${tr('sel.tipMods', { n: 6 })} ${tr('sel.addHint')}`);
    expect(desc('wasd')).toBe(`${tr('sel.tipWasd', { n: 4 })} ${tr('sel.addHint')}`);
    for (const g of ['letters', 'digits', 'mods', 'wasd']) {
      expect(btn(g).attributes('aria-disabled')).toBeUndefined();
      expect(btn(g).attributes('aria-pressed')).toBeUndefined(); // not a toggle
    }
  });

  it('uses the position tooltips while the keymap is unread', async () => {
    const { device, desc } = await bar();
    device.layer0 = [];
    await flushPromises();
    expect(desc('mods')).toBe(`${tr('sel.tipModsPos', { n: 7 })} ${tr('sel.addHint')}`);
  });

  it('click replaces; Ctrl / ⌘ / Shift click adds; Enter replaces and Shift+Enter adds; nothing is sent', async () => {
    const { sel, btn, exchange } = await bar();
    sel.selectMany([5]);
    await btn('wasd').trigger('click');
    expect(sel.ids).toEqual(WASD);
    for (const mod of ['ctrlKey', 'metaKey', 'shiftKey'] as const) {
      sel.selectMany([5]);
      await btn('wasd').trigger('click', { [mod]: true });
      expect(sel.ids, mod).toEqual([5, ...WASD]);
    }
    sel.selectMany([5]);
    await btn('mods').trigger('keydown', { key: 'Enter' });
    expect(sel.ids).toEqual(MODS);
    sel.selectMany([5]);
    await btn('mods').trigger('keydown', { key: 'Enter', shiftKey: true });
    expect(sel.ids).toEqual([5, ...MODS]);
    // the whole-board buttons too
    for (const b of w!.findAll('.sb__actions button')) await b.trigger('click');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('an empty group stays focusable, says why, and a click changes nothing', async () => {
    const { device, sel, btn, desc } = await bar();
    remap(device, Object.fromEntries(DIGITS.map((id, i) => [id, 0x3a + i])));
    await flushPromises();
    expect(btn('digits').attributes('aria-disabled')).toBe('true');
    expect(btn('digits').attributes('disabled')).toBeUndefined();
    expect(desc('digits')).toBe(tr('sel.groupEmpty'));
    sel.selectMany([5]);
    await btn('digits').trigger('click');
    await btn('digits').trigger('click', { shiftKey: true });
    await btn('digits').trigger('keydown', { key: 'Enter' });
    expect(sel.ids).toEqual([5]);
    expect(btn('letters').attributes('aria-disabled')).toBeUndefined();
  });

  it('the keycap legend: a screen reader reads one plain sentence; a detail slot takes its place', async () => {
    await demo();
    w = mount(SelectionBar, {
      props: { shows: [{ text: 'a' }, { glyph: 'RT', tone: 'var(--m-press)', text: 'b' }, { sample: 'flag', label: 'c', text: 'd' }] },
      attachTo: document.body,
    });
    await flushPromises();
    const plain = `${tr('sel.shows')}: a · RT = b · c = d`;
    expect(w.find('.sb__shows .sr-only').text()).toBe(plain);
    expect(w.find('.sb__shows').attributes('title')).toBe(plain);
    expect(w.find('.sb__shows .sb__g').attributes('style')).toContain('--tone: var(--m-press)');
    expect(w.find('.sb__flag').exists()).toBe(true);
    w.unmount();
    w = mount(SelectionBar, { props: { shows: [{ text: 'a' }], tip: 'T' }, slots: { detail: '<b class="d">x</b>' }, attachTo: document.body });
    await flushPromises();
    expect(w.find('.sb__shows').classes()).toContain('sb__shows--off'); // hidden, still measured for the row count
    expect(w.find('.sb__detail .d').exists()).toBe(true);
    expect(w.find('.sb__hint').text()).toBe(tr('sel.hint'));
  });
});

describe('pickFit (§3.3)', () => {
  // row(lead, middle) = lead + 12 + 1 + 12 + middle + 12 + actions; fit 1 adds 12 + hint and drops the (i)
  const base: FitInput = {
    bar: 0, lead: 200, leadCompact: 120, leadMax: 140, tip: 24, legend: 300, legendMax: 300, detail: 0, hint: 250, actions: 400, gap: 12,
  };
  const fit1 = 176 + 300 + 400 + 37 + 12 + 250; // 1175
  const fit2 = 200 + 300 + 400 + 37; // 937
  const oneRow = 140 + 300 + 400 + 37; // 877: the widest lead and the widest legend on one row
  it.each([
    [2000, 1], [fit1, 1], [fit1 - 1, 2], [fit2, 2], [fit2 - 1, 3], [oneRow, 3], [oneRow - 1, 4], [300, 4],
  ])('bar %i → fit %i', (bar, expected) => {
    expect(pickFit({ ...base, bar })).toBe(expected);
  });
  it('the row count does not depend on the selection: "all 64 keys" and "4 keys" give the same rows', () => {
    // compact lead 160 for "all 64 keys", 110 for "4 keys"; the widest (160) decides for both
    const all = { ...base, lead: 240, leadCompact: 160, leadMax: 160 };
    const four = { ...base, lead: 180, leadCompact: 110, leadMax: 160 };
    for (let bar = 700; bar <= 1300; bar += 1) {
      const rows = (f: FitInput) => (pickFit({ ...f, bar }) === 4 ? 2 : 1);
      expect(rows(four), `bar ${bar}`).toBe(rows(all));
    }
    expect(pickFit({ ...four, bar: 896 })).toBe(4); // 160 + 300 + 400 + 37 = 897
    expect(pickFit({ ...four, bar: 897 })).toBe(3);
    // a lead wider than the ghost's (should not happen) still counts
    expect(pickFit({ ...base, leadCompact: 200, leadMax: 140, bar: 936 })).toBe(4);
  });
  it('the widest legend the page can switch to decides the rows (a chip change keeps them)', () => {
    expect(pickFit({ ...base, legend: 250, legendMax: 300, bar: oneRow - 1 })).toBe(4);
    expect(pickFit({ ...base, legend: 300, legendMax: 300, bar: oneRow - 1 })).toBe(4);
    expect(pickFit({ ...base, legend: 250, legendMax: 300, bar: oneRow })).toBe(3);
  });
  it('a detail keeps the rows of the legend it replaces: one row shortens it, two rows put it on the second', () => {
    expect(pickFit({ ...base, detail: 600, bar: oneRow })).toBe(3); // too long for one row: ellipsis, not a new row
    expect(pickFit({ ...base, detail: 600, bar: oneRow - 1 })).toBe(4); // the bar was two rows already: it stays
    expect(pickFit({ ...base, detail: 100, bar: oneRow - 1 })).toBe(4); // even a short detail does not lift it to one
    expect(pickFit({ ...base, detail: 100, bar: 140 + 100 + 400 + 37 + 12 + 250 - 24 + 60 })).toBe(1);
    // the detail is measured, not the hidden legend, for fits 1–3
    expect(pickFit({ ...base, legend: 50, legendMax: 50, detail: 100, bar: 200 + 100 + 437 })).toBe(2);
    expect(pickFit({ ...base, legend: 50, legendMax: 50, detail: 100, bar: 200 + 100 + 437 - 1 })).toBe(3);
    // no legend at all (still loading): never two rows
    expect(pickFit({ ...base, legend: 0, legendMax: 0, detail: 900, bar: 500 })).toBe(3);
  });
  it('without a middle part there is no divider either', () => {
    const none = { ...base, legend: 0, legendMax: 0 };
    expect(pickFit({ ...none, bar: 200 + 12 + 400 })).toBe(2);
    expect(pickFit({ ...none, bar: 200 + 12 + 400 - 1 })).toBe(3);
  });
  it('the layouts set the right classes; only fit 4 stacks', () => {
    expect(FIT_CLASSES).toEqual({ 1: ['sb--hint'], 2: [], 3: ['sb--compact'], 4: ['sb--compact', 'sb--stack'] });
  });
});

describe('the keycap legend of each page (§3.4)', () => {
  const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  const legend = () => w!.find('.sb__shows .sr-only').text();

  it('Performance: follows the chip; RT / — / lock / flag appear only when some key has them', async () => {
    const device = await demo();
    const perf = usePerformanceStore();
    await perf.load();
    const all = device.keys.map((k) => k.id);
    const setModes = (mode: (id: number) => PerfMode) => {
      perf.values = Object.fromEntries(all.map((id) => [id, { ...perf.values[id], mode: mode(id) }]));
    };
    setModes(() => 0);
    perf.uncalibrated = [];
    w = mount(PerformancePage, { global: { plugins: [router()], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    const chip = async (i: number) => { await w!.findAll('.chip')[i].trigger('click'); await flushPromises(); };
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('perf.showsAct')}`);
    expect(w.find('.sb__shows .sb__t').attributes('style')).toContain('--tone: var(--m-actuation)');
    setModes((id) => (id === 5 ? 1 : 0));
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('perf.showsAct')} · RT = ${tr('perf.showsRtTag')}`);
    await chip(1);
    expect(legend()).toBe(`${tr('sel.shows')}: ↓ = ${tr('perf.showsRtPress')} · ↑ = ${tr('perf.showsRtRelease')} · — = ${tr('perf.showsRtOff')}`);
    setModes(() => 2);
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ↓ = ${tr('perf.showsRtPress')} · ↑ = ${tr('perf.showsRtRelease')}`);
    await chip(2);
    expect(legend()).toBe(`${tr('sel.shows')}: ↑ = ${tr('perf.showsDzTop')} · ↓ = ${tr('perf.showsDzBottom')}`);
    setModes((id) => (id === 5 ? (7 as PerfMode) : 0));
    perf.uncalibrated = [6];
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ↑ = ${tr('perf.showsDzTop')} · ↓ = ${tr('perf.showsDzBottom')} · ${tr('perf.showsLockedGlyph')} = ${tr('perf.showsLocked')} · ${tr('sel.flaggedGlyph')} = ${tr('sel.flagged')}`);
    expect(w.find('.sb__icon').attributes('style')).toContain('--tone: var(--m-deadzone)'); // the lock in the chip's tone
    // the scope sentence goes first in the (i); its optional parts drop out on a narrow bar
    expect(w.find('.scope__hint').classes()).toContain('sb__opt');
    useSelectionStore().selectMany([5]);
    await flushPromises();
    expect(w.find('.scope__names').classes()).toContain('sb__opt');
    // the (i): the scope sentence first, then how to select
    useSelectionStore().clear();
    await flushPromises();
    expect(w.find('.sb__tip').text()).toContain(tr('perf.scopeAllTip', { n: device.keys.length }));
    useSelectionStore().selectMany([5]);
    await flushPromises();
    expect(w.find('.sb__tip').text()).toContain(tr('perf.scopeSelTip'));
    expect(w.find('.sb__tip').text()).not.toContain(tr('perf.scopeAllTip', { n: device.keys.length }));
    // the widest lead the bar keeps room for is "all 64 keys", whatever is selected
    expect(w.find('.sb__ghost-lead').text()).toContain(tr('perf.scopeAll', { n: device.keys.length }));
    // the other chips' legends are measured too (one row count across chips)
    expect(w.findAll('.sb__ghost > .sb__shows')).toHaveLength(3);
    // a read error: no legend
    perf.loadError = 'read failed';
    await flushPromises();
    expect(w.find('.sb__shows').exists()).toBe(false);
    perf.loadError = null;
    // while loading there is no legend
    perf.loading = true;
    await flushPromises();
    expect(w.find('.sb__shows').exists()).toBe(false);
  });

  it('Switch: the photo; group bars only with two or more groups; the flag only when a key is uncalibrated', async () => {
    const device = await demo();
    const perf = usePerformanceStore();
    await perf.load();
    perf.uncalibrated = [];
    w = mount(SwitchPage, { global: { plugins: [router()] }, attachTo: document.body });
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('swp.shows')}`);
    w.unmount();
    perf.applySwitch([0, 1, 2], findSwitch(perf.catalog, 4208)!);
    await useSyncStore().flush();
    await perf.load(true);
    perf.uncalibrated = [3];
    w = mount(SwitchPage, { global: { plugins: [router()] }, attachTo: document.body });
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('swp.shows')} · ${tr('swp.showsGroupsGlyph')} = ${tr('swp.showsGroups')} · ${tr('sel.flaggedGlyph')} = ${tr('sel.flagged')}`);
    expect(w.find('.sb__bar').attributes('style')).toContain('var(--hue-blue)');
    expect(device.keys.length).toBeGreaterThan(0);
  });

  it('Lighting: where the colours come from, and the ● in the glowing badge colour', async () => {
    const device = await demo();
    (device.transport as unknown as { latencyMs: number }).latencyMs = 0;
    const lighting = useLightingStore();
    await lighting.load();
    w = mount(LightingPage, { attachTo: document.body });
    await flushPromises();
    lighting.stopLivePolling();
    await new Promise((r) => setTimeout(r, 250));
    await flushPromises();
    expect(device.demo).toBe(true);
    lighting.livePreview = true;
    lighting.liveError = false;
    await flushPromises();
    expect(legend()).toContain(tr('lighting.showsSim'));
    lighting.liveError = true;
    await flushPromises();
    expect(legend()).toContain(tr('lighting.showsSaved'));
    lighting.livePreview = false;
    lighting.liveError = false;
    await flushPromises();
    expect(legend().startsWith(`${tr('sel.shows')}: ${tr('lighting.showsSaved')}`)).toBe(true);
    // a key with its own colour: the ● item, drawn in the glowing badge's colour
    lighting.area0Matrix = lighting.area0Matrix.map((r) => (r ? { ...r, custom: true } : r));
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('lighting.showsSaved')} · ● = ${tr('lighting.showsOwn')}`);
    expect(w.find('.sb__shows .sb__g').attributes('style')).toContain(`--tone: ${GLOW_BADGE_TONE}`);
    lighting.area0Matrix = lighting.area0Matrix.map((r) => (r ? { ...r, custom: false } : r));
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('lighting.showsSaved')}`);
  });

  it('Keymap: the layer shown; ▽ and — only while some key on that layer has them', async () => {
    const device = await demo();
    const keymap = useKeymapStore();
    w = mount(KeymapPage, { global: { plugins: [router()], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    await keymap.load();
    await flushPromises();
    const set = (layer: number, changes: Record<number, number>) => {
      keymap.values = { ...keymap.values, [layer]: { ...Object.fromEntries(device.keys.map((k) => [k.id, 0x04])), ...changes } };
    };
    set(0, {});
    await flushPromises();
    const main = tr('keymap.shows', { layer: tr('keymap.layerMain') });
    expect(legend()).toBe(`${tr('sel.shows')}: ${main}`);
    expect(legend()).not.toContain('▽');
    expect(legend()).not.toContain('—');
    set(0, { 5: 0x0001 });
    await flushPromises();
    expect(legend()).toContain(`▽ = ${tr('keymap.showsTrans')}`);
    expect(legend()).not.toContain('—');
    set(0, { 5: 0x0000 });
    await flushPromises();
    expect(legend()).toContain(`— = ${tr('keymap.showsNone')}`);
    expect(legend()).not.toContain('▽');
    // Fn1 has a transparent and an empty key that Main does not have: the legend reads the layer shown
    set(0, {});
    set(1, { 7: 0x0001, 8: 0x0000 });
    keymap.activeLayer = 1;
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('keymap.shows', { layer: tr('keymap.layerFn1') })} · ▽ = ${tr('keymap.showsTrans')} · — = ${tr('keymap.showsNone')}`);
    keymap.activeLayer = 0;
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${main}`);
    expect(w.findAll('.sb__ghost > .sb__shows')).toHaveLength(4); // every layer's legend is measured
  });

  it('Keymap: a group button keeps the focus when the key picker opens; a key selected elsewhere focuses the search', async () => {
    await demo();
    const keymap = useKeymapStore();
    w = mount(KeymapPage, { global: { plugins: [router()], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    await keymap.load();
    await flushPromises();
    const btn = w.find('[data-group="letters"]');
    (btn.element as HTMLElement).focus();
    await btn.trigger('click');
    await flushPromises();
    expect(w.find('.km-quick').exists()).toBe(true); // the picker is open
    expect(document.activeElement).toBe(btn.element);
    useSelectionStore().clear();
    await flushPromises();
    (document.activeElement as HTMLElement | null)?.blur();
    useSelectionStore().selectMany([5]);
    await flushPromises();
    expect(document.activeElement?.tagName).toBe('INPUT'); // the picker's search
  });

  it('Advanced: the A/B item only while a SOCD or RS pair exists', async () => {
    const device = await demo();
    const adv = useAdvancedStore();
    await adv.load();
    w = mount(AdvancedPage, { global: { plugins: [router()], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    const [a, b] = [device.keys[20], device.keys[21]];
    const pair = (type: 'SOCD' | 'RS') => {
      const base = { row: 0, col: 0, pairedRow: 0, pairedCol: 0, keycodes: [0x04, 0x07] as [number, number], delay: 0 };
      const rec = (k: typeof a, o: typeof a) => (type === 'SOCD'
        ? { ...base, mode: 6 as const, type, socdMode: 0, row: k.row, col: k.col, pairedRow: o.row, pairedCol: o.col }
        : { ...base, mode: 7 as const, type, row: k.row, col: k.col, pairedRow: o.row, pairedCol: o.col });
      adv.records = { [a.id]: rec(a, b), [b.id]: rec(b, a) };
    };
    const dks = { mode: 1 as const, row: a.row, col: a.col, type: 'DKS' as const, keycodes: [0x04, 0x2c, 0, 0] as [number, number, number, number], travels: [0xff, 0x01, 0, 0] as [number, number, number, number], deadzones: [1.2, 2.8] as [number, number] };
    adv.records = { [a.id]: dks };
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('advanced.shows')}`);
    pair('RS');
    await flushPromises();
    expect(adv.assignments.map((x) => x.type)).toEqual(['RS']);
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('advanced.shows')} · A/B = ${tr('advanced.showsPair')}`);
    pair('SOCD');
    await flushPromises();
    expect(legend()).toContain(`A/B = ${tr('advanced.showsPair')}`);
    adv.records = {};
    await flushPromises();
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('advanced.shows')}`);
  });

  it('Gamepad: no legend before the gamepad config is ready', async () => {
    await demo('pro-xinput');
    w = mount(GamepadPage, { global: { plugins: [router()], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    const gp = useGamepadStore();
    await vi.waitFor(() => expect(w!.find('.sb__shows .sr-only').exists()).toBe(true), { timeout: 10000 });
    expect(legend()).toBe(`${tr('sel.shows')}: ${tr('gp.shows')} · ${tr('gp.showsGroups')}`);
    const config = gp.config;
    gp.config = null;
    await flushPromises();
    expect(w.find('.sb__shows').exists()).toBe(false);
    gp.config = config;
    await vi.waitFor(() => expect(w!.find('.sb__shows').exists()).toBe(true), { timeout: 10000 });
  });

  it('PageLayout hands the hint, the tip and the other legends to the bar', async () => {
    await demo();
    w = mount(PageLayout, {
      props: { title: 'T', keyboard: true, hint: 'HINT', tip: 'TIP', shows: [{ text: 'one' }], showsAlt: [[{ text: 'two' }]] },
      slots: { keyboard: '<i />' },
      global: { plugins: [router()] },
      attachTo: document.body,
    });
    await flushPromises();
    expect(w.find('.sb__hint').text()).toBe('HINT');
    expect(w.find('.sb__tip').text()).toContain('TIP HINT');
    expect(w.findAll('.sb__ghost > .sb__shows').map((p) => p.text())).toEqual([`${tr('sel.shows')}:one`, `${tr('sel.shows')}:two`]);
  });

  it('GLOW_BADGE_TONE is the colour of the glowing keycap badge', () => {
    const css = readFileSync(resolve('src/components/keyboard/Keycap.vue'), 'utf8').split('<style')[1];
    expect(css).toMatch(new RegExp(`\\.cap\\.cap--glow \\.cap__badge \\{ color: ${GLOW_BADGE_TONE.replace(/[()]/g, '\\$&')}; \\}`));
  });

  it('no page passes #hint any more: the detail slot replaced it', () => {
    for (const p of ['AdvancedPage', 'GamepadPage', 'KeymapPage', 'PerformancePage', 'SwitchPage', 'LightingPage']) {
      expect(readFileSync(resolve(`src/pages/${p}.vue`), 'utf8')).not.toContain('#hint');
    }
  });
});
