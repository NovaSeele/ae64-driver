import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import NumberField from '../src/components/ui/NumberField.vue';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import { useHistoryStore } from '../src/stores/history';
import { useSelectionStore } from '../src/stores/selection';
import type { PhysicalKey } from '../src/protocol';

let w: VueWrapper | null = null;
let removeShortcuts: (() => void) | null = null;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 400 } }]); }
    disconnect() {}
  });
});
afterEach(() => {
  removeShortcuts?.();
  removeShortcuts = null;
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function setupHistory() {
  const history = useHistoryStore();
  removeShortcuts = history.installShortcuts();
  const undo = vi.fn();
  history.push({ label: 'edit', undo, redo: vi.fn() });
  return { history, undo };
}

function ctrlZ(el: HTMLElement) {
  const e = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true, cancelable: true });
  el.dispatchEvent(e);
  return e;
}

async function dirtyNumberField() {
  w = mount(NumberField, { props: { modelValue: 1, min: 0.1, max: 4, label: 'Act' }, attachTo: document.body });
  const el = w.find('input').element as HTMLInputElement;
  el.focus();
  return el;
}

describe('app undo shortcut guards', () => {
  it('Ctrl+Z in a NumberField with a draft leaves the text undo to the browser', async () => {
    const { history, undo } = setupHistory();
    const el = await dirtyNumberField();
    el.value = '1.5';
    el.dispatchEvent(new Event('input'));
    await nextTick();
    expect(el.hasAttribute('data-app-keys')).toBe(false);
    const e = ctrlZ(el);
    expect(undo).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(true);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Ctrl+Z in a plain text input leaves the text undo to the browser', () => {
    const { history, undo } = setupHistory();
    const input = document.createElement('input');
    input.type = 'text';
    document.body.appendChild(input);
    input.focus();
    const e = ctrlZ(input);
    expect(undo).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(true);
    expect(e.defaultPrevented).toBe(false);
  });

  it('Ctrl+Z in a textarea leaves the text undo to the browser', () => {
    const { history, undo } = setupHistory();
    const ta = document.createElement('textarea');
    document.body.appendChild(ta);
    ta.focus();
    const e = ctrlZ(ta);
    expect(undo).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(true);
    expect(e.defaultPrevented).toBe(false);
  });

  it('control: Ctrl+Z in a clean NumberField runs the app undo', async () => {
    const { history, undo } = setupHistory();
    const el = await dirtyNumberField();
    expect(el.hasAttribute('data-app-keys')).toBe(true);
    const e = ctrlZ(el);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(history.canUndo).toBe(false);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('KeyboardView Esc guards', () => {
  const key = (id: number, x: number): PhysicalKey => ({ id, uiRow: 0, row: 1, col: id, x, y: 0, w: 1, name: `K${id}` });
  const esc = (el: HTMLElement) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));

  function setup() {
    w = mount(KeyboardView, { props: { keys: [key(0, 0), key(1, 1)], selectable: true }, attachTo: document.body });
    const sel = useSelectionStore();
    sel.selectMany([0, 1]);
    return sel;
  }

  it('Esc in a plain input outside a dialog keeps the selection', () => {
    const sel = setup();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    esc(input);
    expect(sel.ids).toEqual([0, 1]);
  });

  it('control: Esc on the body clears the selection', () => {
    const sel = setup();
    esc(document.body);
    expect(sel.ids).toEqual([]);
  });
});
