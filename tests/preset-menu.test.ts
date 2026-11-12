// The "Mẫu riêng" menu on the Hành trình toolbar: apply, delete with undo, empty state, disabled save, Esc and focus.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import PerformancePage from '../src/pages/PerformancePage.vue';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { useUserPresetsStore } from '../src/stores/userPresets';
import type { UserPreset } from '../src/stores/userPresets';
import { useToast } from '../src/components/ui/toast';
import { t } from '../src/i18n/vi';

const ALL = PHYSICAL_KEYS.map((k) => k.id);
const STORAGE_KEY = 'ae64.perf.userPresets';
vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
const values = (over: Partial<UserPreset> = {}): Omit<UserPreset, 'id' | 'name'> => ({
  mode: 1, continuous: true, actuation: 0.4, rtPress: 0.2, rtRelease: 0.25, deadTop: 0.05, deadBottom: 0.07, ...over,
});

async function setup() {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const perf = usePerformanceStore();
  await perf.load();
  const v = { ...perf.values };
  for (const k of ALL) v[k] = { ...v[k], mode: 1, normalPress: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 };
  perf.values = v;
  useSelectionStore().selectMany([]);
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(PerformancePage, { global: { plugins: [router], stubs: { KeyboardView: true } }, attachTo: document.body });
  await flushPromises();
  const exchange = vi.spyOn(device.transport as MockTransport as unknown as { exchange: () => unknown }, 'exchange');
  return { perf, exchange, history: useHistoryStore() };
}
const btn = () => document.body.querySelector<HTMLButtonElement>('.umenu__btn')!;
const rows = () => [...document.body.querySelectorAll<HTMLElement>('.umenu__row')];
const names = () => rows().map((r) => r.querySelector('.umenu__name')!.textContent);
const saveItem = () => document.body.querySelector<HTMLButtonElement>('.umenu__save')!;
const isOpen = () => document.body.querySelector('.umenu') !== null;
const stored = () => (JSON.parse(localStorage.getItem(STORAGE_KEY)!) as UserPreset[]).map((p) => p.name);
async function open() {
  btn().click();
  await flushPromises();
}
const key = (el: Element, k: string) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useToast().items.value = [];
});
afterEach(async () => {
  await useSyncStore().flush();
  await flushPromises();
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  useToast().items.value = [];
});

describe('Mẫu riêng menu', () => {
  it('applying from the menu is one history entry; the menu closes and focus returns to the button', async () => {
    useUserPresetsStore().add('Nhạy', values());
    const { perf, history } = await setup();
    await open();
    expect(btn().getAttribute('aria-expanded')).toBe('true');
    document.body.querySelector<HTMLButtonElement>('.umenu__use')!.click();
    await flushPromises();
    expect(perf.values[ALL[0]].rtFirstTouch).toBe(0.4);
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(btn());
    history.undo();
    expect(perf.values[ALL[0]].rtFirstTouch).toBe(1);
    expect(history.canUndo).toBe(false); // exactly one entry
  });

  it('opening focuses the first row; ArrowDown/Up move between the names and the save item', async () => {
    const store = useUserPresetsStore();
    store.add('A', values());
    store.add('B', values());
    await setup();
    await open();
    await flushPromises();
    const uses = [...document.body.querySelectorAll<HTMLButtonElement>('.umenu__use')];
    expect(document.activeElement).toBe(uses[0]);
    key(uses[0], 'ArrowDown');
    expect(document.activeElement).toBe(uses[1]);
    key(uses[1], 'ArrowDown');
    expect(document.activeElement).toBe(saveItem());
    key(saveItem(), 'ArrowUp');
    expect(document.activeElement).toBe(uses[1]);
  });

  it('ArrowDown on the closed button opens it', async () => {
    await setup();
    key(btn(), 'ArrowDown');
    await flushPromises();
    expect(isOpen()).toBe(true);
  });

  it('delete, then the toast Hoàn tác restores the preset at the same index', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    await open();
    document.body.querySelectorAll<HTMLButtonElement>('.umenu__x')[1].click();
    await flushPromises();
    expect(names()).toEqual(['A', 'C']);
    expect(stored()).toEqual(['A', 'C']);
    const toast = useToast().items.value.find((x) => x.text === t('perf.presetDeleted', { name: 'B' }))!;
    expect(toast.action!.label).toBe(t('history.undo'));
    toast.action!.run();
    await flushPromises();
    expect(names()).toEqual(['A', 'B', 'C']);
    expect(stored()).toEqual(['A', 'B', 'C']);
  });

  it('Delete on a focused row deletes it and focuses the row that took its place', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    await open();
    const first = document.body.querySelector<HTMLButtonElement>('.umenu__use')!;
    first.focus();
    key(first, 'Delete');
    await flushPromises();
    expect(names()).toEqual(['B', 'C']);
    expect(document.activeElement).toBe(document.body.querySelector('.umenu__use'));
  });

  it('empty state, with the save item still there', async () => {
    await setup();
    expect(btn().textContent).toContain(t('perf.userPresets'));
    await open();
    expect(document.body.querySelector('.umenu__empty')!.textContent).toBe(t('perf.userPresetsEmpty'));
    expect(rows()).toHaveLength(0);
    expect(saveItem().disabled).toBe(false);
  });

  it('mixed values: the save item is disabled and the reason is a caption', async () => {
    const { perf } = await setup();
    perf.values = { ...perf.values, [ALL[3]]: { ...perf.values[ALL[3]], normalPress: 2, rtFirstTouch: 2 } };
    await flushPromises();
    await open();
    expect(saveItem().disabled).toBe(true);
    expect(document.body.querySelector('.umenu__why')!.textContent).toBe(t('perf.presetMixed'));
  });

  it('Esc closes the menu and returns focus to the button', async () => {
    useUserPresetsStore().add('A', values());
    await setup();
    await open();
    key(document.body.querySelector('.umenu__use')!, 'Escape');
    await flushPromises();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(btn());
  });

  it('opening and closing sends nothing to the keyboard', async () => {
    useUserPresetsStore().add('A', values());
    const { exchange } = await setup();
    await open();
    key(document.body.querySelector('.umenu__use')!, 'Escape');
    await flushPromises();
    await open();
    btn().click();
    await flushPromises();
    expect(isOpen()).toBe(false);
    expect(exchange).not.toHaveBeenCalled();
  });
});
