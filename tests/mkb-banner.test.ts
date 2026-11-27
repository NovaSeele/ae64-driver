// MKB-V step 2a-2: View-mode banner (DESIGN MKB §9.1) — placement, text (vi/en), contrast/underline,
// help dialog, once-per-connection role="status" announcement (kills M17), and no notAllowed toast on generic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextTick } from 'vue';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import App from '../src/App.vue';
import { installPerfTabGuard, routes } from '../src/router';
import { useDeviceStore } from '../src/stores/device';
import { useToast } from '../src/components/ui/toast';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

let pinia: Pinia;
const mounted: VueWrapper[] = [];

function makeRouter(): Router {
  const r = createRouter({ history: createMemoryHistory(), routes });
  installPerfTabGuard(r);
  return r;
}

async function mountApp(startPath = '/overview') {
  const router = makeRouter();
  await router.push(startPath);
  await router.isReady();
  const w = mount(App, {
    global: { plugins: [router, pinia] },
    attachTo: document.body,
  });
  mounted.push(w);
  await flushPromises();
  return { w, router, device: useDeviceStore() };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  setLocale('vi');
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 1000 } }]); }
    unobserve() {}
    disconnect() {}
  });
});

afterEach(async () => {
  while (mounted.length) mounted.pop()!.unmount();
  await useDeviceStore().disconnect({ flush: false }).catch(() => undefined);
  await flushPromises();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ViewModeBanner (DESIGN MKB §9.1)', () => {
  it('is absent when disconnected and on AE64 (max / pro), and appears right below TopBar on generic', async () => {
    const { w, device } = await mountApp('/overview');
    expect(w.find('[data-testid="view-mode-banner"]').exists()).toBe(false);

    await device.connectDemo('max');
    await flushPromises();
    expect(w.find('[data-testid="view-mode-banner"]').exists()).toBe(false);

    await device.connectDemo('pro');
    await flushPromises();
    expect(w.find('[data-testid="view-mode-banner"]').exists()).toBe(false);

    await device.connectGenericMock('g60', { latencyMs: 0 });
    await flushPromises();
    const banner = w.find('[data-testid="view-mode-banner"]');
    expect(banner.exists()).toBe(true);

    // Mounted directly below TopBar inside .main (before .main__scroll)
    const main = w.find('main.main').element;
    const children = Array.from(main.children);
    const topIdx = children.findIndex((el) => el.classList.contains('top'));
    const bannerIdx = children.findIndex((el) => el.getAttribute('data-testid') === 'view-mode-banner');
    const scrollIdx = children.findIndex((el) => el.classList.contains('main__scroll'));
    expect(topIdx).toBeGreaterThanOrEqual(0);
    expect(bannerIdx).toBe(topIdx + 1);
    expect(scrollIdx).toBeGreaterThan(bannerIdx);
  });

  it('shows exact vi and en text, aria-hidden eye icon, always-underlined link, and opens help dialog', async () => {
    const { w, device } = await mountApp('/overview');
    await device.connectGenericMock('g60', { latencyMs: 0 });
    await flushPromises();

    const banner = w.find('[data-testid="view-mode-banner"]');
    expect(banner.text()).toContain('Chế độ xem');
    expect(banner.text()).toContain('Mock 60 chưa được kiểm chứng với AE64 Control. Ứng dụng chỉ đọc, không ghi gì vào bàn phím.');

    const icon = banner.find('.vmb__icon');
    expect(icon.exists()).toBe(true);
    expect(icon.attributes('aria-hidden')).toBe('true');

    const whyBtn = banner.find('[data-testid="view-mode-why"]');
    expect(whyBtn.exists()).toBe(true);
    expect(whyBtn.text()).toBe('Vì sao?');

    // Verify underline rule exists in ViewModeBanner.vue CSS (R15 / WCAG 1.4.1)
    const src = readFileSync(resolve('src/components/shell/ViewModeBanner.vue'), 'utf8');
    expect(src).toMatch(/\.vmb__why[\s\S]*text-decoration:\s*underline/);

    // Clicking "Vì sao?" opens help dialog containing §12 help body
    await whyBtn.trigger('click');
    await flushPromises();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(t('help.body'));

    // Switch to English and check exact en text
    setLocale('en');
    await nextTick();
    expect(banner.text()).toContain('View mode');
    expect(banner.text()).toContain('Mock 60 has not been verified with AE64 Control. The app only reads; nothing is written to the keyboard.');
    expect(whyBtn.text()).toBe('Why?');
    expect(dialog!.textContent).toContain(t('help.body'));
  });

  it('announces once per connection in role="status" and does NOT re-announce on route or language switch (kills M17)', async () => {
    const { w, router, device } = await mountApp('/overview');
    await device.connectGenericMock('g60', { latencyMs: 0 });
    await flushPromises();

    const liveRegion = w.find('[data-testid="view-mode-announce"]');
    expect(liveRegion.exists()).toBe(true);
    expect(liveRegion.attributes('role')).toBe('status');
    expect(liveRegion.text()).toBe('Chế độ xem: Mock 60');

    // Observe any DOM / text mutation on the live region across navigation and locale changes
    const mutations: MutationRecord[] = [];
    const mo = new MutationObserver((list) => mutations.push(...list));
    mo.observe(liveRegion.element, { childList: true, characterData: true, subtree: true });

    for (const path of ['/keymap', '/performance', '/lighting', '/profiles', '/macro', '/settings', '/firmware', '/typing', '/overview']) {
      await router.push(path);
      await flushPromises();
      expect(w.find('[data-testid="view-mode-banner"]').exists()).toBe(true);
    }
    expect(mutations).toHaveLength(0);

    // Language switch updates visible strip but must NOT re-announce in role="status"
    setLocale('en');
    await nextTick();
    await flushPromises();
    expect(w.find('[data-testid="view-mode-banner"]').text()).toContain('View mode');
    setLocale('vi');
    await nextTick();
    await flushPromises();
    expect(mutations).toHaveLength(0);
    expect(liveRegion.text()).toBe('Chế độ xem: Mock 60');

    // Connecting another generic keyboard DOES announce once for the new connection
    await device.connectGenericMock('g75', { latencyMs: 0 });
    await flushPromises();
    expect(liveRegion.text()).toBe('Chế độ xem: Mock 75');
    expect(mutations.length).toBeGreaterThan(0);

    mo.disconnect();
  });

  it('does not show the device.notAllowed toast on generic connect (g60, gspoof)', async () => {
    const device = useDeviceStore();
    const toast = useToast();
    const showSpy = vi.spyOn(toast, 'show');

    await device.connectGenericMock('g60', { latencyMs: 0 });
    await device.connectGenericMock('gspoof', { latencyMs: 0 });
    await flushPromises();

    const notAllowed = t('device.notAllowed');
    const badCalls = showSpy.mock.calls.filter(([msg]) => msg === notAllowed);
    expect(badCalls).toHaveLength(0);
  });
});
