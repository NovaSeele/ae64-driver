// The Mẫu cài đặt card on Hành trình: built-in apply, saved rows (0, 3, 6), delete with undo at the same index, the save button and its reason.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { mountPerformance } from './mountPerformance';
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
  ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
  await flushPromises();
  const exchange = vi.spyOn(device.transport as MockTransport as unknown as { exchange: () => unknown }, 'exchange');
  return { perf, exchange, history: useHistoryStore() };
}
const rows = () => [...document.body.querySelectorAll<HTMLElement>('.preset-row')];
const names = () => rows().map((r) => r.querySelector('.preset__name')!.textContent);
const saveBtn = () => document.body.querySelector<HTMLButtonElement>('.presets__save button')!;
const why = () => document.body.querySelector('.presets__save .hint');
const stored = () => (JSON.parse(localStorage.getItem(STORAGE_KEY)!) as UserPreset[]).map((p) => p.name);

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

const savedCard = () => document.body.querySelector<HTMLElement>('.saved .card')!;

describe('Mẫu riêng card', () => {
  it('is always shown, in its own row outside the column grid, with "n/6" and the empty line', async () => {
    await setup();
    expect(savedCard().textContent).toContain(t('perf.presetsOwn'));
    expect(savedCard().textContent).toContain(t('perf.presetsOwnSub', { n: 0, max: 6 }));
    expect(savedCard().textContent).toContain(t('perf.presetsEmpty'));
    expect(savedCard().querySelector('.presets__save button')).not.toBeNull();
    expect(document.body.querySelector('.grid .saved')).toBeNull();
    expect(document.body.querySelector('.pcol .saved')).toBeNull();
    expect(document.body.querySelector('.grid .presets__save')).toBeNull();
  });

  it('row 1 (the column grid) is identical with 0 and 6 saved presets; the saved card is not in it', async () => {
    await setup();
    const grid = () => document.body.querySelector<HTMLElement>('.grid')!;
    const empty = grid().innerHTML;
    for (let i = 0; i < 6; i++) useUserPresetsStore().add(`P${i}`, values());
    await flushPromises();
    expect(rows()).toHaveLength(6);
    expect(savedCard().textContent).toContain(t('perf.presetsOwnSub', { n: 6, max: 6 }));
    expect(savedCard().textContent).not.toContain(t('perf.presetsEmpty'));
    expect(grid().innerHTML).toBe(empty);
    expect(grid().nextElementSibling).toBe(document.body.querySelector('.saved'));
    for (const x of [...useUserPresetsStore().presets]) useUserPresetsStore().remove(x.id);
    await flushPromises();
    expect(grid().innerHTML).toBe(empty);
  });
});

describe('Mẫu cài đặt card', () => {
  it('holds the three built-ins only', async () => {
    await setup();
    const card = [...document.body.querySelectorAll<HTMLElement>('.pcol .card')].find((c) => c.textContent!.includes(t('perf.presetTyping')))!;
    expect(card.querySelectorAll('.preset')).toHaveLength(3);
    expect(card.querySelector('.presets__save')).toBeNull();
  });

  it('a built-in preset is one history entry', async () => {
    const { perf, history } = await setup();
    const before = perf.values[ALL[0]].rtFirstTouch;
    const typing = [...document.body.querySelectorAll<HTMLButtonElement>('.presets > .preset')].find((b) => b.textContent!.includes(t('perf.presetTyping')))!;
    typing.click();
    await flushPromises();
    expect(perf.values[ALL[0]].rtFirstTouch).not.toBe(before);
    history.undo();
    expect(perf.values[ALL[0]].rtFirstTouch).toBe(before);
    expect(history.canUndo).toBe(false); // exactly one entry
  });

  it.each([0, 3, 6])('%i saved presets: that many rows, each with its meta line and ×', async (n) => {
    const store = useUserPresetsStore();
    for (let i = 0; i < n; i++) store.add(`P${i}`, values());
    await setup();
    expect(rows()).toHaveLength(n);
    for (const r of rows()) {
      expect(r.querySelector('.preset__desc')!.textContent).toBe(t('perf.presetUserMeta', { mode: 'RT', act: '0.40' }));
      expect(r.querySelector('.preset-x')).not.toBeNull();
    }
    expect(document.body.querySelectorAll('.presets > .preset')).toHaveLength(3 + 0); // built-ins only (saved rows are wrapped)
    expect(saveBtn().textContent!.trim()).toBe(t('perf.presetSaveCurrent'));
    if (n === 6) {
      expect(saveBtn().disabled).toBe(true);
      expect(why()!.textContent).toBe(t('perf.presetFull', { n: 6 }));
    } else {
      expect(saveBtn().disabled).toBe(false);
      expect(why()).toBeNull();
    }
  });

  it('applying a saved row is one history entry', async () => {
    useUserPresetsStore().add('Nhạy', values());
    const { perf, history } = await setup();
    document.body.querySelector<HTMLButtonElement>('.preset-row .preset')!.click();
    await flushPromises();
    expect(perf.values[ALL[0]].rtFirstTouch).toBe(0.4);
    history.undo();
    expect(perf.values[ALL[0]].rtFirstTouch).toBe(1);
    expect(history.canUndo).toBe(false);
  });

  it('× deletes, then the toast Hoàn tác restores the preset at the same index', async () => {
    const store = useUserPresetsStore();
    for (const n of ['A', 'B', 'C']) store.add(n, values());
    await setup();
    document.body.querySelectorAll<HTMLButtonElement>('.preset-x')[1].click();
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

  it('mixed values: the save button is disabled and the reason is a caption under it', async () => {
    const { perf } = await setup();
    expect(saveBtn().disabled).toBe(false);
    perf.values = { ...perf.values, [ALL[3]]: { ...perf.values[ALL[3]], normalPress: 2, rtFirstTouch: 2 } };
    await flushPromises();
    expect(saveBtn().disabled).toBe(true);
    expect(why()!.textContent).toBe(t('perf.presetMixed'));
    expect(saveBtn().getAttribute('aria-describedby')).toBe(why()!.id);
  });

  it('the save button opens the dialog; browsing the card sends nothing to the keyboard', async () => {
    useUserPresetsStore().add('A', values());
    const { exchange } = await setup();
    saveBtn().click();
    await flushPromises();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();
    expect(exchange).not.toHaveBeenCalled();
  });
});
