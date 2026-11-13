// Key lock while measuring (DESIGN C §3.8, §11) and the roving tab stop shared by the check's chips and table rows.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, KeepAlive, nextTick, ref } from 'vue';
import { mount } from '@vue/test-utils';
import { useKeyLock } from '../src/composables/useKeyLock';
import { useRovingFocus } from '../src/composables/useRovingFocus';

const active = ref(true);
const blocked = vi.fn();
const Locked = defineComponent({
  name: 'Locked',
  setup() {
    useKeyLock({ active: () => active.value, onBlocked: blocked });
    return () => h('div', { class: 'locked' }, [
      h('button', { id: 'btn' }, 'b'),
      h('span', { 'data-keylock': '' }, [h('button', { id: 'lock', role: 'switch' })]),
      h('textarea', { id: 'box', 'data-keytest': '' }),
      h('input', { id: 'inp' }),
      h('div', { role: 'dialog' }, [h('button', { id: 'dlg' })]),
      h('div', { role: 'alertdialog' }, [h('button', { id: 'alert' })]),
      h('dialog', { open: true }, [h('button', { id: 'native' })]),
      h('div', { role: 'tablist' }, [h('button', { id: 'tab', role: 'tab' })]),
      h('div', { contenteditable: 'true', id: 'ce' }),
    ]);
  },
});

/** Dispatch a key event on `target` (by id, or the body); returns whether it was blocked (default prevented). */
function press(code: string, target = 'btn', init: KeyboardEventInit = {}, type: 'keydown' | 'keyup' = 'keydown'): boolean {
  const el = target === 'body' ? document.body : document.getElementById(target)!;
  const e = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e.defaultPrevented;
}

afterEach(() => {
  document.body.innerHTML = '';
  active.value = true;
  blocked.mockReset();
});

describe('useKeyLock', () => {
  it('blocks Space on keydown and keyup, and Shift+Space; stops the event before the page sees it', () => {
    const w = mount(Locked, { attachTo: document.body });
    const seen = vi.fn();
    document.getElementById('btn')!.addEventListener('keydown', seen);
    expect(press('Space')).toBe(true);
    expect(press('Space', 'btn', {}, 'keyup')).toBe(true);
    expect(press('Space', 'btn', { shiftKey: true })).toBe(true);
    expect(seen).not.toHaveBeenCalled();
    expect(blocked).toHaveBeenCalledTimes(2); // keydowns only
    w.unmount();
  });

  it('blocks the scrolling, pressing and typing keys', () => {
    const w = mount(Locked, { attachTo: document.body });
    for (const code of ['Enter', 'NumpadEnter', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'Backspace', 'KeyA', 'KeyZ', 'Digit0', 'Digit9', 'Numpad0', 'Numpad9']) {
      expect(press(code), code).toBe(true);
    }
    expect(press('Space', 'body')).toBe(true);
    w.unmount();
  });

  it('lets Tab, Shift+Tab, Esc, F-keys and Ctrl/Alt/Meta shortcuts through', () => {
    const w = mount(Locked, { attachTo: document.body });
    expect(press('Tab')).toBe(false);
    expect(press('Tab', 'btn', { shiftKey: true })).toBe(false);
    expect(press('Escape')).toBe(false);
    expect(press('F5')).toBe(false);
    expect(press('Space', 'btn', { ctrlKey: true })).toBe(false);
    expect(press('ArrowLeft', 'btn', { altKey: true })).toBe(false);
    expect(press('KeyA', 'btn', { metaKey: true })).toBe(false);
    expect(blocked).not.toHaveBeenCalled();
    w.unmount();
  });

  it('keeps every key while typing: typing test box, inputs, contenteditable', () => {
    const w = mount(Locked, { attachTo: document.body });
    expect(press('Space', 'box')).toBe(false);
    expect(press('KeyA', 'box')).toBe(false);
    expect(press('Space', 'inp')).toBe(false);
    expect(press('Space', 'ce')).toBe(false);
    w.unmount();
  });

  it("does not block Space on the lock's own switch (the way out)", () => {
    const w = mount(Locked, { attachTo: document.body });
    expect(press('Space', 'lock')).toBe(false);
    expect(press('Enter', 'lock')).toBe(false);
    w.unmount();
  });

  it('does nothing while not active (switch off, or not measuring)', () => {
    const w = mount(Locked, { attachTo: document.body });
    active.value = false;
    expect(press('Space')).toBe(false);
    active.value = true;
    expect(press('Space')).toBe(true);
    w.unmount();
  });

  it('inside a dialog (Help, a shell popover, an alert, a native dialog) Space, Enter and arrows work; outside it blocks again', () => {
    const w = mount(Locked, { attachTo: document.body });
    for (const id of ['dlg', 'alert', 'native']) {
      for (const code of ['Space', 'Enter', 'ArrowDown', 'ArrowRight']) expect(press(code, id), `${id} ${code}`).toBe(false);
    }
    // the dialog closed, focus back on the page
    expect(press('Space', 'btn')).toBe(true);
    w.unmount();
  });

  it('still blocks the arrows on a tab row (part E): that is what the lock prevents', () => {
    const w = mount(Locked, { attachTo: document.body });
    expect(press('ArrowRight', 'tab')).toBe(true);
    expect(press('ArrowLeft', 'tab')).toBe(true);
    w.unmount();
  });

  it('leaves an event another listener already handled (the demo keyboard): no block, no reminder', () => {
    const w = mount(Locked, { attachTo: document.body });
    const demo = (e: KeyboardEvent) => e.preventDefault(); // a window capture listener, like attachDemoPress
    window.addEventListener('keydown', demo, true);
    const seen = vi.fn();
    document.getElementById('btn')!.addEventListener('keydown', seen);
    press('Space');
    expect(seen).toHaveBeenCalledTimes(1); // the lock did not stop it
    expect(blocked).not.toHaveBeenCalled();
    window.removeEventListener('keydown', demo, true);
    w.unmount();
  });

  it('runs after a window capture listener attached later (the demo switched on after the page opened)', () => {
    const w = mount(Locked, { attachTo: document.body });
    const order: string[] = [];
    const demo = (e: KeyboardEvent) => { order.push('demo'); e.preventDefault(); };
    window.addEventListener('keydown', demo, true);
    press('Space');
    expect(order).toEqual(['demo']);
    expect(blocked).not.toHaveBeenCalled();
    window.removeEventListener('keydown', demo, true);
    w.unmount();
  });

  it('detaches when the page is left, and when its KeepAlive tab is hidden; attaches again when shown', async () => {
    const show = ref(true);
    const Other = defineComponent({ name: 'Other', render: () => h('i') });
    const Host = defineComponent({ render: () => h(KeepAlive, null, [show.value ? h(Locked) : h(Other)]) });
    const w = mount(Host, { attachTo: document.body });
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    expect(press('Space')).toBe(true);
    show.value = false; // deactivated: the tab is kept but hidden
    await nextTick();
    expect(remove).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(remove).toHaveBeenCalledWith('keyup', expect.any(Function), true);
    const e = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
    show.value = true; // activated again
    await nextTick();
    expect(add).toHaveBeenCalledWith('keydown', expect.any(Function), true);
    expect(press('Space')).toBe(true);
    w.unmount();
    const after = new KeyboardEvent('keydown', { code: 'Space', bubbles: true, cancelable: true });
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });
});

describe('useRovingFocus', () => {
  const ids = ref([3, 7, 9, 12]);
  const List = defineComponent({
    props: { orientation: { type: String as () => 'both' | 'vertical', default: 'both' } },
    setup(props) {
      const box = ref<HTMLElement | null>(null);
      const r = useRovingFocus({ container: box, ids: () => ids.value, orientation: props.orientation });
      return () => h('div', { ref: box }, ids.value.map((id) => h('button', {
        'data-rid': id, tabindex: r.tabindex(id), onFocus: () => r.onFocus(id), onKeydown: (e: KeyboardEvent) => r.onKeydown(e, id),
      }, String(id))));
    },
  });
  const btn = (id: number) => document.querySelector<HTMLElement>(`[data-rid="${id}"]`)!;
  const stops = () => [...document.querySelectorAll<HTMLElement>('[data-rid]')].filter((b) => b.tabIndex === 0).map((b) => b.dataset.rid);
  const key = async (id: number, k: string) => {
    btn(id).dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    await nextTick();
    await nextTick();
  };
  afterEach(() => { ids.value = [3, 7, 9, 12]; });

  it('one Tab stop; arrows, Home and End move it and focus', async () => {
    const w = mount(List, { attachTo: document.body });
    expect(stops()).toEqual(['3']);
    btn(3).focus();
    await key(3, 'ArrowRight');
    expect(document.activeElement).toBe(btn(7));
    expect(stops()).toEqual(['7']);
    await key(7, 'ArrowDown');
    expect(document.activeElement).toBe(btn(9));
    await key(9, 'End');
    expect(document.activeElement).toBe(btn(12));
    await key(12, 'ArrowRight'); // stays at the end
    expect(document.activeElement).toBe(btn(12));
    await key(12, 'Home');
    expect(document.activeElement).toBe(btn(3));
    await key(3, 'ArrowUp');
    expect(document.activeElement).toBe(btn(3));
    w.unmount();
  });

  it('vertical lists ignore ←/→', async () => {
    const w = mount(List, { props: { orientation: 'vertical' }, attachTo: document.body });
    btn(3).focus();
    await key(3, 'ArrowRight');
    expect(document.activeElement).toBe(btn(3));
    await key(3, 'ArrowDown');
    expect(document.activeElement).toBe(btn(7));
    w.unmount();
  });

  it('keeps the remembered item when the list changes; a removed item hands the stop to its neighbour', async () => {
    const w = mount(List, { attachTo: document.body });
    btn(9).focus();
    await nextTick();
    ids.value = [1, 3, 7, 9, 12];
    await nextTick();
    expect(stops()).toEqual(['9']);
    ids.value = [1, 3, 7, 12];
    await nextTick();
    expect(stops()).toEqual(['12']); // index 3 (where 9 was) is now 12
    ids.value = [1];
    await nextTick();
    expect(stops()).toEqual(['1']);
    w.unmount();
  });
});
