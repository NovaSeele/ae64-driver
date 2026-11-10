import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import Sidebar from '../src/components/shell/Sidebar.vue';
import { NAV } from '../src/router';
import { t } from '../src/i18n/vi';
import KeyPicker from '../src/components/ui/KeyPicker.vue';
import Slider from '../src/components/ui/Slider.vue';
import Tabs from '../src/components/ui/Tabs.vue';
import ColorPicker from '../src/components/ui/ColorPicker.vue';
import NumberField, { decimalsFor, formatMm } from '../src/components/ui/NumberField.vue';
import { deriveRtLinked } from '../src/pages/PerformancePage.vue';
import type { Performance } from '../src/protocol';

describe('KeyPicker', () => {
  it('emits plain keycodes and modifier combos (mask in the high byte)', async () => {
    const w = mount(KeyPicker);
    const keyC = () => w.findAll('.kp__key').find((b) => b.find('.kp__label').text() === 'C')!;
    await keyC().trigger('click');
    expect(w.emitted('pick')![0]).toEqual([0x06]);

    const mods = w.findAll('.kp__mod');
    await mods.find((b) => b.text() === 'Ctrl')!.trigger('click');
    await mods.find((b) => b.text() === 'Shift')!.trigger('click');
    await keyC().trigger('click');
    expect(w.emitted('pick')![1]).toEqual([0x0306]);
  });

  it('searches across groups and hides factory reset', async () => {
    const w = mount(KeyPicker);
    await w.find('input[type="search"]').setValue('fn1');
    expect(w.findAll('.kp__label').map((x) => x.text())).toContain('Fn1');
    await w.find('input[type="search"]').setValue('factory');
    expect(w.findAll('.kp__key')).toHaveLength(0);
  });
});

describe('Slider', () => {
  it('steps with arrows, fine-steps with Shift, and commits', async () => {
    const w = mount(Slider, { props: { modelValue: 1, min: 0.1, max: 3.3, step: 0.05, fineStep: 0.01, orientation: 'vertical', label: 'x' } });
    const thumb = w.find('[role="slider"]');
    await thumb.trigger('keydown', { key: 'ArrowDown' });
    await thumb.trigger('keydown', { key: 'ArrowUp', shiftKey: true });
    await thumb.trigger('keydown', { key: 'End' });
    expect(w.emitted('update:modelValue')!.map((e) => e[0])).toEqual([1.05, 0.99, 3.3]);
    expect(w.emitted('commit')).toHaveLength(3);
  });

  it('a cancelled drag keeps the value it reached instead of jumping to min, and snaps to round values', async () => {
    const w = mount(Slider, {
      props: { modelValue: 0.3, min: 0.01, max: 2, step: 0.05, label: 'rt', 'onUpdate:modelValue': (v: number) => w.setProps({ modelValue: v }) },
      attachTo: document.body,
    });
    const track = w.find('.sl');
    const el = track.element as HTMLElement;
    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 200, height: 20, right: 200, bottom: 20, x: 0, y: 0, toJSON: () => ({}) });
    el.setPointerCapture = () => undefined;
    // The test DOM has no PointerEvent: MouseEvent carries the same fields the slider reads.
    const fire = async (type: string, clientX: number) => {
      el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX, clientY: 10 }));
      await w.vm.$nextTick();
    };
    await fire('pointerdown', 40);
    await fire('pointermove', 80);
    // Chromium cancels the stream (native drag, gesture…) with clientX 0.
    await fire('pointercancel', 0);
    const values = w.emitted('update:modelValue')!.map((e) => e[0]);
    expect(values).toEqual([0.4, 0.8]); // 40/200·1.99+0.01 → 0.40, 80/200 → 0.80 (absolute 0.05 grid)
    expect(w.emitted('commit')!.map((e) => e[0])).toEqual([0.8]);
    expect(w.props('modelValue')).toBe(0.8);
    w.unmount();
  });
});

describe('ColorPicker', () => {
  it('accepts hex input and records recent colours', async () => {
    localStorage.clear();
    const w = mount(ColorPicker, { props: { modelValue: '#3fe0c5', 'onUpdate:modelValue': (v: string) => w.setProps({ modelValue: v }) } });
    const hex = w.find('.cp__field--hex input');
    await hex.setValue('#ff8800');
    await hex.trigger('keydown', { key: 'Enter' });
    expect(w.props('modelValue')).toBe('#ff8800');
    expect(w.emitted('commit')![0]).toEqual(['#ff8800']);
    expect(JSON.parse(localStorage.getItem('ae64.recentColors')!)).toEqual(['#ff8800']);
  });
});

describe('NumberField', () => {
  const props = { min: 0.1, max: 3.3, step: 0.05, decimals: 3, label: 'x' };

  it('does not step from the range midpoint on a mixed value', async () => {
    const w = mount(NumberField, { props: { ...props, modelValue: null } });
    const [minus, plus] = w.findAll('.nf__btn');
    expect(minus.attributes('disabled')).toBeDefined();
    expect(plus.attributes('disabled')).toBeDefined();
    await plus.trigger('click');
    await w.find('input').trigger('keydown', { key: 'ArrowUp' });
    expect(w.emitted('update:modelValue')).toBeUndefined();
    expect(w.emitted('step')).toBeUndefined();
  });

  it('typing a number on a mixed value still sets it', async () => {
    const w = mount(NumberField, { props: { ...props, modelValue: null } });
    await w.find('input').setValue('1,5');
    await w.find('input').trigger('keydown', { key: 'Enter' });
    expect(w.emitted('update:modelValue')![0]).toEqual([1.5]);
  });

  it('emits a relative step on a mixed value when `relative`', async () => {
    const w = mount(NumberField, { props: { ...props, modelValue: null, relative: true } });
    await w.findAll('.nf__btn')[1].trigger('click');
    await w.find('input').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(w.emitted('step')!.map((e) => e[0])).toEqual([0.05, -0.005]);
    expect(w.emitted('update:modelValue')).toBeUndefined();
  });

  it('steps a single value from itself', async () => {
    const w = mount(NumberField, { props: { ...props, modelValue: 1 } });
    await w.findAll('.nf__btn')[1].trigger('click');
    expect(w.emitted('update:modelValue')![0]).toEqual([1.05]);
  });

  it('shows 2 decimals unless the value needs the third', () => {
    expect(formatMm(1, 3)).toBe('1.00');
    expect(formatMm(0.8, 3)).toBe('0.80');
    expect(formatMm(0.125, 3)).toBe('0.125');
    expect(formatMm(0.125, 2)).toBe('0.13');
    expect(decimalsFor(2.5, 3)).toBe(2);
    const w = mount(NumberField, { props: { ...props, modelValue: 1 } });
    expect((w.find('input').element as HTMLInputElement).value).toBe('1.00');
  });
});

describe('RT link derivation', () => {
  const rec = (mode: number, rtPress: number, rtRelease: number) => ({ mode, rtPress, rtRelease }) as Performance;
  const isRt = (m: number) => m === 1 || m === 2;
  it('is linked only when every Rapid Trigger key has press = release', () => {
    expect(deriveRtLinked([rec(1, 0.3, 0.3), rec(2, 0.5, 0.5)], isRt)).toBe(true);
    expect(deriveRtLinked([rec(1, 0.8, 0.3)], isRt)).toBe(false);
    expect(deriveRtLinked([rec(1, 0.3, 0.3), rec(1, 0.8, 0.3)], isRt)).toBe(false);
    expect(deriveRtLinked([rec(0, 0.8, 0.3), rec(1, 0.3, 0.3)], isRt)).toBe(true); // standard keys' RT fields are not edited
  });
});


describe('Sidebar', () => {
  it('renders every nav link with a title in compact mode and toggles compact on fold button click', async () => {
    setActivePinia(createPinia());
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/keymap', component: { template: '<div />' } }],
    });
    const w = mount(Sidebar, {
      props: { compact: true },
      global: { plugins: [router], stubs: { teleport: true } },
    });
    expect(w.classes()).toContain('side--compact');
    const links = w.findAll('.side__link');
    const allItems = NAV.flatMap((g) => g.items);
    expect(links.length).toBe(allItems.length);
    for (let i = 0; i < links.length; i++) {
      expect(links[i].attributes('title')).toBe(t(allItems[i].title));
    }

    // Fold button toggles the model
    const foldBtn = w.findAll('.side-foot__btn').at(-1)!;
    await foldBtn.trigger('click');
    expect(w.emitted('update:compact')?.[0]).toEqual([false]);
  });
});

describe('Tabs keyboard', () => {
  const items = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C', count: 3 }];
  const mk = (modelValue: string) => mount(Tabs, {
    attachTo: document.body,
    props: { items, label: 'L', modelValue, 'onUpdate:modelValue': (v: string) => w.setProps({ modelValue: v }) },
  });
  let w: ReturnType<typeof mk>;
  const active = () => (document.activeElement as HTMLElement | null)?.dataset.id;

  it('Home and End select and focus the first and last tab', async () => {
    w = mk('b');
    const list = w.find('[role=tablist]');
    await list.trigger('keydown', { key: 'End' });
    expect(w.props('modelValue')).toBe('c');
    expect(active()).toBe('c');
    await list.trigger('keydown', { key: 'Home' });
    expect(w.props('modelValue')).toBe('a');
    expect(active()).toBe('a');
    w.unmount();
  });

  it('arrows still wrap, other keys do nothing', async () => {
    w = mk('a');
    const list = w.find('[role=tablist]');
    await list.trigger('keydown', { key: 'ArrowLeft' });
    expect(w.props('modelValue')).toBe('c');
    await list.trigger('keydown', { key: 'ArrowRight' });
    expect(w.props('modelValue')).toBe('a');
    await list.trigger('keydown', { key: 'Enter' });
    expect(w.props('modelValue')).toBe('a');
    w.unmount();
  });
});
