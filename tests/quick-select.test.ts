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

async function demo(model: 'max' | 'pro' = 'max') {
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
    sel.letters('add');
    expect(sel.ids).toEqual([...LETTERS, ...MODS].sort((a, b) => a - b));
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
    expect(w.find('.sb__shows').exists()).toBe(false);
    expect(w.find('.sb__detail .d').exists()).toBe(true);
    expect(w.find('.sb__hint').text()).toBe(tr('sel.hint'));
  });
});

describe('pickFit (§3.3)', () => {
  // row(lead) = lead + 12 + 1 + 12 + middle + 12 + actions; fit 1 adds 12 + hint and drops the (i)
  const base: FitInput = { bar: 0, lead: 200, leadCompact: 120, tip: 24, middle: 300, hint: 250, actions: 400, gap: 12, detail: false };
  const fit1 = 176 + 300 + 400 + 37 + 12 + 250; // 1175
  const fit2 = 200 + 300 + 400 + 37; // 937
  const fit3 = 120 + 300 + 400 + 37; // 857
  it.each([
    [2000, 1], [fit1, 1], [fit1 - 1, 2], [fit2, 2], [fit2 - 1, 3], [fit3, 3], [fit3 - 1, 4], [300, 4],
  ])('bar %i → fit %i', (bar, expected) => {
    expect(pickFit({ ...base, bar })).toBe(expected);
  });
  it('a detail never moves to a second row: it stops at 3', () => {
    for (const bar of [fit3 - 1, 600, 1]) expect(pickFit({ ...base, bar, detail: true })).toBe(3);
    expect(pickFit({ ...base, bar: fit1, detail: true })).toBe(1);
    expect(pickFit({ ...base, bar: fit2, detail: true })).toBe(2);
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
