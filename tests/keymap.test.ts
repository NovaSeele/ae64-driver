import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { useKeymapStore } from '../src/stores/keymap';

async function connectMock(): Promise<MockTransport> {
  const device = useDeviceStore();
  await device.connectDemo();
  return device.transport as MockTransport;
}

describe('keymap store', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('loads 4 layers across 64 keys from MockTransport', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    await keymap.load();

    expect(keymap.loadedCount).toBe(20); // 4 layers * 5 rows
    expect(Object.keys(keymap.values[0]).length).toBe(64);
    expect(Object.keys(keymap.values[1]).length).toBe(64);
    expect(Object.keys(keymap.values[2]).length).toBe(64);
    expect(Object.keys(keymap.values[3]).length).toBe(64);

    // Esc is key 0
    const esc = PHYSICAL_KEYS[0];
    expect(keymap.legendFor(esc, 0)).toBe('Esc');
  });

  it('correctly displays legends and sublabels for Transparent and Empty keys', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    await keymap.load();

    const esc = PHYSICAL_KEYS[0];
    // In MockTransport, layer 1 has Transparent (0x0001) for Esc
    expect(keymap.values[1][esc.id]).toBe(0x0001);
    expect(keymap.legendFor(esc, 1)).toBe('▽');
    expect(keymap.sublabelFor(esc, 1)).toBe('Esc');

    // Test Empty (0x0000)
    keymap.values[1][esc.id] = 0x0000;
    expect(keymap.legendFor(esc, 1)).toBe('—');
    expect(keymap.sublabelFor(esc, 1)).toBeUndefined();
  });

  it('writes keycodes and verifies by read-back', async () => {
    const mock = await connectMock();
    const keymap = useKeymapStore();
    const sync = useSyncStore();
    await keymap.load();

    const esc = PHYSICAL_KEYS[0];
    keymap.activeLayer = 0;
    keymap.applyKeycode([esc.id], 0x0004); // Key 'A'
    expect(keymap.values[0][esc.id]).toBe(0x0004);

    await sync.flush();
    const read = await mock.getKeycode(esc, 0);
    expect(read).toBe(0x0004);
  });

  it('supports history undo and redo for keymap edits', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    const history = useHistoryStore();
    const sync = useSyncStore();
    await keymap.load();

    const esc = PHYSICAL_KEYS[0];
    const prevCode = keymap.values[0][esc.id];
    keymap.activeLayer = 0;
    keymap.applyKeycode([esc.id], 0x0005); // Key 'B'
    expect(keymap.values[0][esc.id]).toBe(0x0005);

    history.undo();
    expect(keymap.values[0][esc.id]).toBe(prevCode);

    history.redo();
    expect(keymap.values[0][esc.id]).toBe(0x0005);

    await sync.flush();
  });

  it('applies Fn release rule: higher layers get Transparent 0001', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    const sync = useSyncStore();
    await keymap.load();

    const key = PHYSICAL_KEYS[5]; // Key '5'
    keymap.activeLayer = 0;
    // Set higher layers to something else first to verify they get overwritten
    keymap.values[1][key.id] = 0x0010;
    keymap.values[2][key.id] = 0x0020;
    keymap.values[3][key.id] = 0x0030;

    const res = keymap.applyKeycode([key.id], 0xf101); // Fn1 switch
    expect(res.fnGuarded).toBe(true);
    expect(keymap.values[0][key.id]).toBe(0xf101);
    expect(keymap.values[1][key.id]).toBe(0x0001);
    expect(keymap.values[2][key.id]).toBe(0x0001);
    expect(keymap.values[3][key.id]).toBe(0x0001);

    await sync.flush();
  });

  it('computes default-layer diff and applies restore', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    const sync = useSyncStore();
    await keymap.load();

    const k1 = PHYSICAL_KEYS[1];
    const k2 = PHYSICAL_KEYS[2];
    keymap.activeLayer = 0;
    keymap.applyKeycode([k1.id, k2.id], 0x004c); // Delete
    await sync.flush();

    const diff = await keymap.computeDefaultDiff(0);
    expect(diff.diffCount).toBeGreaterThanOrEqual(2);

    keymap.applyDefault(0, diff.defaultCodes);
    await sync.flush();

    const afterDiff = await keymap.computeDefaultDiff(0);
    expect(afterDiff.diffCount).toBe(0);
  });
});
