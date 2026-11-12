import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import NumberField from '../src/components/ui/NumberField.vue';

let w: VueWrapper | null = null;
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; });

function make(modelValue = 1) {
  w = mount(NumberField, { props: { modelValue, min: 0.1, max: 4, label: 'Act' }, attachTo: document.body });
  const el = w.find('input').element as HTMLInputElement;
  el.focus();
  return el;
}
async function type(el: HTMLInputElement, v: string) {
  el.value = v;
  el.dispatchEvent(new Event('input'));
  await nextTick();
}
const esc = (el: HTMLInputElement) => {
  const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
};

describe('NumberField app-keys marker', () => {
  it('is present when clean and gone with a draft', async () => {
    const el = make();
    expect(el.hasAttribute('data-app-keys')).toBe(true);
    await type(el, '1.5');
    expect(el.hasAttribute('data-app-keys')).toBe(false);
  });

  it('Esc on a dirty field reverts the text, blurs and keeps the Esc for itself', async () => {
    const el = make();
    await type(el, '1.5');
    const e = esc(el);
    await nextTick();
    // The revert makes the field clean (data-app-keys) before a browser runs the window listeners, so the
    // field must mark the Esc handled or KeyboardView would also clear the selection.
    expect(e.defaultPrevented).toBe(true);
    expect(el.value).toBe('1.00');
    expect(document.activeElement).not.toBe(el);
  });

  it('Esc on a clean field is left alone: no preventDefault, no blur', async () => {
    const el = make();
    const e = esc(el);
    expect(e.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(el);
  });

  it('a focused clean field follows a new modelValue', async () => {
    const el = make();
    await w!.setProps({ modelValue: 2 });
    await nextTick();
    expect(el.value).toBe('2.00');
    expect(el.hasAttribute('data-app-keys')).toBe(true);
  });

  it('a focused dirty field keeps its draft when modelValue changes', async () => {
    const el = make();
    await type(el, '1.5');
    await w!.setProps({ modelValue: 2 });
    await nextTick();
    expect(el.value).toBe('1.5');
    expect(el.hasAttribute('data-app-keys')).toBe(false);
  });
});

describe('NumberField unit suffix', () => {
  it('is hidden on a mixed value and back with a value or typing', async () => {
    w = mount(NumberField, { props: { modelValue: null, min: 0.1, max: 4, label: 'Act' }, attachTo: document.body });
    expect(w.find('.nf__unit').exists()).toBe(false);
    await type(w.find('input').element as HTMLInputElement, '1.5');
    expect(w.find('.nf__unit').exists()).toBe(true);
    await w.setProps({ modelValue: 2 });
    expect(w.find('.nf__unit').text()).toBe('mm');
  });
});
