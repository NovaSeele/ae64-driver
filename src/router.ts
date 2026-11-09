// Hash router. The default page (Performance) is bundled with the app; every other page is lazy-loaded into its own chunk.
import { createRouter, createWebHashHistory } from 'vue-router';
import type { Component } from 'vue';
import {
  IconActivity, IconAdjustmentsHorizontal, IconBolt, IconBulb, IconKeyboard, IconListDetails, IconSettings,
  IconStethoscope,
} from '@tabler/icons-vue';
import type { MessageKey } from './i18n/vi';
import IconSwitch from './components/ui/IconSwitch.vue';
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

export const NAV: { group: MessageKey; items: NavItem[] }[] = [
  {
    group: 'nav.groupProfile',
    items: [
      { path: '/keymap', title: 'page.keymap', icon: IconKeyboard, tone: 'var(--f-keymap)' },
      { path: '/performance', title: 'page.performance', icon: IconAdjustmentsHorizontal, tone: 'var(--f-performance)' },
      { path: '/advanced', title: 'page.advanced', icon: IconBolt, tone: 'var(--f-advanced)' },
      { path: '/lighting', title: 'page.lighting', icon: IconBulb, tone: 'var(--f-lighting)' },
    ],
  },
  {
    group: 'nav.groupDevice',
    items: [
      { path: '/macro', title: 'page.macro', icon: IconListDetails, tone: 'var(--f-macro)' },
      { path: '/switch', title: 'page.switch', icon: IconSwitch, tone: 'var(--f-switch)' },
      { path: '/live', title: 'page.live', icon: IconActivity, tone: 'var(--f-live)' },
      { path: '/settings', title: 'page.settings', icon: IconSettings, tone: 'var(--f-settings)' },
      { path: '/diagnostics', title: 'page.diagnostics', icon: IconStethoscope, tone: 'var(--f-diagnostics)' },
    ],
  },
];

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/performance' },
    { path: '/keymap', component: () => import('./pages/KeymapPage.vue'), meta: { title: 'page.keymap' } },
    // The default page is bundled with the app (no extra round trip on a first visit); the others stay lazy.
    { path: '/performance', component: PerformancePage, meta: { title: 'page.performance' } },
    { path: '/advanced', component: () => import('./pages/AdvancedPage.vue'), meta: { title: 'page.advanced' } },
    { path: '/lighting', component: () => import('./pages/LightingPage.vue'), meta: { title: 'page.lighting' } },
    { path: '/macro', component: () => import('./pages/MacroPage.vue'), meta: { title: 'page.macro' } },
    { path: '/switch', component: () => import('./pages/SwitchPage.vue'), meta: { title: 'page.switch' } },
    { path: '/live', component: () => import('./pages/LiveTravelPage.vue'), meta: { title: 'page.live' } },
    // Calibration is the second tab of the Switch page; old links and bookmarks land on it.
    { path: '/calibration', redirect: { path: '/switch', query: { tab: 'calibration' } } },
    { path: '/settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: 'page.settings' } },
    { path: '/diagnostics', component: () => import('./pages/DiagnosticsPage.vue'), meta: { title: 'page.diagnostics' } },
    { path: '/:pathMatch(.*)*', redirect: '/performance' },
  ],
});
