// stores/gamepad.ts on the demo keyboards: load, apply → sync job (BEGIN / WRITE / COMMIT) → byte-for-byte verify, batching,
// undo, the checks before writing, lost COMMIT replies, revision conflicts and the Xbox USB switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MockTransport } from '../src/protocol';
import type { DemoSeed } from '../src/protocol/mock';
import { GP_CAP, GP_CMD, cloneConfig, emptyConfig, encodeConfig, keyPosOf } from '../src/protocol/gamepad';
import type { GamepadConfig } from '../src/protocol/gamepad';
import { MockGamepadFirmware } from '../src/protocol/mockGamepad';
import { useDeviceStore } from '../src/stores/device';
import { useGamepadStore, newToken } from '../src/stores/gamepad';
import { useSyncStore } from '../src/stores/sync';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { t as tr } from '../src/i18n/vi';

async function setup(seed: DemoSeed = 'pro-xinput', opts: { load?: boolean } = {}) {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(seed);
  const t = device.transport as MockTransport;
  const frames: number[][] = [];
  t.onPacketRaw((dir, b) => { if (dir === 'out') frames.push(Array.from(b)); });
  const gp = useGamepadStore();
  if (opts.load !== false) await gp.load();
  return { device, t, fw: t.gamepadFirmware!, frames, gp, sync: useSyncStore(), history: useHistoryStore() };
}
/** AGP1 commands sent (cmd bytes), in order. */
const agp = (frames: number[][]) => frames.filter((f) => f[0] === 0x10).map((f) => f[1]);
const block = (cfg: GamepadConfig) => Array.from(encodeConfig(cfg));

beforeEach(() => vi.useRealTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('load', () => {
  it('an AE64 Max: support "max", not a single family-0x10 frame', async () => {
    const { gp, frames } = await setup('max');
    expect(gp.support).toBe('max');
    expect(agp(frames)).toEqual([]);
    expect(gp.apply((d) => { d.mode = 'off'; }, 'x')).toBe(false);
  });
  it('a stock Pro: support "stock" after one INFO, and nothing can be applied', async () => {
    const { gp, frames } = await setup('pro');
    expect(gp.support).toBe('stock');
    expect(agp(frames)).toEqual([GP_CMD.INFO]);
    expect(gp.apply((d) => { d.mode = 'off'; }, 'x')).toBe(false);
    expect(useSyncStore().pendingCount()).toBe(0);
  });
  it('the gamepad firmware: INFO, READ in 48-byte chunks, USB status; the block and its revision', async () => {
    const { gp, fw, frames } = await setup();
    expect(gp.support).toBe('ready');
    expect(agp(frames)).toEqual([GP_CMD.INFO, ...new Array(5).fill(GP_CMD.READ), GP_CMD.USB_STATUS]);
    expect(frames.filter((f) => f[0] === 0x10 && f[1] === GP_CMD.READ).map((f) => f[16])).toEqual([48, 48, 48, 48, 16]);
    expect(block(gp.config!)).toEqual(Array.from(fw.active));
    expect(gp.revision).toBe(1);
    expect(gp.dirty).toBe(false);
    expect(gp.usb).toEqual({ enabled: true, targetEnabled: true, phase: 0, revision: 1 });
  });
  it('a block that fails its CRC is an error, not a configuration', async () => {
    const { gp, t } = await setup('pro-xinput', { load: false });
    const read = t.gamepadRead.bind(t);
    vi.spyOn(t, 'gamepadRead').mockImplementation(async (r, o, n) => { const d = await read(r, o, n); if (o === 0) d[20] ^= 1; return d; });
    await gp.load();
    expect(gp.support).toBe('error');
    expect(gp.loadError).toBe(tr('gp.readCrc'));
    expect(gp.config).toBeNull();
  });
  it('a new connection forgets everything', async () => {
    const { gp, device } = await setup();
    await device.switchDemoModel('max');
    expect([gp.support, gp.config, gp.revision]).toEqual(['unknown', null, null]);
  });
});

describe('apply → write → verify', () => {
  it('writes BEGIN, six 40-byte WRITEs and COMMIT after the checks, then reads the block back', async () => {
    const { gp, fw, frames, sync } = await setup();
    frames.length = 0;
    expect(gp.apply((d) => { d.mode = 'mixed'; }, 'mode')).toBe(true);
    const draft = cloneConfig(gp.config!);
    await sync.flush();
    expect(Array.from(fw.active)).toEqual(block(draft));
    expect(fw.revision).toBe(2);
    expect(gp.revision).toBe(2);
    expect(gp.dirty).toBe(false);
    const seq = frames.map((f) => (f[0] === 0x10 ? `10:${f[1].toString(16)}` : `${f[0]}:${f[1]}`));
    const i = seq.indexOf('10:21');
    expect(seq.slice(0, i)).toEqual(['10:20', '2:3', ...new Array(10).fill('4:1')]); // INFO, active profile, 04 01 of the 10 assigned keys
    // each 04 01 asks the record's key by its firmware (row, col)
    const asked = frames.filter((f) => f[0] === 4 && f[1] === 1).map((f) => `${f[2]}:${f[3]}`);
    const assigned = draft.bindings.filter((b) => b.key !== null).map((b) => keyPosOf(b.key!)!);
    expect(asked).toEqual(assigned.map((p) => `${p.row}:${p.col}`));
    expect(asked).toContain('5:6'); // Space (key 58) is sensor column 6, not 3
    expect(seq.slice(i)).toEqual(['10:21', ...new Array(6).fill('10:22'), '10:23', '10:20', ...new Array(5).fill('10:25')]);
    const writes = frames.filter((f) => f[0] === 0x10 && f[1] === GP_CMD.WRITE);
    expect(writes.map((f) => f[9] - 10)).toEqual([40, 40, 40, 40, 40, 8]);
    const begin = frames.find((f) => f[0] === 0x10 && f[1] === GP_CMD.BEGIN)!;
    const token = begin.slice(20, 28);
    expect(token.some((b) => b !== 0)).toBe(true);
    expect(writes.every((f) => f.slice(10, 18).join() === token.join())).toBe(true);
  });
  it('consecutive edits coalesce into one upload of the newest draft', async () => {
    const { gp, fw, frames, sync } = await setup();
    frames.length = 0;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    gp.apply((d) => { d.sticks[0].deadzone = 1200; }, 'deadzone');
    gp.apply((d) => { d.bindings[12].key = 40; }, 'X');
    await sync.flush();
    expect(agp(frames).filter((c) => c === GP_CMD.BEGIN).length).toBe(1);
    expect(Array.from(fw.active)).toEqual(block(gp.config!));
    expect(fw.revision).toBe(2);
  });
  it('undo and redo write the earlier and the later block', async () => {
    const { gp, fw, sync, history } = await setup();
    const original = Array.from(fw.active);
    gp.apply((d) => { d.bindings[0].curve = 'smooth'; }, 'curve');
    await sync.flush();
    const changed = Array.from(fw.active);
    expect(changed).not.toEqual(original);
    history.undo();
    await sync.flush();
    expect(Array.from(fw.active)).toEqual(original);
    expect(gp.dirty).toBe(false);
    history.redo();
    await sync.flush();
    expect(Array.from(fw.active)).toEqual(changed);
    expect(fw.revision).toBe(4);
  });
  it('an edit the keyboard would refuse is not applied (lastIssues says why); an unchanged edit records nothing', async () => {
    const { gp, sync, history } = await setup();
    expect(gp.apply((d) => { d.bindings[3].key = d.bindings[2].key; }, 'dup')).toBe(false);
    expect(gp.lastIssues.map((i) => i.code)).toEqual(['duplicateKey']);
    expect(gp.apply((d) => { d.mode = 'controller'; }, 'same')).toBe(false);
    expect(history.canUndo).toBe(false);
    expect(sync.pendingCount()).toBe(0);
  });
  it('the read-back is compared byte for byte: another block after the COMMIT is shown, not reported as saved', async () => {
    const { gp, fw, sync } = await setup();
    const handle = fw.handle.bind(fw);
    vi.spyOn(fw, 'handle').mockImplementation((req) => {
      const r = handle(req);
      if (req[1] === GP_CMD.COMMIT && r?.[8] === 0) fw.active[16 + 12 * 8] = 50; // the keyboard stored X on another key
      return r;
    });
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await expect(sync.flush()).rejects.toThrow();
    expect(gp.config!.bindings[12].key).toBe(50);
    expect(gp.notice).toBe(tr('gp.revisionChanged'));
  });
});

describe('checks before writing', () => {
  it('another writer changed the block: it is re-read and shown, nothing is uploaded', async () => {
    const { gp, fw, frames, sync } = await setup();
    const other = emptyConfig();
    other.bindings[10].key = 7;
    fw.active = encodeConfig(other);
    fw.revision = 5;
    frames.length = 0;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await expect(sync.flush()).rejects.toThrow();
    expect(agp(frames)).not.toContain(GP_CMD.BEGIN);
    expect(gp.revision).toBe(5);
    expect(block(gp.config!)).toEqual(block(other));
    expect(gp.notice).toBe(tr('gp.revisionChanged'));
  });
  it('a key whose travel is shorter than its record’s full output is refused before BEGIN; the draft returns to the keyboard’s', async () => {
    const { gp, frames, sync } = await setup();
    const before = block(gp.config!);
    frames.length = 0;
    // The page's own check refuses it first (Q travels 3.4 mm)…
    expect(gp.apply((d) => { d.bindings[0].endUm = 3500; d.bindings[0].declaredUm = 4000; }, 'LT')).toBe(false);
    expect(gp.lastTravelIssues).toEqual([{ code: 'overTravel', index: 0, key: gp.config!.bindings[0].key, limitUm: 3400 }]);
    // …and the job reads the travel again before writing (the page's copy may be stale).
    const perf = usePerformanceStore();
    const q = gp.config!.bindings[0].key!;
    perf.values = { ...perf.values, [q]: { ...perf.values[q], axisRangeMax: 4000 } };
    expect(gp.apply((d) => { d.bindings[0].endUm = 3500; d.bindings[0].declaredUm = 4000; }, 'LT')).toBe(true);
    await expect(sync.flush()).rejects.toThrow(/3\.50 mm/);
    expect(agp(frames)).not.toContain(GP_CMD.BEGIN);
    expect(block(gp.config!)).toEqual(before);
  });
  it('the keyboard switched profile behind the app: refused before BEGIN', async () => {
    const { gp, t, frames, sync } = await setup();
    await t.setActiveProfile(2);
    frames.length = 0;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await expect(sync.flush()).rejects.toThrow(tr('gp.profileChanged'));
    expect(agp(frames)).not.toContain(GP_CMD.BEGIN);
  });
  it('an output the firmware does not offer is refused before BEGIN', async () => {
    const { gp, t, frames, sync } = await setup('pro-xinput', { load: false });
    (t as unknown as { gamepadFirmware: MockGamepadFirmware }).gamepadFirmware = new MockGamepadFirmware({
      caps: GP_CAP.XINPUT | GP_CAP.PERSISTENT, block: encodeConfig(emptyConfig()), maxTravelUm: () => 3400,
    });
    await gp.load();
    frames.length = 0;
    gp.apply((d) => { d.transport = 'hid'; }, 'hid');
    await expect(sync.flush()).rejects.toThrow(/HID/);
    expect(agp(frames)).not.toContain(GP_CMD.BEGIN);
  });
});

describe('failures during the upload', () => {
  it('a refused COMMIT aborts the upload; the draft returns to the keyboard’s block', async () => {
    const { gp, fw, frames, sync } = await setup();
    const before = block(gp.config!);
    (fw as unknown as { maxTravelUm: (k: number) => number }).maxTravelUm = () => 1000; // calibrated stroke shorter than 04 01 says
    frames.length = 0;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await expect(sync.flush()).rejects.toThrow(/COMMIT/);
    expect(agp(frames).slice(-2)).toEqual([GP_CMD.COMMIT, GP_CMD.ABORT]);
    expect(fw.staged).toBe(false);
    expect(fw.revision).toBe(1);
    expect(block(gp.config!)).toEqual(before);
    expect(agp(frames).filter((c) => c === GP_CMD.BEGIN).length).toBe(1); // permanent: not retried
  });
  it('a failed WRITE sends ABORT', async () => {
    const { gp, t, fw, frames, sync } = await setup();
    let n = 0;
    const write = t.gamepadWrite.bind(t);
    vi.spyOn(t, 'gamepadWrite').mockImplementation(async (...a) => { if (++n === 3) throw new Error('usb glitch'); return write(...a); });
    frames.length = 0;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await expect(sync.flush()).rejects.toThrow(/usb glitch/);
    const sent = agp(frames);
    expect(sent.slice(sent.indexOf(GP_CMD.BEGIN))).toEqual([GP_CMD.BEGIN, GP_CMD.WRITE, GP_CMD.WRITE, GP_CMD.ABORT]);
    expect(fw.staged).toBe(false);
    expect(fw.revision).toBe(1);
    await sync.flush(); // retried
    expect(fw.revision).toBe(2);
  });
  it('a lost COMMIT reply that did land: the read-back confirms it, nothing is written twice', async () => {
    const { gp, t, fw, frames, sync } = await setup();
    t.dropGamepadReply = (cmd) => cmd === GP_CMD.COMMIT;
    frames.length = 0;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await sync.flush();
    expect(fw.revision).toBe(2);
    expect(gp.unconfirmed).toBe(false);
    expect(gp.revision).toBe(2);
    expect(agp(frames).filter((c) => c === GP_CMD.BEGIN).length).toBe(1);
  });
  it('a lost COMMIT reply that did not land: the retry writes it again', async () => {
    const { gp, t, fw, sync } = await setup();
    fw.failInstall = true; // the keyboard refuses it (storage), and that reply is lost too
    t.dropGamepadReply = (cmd) => cmd === GP_CMD.COMMIT;
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    await expect(sync.flush()).rejects.toThrow();
    expect(fw.revision).toBe(1);
    expect(gp.unconfirmed).toBe(false);
    expect(fw.staged).toBe(true); // the keyboard still holds that upload until it expires
    fw.now = () => Date.now() + 6000; // …which it does after 5 s
    await sync.flush();
    expect(fw.revision).toBe(2);
    expect(Array.from(fw.active)).toEqual(block(gp.config!));
  });
  it('a lost COMMIT reply and no read-back: "unconfirmed", and the draft is kept when the job is given up', async () => {
    const { gp, t, sync } = await setup();
    t.dropGamepadReply = (cmd) => cmd === GP_CMD.COMMIT;
    const info = t.gamepadInfo.bind(t);
    let calls = 0;
    vi.spyOn(t, 'gamepadInfo').mockImplementation(async () => { if (++calls > 1) throw new Error('gone'); return info(); });
    gp.apply((d) => { d.mode = 'mixed'; }, 'mode');
    const draft = block(gp.config!);
    for (let i = 0; i < 3; i++) await sync.flush().catch(() => undefined);
    expect(gp.unconfirmed).toBe(true);
    expect(sync.pendingCount()).toBe(0); // given up after 3 attempts
    expect(block(gp.config!)).toEqual(draft);
  });
});

describe('newToken', () => {
  it('8 random bytes, never all zero', () => {
    let n = 0;
    vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      (a as unknown as Uint8Array).fill(n++ === 0 ? 0 : 7);
      return a;
    });
    expect(newToken()).toEqual([7, 7, 7, 7, 7, 7, 7, 7]);
    expect(n).toBe(2);
  });
});

describe('Xbox USB device switch', () => {
  it('demo: hides and shows the Xbox device, confirmed by the idle state', async () => {
    const { gp, fw } = await setup();
    expect(await gp.setXboxDevice(false)).toBe(true);
    expect(fw.usb).toMatchObject({ enabled: false, target: false, phase: 0, revision: 2 });
    expect(gp.usb).toEqual({ enabled: false, targetEnabled: false, phase: 0, revision: 2 });
    expect(await gp.setXboxDevice(false)).toBe(true); // already hidden: nothing sent
    expect(fw.usb.revision).toBe(2);
    expect(await gp.setXboxDevice(true)).toBe(true);
    expect(fw.usb.enabled).toBe(true);
  });
  it('a change still pending is not stacked on', async () => {
    const { gp, fw, frames } = await setup();
    fw.usb.phase = 1;
    fw.usb.queuedAt = Date.now() + 60_000;
    frames.length = 0;
    expect(await gp.setXboxDevice(false)).toBe(false);
    expect(gp.usbError).toBe(tr('gp.usbPending'));
    expect(agp(frames)).not.toContain(GP_CMD.USB_SET);
  });
  it('firmware without the switch: refused, nothing sent', async () => {
    const { gp, t } = await setup('pro-xinput', { load: false });
    (t as unknown as { gamepadFirmware: MockGamepadFirmware }).gamepadFirmware = new MockGamepadFirmware({
      caps: GP_CAP.XINPUT, block: encodeConfig(emptyConfig()), maxTravelUm: () => 3400,
    });
    await gp.load();
    await expect(gp.setXboxDevice(false)).rejects.toThrow(tr('gp.usbUnsupported'));
  });

  describe('real keyboard path (re-enumeration)', () => {
    async function real() {
      const s = await setup();
      s.device.demo = false;
      return s;
    }
    it('reconnects the same keyboard and confirms the state', async () => {
      const s = await real();
      const fw = s.fw;
      const reconnect = vi.spyOn(s.device, 'tryAutoReconnect').mockImplementation(async () => {
        await s.device.connectDemo('pro-xinput');
        (s.device.transport as unknown as { gamepadFirmware: MockGamepadFirmware }).gamepadFirmware = fw;
        s.device.demo = false;
        return true;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      const p = s.gp.setXboxDevice(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBe(true);
      expect(reconnect).toHaveBeenCalledTimes(1);
      expect(s.gp.usb).toMatchObject({ enabled: false, targetEnabled: false, phase: 0 });
      expect(s.gp.support).toBe('ready');
    });
    it('another keyboard came back: not confirmed', async () => {
      const s = await real();
      vi.spyOn(s.device, 'tryAutoReconnect').mockImplementation(async () => {
        await s.device.connectDemo('pro-xinput');
        s.device.info = { ...s.device.info!, serial: '123412341234', serialHex: '010203040102030401020304' };
        return true;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      const p = s.gp.setXboxDevice(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBe(false);
      expect(s.gp.usbError).toBe(tr('gp.usbOtherKeyboard'));
    });
    it('a keyboard back whose serial reads the same as decimals but differs in hex: not confirmed (serialHex compared)', async () => {
      const s = await real();
      const before = s.device.info!;
      vi.spyOn(s.device, 'tryAutoReconnect').mockImplementation(async () => {
        await s.device.connectDemo('pro-xinput');
        s.device.info = { ...s.device.info!, serial: before.serial, serialHex: 'aa'.repeat(12) };
        return true;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      const p = s.gp.setXboxDevice(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBe(false);
      expect(s.gp.usbError).toBe(tr('gp.usbOtherKeyboard'));
    });
    it('the same keyboard back but the switch not in the requested state: not confirmed', async () => {
      const s = await real();
      vi.spyOn(s.device, 'tryAutoReconnect').mockImplementation(async () => {
        await s.device.connectDemo('pro-xinput'); // a fresh firmware: still enabled
        s.device.demo = false;
        return true;
      });
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      const p = s.gp.setXboxDevice(false);
      await vi.advanceTimersByTimeAsync(2000);
      expect(await p).toBe(false);
      expect(s.gp.usbError).toBe(tr('gp.usbNotConfirmed'));
    });
    it('no reconnection within the timeout', async () => {
      const s = await real();
      vi.spyOn(s.device, 'tryAutoReconnect').mockResolvedValue(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
      const p = s.gp.setXboxDevice(false);
      await vi.advanceTimersByTimeAsync(17_000);
      expect(await p).toBe(false);
      expect(s.gp.usbError).toBe(tr('gp.usbReconnectFailed'));
    });
    it('a keyboard without a serial number is not switched', async () => {
      const s = await real();
      s.device.info = { ...s.device.info!, serial: '000000000000', serialHex: '000000000000000000000000' };
      s.frames.length = 0;
      expect(await s.gp.setXboxDevice(false)).toBe(false);
      expect(s.gp.usbError).toBe(tr('gp.usbNoSerial'));
      expect(agp(s.frames)).toEqual([]);
    });
  });
});
