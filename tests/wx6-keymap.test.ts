// WX6 U-08: the Fn release rule runs both ways on every keymap write path (pick, Restore default layer, backup restore).
// At a key where a layer holds an Fn switch (F101–F103), every higher layer holds Transparent. Demo keyboard only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import KeymapPage from '../src/pages/KeymapPage.vue';
import KeyPicker from '../src/components/ui/KeyPicker.vue';
import { MockTransport } from '../src/protocol';
import { isWriteCommand } from '../src/protocol/safety';
import { useDeviceStore } from '../src/stores/device';
import { breaksFnRule, isFnSwitch, useKeymapStore } from '../src/stores/keymap';
import { useDiagnosticsStore } from '../src/stores/diagnostics';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });
const FN1 = 0xf101;
const TRANS = 0x0001;
const A = 0x0004;

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
  await useSyncStore().flush().catch(() => undefined);
  w?.unmount();
  w = null;
  await flushPromises();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const hex = (b: ArrayLike<number>) => Array.from(b).slice(0, 3).map((x) => x.toString(16).padStart(2, '0')).join(' ');
function writesOf(mock: MockTransport): string[] {
  const out: string[] = [];
  mock.onPacket((e) => { if (e.dir === 'out' && isWriteCommand([...e.bytes])) out.push(hex(e.bytes)); });
  return out;
}
/** Demo board with Fn1 put on Main at `name` through the app (the rule makes Fn1–Fn3 Transparent there). */
async function withFnOnMain(name = 'Caps') {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const keymap = useKeymapStore();
  await keymap.load();
  const key = (n: string) => device.keys.find((k) => k.name === n)!;
  const fnKey = key(name);
  keymap.activeLayer = 0;
  keymap.applyKeycode([fnKey.id], FN1);
  await useSyncStore().flush();
  expect(keymap.values[1][fnKey.id]).toBe(TRANS);
  return { device, mock, keymap, key, fnKey };
}

describe('WX6 U-08: the pick', () => {
  it('H turned round: "A" on Fn1 above an Fn1 switch on Main is refused and nothing is written', async () => {
    const { mock, keymap, fnKey } = await withFnOnMain();
    keymap.activeLayer = 1;
    const plan = keymap.planKeycode([fnKey.id], A);
    expect(plan.after).toEqual({});
    expect(plan.fnBlocked).toEqual([{ id: fnKey.id, layer: 0, code: FN1 }]);
    const writes = writesOf(mock);
    expect(keymap.applyKeycode([fnKey.id], A).fnBlocked.length).toBe(1);
    await useSyncStore().flush();
    expect(writes).toEqual([]);
    expect(isFnSwitch(await mock.getKeycode(fnKey, 0))).toBe(true);
    expect(await mock.getKeycode(fnKey, 1)).toBe(TRANS);
  });

  it('the same on Fn3 (every layer above), and another Fn switch is refused too; Transparent is always allowed', async () => {
    const { keymap, fnKey } = await withFnOnMain();
    keymap.activeLayer = 3;
    expect(keymap.planKeycode([fnKey.id], A).fnBlocked.length).toBe(1);
    keymap.activeLayer = 2;
    expect(keymap.planKeycode([fnKey.id], 0xf103).fnBlocked.length).toBe(1);
    // a bad state from another tool: Transparent can always put it right
    keymap.values = { ...keymap.values, 2: { ...keymap.values[2], [fnKey.id]: A } };
    const fix = keymap.planKeycode([fnKey.id], TRANS);
    expect(fix.fnBlocked).toEqual([]);
    expect(fix.after).toEqual({ [`2:${fnKey.id}`]: TRANS });
  });

  it('the selection: the Fn-held key is refused with the note, the other key is written', async () => {
    const { device, mock, keymap, key, fnKey } = await withFnOnMain();
    const sel = useSelectionStore();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(KeymapPage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    keymap.activeLayer = 1;
    const other = key('G');
    sel.selectMany([fnKey.id, other.id], 'replace');
    await flushPromises();
    const writes = writesOf(mock);
    w.findComponent(KeyPicker).vm.$emit('pick', A);
    await flushPromises();
    await useSyncStore().flush();
    await flushPromises();
    expect(keymap.values[1][other.id]).toBe(A);
    expect(keymap.values[1][fnKey.id]).toBe(TRANS);
    expect(await mock.getKeycode(other, 1)).toBe(A);
    expect(await mock.getKeycode(fnKey, 1)).toBe(TRANS);
    expect(writes.filter((x) => x.startsWith('ff 03 02') || x.startsWith('03 02')).length).toBeLessThanOrEqual(1);
    const note = w.find('[data-test="fn-rule-refused"]');
    expect(note.text()).toBe(t('keymap.fnRuleRefused', { key: fnKey.name, fn: 'Fn1', layer: 'Main' }));
    expect(note.text()).toBe(`Phím ${fnKey.name} đang giữ Fn1 ở lớp Main. Ở lớp này nó phải để Transparent để nhả được Fn.`);
    // another selection: the note goes
    sel.select(other.id);
    await flushPromises();
    expect(w.find('[data-test="fn-rule-refused"]').exists()).toBe(false);
    void device;
  });
});

describe('WX7 0a: the Fn rule edges (KM2, KM7)', () => {
  it('on the layer that holds the Fn switch, another code replaces it: "A" on the Fn key on Main is written', async () => {
    const { mock, keymap, fnKey } = await withFnOnMain();
    keymap.activeLayer = 0;
    const plan = keymap.planKeycode([fnKey.id], A);
    expect(plan.fnBlocked).toEqual([]);
    const writes = writesOf(mock);
    keymap.applyKeycode([fnKey.id], A);
    await useSyncStore().flush();
    expect(keymap.values[0][fnKey.id]).toBe(A);
    expect(await mock.getKeycode(fnKey, 0)).toBe(A);
    expect(writes.length).toBeGreaterThan(0);
  });

  it('one key selected, held by an Fn switch below, "A" picked: the note shows and nothing is written', async () => {
    const { mock, keymap, fnKey } = await withFnOnMain();
    const sel = useSelectionStore();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(KeymapPage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    keymap.activeLayer = 1;
    sel.select(fnKey.id);
    await flushPromises();
    const writes = writesOf(mock);
    w.findComponent(KeyPicker).vm.$emit('pick', A);
    await flushPromises();
    await useSyncStore().flush();
    await flushPromises();
    expect(writes).toEqual([]);
    expect(keymap.values[1][fnKey.id]).toBe(TRANS);
    expect(w.find('[data-test="fn-rule-refused"]').text()).toBe(t('keymap.fnRuleRefused', { key: fnKey.name, fn: 'Fn1', layer: 'Main' }));
  });
});

describe('WX6 U-08: Restore default layer', () => {
  it('applyDefault skips a key whose default would break the rule; computeDefaultDiff counts it', async () => {
    const { keymap, fnKey, key } = await withFnOnMain();
    const other = key('G');
    // Fn1 layer default for these keys, as the keyboard reports it; force non-Transparent defaults to test the skip
    const n = keymap.applyDefault(1, { [fnKey.id]: A, [other.id]: 0x0005 });
    expect(n).toBe(1);
    expect(keymap.values[1][fnKey.id]).toBe(TRANS);
    expect(keymap.values[1][other.id]).toBe(0x0005);
    await useSyncStore().flush();
  });

  it('the restore names the keys left as they are (through the keyboard\'s own defaults)', async () => {
    const { mock, keymap, fnKey } = await withFnOnMain();
    // the keyboard's Fn1 default at the Fn key is "A" (the demo's are all Transparent): the restore must leave it
    const real = mock.getDefaultKeymapRow.bind(mock);
    vi.spyOn(mock, 'getDefaultKeymapRow').mockImplementation(async (sys, layer, row) => {
      const codes = await real(sys, layer, row);
      return layer === 1 && row === fnKey.row ? codes.map((c, col) => (col === fnKey.col ? A : c)) : codes;
    });
    keymap.activeLayer = 1;
    const diff = await keymap.computeDefaultDiff(1);
    expect(diff.fnBlocked).toEqual([fnKey.id]);
    expect(diff.defaultCodes[fnKey.id]).toBeUndefined();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(KeymapPage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
    await flushPromises();
    keymap.activeLayer = 1;
    await flushPromises();
    await w.findAll('button').find((x) => x.text().includes(t('keymap.restoreDefault')))!.trigger('click');
    const named = t('keymap.restoreDefaultFnSkipped', { n: 1, keys: fnKey.name });
    if (diff.diffCount > 0) {
      // other keys differ: the dialog says which keys stay as they are
      await vi.waitFor(() => expect(document.body.querySelector('[data-test="restore-fn-skipped"]')?.textContent?.trim()).toBe(named));
    } else {
      const { useToast } = await import('../src/components/ui/toast');
      await vi.waitFor(() => expect(useToast().items.value.map((x) => x.text)).toContain(named));
    }
    // the rule itself, both ways
    expect(breaksFnRule({ 0: { 1: FN1 }, 1: { 1: TRANS } }, 1, 1, A)).toBe(true);
    expect(breaksFnRule({ 0: { 1: 0x04 }, 1: { 1: A } }, 0, 1, FN1)).toBe(true);
    expect(breaksFnRule({ 0: { 1: 0x04 }, 1: { 1: TRANS }, 2: { 1: TRANS }, 3: { 1: TRANS } }, 0, 1, FN1)).toBe(false);
    expect(breaksFnRule({ 0: { 1: FN1 } }, 2, 1, TRANS)).toBe(false);
  });
});

describe('WX6 U-08: backup restore', () => {
  it('a file that would put "A" above an Fn switch is refused at validation, naming the key; nothing is written', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const diag = useDiagnosticsStore();
    const payload = await diag.generateBackup();
    const caps = device.keys.find((k) => k.name === 'Caps')!;
    payload.keymap[0][caps.id] = FN1;
    payload.keymap[1][caps.id] = A;
    payload.keymap[2][caps.id] = TRANS;
    payload.keymap[3][caps.id] = TRANS;
    const writes = writesOf(mock);
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.refused).toBe(t('diagnostics.vRefused', { msg: t('diagnostics.vFnRule', { keys: 'Caps' }) }));
    await expect(diag.applyRestore(diff)).rejects.toThrow();
    expect(writes).toEqual([]);
    expect(isFnSwitch(await mock.getKeycode(caps, 0))).toBe(false);
  });

  it('a file this app wrote (the rule kept) restores', async () => {
    const { device, mock, keymap, fnKey } = await withFnOnMain();
    const diag = useDiagnosticsStore();
    const payload = await diag.generateBackup();
    keymap.activeLayer = 0;
    keymap.applyKeycode([fnKey.id], A); // the Fn switch moved away; the file puts it back with Transparent above
    await useSyncStore().flush();
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.refused).toBeNull();
    await diag.applyRestore(diff);
    expect(await mock.getKeycode(fnKey, 0)).toBe(FN1);
    void device;
  });
});
