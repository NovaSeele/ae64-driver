// Mount the Performance page (DESIGN E) with the app's real routes and tab guard, the way the app does: RouterView at
// /performance?tab=…, or at an old link (/live?check=1, /switch?tab=calibration …) that redirects to a tab.
import { flushPromises, mount } from '@vue/test-utils';
import type { MountingOptions, VueWrapper } from '@vue/test-utils';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import type { RouteLocationRaw, Router } from 'vue-router';
import type { Plugin } from 'vue';
import { installPerfTabGuard, routes } from '../src/router';
import type { PerfTab } from '../src/router';

export interface MountOptions {
  attachTo?: HTMLElement;
  stubs?: NonNullable<MountingOptions<unknown>['global']>['stubs'];
  /** e.g. an explicit pinia */
  plugins?: Plugin[];
}

/** A fresh memory-history router with the app's routes and its ?tab= guard. */
export function perfRouter(): Router {
  const router = createRouter({ history: createMemoryHistory(), routes });
  installPerfTabGuard(router);
  return router;
}

/** The four lazy tabs, loaded before a mount: then the page's own import() of a tab resolves from the module cache in a
 *  few promise ticks (no timers, so tests with fake timers mount the same). */
const preload = () => Promise.all([
  import('../src/components/advanced/AdvancedTab.vue'),
  import('../src/components/switch/SwitchTab.vue'),
  import('../src/components/calibration/CalibrationView.vue'),
  import('../src/components/live/TestTab.vue'),
]);

/** Wait until the open tab rendered (the four lazy tabs are async components). */
export async function tabReady(w: VueWrapper): Promise<void> {
  for (let i = 0; i < 50; i++) {
    await flushPromises();
    if (w.element instanceof Element && w.element.querySelector('#ptab-panel > *')) break;
  }
  await flushPromises();
}

/** Mount at any location (an old link is redirected by the real routes). */
export async function mountAt(to: RouteLocationRaw, opts: MountOptions = {}): Promise<{ w: VueWrapper; router: Router }> {
  await preload();
  const router = perfRouter();
  await router.push(to);
  const w = mount(RouterView, {
    global: { plugins: [router, ...(opts.plugins ?? [])], stubs: opts.stubs },
    attachTo: opts.attachTo ?? document.body,
  });
  if (router.currentRoute.value.path === '/performance') await tabReady(w);
  else await flushPromises();
  return { w, router };
}

/** Mount the Performance page on one tab, with that tab's own query (key, check). */
export function mountPerformance(tab: PerfTab, query: Record<string, string> = {}, opts: MountOptions = {}) {
  return mountAt({ path: '/performance', query: { ...query, tab } }, opts);
}
