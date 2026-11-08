import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import KeyPicker from '../src/components/ui/KeyPicker.vue';
import Slider from '../src/components/ui/Slider.vue';
import ColorPicker from '../src/components/ui/ColorPicker.vue';

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
