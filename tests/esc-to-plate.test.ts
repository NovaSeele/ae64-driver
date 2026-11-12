// WB-FOCUS-2: Esc in a clean NumberField leaves the field and lands on the keyboard plate's tab stop.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { defineComponent, h, nextTick, ref } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import NumberField from '../src/components/ui/NumberField.vue';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import { useHistoryStore } from '../src/stores/history';
import { useSelectionStore } from '../src/stores/selection';
import type { PhysicalKey } from '../src/protocol';

const key = (id: number, uiRow: number, x: number): PhysicalKey => ({ id, uiRow, row: 1, col: id, x, y: uiRow, w: 1, name: `K${id}` });
const KEYS = [key(0, 0, 0), key(1, 0, 1), key(2, 1, 0), key(3, 1, 1)];

let w: VueWrapper | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 400 } }]); }
    disconnect() {}
  });
});
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

function setup() {
  const value = ref(1);
  const changes = vi.fn();
  w = mount(defineComponent({
    setup: () => () => h('div', [
      h(KeyboardView, { keys: KEYS, selectable: true }),
      h(NumberField, { modelValue: value.value, min: 0.1, max: 4, label: 'Act', 'onUpdate:modelValue': (v: number) => { value.value = v; changes(v); } }),
    ]),
  }), { attachTo: document.body });
  const sel = useSelectionStore();
  const history = useHistoryStore();
  const field = w.find('input').element as HTMLInputElement;
  const keyEl = (id: number) => document.body.querySelector<HTMLElement>(`[data-key="${id}"]`)!;
  const press = (el: Element, k: string) => {
    const e = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e;
  };
  return { sel, history, field, keyEl, press, changes, value };
}

describe('Esc from a clean NumberField goes to the plate', () => {
  it('a. clears the selection and focuses the tab-stop key', async () => {
    const { sel, field, keyEl, press } = setup();
    sel.select(2, 'replace');
    keyEl(2).focus();
    field.focus();
    await nextTick();
    expect(document.activeElement).toBe(field);
    press(field, 'Escape');
    expect(sel.ids).toEqual([]);
    expect(document.activeElement).toBe(keyEl(2));
  });

  it('b. the next ArrowUp moves between keys and edits nothing', async () => {
    const { sel, history, field, keyEl, press, changes } = setup();
    sel.select(2, 'replace');
    keyEl(2).focus();
    field.focus();
    await nextTick();
    press(field, 'Escape');
    const before = history.canUndo;
    press(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(keyEl(0));
    expect(changes).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(before);
    expect(field.value).toBe('1.00');
  });

  it('d. with nothing selected it still leaves the field for the tab stop', async () => {
    const { sel, field, keyEl, press, changes } = setup();
    keyEl(3).focus();
    field.focus();
    await nextTick();
    expect(sel.ids).toEqual([]);
    press(field, 'Escape');
    expect(document.activeElement).toBe(keyEl(3));
    expect(sel.ids).toEqual([]);
    expect(changes).not.toHaveBeenCalled();
  });

  it('f. focuses the tab-stop key with preventScroll', async () => {
    const { sel, field, keyEl, press } = setup();
    sel.select(2, 'replace');
    keyEl(2).focus();
    field.focus();
    await nextTick();
    const spy = vi.spyOn(HTMLElement.prototype, 'focus');
    press(field, 'Escape');
    expect(spy.mock.contexts).toContain(keyEl(2));
    const i = spy.mock.contexts.indexOf(keyEl(2));
    expect(spy.mock.calls[i][0]).toEqual({ preventScroll: true });
    spy.mockRestore();
  });

  it('g. Esc from a focused element outside [data-app-keys] does not move focus to the plate', async () => {
    const { keyEl, press } = setup();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    keyEl(2).focus();
    outside.focus();
    await nextTick();
    expect(document.activeElement).toBe(outside);
    press(outside, 'Escape');
    expect(document.activeElement).toBe(outside);
    expect(document.activeElement).not.toBe(keyEl(2));
  });

  it('e. a field with a draft reverts and blurs, keeps the selection; a second Esc clears it', async () => {
    const { sel, field, press } = setup();
    sel.select(2, 'replace');
    field.focus();
    field.value = '1.5';
    field.dispatchEvent(new Event('input'));
    await nextTick();
    press(field, 'Escape');
    await nextTick();
    expect(field.value).toBe('1.00');
    expect(document.activeElement).not.toBe(field);
    expect(sel.ids).toEqual([2]);
    press(document.body, 'Escape');
    expect(sel.ids).toEqual([]);
  });
});
