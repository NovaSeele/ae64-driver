// While a toast is open the page scroller gets a bottom spacer (--toast-safe = stack height + 16 px); 0 when none. 0 HID.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import ToastHost from '../src/components/ui/Toast.vue';
import { useToast } from '../src/components/ui/toast';

let cb: ResizeObserverCallback | null = null;
let w: VueWrapper | null = null;
const safe = (): string => document.documentElement.style.getPropertyValue('--toast-safe');
const report = (h: number): void => cb?.([{ contentRect: { height: h } } as ResizeObserverEntry], {} as ResizeObserver);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { constructor(c: ResizeObserverCallback) { cb = c; } observe() {} disconnect() {} unobserve() {} });
  w = mount(ToastHost, { attachTo: document.body });
});
afterEach(() => {
  w?.unmount();
  w = null;
  useToast().items.value = [];
  vi.unstubAllGlobals();
});

describe('toast safe area', () => {
  it('is 0 or unset with no toast', () => {
    expect(['', '0px']).toContain(safe());
  });
  it('is the stack height + 16 px while a toast is open, and 0 once dismissed', async () => {
    const { show, dismiss } = useToast();
    const id = show('Đã lưu');
    await nextTick();
    report(56);
    expect(safe()).toBe('72px');
    dismiss(id);
    await nextTick();
    report(0);
    expect(safe()).toBe('0px');
  });
});
