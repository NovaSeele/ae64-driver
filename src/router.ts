// Hash router. The default page (Performance) is bundled with the app; every other page is lazy-loaded into its own chunk.
import { createRouter, createWebHashHistory } from 'vue-router';
import type { Component } from 'vue';
import {
  IconActivity, IconAdjustmentsHorizontal, IconBolt, IconBulb, IconKeyboard, IconListDetails, IconSettings,
  IconStethoscope, IconTarget,
} from '@tabler/icons-vue';
import type { MessageKey } from './i18n/vi';
import PerformancePage from './pages/PerformancePage.vue';

declare module 'vue-router' {
  interface RouteMeta {
    title: MessageKey;
  }
}

export interface NavItem { path: string; title: MessageKey; icon: Component }

export const NAV: { group: MessageKey; items: NavItem[] }[] = [
  {
    group: 'nav.groupProfile',
    items: [
      { path: '/keymap', title: 'page.keymap', icon: IconKeyboard },
      { path: '/performance', title: 'page.performance', icon: IconAdjustmentsHorizontal },
      { path: '/advanced', title: 'page.advanced', icon: IconBolt },
      { path: '/lighting', title: 'page.lighting', icon: IconBulb },
    ],
  },
  {
    group: 'nav.groupDevice',
    items: [
      { path: '/macro', title: 'page.macro', icon: IconListDetails },
      { path: '/live', title: 'page.live', icon: IconActivity },
      { path: '/calibration', title: 'page.calibration', icon: IconTarget },
      { path: '/settings', title: 'page.settings', icon: IconSettings },
      { path: '/diagnostics', title: 'page.diagnostics', icon: IconStethoscope },
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
    { path: '/live', component: () => import('./pages/LiveTravelPage.vue'), meta: { title: 'page.live' } },
    { path: '/calibration', component: () => import('./pages/CalibrationPage.vue'), meta: { title: 'page.calibration' } },
    { path: '/settings', component: () => import('./pages/SettingsPage.vue'), meta: { title: 'page.settings' } },
    { path: '/diagnostics', component: () => import('./pages/DiagnosticsPage.vue'), meta: { title: 'page.diagnostics' } },
    { path: '/:pathMatch(.*)*', redirect: '/performance' },
  ],
});
