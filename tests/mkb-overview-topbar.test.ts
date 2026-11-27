import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { installPerfTabGuard, routes } from '../src/router';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { clearTuningSnapshots } from '../src/stores/tuning';
import OverviewPage from '../src/pages/OverviewPage.vue';
import TopBar from '../src/components/shell/TopBar.vue';

vi.setConfig({ testTimeout: 30000 });

let pinia: Pinia;
const mounted: VueWrapper[] = [];

function makeRouter() {
  const r = createRouter({ history: createMemoryHistory(), routes });
  installPerfTabGuard(r);
  return r;
}

async function mountOverviewAndTopBar() {
  const router = makeRouter();
  await router.push('/overview');
  await router.isReady();
  const ov = mount(OverviewPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
  const tb = mount(TopBar, { global: { plugins: [router, pinia] }, attachTo: document.body });
  mounted.push(ov, tb);
  await vi.waitFor(() => {
    expect(usePerformanceStore().loading).toBe(false);
    expect(useSettingsStore().loading).toBe(false);
  }, { timeout: 10000, interval: 5 });
  await flushPromises();
  return { ov, tb };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  clearTuningSnapshots();
  setLocale('vi');
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 1000 } }]); }
    unobserve() {}
    disconnect() {}
  });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(async () => {
  while (mounted.length) mounted.pop()!.unmount();
  await useDeviceStore().disconnect({ flush: false }).catch(() => undefined);
  await flushPromises();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MKB-V Overview & TopBar view mode', () => {
  it('on g60: shows cardSub in hero with status dot, hides edit cues, save pill, and undo/redo', async () => {
    const device = useDeviceStore();
    await device.connectGenericMock('g60', { latencyMs: 0 });
    expect(device.support).toBe('generic');

    const { ov, tb } = await mountOverviewAndTopBar();

    const meta = ov.find('.ovh__meta');
    expect(meta.find('.ovh__dot').exists()).toBe(true);
    const expectedSub = t('mkb.name.cardSub', {
      board: device.info!.boardIdHex.toUpperCase(),
      fw: device.info!.firmware,
    });
    expect(meta.text()).toBe(expectedSub);

    expect(ov.text()).not.toContain(t('ov.editKeys'));
    expect(ov.text()).not.toContain(t('ov.tune'));
    expect(ov.find('.ovh__actions').text()).toContain(t('page.performance'));

    const subText = ov.find('.ovk__sub').text();
    expect(subText).toContain(device.activeProfileName);
    expect(subText).not.toContain('Bấm một phím để sửa nó');
    expect(subText).not.toContain('Click a key to edit it');

    expect(tb.find('.pill').exists()).toBe(false);
    expect(tb.find('.top__hist').exists()).toBe(false);
    expect(tb.findAll('.top__hist button')).toHaveLength(0);
  });

  it('on AE64 demo (max): hero meta, edit cues, save pill, and undo/redo still show as before', async () => {
    const device = useDeviceStore();
    await device.connectDemo('max');
    expect(device.support).toBe('ae64');

    const { ov, tb } = await mountOverviewAndTopBar();

    const meta = ov.find('.ovh__meta');
    expect(meta.find('.ovh__dot').exists()).toBe(true);
    expect(meta.text()).toContain(t('device.demo'));
    expect(meta.text()).toContain(t('device.firmware'));
    expect(meta.text()).toContain(device.info!.firmware);

    expect(ov.text()).toContain(t('ov.editKeys'));
    expect(ov.text()).toContain(t('ov.tune'));
    expect(ov.find('.ovk__sub').text()).toBe(t('ov.keyboardSub', { name: device.activeProfileName }));

    expect(tb.find('.pill').exists()).toBe(true);
    expect(tb.find('.pill').text()).toContain(t('sync.saved'));
    expect(tb.find('.top__hist').exists()).toBe(true);
    expect(tb.findAll('.top__hist button')).toHaveLength(2);
  });
});
