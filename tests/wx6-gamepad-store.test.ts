// WX6 gamepad store: U-15 usbError is cleared by a good read and a new connection; U-16 "Use the keyboard's" drops the
// gamepad's undo / redo (only those); the demo firmware keeps one block and one revision per onboard profile.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MockTransport } from '../src/protocol';
import { controlIndex, decodeConfig, emptyConfig, encodeConfig, keyIndexOf } from '../src/protocol/gamepad';
import { useDeviceStore } from '../src/stores/device';
import { useGamepadStore } from '../src/stores/gamepad';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';

vi.setConfig({ testTimeout: 30000 });

afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
});

async function setup() {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo('pro-xinput');
  const t = device.transport as MockTransport;
  const fw = t.gamepadFirmware!;
  const gp = useGamepadStore();
  await gp.load();
  return { device, t, fw, gp, sync: useSyncStore(), history: useHistoryStore() };
}
const key = (name: string) => {
  const k = useDeviceStore().keys.find((d) => d.name === name)!;
  return keyIndexOf(k.row, k.col)!;
};

describe('WX6 U-15: the Xbox switch failure text', () => {
  it('goes after a good re-read of a settled switch, and after a new connection', async () => {
    const { device, fw, gp } = await setup();
    fw.usb.phase = 1; fw.usb.target = !fw.usb.enabled; fw.usb.queuedAt = Date.now() + 60_000;
    expect(await gp.setXboxDevice(false)).toBe(false);
    expect(gp.usbError).toBeTruthy();
    // still pending on a re-read: the text stays
    await gp.readUsb();
    expect(gp.usbError).toBeTruthy();
    fw.usb.phase = 0; fw.usb.target = fw.usb.enabled;
    expect(await gp.readUsb()).toMatchObject({ phase: 0 });
    expect(gp.usbError).toBeNull();
    // and a new connection
    fw.usb.phase = 1; fw.usb.target = !fw.usb.enabled; fw.usb.queuedAt = Date.now() + 60_000;
    expect(await gp.setXboxDevice(false)).toBe(false);
    expect(gp.usbError).toBeTruthy();
    await device.connectDemo('pro-xinput');
    expect(gp.usbError).toBeNull();
  });
});

describe('WX6 U-16: undo after a conflict', () => {
  it('after "Use the keyboard\'s", Ctrl+Z writes nothing to the gamepad block; another page\'s undo stays', async () => {
    const { fw, gp, sync, history } = await setup();
    const LT = controlIndex('LT');
    const A = controlIndex('A');
    // another page's edit first (no owner): it keeps its undo
    let otherUndone = 0;
    history.push({ label: 'other page', undo: () => { otherUndone++; }, redo: () => undefined });
    gp.assign(LT, key('T'));
    await sync.flush();
    const other = emptyConfig();
    other.bindings.forEach((b) => { b.key = null; });
    other.bindings[A] = { ...other.bindings[A], key: key('Z'), declaredUm: 3400, endUm: 3400 };
    fw.active = encodeConfig(other);
    fw.revision = 20;
    gp.setMode('mixed');
    await expect(sync.flush()).rejects.toThrow();
    expect(gp.conflict).not.toBeNull();
    gp.keepKeyboard();
    expect(history.undoLabel).toBe('other page'); // the gamepad's two entries are gone, the other page's is the top
    history.undo();
    await sync.flush();
    expect(otherUndone).toBe(1);
    expect(fw.revision).toBe(20); // nothing written to the gamepad block
    expect(decodeConfig(fw.active).bindings[A].key).toBe(key('Z'));
    expect(gp.conflict).toBeNull();
  });

  it('an edit, saved and read back as is: its undo stays', async () => {
    const { gp, sync, history } = await setup();
    gp.assign(controlIndex('LT'), key('T'));
    await sync.flush();
    await gp.load(true);
    expect(history.canUndo).toBe(true);
  });
});

describe('WX6: the demo gamepad firmware and profiles', () => {
  it('one block and one revision for every onboard profile', async () => {
    const { device, fw, gp, sync } = await setup();
    const LT = controlIndex('LT');
    gp.assign(LT, key('T'));
    await sync.flush();
    const rev0 = fw.revision;
    await device.switchProfile(1);
    await vi.waitFor(() => expect(gp.support).toBe('ready'), { timeout: 10000 });
    await vi.waitFor(() => expect(gp.revision).toBe(fw.revision));
    expect(gp.config!.bindings[LT].key).not.toBe(key('T')); // profile 2 has its own block
    await device.switchProfile(0);
    await vi.waitFor(() => expect(gp.revision).toBe(fw.revision));
    expect(gp.config!.bindings[LT].key).toBe(key('T')); // profile 1's edit is still there
    expect(fw.revision).toBe((rev0 + 1) >>> 0); // its own revision, bumped once for the load
  });
});
