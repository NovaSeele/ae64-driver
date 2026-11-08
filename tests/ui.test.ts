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
