// PRESET-SAVE-1: after a preset save the footer is scrolled above the toast, focus stays on a live control, and a save that
// fills the list says so. Presets are localStorage only: 0 HID.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { PHYSICAL_KEYS } from '../src/protocol';
import { mountPerformance } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { usePerformanceStore } from '../src/stores/performance';
import { useUserPresetsStore } from '../src/stores/userPresets';
import type { UserPreset } from '../src/stores/userPresets';
import { useToast } from '../src/components/ui/toast';
import { t } from '../src/i18n/vi';

const ALL = PHYSICAL_KEYS.map((k) => k.id);
vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
const values = (): Omit<UserPreset, 'id' | 'name'> => ({ mode: 1, continuous: true, actuation: 0.4, rtPress: 0.2, rtRelease: 0.25, deadTop: 0.05, deadBottom: 0.07 });
const scrollSpy = vi.fn();

async function setup(before: number) {
  for (let i = 0; i < before; i++) useUserPresetsStore().add(`P${i}`, values());
  const device = useDeviceStore();
  await device.connectDemo('max');
  const perf = usePerformanceStore();
  await perf.load();
  const v = { ...perf.values };
  for (const k of ALL) v[k] = { ...v[k], mode: 1, normalPress: 1, normalRelease: 1, rtFirstTouch: 1, rtPress: 0.3, rtRelease: 0.3, pressDeadStroke: 0.1, releaseDeadStroke: 0.1 };
  perf.values = v;
  useSelectionStore().selectMany([]);
  ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
  await flushPromises();
}
const saveBtn = () => document.body.querySelector<HTMLButtonElement>('.presets__save button')!;
async function save(name: string) {
  saveBtn().click();
  await flushPromises();
  const input = document.body.querySelector<HTMLInputElement>('.save__input')!;
  input.value = name;
  input.dispatchEvent(new Event('input'));
  await flushPromises();
  document.body.querySelector('form.save')!.dispatchEvent(new Event('submit', { cancelable: true }));
  await flushPromises();
  await new Promise((r) => setTimeout(r, 650)); // the capped wait for the toast host (none in jsdom) + a frame
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  useToast().items.value = [];
  scrollSpy.mockClear();
  Element.prototype.scrollIntoView = scrollSpy;
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

describe('preset save result', () => {
  it('the 6th save focuses the new row\'s apply button and the toast says the list is full', async () => {
    await setup(5);
    await save('Sáu');
    expect(saveBtn().disabled).toBe(true);
    const active = document.activeElement as HTMLElement;
    expect(active).not.toBe(document.body);
    expect(active.classList.contains('preset')).toBe(true);
    expect(active.querySelector('.preset__name')!.textContent).toBe('Sáu');
    expect(useToast().items.value.map((x) => x.text)).toContain(t('perf.presetSavedFull', { name: 'Sáu', n: 6 }));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect((scrollSpy.mock.contexts[0] as HTMLElement).id).toBe('perf-save-why');
    expect(scrollSpy.mock.calls[0][0]).toMatchObject({ block: 'nearest' });
  });

  it('the 1st save focuses the save button, uses the plain toast and scrolls to the button', async () => {
    await setup(0);
    await save('Một');
    expect(document.activeElement).toBe(saveBtn());
    const texts = useToast().items.value.map((x) => x.text);
    expect(texts).toContain(t('perf.presetSaved', { name: 'Một' }));
    expect(texts).not.toContain(t('perf.presetSavedFull', { name: 'Một', n: 6 }));
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy.mock.contexts[0]).toBe(saveBtn());
  });

  it('another toast does not scroll', async () => {
    await setup(0);
    useToast().show('hello', 'info');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 100));
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
