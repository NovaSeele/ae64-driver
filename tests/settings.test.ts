import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { flushPromises, mount } from '@vue/test-utils';
import SettingsPage from '../src/pages/SettingsPage.vue';
import { t } from '../src/i18n/vi';
import Segmented from '../src/components/ui/Segmented.vue';
import { PROFILE_NAME_MAX_BYTES, truncateUtf8, useSettingsStore, utf8Bytes } from '../src/stores/settings';

async function connectMock(): Promise<MockTransport> {
  const device = useDeviceStore();
  await device.connectDemo();
  return device.transport as MockTransport;
}

describe('settings store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads settings and hardware info from device', async () => {
    await connectMock();
    const settings = useSettingsStore();
    await settings.load();

    expect(settings.systemMode).toBe(0); // Windows
    expect(settings.supportedRates).toContain(0); // 8000 Hz
    expect(settings.rgbSleep).toBe(0); // Initial demo setting is 0 (off)
    expect(settings.shakeOptimization).toBe(true);
    expect(settings.macroSpace.count).toBe(16);
    expect(settings.lightingAreas?.count).toBe(2);
  });

  it('a setting whose write is given up shows the value the keyboard really has', async () => {
    const mock = await connectMock();
    const settings = useSettingsStore();
    const sync = useSyncStore();
    await settings.load();
    expect(settings.systemMode).toBe(0);
    vi.spyOn(mock, 'setSystemMode').mockRejectedValue(new Error('usb'));
    settings.setSystemMode(1);
    expect(settings.systemMode).toBe(1); // optimistic
    for (let i = 0; i < 3; i++) await sync.flush().catch(() => undefined);
    expect(sync.pendingCount()).toBe(0);
    expect(await mock.getSystemMode()).toBe(0);
    expect(settings.systemMode).toBe(0);
  });

  it('updates system mode, polling rate, rgb sleep and shake optimization with read-back verification', async () => {
    const mock = await connectMock();
    const settings = useSettingsStore();
    const sync = useSyncStore();
    await settings.load();

    const out: number[][] = [];
    mock.onPacket((e) => { if (e.dir === 'out') out.push(e.bytes); });

    settings.setSystemMode(1); // macOS
    settings.setRgbSleep(20);
    settings.setShakeOptimization(true);
    await settings.setPollingRate(3); // 1000 Hz — flushes the queue first, then is sent last

    await sync.flush();

    // Global settings are applied without a 02 02 commit (factory driver behaviour).
    expect(out.some((b) => b[0] === 0x02 && b[1] === 0x02)).toBe(false);
    // Nothing but reads after the polling-rate write (the real keyboard restarts its USB interface).
    const idx = out.findIndex((b) => b[0] === 0x02 && b[1] === 0x05 && b[2] === 0x02);
    expect(idx).toBeGreaterThan(-1);
    expect(out.slice(idx + 1).every((b) => !(b[0] === 0x02 && [0x02, 0x04, 0x0d, 0x10].includes(b[1]) && b[2] !== 0x01))).toBe(true);

    expect(await mock.getSystemMode()).toBe(1);
    expect(await mock.getPollingRate()).toBe(3);
    expect(await mock.getRgbSleep()).toBe(20);
    expect(await mock.getShakeOptimization()).toBe(true);
  });

  it('supports undo/redo for settings changes', async () => {
    await connectMock();
    const settings = useSettingsStore();
    const history = useHistoryStore();
    const sync = useSyncStore();
    await settings.load();

    const prev = settings.rgbSleep;
    settings.setRgbSleep(30);
    expect(settings.rgbSleep).toBe(30);

    history.undo();
    expect(settings.rgbSleep).toBe(prev);

    history.redo();
    expect(settings.rgbSleep).toBe(30);
    // Undo/redo must not push new history entries (redo stays available after undo).
    history.undo();
    expect(history.canRedo).toBe(true);
    history.redo();
    expect(settings.rgbSleep).toBe(30);

    await sync.flush();
  });

  it('renames profile via device store and verifies name', async () => {
    const mock = await connectMock();
    const device = useDeviceStore();
    await device.renameProfile(0, 'Gaming Pro');

    expect(device.profileNames[0]).toBe('Gaming Pro');
    expect(await mock.getProfileName(0)).toBe('Gaming Pro');
  });

  it('is not loaded (defaults only) until read from the keyboard, and again after a new connection', async () => {
    await connectMock();
    const settings = useSettingsStore();
    expect(settings.loaded).toBe(false);
    await settings.load();
    expect(settings.loaded).toBe(true);
    expect(settings.loadError).toBeNull();

    await useDeviceStore().connectDemo(); // a new transport: the values belong to the old connection
    expect(settings.loaded).toBe(false);
  });

  it('stays not loaded and reports the error when reading fails', async () => {
    const mock = await connectMock();
    const settings = useSettingsStore();
    vi.spyOn(mock, 'getRgbSleep').mockRejectedValue(new Error('timeout'));
    await settings.load();
    expect(settings.loaded).toBe(false);
    expect(settings.loadError).toContain('timeout');
  });

  it('exposes the requested polling rate as pending while applying', async () => {
    await connectMock();
    const settings = useSettingsStore();
    await settings.load();
    const p = settings.setPollingRate(3);
    expect(settings.pollingState).toBe('applying');
    expect(settings.pollingTarget).toBe(3);
    await p;
    expect(settings.pollingTarget).toBeNull();
    expect(settings.pollingRate).toBe(3);
  });
});

describe('profile name byte limit', () => {
  it('counts UTF-8 bytes, not characters', () => {
    expect(utf8Bytes('abc')).toBe(3);
    expect(utf8Bytes('Phím')).toBe(5);
    expect(utf8Bytes('Việt')).toBe(6);
  });

  it('truncates to the limit without splitting a character', () => {
    expect(truncateUtf8('abc', 32)).toBe('abc');
    const long = 'Bàn phím chơi game của tôi rất nhanh';
    const cut = truncateUtf8(long, PROFILE_NAME_MAX_BYTES);
    expect(utf8Bytes(cut)).toBeLessThanOrEqual(PROFILE_NAME_MAX_BYTES);
    expect(long.startsWith(cut)).toBe(true);
    expect(utf8Bytes(truncateUtf8('ệệệệệệệệệệệệ', 32))).toBe(30); // 10 × 3 bytes; the 11th would not fit
    expect(truncateUtf8('abc', 0)).toBe('');
  });
});

describe('Segmented', () => {
  const options = [{ value: 0, label: 'A' }, { value: 1, label: 'B' }, { value: 2, label: 'C' }];
  const make = (extra: Record<string, unknown> = {}) =>
    mount(Segmented, { props: { modelValue: 0, options, label: 'x', ...extra }, attachTo: document.body });

  it('default: arrow keys select as they move focus', async () => {
    const w = make();
    await w.get('[data-v="0"]').trigger('keydown', { key: 'ArrowRight' });
    expect(w.emitted('update:modelValue')?.[0]).toEqual([1]);
    w.unmount();
  });

  it('manual: arrows only move focus; click selects', async () => {
    const w = make({ manual: true });
    const a = w.get('[data-v="0"]');
    (a.element as HTMLElement).focus();
    await a.trigger('keydown', { key: 'ArrowRight' });
    expect(w.emitted('update:modelValue')).toBeUndefined();
    expect(document.activeElement).toBe(w.get('[data-v="1"]').element);
    // focus keeps travelling from the focused option, not from the selected one
    await w.get('[data-v="1"]').trigger('keydown', { key: 'ArrowRight' });
    expect(document.activeElement).toBe(w.get('[data-v="2"]').element);
    await w.get('[data-v="2"]').trigger('click');
    expect(w.emitted('update:modelValue')?.[0]).toEqual([2]);
    w.unmount();
  });

  it('disabled: no selection by click or key', async () => {
    const w = make({ disabled: true });
    await w.get('[data-v="1"]').trigger('click');
    await w.get('[data-v="0"]').trigger('keydown', { key: 'ArrowRight' });
    expect(w.emitted('update:modelValue')).toBeUndefined();
    expect(w.get('[data-v="1"]').attributes('disabled')).toBeDefined();
    w.unmount();
  });
});

describe('SettingsPage polling rate control', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('shows bare numbers, keeps "Hz" in accessible names and the confirm dialog', async () => {
    await connectMock();
    const settings = useSettingsStore();
    await settings.load();
    const w = mount(SettingsPage, { attachTo: document.body });
    await flushPromises();
    const group = w.findAll('[role="radiogroup"]').find((g) => g.attributes('aria-label') === t('settings.pollingRate'))!;
    const opts = group.findAll('[role="radio"]');
    expect(opts.length).toBeGreaterThan(0);
    for (const o of opts) {
      expect(o.text()).toMatch(/^\d+$/);
      expect(o.attributes('aria-label')).toMatch(/^\d+ Hz$/);
    }
    expect(w.find('.settings-rate__unit').text()).toBe('Hz');
    const other = opts.find((o) => o.attributes('aria-checked') === 'false')!;
    await other.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toMatch(/\d+ Hz\?/);
    w.unmount();
  });
});
