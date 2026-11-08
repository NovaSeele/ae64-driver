import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { BULK_CONFIRM_KEYS, needsAssignConfirm, useKeymapStore } from '../src/stores/keymap';

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

  it('layer-0 key edit: device.layer0[id] retains new code before and after flush', async () => {
    await connectMock();
    const device = useDeviceStore();
    const keymap = useKeymapStore();
    const sync = useSyncStore();
    await keymap.load(true);

    const esc = PHYSICAL_KEYS[0];
    keymap.activeLayer = 0;
    keymap.applyKeycode([esc.id], 0x0004); // Key 'A'
    expect(device.layer0[esc.id]).toBe(0x0004);

    await sync.flush();
    expect(device.layer0[esc.id]).toBe(0x0004);
  });

  it('does not write or undo/redo to a BLOCKED keycode', async () => {
    const mock = await connectMock();
    const esc = PHYSICAL_KEYS[0];
    const wKey = PHYSICAL_KEYS[16]; // 'W' key

    // Pre-seed mock layer 1 Esc key to 0xF200 (factory reset)
    (mock as unknown as { profiles: { keymap: number[][][] }[] }).profiles[0].keymap[1][esc.row][esc.col] = 0xf200;

    const keymap = useKeymapStore();
    const sync = useSyncStore();
    const history = useHistoryStore();
    await keymap.load(true);
    expect(keymap.values[1][esc.id]).toBe(0xf200);

    // Applying blocked keycode directly returns fnGuarded=false with no changes
    keymap.activeLayer = 0;
    const blockedRes = keymap.applyKeycode([esc.id], 0xf200);
    expect(blockedRes.fnGuarded).toBe(false);

    // Edit key holding F200 on layer 1 to 0x0004
    keymap.activeLayer = 1;
    keymap.applyKeycode([esc.id], 0x0004);
    expect(keymap.values[1][esc.id]).toBe(0x0004);
    await sync.flush();

    // History undo must NOT enqueue setKeycode(0xF200); local value stays 0x04
    const setKeycode = vi.spyOn(mock, 'setKeycode');
    history.undo();
    await sync.flush().catch(() => undefined);
    expect(setKeycode.mock.calls.some(([, code]) => code === 0xf200)).toBe(false);
    expect(keymap.values[1][esc.id]).toBe(0x0004);

    // A later edit of another key still saves
    keymap.activeLayer = 0;
    keymap.applyKeycode([wKey.id], 0x0005);
    await sync.flush();
    expect(setKeycode.mock.calls.some(([pos, code]) => pos.row === wKey.row && pos.col === wKey.col && code === 0x0005)).toBe(true);
    expect(sync.state).toBe('saved');
  });

  it('restore-default writes only the layer captured at click time and reports the real count', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    const sync = useSyncStore();
    await keymap.load(true);

    const k = PHYSICAL_KEYS[1];
    keymap.activeLayer = 1;
    keymap.applyKeycode([k.id], 0x004c);
    await sync.flush();
    const diff = await keymap.computeDefaultDiff(1);
    expect(diff.diffCount).toBeGreaterThanOrEqual(1);

    // The user switches layer after the click: the diff must still go to layer 1.
    keymap.activeLayer = 0;
    const layer0Before = { ...keymap.values[0] };
    const written = keymap.applyDefault(1, diff.defaultCodes);
    expect(written).toBe(diff.diffCount);
    expect(keymap.values[0]).toEqual(layer0Before);
    expect(keymap.values[1][k.id]).toBe(diff.defaultCodes[k.id]);
    await sync.flush();
    expect((await keymap.computeDefaultDiff(1)).diffCount).toBe(0);
  });

  it('restore-default reports nothing written when the keymap is not loaded', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    await expect(keymap.computeDefaultDiff(0)).rejects.toThrow();
    expect(keymap.applyDefault(0, { 0: 0x0004 })).toBe(0);
  });

  it('lists factory keys and flags assignments that would overwrite them', async () => {
    const mock = await connectMock();
    const esc = PHYSICAL_KEYS[0];
    (mock as unknown as { profiles: { keymap: number[][][] }[] }).profiles[0].keymap[0][esc.row][esc.col] = 0xf200;
    const keymap = useKeymapStore();
    await keymap.load(true);

    expect(keymap.factoryKeys).toContainEqual({ layer: 0, id: esc.id, code: 0xf200 });
    keymap.activeLayer = 0;
    const plan = keymap.planKeycode([esc.id], 0x0004);
    expect(plan.factoryLost).toEqual([{ layer: 0, id: esc.id, code: 0xf200 }]);
    expect(needsAssignConfirm(Object.keys(plan.after).length, plan.factoryLost)).toBe(true);
    // The factory-key default is skipped by restore-default, never written.
    const diff = await keymap.computeDefaultDiff(0);
    expect(diff.factoryLost).toContain(esc.id);
  });

  it('asks for confirmation when an assignment touches more than 8 keys', async () => {
    await connectMock();
    const keymap = useKeymapStore();
    await keymap.load(true);
    keymap.activeLayer = 0;
    const plan = keymap.planKeycode(PHYSICAL_KEYS.map((k) => k.id), 0x0004);
    const changed = Object.keys(plan.after).length;
    expect(changed).toBeGreaterThan(BULK_CONFIRM_KEYS);
    expect(needsAssignConfirm(changed, plan.factoryLost)).toBe(true);
    expect(needsAssignConfirm(BULK_CONFIRM_KEYS, [])).toBe(false);
  });

  it('resets the Fn-rule notice when the profile changes', async () => {
    await connectMock();
    const device = useDeviceStore();
    const keymap = useKeymapStore();
    await keymap.load(true);
    keymap.activeLayer = 0;
    keymap.applyKeycode([PHYSICAL_KEYS[1].id], 0xf101);
    expect(keymap.fnNoticeTriggered).toBe(true);

    await device.switchProfile(1);
    expect(keymap.fnNoticeTriggered).toBe(false);
  });
});
