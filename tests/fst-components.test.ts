// DESIGN FST §7 tests 1–2 + mutant F9: NumberField fineStep prop and Slider pageStep / fineStep props,
// verifying component defaults remain unchanged for all other callers (DKS, MPT, gamepad, Lighting, ColorPicker…).
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import NumberField from '../src/components/ui/NumberField.vue';
import Slider from '../src/components/ui/Slider.vue';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
});

function stubTrack(wrapper: VueWrapper, rect: Partial<DOMRect> = {}) {
  const el = wrapper.find('.sl').element as HTMLElement;
  const full: DOMRect = {
    left: 0, top: 0, width: 300, height: 20, right: 300, bottom: 20, x: 0, y: 0,
    toJSON: () => ({}),
    ...rect,
  };
  el.getBoundingClientRect = () => full;
  el.setPointerCapture = () => undefined;
  return el;
}

describe('FST test 1: NumberField fineStep prop and default (F9)', () => {
  it('without fineStep, Shift + click and Shift + Arrow step step / 10 (unchanged default for DKS / gamepad / Lighting)', async () => {
    // 0.01 default step -> Shift gives 0.001
    w = mount(NumberField, {
      props: { modelValue: 1, min: 0.1, max: 4, step: 0.01, decimals: 3, label: 'Act', 'onUpdate:modelValue': (v: number) => w!.setProps({ modelValue: v }) },
      attachTo: document.body,
    });
    const [minus, plus] = w.findAll('.nf__btn');
    const input = w.find('input');

    await plus.trigger('click'); // 1.00 -> 1.01
    await plus.trigger('click', { shiftKey: true }); // 1.01 -> 1.011
    await minus.trigger('click', { shiftKey: true }); // 1.011 -> 1.01
    await input.trigger('keydown', { key: 'ArrowUp', shiftKey: true }); // 1.01 -> 1.011
    await input.trigger('keydown', { key: 'ArrowDown', shiftKey: true }); // 1.011 -> 1.01

    expect(w.emitted('update:modelValue')!.map((e) => e[0])).toEqual([1.01, 1.011, 1.01, 1.011, 1.01]);
    w.unmount();

    // Non-mm caller (e.g. gamepad sticks step 0.5, decimals 2 -> Shift gives 0.05)
    w = mount(NumberField, {
      props: { modelValue: 50, min: 0, max: 100, step: 0.5, decimals: 2, unit: '%', label: 'Stick', 'onUpdate:modelValue': (v: number) => w!.setProps({ modelValue: v }) },
      attachTo: document.body,
    });
    await w.findAll('.nf__btn')[1].trigger('click', { shiftKey: true }); // 50 -> 50.05
    await w.find('input').trigger('keydown', { key: 'ArrowUp', shiftKey: true }); // 50.05 -> 50.10
    expect(w.emitted('update:modelValue')!.map((e) => e[0])).toEqual([50.05, 50.1]);
  });

  it('with fineStep equal to step, Shift + click and Shift + Arrow match plain click and Arrow', async () => {
    for (const step of [0.001, 0.01]) {
      w?.unmount();
      w = mount(NumberField, {
        props: { modelValue: 1, min: 0.1, max: 4, step, fineStep: step, decimals: 3, label: 'Act', 'onUpdate:modelValue': (v: number) => w!.setProps({ modelValue: v }) },
        attachTo: document.body,
      });
      const [minus, plus] = w.findAll('.nf__btn');
      const input = w.find('input');

      await plus.trigger('click');
      await minus.trigger('click');
      await plus.trigger('click', { shiftKey: true });
      await minus.trigger('click', { shiftKey: true });
      await input.trigger('keydown', { key: 'ArrowUp' });
      await input.trigger('keydown', { key: 'ArrowDown' });
      await input.trigger('keydown', { key: 'ArrowUp', shiftKey: true });
      await input.trigger('keydown', { key: 'ArrowDown', shiftKey: true });

      const vals = w.emitted('update:modelValue')!.map((e) => e[0]);
      const up = Number((1 + step).toFixed(3));
      expect(vals).toEqual([up, 1, up, 1, up, 1, up, 1]);
    }
  });

  it('relative mode emits ± fineStep on Shift (and ± step / 10 when fineStep is omitted)', async () => {
    w = mount(NumberField, {
      props: { modelValue: null, min: 0.01, max: 2, step: 0.01, decimals: 3, label: 'RT', relative: true },
      attachTo: document.body,
    });
    await w.findAll('.nf__btn')[1].trigger('click', { shiftKey: true });
    await w.findAll('.nf__btn')[0].trigger('click', { shiftKey: true });
    expect(w.emitted('step')!.map((e) => e[0])).toEqual([0.001, -0.001]);
    w.unmount();

    w = mount(NumberField, {
      props: { modelValue: null, min: 0.01, max: 2, step: 0.01, fineStep: 0.01, decimals: 3, label: 'RT', relative: true },
      attachTo: document.body,
    });
    await w.findAll('.nf__btn')[1].trigger('click', { shiftKey: true });
    await w.find('input').trigger('keydown', { key: 'ArrowDown', shiftKey: true });
    expect(w.emitted('step')!.map((e) => e[0])).toEqual([0.01, -0.01]);
  });
});

describe('FST test 2: Slider pageStep and fineStep props and defaults (F9)', () => {
  it('without pageStep / fineStep, PageUp = +step * 10 and Shift = step / 10 (unchanged default)', async () => {
    w = mount(Slider, { props: { modelValue: 1, min: 0, max: 4, step: 0.05, label: 'S' }, attachTo: document.body });
    const thumb = w.find('[role="slider"]');
    await thumb.trigger('keydown', { key: 'PageUp' });
    await thumb.trigger('keydown', { key: 'PageDown' });
    await thumb.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(w.emitted('update:modelValue')!.map((e) => e[0])).toEqual([1.5, 0.5, 1.005]);
    w.unmount();

    // Relative mode without pageStep
    w = mount(Slider, {
      props: { modelValue: 0.3, range: [0.3, 0.4], min: 0.01, max: 2, step: 0.01, label: 'S', relative: true },
      attachTo: document.body,
    });
    await w.find('[role="slider"]').trigger('keydown', { key: 'PageUp' });
    await w.find('[role="slider"]').trigger('keydown', { key: 'PageDown' });
    expect(w.emitted('step')!.map((e) => e[0])).toEqual([0.1, -0.1]);
  });

  it('with step 0.001 and pageStep 0.1: PageUp +0.1 and PageDown -0.1 in absolute and relative branches (exact 0.1)', async () => {
    // Absolute branch
    w = mount(Slider, {
      props: { modelValue: 1.237, min: 0.1, max: 3.31, step: 0.001, fineStep: 0.001, pageStep: 0.1, label: 'Act' },
      attachTo: document.body,
    });
    const thumb = w.find('[role="slider"]');
    await thumb.trigger('keydown', { key: 'PageUp' });
    await thumb.trigger('keydown', { key: 'PageDown' });
    expect(w.emitted('update:modelValue')!.map((e) => e[0])).toEqual([1.337, 1.137]);
    w.unmount();

    // Relative branch: exact 0.1 / -0.1 (not 0.10000000000000001)
    w = mount(Slider, {
      props: { modelValue: 0.3, range: [0.3, 0.4], min: 0.01, max: 2, step: 0.001, fineStep: 0.001, pageStep: 0.1, label: 'RT', relative: true },
      attachTo: document.body,
    });
    const rThumb = w.find('[role="slider"]');
    await rThumb.trigger('keydown', { key: 'PageUp' });
    await rThumb.trigger('keydown', { key: 'PageDown' });
    await rThumb.trigger('keydown', { key: 'ArrowRight' });
    const steps = w.emitted('step')!.map((e) => e[0]);
    expect(steps).toEqual([0.1, -0.1, 0.001]);
    expect(String(steps[0])).toBe('0.1');
    expect(String(steps[1])).toBe('-0.1');
  });

  it('Shift-drag and Shift-arrow with fineStep === step equal plain drag and plain arrow', async () => {
    for (const step of [0.001, 0.01]) {
      w?.unmount();
      w = mount(Slider, {
        props: { modelValue: 0.5, min: 0, max: 3, step, fineStep: step, pageStep: 0.1, label: 'S' },
        attachTo: document.body,
      });
      const el = stubTrack(w, { width: 300, height: 20 });
      const thumb = w.find('[role="slider"]');

      // Arrow keys
      await thumb.trigger('keydown', { key: 'ArrowRight' });
      await thumb.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
      await thumb.trigger('keydown', { key: 'ArrowLeft' });
      await thumb.trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
      const arrowVals = w.emitted('update:modelValue')!.map((e) => e[0]);
      expect(arrowVals[1]).toBe(arrowVals[0]);
      expect(arrowVals[3]).toBe(arrowVals[2]);

      // Pointer drag at a non-0.01 coordinate (123.7 px / 300 px * 3 = 1.237)
      const before = w.emitted('update:modelValue')!.length;
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 123.7, clientY: 10 }));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 123.7, clientY: 10 }));
      await w.vm.$nextTick();
      const plainVal = w.emitted('update:modelValue')![before][0];

      const beforeShift = w.emitted('update:modelValue')!.length;
      el.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: 123.7, clientY: 10, shiftKey: true }));
      el.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0, clientX: 123.7, clientY: 10, shiftKey: true }));
      await w.vm.$nextTick();
      const shiftVal = w.emitted('update:modelValue')![beforeShift][0];

      expect(shiftVal).toBe(plainVal);
      expect(plainVal).toBe(step === 0.001 ? 1.237 : 1.24);
    }
  });
});
