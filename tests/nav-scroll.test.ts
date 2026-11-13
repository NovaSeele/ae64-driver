// NAV-SCROLL-1: a new page (path) opens at the top of the page scroller, a query change keeps the scroll, and a page
// that scrolls itself when it mounts (a deep link, /live?check=1) keeps the scroll it chose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils';
import { defineComponent, h, onMounted } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../src/App.vue';
import { useDeviceStore } from '../src/stores/device';

let w: VueWrapper | null = null;

/** A page that scrolls the page scroller to 300 when it mounts, as a deep link does. */
const SelfScrolling = defineComponent({
  setup() {
    onMounted(() => { document.querySelector<HTMLElement>('.main__scroll')!.scrollTop = 300; });
    return () => h('section', 'deep');
  },
});

async function mountApp() {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<i>home</i>' } },
      { path: '/other', component: { template: '<b>other</b>' } },
      { path: '/deep', component: SelfScrolling },
    ],
  });
  await router.push('/');
  await useDeviceStore().connectDemo();
  w = mount(App, {
    // the page Transition runs for real: its before-enter hook is what resets the scroll
    global: { plugins: [router], stubs: { Sidebar: true, TopBar: true, ConnectScreen: true, transition: false } },
    attachTo: document.body,
  });
  await flushPromises();
  return { router, scroller: w.find('.main__scroll').element as HTMLElement };
}
/** Let the out-in transition finish (no CSS durations in jsdom: leave and enter end on the next frames). */
async function settle() {
  for (let i = 0; i < 5; i++) {
    await flushPromises();
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('page scroll on navigation (NAV-SCROLL-1)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });

  it('another path opens at the top', async () => {
    const { router, scroller } = await mountApp();
    scroller.scrollTop = 500;
    await router.push('/other');
    await settle();
    expect(w!.find('.main__scroll b').exists()).toBe(true);
    expect(scroller.scrollTop).toBe(0);
  });

  it('a query change on the same page keeps the scroll', async () => {
    const { router, scroller } = await mountApp();
    scroller.scrollTop = 500;
    await router.push({ path: '/', query: { key: '5' } });
    await settle();
    expect(scroller.scrollTop).toBe(500);
  });

  it('a page that scrolls itself on mount keeps its own scroll', async () => {
    const { router, scroller } = await mountApp();
    scroller.scrollTop = 500;
    await router.push('/deep');
    await settle();
    expect(w!.find('.main__scroll section').exists()).toBe(true);
    expect(scroller.scrollTop).toBe(300);
  });
});
