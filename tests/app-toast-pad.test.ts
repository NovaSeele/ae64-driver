// App.vue wires toastSafeTarget to the page scroller: padding-bottom (held pad) and scroll-padding-bottom (target). 0 HID beyond the demo mock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../src/App.vue';
import { toastSafeTarget } from '../src/components/ui/toast';
import { useDeviceStore } from '../src/stores/device';

let w: VueWrapper | null = null;

describe('App toast pad on the page scroller', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    toastSafeTarget.value = 0;
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; toastSafeTarget.value = 0; vi.unstubAllGlobals(); });

  async function mountApp() {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }, { path: '/other', component: { template: '<b />' } }] });
    await router.push('/');
    await useDeviceStore().connectDemo();
    w = mount(App, {
      global: { plugins: [router], stubs: { Sidebar: true, TopBar: true, ConnectScreen: true } },
      attachTo: document.body,
    });
    await flushPromises();
    return { router, scroller: w.find('.main__scroll').element as HTMLElement };
  }

  it('toastSafeTarget 98 gives padding-bottom and scroll-padding-bottom 98px', async () => {
    const { scroller } = await mountApp();
    toastSafeTarget.value = 98;
    await nextTick();
    expect(scroller.style.paddingBottom).toBe('98px');
    expect(scroller.style.scrollPaddingBottom).toBe('98px');
  });

  it('a route change while a pad is held sets the padding to the target at once', async () => {
    const { router, scroller } = await mountApp();
    toastSafeTarget.value = 98;
    await nextTick();
    // At the bottom of the content: closing the toast keeps the pad on screen.
    Object.defineProperty(scroller, 'scrollTop', { value: 1000 + 98 - 400, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 400, configurable: true });
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000 + 98, configurable: true });
    toastSafeTarget.value = 0;
    await nextTick();
    expect(scroller.style.paddingBottom).toBe('98px');
    expect(scroller.style.scrollPaddingBottom).toBe('0px');
    await router.push('/other');
    await flushPromises();
    expect(scroller.style.paddingBottom).toBe('0px');
  });
});
