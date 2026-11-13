// WORKBENCH-1 step 1 (Hành trình): global-first scope, the editor dock, presets including the user's own.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { createApp } from 'vue';
import type { App } from 'vue';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { mountPerformance } from './mountPerformance';
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
import ToastHost from '../src/components/ui/Toast.vue';
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
  for (const k of ALL) values[k] = { ...values[k], mode: 1, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 };
  perf.values = values;
  useSelectionStore().selectMany(select);
  ({ w } = await mountPerformance('travel', {}, { stubs: opts.realKeyboard ? {} : { KeyboardView: true } }));
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
let host: { app: App; el: HTMLElement } | null = null;
/** Press the visible Hoàn tác button of the toast host (the real click path: run, then close). */
async function pressToastAction() {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const app = createApp(ToastHost);
  app.mount(el);
  host = { app, el };
  await flushPromises();
  el.querySelector<HTMLButtonElement>('.toast__act')!.click();
  await flushPromises();
}
// The Mẫu cài đặt card: built-in rows, then the saved ones (each with a ×), then the save button.
const presetRows = () => [...document.body.querySelectorAll<HTMLButtonElement>('.presets .preset')];
const chipByText = (s: string) => presetRows().find((b) => b.querySelector('.preset__name')?.textContent === s)!;
const saveItem = () => document.body.querySelector<HTMLButtonElement>('.presets__save button')!;
async function openMenu() {
  await flushPromises();
}
const userUse = chipByText;
async function applyUser(name: string) {
  userUse(name).click();
  await flushPromises();
}
const scopeText = () => document.body.querySelector('.scope')!.textContent!.replace(/\s+/g, ' ').trim();
const userPreset = (over: Partial<UserPreset> = {}): Omit<UserPreset, 'id' | 'name'> => ({
  mode: 1, continuous: true, actuation: 0.4, rtPress: 0.2, rtRelease: 0.25, deadTop: 0.05, deadBottom: 0.07, ...over,
});

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useToast().items.value = [];
});
afterEach(async () => {
  // A pending autosave job of this case must not fire into the next case's keyboard (sync resolves the device at fire time).
  await useSyncStore().flush();
  await flushPromises();
  off?.();
  off = null;
  w?.unmount();
  w = null;
  host?.app.unmount();
  host = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  useToast().items.value = [];
});

describe('W1: nothing selected means all keys', () => {
  it('the editors are shown and the scope line names every key of the connected keyboard', async () => {
    const { device } = await setup([]);
    expect(document.body.querySelector('.grid .act')).not.toBeNull();
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
    const setting = document.body.querySelector<HTMLInputElement>(`.c-dead input[aria-label="${t('perf.deadTop')}"]`)!;
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

  it('the toast Hoàn tác right after an all-keys edit restores all keys and closes the toast', async () => {
    const { perf, history } = await setup([]);
    const before = snapshot(perf);
    await typeActuation('1.7');
    const toast = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    await pressToastAction();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(toasts().some((x) => x.id === toast.id)).toBe(false);
  });

  it('P2: two all-keys edits, Ctrl+Z, then the toast Hoàn tác does nothing', async () => {
    const { perf, history } = await setup([]);
    off = history.installShortcuts();
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await typeActuation('1.7');
    now += 1000; // outside COALESCE_MS: a second entry
    await typeActuation('1.8');
    const toast = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    expect(perf.values[id('W')].rtFirstTouch).toBe(1.7);
    toast.action!.run();
    expect(perf.values[id('W')].rtFirstTouch).toBe(1.7);
    expect(history.canUndo).toBe(true);
  });

  it('P3: an all-keys edit, then the same label from a 64-key selection: the old toast does not undo the selected-keys edit', async () => {
    const { perf } = await setup([]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await typeActuation('1.7');
    const toast = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    now += 1000; // outside COALESCE_MS, so the second edit is its own entry
    useSelectionStore().selectMany(ALL);
    await flushPromises();
    await typeActuation('1.2');
    toast.action!.run();
    expect(perf.values[id('W')].rtFirstTouch).toBe(1.2);
  });

  it('P4: an all-keys edit, then a preset: the older toast does nothing, the preset toast undoes only the preset', async () => {
    const { perf, history } = await setup([]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await typeActuation('1.7');
    const toastA = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    now += 1000;
    const afterA = snapshot(perf);
    chipByText(t('perf.presetTyping')).click();
    await flushPromises();
    const afterB = snapshot(perf);
    expect(afterB).not.toEqual(afterA);
    const toastB = toasts().find((x) => x.action && x.id !== toastA.id)!;
    expect(toastB).toBeDefined();
    expect(toasts().filter((x) => x.action)).toHaveLength(1); // the all-keys toast was replaced
    toastA.action!.run();
    expect(snapshot(perf)).toEqual(afterB);
    toastB.action!.run();
    expect(snapshot(perf)).toEqual(afterA);
    expect(history.canUndo).toBe(true);
  });

  it('P5: a preset, then an all-keys edit: the preset toast does nothing, the edit toast undoes only the edit', async () => {
    const { perf, history } = await setup([]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const before = snapshot(perf);
    chipByText(t('perf.presetTyping')).click();
    await flushPromises();
    const afterB = snapshot(perf);
    const toastB = toasts().find((x) => x.action)!;
    now += 1000;
    await typeActuation('1.7');
    const toastA = toasts().find((x) => x.text === t('perf.appliedAll', { n: 64 }))!;
    const afterA = snapshot(perf);
    expect(afterA).not.toEqual(afterB);
    toastB.action!.run();
    expect(snapshot(perf)).toEqual(afterA);
    toastA.action!.run();
    expect(snapshot(perf)).toEqual(afterB);
    expect(history.canUndo).toBe(true);
    history.undo();
    expect(snapshot(perf)).toEqual(before);
  });

  it('repeated all-keys edits leave exactly one toast, and its Hoàn tác undoes the latest entry', async () => {
    const { perf, history } = await setup([]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await typeActuation('1.7');
    const afterFirst = snapshot(perf);
    now += 1000;
    await typeActuation('1.8');
    const same = toasts().filter((x) => x.text === t('perf.appliedAll', { n: 64 }));
    expect(same).toHaveLength(1);
    same[0].action!.run();
    expect(snapshot(perf)).toEqual(afterFirst);
    expect(history.canUndo).toBe(true);
  });

  const nudge = (selector: string, times = 6) => async () => {
    for (let i = 0; i < times; i++) {
      document.body.querySelector<HTMLInputElement>(selector)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await flushPromises();
    }
  };
  const rtField = (label: string) => `.c-rt input[aria-label="${label}"]`;
  const dzField = (label: string) => `.c-dead input[aria-label="${label}"]`;

  it.each([
    ['nf-rt-rtPress', rtField(t('perf.rtPress')), 'rtPress', false],
    ['nf-rt-rtRelease', rtField(t('perf.rtRelease')), 'rtRelease', false],
    ['nf-dz-pressDeadStroke', dzField(t('perf.deadTop')), 'pressDeadStroke', false],
    ['nf-dz-releaseDeadStroke', dzField(t('perf.deadBottom')), 'releaseDeadStroke', false],
    ['step-rt-rtPress', rtField(t('perf.rtPress')), 'rtPress', true],
    ['step-rt-rtRelease', rtField(t('perf.rtRelease')), 'rtRelease', true],
    ['step-dz-pressDeadStroke', dzField(t('perf.deadTop')), 'pressDeadStroke', true],
    ['step-dz-releaseDeadStroke', dzField(t('perf.deadBottom')), 'releaseDeadStroke', true],
  ] as const)('6 × ArrowUp in %s (all keys) is one history entry; one undo restores all 64 keys', async (_name, selector, field, mixed) => {
    const { perf, history } = await setup([]);
    if (mixed) {
      perf.values = { ...perf.values, [id('W')]: { ...perf.values[id('W')], [field]: perf.values[id('W')][field] + 0.2 } };
      await flushPromises();
    }
    const before = snapshot(perf);
    await nudge(selector)();
    expect(perf.values[id('A')][field]).toBeGreaterThan(before[id('A')][field]);
    history.undo();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('history ids: kept by coalescing, undo and redo; a new entry gets a new one', async () => {
    const history = useHistoryStore();
    const noop = () => {};
    history.push({ label: 'a', undo: noop, redo: noop, coalesce: 'x' });
    const first = history.undoId;
    history.push({ label: 'a', undo: noop, redo: noop, coalesce: 'x' });
    expect(history.undoId).toBe(first);
    history.push({ label: 'b', undo: noop, redo: noop });
    const second = history.undoId;
    expect(second).not.toBe(first);
    history.undo();
    expect(history.undoId).toBe(first);
    history.redo();
    expect(history.undoId).toBe(second);
  });

  it('6 × ArrowUp in the Actuation number field (all keys) is one history entry; one undo restores all 64 keys', async () => {
    const { perf, history } = await setup([]);
    const before = snapshot(perf);
    for (let i = 0; i < 6; i++) {
      actField().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await flushPromises();
    }
    expect(perf.values[id('W')].rtFirstTouch).toBeGreaterThan(1);
    expect(toasts().filter((x) => x.text === t('perf.appliedAll', { n: 64 }))).toHaveLength(1); // announced at once, not a slider drag
    history.undo();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
  });

  it('the same on a mixed value (the relative step path): one entry, and each key moves from its own value', async () => {
    const { perf, history } = await setup([]);
    const values = { ...perf.values };
    values[id('W')] = { ...values[id('W')], normalPress: 0.5, normalRelease: 0.5, rtFirstTouch: 0.5 };
    perf.values = values;
    await flushPromises();
    const before = snapshot(perf);
    for (let i = 0; i < 4; i++) {
      actField().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await flushPromises();
    }
    expect(perf.values[id('W')].rtFirstTouch).toBeGreaterThan(0.5);
    expect(perf.values[id('W')].rtFirstTouch).toBeLessThan(perf.values[id('A')].rtFirstTouch);
    history.undo();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
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
    await openMenu();
    saveItem().click();
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

describe('undo toast: it lives only while its entry is on top, one at a time', () => {
  const allKeysText = () => t('perf.appliedAll', { n: 64 });
  const undoToasts = () => toasts().filter((x) => x.action);

  it('a. all-keys edit, then a preset: one toast, the preset one; its Hoàn tác undoes only the preset', async () => {
    const { perf } = await setup([]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await typeActuation('1.7');
    const afterEdit = snapshot(perf);
    now += 1000;
    chipByText(t('perf.presetTyping')).click();
    await flushPromises();
    expect(undoToasts()).toHaveLength(1);
    expect(undoToasts()[0].text).toBe(t('perf.presetApplied', { name: t('perf.presetTyping'), n: 64 }));
    await pressToastAction();
    expect(snapshot(perf)).toEqual(afterEdit);
    expect(perf.values[id('W')].rtFirstTouch).toBe(1.7);
  });

  it('b. all-keys edit, then a scoped edit on W: the all-keys toast closes at once', async () => {
    await setup([]);
    let now = Date.now();
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    await typeActuation('1.7');
    expect(toasts().some((x) => x.text === allKeysText())).toBe(true);
    now += 1000;
    useSelectionStore().selectMany([id('W')]);
    await flushPromises();
    await typeActuation('0.6');
    expect(toasts().some((x) => x.action)).toBe(false);
  });

  it('c. all-keys edit, then history.undo(): the toast closes and the edit is undone once', async () => {
    const { perf, history } = await setup([]);
    const before = snapshot(perf);
    await typeActuation('1.7');
    history.undo();
    expect(undoToasts()).toHaveLength(0);
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(true);
  });

  it('d. 6 × ArrowUp in one field: one toast, one entry; Hoàn tác restores the value from before the first step', async () => {
    const { perf, history } = await setup([]);
    const before = snapshot(perf);
    for (let i = 0; i < 6; i++) {
      actField().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await flushPromises();
    }
    expect(undoToasts()).toHaveLength(1);
    const kept = undoToasts()[0].id;
    await pressToastAction();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(toasts().some((x) => x.id === kept)).toBe(false);
  });

  it('a repeated step on the same coalesced entry keeps the toast it has (same id)', async () => {
    await setup([]);
    for (let i = 0; i < 2; i++) {
      actField().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
      await flushPromises();
      if (i === 0) var first = undoToasts()[0].id;
    }
    expect(undoToasts().map((x) => x.id)).toEqual([first!]);
  });

  it('a history clear (profile reload) closes the toast; unmounting the page closes it too', async () => {
    const { history } = await setup([]);
    await typeActuation('1.7');
    history.clear();
    expect(undoToasts()).toHaveLength(0);
    await typeActuation('1.8');
    expect(undoToasts()).toHaveLength(1);
    w!.unmount();
    w = null;
    expect(undoToasts()).toHaveLength(0);
  });

  it('e. opening and closing toasts sends nothing to the keyboard', async () => {
    const { exchange, setPerf, sync, history } = await setup([]);
    await typeActuation('1.7');
    await sync.flush();
    exchange.mockClear();
    setPerf.mockClear();
    history.clear(); // closes the toast without undoing
    await flushPromises();
    await sync.flush();
    expect(exchange).not.toHaveBeenCalled();
    expect(setPerf).not.toHaveBeenCalled();
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
    await openMenu();
    saveItem().click();
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
    await openMenu();
    expect(userUse('Của tôi')).toBeDefined();
    expect(exchange).not.toHaveBeenCalled();
    expect(setPerf).not.toHaveBeenCalled();
  });

  it('survives a reload (a fresh store reads it back)', async () => {
    useUserPresetsStore().add('Giữ lại', userPreset());
    setActivePinia(createPinia());
    expect(useUserPresetsStore().presets.map((p) => p.name)).toEqual(['Giữ lại']);
  });

  it('mixed values cannot be saved: the item is disabled with the reason as a caption', async () => {
    const { perf } = await setup([]);
    await openMenu();
    expect(saveItem().disabled).toBe(false);
    perf.values = { ...perf.values, [id('Q')]: { ...perf.values[id('Q')], normalPress: 2, rtFirstTouch: 2 } };
    await flushPromises();
    expect(saveItem().disabled).toBe(true);
    expect(document.body.querySelector(`#${saveItem().getAttribute('aria-describedby')}`)!.textContent).toBe(t('perf.presetMixed'));
  });

  it('at most 6 user presets; the 7th cannot be saved', async () => {
    const store = useUserPresetsStore();
    for (let i = 0; i < USER_PRESET_MAX; i++) expect(store.add(`P${i}`, userPreset())).not.toBeNull();
    expect(store.add('P7', userPreset())).toBeNull();
    await setup(WASD);
    await openMenu();
    expect(saveItem().disabled).toBe(true);
    expect(document.body.querySelector('.presets__save .hint')!.textContent).toBe(t('perf.presetFull', { n: USER_PRESET_MAX }));
    expect(document.body.querySelectorAll('.preset-row')).toHaveLength(USER_PRESET_MAX);
  });

  it('applying a user preset to W A S D changes only those 4 keys, as one history entry', async () => {
    useUserPresetsStore().add('Nhạy', userPreset());
    const { perf, setPerf, history, sync } = await setup(WASD);
    const before = snapshot(perf);
    await applyUser('Nhạy');
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
    await applyUser('Std');
    for (const k of WASD) expect(perf.values[k]).toMatchObject({ mode: 0, normalPress: 0.4, rtFirstTouch: 0.4, rtPress: 0.3, rtRelease: 0.3 });
  });

  it('a non-continuous RT preset gives mode 1 below protocol 1.3.0.0 and mode 2 from it', async () => {
    useUserPresetsStore().add('Int', userPreset({ continuous: false }));
    const { perf, device } = await setup(WASD);
    device.version = { main: 1, sub: 2, hardware: 0, software: 0 };
    await applyUser('Int');
    for (const k of WASD) expect(perf.values[k].mode).toBe(1);
    device.version = { main: 1, sub: 3, hardware: 0, software: 0 };
    await applyUser('Int');
    for (const k of WASD) expect(perf.values[k].mode).toBe(2);
  });

  it('a preset toast Hoàn tác undoes the preset and the toast closes', async () => {
    const { perf, history } = await setup(WASD);
    const before = snapshot(perf);
    chipByText(t('perf.presetTyping')).click();
    await flushPromises();
    const toast = toasts().find((x) => x.action)!;
    expect(toast).toBeDefined();
    await pressToastAction();
    expect(snapshot(perf)).toEqual(before);
    expect(history.canUndo).toBe(false);
    expect(toasts().some((x) => x.id === toast.id)).toBe(false);
  });

  it('delete removes the chip and the stored entry and sends nothing to the keyboard', async () => {
    useUserPresetsStore().add('Xoá tôi', userPreset());
    const { exchange, setPerf, sync, history } = await setup(WASD);
    await openMenu();
    document.body.querySelector<HTMLButtonElement>(`.preset-x[aria-label="${t('perf.presetDelete', { name: 'Xoá tôi' })}"]`)!.click();
    await flushPromises();
    await sync.flush();
    expect(document.body.querySelectorAll('.preset-row')).toHaveLength(0);
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
    await applyUser('Quá tay');
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
    await applyUser('Mịn');
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
    expect(tips.length).toBeGreaterThanOrEqual(2); // the toolbar's two; the cards carry their hints as subtitles
    for (const b of tips) {
      expect(b.tabIndex).toBe(0);
      const text = document.body.querySelector(`#${b.getAttribute('aria-describedby')}`)!.textContent!;
      expect(text.length).toBeGreaterThan(5);
    }
  });

  it('DOM (= Tab) order: toolbar, keyboard, scope bar, editor cards', async () => {
    await setup([]);
    const q = (s: string) => document.body.querySelector(s)!;
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    // E: the board frame is TabKeyboard's (.tk__board); the view tools sit in the page toolbar, still before it
    expect(before(q('.wb__bar'), q('.tk__board'))).toBe(true);
    expect(before(q('.tk__board'), q('.sb'))).toBe(true);
    expect(before(q('.sb'), q('.grid'))).toBe(true);
    expect(document.body.querySelector('.page__aside')).toBeNull();
  });

  it('the Mode card carries Mode and Rapid Trigger liên tục; Standard keeps the diagram reachable', async () => {
    const { perf } = await setup([]);
    expect(document.body.querySelector('.c-mode .seg')).not.toBeNull();
    expect(document.body.querySelector('.c-mode [role="switch"]')).not.toBeNull();
    const values = { ...perf.values };
    for (const k of ALL) values[k] = { ...values[k], mode: 0 };
    perf.values = values;
    await flushPromises();
    expect(document.body.querySelector('.c-mode [role="switch"]')).toBeNull();
    expect(document.body.querySelector('.pcol .std')).not.toBeNull();
  });
});

function W_ID(): number { return id("W"); }
