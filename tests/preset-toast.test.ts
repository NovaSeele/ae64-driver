// The two Hoàn tác toasts of Hành trình: the history undo toast and the preset-delete toast (merge, restore once, closes on
// any other change of the saved list), plus the toast of a preset that changes nothing and the one-undo-toast rule. 0 HID.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createApp, nextTick } from 'vue';
import type { App } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import PerformancePage from '../src/pages/PerformancePage.vue';
import ToastHost from '../src/components/ui/Toast.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore, pickEdit } from '../src/stores/performance';
import { useUserPresetsStore } from '../src/stores/userPresets';
import type { UserPreset } from '../src/stores/userPresets';
import { useToast } from '../src/components/ui/toast';
import { t } from '../src/i18n/vi';

const ALL = PHYSICAL_KEYS.map((k) => k.id);
const STORAGE_KEY = 'ae64.perf.userPresets';
vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
let host: App | null = null;
const values = (over: Partial<UserPreset> = {}): Omit<UserPreset, 'id' | 'name'> => ({
  mode: 1, continuous: true, actuation: 0.4, rtPress: 0.2, rtRelease: 0.25, deadTop: 0.05, deadBottom: 0.07, ...over,
});

async function setup() {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const perf = usePerformanceStore();
  await perf.load();
  const v = { ...perf.values };
  for (const k of ALL) v[k] = { ...v[k], mode: 1, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 };
  perf.values = v;
  useSelectionStore().selectMany([]);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(PerformancePage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
  await flushPromises();
  const setPerf = vi.spyOn(device.transport as MockTransport, 'setPerformance');
  return { perf, setPerf, history: useHistoryStore() };
}
const snapshot = (perf: ReturnType<typeof usePerformanceStore>) => Object.fromEntries(ALL.map((k) => [k, pickEdit(perf.values[k])]));
const rows = () => [...document.body.querySelectorAll<HTMLElement>('.preset-row')];
const names = () => rows().map((r) => r.querySelector('.preset__name')!.textContent);
const stored = () => (JSON.parse(localStorage.getItem(STORAGE_KEY)!) as UserPreset[]).map((p) => p.name);
const del = async (i: number) => {
  document.body.querySelectorAll<HTMLButtonElement>('.preset-x')[i].click();
  await flushPromises();
};
const toasts = () => useToast().items.value;
const withAction = () => toasts().filter((x) => x.action);
const isPresetDelete = (x: { kind: string; action?: unknown }) => x.kind === 'info' && !!x.action; // the history undo toast is 'success'
const presetToasts = () => toasts().filter(isPresetDelete);
const actField = () => document.body.querySelector<HTMLInputElement>(`.act input[aria-label="${t('perf.actuation')}"]`)!;
async function typeActuation(v: string) {
  actField().value = v;
  actField().dispatchEvent(new Event('input'));
  actField().dispatchEvent(new Event('blur'));
  await flushPromises();
}
const chip = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.presets > .preset')].find((b) => b.textContent!.includes(text))!;
let now = 0;

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useToast().items.value = [];
  now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
});
afterEach(async () => {
  await useSyncStore().flush();
  await flushPromises();
  host?.unmount();
  host = null;
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  useToast().items.value = [];
});

describe('preset-delete toast', () => {
  const six = () => { for (const n of ['A', 'B', 'C', 'D', 'E', 'F']) useUserPresetsStore().add(n, values()); };

  it('deleting 1, 2, then 3 in a row keeps one toast; Hoàn tác restores the original order', async () => {
    six();
    await setup();
    await del(1); // B
    expect(presetToasts()).toHaveLength(1);
    expect(presetToasts()[0].text).toBe(t('perf.presetDeleted', { name: 'B' }));
    await del(2); // D (now at index 2 of A C D E F)
    expect(presetToasts()).toHaveLength(1);
    expect(presetToasts()[0].text).toBe(t('perf.presetsDeleted', { n: 2, names: 'B, D' }));
    await del(0); // A
    expect(names()).toEqual(['C', 'E', 'F']);
    const only = presetToasts();
    expect(only).toHaveLength(1);
    expect(only[0].text).toBe(t('perf.presetsDeleted', { n: 3, names: 'B, D, A' }));
    expect(only[0].title).toBe('B, D, A');
    only[0].action!.run();
    await flushPromises();
    expect(names()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(stored()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    expect(presetToasts()).toHaveLength(0);
  });

  it('a delete restarts the timer of the merged toast', async () => {
    six();
    await setup();
    const x = async () => { document.body.querySelectorAll<HTMLButtonElement>('.preset-x')[0].click(); await nextTick(); }; // no flushPromises under fake timers
    vi.useFakeTimers();
    try {
      await x();
      vi.advanceTimersByTime(3000);
      await x();
      vi.advanceTimersByTime(3000); // 6 s after the first delete, 3 s after the second
      expect(presetToasts()).toHaveLength(1);
      vi.advanceTimersByTime(400);
      expect(presetToasts()).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a delete after the toast has gone starts a fresh toast of one', async () => {
    six();
    await setup();
    await del(0);
    useToast().items.value = []; // closed by the user or its timer
    await del(0);
    expect(presetToasts()[0].text).toBe(t('perf.presetDeleted', { name: 'B' }));
  });

  it('saving a new preset closes the toast and nothing is restored later', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    await del(1);
    const act = presetToasts()[0].action!;
    store.add('D', values());
    await flushPromises();
    expect(presetToasts()).toHaveLength(0);
    act.run(); // a stale click, if the button were still reachable
    await flushPromises();
    expect(names()).toEqual(['A', 'C', 'D']);
  });

  it('after one Hoàn tác, a new save still closes a later delete toast (PT9)', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    await del(0); // A
    presetToasts()[0].action!.run();
    await flushPromises();
    expect(names()).toEqual(['A', 'B', 'C']);
    await del(1); // B
    expect(presetToasts()).toHaveLength(1);
    store.add('D', values());
    await flushPromises();
    expect(presetToasts()).toHaveLength(0);
  });

  it('Hoàn tác twice restores once', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    await del(1);
    const act = presetToasts()[0].action!;
    act.run();
    act.run();
    await flushPromises();
    expect(names()).toEqual(['A', 'B', 'C']);
    expect(stored()).toEqual(['A', 'B', 'C']);
  });

  it('the Hoàn tác button names what it undoes (one preset, n presets)', async () => {
    six();
    await setup();
    const el = document.createElement('div');
    document.body.appendChild(el);
    host = createApp(ToastHost);
    host.mount(el);
    await del(1);
    await flushPromises();
    const btn = () => el.querySelector<HTMLButtonElement>('.toast__act')!;
    expect(btn().getAttribute('aria-label')).toBe(t('perf.presetUndoOne', { name: 'B' }));
    await del(0);
    await flushPromises();
    expect(btn().getAttribute('aria-label')).toBe(t('perf.presetUndoMany', { n: 2 }));
    expect(el.querySelector('.toast__text')!.getAttribute('title')).toBe('B, A');
    btn().click();
    await flushPromises();
    expect(names()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
  });

  it('next to an all-keys edit: two toasts, each Hoàn tác undoes only its own thing, no board write from presets', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    const { perf, setPerf, history } = await setup();
    const before = snapshot(perf);
    await typeActuation('1.7');
    const edited = snapshot(perf);
    await useSyncStore().flush();
    const writes = setPerf.mock.calls.length;
    await del(1);
    expect(withAction()).toHaveLength(2);
    // the preset Hoàn tác restores the preset and leaves the board values alone
    presetToasts()[0].action!.run();
    await flushPromises();
    expect(names()).toEqual(['A', 'B', 'C']);
    expect(snapshot(perf)).toEqual(edited);
    expect(history.canUndo).toBe(true);
    // delete again: the board-history Hoàn tác undoes the edit and leaves the delete alone
    await del(1);
    const editToast = toasts().find((x) => !isPresetDelete(x) && x.action)!;
    editToast.action!.run();
    expect(snapshot(perf)).toEqual(before);
    expect(names()).toEqual(['A', 'C']);
    expect(presetToasts()).toHaveLength(1);
    await useSyncStore().flush();
    setPerf.mockClear();
    presetToasts()[0].action!.run();
    await flushPromises();
    await useSyncStore().flush();
    expect(names()).toEqual(['A', 'B', 'C']);
    expect(setPerf).not.toHaveBeenCalled();
    expect(writes).toBeGreaterThan(0); // the edit itself did write: the spy works
  });

  it('restore with a full list is guarded', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    await del(1);
    const act = presetToasts()[0].action!;
    // Fill the list behind the page's back: the guard is the last line of defence.
    store.presets = [...store.presets, ...['X', 'Y', 'Z', 'W'].map((n, i) => ({ ...store.presets[0], id: `x${i}`, name: n }))];
    act.run();
    await flushPromises();
    expect(store.presets.length).toBe(6);
  });
});

describe('history undo toast', () => {
  it('T6: a preset that changes nothing shows no Hoàn tác toast', async () => {
    const { perf, history } = await setup();
    await typeActuation('1.7');
    now += 1000;
    chip(t('perf.presetTyping')).click();
    await flushPromises();
    now += 1000;
    const applied = snapshot(perf);
    chip(t('perf.presetTyping')).click(); // every key already has these values
    await flushPromises();
    expect(snapshot(perf)).toEqual(applied);
    expect(withAction()).toHaveLength(0);
    const shown = toasts().find((x) => x.text === t('perf.presetApplied', { name: t('perf.presetTyping'), n: 64 }))!;
    expect(shown).toBeDefined();
    expect(history.canUndo).toBe(true); // the older entries are untouched
  });

  it('T3: a new all-keys edit while an older undo toast is up leaves exactly one', async () => {
    const { perf } = await setup();
    await typeActuation('1.7');
    const first = withAction();
    expect(first).toHaveLength(1);
    now += 1000;
    chip(t('perf.presetTyping')).click();
    await flushPromises();
    now += 1000;
    await typeActuation('1.9');
    expect(withAction()).toHaveLength(1);
    expect(withAction()[0].id).not.toBe(first[0].id);
    withAction()[0].action!.run();
    expect(perf.values[ALL[0]].rtFirstTouch).not.toBe(1.9);
  });
});
