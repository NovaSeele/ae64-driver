// CSW step 1: travelLimitMm, fitTravel, and switch plan/apply parity with the guard (DESIGN §7.2, §19 Test 21).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { findSwitch, switchCatalogFor } from '../src/protocol/switches';
import { DIST_FIELDS, checkPerformanceWrite } from '../src/protocol/safety';
import { LIMITS, fitTravel, travelLimitMm, usePerformanceStore } from '../src/stores/performance';
import type { PerfEdit } from '../src/stores/performance';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { formatMm } from '../src/components/ui/NumberField.vue';
import { switchName } from '../src/data/switchDisplay';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

const baseEdit = (over: Partial<PerfEdit> = {}): PerfEdit => ({
  mode: 0,
  normalPress: 2.0,
  normalRelease: 2.0,
  rtFirstTouch: 1.0,
  rtPress: 0.5,
  rtRelease: 0.5,
  pressDeadStroke: 0.1,
  releaseDeadStroke: 0.1,
  ...over,
});

describe('travelLimitMm and fitTravel (DESIGN §7.2, Test 21)', () => {
  it('travelLimitMm caps at MAX_TRAVEL_MM = 4.0 (kills M30)', () => {
    expect(travelLimitMm(3390)).toBe(3.39);
    expect(travelLimitMm(4015)).toBe(4.0);
    expect(travelLimitMm(4000)).toBe(4.0);
    expect(travelLimitMm(1000)).toBe(1.0);
    expect(travelLimitMm(3130)).toBe(3.13);
  });

  it('clamps travel fields to travelLimitMm (including the 4.0 mm cap on R 4015) without mutating input (kills M30)', () => {
    const orig = baseEdit({ normalPress: 4.01, normalRelease: 4.01 });
    const snapshot = { ...orig };
    const res = fitTravel(orig, 4015);
    expect(orig).toEqual(snapshot); // never mutates input
    expect(res.edit).not.toBe(orig);
    expect(res.edit.normalPress).toBe(4.0);
    expect(res.edit.normalRelease).toBe(4.0);
    expect(res.clamped).toEqual([
      { field: 'normalPress', from: 4.01, to: 4.0 },
      { field: 'normalRelease', from: 4.01, to: 4.0 },
    ]);

    const rt = fitTravel(baseEdit({ rtRelease: 3.6 }), 3390);
    expect(rt.edit.rtRelease).toBe(3.39);
    expect(rt.clamped).toEqual([{ field: 'rtRelease', from: 3.6, to: 3.39 }]);
  });

  it('clamps dead-zone values above the limit to LIMITS.deadMax (1.0 mm), not the limit (kills M30 and M31)', () => {
    const res = fitTravel(baseEdit({ pressDeadStroke: 3.5, releaseDeadStroke: 0.9 }), 3390);
    expect(res.edit.pressDeadStroke).toBe(LIMITS.deadMax);
    expect(res.edit.pressDeadStroke).toBe(1.0);
    expect(res.edit.releaseDeadStroke).toBe(0.9);
    expect(res.clamped).toEqual([{ field: 'pressDeadStroke', from: 3.5, to: 1.0 }]);

    const both = fitTravel(baseEdit({ pressDeadStroke: 3.5, releaseDeadStroke: 3.8 }), 3390);
    expect(both.edit.pressDeadStroke).toBe(1.0);
    expect(both.edit.releaseDeadStroke).toBe(1.0);
    expect(both.clamped).toEqual([
      { field: 'pressDeadStroke', from: 3.5, to: 1.0 },
      { field: 'releaseDeadStroke', from: 3.8, to: 1.0 },
    ]);
  });

  it('leaves values at or under the limit untouched (within 1e-9 tolerance) and never raises anything', () => {
    const atLimit = baseEdit({
      normalPress: 3.39,
      normalRelease: 3.39,
      rtFirstTouch: 3.39,
      rtPress: 3.39,
      rtRelease: 3.39,
      pressDeadStroke: 3.39,
      releaseDeadStroke: 0.0,
    });
    const res = fitTravel(atLimit, 3390);
    expect(res.edit).toEqual(atLimit);
    expect(res.clamped).toEqual([]);

    const at4 = baseEdit({ normalPress: 4.0, rtFirstTouch: 4.0 + 1e-10, pressDeadStroke: 0.05 });
    const res4 = fitTravel(at4, 4015);
    expect(res4.edit).toEqual(at4);
    expect(res4.clamped).toEqual([]);
  });

  it('property test: for every catalog entry of both boards and custom bounds (3130, 4015), all 7 fields at 5.0 pass checkPerformanceWrite after fitTravel (kills M30 and M31)', () => {
    const allFive: PerfEdit = {
      mode: 1,
      normalPress: 5.0,
      normalRelease: 5.0,
      rtFirstTouch: 5.0,
      rtPress: 5.0,
      rtRelease: 5.0,
      pressDeadStroke: 5.0,
      releaseDeadStroke: 5.0,
    };
    const boards = ['0030000d', '0030000a'] as const;
    for (const boardIdHex of boards) {
      const catalog = switchCatalogFor(boardIdHex)!;
      const start: Performance = {
        ...allFive,
        axis: 0,
        calibrate: 1,
        axisV2Id: 12432,
        axisRangeMax: 3310,
        axisCoefficient: 20500,
      };
      // Every catalog entry of this board
      for (const entry of catalog) {
        const fitted = fitTravel(allFive, entry.rangeMax);
        expect(fitted.clamped.map((c) => c.field)).toEqual([...DIST_FIELDS]);
        expect(fitted.edit.pressDeadStroke).toBe(1.0);
        expect(fitted.edit.releaseDeadStroke).toBe(1.0);
        const next: Performance = {
          ...start,
          ...fitted.edit,
          axisV2Id: entry.id,
          axisRangeMax: entry.rangeMax,
          axisCoefficient: entry.coefficient,
        };
        expect(checkPerformanceWrite(next, [start], { boardIdHex }), `${boardIdHex} id ${entry.id}`).toBeNull();
      }
      // Custom bounds (3130 / 26800 and 4015 / 13300) keeping the key's own id
      for (const [r, c] of [[3130, 26800], [4015, 13300]] as const) {
        const fitted = fitTravel(allFive, r);
        expect(fitted.clamped.map((x) => x.field)).toEqual([...DIST_FIELDS]);
        expect(fitted.edit.pressDeadStroke).toBe(1.0);
        expect(fitted.edit.releaseDeadStroke).toBe(1.0);
        const next: Performance = { ...start, ...fitted.edit, axisRangeMax: r, axisCoefficient: c };
        expect(checkPerformanceWrite(next, [start], { boardIdHex }), `${boardIdHex} custom ${r}/${c}`).toBeNull();
      }
    }
  });
});

describe('planSwitch, applySwitch and SwitchPicker parity with fitTravel (Test 21)', () => {
  let w: VueWrapper | null = null;
  const body = () => document.body;
  const opt = (name: string) => [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === name)!;
  const warns = () => [...body().querySelectorAll('.swp__warn')].map((p) => p.textContent);

  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
  });

  async function mountCard(ids: number[]) {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(SwitchCard, { props: { ids }, global: { plugins: [router] }, attachTo: document.body });
    (w.find('.swc__foot button').element as HTMLElement).click();
    await flushPromises();
  }

  it('actuation 4.01 on a 4015 list switch clamps to 4.0 with one sw.clampAct line at 4.0 and Apply succeeds (kills M30)', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const mock = device.transport as MockTransport;
    // Put a key with actuation 4.01 directly in the mock's active profile (simulating a record from another app).
    const pos = `${W.row}:${W.col}`;
    const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number };
    const rec = m.profiles[m.active].perf.get(pos)!;
    rec[0] = 0; // mode 0 (Standard)
    rec[1] = 4010 & 0xff; rec[2] = 4010 >>> 8; // normalPress 4.01 mm
    rec[3] = 4010 & 0xff; rec[4] = 4010 >>> 8; // normalRelease 4.01 mm

    const perf = usePerformanceStore();
    await perf.load();
    const white4015 = findSwitch(perf.catalog, 4416)!;
    expect(white4015.rangeMax).toBe(4015);

    const plan = perf.planSwitch([W.id], white4015);
    expect(plan.limitMm).toBe(4.0);
    expect(plan.clamped).toEqual([
      { id: W.id, field: 'normalPress', from: 4.01, to: 4.0 },
      { id: W.id, field: 'normalRelease', from: 4.01, to: 4.0 },
    ]);

    await mountCard([W.id]);
    [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes('Gateron'))!.click();
    await flushPromises();
    opt(switchName(white4015)).click();
    await flushPromises();
    expect(warns()).toContain(t('sw.clampAct', { n: 1, max: formatMm(4.0, 3) }));
    expect(warns().some((line) => line?.includes(t('sw.clampOther', { n: 1, max: formatMm(4.0, 3) })))).toBe(false);

    perf.applySwitch([W.id], white4015);
    await useSyncStore().flush();
    expect(useSyncStore().state).toBe('saved');
    const after = await mock.getPerformance(W);
    expect(after.axisV2Id).toBe(4416);
    expect(after.axisRangeMax).toBe(4015);
    expect(after.normalPress).toBe(4.0);
    expect(after.normalRelease).toBe(4.0);
  });

  it('a key with a deep dead zone: planSwitch counts it under sw.clampOther, Apply writes 1.0 and the transport accepts it with no refusal (kills M30 and M31)', async () => {
    const device = useDeviceStore();
    await device.connectDemo();
    const mock = device.transport as MockTransport;
    // Seed a deep dead zone (3.5 mm) in the mock (as another app could write), while actuation stays 2.0 mm.
    const pos = `${W.row}:${W.col}`;
    const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number };
    const rec = m.profiles[m.active].perf.get(pos)!;
    rec[11] = 3500 & 0xff; rec[12] = 3500 >>> 8; // pressDeadStroke 3.5 mm
    rec[13] = 3500 & 0xff; rec[14] = 3500 >>> 8; // releaseDeadStroke 3.5 mm

    const perf = usePerformanceStore();
    await perf.load();
    const jadePro = findSwitch(perf.catalog, 4128)!; // rangeMax 3390
    expect(jadePro.rangeMax).toBe(3390);

    const plan = perf.planSwitch([W.id], jadePro);
    expect(plan.limitMm).toBe(3.39);
    expect(plan.clamped).toEqual([
      { id: W.id, field: 'pressDeadStroke', from: 3.5, to: 1.0 },
      { id: W.id, field: 'releaseDeadStroke', from: 3.5, to: 1.0 },
    ]);

    await mountCard([W.id]);
    [...body().querySelectorAll<HTMLElement>('[role=tab]')].find((x) => x.textContent?.includes('Gateron'))!.click();
    await flushPromises();
    opt(switchName(jadePro)).click();
    await flushPromises();
    expect(warns()).toContain(t('sw.clampOther', { n: 1, max: formatMm(3.39, 3) }));
    expect(warns().some((line) => line?.includes(t('sw.clampAct', { n: 1, max: formatMm(3.39, 3) })))).toBe(false);

    perf.applySwitch([W.id], jadePro);
    await useSyncStore().flush();
    expect(useSyncStore().state).toBe('saved');
    const after = await mock.getPerformance(W);
    expect(after).toMatchObject({
      axisV2Id: 4128,
      axisRangeMax: 3390,
      axisCoefficient: 20000,
      pressDeadStroke: 1.0,
      releaseDeadStroke: 1.0,
    });
  });
});
