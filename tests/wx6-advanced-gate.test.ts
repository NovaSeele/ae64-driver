// WX6 U-06: Disconnect / Change keyboard / the demo-model switch ask the Advanced tab's own draft question first.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { PHYSICAL_KEYS } from '../src/protocol';
import { mountAt } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { useSelectionStore } from '../src/stores/selection';
import { usePerformanceStore } from '../src/stores/performance';
import { useAdvancedStore } from '../src/stores/advanced';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

let w: VueWrapper | null = null;
let pinia: Pinia;
const settle = async () => { for (let i = 0; i < 8; i++) await flushPromises(); };
const dialogs = () => document.querySelectorAll('[role="dialog"]').length;
const keyId = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!.id;
const dialogButton = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((b) => b.textContent?.trim() === label)!;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  clearTuningSnapshots();
  locale.value = 'vi';
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function dirtyAdvanced() {
  const device = useDeviceStore();
  await device.connectDemo();
  await device.switchProfile(1);
  await useAdvancedStore().load();
  w = (await mountAt('/performance?tab=advanced', { plugins: [pinia] })).w;
  await vi.waitFor(() => {
    expect(usePerformanceStore().loading).toBe(false);
    expect(useAdvancedStore().loading).toBe(false);
  }, { timeout: 15000, interval: 5 });
  await settle();
  await w.find('.item__main').trigger('click');
  await settle();
  useSelectionStore().selectMany([keyId('W')]);
  await settle();
  expect(useHistoryStore().suspended).toBe(true); // dirty
  return device;
}

describe('WX6 U-06: the Advanced draft and the device buttons', () => {
  it('Disconnect asks with the tab\'s dialog; keep = still connected, drop = disconnected', async () => {
    const device = await dirtyAdvanced();
    await device.disconnect({ user: true });
    await settle();
    expect(dialogs()).toBe(1);
    expect(device.connected).toBe(true);
    dialogButton(t('advanced.discardKeep')).click();
    await settle();
    expect(device.connected).toBe(true);
    expect(useHistoryStore().suspended).toBe(true); // still dirty
    await device.disconnect({ user: true });
    await settle();
    dialogButton(t('advanced.discardDo')).click();
    await vi.waitFor(() => expect(device.connected).toBe(false));
  });

  it('the demo-model switch asks first', async () => {
    const device = await dirtyAdvanced();
    await device.switchDemoModel('pro');
    await settle();
    expect(dialogs()).toBe(1);
    expect(device.model).toBe('max');
  });
});
