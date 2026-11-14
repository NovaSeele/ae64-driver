// DESIGN H §3.1, §11 items 9, 10: the support text block and "Copy info" (Settings hardware card, Diagnostics device card).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '../src/router';
import SettingsPage from '../src/pages/SettingsPage.vue';
import DiagnosticsPage from '../src/pages/DiagnosticsPage.vue';
import { browserLabel, buildSupportInfo, localStamp } from '../src/data/supportInfo';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSettingsStore } from '../src/stores/settings';
import { useToast } from '../src/components/ui/toast';
import { setLocale } from '../src/i18n/locale';
import { setTheme } from '../src/theme';
import { t } from '../src/i18n/vi';

let wrapper: VueWrapper | null = null;
const nav = navigator as unknown as Record<string, unknown>;

function setNav(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  setLocale('vi');
  setTheme('graphite');
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  delete nav.clipboard;
  delete nav.userAgentData;
  vi.useRealTimers();
  vi.restoreAllMocks();
  setLocale('vi');
  localStorage.clear();
});

const DEMO_MAX = {
  model: 'AE64 Max', demo: true, boardIdHex: '0030000d', firmware: '0.0.4.0', protocol: '1.3.0.0', rtPrecision: 0.001,
  pollingHz: 8000, macro: { capacity: 960, count: 16 },
};

describe('item 9: the text block', () => {
  it('demo Max, vi graphite: the 11 lines of §3.1, fixed English labels', () => {
    const now = new Date(2026, 10, 13, 4, 35);
    const text = buildSupportInfo({ version: '0.1.0+20261112210111', keyboard: DEMO_MAX, browser: 'unknown', locale: 'vi', theme: 'graphite', now });
    expect(text.split('\n')).toEqual([
      'AE64 Control 0.1.0+20261112210111 (web)',
      'Keyboard: AE64 Max (demo)',
      'Board ID: 0x0030000D',
      'Firmware: 0.0.4.0',
      'Protocol: 1.3.0.0',
      'RT resolution: 0.001 mm',
      'Polling rate: 8000 Hz',
      'Macro memory: 960 actions, 16 slots',
      'Browser: unknown',
      'App: vi, graphite',
      `Copied: ${localStamp(now)}`,
    ]);
    expect(localStamp(now)).toMatch(/^2026-11-13 04:35 \(UTC[+-]\d{2}:\d{2}\)$/);
  });

  it('the stamp carries the UTC offset with its sign', () => {
    const d = new Date(2026, 10, 13, 4, 35);
    vi.spyOn(d, 'getTimezoneOffset').mockReturnValue(-420);
    expect(localStamp(d)).toBe('2026-11-13 04:35 (UTC+07:00)');
    vi.spyOn(d, 'getTimezoneOffset').mockReturnValue(330);
    expect(localStamp(d)).toBe('2026-11-13 04:35 (UTC-05:30)');
    vi.spyOn(d, 'getTimezoneOffset').mockReturnValue(0);
    expect(localStamp(d)).toBe('2026-11-13 04:35 (UTC+00:00)');
  });

  it('not connected: "Keyboard: not connected", no Board ID … Macro lines', () => {
    const text = buildSupportInfo({ version: '1', keyboard: null, browser: 'unknown', locale: 'en', theme: 'auto', now: new Date() });
    const lines = text.split('\n');
    expect(lines[1]).toBe('Keyboard: not connected');
    expect(lines).toHaveLength(5);
    expect(text).not.toMatch(/Board ID|Firmware|Polling|Macro/);
  });

  it('values not read yet are "—"', () => {
    const text = buildSupportInfo({
      version: '1', keyboard: { model: null, demo: false, pollingHz: null, macro: null }, browser: 'x', locale: 'vi', theme: 'auto', now: new Date(),
    });
    expect(text).toContain('Keyboard: AE64 (WebHID)');
    expect(text).toContain('Board ID: —');
    expect(text).toContain('Polling rate: —');
    expect(text).toContain('Macro memory: —');
    expect(text).toContain('RT resolution: —');
  });

  it('browser: unknown without userAgentData (jsdom); a named brand before Chromium, never the "Not…A…Brand" placeholder', () => {
    expect(browserLabel(navigator as never)).toBe('unknown');
    expect(browserLabel(undefined)).toBe('unknown');
    expect(browserLabel({ userAgentData: { brands: [{ brand: 'Not.A/Brand', version: '99' }, { brand: 'Chromium', version: '147' }, { brand: 'Google Chrome', version: '147' }], platform: 'Windows' } }))
      .toBe('Google Chrome 147 · Windows');
    expect(browserLabel({ userAgentData: { brands: [{ brand: 'Chromium', version: '147' }, { brand: ' Not;A Brand', version: '8' }], platform: '' } }))
      .toBe('Chromium 147');
    expect(browserLabel({ userAgentData: { brands: [{ brand: 'Not_A Brand', version: '8' }] } })).toBe('unknown');
  });
});

async function settingsPage() {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/settings');
  wrapper = mount(SettingsPage, { global: { plugins: [router] }, attachTo: document.body });
  await vi.waitFor(() => expect(useSettingsStore().loaded).toBe(true));
  await flushPromises();
  const out: string[] = [];
  mock.onPacket((e) => { if (e.dir === 'out' && !(e.bytes[0] === 4 && e.bytes[1] === 3)) out.push([...e.bytes.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' ')); });
  const hw = wrapper.findAll('.card').find((c) => c.find('.card__title').text() === t('settings.deviceInfo'))!;
  return { device, out, w: wrapper, hw, button: () => hw.find('.card__actions button') };
}

describe('item 10: Copy info on the Settings hardware card', () => {
  it('copies the block (no serial number), says so, shows "Copied" for 2 s; 0 HID', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });
    setNav('userAgentData', { brands: [{ brand: 'Chromium', version: '147' }], platform: 'Windows' });
    const { device, out, button } = await settingsPage();
    expect(button().text()).toBe(t('info.copy'));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    // later than now: Vue ignores an event older than its listener (the fake clock stamps the event)
    vi.setSystemTime(new Date(2030, 0, 2, 4, 35));
    await button().trigger('click');
    for (let i = 0; i < 5; i++) await Promise.resolve(); // microtasks only: vi.waitFor would move the fake clock
    expect(writeText).toHaveBeenCalledTimes(1);
    const text = writeText.mock.calls[0][0] as string;
    const lines = text.split('\n');
    expect(lines).toHaveLength(11);
    expect(lines.slice(1)).toEqual([
      'Keyboard: AE64 Max (demo)', 'Board ID: 0x0030000D', 'Firmware: 0.0.4.0', 'Protocol: 1.3.0.0', 'RT resolution: 0.001 mm',
      'Polling rate: 8000 Hz', 'Macro memory: 960 actions, 16 slots', 'Browser: Chromium 147 · Windows', 'App: vi, graphite',
      `Copied: ${localStamp(new Date(2030, 0, 2, 4, 35))}`,
    ]);
    expect(lines[0]).toMatch(/^AE64 Control \S+ \(web\)$/);
    expect(device.info?.serial).toBeTruthy();
    expect(text).not.toContain(device.info!.serial);
    expect(useToast().items.value.map((x) => x.text)).toContain(t('info.copiedToast'));
    expect(button().text()).toBe(t('info.copied'));
    vi.advanceTimersByTime(1999);
    await flushPromises();
    expect(button().text()).toBe(t('info.copied'));
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(button().text()).toBe(t('info.copy'));
    expect(out).toEqual([]);
  });

  it('labels stay English when the app is in English', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });
    setLocale('en');
    const { button } = await settingsPage();
    await button().trigger('click');
    await flushPromises();
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('Keyboard: AE64 Max (demo)');
    expect(text).toContain('Macro memory: 960 actions, 16 slots');
    expect(text).toContain('App: en, graphite');
  });

  it('writeText refuses → the dialog with the text selected and focused, no error toast; Close → focus back on the button', async () => {
    setNav('clipboard', { writeText: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')) });
    const { button, out } = await settingsPage();
    (button().element as HTMLButtonElement).focus();
    await button().trigger('click');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 5));
    const area = document.body.querySelector<HTMLTextAreaElement>('.ci__text')!;
    expect(area).toBeTruthy();
    expect(area.readOnly).toBe(true);
    expect(area.getAttribute('aria-label')).toBe(t('info.copyLabel'));
    expect(area.value.split('\n')).toHaveLength(11);
    expect(document.activeElement).toBe(area);
    expect(area.selectionStart).toBe(0);
    expect(area.selectionEnd).toBe(area.value.length);
    expect(document.body.querySelector('.ci__help')!.textContent).toBe(t('info.copyHelp', { mod: 'Ctrl' }));
    expect(useToast().items.value.filter((x) => x.kind === 'error')).toEqual([]);
    const close = [...document.body.querySelectorAll<HTMLButtonElement>('.dlg__foot button')].find((b) => b.textContent!.trim() === t('info.close'))!;
    close.click();
    await flushPromises();
    expect(document.body.querySelector('.ci__text')).toBeNull();
    expect(document.activeElement).toBe(button().element);
    expect(out).toEqual([]);
  });

  it('no Clipboard API at all → the same dialog', async () => {
    const { button } = await settingsPage();
    await button().trigger('click');
    await flushPromises();
    expect(document.body.querySelector('.ci__text')).toBeTruthy();
  });

  it('macOS: the help says ⌘', async () => {
    setNav('userAgentData', { brands: [], platform: 'macOS' });
    const { button } = await settingsPage();
    await button().trigger('click');
    await flushPromises();
    expect(document.body.querySelector('.ci__help')!.textContent).toBe(t('info.copyHelp', { mod: '⌘' }));
  });
});

describe('item 10: Copy info on the Diagnostics device card', () => {
  async function diagPage() {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const mock = device.transport as MockTransport;
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/diagnostics');
    const out: string[] = [];
    mock.onPacket((e) => { if (e.dir === 'out' && !(e.bytes[0] === 4 && e.bytes[1] === 3)) out.push([...e.bytes.slice(0, 3)].map((b) => b.toString(16)).join(' ')); });
    wrapper = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    const card = wrapper.findAll('.card').find((c) => c.find('.card__title').text() === t('diagnostics.deviceTitle'))!;
    return { out, card };
  }

  it('settings never read here: polling rate and macro memory are "—", and nothing is read for it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });
    const { out, card } = await diagPage();
    const load = vi.spyOn(useSettingsStore(), 'load');
    out.length = 0;
    expect(useSettingsStore().loaded).toBe(false);
    await card.find('.card__actions button').trigger('click');
    await flushPromises();
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('Polling rate: —');
    expect(text).toContain('Macro memory: —');
    expect(text).toContain('Board ID: 0x0030000D');
    expect(load).not.toHaveBeenCalled();
    expect(out).toEqual([]);
    expect(card.find('.card__actions button').text()).toBe(t('info.copied'));
  });

  it('H-TEST-6: settings read once, then a load that failed: polling rate and macro memory are "—", not the old values', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });
    const { card } = await diagPage();
    const settings = useSettingsStore();
    await settings.load();
    expect(settings.loaded).toBe(true); // values are there …
    settings.loadError = 'x'; // … but the last read failed
    expect(settings.loaded).toBe(true);
    await card.find('.card__actions button').trigger('click');
    await flushPromises();
    const text = writeText.mock.calls[0][0] as string;
    expect(text).toContain('Polling rate: —');
    expect(text).toContain('Macro memory: —');
  });
});
