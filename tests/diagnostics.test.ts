import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useKeymapStore } from '../src/stores/keymap';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { useDiagnosticsStore } from '../src/stores/diagnostics';

async function connectMock(): Promise<MockTransport> {
  const device = useDeviceStore();
  await device.connectDemo();
  return device.transport as MockTransport;
}

describe('diagnostics store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('exports configuration with valid versioned schema shape', async () => {
    await connectMock();
    const diag = useDiagnosticsStore();
    const backup = await diag.generateBackup();

    expect(backup.schemaVersion).toBe(1);
    expect(backup.appName).toBe('ae64max');
    expect(backup.boardIdHex).toBe('0030000d');
    expect(backup.profileIndex).toBe(0);
    expect(backup.profileName).toBeTruthy();
    expect(new Date(backup.timestamp).getTime()).toBeGreaterThan(0);

    // Global settings
    expect(backup.globalSettings).toBeDefined();
    expect(typeof backup.globalSettings.systemMode).toBe('number');
    expect(typeof backup.globalSettings.pollingRate).toBe('number');

    // Keymap: 4 layers × 64 keys
    expect(Object.keys(backup.keymap).length).toBe(4);
    expect(Object.keys(backup.keymap[0]).length).toBe(64);

    // Performance: 64 keys
    expect(Object.keys(backup.performance).length).toBe(64);

    // Lighting: 2 areas
    expect(backup.lighting.areas.length).toBe(2);
    expect(backup.lighting.areas[0].leds.length).toBe(126);
    expect(backup.lighting.areas[1].leds.length).toBe(38);

    // Macros: 16 slots
    expect(backup.macros.length).toBe(16);
  });

  it('rejects invalid JSON, wrong schema, or disallowed board ID', async () => {
    await connectMock();
    const diag = useDiagnosticsStore();

    await expect(diag.parseAndDiffBackup('{ invalid json')).rejects.toThrow('invalid_json');

    const badSchema = JSON.stringify({ schemaVersion: 99, boardIdHex: '0030000d' });
    await expect(diag.parseAndDiffBackup(badSchema)).rejects.toThrow('invalid_schema');

    const badBoard = JSON.stringify({ schemaVersion: 1, boardIdHex: 'ffffffff' });
    await expect(diag.parseAndDiffBackup(badBoard)).rejects.toThrow('invalid_board');
  });

  it('calculates diff summary on import', async () => {
    await connectMock();
    const diag = useDiagnosticsStore();
    const backup = await diag.generateBackup();

    // Modify some values in backup
    const esc = PHYSICAL_KEYS[0];
    backup.keymap[0][esc.id] = 0x004c; // Delete
    backup.performance[esc.id].normalPress = 1.0;
    backup.globalSettings.systemMode = 1; // macOS
    backup.globalSettings.pollingRate = 2; // 2000 Hz — never restored from a backup (USB restart)

    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));
    expect(diff.keymapDiffCount).toBe(1);
    expect(diff.perfDiffCount).toBe(1);
    expect(diff.settingsDiffCount).toBe(1);
  });

  it('restores keymap, performance and global settings from backup', async () => {
    const mock = await connectMock();
    const diag = useDiagnosticsStore();
    const keymapStore = useKeymapStore();
    const perfStore = usePerformanceStore();
    const settingsStore = useSettingsStore();

    const backup = await diag.generateBackup();
    const esc = PHYSICAL_KEYS[0];
    backup.keymap[0][esc.id] = 0x0014; // Key 'Q'
    backup.performance[esc.id].mode = 0;
    backup.performance[esc.id].normalPress = 1.5;
    backup.globalSettings.rgbSleep = 5;

    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));
    await diag.applyRestore(diff);

    // Verify keymap restored
    expect(keymapStore.values[0][esc.id]).toBe(0x0014);
    expect(await mock.getKeycode(esc, 0)).toBe(0x0014);

    // Verify performance restored
    expect(perfStore.values[esc.id].mode).toBe(0);
    expect(perfStore.values[esc.id].normalPress).toBe(1.5);

    // Verify settings restored
    expect(settingsStore.rgbSleep).toBe(5);
    expect(await mock.getRgbSleep()).toBe(5);
  }, 15000);

  it('rejects backup payload with blocked keycode (0xF200) without writing to transport', async () => {
    const mock = await connectMock();
    const diag = useDiagnosticsStore();
    const backup = await diag.generateBackup();
    const esc = PHYSICAL_KEYS[0];
    backup.keymap[0][esc.id] = 0xf200; // Blocked keycode

    const setKeycode = vi.spyOn(mock, 'setKeycode');
    const setPerformance = vi.spyOn(mock, 'setPerformance');

    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));
    await expect(diag.applyRestore(diff)).rejects.toThrow(/Blocked keycode/);

    expect(setKeycode).not.toHaveBeenCalled();
    expect(setPerformance).not.toHaveBeenCalled();
  });

  it('rejects backup payload with unknown unassignable keycode (0xF204) without writing to transport', async () => {
    const mock = await connectMock();
    const diag = useDiagnosticsStore();
    const backup = await diag.generateBackup();
    const esc = PHYSICAL_KEYS[0];
    backup.keymap[0][esc.id] = 0xf204; // Unknown unassignable keycode

    const setKeycode = vi.spyOn(mock, 'setKeycode');
    const setPerformance = vi.spyOn(mock, 'setPerformance');

    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));
    await expect(diag.applyRestore(diff)).rejects.toThrow(/Unassignable keycode/);

    expect(setKeycode).not.toHaveBeenCalled();
    expect(setPerformance).not.toHaveBeenCalled();
  });

  it('flushes pending queued edits before restore writes, and clears history after restore', async () => {
    await connectMock();
    const diag = useDiagnosticsStore();
    const perfStore = usePerformanceStore();
    const history = useHistoryStore();
    const sync = useSyncStore();

    await perfStore.load();
    const esc = PHYSICAL_KEYS[0];
    const wKey = PHYSICAL_KEYS[16];

    // Enqueue a pending perf edit on 'W'
    perfStore.apply([wKey.id], () => ({ normalPress: 1.1 }), 'edit W');
    expect(sync.state).toBe('pending');
    expect(history.canUndo).toBe(true);

    const backup = await diag.generateBackup();
    backup.keymap[0][esc.id] = 0x0014; // Key 'Q'
    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));

    await diag.applyRestore(diff);

    // Verify pending perf edit was flushed and saved
    expect(sync.state).toBe('saved');
    expect(perfStore.values[wKey.id].normalPress).toBeCloseTo(1.1);
    expect(history.canUndo).toBe(false);
  }, 15000);

  it('reports written sections and clears history when restore fails part-way', async () => {
    const mock = await connectMock();
    const diag = useDiagnosticsStore();
    const history = useHistoryStore();

    const backup = await diag.generateBackup();
    const esc = PHYSICAL_KEYS[0];
    backup.keymap[0][esc.id] = 0x0014; // Key 'Q' (changed keymap)
    backup.performance[esc.id].normalPress = 1.3; // changed perf

    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));

    // Force performance write to fail after keymap writes
    vi.spyOn(mock, 'setPerformance').mockRejectedValue(new Error('simulated perf bus error'));

    // Push something to history to verify it gets cleared
    history.push({ label: 'test', undo: () => {}, redo: () => {} });
    expect(history.canUndo).toBe(true);

    await expect(diag.applyRestore(diff)).rejects.toThrow(/keymap written; performance failed: simulated perf bus error/);

    expect(history.canUndo).toBe(false);
  }, 15000);
});
