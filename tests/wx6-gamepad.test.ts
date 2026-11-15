// WX6 gamepad page: U-04 (an armed output is taken only by a key picked on the keyboard picture).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import GamepadPage from '../src/pages/GamepadPage.vue';
import { controlIndex, keyIndexOf } from '../src/protocol/gamepad';
import { useDeviceStore } from '../src/stores/device';
import { useGamepadStore } from '../src/stores/gamepad';
import { useHistoryStore } from '../src/stores/history';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
let w: VueWrapper | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'en';
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
  w?.unmount();
  w = null;
  await flushPromises();
  document.body.innerHTML = '';
  locale.value = 'vi';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open() {
  const device = useDeviceStore();
  await device.connectDemo('pro-xinput');
  w = mount(GamepadPage, { global: { plugins: [router()] }, attachTo: document.body });
  await flushPromises();
  const gp = useGamepadStore();
  await vi.waitFor(() => expect(gp.travelKnown && w!.find('.gpo').exists()).toBe(true), { timeout: 10000 });
  (w.find('.kb').element as HTMLElement).setPointerCapture = () => undefined;
  return { device, gp, sel: useSelectionStore(), history: useHistoryStore(), sync: useSyncStore() };
}
const keyOf = (name: string) => useDeviceStore().keys.find((d) => d.name === name)!;
const keyIdx = (name: string) => { const k = keyOf(name); return keyIndexOf(k.row, k.col)!; };
const nameOfIdx = (i: number | null) => (i === null ? null : useDeviceStore().keys.find((k) => keyIndexOf(k.row, k.col) === i)?.name);
async function arm(index: number) {
  await w!.find(`[data-gp-tile="${index}"]`).trigger('click');
  await flushPromises();
  expect(w!.find('.gp-armed').exists()).toBe(true);
}
/** A plain click / tap on a key of the picture (pointerdown on the key, pointerup on the board, no movement). */
async function clickKey(name: string, mods: { ctrlKey?: boolean } = {}) {
  const el = w!.find(`[data-key="${keyOf(name).id}"]`).element;
  el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, ...mods }));
  w!.find('.kb').element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 5, clientY: 5, ...mods }));
  await flushPromises();
}

describe('WX6 U-04: an armed output takes only a picked key', () => {
  it('"All" while an output is armed assigns nothing, writes nothing and disarms', async () => {
    const { gp, sel, history, sync } = await open();
    const Y = controlIndex('Y'); // the demo block has Y on F
    expect(nameOfIdx(gp.config!.bindings[Y].key)).toBe('F');
    const before = JSON.stringify(gp.config!.bindings);
    const undoBefore = history.undoId;
    await arm(Y);
    const all = w!.findAll('.sb__actions button').find((b) => b.text() === tr('sel.all'))!;
    await all.trigger('click');
    await flushPromises();
    expect(JSON.stringify(gp.config!.bindings)).toBe(before);
    expect(history.undoId).toBe(undoBefore);
    expect(sync.pendingCount()).toBe(0);
    expect(w!.find('.gp-armed').exists()).toBe(false); // disarmed
    expect(sel.count).toBeGreaterThan(1); // and "All" did select all
  });

  it('"Letters", Invert and Clear while armed assign nothing and disarm', async () => {
    const { gp, history, sync } = await open();
    const A = controlIndex('A'); // demo: A on Space
    const LT = controlIndex('LT'); // demo: LT on Q
    expect(nameOfIdx(gp.config!.bindings[LT].key)).toBe('Q');
    const before = JSON.stringify(gp.config!.bindings);
    const undoBefore = history.undoId;
    await arm(A);
    await w!.find('.sb__actions [data-group="letters"]').trigger('click');
    await flushPromises();
    expect(w!.find('.gp-armed').exists()).toBe(false);
    await arm(A);
    await w!.findAll('.sb__actions button').find((b) => b.text() === tr('sel.invert'))!.trigger('click');
    await flushPromises();
    expect(w!.find('.gp-armed').exists()).toBe(false);
    expect(JSON.stringify(gp.config!.bindings)).toBe(before);
    expect(gp.config!.bindings[A].key).toBe(keyIdx('Space'));
    expect(history.undoId).toBe(undoBefore);
    expect(sync.pendingCount()).toBe(0);
  });

  it('Ctrl-click that deselects a key while armed assigns nothing and disarms', async () => {
    const { gp, sel, history } = await open();
    const Y = controlIndex('Y');
    sel.selectMany([keyOf('G').id, keyOf('H').id], 'replace');
    await flushPromises();
    await arm(Y); // two keys selected: the tile arms
    const before = JSON.stringify(gp.config!.bindings);
    const undoBefore = history.undoId;
    await clickKey('H', { ctrlKey: true }); // toggles H off
    expect(sel.ids).toEqual([keyOf('G').id]);
    expect(w!.find('.gp-armed').exists()).toBe(false);
    expect(JSON.stringify(gp.config!.bindings)).toBe(before);
    expect(history.undoId).toBe(undoBefore);
  });

  it('a click on one key assigns the armed output as one undo step', async () => {
    const { gp, sel, history } = await open();
    const Y = controlIndex('Y');
    const undoBefore = history.undoId;
    await arm(Y);
    await clickKey('G');
    expect(nameOfIdx(gp.config!.bindings[Y].key)).toBe('G');
    expect(w!.find('.gp-armed').exists()).toBe(false);
    expect(sel.ids).toEqual([keyOf('G').id]);
    expect(history.undoId).not.toBe(undoBefore);
    history.undo();
    await flushPromises();
    expect(nameOfIdx(gp.config!.bindings[Y].key)).toBe('F'); // one step back puts Y on F again
    expect(history.undoId).toBe(undoBefore);
  });

  it('Enter on a focused key assigns the armed output', async () => {
    const { gp } = await open();
    const Y = controlIndex('Y');
    await arm(Y);
    const el = w!.find(`[data-key="${keyOf('J').id}"]`);
    await el.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect(nameOfIdx(gp.config!.bindings[Y].key)).toBe('J');
    expect(w!.find('.gp-armed').exists()).toBe(false);
  });
});
