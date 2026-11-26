// WX5 items 1–9 (WHOLE review U-02, U-03, U-05, U-11, U-12, U-13 and the P3 lines NumberField, read-only board, Advanced
// accessibility). The reviewer's reproductions (review/WHOLE-tests/zz-agentA-*, zz-agentC-ui) turned round to the right
// behaviour, plus the cases the brief adds. Demo / mock only: no real keyboard.
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
import { fixUnusedStage3, useAdvancedStore, validateAssignment } from '../src/stores/advanced';
import type { DksAssignment, MptAssignment, SocdAssignment } from '../src/stores/advanced';
import { useSyncStore } from '../src/stores/sync';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { useToast } from '../src/components/ui/toast';
import NumberField, { parseNumber } from '../src/components/ui/NumberField.vue';
import MptEditor from '../src/components/advanced/MptEditor.vue';
import DksEditor from '../src/components/advanced/DksEditor.vue';
import PairEditor from '../src/components/advanced/PairEditor.vue';
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useToast().items.value = [];
  localStorage.clear();
});

async function boot(seed: 'max' | 'pro' = 'max') {
  setActivePinia(createPinia());
  clearTuningSnapshots();
  const device = useDeviceStore();
  await device.connectDemo(seed);
  return {
    device, perf: usePerformanceStore(), adv: useAdvancedStore(), sync: useSyncStore(), history: useHistoryStore(),
    sel: useSelectionStore(), mock: device.transport as MockTransport,
  };
}
const settle = async (n = 30) => { for (let i = 0; i < n; i++) await flushPromises(); };
const add = (v: number, d: number) => Number((v + d).toFixed(3));

describe('WX5 1 U-02: a coalesced gesture is undone to the values from before it (first value wins)', () => {
  it('store: step − then + on a mixed dead zone (0 and 0.2), one undo puts both keys back', async () => {
    const { device, perf, history, sync } = await boot();
    await perf.load();
    const [a, b] = [device.keys[10].id, device.keys[11].id];
    perf.apply([a], () => ({ pressDeadStroke: 0 }), 'setup');
    perf.apply([b], () => ({ pressDeadStroke: 0.2 }), 'setup');
    await sync.flush();
    const step = (d: number) => perf.apply([a, b], (p) => ({ pressDeadStroke: add(p.pressDeadStroke, d) }), 'dz', 'step-dz-pressDeadStroke');
    step(-0.01); // a is clamped at 0 (unchanged), b -> 0.19
    step(+0.01); // a -> 0.01, b -> 0.20
    history.undo();
    expect({ a: perf.values[a].pressDeadStroke, b: perf.values[b].pressDeadStroke }).toEqual({ a: 0, b: 0.2 });
    // redo gives the gesture's last values back, for both keys
    history.redo();
    expect({ a: perf.values[a].pressDeadStroke, b: perf.values[b].pressDeadStroke }).toEqual({ a: 0.01, b: 0.2 });
    await sync.flush();
    expect((await device.transport!.getPerformance(device.keys[10])).pressDeadStroke).toBe(0.01);
  });

  it('store: a slider drag whose first value equals one key (only the other changes), then undo', async () => {
    const { device, perf, history, sync } = await boot();
    await perf.load();
    const [a, b] = [device.keys[10].id, device.keys[11].id];
    perf.apply([a], () => ({ mode: 0, normalPress: 1.0, rtFirstTouch: 1.0 }), 'setup');
    perf.apply([b], () => ({ mode: 0, normalPress: 2.0, rtFirstTouch: 2.0 }), 'setup');
    await sync.flush();
    const set = (v: number) => perf.apply([a, b], () => ({ normalPress: v, rtFirstTouch: v }), 'act', 'act');
    set(2.0);
    set(2.2);
    history.undo();
    expect({ a: perf.values[a].normalPress, b: perf.values[b].normalPress }).toEqual({ a: 1.0, b: 2.0 });
    expect(history.canUndo).toBe(true); // the setup entries are still there: the gesture was one entry
    history.redo();
    expect({ a: perf.values[a].normalPress, b: perf.values[b].normalPress }).toEqual({ a: 2.2, b: 2.2 });
    await sync.flush();
  });

  it('store: one key stepped three times is still one entry, undone to its first value', async () => {
    const { device, perf, history, sync } = await boot();
    await perf.load();
    const a = device.keys[12].id;
    perf.apply([a], () => ({ pressDeadStroke: 0.1 }), 'setup');
    await sync.flush();
    history.clear();
    for (let i = 0; i < 3; i++) perf.apply([a], (p) => ({ pressDeadStroke: add(p.pressDeadStroke, 0.01) }), 'dz', 'step-dz-pressDeadStroke');
    expect(perf.values[a].pressDeadStroke).toBe(0.13);
    history.undo();
    expect(perf.values[a].pressDeadStroke).toBe(0.1);
    expect(history.canUndo).toBe(false);
    await sync.flush();
  });

  it('page: the Travel tab, two keys selected, top dead zone − then +, one undo', async () => {
    const { device, perf, history, sync, sel } = await boot();
    await perf.load();
    const [a, b] = [device.keys[10].id, device.keys[11].id];
    perf.apply([a], () => ({ pressDeadStroke: 0 }), 'setup');
    perf.apply([b], () => ({ pressDeadStroke: 0.2 }), 'setup');
    await sync.flush();
    history.clear();
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    sel.selectMany([a, b]);
    await flushPromises();
    const nf = w.find('.c-dead').findAllComponents(NumberField)[0];
    expect(nf.props('modelValue')).toBeNull(); // mixed
    const btns = nf.findAll('.nf__btn');
    await btns[0].trigger('click'); // −
    await btns[1].trigger('click'); // +
    await flushPromises();
    history.undo();
    await flushPromises();
    expect({ a: perf.values[a].pressDeadStroke, b: perf.values[b].pressDeadStroke }).toEqual({ a: 0, b: 0.2 });
    expect(history.canUndo).toBe(false);
    await sync.flush();
  });
});

describe('WX5 2 U-03: a two-stage MPT whose stage 2 is deeper than 1.5 mm saves', () => {
  it('Save writes the MPT (stage 3 has no output; its depth follows stage 2)', async () => {
    const { device, adv, sel, mock } = await boot();
    await adv.load();
    const setMpt = vi.spyOn(mock, 'setMpt');
    const key = device.keys.find((k) => !adv.byKey.get(k.id) && k.name === 'G') ?? device.keys.find((k) => !adv.byKey.get(k.id))!;
    ({ w } = await mountPerformance('advanced'));
    await flushPromises();
    sel.selectMany([key.id]);
    await flushPromises();
    await w.find('[data-add="MPT"]').trigger('click');
    await flushPromises();
    const ed = w.findComponent(MptEditor);
    await ed.findAll('.os')[1].trigger('click');
    await flushPromises();
    [...document.querySelectorAll<HTMLButtonElement>('.op__key')].find((b) => !b.disabled && !b.classList.contains('op__key--current'))!.click();
    await flushPromises();
    const nf = ed.findAllComponents(NumberField);
    expect(nf[2].props('disabled')).toBe(true);
    const input = nf[1].find('input');
    await input.setValue('2.0');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const draft = ed.props('modelValue') as MptAssignment;
    expect(draft.depths[1]).toBe(2);
    expect(draft.depths[2]).toBeGreaterThan(2); // the unused stage 3 moved past stage 2 in the draft too
    await w.findAll('.ed__foot button').find((b) => b.text() === t('advanced.save'))!.trigger('click');
    await settle(20);
    expect(w.find('.ed__problem').exists()).toBe(false);
    await vi.waitFor(() => expect(setMpt).toHaveBeenCalledTimes(1));
    await useSyncStore().flush(); // the read-back too: nothing of this test may run on the next one's pinia
    await settle(10);
    expect((await mock.getAdvanced(key)).type).toBe('MPT');
  });

  it('a three-stage MPT out of order is still refused (stage 3 has an output, nothing is moved)', () => {
    const a: MptAssignment = { type: 'MPT', keys: [20], keycodes: [0x04, 0x05, 0x06], depths: [0.5, 2.0, 1.5] };
    expect(fixUnusedStage3(a, 3.3).depths).toEqual([0.5, 2.0, 1.5]);
    expect(validateAssignment(fixUnusedStage3(a, 3.3), { layer0: () => 0x04, mptMax: 3.3 })).not.toBeNull();
    const two: MptAssignment = { ...a, keycodes: [0x04, 0x05, 0] };
    expect(validateAssignment(fixUnusedStage3(two, 3.3), { layer0: () => 0x04, mptMax: 3.3 })).toBeNull();
  });
});

describe('WX5 3 U-05 and P3 NumberField: nothing is written unless the text was changed, and odd text is not guessed', () => {
  async function type(el: HTMLInputElement, v: string) {
    el.value = v;
    el.dispatchEvent(new Event('input'));
    await nextTick();
  }
  const enter = (el: HTMLInputElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));

  it('focus + blur without typing on a value above max emits nothing; the field says it is out of range', async () => {
    w = mount(NumberField, { props: { modelValue: 300, min: 0, max: 120, step: 1, decimals: 0, label: 'sleep' }, attachTo: document.body });
    const el = w.find('input').element as HTMLInputElement;
    expect(el.value).toBe('300');
    expect(el.getAttribute('aria-invalid')).toBe('true');
    el.focus();
    await nextTick();
    el.blur();
    await nextTick();
    expect(w.emitted('update:modelValue')).toBeUndefined();
    expect(el.value).toBe('300');
  });

  it('a typed value then ArrowUp steps from what was typed', async () => {
    w = mount(NumberField, { props: { modelValue: 30, min: 1, max: 32767, step: 10, decimals: 0, unit: 'ms', label: 'delay' }, attachTo: document.body });
    const el = w.find('input').element as HTMLInputElement;
    el.focus();
    await type(el, '500');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    await nextTick();
    expect(w.emitted('update:modelValue')).toEqual([[510]]);
    expect(el.value).toBe('510');
  });

  it('"1.500" and "1 500" in a whole-number field are not read: error state, nothing written; Esc puts the value back', async () => {
    w = mount(NumberField, { props: { modelValue: 30, min: 1, max: 32767, step: 10, decimals: 0, unit: 'ms', label: 'delay' }, attachTo: document.body });
    const el = w.find('input').element as HTMLInputElement;
    el.focus();
    for (const s of ['1.500', '1 500', '1,5', '2x']) {
      await type(el, s);
      enter(el);
      await nextTick();
      expect(el.getAttribute('aria-invalid')).toBe('true');
      expect(w.find('.nf').classes()).toContain('nf--invalid');
    }
    el.blur();
    await nextTick();
    expect(w.emitted('update:modelValue')).toBeUndefined();
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await nextTick();
    expect(el.value).toBe('30');
    expect(el.getAttribute('aria-invalid')).toBeNull();
  });

  it('"," is a decimal mark in a millimetre field; one number only', async () => {
    expect(parseNumber('1,25', 2)).toBe(1.25);
    expect(parseNumber('.5', 2)).toBe(0.5);
    expect(parseNumber(' 2 ', 2)).toBe(2);
    expect(parseNumber('', 2)).toBeNull();
    for (const s of ['1.2.3', '1,2.3', '1 2', 'e3', '1e3', '--1']) expect(parseNumber(s, 2)).toBeNaN();
    w = mount(NumberField, { props: { modelValue: 1, min: 0.1, max: 3.3, label: 'act' }, attachTo: document.body });
    const el = w.find('input').element as HTMLInputElement;
    el.focus();
    await type(el, '1,25');
    enter(el);
    await nextTick();
    expect(w.emitted('update:modelValue')).toEqual([[1.25]]);
  });
});

describe('WX5 4 U-11: no app undo under an open Advanced editor; Save always means the keyboard holds what it shows', () => {
  async function openSaved() {
    const env = await boot();
    const { device, adv, sync } = env;
    await adv.load();
    const key = device.keys.find((k) => !adv.byKey.get(k.id) && k.name === 'G') ?? device.keys.find((k) => !adv.byKey.get(k.id))!;
    const a: DksAssignment = { type: 'DKS', keys: [key.id], keycodes: [0x04, 0x05, 0, 0], travels: [0xff, 0xff, 0, 0], dbs: [1.0, 2.0] };
    await adv.save(a);
    await sync.flush();
    expect(env.history.canUndo).toBe(true);
    expect((await env.mock.getAdvanced(key)).type).toBe('DKS'); // the starting point: the DKS is on the keyboard
    ({ w } = await mountPerformance('advanced'));
    await settle(5);
    await w.findAll('.item').find((r) => r.attributes('data-item') === `DKS:${key.id}`)!.find('.item__main').trigger('click');
    await flushPromises();
    expect(w.find('.editor').exists()).toBe(true);
    return { ...env, key };
  }

  it('Ctrl+Z with a clean editor open changes nothing; Save then says "saved" only with the DKS on the keyboard', async () => {
    const { history, sync, mock, key } = await openSaved();
    expect(history.suspended).toBe(true);
    expect(history.canUndo).toBe(false);
    const off = history.installShortcuts(window);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true }));
    off();
    history.undo(); // the toolbar button's call: a no-op too
    await sync.flush().catch(() => undefined);
    await settle(20);
    expect((await mock.getAdvanced(key)).type).toBe('DKS');
    useToast().items.value = [];
    await w!.findAll('.ed__foot button').find((b) => b.text() === t('advanced.save'))!.trigger('click');
    await settle(40);
    const saidSaved = useToast().items.value.some((x) => x.kind === 'success');
    expect(saidSaved && (await mock.getAdvanced(key)).type !== 'DKS').toBe(false);
    expect((await mock.getAdvanced(key)).type).toBe('DKS');
  });

  it('after the editor closes, undo works again', async () => {
    const { history, sync, mock, key } = await openSaved();
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); // clean: closes
    await settle(5);
    expect(w!.find('.editor').exists()).toBe(false);
    expect(history.suspended).toBe(false);
    expect(history.canUndo).toBe(true);
    history.undo();
    await sync.flush();
    await settle(10);
    expect((await mock.getAdvanced(key)).type).toBe('NONE');
  });

  it('save() writes when the keyboard record differs, even if the editor is clean', async () => {
    const { adv, sync, mock, device } = await boot();
    await adv.load();
    const key = device.keys.find((k) => !adv.byKey.get(k.id))!;
    const a: DksAssignment = { type: 'DKS', keys: [key.id], keycodes: [0x04, 0, 0, 0], travels: [0xff, 0, 0, 0], dbs: [1.0, 2.0] };
    await adv.save(a);
    await sync.flush();
    const setDks = vi.spyOn(mock, 'setDks');
    await adv.save(a); // same as the keyboard: no write
    await sync.flush();
    expect(setDks).not.toHaveBeenCalled();
    await adv.remove(adv.byKey.get(key.id)!); // the keyboard no longer has it
    await sync.flush();
    await adv.save(a, a); // "editing" the old record, unchanged: still written, since the keyboard differs
    await sync.flush();
    expect(setDks).toHaveBeenCalledTimes(1);
    expect((await mock.getAdvanced(key)).type).toBe('DKS');
  });
});

describe('WX5 5 U-12: an arrow key on a mixed slider moves each key from its own value', () => {
  it('ArrowRight on the mixed top dead zone (0.05 and 0.60): 0.051 and 0.601; the slider says it is mixed', async () => {
    const { device, perf, sync, sel } = await boot();
    await perf.load();
    const [a, b] = [device.keys[10].id, device.keys[11].id];
    perf.apply([a], () => ({ pressDeadStroke: 0.05 }), 'setup');
    perf.apply([b], () => ({ pressDeadStroke: 0.6 }), 'setup');
    await sync.flush();
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    sel.selectMany([a, b]);
    await flushPromises();
    const thumb = w.find('.c-dead [role="slider"]');
    expect(thumb.attributes('aria-valuetext')).toContain(t('perf.mixed'));
    await thumb.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect({ a: perf.values[a].pressDeadStroke, b: perf.values[b].pressDeadStroke }).toEqual({ a: 0.051, b: 0.601 });
    await thumb.trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect({ a: perf.values[a].pressDeadStroke, b: perf.values[b].pressDeadStroke }).toEqual({ a: 0.05, b: 0.6 });
    await sync.flush();
  });

  it('a slider with one value keeps its absolute steps', async () => {
    const { device, perf, sync, sel } = await boot();
    await perf.load();
    const [a, b] = [device.keys[10].id, device.keys[11].id];
    perf.apply([a, b], () => ({ pressDeadStroke: 0.2 }), 'setup');
    await sync.flush();
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    sel.selectMany([a, b]);
    await flushPromises();
    const thumb = w.find('.c-dead [role="slider"]');
    expect(thumb.attributes('aria-valuetext') ?? '').not.toContain(t('perf.mixed'));
    await thumb.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect([perf.values[a].pressDeadStroke, perf.values[b].pressDeadStroke]).toEqual([0.201, 0.201]);
    await sync.flush();
  });
});

describe('WX5 6 U-13: the RT card sums up RT keys only', () => {
  it('one RT key (0.2) and one Standard key (hidden rtPress 0.5): the field shows 0.2, not mixed', async () => {
    const { device, perf, sync, sel } = await boot();
    await perf.load();
    const [a, b] = [device.keys[20].id, device.keys[21].id];
    perf.apply([a], () => ({ mode: 1, rtPress: 0.2, rtRelease: 0.2 }), 'setup');
    perf.apply([b], () => ({ mode: 0, rtPress: 0.5, rtRelease: 0.5 }), 'setup');
    await sync.flush();
    ({ w } = await mountPerformance('travel'));
    await flushPromises();
    sel.selectMany([a, b]);
    await flushPromises();
    const nf = w.find('.c-rt').findAllComponents(NumberField);
    expect(nf[0].props('modelValue')).toBe(0.2);
    expect(nf[1].props('modelValue')).toBe(0.2);
  });
});

describe('WX5 8 P3: a read-only board says so and offers no edit on Travel, Advanced and Switch', () => {
  for (const tab of ['travel', 'advanced', 'switch'] as const) {
    it(`${tab}: the note, and the edit controls are off`, async () => {
      const { device, perf, adv } = await boot();
      device.boardAllowed = false;
      (device.transport as unknown as { boardAllowed: boolean }).boardAllowed = false;
      await perf.load();
      await adv.load();
      ({ w } = await mountPerformance(tab));
      await settle(10);
      expect(w.text()).toMatch(/allowlist|danh sách được phép ghi/);
      if (tab === 'travel') {
        expect(w.find('.ro-note').exists()).toBe(true);
        for (const b of w.findAll('button.preset')) expect(b.attributes('disabled')).toBeDefined();
        for (const nf of w.findAllComponents(NumberField)) expect(nf.props('disabled')).toBe(true);
      } else if (tab === 'advanced') {
        expect(w.find('.ro-note').exists()).toBe(true);
        for (const b of w.findAll('.type')) expect(b.attributes('disabled')).toBeDefined();
        for (const b of w.findAll('.item button')) expect(b.attributes('disabled')).toBeDefined();
      } else {
        expect(w.find('[data-test="switch-read-only"]').exists()).toBe(true);
        useSelectionStore().selectMany([device.keys[10].id]);
        await settle(5);
        const change = w.findAll('button').find((b) => b.text() === t('sw.change'))!;
        expect(change.attributes('disabled')).toBeDefined();
      }
    });
  }

  it('travel: a click on a preset changes nothing and queues nothing', async () => {
    const { device, perf, sync, history, mock } = await boot();
    device.boardAllowed = false;
    (mock as unknown as { boardAllowed: boolean }).boardAllowed = false;
    await perf.load();
    ({ w } = await mountPerformance('travel'));
    await settle(5);
    const before = JSON.stringify(perf.values);
    const btn = w.findAll('button.preset')[0].element as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.disabled = false; // a click that gets through anyway: the handler refuses it too
    btn.click();
    await settle(5);
    expect(JSON.stringify(perf.values)).toBe(before);
    expect(history.canUndo).toBe(false);
    expect(sync.pendingCount()).toBe(0);
  });

  it('a writable board shows no read-only note', async () => {
    const { perf, adv } = await boot();
    await perf.load();
    await adv.load();
    ({ w } = await mountPerformance('travel'));
    await settle(5);
    expect(w.find('.ro-note').exists()).toBe(false);
  });
});

describe('WX5 9 P3 Advanced accessibility', () => {
  const dks = (): DksAssignment => ({ type: 'DKS', keys: [20], keycodes: [0x04, 0, 0, 0], travels: [0, 0, 0, 0], dbs: [1.0, 2.0] });
  function mountDks() {
    setActivePinia(createPinia());
    const host = mount(DksEditor, {
      props: { modelValue: dks(), firmware: undefined, 'onUpdate:modelValue': (v: DksAssignment) => host.setProps({ modelValue: v }) },
      attachTo: document.body,
    });
    return host;
  }
  const cell = (h: VueWrapper, row: number, i: number) => h.findAll('.tl__row')[row].findAll('.cell')[i];
  const on = (h: VueWrapper, row: number, i: number) => cell(h, row, i).attributes('aria-pressed') === 'true';

  it('a DKS cell toggles on click (keyboard Enter / Space, assistive tech: click without a pointer)', async () => {
    const h = mountDks();
    w = h;
    expect(on(h, 0, 0)).toBe(false);
    await cell(h, 0, 0).trigger('click'); // detail 0, as Enter / Space and AT clicks are
    expect(on(h, 0, 0)).toBe(true);
    await cell(h, 0, 0).trigger('click');
    expect(on(h, 0, 0)).toBe(false);
  });

  it('a pointer press toggles once: pointerdown paints, the click that ends the press does not toggle back', async () => {
    const h = mountDks();
    w = h;
    const el = cell(h, 0, 0).element;
    el.dispatchEvent(new PointerEvent('pointerdown', { button: 0, buttons: 1, bubbles: true, cancelable: true }));
    await nextTick();
    expect(on(h, 0, 0)).toBe(true);
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('click', { detail: 1, bubbles: true, cancelable: true }));
    await nextTick();
    expect(on(h, 0, 0)).toBe(true);
    // a keyboard click right after still toggles
    el.dispatchEvent(new MouseEvent('click', { detail: 0, bubbles: true, cancelable: true }));
    await nextTick();
    expect(on(h, 0, 0)).toBe(false);
  });

  it('each row\'s Edit / Delete names its keys and type: "Sửa G (DKS)" / "Xoá G (DKS)"', async () => {
    const { device, adv, sync } = await boot();
    await adv.load();
    const key = device.keys.find((k) => !adv.byKey.get(k.id) && k.name === 'G')!;
    await adv.save({ type: 'DKS', keys: [key.id], keycodes: [0x04, 0, 0, 0], travels: [0xff, 0, 0, 0], dbs: [1.0, 2.0] });
    await sync.flush();
    ({ w } = await mountPerformance('advanced'));
    await settle(5);
    const row = w.findAll('.item').find((r) => r.attributes('data-item') === `DKS:${key.id}`)!;
    const labels = row.findAll('button[aria-label]').map((b) => b.attributes('aria-label'));
    const legend = device.legend(key);
    expect(labels).toContain(`Sửa ${legend} (DKS)`);
    expect(labels).toContain(`Xoá ${legend} (DKS)`);
    // names differ from row to row
    const all = w.findAll('.item button[aria-label]').map((b) => b.attributes('aria-label'));
    expect(new Set(all).size).toBe(all.length);
  });

  it('SOCD modes: one Tab stop on the checked mode, arrow keys move the choice', async () => {
    setActivePinia(createPinia());
    const pair: SocdAssignment = { type: 'SOCD', keys: [1, 2], keycodes: [0x04, 0x07], delay: 0, mode: 0 };
    let h!: VueWrapper;
    const onUpdate = (v: unknown) => { void h.setProps({ modelValue: v }); };
    h = mount(PairEditor, {
      props: { modelValue: pair, slot: 0 as const, keyName: (id: number) => `K${id}`, 'onUpdate:modelValue': onUpdate },
      attachTo: document.body,
    }) as unknown as VueWrapper;
    w = h;
    const radios = () => h.findAll('[role="radio"]');
    expect(radios().map((r) => r.attributes('tabindex'))).toEqual(['0', '-1', '-1', '-1']);
    (radios()[0].element as HTMLElement).focus();
    await radios()[0].trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect((h.props() as { modelValue: SocdAssignment }).modelValue.mode).toBe(1);
    expect(radios().map((r) => r.attributes('tabindex'))).toEqual(['-1', '0', '-1', '-1']);
    expect(document.activeElement).toBe(radios()[1].element);
    await radios()[1].trigger('keydown', { key: 'End' });
    expect((h.props() as { modelValue: SocdAssignment }).modelValue.mode).toBe(3);
    await radios()[3].trigger('keydown', { key: 'ArrowDown' }); // wraps
    expect((h.props() as { modelValue: SocdAssignment }).modelValue.mode).toBe(0);
    await radios()[0].trigger('keydown', { key: 'ArrowLeft' });
    expect((h.props() as { modelValue: SocdAssignment }).modelValue.mode).toBe(3);
  });

  it('Travel metric chips: one Tab stop, arrow keys move the shown metric', async () => {
    const { perf } = await boot();
    await perf.load();
    ({ w } = await mountPerformance('travel'));
    await settle(5);
    const chips = () => w!.findAll('.ph__tools .chips .chip');
    expect(chips().map((c) => c.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    (chips()[0].element as HTMLElement).focus();
    await chips()[0].trigger('keydown', { key: 'ArrowRight' });
    await nextTick();
    expect(chips().map((c) => c.attributes('aria-checked'))).toEqual(['false', 'true', 'false']);
    expect(chips().map((c) => c.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    await chips()[1].trigger('keydown', { key: 'Home' });
    await nextTick();
    expect(chips()[0].attributes('aria-checked')).toBe('true');
  });

  it('the editor settings that wait for a key are inert (not in the Tab order), and come alive once the key is picked', async () => {
    const { device, sel, adv } = await boot();
    await adv.load();
    ({ w } = await mountPerformance('advanced'));
    await settle(10);
    await w.find('.type[data-type="DKS"]').trigger('click');
    await settle(5);
    const body = () => w!.find('.ed__body');
    expect(body().classes()).toContain('ed__body--off');
    expect(body().attributes('inert')).toBeDefined();
    sel.selectMany([device.keys.find((k) => k.name === 'W')!.id]);
    await settle(5);
    expect(body().classes()).not.toContain('ed__body--off');
    expect(body().attributes('inert')).toBeUndefined();
  });
});
