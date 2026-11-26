// WX6 item 0: tests for the WX5 reviewer mutants that survived (review/WX5-tests/mutWX5.cjs, numbers in brackets), and
// N-WX5-1 (a step further out of range writes nothing). Demo / mock only: no real keyboard.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { mountPerformance } from './mountPerformance';
import type { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { useAdvancedStore } from '../src/stores/advanced';
import type { DksAssignment } from '../src/stores/advanced';
import { useSyncStore } from '../src/stores/sync';
import { useUserPresetsStore } from '../src/stores/userPresets';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { useToast } from '../src/components/ui/toast';
import NumberField from '../src/components/ui/NumberField.vue';
import DksEditor from '../src/components/advanced/DksEditor.vue';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

let w: VueWrapper | null = null;
beforeEach(() => {
  localStorage.clear();
  setLocale('vi');
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 }, borderBoxSize: [{ inlineSize: 900, blockSize: 300 }] }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useToast().items.value = [];
  localStorage.clear();
});

async function boot() {
  setActivePinia(createPinia());
  clearTuningSnapshots();
  const device = useDeviceStore();
  await device.connectDemo('max');
  return {
    device, perf: usePerformanceStore(), adv: useAdvancedStore(), sync: useSyncStore(), history: useHistoryStore(),
    sel: useSelectionStore(), mock: device.transport as MockTransport,
  };
}
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await flushPromises(); };
const key = (device: ReturnType<typeof useDeviceStore>, name: string) => device.keys.find((k) => k.name === name)!.id;

describe('WX6 0a.1 the vertical actuation slider on a mixed pair (SL1 #9, SL2 #10, TE1 #12, TT1 #13)', () => {
  it('ArrowDown / ArrowUp step each key by one step (0.001), PageUp / PageDown by 0.1, from its own value', async () => {
    const { device, perf, sync, sel } = await boot();
    await perf.load();
    const [a, b] = [key(device, 'Q'), key(device, 'W')];
    perf.apply([a], () => ({ mode: 0, normalPress: 1.0, rtFirstTouch: 1.0 }), 'setup');
    perf.apply([b], () => ({ mode: 0, normalPress: 2.0, rtFirstTouch: 2.0 }), 'setup');
    await sync.flush();
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    sel.selectMany([a, b]);
    await flushPromises();
    const thumb = w.find('.te [role="slider"]');
    expect(thumb.attributes('aria-orientation')).toBe('vertical');
    const now = () => [perf.values[a].normalPress, perf.values[b].normalPress];
    await thumb.trigger('keydown', { key: 'ArrowDown' }); // deeper
    await flushPromises();
    expect(now()).toEqual([1.001, 2.001]);
    await thumb.trigger('keydown', { key: 'ArrowUp' });
    await flushPromises();
    expect(now()).toEqual([1.0, 2.0]);
    await thumb.trigger('keydown', { key: 'PageUp' });
    await flushPromises();
    expect(now()).toEqual([1.1, 2.1]);
    await thumb.trigger('keydown', { key: 'PageDown' });
    await flushPromises();
    expect(now()).toEqual([1.0, 2.0]);
    await sync.flush();
  });
});

describe('WX6 0a.2 the RT press slider on a mixed pair (TT2 #14)', () => {
  it('ArrowRight moves each RT key from its own press value', async () => {
    const { device, perf, sync, sel } = await boot();
    await perf.load();
    const [a, b] = [key(device, 'Q'), key(device, 'W')];
    perf.apply([a], () => ({ mode: 1, rtPress: 0.2, rtRelease: 0.2 }), 'setup');
    perf.apply([b], () => ({ mode: 1, rtPress: 0.5, rtRelease: 0.2 }), 'setup');
    await sync.flush();
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    sel.selectMany([a, b]);
    await flushPromises();
    const thumb = w.find('.c-rt [role="slider"]');
    expect(thumb.attributes('aria-valuetext')).toContain(t('perf.mixed'));
    await thumb.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect([perf.values[a].rtPress, perf.values[b].rtPress]).toEqual([0.201, 0.501]);
    await sync.flush();
  });
});

describe('WX6 0a.3 every read-only control (TT3 #15, TT4 #16, TT6 #18, AT1 #25, AT2 #26, AT3 #27)', () => {
  async function readOnly() {
    const env = await boot();
    env.device.boardAllowed = false;
    (env.mock as unknown as { boardAllowed: boolean }).boardAllowed = false;
    return env;
  }

  it('Travel: the mode control and the RT link button are off; a saved preset that gets a click changes and queues nothing', async () => {
    const { device, perf, sync, history, sel } = await readOnly();
    const up = useUserPresetsStore();
    const p = up.add('mine', { mode: 1, continuous: false, actuation: 1.2, rtPress: 0.3, rtRelease: 0.3, deadTop: 0.1, deadBottom: 0.1 })!;
    await perf.load();
    const [a, b] = [key(device, 'Q'), key(device, 'W')];
    ({ w } = await mountPerformance('travel'));
    await settle(5);
    sel.selectMany([a, b]);
    await settle(5);
    const mode = w.find(`[role="radiogroup"][aria-label="${t('perf.mode')}"]`);
    expect(mode.exists()).toBe(true);
    expect(mode.attributes('aria-disabled')).toBe('true');
    const link = w.find(`button[title="${t('perf.rtLinkHint')}"]`);
    expect(link.exists()).toBe(true);
    expect(link.attributes('disabled')).toBeDefined();
    const mine = w.find(`button.preset[data-preset="${p.id}"]`).element as HTMLButtonElement;
    expect(mine.disabled).toBe(true);
    const before = JSON.stringify(perf.values);
    mine.disabled = false; // a click that gets through anyway: the handler refuses it too
    mine.click();
    await settle(5);
    expect(JSON.stringify(perf.values)).toBe(before);
    expect(history.canUndo).toBe(false);
    expect(sync.pendingCount()).toBe(0);
  });

  it('Advanced: every row\'s Delete, the summary\'s Edit and the add chips are off', async () => {
    const env = await boot(); // writable first: put a DKS on G to have a row and a summary
    const g = key(env.device, 'G');
    await env.adv.load();
    const dks: DksAssignment = { type: 'DKS', keys: [g], keycodes: [0x04, 0, 0, 0], travels: [0xff, 0, 0, 0], dbs: [1.0, 2.0] };
    await env.adv.save(dks);
    await env.sync.flush();
    env.device.boardAllowed = false;
    (env.mock as unknown as { boardAllowed: boolean }).boardAllowed = false;
    ({ w } = await mountPerformance('advanced'));
    await settle(5);
    env.sel.selectMany([g]);
    await settle(5);
    const deletes = w.findAll('.item button').filter((b) => (b.attributes('aria-label') ?? '').startsWith(`${t('advanced.delete')} `));
    expect(deletes.length).toBeGreaterThan(0);
    for (const b of deletes) expect(b.attributes('disabled')).toBeDefined();
    const summaryEdit = w.findAll('button').filter((b) => (b.attributes('aria-label') ?? '').startsWith(`${t('advanced.edit')} DKS`));
    expect(summaryEdit.length).toBe(1);
    expect(summaryEdit[0].attributes('disabled')).toBeDefined();
    env.sel.selectMany([key(env.device, 'H')]); // a free key: the add chips
    await settle(5);
    const chips = w.findAll('[data-add]');
    expect(chips.length).toBeGreaterThan(0);
    for (const c of chips) expect(c.attributes('disabled')).toBeDefined();
  });
});

describe('WX6 0a.4 NumberField (N-a #4, N-b #5)', () => {
  async function type(el: HTMLInputElement, v: string) {
    el.value = v;
    el.dispatchEvent(new Event('input'));
    await nextTick();
  }
  it('"1.2.3" typed, then ArrowUp: the step is from the value, no NaN emitted', async () => {
    w = mount(NumberField, { props: { modelValue: 1, min: 0.1, max: 3.3, label: 'act' }, attachTo: document.body });
    const el = w.find('input').element as HTMLInputElement;
    el.focus();
    await type(el, '1.2.3');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.emitted('update:modelValue')).toEqual([[1.01]]);
    expect(el.value).toBe('1.01');
  });

  it('the text emptied, then blur: the value is shown again and nothing is emitted', async () => {
    w = mount(NumberField, { props: { modelValue: 1.5, min: 0.1, max: 3.3, label: 'act' }, attachTo: document.body });
    const el = w.find('input').element as HTMLInputElement;
    el.focus();
    await type(el, '');
    el.blur();
    await nextTick();
    expect(w.emitted('update:modelValue')).toBeUndefined();
    expect(el.value).toBe('1.50');
  });
});

describe('WX6 0a.5 history (Y2 #3)', () => {
  it('a gesture whose steps come every 100 ms over 1.5 s is one entry', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
    setActivePinia(createPinia());
    const history = useHistoryStore();
    let v = 0;
    for (let i = 1; i <= 16; i++) {
      const to = i;
      history.push({ label: 'drag', undo: () => { v = 0; }, redo: () => { v = to; }, coalesce: 'drag' });
      v = i;
      vi.advanceTimersByTime(100);
    }
    expect(v).toBe(16);
    history.undo();
    expect(v).toBe(0);
    expect(history.canUndo).toBe(false);
    history.redo();
    expect(v).toBe(16);
  });
});

describe('WX6 0a.6 pair editors (AT6 #29)', () => {
  it('while the two keys of an SOCD are being picked, the editor body is not inert and its slot buttons work', async () => {
    const { adv } = await boot();
    await adv.load();
    ({ w } = await mountPerformance('advanced'));
    await settle(5);
    await w.find('.type[data-type="SOCD"]').trigger('click');
    await settle(5);
    const body = w.find('.ed__body');
    expect(body.classes()).not.toContain('ed__body--off');
    expect(body.attributes('inert')).toBeUndefined();
    const slots = () => w!.findAll('.side__select');
    expect(slots().map((s) => s.attributes('aria-pressed'))).toEqual(['true', 'false']);
    await slots()[1].trigger('click');
    await settle(2);
    expect(slots().map((s) => s.attributes('aria-pressed'))).toEqual(['false', 'true']);
  });
});

describe('WX6 0a.7 DKS (DK1 #24)', () => {
  it('a press on A that ends on B (drag-paint), then a click without a pointer on A toggles A', async () => {
    setActivePinia(createPinia());
    const dks: DksAssignment = { type: 'DKS', keys: [20], keycodes: [0x04, 0, 0, 0], travels: [0, 0, 0, 0], dbs: [1.0, 2.0] };
    const h = mount(DksEditor, {
      props: { modelValue: dks, firmware: undefined, 'onUpdate:modelValue': (v: DksAssignment) => h.setProps({ modelValue: v }) },
      attachTo: document.body,
    });
    w = h;
    const cell = (i: number) => h.findAll('.tl__row')[0].findAll('.cell')[i];
    const on = (i: number) => cell(i).attributes('aria-pressed') === 'true';
    cell(0).element.dispatchEvent(new PointerEvent('pointerdown', { button: 0, buttons: 1, bubbles: true, cancelable: true }));
    await nextTick();
    cell(1).element.dispatchEvent(new PointerEvent('pointerenter', { buttons: 1 }));
    await nextTick();
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    await nextTick();
    expect([on(0), on(1)]).toEqual([true, true]); // painted A and B; the click of that press went to neither cell
    cell(0).element.dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true, cancelable: true })); // Enter / Space
    await nextTick();
    expect([on(0), on(1)]).toEqual([false, true]);
  });
});

describe('WX6 0b N-WX5-1: a step further out of range does nothing; a step toward it lands on the bound', () => {
  function field() {
    w = mount(NumberField, { props: { modelValue: 300, min: 0, max: 120, step: 1, decimals: 0, unit: 'min', label: 'sleep' }, attachTo: document.body });
    return { el: w.find('input').element as HTMLInputElement, btns: w.findAll('.nf__btn') };
  }
  it('300 with max 120: "+" and ArrowUp emit nothing', async () => {
    const { el, btns } = field();
    await btns[1].trigger('click');
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await nextTick();
    expect(w!.emitted('update:modelValue')).toBeUndefined();
    expect(el.value).toBe('300');
    expect(el.getAttribute('aria-invalid')).toBe('true'); // the out-of-range note stays
  });
  it('300 with max 120: "−" emits 120', async () => {
    const { btns } = field();
    await btns[0].trigger('click');
    expect(w!.emitted('update:modelValue')).toEqual([[120]]);
  });
  it('below the minimum: "−" does nothing, "+" lands on the minimum', async () => {
    w = mount(NumberField, { props: { modelValue: 0.05, min: 0.1, max: 3.3, label: 'act' }, attachTo: document.body });
    const btns = w.findAll('.nf__btn');
    await btns[0].trigger('click');
    expect(w.emitted('update:modelValue')).toBeUndefined();
    await btns[1].trigger('click');
    expect(w.emitted('update:modelValue')).toEqual([[0.1]]);
  });
});
