// WORKBENCH-1 step 1 (Hành trình): global-first scope, the editor dock, presets including the user's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import PerformancePage from '../src/pages/PerformancePage.vue';
import TravelEditor from '../src/components/performance/TravelEditor.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { useCalibrationStore } from '../src/stores/calibration';
import { pickEdit, rangeMm, usePerformanceStore } from '../src/stores/performance';
import { USER_PRESET_MAX, sanitizePreset, useUserPresetsStore } from '../src/stores/userPresets';
import type { UserPreset } from '../src/stores/userPresets';
import { useToast } from '../src/components/ui/toast';
import { t } from '../src/i18n/vi';

const id = (n: string) => PHYSICAL_KEYS.find((k) => k.name === n)!.id;
const WASD = ['W', 'A', 'S', 'D'].map(id);
const ALL = PHYSICAL_KEYS.map((k) => k.id);
const STORAGE_KEY = 'ae64.perf.userPresets';

// Each case loads a demo keyboard in real time (the 5 s default flakes under a loaded full-suite run).
vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
let off: (() => void) | null = null;

/** The demo keyboard with every key RT at 1.0 mm (store only, no write), the page mounted on the given selection. */
async function setup(select: number[] = [], opts: { realKeyboard?: boolean; model?: 'max' | 'pro' } = {}) {
  const device = useDeviceStore();
  await device.connectDemo(opts.model ?? 'max');
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const values = { ...perf.values };
  for (const k of ALL) values[k] = { ...values[k], mode: 1, normalPress: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 };
  perf.values = values;
  useSelectionStore().selectMany(select);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(PerformancePage, {
    global: { plugins: [router], stubs: opts.realKeyboard ? {} : { KeyboardView: true } },
    attachTo: document.body,
  });
  await flushPromises();
  const setPerf = vi.spyOn(mock, 'setPerformance');
  const exchange = vi.spyOn(mock as unknown as { exchange: () => unknown }, 'exchange');
  return { device, mock, perf, setPerf, exchange, history: useHistoryStore(), sync: useSyncStore() };
}
const snapshot = (perf: ReturnType<typeof usePerformanceStore>) => Object.fromEntries(ALL.map((k) => [k, pickEdit(perf.values[k])]));
const actField = () => document.body.querySelector<HTMLInputElement>(`.act input[aria-label="${t('perf.actuation')}"]`)!;
async function typeActuation(v: string) {
  actField().value = v;
  actField().dispatchEvent(new Event('input'));
  actField().dispatchEvent(new Event('blur'));
  await flushPromises();
}
const toasts = () => useToast().items.value;
const presetChips = () => [...document.body.querySelectorAll<HTMLButtonElement>('.wb__presets > .chip, .wb__presets .uchip__use')];
const chipByText = (s: string) => presetChips().find((b) => b.textContent?.trim() === s)!;
const scopeText = () => document.body.querySelector('.scope')!.textContent!.replace(/\s+/g, ' ').trim();
const userPreset = (over: Partial<UserPreset> = {}): Omit<UserPreset, 'id' | 'name'> => ({
  mode: 1, continuous: true, actuation: 0.4, rtPress: 0.2, rtRelease: 0.25, deadTop: 0.05, deadBottom: 0.07, ...over,
});

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useToast().items.value = [];
});
afterEach(() => {
  off?.();
  off = null;
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('W1: nothing selected means all keys', () => {
  it('the editors are shown and the scope line names every key of the connected keyboard', async () => {
    const { device } = await setup([]);
    expect(document.body.querySelector('.dock .act')).not.toBeNull();
    expect(scopeText()).toBe(`${t('perf.scopeAll', { n: device.keys.length })} · ${t('perf.scopeAllHint')}`);
    expect(scopeText()).toContain(t('perf.scopeAll', { n: 64 }));
  });

  it('a selection scopes the line to its keys, and Esc hint is there', async () => {
    await setup(WASD);
    expect(scopeText()).toBe(`${t('perf.scopeSel', { n: 4 })} (W A S D) · ${t('perf.scopeSelHint')}`);
  });

  it('a long selection lists some names, then …', async () => {
    await setup(ALL.slice(0, 12));
    expect(scopeText()).toMatch(/\(.+ …\)/);
  });

  it('an actuation change with nothing selected writes all 64 keys as ONE history entry; the toast and Ctrl+Z undo the same entry', async () => {
    const { perf, setPerf, history, sync } = await setup([]);
    off = history.installShortcuts();
    const before = snapshot(perf);
    await typeActuation('1.7');
    for (const k of ALL) expect(perf.values[k].rtFirstTouch).toBe(1.7);
    await sync.flush();
    expect(setPerf).toHaveBeenCalledTimes(64);
    const toast = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    expect(toast).toBeDefined();
    expect(toast.action!.label).toBe(t('history.undo'));
    const after = snapshot(perf);

    // Hoàn tác (the toast) = the history store's undo: one step restores all 64 keys, and nothing else is left to undo.
    toast.action!.run();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);

    // Redo, then Ctrl+Z: the very same single entry.
    history.redo();
    expect(snapshot(perf)).toEqual(after);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
    await sync.flush();
    expect(perf.values[W_ID()].rtFirstTouch).toBe(1);
  });

  it('the toast offers nothing when it no longer names the top history entry (a newer edit sits on top)', async () => {
    const { perf, history } = await setup([]);
    await typeActuation('1.7');
    const toast = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    // a newer edit by hand with a different label
    useSelectionStore().selectMany(WASD);
    await flushPromises();
    const setting = document.body.querySelector<HTMLInputElement>(`.pcol--dead input[aria-label="${t('perf.deadTop')}"]`)!;
    setting.value = '0.3';
    setting.dispatchEvent(new Event('input'));
    setting.dispatchEvent(new Event('blur'));
    await flushPromises();
    expect(perf.values[W_ID()].pressDeadStroke).toBe(0.3);
    toast.action!.run();
    expect(perf.values[W_ID()].pressDeadStroke).toBe(0.3); // untouched: Ctrl+Z is the way to undo that one
    expect(perf.values[W_ID()].rtFirstTouch).toBe(1.7);
    expect(history.canUndo).toBe(true);
  });

  it('with W A S D selected only those 4 keys change', async () => {
    const { perf, setPerf, sync } = await setup(WASD);
    const before = snapshot(perf);
    await typeActuation('0.6');
    await sync.flush();
    for (const k of ALL) expect(perf.values[k].rtFirstTouch).toBe(WASD.includes(k) ? 0.6 : before[k].rtFirstTouch);
    expect(setPerf).toHaveBeenCalledTimes(4);
    expect(toasts().some((x) => x.action !== undefined)).toBe(false); // the toast is for all-keys changes
  });

  it('a slider drag or arrow-key repeat in all-keys scope is ONE history entry and one write per key', async () => {
    const { perf, setPerf, history, sync } = await setup([]);
    const before = snapshot(perf);
    const thumb = () => document.body.querySelector<HTMLElement>('.act [role="slider"]')!;
    for (let i = 0; i < 6; i++) {
      thumb().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
      await flushPromises();
    }
    for (const k of ALL) expect(perf.values[k].rtFirstTouch).toBe(1.06);
    await sync.flush();
    expect(setPerf).toHaveBeenCalledTimes(64); // the sync queue coalesces per key (last wins), never 64 × 6
    expect(toasts().filter((x) => x.text === t('perf.appliedAll', { n: 64 }))).toHaveLength(1);
    history.undo();
    expect(snapshot(perf)).toEqual(before); // one undo undoes the whole gesture
    expect(history.canUndo).toBe(false);
  });

  it('a drag (update events, then commit) is one history entry', async () => {
    const { perf, history } = await setup([]);
    const before = snapshot(perf);
    const te = w!.findComponent(TravelEditor);
    for (const v of [1.1, 1.2, 1.3, 1.4, 1.5]) te.vm.$emit('update', v);
    te.vm.$emit('commit', 1.5);
    await flushPromises();
    for (const k of ALL) expect(perf.values[k].rtFirstTouch).toBe(1.5);
    history.undo();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('the page never reaches the switch write (no switch card, no applySwitch) in either scope', async () => {
    const { perf } = await setup([]);
    const spy = vi.spyOn(perf, 'applySwitch');
    expect(document.body.querySelector('.swc')).toBeNull();
    useSelectionStore().selectMany(WASD);
    await flushPromises();
    expect(document.body.querySelector('.swc')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('Esc returns to all keys', () => {
  async function withKeyboard(select: number[]) {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900, height: 300 }, borderBoxSize: [{ inlineSize: 900, blockSize: 300 }] }]); }
      unobserve() {}
      disconnect() {}
    });
    return setup(select, { realKeyboard: true });
  }
  const esc = (target: EventTarget) => target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  it('clears the selection (back to all keys)', async () => {
    await withKeyboard(WASD);
    esc(document.body);
    await flushPromises();
    expect(useSelectionStore().count).toBe(0);
    expect(scopeText()).toContain(t('perf.scopeAll', { n: 64 }));
  });

  it('does nothing inside a number field that holds a draft', async () => {
    await withKeyboard(WASD);
    actField().value = '0.8';
    actField().dispatchEvent(new Event('input'));
    await flushPromises();
    esc(actField());
    await flushPromises();
    expect(useSelectionStore().count).toBe(4);
  });

  it('does nothing inside a dialog (the save dialog)', async () => {
    await withKeyboard(WASD);
    chipByText(t('perf.presetSave')).click();
    await flushPromises();
    const dlg = document.body.querySelector('[role="dialog"]')!;
    expect(dlg).not.toBeNull();
    esc(dlg);
    await flushPromises();
    expect(useSelectionStore().count).toBe(4);
  });

  const key = (target: EventTarget, init: KeyboardEventInit) => target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
  const typeDraft = async (v: string) => { actField().value = v; actField().dispatchEvent(new Event('input')); await flushPromises(); };

  it('after Enter in the field, Ctrl+Z / Ctrl+Y on the still-focused input are app undo / redo', async () => {
    const { perf, history } = await withKeyboard([]);
    off = history.installShortcuts();
    const before = snapshot(perf);
    const oldText = actField().value;
    actField().focus();
    await typeDraft('1.50');
    key(actField(), { key: 'Enter' });
    await flushPromises();
    for (const k of ALL) expect(perf.values[k].rtFirstTouch).toBe(1.5);
    expect(document.activeElement).toBe(actField());
    expect(actField().hasAttribute('data-app-keys')).toBe(true);
    const after = snapshot(perf);

    key(actField(), { key: 'z', ctrlKey: true });
    await flushPromises();
    expect(snapshot(perf)).toEqual(before);
    expect(actField().value).toBe(oldText);
    expect(actField().hasAttribute('data-app-keys')).toBe(true);

    key(actField(), { key: 'y', ctrlKey: true });
    await flushPromises();
    expect(snapshot(perf)).toEqual(after);
    expect(actField().value).toBe('1.50');
  });

  it('one Esc in a clean field clears the key selection', async () => {
    await withKeyboard(WASD);
    actField().focus();
    await typeDraft('0.80');
    key(actField(), { key: 'Enter' });
    await flushPromises();
    expect(useSelectionStore().count).toBe(4);
    key(actField(), { key: 'Escape' });
    await flushPromises();
    expect(useSelectionStore().count).toBe(0);
  });

  it('a draft keeps Esc and Ctrl+Z: Esc reverts the text, the selection and the history stay', async () => {
    const { perf, history } = await withKeyboard(WASD);
    off = history.installShortcuts();
    const before = snapshot(perf);
    const committed = actField().value;
    actField().focus();
    await typeDraft('0.8');
    expect(actField().hasAttribute('data-app-keys')).toBe(false);
    key(actField(), { key: 'z', ctrlKey: true });
    expect(history.canUndo).toBe(false);
    expect(snapshot(perf)).toEqual(before);
    key(actField(), { key: 'Escape' });
    await flushPromises();
    expect(actField().value).toBe(committed);
    expect(useSelectionStore().count).toBe(4);
    expect(snapshot(perf)).toEqual(before);
  });

  it('does nothing during a calibration', async () => {
    const { device } = await withKeyboard(WASD);
    useCalibrationStore().phase = 'running';
    esc(document.body);
    await flushPromises();
    expect(useSelectionStore().count).toBe(4);
    useCalibrationStore().phase = 'idle';
    expect(device.calibrationLocked()).toBe(false);
    esc(document.body);
    await flushPromises();
    expect(useSelectionStore().count).toBe(0);
  });
});

describe('W3: presets', () => {
  it('a built-in preset applies to the scope as one history entry', async () => {
    const { perf, history } = await setup(WASD);
    const before = snapshot(perf);
    chipByText(t('perf.presetTyping')).click();
    await flushPromises();
    for (const k of WASD) expect(perf.values[k].mode).toBe(0);
    for (const k of ALL.filter((x) => !WASD.includes(x))) expect(pickEdit(perf.values[k])).toEqual(before[k]);
    history.undo();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('save: name + current values, kept in localStorage, nothing sent to the keyboard', async () => {
    const { exchange, setPerf, sync } = await setup(WASD);
    chipByText(t('perf.presetSave')).click();
    await flushPromises();
    const input = document.body.querySelector<HTMLInputElement>('[role="dialog"] input')!;
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain(t('perf.presetNote'));
    input.value = 'Của tôi';
    input.dispatchEvent(new Event('input'));
    await flushPromises();
    const save = [...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === t('perf.presetSaveBtn'))!;
    save.click();
    await flushPromises();
    await sync.flush();
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ name: 'Của tôi', mode: 1, continuous: true, actuation: 1, rtPress: 0.3, rtRelease: 0.3, deadTop: 0.1, deadBottom: 0.1 });
    expect(chipByText('Của tôi')).toBeDefined();
    expect(exchange).not.toHaveBeenCalled();
    expect(setPerf).not.toHaveBeenCalled();
  });

  it('survives a reload (a fresh store reads it back)', async () => {
    useUserPresetsStore().add('Giữ lại', userPreset());
    setActivePinia(createPinia());
    expect(useUserPresetsStore().presets.map((p) => p.name)).toEqual(['Giữ lại']);
  });

  it('mixed values cannot be saved: the button is disabled with a reason', async () => {
    const { perf } = await setup([]);
    expect(chipByText(t('perf.presetSave')).disabled).toBe(false);
    perf.values = { ...perf.values, [id('Q')]: { ...perf.values[id('Q')], normalPress: 2, rtFirstTouch: 2 } };
    await flushPromises();
    const btn = chipByText(t('perf.presetSave'));
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(t('perf.presetMixed'));
    expect(document.body.querySelector(`#${btn.getAttribute('aria-describedby')}`)!.textContent).toBe(t('perf.presetMixed'));
  });

  it('at most 6 user presets; the 7th cannot be saved', async () => {
    const store = useUserPresetsStore();
    for (let i = 0; i < USER_PRESET_MAX; i++) expect(store.add(`P${i}`, userPreset())).not.toBeNull();
    expect(store.add('P7', userPreset())).toBeNull();
    await setup(WASD);
    const btn = chipByText(t('perf.presetSave'));
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe(t('perf.presetFull', { n: USER_PRESET_MAX }));
    expect(document.body.querySelectorAll('.uchip')).toHaveLength(USER_PRESET_MAX);
  });

  it('applying a user preset to W A S D changes only those 4 keys, as one history entry', async () => {
    useUserPresetsStore().add('Nhạy', userPreset());
    const { perf, setPerf, history, sync } = await setup(WASD);
    const before = snapshot(perf);
    chipByText('Nhạy').click();
    await flushPromises();
    await sync.flush();
    for (const k of ALL) {
      if (WASD.includes(k)) expect(pickEdit(perf.values[k])).toMatchObject({ mode: 1, normalPress: 0.4, rtFirstTouch: 0.4, rtPress: 0.2, rtRelease: 0.25, pressDeadStroke: 0.05, releaseDeadStroke: 0.07 });
      else expect(pickEdit(perf.values[k])).toEqual(before[k]);
    }
    expect(setPerf).toHaveBeenCalledTimes(4);
    history.undo();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('a Standard preset leaves the RT fields alone; a non-continuous RT preset keeps mode 1 where the protocol cannot do mode 2', async () => {
    const store = useUserPresetsStore();
    store.add('Std', userPreset({ mode: 0 }));
    const { perf } = await setup(WASD);
    chipByText('Std').click();
    await flushPromises();
    for (const k of WASD) expect(perf.values[k]).toMatchObject({ mode: 0, normalPress: 0.4, rtFirstTouch: 0.4, rtPress: 0.3, rtRelease: 0.3 });
  });

  it('delete removes the chip and the stored entry and sends nothing to the keyboard', async () => {
    useUserPresetsStore().add('Xoá tôi', userPreset());
    const { exchange, setPerf, sync, history } = await setup(WASD);
    document.body.querySelector<HTMLButtonElement>(`.uchip__x[aria-label="${t('perf.presetDelete', { name: 'Xoá tôi' })}"]`)!.click();
    await flushPromises();
    await sync.flush();
    expect(document.body.querySelectorAll('.uchip')).toHaveLength(0);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual([]);
    expect(exchange).not.toHaveBeenCalled();
    expect(setPerf).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(false);
  });
});

describe('user presets from localStorage are untrusted', () => {
  const load = (raw: string) => {
    localStorage.setItem(STORAGE_KEY, raw);
    setActivePinia(createPinia());
    return useUserPresetsStore().presets;
  };
  const good = { id: 'a1', name: 'Tốt', mode: 1, continuous: true, actuation: 1, rtPress: 0.3, rtRelease: 0.3, deadTop: 0.1, deadBottom: 0.1 };

  it('corrupt or non-array JSON gives no presets and no crash', () => {
    expect(load('{not json')).toEqual([]);
    expect(load('{"a":1}')).toEqual([]);
    expect(load('42')).toEqual([]);
    expect(load('null')).toEqual([]);
  });

  it('wrong shapes, types and unknown modes are dropped; valid siblings survive', () => {
    const bad = [
      null, 5, 'x', [],
      { ...good, id: 'b1', name: '' },
      { ...good, id: 'b2', name: 'x'.repeat(40) },
      { ...good, id: 'b3', mode: 2 },
      { ...good, id: 'b4', mode: '1' },
      { ...good, id: 'b5', continuous: 'yes' },
      { ...good, id: 'b6', actuation: '1' },
      { ...good, id: 'b7', rtPress: null },
      { ...good, id: 'b8', deadTop: undefined },
      { ...good, id: 7 },
      { ...good, id: '' },
      { ...good, id: 'a1' }, // duplicate id
    ];
    expect(load(JSON.stringify([...bad, good])).map((p) => p.id)).toEqual(['a1']);
  });

  it('out-of-range numbers are clamped to the limits; more than 6 entries are cut', () => {
    const wild = { ...good, id: 'w', actuation: 99, rtPress: -5, rtRelease: 1e9, deadTop: -1, deadBottom: 50 };
    const [p] = load(JSON.stringify([wild]));
    expect(p).toMatchObject({ actuation: 10, rtPress: 0.01, rtRelease: 2, deadTop: 0, deadBottom: 1 });
    const many = Array.from({ length: 9 }, (_, i) => ({ ...good, id: `m${i}` }));
    expect(load(JSON.stringify(many))).toHaveLength(USER_PRESET_MAX);
    expect(sanitizePreset({ ...good, actuation: Infinity })).toBeNull(); // not finite
  });

  it('a throwing localStorage is survived on load and on save', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('full'); });
    setActivePinia(createPinia());
    const store = useUserPresetsStore();
    expect(store.presets).toEqual([]);
    expect(store.add('Còn trong phiên', userPreset())).not.toBeNull();
    expect(store.presets).toHaveLength(1);
    store.remove(store.presets[0].id);
    expect(store.presets).toEqual([]);
  });

  it('a hand-edited preset never reaches the keyboard out of range: apply clamps to each key (Max)', async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([{ ...good, id: 'wild', name: 'Quá tay', actuation: 99, rtPress: 50, rtRelease: -3, deadTop: 9, deadBottom: -9 }]));
    setActivePinia(createPinia());
    const { perf, sync } = await setup(WASD);
    chipByText('Quá tay').click();
    await flushPromises();
    await sync.flush();
    for (const k of WASD) {
      const p = perf.values[k];
      expect(p.rtFirstTouch).toBeLessThanOrEqual(rangeMm(p));
      expect(p.normalPress).toBeLessThanOrEqual(rangeMm(p));
      expect(p.rtPress).toBeLessThanOrEqual(2);
      expect(p.rtRelease).toBeGreaterThanOrEqual(0.01);
      expect(p.pressDeadStroke).toBeLessThanOrEqual(1);
      expect(p.releaseDeadStroke).toBeGreaterThanOrEqual(0);
    }
  });

  it('on the Pro (coarser precision) a preset value is rounded to the model grid before the write', async () => {
    useUserPresetsStore().add('Mịn', userPreset({ actuation: 0.437, rtPress: 0.123, rtRelease: 0.127 }));
    const { device, perf, sync } = await setup(WASD, { model: 'pro' });
    chipByText('Mịn').click();
    await flushPromises();
    await sync.flush();
    const step = device.rtPrecision || 0.001;
    for (const k of WASD) {
      for (const v of [perf.values[k].rtFirstTouch, perf.values[k].rtPress, perf.values[k].rtRelease]) {
        expect(Math.abs(Math.round(v / step) * step - v)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('W2: one-screen structure', () => {
  it('every (i) explanation is a keyboard-reachable button whose text is in the DOM for aria-describedby', async () => {
    await setup([]);
    const tips = [...document.body.querySelectorAll<HTMLButtonElement>('.info__btn')];
    expect(tips.length).toBeGreaterThanOrEqual(6);
    for (const b of tips) {
      expect(b.tabIndex).toBe(0);
      const text = document.body.querySelector(`#${b.getAttribute('aria-describedby')}`)!.textContent!;
      expect(text.length).toBeGreaterThan(5);
    }
  });

  it('DOM (= Tab) order: toolbar, keyboard, scope bar, dock', async () => {
    await setup([]);
    const q = (s: string) => document.body.querySelector(s)!;
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before(q('.wb__bar'), q('.wb__board'))).toBe(true);
    expect(before(q('.wb__board'), q('.sb'))).toBe(true);
    expect(before(q('.sb'), q('.dock'))).toBe(true);
    expect(document.body.querySelector('.page__aside')).toBeNull();
  });

  it('the dock header carries Mode and Rapid Trigger liên tục; Standard keeps the diagram reachable', async () => {
    const { perf } = await setup([]);
    expect(document.body.querySelector('.dock__head .seg')).not.toBeNull();
    expect(document.body.querySelector('.dock__head [role="switch"]')).not.toBeNull();
    const values = { ...perf.values };
    for (const k of ALL) values[k] = { ...values[k], mode: 0 };
    perf.values = values;
    await flushPromises();
    expect(document.body.querySelector('.dock__head [role="switch"]')).toBeNull();
    expect(document.body.querySelector('.pcol--std .std')).not.toBeNull();
  });
});

function W_ID(): number { return id("W"); }
