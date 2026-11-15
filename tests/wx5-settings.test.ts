// WX5 item 3 (U-05) on the Settings page: the reviewer's zz-agentC-ui D turned round. In a file of its own, as the
// reproduction was: the page reads the keyboard once, and no other test's async work may share the run.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import SettingsPage from '../src/pages/SettingsPage.vue';
import { routes } from '../src/router';
import type { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

let w: VueWrapper | null = null;
beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); setLocale('vi'); });
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.restoreAllMocks(); localStorage.clear(); });

describe('WX5 3 U-05: Settings RGB sleep', () => {
  it('Settings: a keyboard holding RGB sleep 300 min, tabbing through the field writes nothing', async () => {
    setActivePinia(createPinia());
    clearTuningSnapshots();
    const device = useDeviceStore();
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    await mock.setRgbSleep(300);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/settings');
    w = mount(SettingsPage, { global: { plugins: [router] }, attachTo: document.body });
    const settings = useSettingsStore();
    await vi.waitFor(() => expect(settings.loaded).toBe(true));
    await flushPromises();
    const setSleep = vi.spyOn(mock, 'setRgbSleep');
    const input = w.find<HTMLInputElement>(`input[aria-label="${t('settings.rgbSleep')}"]`).element;
    expect(input.value).toBe('300');
    input.focus();
    await nextTick();
    input.blur();
    await nextTick();
    expect(settings.rgbSleep).toBe(300);
    expect(useHistoryStore().canUndo).toBe(false);
    await useSyncStore().flush();
    expect(setSleep).not.toHaveBeenCalled();
    expect(await mock.getRgbSleep()).toBe(300);
  });
});
