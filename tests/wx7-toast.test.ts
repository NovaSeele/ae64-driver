// WX7 item 2: toasts are read from one polite and one assertive live region that exist from mount; a toast's timer is held
// while the pointer is on it or focus is inside it, and runs on with the time that was left.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ToastHost from '../src/components/ui/Toast.vue';
import { useToast } from '../src/components/ui/toast';

let w: VueWrapper | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  useToast().items.value = [];
  w = mount(ToastHost, { attachTo: document.body });
});
afterEach(() => {
  w?.unmount();
  w = null;
  for (const it of useToast().items.value) useToast().dismiss(it.id);
  document.body.innerHTML = '';
  vi.useRealTimers();
});

const toasts = () => w!.findAll('.toast');
const live = () => w!.find('[data-test="toast-live"]');
const alert = () => w!.find('[data-test="toast-alert"]');

describe('WX7 item 2: one live region', () => {
  it('a polite and an assertive region exist before the first toast; each toast\'s text goes into the right one', async () => {
    expect(live().exists()).toBe(true);
    expect(live().attributes('role')).toBe('status');
    expect(live().attributes('aria-live')).toBe('polite');
    expect(alert().attributes('aria-live')).toBe('assertive');
    expect(live().text()).toBe('');
    const before = live().element;
    useToast().show('Đã lưu.', 'success');
    useToast().show('Lỗi ghi.', 'error');
    await nextTick();
    expect(live().element).toBe(before); // the same region, not a new one
    expect(live().text()).toBe('Đã lưu.');
    expect(alert().text()).toBe('Lỗi ghi.');
    // the visible toasts carry no role of their own
    expect(toasts().length).toBe(2);
    for (const t of toasts()) expect(t.attributes('role')).toBeUndefined();
    expect(w!.findAll('[role="status"]').length).toBe(1);
    expect(w!.findAll('[role="alert"]').length).toBe(0);
  });

  it('the queue rules stay: the same text replaces, at most four', async () => {
    const { show } = useToast();
    show('A'); show('B'); show('A');
    await nextTick();
    expect(toasts().map((t) => t.find('.toast__text').text())).toEqual(['B', 'A']);
    show('C'); show('D'); show('E');
    await nextTick();
    expect(toasts().map((t) => t.find('.toast__text').text())).toEqual(['A', 'C', 'D', 'E']);
    vi.advanceTimersByTime(3300);
    await nextTick();
    expect(toasts().length).toBe(0);
  });
});

describe('WX7 item 2: pause on hover and on focus', () => {
  it('hover holds a toast past its time; it goes after the pointer leaves, with the time that was left', async () => {
    useToast().show('Đã đổi phím.', 'info', 3200);
    await nextTick();
    vi.advanceTimersByTime(1000);
    await toasts()[0].trigger('mouseenter');
    vi.advanceTimersByTime(10_000);
    await nextTick();
    expect(toasts().length).toBe(1);
    await toasts()[0].trigger('mouseleave');
    vi.advanceTimersByTime(2100);
    await nextTick();
    expect(toasts().length).toBe(1); // 2.2 s were left
    vi.advanceTimersByTime(200);
    await nextTick();
    expect(toasts().length).toBe(0);
  });

  it('focus on its "Hoàn tác" holds it; moving between its buttons keeps the hold; focus leaving lets it go', async () => {
    const run = vi.fn();
    useToast().show('Đã xoá.', 'info', 3200, { label: 'Hoàn tác', run });
    await nextTick();
    const act = toasts()[0].find('.toast__act');
    const close = toasts()[0].find('.toast__x');
    (act.element as HTMLElement).focus();
    await act.trigger('focusin');
    vi.advanceTimersByTime(8000);
    await nextTick();
    expect(toasts().length).toBe(1);
    await act.trigger('focusout', { relatedTarget: close.element });
    await close.trigger('focusin');
    vi.advanceTimersByTime(8000);
    await nextTick();
    expect(toasts().length).toBe(1);
    await close.trigger('focusout', { relatedTarget: document.body });
    vi.advanceTimersByTime(3300);
    await nextTick();
    expect(toasts().length).toBe(0);
    expect(run).not.toHaveBeenCalled();
  });

  it('hover and focus together: the toast stays until both are gone', async () => {
    useToast().show('Hai lý do.', 'info', 3200);
    await nextTick();
    const el = toasts()[0];
    await el.trigger('mouseenter');
    await el.find('.toast__x').trigger('focusin');
    await el.trigger('mouseleave');
    vi.advanceTimersByTime(10_000);
    await nextTick();
    expect(toasts().length).toBe(1);
    await el.find('.toast__x').trigger('focusout', { relatedTarget: null });
    vi.advanceTimersByTime(3300);
    await nextTick();
    expect(toasts().length).toBe(0);
  });
});
