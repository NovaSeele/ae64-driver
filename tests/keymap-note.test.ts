// KM-NOTE-1: the Fn-rule note and the factory-key warning on the Keymap page belong to what is selected. The Fn note
// shows while an Fn switch is selected (not for the rest of the session after one was assigned); the factory warning
// shows then too, or when a selected key holds a factory keycode on the layer shown. The confirm before an assignment
// that would overwrite a factory key is unchanged. Demo keyboard only: the layers are set in the store, nothing is read
// from or written to a real board.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import KeymapPage from '../src/pages/KeymapPage.vue';
import KeyPicker from '../src/components/ui/KeyPicker.vue';
import { useDeviceStore } from '../src/stores/device';
import { useKeymapStore } from '../src/stores/keymap';
import { useSelectionStore } from '../src/stores/selection';
import { useToast } from '../src/components/ui/toast';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

const FN1 = 0xf101;
const FN2 = 0xf102;
const FACTORY_RESET = 0xf200;

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

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });

/** Demo board, Keymap page open, layers: every key `A` (0x04) except Q = Fn1 on Main and O = factory reset on Fn1. */
async function open() {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const keymap = useKeymapStore();
  const sel = useSelectionStore();
  w = mount(KeymapPage, { global: { plugins: [router()], stubs: { KeyboardView: true } }, attachTo: document.body });
  await flushPromises();
  await keymap.load();
  await flushPromises();
  const key = (name: string) => device.keys.find((k) => k.name === name)!.id;
  const all = Object.fromEntries(device.keys.map((k) => [k.id, 0x04]));
  keymap.values = { 0: { ...all, [key('Q')]: FN1 }, 1: { ...all, [key('O')]: FACTORY_RESET }, 2: { ...all }, 3: { ...all } };
  keymap.activeLayer = 0;
  sel.clear();
  await flushPromises();
  return { device, keymap, sel, key };
}
const fnNote = () => w!.find('.km-alert').exists();
const factoryWarning = () => w!.find('.km-factory').exists();

describe('Keymap page: the Fn note and the factory warning follow the selection (KM-NOTE-1)', () => {
  it('A on Main: neither block', async () => {
    const { sel, key } = await open();
    sel.select(key('A'));
    await flushPromises();
    expect(fnNote()).toBe(false);
    expect(factoryWarning()).toBe(false);
  });

  it('nothing selected: neither block, though a factory key is on the board', async () => {
    const { keymap } = await open();
    expect(keymap.factoryKeys).toHaveLength(1);
    expect(fnNote()).toBe(false);
    expect(factoryWarning()).toBe(false);
  });

  it('the Fn1 key selected: both blocks, the warning listing the board\'s factory keys as before', async () => {
    const { sel, key } = await open();
    sel.select(key('Q'));
    await flushPromises();
    expect(fnNote()).toBe(true);
    expect(w!.find('.km-alert').text()).toBe(tr('keymap.fnRuleNote'));
    expect(factoryWarning()).toBe(true);
    expect(w!.find('.km-factory').text()).toContain(tr('keymap.factoryListTitle'));
    expect(w!.findAll('.km-factory__list li')).toHaveLength(1);
  });

  it('O on layer Fn1 (a factory key there): only the factory warning; O on Main: neither', async () => {
    const { keymap, sel, key } = await open();
    keymap.activeLayer = 1;
    sel.select(key('O'));
    await flushPromises();
    expect(fnNote()).toBe(false);
    expect(factoryWarning()).toBe(true);
    keymap.activeLayer = 0; // the same key on the layer where it is a plain key
    await flushPromises();
    expect(factoryWarning()).toBe(false);
  });

  it('a selection that includes a factory key among others still warns', async () => {
    const { keymap, sel, key } = await open();
    keymap.activeLayer = 1;
    sel.selectMany([key('A'), key('O'), key('S')]);
    await flushPromises();
    expect(factoryWarning()).toBe(true);
  });

  it('after assigning Fn2 to Caps, selecting A shows neither (the note does not stay for the session)', async () => {
    const { keymap, sel, key } = await open();
    sel.select(key('Caps'));
    await flushPromises();
    w!.findComponent(KeyPicker).vm.$emit('pick', FN2);
    await flushPromises();
    expect(keymap.values[0][key('Caps')]).toBe(FN2); // assigned (demo board), the higher layers made Transparent
    expect(keymap.values[2][key('Caps')]).toBe(0x0001);
    expect(useToast().items.value.map((x) => x.text)).toContain(tr('keymap.fnGuardedApplied')); // the toast still says what happened
    expect(fnNote()).toBe(true); // Caps is an Fn switch now and still selected
    sel.select(key('A'));
    await flushPromises();
    expect(fnNote()).toBe(false);
    expect(factoryWarning()).toBe(false);
  });

  it('assigning Fn to O on Main (it would overwrite the factory key on Fn1) still asks first', async () => {
    const { keymap, sel, key } = await open();
    sel.select(key('O'));
    await flushPromises();
    expect(factoryWarning()).toBe(false);
    w!.findComponent(KeyPicker).vm.$emit('pick', FN1);
    await flushPromises();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain(tr('keymap.assignTitle'));
    expect(keymap.values[0][key('O')]).toBe(0x04); // nothing assigned until confirmed
    expect(keymap.values[1][key('O')]).toBe(FACTORY_RESET);
  });
});
