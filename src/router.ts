// Hash router. The default page (Performance) is bundled with the app; every other page is lazy-loaded into its own chunk.
import { createRouter, createWebHashHistory } from 'vue-router';
import type { Router, RouteRecordRaw } from 'vue-router';
import type { Component } from 'vue';
import {
  IconAdjustmentsHorizontal, IconBulb, IconDeviceGamepad2, IconKeyboard, IconListDetails, IconSettings, IconStethoscope,
} from '@tabler/icons-vue';
import type { MessageKey } from './i18n/vi';
import PerformancePage from './pages/PerformancePage.vue';

declare module 'vue-router' {
  interface RouteMeta {
    title: MessageKey;
  }
}

export interface NavItem {
  path: string;
  title: MessageKey;
  icon: Component;
  /** Feature colour (CSS value) of the sidebar icon tile and the top-bar title tile. */
  tone: string;
}

// DESIGN E §3.8: Travel, Advanced keys, Switch, Calibration and Key test are the five tabs of the one Performance item.
export const NAV: { group: MessageKey; items: NavItem[] }[] = [
  {
    group: 'nav.groupKeyboard',
    items: [
      { path: '/performance', title: 'page.performance', icon: IconAdjustmentsHorizontal, tone: 'var(--f-performance)' },
    ],
  },
  {
    group: 'nav.groupCustomize',
    items: [
      { path: '/keymap', title: 'page.keymap', icon: IconKeyboard, tone: 'var(--f-keymap)' },
      { path: '/macro', title: 'page.macro', icon: IconListDetails, tone: 'var(--f-macro)' },
      { path: '/lighting', title: 'page.lighting', icon: IconBulb, tone: 'var(--f-lighting)' },
      { path: '/gamepad', title: 'page.gamepad', icon: IconDeviceGamepad2, tone: 'var(--f-gamepad)' },
    ],
  },
  {
    group: 'nav.groupDevice',
    items: [
      { path: '/settings', title: 'page.settings', icon: IconSettings, tone: 'var(--f-settings)' },
      { path: '/diagnostics', title: 'page.diagnostics', icon: IconStethoscope, tone: 'var(--f-diagnostics)' },
    ],
  },
];

// ----- the Performance page's tabs (DESIGN E §3.1)
export const PERF_TABS = ['travel', 'advanced', 'switch', 'calibration', 'test'] as const;
export type PerfTab = (typeof PERF_TABS)[number];
export const asPerfTab = (v: unknown): PerfTab | null => ((PERF_TABS as readonly unknown[]).includes(v) ? (v as PerfTab) : null);
/** The last tab used, in this browser (a view preference: nothing goes to the keyboard). `ae64.switchTab` is not read. */
export const PERF_TAB_KEY = 'ae64.perfTab';
export function storedTab(): PerfTab | null {
  try { return asPerfTab(localStorage.getItem(PERF_TAB_KEY)); } catch { return null; }
}
export function saveTab(tab: PerfTab): void {
  try { localStorage.setItem(PERF_TAB_KEY, tab); } catch { /* storage unavailable: the tab is just not remembered */ }
}

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/performance' },
  { path: '/keymap', component: () => import('./pages/KeymapPage.vue'), meta: { title: 'page.keymap' } },
  // The default page is bundled with the app (no extra round trip on a first visit); the others stay lazy.
  { path: '/performance', component: PerformancePage, meta: { title: 'page.performance' } },
  // Old links and bookmarks land on the tab that replaced the page; ?key= and ?check= are kept (DESIGN E §3.1).
  { path: '/advanced', redirect: { path: '/performance', query: { tab: 'advanced' } } },
  { path: '/switch', redirect: (to) => ({ path: '/performance', query: { tab: to.query.tab === 'calibration' ? 'calibration' : 'switch' } }) },
  { path: '/calibration', redirect: { path: '/performance', query: { tab: 'calibration' } } },
  { path: '/live', redirect: (to) => ({ path: '/performance', query: { ...to.query, tab: 'test' } }) },
  { path: '/lighting', component: () => import('./pages/LightingPage.vue'), meta: { title: 'page.lighting' } },
  { path: '/gamepad', component: () => import('./pages/GamepadPage.vue'), meta: { title: 'page.gamepad' } },
  { path: '/macro', component: () => import('./pages/MacroPage.vue'), meta: { title: 'page.macro' } },
  { path: '/settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: 'page.settings' } },
  { path: '/diagnostics', component: () => import('./pages/DiagnosticsPage.vue'), meta: { title: 'page.diagnostics' } },
  { path: '/:pathMatch(.*)*', redirect: '/performance' },
];

/**
 * The URL always names the Performance tab, normalised here rather than replaced in the page (review E, P2-b): the page
 * never renders without a valid tab, and a sidebar click to /performance while on ?tab=switch is the current location
 * ("duplicated": no new history entry).
 */
export function installPerfTabGuard(r: Router): void {
  r.beforeEach((to) => {
    if (to.path === '/performance' && !asPerfTab(to.query.tab)) {
      return { path: to.path, query: { ...to.query, tab: storedTab() ?? 'travel' }, hash: to.hash };
    }
  });
}

export const router = createRouter({
  history: createWebHashHistory(),
  routes,
});
installPerfTabGuard(router);
