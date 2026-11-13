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
import { PRESETS, usePerformanceStore } from '../src/stores/performance';
import { t } from '../src/i18n/vi';

const id = (n: string) => PHYSICAL_KEYS.find((k) => k.name === n)!.id;
const E = id('E');
const Q = id('Q');
const W = id('W');

let w: VueWrapper | null = null;

async function setup(select: number[]) {
  const device = useDeviceStore();
  await device.connectDemo();
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const setPerf = vi.spyOn(mock, 'setPerformance');
  // Standard keys with an old, different RT field, as a keyboard that was never touched by this app (store only, no write).
  for (const k of [Q, W]) perf.values = { ...perf.values, [k]: { ...perf.values[k], mode: 0, normalPress: 2, rtFirstTouch: 0.5 } };
  useSelectionStore().selectMany(select);
  ({ w } = await mountPerformance('travel', {}, { stubs: { KeyboardView: true } }));
  await flushPromises();
  return { mock, perf, setPerf };
}
const both = (perf: ReturnType<typeof usePerformanceStore>, k: number) => [perf.values[k].normalPress, perf.values[k].rtFirstTouch];
const seg = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.seg button')].find((b) => b.textContent?.trim() === label)!;
const actInput = () => document.body.querySelector<HTMLInputElement>(`.act input[aria-label="${t('perf.actuation')}"]`)!;
const hasRtCard = () => document.body.querySelector('.c-rt') !== null;
async function flush() {
  await flushPromises();
  await useSyncStore().flush();
}

describe('one actuation point for Standard and Rapid Trigger', () => {
  beforeEach(() => setActivePinia(createPinia()));
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('loading a profile with unequal fields (E: normalPress 2, rtFirstTouch 1) writes nothing', async () => {
    const { perf, setPerf } = await setup([E]);
    expect(both(perf, E)).toEqual([2, 1]);
    expect(both(perf, Q)).toEqual([2, 0.5]);
    await flush();
    expect(setPerf).not.toHaveBeenCalled();
  });

  it('RT 1.00 -> Standard shows and stores 1.00, and back to RT keeps it', async () => {
    const { perf, setPerf } = await setup([E]);
    expect(actInput().value).toBe('1.00');
    seg(t('perf.modeStandard')).click();
    await flush();
    expect(perf.values[E].mode).toBe(0);
    expect(both(perf, E)).toEqual([1, 1]);
    expect(actInput().value).toBe('1.00');
    expect(setPerf).toHaveBeenCalledTimes(1);
    seg(t('perf.modeRt')).click();
    await flush();
    expect(perf.values[E].mode).toBe(1);
    expect(both(perf, E)).toEqual([1, 1]);
    expect(actInput().value).toBe('1.00');
  });

  it('Standard 2.00 -> RT shows 2.00; one write per edited key; undo restores both fields', async () => {
    const { perf, setPerf } = await setup([Q, W]);
    const before = [Q, W].map((k) => ({ ...perf.values[k] }));
    expect(before.every((p) => p.mode === 0)).toBe(true);
    seg(t('perf.modeRt')).click();
    await flush();
    expect(both(perf, Q)).toEqual([2, 2]);
    expect(both(perf, W)).toEqual([2, 2]);
    expect(actInput().value).toBe('2.00');
    expect(setPerf).toHaveBeenCalledTimes(2);
    useHistoryStore().undo();
    await flush();
    expect(perf.values[Q].mode).toBe(0);
    expect(both(perf, Q)).toEqual([2, 0.5]);
    expect(both(perf, W)).toEqual([2, 0.5]);
  });

  it('typed value and ± step on a mixed selection write equal fields', async () => {
    const { perf, setPerf } = await setup([E, Q]);
    const orig = [E, Q].map((k) => ({ ...perf.values[k] }));
    actInput().value = '1.5';
    actInput().dispatchEvent(new Event('input'));
    actInput().dispatchEvent(new Event('blur'));
    await flush();
    for (const k of [E, Q]) expect(both(perf, k)).toEqual([1.5, 1.5]);
    expect(setPerf).toHaveBeenCalledTimes(2);
    expect(perf.values[E].mode).toBe(orig[0].mode);

    // Undo restores both fields of both keys.
    useHistoryStore().undo();
    await flush();
    expect(both(perf, E)).toEqual([orig[0].normalPress, orig[0].rtFirstTouch]);
    expect(both(perf, Q)).toEqual([orig[1].normalPress, orig[1].rtFirstTouch]);

    // ± on a mixed field steps each key from the value its own mode shows, and writes equal fields.
    setPerf.mockClear();
    const shown = [E, Q].map((k) => (perf.values[k].mode === 0 ? perf.values[k].normalPress : perf.values[k].rtFirstTouch));
    expect(new Set(shown).size).toBe(2);
    document.body.querySelector<HTMLButtonElement>(`.act button[aria-label="${t('ui.increase')} ${t('perf.actuation')}"]`)!.click();
    await flush();
    [E, Q].forEach((k, i) => expect(both(perf, k)).toEqual([+(shown[i] + 0.01).toFixed(3), +(shown[i] + 0.01).toFixed(3)]));
    expect(setPerf).toHaveBeenCalledTimes(2);
  });

  it('each preset leaves equal fields', async () => {
    const { perf } = await setup([E, Q]);
    for (const p of PRESETS) {
      expect(p.values.normalPress).toBe(p.values.rtFirstTouch);
      const idx = [...document.body.querySelectorAll<HTMLButtonElement>('.presets > .preset')][PRESETS.indexOf(p)];
      idx.click();
      await flush();
      for (const k of [E, Q]) {
        expect(both(perf, k)[0]).toBe(both(perf, k)[1]);
        expect(perf.values[k].normalPress).toBe(p.values.normalPress);
      }
    }
  });

  it('shows the Rapid Trigger card only when an RT key is selected', async () => {
    await setup([Q]);
    expect(hasRtCard()).toBe(false);
    useSelectionStore().selectMany([Q, E]);
    await flushPromises();
    expect(hasRtCard()).toBe(true);
  });
});
