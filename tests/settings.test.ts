import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { useSettingsStore } from '../src/stores/settings';

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
});
