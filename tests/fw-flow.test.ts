// DESIGN FW §11 tests 4, 5, 6, 8, 9, 10 (the store part), 11 (rescue) and 12: the session on the demo bus (fake bootloader),
// fake timers with the real waits (6 s / 3 s per packet / 10 s / 3 s + 20 s).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FW_BOARD_MAX, FW_BOARD_PRO } from '../src/protocol/firmware';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { MockTransport } from '../src/protocol/mock';
import { BaseTransport, FirmwareSessionError } from '../src/protocol/client';
import { UnsafeCommandError } from '../src/protocol/safety';
import { useCalibrationStore } from '../src/stores/calibration';
import { useGamepadStore } from '../src/stores/gamepad';
import { useHistoryStore } from '../src/stores/history';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { t as tr } from '../src/i18n/vi';
import { fwText } from '../src/components/firmware/fwText';
import { CRC, demo, fileOf, makeFw, run, seq, startWith } from './fw-helpers';
import { createPinia, setActivePinia } from 'pinia';
import { FW_PROBE_FILTER, HID_FILTERS } from '../src/protocol/constants';
import { HidFwPort, HidTransport } from '../src/protocol/hid';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { FakeHidDevice, hidKeyboard, installFakeHid, removeFakeHid } from './fw-hid';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type S = Pick<Awaited<ReturnType<typeof demo>>, 'fw'>; // the demo and the WebHID keyboard (fw-hid) alike
/** Runs the fake clock in steps of 250 ms until `pred` holds (or `max` ms passed). Returns the ms run. */
async function until(pred: () => boolean, max = 60_000): Promise<number> {
  let ms = 0;
  while (!pred() && ms < max) { await run(250); ms += 250; }
  return ms;
}
const STOPS = ['verifyFail', 'packetFail', 'lost', 'notFound', 'manyBoot', 'manyApp', 'rescue'];
const settled = (s: S) => () => !s.fw.active || STOPS.includes(s.fw.phase);
const ENDS = ['done', 'doneUnknown', 'versionMismatch', 'noGamepad', 'enterFail', 'preflightFail', ...STOPS];
const ended = (s: S) => () => ENDS.includes(s.fw.phase);
/** 01 01 sent (device.init sends it once per connection). */
function initCount(spy: { mock: { calls: unknown[][] } }): number {
  return spy.mock.calls.filter((c) => c[0] === 'out' && (c[1] as Uint8Array)[0] === 1 && (c[1] as Uint8Array)[1] === 1).length;
}
const logSpy = () => vi.spyOn(BaseTransport.prototype as unknown as { log: (d: string, b: Uint8Array) => void }, 'log');
const cmds = (bus: MockFwBus, dev: string) => bus.received.filter((r) => r.dev === dev).map((r) => r.cmd);
const sent08 = (bus: MockFwBus) => bus.received.filter((r) => r.cmd.startsWith('08'));

describe('9. a full write on the demo Pro, and the versions after it', { timeout: 60_000 }, () => {
  it('0.1.0.0: the order of P06, packets equal the file, 0 violations, done; the keyboard handed back as a new connection', async () => {
    const s = await demo('pro');
    const history = useHistoryStore();
    const sync = useSyncStore();
    const file = makeFw({ crc: CRC.v0100 });
    // 12. opening the page, choosing the file and typing send nothing
    await s.fw.chooseFile(fileOf(file));
    s.fw.typed = 'AE64 Pro';
    await run(1000);
    expect(s.bus.received).toEqual([]);
    expect(s.fw.needsRisk).toBe(false);
    expect(s.fw.canStart).toBe(true);
    const log = logSpy();
    await startWith(s.fw, file);
    expect(s.fw.active).toBe(true);
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(seq(s.bus).slice(0, 7)).toEqual(['app 01 02', 'app 08 01', 'boot 01 02', 'boot 08 02 ×2121', 'boot 08 03', 'boot 08 04', 'app 01 02']);
    expect(s.bus.violations).toEqual([]);
    expect(s.bus.writes.length).toBe(2121);
    expect([...s.bus.writes[0].subarray(0, 8)]).toEqual([0x08, 0x02, 0, 0, 0, 0, 0x38, 0]);
    expect([...s.bus.writes[0].subarray(8, 64)]).toEqual([...file.subarray(0, 56)]);
    const joined = new Uint8Array(file.length);
    for (const w of s.bus.writes) joined.set(w.subarray(8, 8 + (w[6] | (w[7] << 8))), w[2] | (w[3] << 8) | (w[4] << 16));
    expect(joined).toEqual(file);
    expect(s.fw.active).toBe(false);
    expect(s.fw.doneVersion).toBe('0.1.0.0');
    expect(s.device.connected).toBe(true);
    expect(s.device.transport).not.toBe(s.t);
    expect(s.device.info?.firmware).toBe('0.1.0.0');
    expect(initCount(log)).toBe(1); // device.init once, on the keyboard back in its app
    expect(history.canUndo).toBe(false);
    expect(sync.pendingCount()).toBe(0);
    expect(s.fw.typed).toBe(''); // a second session needs the confirmation again
  });

  it('0.0.5.0 (116 464 B): 2080 packets, the last at offset 116 424 with length 28 00', async () => {
    const s = await demo('pro');
    await startWith(s.fw, makeFw({ size: 116_464, crc: CRC.v0050 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    const last = s.bus.writes.at(-1)!;
    expect(s.bus.writes.length).toBe(2080);
    expect([...last.subarray(0, 8)]).toEqual([0x08, 0x02, 0xc8, 0xc6, 0x01, 0x00, 0x28, 0x00]);
    expect(last.subarray(48).every((b) => b === 0)).toBe(true);
  });

  it('XInput 0.8.1: back with 0.1.0.0 + INFO AGP1 caps 30 → done "0.8.1" (not versionMismatch)', async () => {
    const s = await demo('pro');
    await startWith(s.fw, makeFw({ crc: CRC.xinput081 }));
    expect(s.fw.active).toBe(true); // the risk box was ticked
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(s.fw.doneVersion).toBe('0.8.1');
    expect(s.device.info?.firmware).toBe('0.1.0.0');
    expect(s.device.demoSeed).toBe('pro-xinput');
  });

  it('XInput 0.8.1 but INFO answers 10 FF → noGamepad (unlocked)', async () => {
    const s = await demo('pro');
    s.bus.flags.noGamepad = true;
    await startWith(s.fw, makeFw({ crc: CRC.xinput081 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('noGamepad');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.noGamepad', { got: '0.1.0.0' }));
    expect(s.fw.active).toBe(false);
    expect(s.fw.rows.find).toBe('fail');
  });

  it('official 0.1.0.0 but AGP1 still answers (the old XInput build runs) → versionMismatch', async () => {
    const s = await demo('pro');
    s.bus.flags.staleGamepad = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('versionMismatch');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.version', { got: '0.1.0.0 + AGP1', want: 'AE64 Pro App 0.1.0.0' }));
  });

  it('01 02 reports another version → versionMismatch; an unknown file → doneUnknown with the version read', async () => {
    const a = await demo('pro');
    a.bus.flags.version = '0.0.9.0';
    await startWith(a.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(a));
    expect(a.fw.phase).toBe('versionMismatch');
    const b = await demo('pro');
    await startWith(b.fw, makeFw({ seed: 77 }));
    await until(ended(b));
    expect(b.fw.phase).toBe('doneUnknown');
    expect(b.fw.doneVersion).toBe('0.1.0.0');
  });
});

describe('4–5. failures: nothing is retried by itself', { timeout: 60_000 }, () => {
  it('08 03 fails → verifyFail, no 08 04, the app stays locked; "Ghi lại từ đầu" after ≥ 1 s of quiet, never 08 01 again → done', async () => {
    const s = await demo('pro');
    s.bus.flags.verifyFail = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(settled(s));
    expect(s.fw.phase).toBe('verifyFail');
    expect(s.fw.active).toBe(true);
    expect(cmds(s.bus, 'boot')).not.toContain('08 04');
    await run(30_000);
    expect(s.fw.phase).toBe('verifyFail'); // stays
    s.bus.flags.verifyFail = false;
    const before = s.bus.received.length;
    s.fw.retry();
    await run(900);
    expect(s.bus.received.length).toBe(before); // quiet for 1 s first
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(s.bus.received.filter((r) => r.cmd === '08 01').length).toBe(1);
    expect(s.bus.violations).toEqual([]);
  });

  it('a wrong echo at packet 500 → packetFail (packet 500), no 501, no 08 03; retry writes from 0 → done', async () => {
    const s = await demo('pro');
    s.bus.flags.wrongEchoAt = 500;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(settled(s));
    expect(s.fw.phase).toBe('packetFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.packet', { n: 500 }));
    expect(s.bus.writes.length).toBe(501);
    expect(cmds(s.bus, 'boot')).not.toContain('08 03');
    expect(s.fw.rows.write).toBe('fail');
    s.fw.retry();
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(s.bus.writes.length).toBe(501 + 2121);
    expect(s.bus.violations).toEqual([]);
  });

  it('packet 0 answered after 2.5 s → passes; packet 10 after 3.1 s → packetFail, sent once; the late reply is dropped before the retry', async () => {
    const a = await demo('pro');
    a.bus.flags.delayAt = { packet: 0, ms: 2500 };
    await startWith(a.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(a));
    expect(a.fw.phase).toBe('done');

    const s = await demo('pro');
    s.bus.flags.delayAt = { packet: 10, ms: 3100 };
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(settled(s));
    expect(s.fw.phase).toBe('packetFail');
    expect(s.bus.writes.length).toBe(11); // packet 10 sent once, nothing after it
    s.fw.retry();
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(s.bus.dropped).toBeGreaterThanOrEqual(1); // the 3.1 s reply came and was not taken for packet 0
    expect(s.bus.violations).toEqual([]);
  });

  it('08 01 without a reply (the keyboard leaves at once) → goes on as normal', async () => {
    const s = await demo('pro');
    s.bus.flags.enterSilent = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
  });

  it('no permission for the bootloader: nothing is asked for 6 s, then "Allow…" (looking goes on); the right device → writing', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNeedsPermission = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(5900);
    expect(s.fw.phase).toBe('entering');
    expect(cmds(s.bus, 'boot')).toEqual([]);
    await run(700);
    expect(s.fw.phase).toBe('needPermission');
    const p = s.fw.allow();
    await run(500);
    await p;
    expect(['writing', 'verifying', 'rebooting', 'finding', 'done']).toContain(s.fw.phase);
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
  });

  it('"Allow…" and the user picks an AE64 Max: wrongDevice, still needPermission; the Max only got 01 02', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNeedsPermission = true;
    s.bus.flags.choose = 'max';
    s.bus.flags.extra = ['max'];
    s.bus.attach(s.t); // plugs the extra devices
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(6600);
    expect(s.fw.phase).toBe('needPermission');
    const p = s.fw.allow();
    await run(2000);
    await p;
    expect(s.fw.wrongDevice).toBe(true);
    expect(s.fw.phase).toBe('needPermission');
    expect(cmds(s.bus, 'max').length).toBeGreaterThan(0);
    expect(cmds(s.bus, 'max').every((c) => c === '01 02')).toBe(true);
    expect(s.bus.writes).toEqual([]);
  });

  it('enterFail: the keyboard stays in its app → after 10 s one 01 02 says run mode 0 → unlocked, fw.err.enter, 0 × 08 02, init once', async () => {
    const s = await demo('pro');
    s.bus.flags.enterFail = true;
    const log = logSpy();
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enter'));
    expect(s.fw.active).toBe(false);
    expect(s.bus.writes).toEqual([]);
    await run(2000);
    expect(s.device.connected).toBe(true);
    expect(initCount(log)).toBe(1);
  });

  it('unplugged mid-write → lost (locked); back in its bootloader → rescue mode', async () => {
    const s = await demo('pro');
    s.bus.flags.unplugAt = 100;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'lost');
    expect(s.fw.active).toBe(true);
    expect(s.fw.rows).toEqual({ write: 'fail', verify: 'todo', reboot: 'todo', find: 'todo' });
    expect(fwText(s.fw.error)).toBe(tr('fw.err.lost'));
    await until(() => s.fw.phase === 'rescue', 5000);
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.rescueBoard).toBe(FW_BOARD_PRO);
  });

  it('the keyboard never comes back after 08 04 → notFound after 3 + 20 s (locked)', async () => {
    const s = await demo('pro');
    s.bus.flags.notFound = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'finding');
    const ms = await until(() => s.fw.phase === 'notFound', 30_000);
    expect(ms).toBeGreaterThanOrEqual(19_000);
    expect(ms).toBeLessThanOrEqual(21_000);
    expect(s.fw.active).toBe(true);
    expect(fwText(s.fw.error)).toBe(tr('fw.err.notFound'));
  });
});

describe('6. the connection path while a session runs', { timeout: 60_000 }, () => {
  it('the keyboard leaving USB after 08 01: no lost-connection toast, no init, no auto-reconnect, the page is kept', async () => {
    const s = await demo('pro');
    const log = logSpy();
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(3000);
    expect(s.t.connected).toBe(false);
    expect(useToast().items.value).toEqual([]);
    expect(initCount(log)).toBe(0);
    expect(await s.device.tryAutoReconnect()).toBe(false);
    expect(s.device.transport).toBe(s.t); // not reset: App keeps the page (keepPage) while firmware.active
    await until(ended(s));
    expect(initCount(log)).toBe(1);
  });

  it('a device whose 01 02 says run mode 255: exactly one 01 02, then rescue; run mode 7: one 01 02, fw.rescue.unknownMode', async () => {
    const s = await demo('pro');
    const boot = new MockBootloader(s.bus, [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6], 'boot');
    const sent: string[] = [];
    boot.onPacketRaw((d, b) => { if (d === 'out') sent.push(`${b[0]} ${b[1]}`); });
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    expect(sent).toEqual(['1 2']);
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.active).toBe(true);
    expect(s.device.connected).toBe(false);

    const o = await demo('pro');
    const odd = new MockBootloader(o.bus, [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6], 'boot');
    const orig = o.bus.deviceInfo.bind(o.bus);
    o.bus.deviceInfo = (b, sr, _m, f) => orig(b, sr, 7, f);
    const sent7: string[] = [];
    odd.onPacketRaw((d, b) => { if (d === 'out') sent7.push(`${b[0]} ${b[1]}`); });
    const q = o.device.adoptFromFirmware(odd, true);
    await run(500);
    await q;
    expect(sent7).toEqual(['1 2']);
    expect(o.fw.rescue).toBe(false);
    expect(o.device.error).toBe(tr('fw.rescue.unknownMode', { mode: 7 }));
  });
});

describe('6. auto-reconnect with WebHID present', { timeout: 60_000 }, () => {
  it('rescue mode (no app connection): tryAutoReconnect opens nothing while the firmware page holds the device', async () => {
    const getDevices = vi.fn(async () => [] as HIDDevice[]);
    const hid = { getDevices, requestDevice: vi.fn(async () => []), addEventListener: vi.fn(), removeEventListener: vi.fn() };
    Object.defineProperty(navigator, 'hid', { value: hid, configurable: true });
    try {
      const s = await demo('pro');
      expect(s.device.hidAvailable).toBe(true);
      const boot = new MockBootloader(s.bus, [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6], 'boot');
      const p = s.device.adoptFromFirmware(boot, true);
      await run(500);
      await p;
      expect(s.fw.active).toBe(true);
      expect(s.device.transport).toBeNull();
      getDevices.mockClear();
      expect(await s.device.tryAutoReconnect()).toBe(false);
      expect(getDevices).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(navigator, 'hid');
    }
  });
});

describe('8. before 08 01 (preflight)', { timeout: 60_000 }, () => {
  it('busy: an exclusive write, calibration, a polling-rate change, the USB switch → no start, 0 × 08', async () => {
    const s = await demo('pro');
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    s.fw.typed = 'AE64 Pro';
    expect(s.fw.canStart).toBe(true);
    const cases: [string, () => () => void][] = [
      ['fw.busy.write', () => s.device.holdExclusive()],
      ['fw.busy.calib', () => { const c = useCalibrationStore() as { phase: string }; c.phase = 'running'; return () => { c.phase = 'idle'; }; }],
      ['fw.busy.usb', () => { const st = useSettingsStore(); st.pollingState = 'applying'; return () => { st.pollingState = 'idle'; }; }],
    ];
    for (const [key, make] of cases) {
      const undo = make();
      expect(s.fw.busy, key).toBe(key);
      expect(s.fw.canStart, key).toBe(false);
      await s.fw.start();
      expect(s.fw.active, key).toBe(false);
      undo();
    }
    expect(sent08(s.bus)).toEqual([]);
  });

  it('busy found by the check after flush (a pending write, calibration, the USB switch) → preflightFail fw.err.busy, unlocked, 0 × 08', async () => {
    const s = await demo('pro');
    const sync = useSyncStore();
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    const cases: [string, () => void][] = [
      ['fw.busy.write', () => vi.spyOn(sync, 'pendingCount').mockReturnValue(1)],
      ['fw.busy.calib', () => { (useCalibrationStore() as { phase: string }).phase = 'running'; }],
      ['fw.busy.usb', () => vi.spyOn(useGamepadStore(), 'usbBusy', 'get').mockReturnValue(true)],
    ];
    for (const [key, make] of cases) {
      s.fw.typed = 'AE64 Pro';
      expect(s.fw.canStart, key).toBe(true);
      vi.spyOn(sync, 'flush').mockImplementation(async () => { make(); });
      await s.fw.start();
      expect(s.fw.phase, key).toBe('preflightFail');
      expect(fwText(s.fw.error), key).toBe(tr('fw.err.busy', { reason: tr(key as 'fw.busy.write') }));
      expect(s.fw.active).toBe(false);
      expect(s.device.exclusiveActive).toBe(false);
      vi.restoreAllMocks();
      (useCalibrationStore() as { phase: string }).phase = 'idle';
    }
    expect(sent08(s.bus)).toEqual([]);
  });

  it('the chosen file changed after it was read: the session keeps its own copy', async () => {
    const s = await demo('pro');
    const file = makeFw({ crc: CRC.v0100 });
    const keep = file.slice();
    const f = fileOf(file);
    await s.fw.chooseFile(f);
    new Uint8Array(await f.arrayBuffer()).fill(0xee); // the bytes the File handed out
    s.fw.typed = 'AE64 Pro';
    void s.fw.start();
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    const joined = new Uint8Array(keep.length);
    for (const w of s.bus.writes) joined.set(w.subarray(8, 8 + (w[6] | (w[7] << 8))), w[2] | (w[3] << 8) | (w[4] << 16));
    expect(joined).toEqual(keep);
  });

  it('the array given to beginFirmwareSession changed after the session opened: the session writes its own copy', async () => {
    const s = await demo('pro');
    const file = makeFw({ crc: CRC.v0100 });
    const keep = file.slice();
    const begin = BaseTransport.prototype.beginFirmwareSession;
    vi.spyOn(BaseTransport.prototype, 'beginFirmwareSession').mockImplementation(async function (this: BaseTransport, bytes, o) {
      const ticket = await begin.call(this, bytes, o);
      bytes.fill(0xee); // the caller's array, after the session took it
      return ticket;
    });
    await startWith(s.fw, file);
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    const joined = new Uint8Array(keep.length);
    for (const w of s.bus.writes) joined.set(w.subarray(8, 8 + (w[6] | (w[7] << 8))), w[2] | (w[3] << 8) | (w[4] << 16));
    expect(joined).toEqual(keep);
  });

  it('the session copy damaged after it was checked: fwWrite checks it again and refuses before packet 0', async () => {
    const s = await demo('pro');
    const begin = BaseTransport.prototype.beginFirmwareSession;
    let copy: Uint8Array | null = null;
    vi.spyOn(BaseTransport.prototype, 'beginFirmwareSession').mockImplementation(async function (this: BaseTransport, bytes, o) {
      const from = vi.spyOn(Uint8Array, 'from');
      try {
        const ticket = await begin.call(this, bytes, o);
        const at = from.mock.calls.findIndex((c) => c[0] === bytes);
        copy = from.mock.results[at]?.value as Uint8Array;
        return ticket;
      } finally {
        from.mockRestore();
      }
    });
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => copy !== null, 3000);
    expect(s.fw.phase).toBe('entering'); // opened, nothing written yet
    copy![5000] ^= 0x01; // one payload bit of the session's copy
    await until(settled(s));
    expect(s.fw.phase).toBe('packetFail');
    expect(fwText(s.fw.error)).toBe(fwText({ key: 'fw.err.recheck', paramKeys: { reason: 'fw.why.file' } }));
    expect(s.bus.writes).toEqual([]);
    expect(sent08(s.bus).map((r) => r.cmd)).toEqual(['08 01']);
  });

  it('device.info (old) says another serial than the fresh 01 02: the session uses the fresh one', async () => {
    const s = await demo('pro');
    s.device.info = { ...s.device.info!, serialHex: 'aa'.repeat(12) };
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
  });

  it('12. typed wrong, or a third-party file without the risk box: start stays off and sends nothing', async () => {
    const s = await demo('pro');
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.xinput081 })));
    expect(s.fw.needsRisk).toBe(true);
    for (const typed of ['', 'AE64', 'AE64 Max', 'ae64pro', 'AE64 Pro x']) {
      s.fw.typed = typed;
      expect(s.fw.canStart, typed).toBe(false);
    }
    for (const typed of ['AE64 Pro', '  ae64   pro ', 'AE64 PRO']) {
      s.fw.typed = typed;
      expect(s.fw.canStart, typed).toBe(false); // the risk box is not ticked
    }
    s.fw.riskOk = true;
    expect(s.fw.canStart).toBe(true);
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.xinput08 })));
    expect(s.fw.riskOk).toBe(false); // a new file unticks it
    await s.fw.start();
    await run(1000);
    expect(s.bus.received).toEqual([]);
  });

  it('12. AE64 Max: nothing can start, 0 commands', async () => {
    const s = await demo('max');
    expect(s.bus).toBeNull(); // no firmware bus on a Max
    const sent: number[][] = [];
    s.t.onPacketRaw((d, b) => { if (d === 'out') sent.push([b[0], b[1]]); });
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    s.fw.typed = 'AE64 Pro';
    expect(s.fw.isPro).toBe(false);
    expect(s.fw.canStart).toBe(false);
    await s.fw.start();
    await run(5000);
    expect(sent.filter((f) => f[0] === 8 || f[0] === 1)).toEqual([]);
  });
});

describe('10. serial and board on the bus', { timeout: 60_000 }, () => {
  it('another Pro whose serial reads the same as decimals: only the right keyboard is taken back; it got only 01 02', async () => {
    const s = await demo('pro');
    const mine = s.device.info!.serialHex;
    s.bus.flags.extra = ['pro-twin'];
    s.bus.attach(s.t);
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(cmds(s.bus, 'pro-twin').length).toBeGreaterThan(0);
    expect(cmds(s.bus, 'pro-twin').every((c) => c === '01 02')).toBe(true);
    expect((s.device.transport as MockTransport).fwLabel).toBe('app');
    expect(s.device.info?.serialHex).toBe(mine);
  });

  it('an AE64 Max plugged in too: probes get 01 02 only, never 08', async () => {
    const s = await demo('pro');
    s.bus.flags.extra = ['max'];
    s.bus.attach(s.t);
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(cmds(s.bus, 'max').length).toBeGreaterThan(0);
    expect(cmds(s.bus, 'max').every((c) => c === '01 02')).toBe(true);
  });

  it('looking for the bootloader every 500 ms: another device gets one 01 02, not one per look', async () => {
    const s = await demo('pro');
    s.bus.flags.extra = ['max'];
    s.bus.flags.bootNeedsPermission = true; // the bootloader stays hidden: the store keeps looking
    s.bus.attach(s.t);
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(6600);
    expect(s.fw.phase).toBe('needPermission');
    await run(5000); // ten more looks
    expect(cmds(s.bus, 'max')).toEqual(['01 02']);
  });

  it('two bootloaders of the board with different serials: the one with the session serial is written, the other only probed', async () => {
    const s = await demo('pro');
    s.bus.flags.extra = ['boot-twin'];
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(cmds(s.bus, 'boot-twin').length).toBeGreaterThan(0);
    expect(cmds(s.bus, 'boot-twin').every((c) => c === '01 02')).toBe(true);
    expect(cmds(s.bus, 'boot').filter((c) => c === '08 02').length).toBe(2121);
  });

  it('two bootloaders without a serial → manyBoot, 0 × 08 02; "Tìm lại" with one left → writes', async () => {
    const s = await demo('pro');
    s.bus.flags.extra = ['boot-twin'];
    s.bus.flags.bootNoSerial = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(settled(s));
    expect(s.fw.phase).toBe('manyBoot');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.manyBoot'));
    expect(s.bus.writes).toEqual([]);
    const twin = (await s.bus.list()).find((d) => d instanceof MockBootloader && d.label === 'boot-twin')!;
    s.bus.unplug(twin);
    s.fw.findAgain();
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
  });
});

describe('11. rescue mode', { timeout: 60_000 }, () => {
  async function rescue(enabled: boolean, flags: Partial<MockFwBus['flags']> = {}) {
    const s = await demo('pro');
    s.fw.setEnabled(enabled);
    Object.assign(s.bus.flags, flags);
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader)!;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    return { ...s, boot };
  }

  it('switch off: an XInput file → officialOnly, write off; an official file → 0 × 08 until "Ghi firmware", then done', async () => {
    const s = await rescue(false);
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.officialOnly).toBe(true);
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.xinput081 })));
    expect(s.fw.rescueRefused).toBe(true);
    expect(s.fw.canRescueWrite).toBe(false);
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    expect(s.fw.canRescueWrite).toBe(true);
    await run(5000);
    expect(sent08(s.bus)).toEqual([]);
    void s.fw.rescueWrite();
    await until(() => s.fw.phase !== 'rescue' && ended(s)());
    expect(s.fw.phase).toBe('done');
    expect(s.fw.rescue).toBe(false);
    expect(s.device.connected).toBe(true);
    expect(s.bus.violations).toEqual([]);
  });

  it('switch on: an XInput file needs the risk box; a bootloader without a board → read-only', async () => {
    const s = await rescue(true);
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.xinput081 })));
    expect(s.fw.rescueRefused).toBe(false);
    expect(s.fw.canRescueWrite).toBe(false);
    s.fw.riskOk = true;
    expect(s.fw.canRescueWrite).toBe(true);

    const n = await rescue(true, { bootNoBoard: true });
    expect(n.fw.rescueBoard).toBeNull();
    await n.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    expect(n.fw.canRescueWrite).toBe(false);
    await n.fw.rescueWrite();
    expect(sent08(n.bus)).toEqual([]);
  });
});

// A failing toBe / toEqual on a transport or a fake device prints its whole object graph (the bus with every packet): megabytes,
// more than a mutation runner reads back. These tests compare short tags instead (same object, same tag).
const tagIds = new WeakMap<object, number>();
let tagNext = 0;
function tag(x: unknown): string {
  if (x === null || x === undefined || typeof x !== 'object') return String(x);
  if (!tagIds.has(x)) tagIds.set(x, ++tagNext);
  const kind = x instanceof HidTransport ? 'hid' : x instanceof FakeHidDevice ? `dev:${x.label}` : (x as object).constructor.name;
  return `${kind}#${tagIds.get(x)}`;
}
const tags = (xs: readonly unknown[]) => xs.map(tag);

// FW review FW-TEST-1: the real WebHID path (HidTransport, HidFwPort, matchesProbe, probeOnly, connectHid, reconnectGrantedHid)
// on a fake navigator.hid over the same bus model (tests/fw-hid.ts).
describe('FW-TEST-1. real WebHID: HidTransport and HidFwPort on a fake navigator.hid', { timeout: 60_000 }, () => {
  afterEach(() => removeFakeHid());

  const sends = (d: FakeHidDevice) => d.sends.map((f) => `${f[0]} ${f[1]}`);
  const onDev = (list: BaseTransport[], d: FakeHidDevice) => list.filter((x) => x instanceof HidTransport && x.hidDevice === (d as unknown as HIDDevice));
  /** A bus without the keyboard in its app (it was unplugged); `boot`: a bootloader plugged in and granted. */
  async function bare(boot: boolean) {
    vi.useRealTimers();
    const app = new MockTransport({ seed: 'pro' });
    const bus = app.fwMock as MockFwBus;
    bus.unplug(app);
    if (boot) bus.plug(new MockBootloader(bus, bus.serial, 'boot'));
    const hid = installFakeHid(bus);
    setActivePinia(createPinia());
    return { bus, hid, device: useDeviceStore(), fw: useFirmwareStore() };
  }

  it('1. list() opens each device of FW_PROBE_FILTER once; another vendor and another collection are never opened; nothing is sent', async () => {
    const s = await hidKeyboard();
    expect(s.hid.requests[0].filters).toEqual([...HID_FILTERS, FW_PROBE_FILTER]); // Connect: the bootloader's filter too
    expect(s.appDev.opens).toBe(1);
    const otherVendor = s.hid.addStray({ vendorId: 0x046d, productId: 0xc52b }); // its collection is FFB0:0001 too
    const ff80 = s.hid.addStray({ productId: 0x300a, collections: [{ usagePage: 0xff80, usage: 1 }] });
    s.bus.plug(new MockBootloader(s.bus, s.bus.serial, 'boot'));
    s.bus.plug(new MockBootloader(s.bus, s.bus.serial.map((b) => b ^ 0x5a), 'boot-other'));
    const port = new HidFwPort();
    port.adopt(s.t);
    const a = await port.list();
    const b = await port.list();
    expect(a.length).toBe(3);
    expect(tags(b)).toEqual(tags(a));
    expect(tag(a[0])).toBe(tag(s.t)); // the app's own connection, not a second one
    expect(s.appDev.opens).toBe(1);
    expect(s.hid.find('boot')!.opens).toBe(1);
    expect(s.hid.find('boot-other')!.opens).toBe(1);
    expect(otherVendor.opens).toBe(0);
    expect(ff80.opens).toBe(0);
    expect(a.slice(1).map((x) => (x as HidTransport).probeOnly)).toEqual([true, true]); // product ID 0: probe-only
    expect(s.bus.received).toEqual([]);
    expect(otherVendor.sends).toEqual([]);
  });

  it('1. a device opened by a connection the port does not know gets no second transport', async () => {
    const s = await hidKeyboard();
    const port = new HidFwPort(); // s.t not adopted
    const list = await port.list();
    expect(tags(onDev(list, s.appDev))).toEqual([]);
    expect(s.appDev.opens).toBe(1);
    for (const x of list) await port.release(x);
    expect(s.t.connected).toBe(true);
    expect(s.appDev.closes).toBe(0);
    expect(s.bus.received).toEqual([]);
  });

  it('2. release closes only the devices the port opened, never the adopted one; reopen is the app\'s connection from then on', async () => {
    const s = await hidKeyboard();
    s.bus.plug(new MockBootloader(s.bus, s.bus.serial, 'boot'));
    const port = new HidFwPort();
    port.adopt(s.t);
    const list = await port.list();
    for (const x of list) await port.release(x);
    expect(s.hid.find('boot')!.closes).toBe(1);
    expect(s.appDev.closes).toBe(0);
    expect(s.t.connected).toBe(true);

    const fresh = await port.reopen(s.t) as HidTransport;
    expect(tag(fresh)).not.toBe(tag(s.t));
    expect(tag(fresh.hidDevice)).toBe(tag(s.appDev));
    expect(fresh.connected).toBe(true);
    expect([s.appDev.opens, s.appDev.closes]).toEqual([2, 1]);
    const again = await port.list();
    expect(tags(onDev(again, s.appDev))).toEqual([tag(fresh)]); // recorded: no third open, no second transport
    expect(s.appDev.opens).toBe(2);
    await port.release(fresh);
    expect(fresh.connected).toBe(true);
    await s.t.close(); // the old connection again (device.adoptFromFirmware closes it): the device stays open under the new one
    expect(fresh.connected).toBe(true);
    expect(s.appDev.closes).toBe(1);
    expect(s.bus.received).toEqual([]);
  });

  it('3. 08 01 ignored, the app still plugged in → enterFail; device.init on the reopened connection, the device stays open', async () => {
    const s = await hidKeyboard({ enterFail: true });
    const log = logSpy();
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enter'));
    expect(s.fw.active).toBe(false);
    const now = s.device.transport as HidTransport;
    expect(now instanceof HidTransport).toBe(true);
    expect(tag(now)).not.toBe(tag(s.t));
    expect(tag(now.hidDevice)).toBe(tag(s.appDev));
    await run(3000);
    expect(s.device.connected).toBe(true);
    expect(now.connected).toBe(true);
    expect([s.appDev.opens, s.appDev.closes]).toEqual([2, 1]);
    expect(initCount(log)).toBe(1);
    expect(sent08(s.bus).map((r) => `${r.dev} ${r.cmd}`)).toEqual(['app 08 01']);
    expect(s.bus.violations).toEqual([]);
  });

  it('3. 08 01: the keyboard comes back in its app as a new device (appBack) → the app gets it (probed with 01 02 only, then init)', async () => {
    const s = await hidKeyboard({ enterBounce: true });
    const log = logSpy();
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enter'));
    expect(s.appDev.present).toBe(false);
    const back = s.hid.find('app')!;
    expect(tag(back)).not.toBe(tag(s.appDev));
    const now = s.device.transport as HidTransport;
    expect(tag(now.hidDevice)).toBe(tag(back));
    expect(s.device.connected).toBe(true);
    expect(back.opens).toBe(1); // the port's probe connection is the one handed to the app
    expect(sends(back).slice(0, 2)).toEqual(['1 2', '1 2']); // the probe, then device.init (01 02 first)
    expect(initCount(log)).toBe(1);
    expect(sent08(s.bus).map((r) => `${r.dev} ${r.cmd}`)).toEqual(['app 08 01']);
    expect(s.bus.violations).toEqual([]);
    await (s.fw.port as HidFwPort).release(now); // handed to the app (keep): the port never closes it
    expect(now.connected).toBe(true);
  });

  it('3. 08 01 ignored and the app connection cannot be opened again → enterFail says the app is not reconnected; nothing stays half-connected', async () => {
    const s = await hidKeyboard({ enterFail: true });
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(2000);
    s.appDev.openError = new DOMException('Failed to open the device.', 'NotAllowedError'); // another app took it meanwhile
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enterNoApp'));
    await run(1000);
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enterNoApp'));
    expect(s.fw.active).toBe(false);
    expect(s.device.connected).toBe(false);
    expect(tag(s.device.transport)).toBe('null');
    expect(s.appDev.opened).toBe(false);
    expect(sent08(s.bus).map((r) => `${r.dev} ${r.cmd}`)).toEqual(['app 08 01']);
    expect(s.bus.violations).toEqual([]);
  });

  it('3. appBack with another AE64 Pro plugged in (another serial): the session\'s own keyboard is the one handed back', async () => {
    const s = await hidKeyboard({ enterBounce: true, extra: ['pro-twin'] });
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enter'));
    const back = s.hid.find('app')!;
    const twin = s.hid.find('pro-twin')!;
    expect(tag((s.device.transport as HidTransport).hidDevice)).toBe(tag(back));
    expect(sends(twin)).toEqual(['1 2']); // probed once, then left alone
    expect(s.bus.violations).toEqual([]);
  });

  it('3. appBack with two keyboards of the session\'s serial: neither is taken; enterFail says to connect again', async () => {
    const s = await hidKeyboard({ enterBounce: true });
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    s.bus.plug(new MockTransport({ seed: 'pro', serial: [...s.bus.serial], fwBus: s.bus, fwLabel: 'clone' }));
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enterNoApp'));
    expect(s.device.connected).toBe(false);
    expect(sends(s.hid.find('app')!)).toEqual(['1 2']);
    expect(sends(s.hid.find('clone')!)).toEqual(['1 2']);
    expect(sent08(s.bus).map((r) => `${r.dev} ${r.cmd}`)).toEqual(['app 08 01']);
    expect(s.bus.violations).toEqual([]);
  });

  it('4. the port\'s chooser: FW_PROBE_FILTER only; cancel, a refused chooser and a device another app holds give nothing', async () => {
    const s = await hidKeyboard();
    s.bus.plug(new MockBootloader(s.bus, s.bus.serial, 'boot'), false); // not allowed yet
    const port = new HidFwPort();
    port.adopt(s.t);
    expect(tags(await port.list())).toEqual([tag(s.t)]);
    s.hid.next = 'cancel';
    expect(tags(await port.request())).toEqual([]);
    expect(s.hid.requests.at(-1)!.filters).toEqual([FW_PROBE_FILTER]);
    s.hid.requestError = new DOMException('Must be handling a user gesture to show a permission request.', 'SecurityError');
    expect(tags(await port.request())).toEqual([]);
    s.hid.requestError = null;
    const boot = s.hid.find('boot')!;
    boot.openError = new DOMException('Failed to open the device.', 'NotAllowedError');
    expect(tags(await port.request())).toEqual([]);
    expect(boot.opens).toBe(0);
    boot.openError = null;
    const got = await port.request();
    expect(onDev(got, boot).length).toBe(1);
    expect((got[0] as HidTransport).probeOnly).toBe(true);
    expect(s.hid.requests.slice(1).map((r) => r.filters)).toEqual(new Array(4).fill([FW_PROBE_FILTER]));
    expect(s.bus.received).toEqual([]);
  });

  it('5. Connect / auto-reconnect on a keyboard in its bootloader: probe-only, 01 02 only, then rescue mode', async () => {
    const c = await bare(true);
    c.hid.next = (all) => all.filter((d) => d.label === 'boot');
    await c.device.connect();
    expect(c.hid.requests[0].filters).toEqual([...HID_FILTERS, FW_PROBE_FILTER]);
    const boot = c.hid.find('boot')!;
    expect(sends(boot)).toEqual(['1 2']);
    expect(c.fw.rescue).toBe(true);
    expect(c.fw.rescueBoard).toBe(FW_BOARD_PRO);
    expect(c.device.connected).toBe(false);
    expect(c.bus.violations).toEqual([]);
    removeFakeHid();

    const r = await bare(true);
    expect(await r.device.tryAutoReconnect()).toBe(true);
    expect(r.hid.requests).toEqual([]); // granted: no chooser
    expect(sends(r.hid.find('boot')!)).toEqual(['1 2']);
    expect(r.fw.rescue).toBe(true);
    expect(r.bus.violations).toEqual([]);
  });

  it('5. an unknown 1CA6 product in its app: 01 02 only, then refused (Connect and auto-reconnect)', async () => {
    for (const how of ['connect', 'reconnect'] as const) {
      const c = await bare(false);
      const odd = new FakeHidDevice(c.hid, new MockTransport({ seed: 'pro' }), { productId: 0x3999, productName: 'AE64 ?' });
      c.hid.strays.push(odd);
      c.hid.next = () => [odd];
      if (how === 'connect') await c.device.connect();
      else await c.device.tryAutoReconnect();
      expect(sends(odd)).toEqual(['1 2']);
      expect(c.device.connected).toBe(false);
      expect(c.device.error).toBe(tr('error.noAe64Selected'));
      expect(odd.opened).toBe(false);
      expect(c.fw.rescue).toBe(false);
      removeFakeHid();
    }
  });

  it('6. a full write through HidFwPort + HidTransport: permission through the chooser, 2121 packets, back in its app, init on the new connection', async () => {
    const s = await hidKeyboard({ bootNeedsPermission: true });
    const log = logSpy();
    const file = makeFw({ crc: CRC.v0100 });
    await startWith(s.fw, file);
    await until(() => s.fw.phase === 'needPermission');
    expect(s.appDev.present).toBe(false);
    const boot = s.hid.find('boot')!;
    expect(boot.opens).toBe(0); // not allowed yet: list() cannot see it
    const allowed = s.fw.allow(); // the bus's chooser: the bootloader (its probe runs on the fake clock)
    await run(2000);
    await allowed;
    expect(s.hid.requests.at(-1)!.filters).toEqual([FW_PROBE_FILTER]);
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(seq(s.bus).slice(0, 7)).toEqual(['app 01 02', 'app 08 01', 'boot 01 02', 'boot 08 02 ×2121', 'boot 08 03', 'boot 08 04', 'app 01 02']);
    expect(s.bus.violations).toEqual([]);
    expect(s.bus.writes.length).toBe(2121);
    const joined = new Uint8Array(file.length);
    for (const w of s.bus.writes) joined.set(w.subarray(8, 8 + (w[6] | (w[7] << 8))), w[2] | (w[3] << 8) | (w[4] << 16));
    expect(joined).toEqual(file);
    expect(boot.opens).toBe(1);
    expect(boot.sends.length).toBe(1 + 2121 + 2);
    const back = s.hid.find('app')!;
    const now = s.device.transport as HidTransport;
    expect(now instanceof HidTransport).toBe(true);
    expect(tag(now.hidDevice)).toBe(tag(back));
    expect(back.opens).toBe(1);
    expect(now.connected).toBe(true);
    expect(s.device.info?.firmware).toBe('0.1.0.0');
    expect(initCount(log)).toBe(1);
    expect(s.fw.active).toBe(false);
    await (s.fw.port as HidFwPort).release(now); // handed to the app (keep): the port never closes it
    expect(now.connected).toBe(true);
    expect(back.closes).toBe(0);
  });

  it('6. the bootloader unplugged mid-write → lost; back in its bootloader → rescue on a new device', async () => {
    const s = await hidKeyboard({ unplugAt: 100 });
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'lost');
    expect(s.fw.active).toBe(true);
    const first = [...s.hid.wrappers.values()].find((d) => d.label === 'boot')!;
    expect(first.present).toBe(false);
    await until(() => s.fw.phase === 'rescue', 5000);
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.rescueBoard).toBe(FW_BOARD_PRO);
    const again = s.hid.find('boot')!;
    expect(tag(again)).not.toBe(tag(first));
    expect(sends(again)).toEqual(['1 2']);
    expect(s.bus.writes.length).toBeGreaterThanOrEqual(101); // the packets sent before the unplug came through
    expect(s.bus.writes.length).toBeLessThan(2121);
    expect(s.bus.violations).toEqual([]);
  });

  it('7. packet 0 answered after 3.6 s → packetFail; the late reply is not taken for packet 0 of the rewrite', async () => {
    const s = await hidKeyboard({ delayAt: { packet: 0, ms: 3600 } });
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(settled(s));
    expect(s.fw.phase).toBe('packetFail');
    expect(s.bus.writes.length).toBe(1);
    s.fw.retry();
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    expect(s.bus.writes.length).toBe(1 + 2121);
    expect(s.bus.violations).toEqual([]);
  });
});

// FW review FW-TEST-3: one test per guard the reviewer's mutants showed untested (mutFW.cjs R2…R15, Sa…Sk, Dc…De).
describe('FW-TEST-3. guards the review mutants found untested', { timeout: 60_000 }, () => {
  const MAX_BOOT_BOARD = [0x00, 0x30, 0x00, 0x0d];
  /** Commands the bus saw from index `from` on, as "dev cmd". */
  const after = (bus: MockFwBus, from: number) => bus.received.slice(from).map((r) => `${r.dev} ${r.cmd}`);

  it('R7: 08 03 never answered → verifyFail after 10 s, no 08 04', async () => {
    const s = await demo('pro');
    s.bus.flags.verifySilent = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'verifying');
    const ms = await until(settled(s), 20_000);
    expect(s.fw.phase).toBe('verifyFail');
    expect(ms).toBeGreaterThanOrEqual(9_500);
    expect(cmds(s.bus, 'boot')).not.toContain('08 04');
    expect(s.bus.violations).toEqual([]);
  });

  it('R8: 08 03 answered with byte 2 = 2 or FF → verifyFail, no 08 04 (only 1 passes)', async () => {
    for (const status of [2, 0xff]) {
      const s = await demo('pro');
      s.bus.flags.verifyStatus = status;
      await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
      await until(settled(s));
      expect(s.fw.phase).toBe('verifyFail');
      expect(cmds(s.bus, 'boot')).not.toContain('08 04');
      expect(s.bus.violations).toEqual([]);
    }
  });

  it('R3: a bootloader of board 0030000D (no serial) is never taken for the Pro: 01 02 only, 0 × 08 02', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNeedsPermission = true; // the Pro's own bootloader stays invisible
    s.bus.flags.extra = ['boot-max'];
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(12_000);
    expect(s.fw.phase).toBe('needPermission');
    expect(cmds(s.bus, 'boot-max')).toEqual(['01 02']);
    expect(s.bus.writes).toEqual([]);
  });

  it('R4: a bootloader without a serial is not taken while another Pro bootloader is plugged in: 0 × 08 02', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNoSerial = true;
    s.bus.flags.extra = ['boot-other']; // board 0030000A, another serial
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(15_000);
    expect(['entering', 'needPermission']).toContain(s.fw.phase);
    expect(cmds(s.bus, 'boot')).toEqual(['01 02']);
    expect(cmds(s.bus, 'boot-other')).toEqual(['01 02']);
    expect(s.bus.writes).toEqual([]);
  });

  it('R5: while looking for the bootloader, the session\'s app connection is never probed (its next 01 02 is the 10 s check)', async () => {
    const s = await demo('pro');
    s.bus.flags.enterFail = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(9_500);
    expect(cmds(s.bus, 'app')).toEqual(['01 02', '08 01']);
    expect(['entering', 'needPermission']).toContain(s.fw.phase);
    await until(ended(s));
    expect(s.fw.phase).toBe('enterFail');
  });

  it('R9: the client refuses a rescue session on a file that is not official when asked (officialOnly)', async () => {
    const s = await demo('pro');
    const boot = new MockBootloader(s.bus, s.bus.serial, 'boot');
    const p = boot.beginRescueSession(makeFw({ crc: CRC.xinput081 }), { officialOnly: true }).then(() => null, (e: unknown) => e);
    await run(500);
    const err = await p;
    expect(err instanceof FirmwareSessionError).toBe(true);
    expect((err as FirmwareSessionError).reason).toBe('official');
    const q = boot.beginRescueSession(makeFw({ crc: CRC.v0100 }), { officialOnly: true });
    await run(500);
    expect(tag(await q)).not.toBe('undefined');
  });

  it('R14: 08 01 → the keyboard comes back in its app on a new connection → enterFail at once, that connection goes to init', async () => {
    const s = await demo('pro');
    s.bus.flags.enterBounce = true;
    const log = logSpy();
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    const ms = await until(ended(s), 20_000);
    expect(s.fw.phase).toBe('enterFail');
    expect(fwText(s.fw.error)).toBe(tr('fw.err.enter'));
    expect(ms).toBeLessThan(9_000); // found by looking (6 s), not by the 10 s check
    expect(s.device.connected).toBe(true);
    const back = s.device.transport as MockTransport;
    expect(tag(back)).not.toBe(tag(s.t));
    expect(back.connected).toBe(true);
    expect(initCount(log)).toBe(1);
    expect(sent08(s.bus).map((r) => `${r.dev} ${r.cmd}`)).toEqual(['app 08 01']);
  });

  it('R15: after 08 04 the keyboard comes back in its bootloader → rescue mode, not notFound', async () => {
    const s = await demo('pro');
    s.bus.flags.restartIntoBoot = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'finding');
    const ms = await until(() => s.fw.phase !== 'finding', 25_000);
    expect(s.fw.phase).toBe('rescue');
    expect(ms).toBeLessThan(10_000);
    expect(s.fw.rescue).toBe(true);
  });

  it('Sa, Sb: no answer to the 10 s check is not enterFail; it asks again 10 s later, then enterFail', async () => {
    const s = await demo('pro');
    s.bus.flags.enterFail = true;
    s.bus.flags.enterQuiet = 1;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(13_500); // the first check (10 s) timed out at 13 s
    expect(s.fw.phase).not.toBe('enterFail');
    expect(s.fw.active).toBe(true);
    expect(cmds(s.bus, 'app')).toEqual(['01 02', '08 01', '01 02']);
    const ms = await until(ended(s), 20_000);
    expect(s.fw.phase).toBe('enterFail');
    expect(13_500 + ms).toBeGreaterThanOrEqual(22_500);
    expect(cmds(s.bus, 'app').slice(0, 4)).toEqual(['01 02', '08 01', '01 02', '01 02']);
  });

  it('Sc: the bootloader unplugged during 08 03 → lost (in the check), then rescue; not verifyFail', async () => {
    const s = await demo('pro');
    s.bus.flags.unplugAtVerify = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'lost' || settled(s)());
    expect(s.fw.phase).toBe('lost');
    expect(s.fw.rows.write).toBe('done'); // lost in the check, after every packet was acknowledged
    expect(s.fw.rows.verify).toBe('fail');
    await until(() => s.fw.phase === 'rescue', 5000);
    expect(s.fw.rescue).toBe(true);
  });

  it('Sk: lost mid-write, the keyboard comes back in its app → stays lost (01 02 only), no rescue', async () => {
    const s = await demo('pro');
    s.bus.flags.unplugAt = 100;
    s.bus.flags.lostIntoApp = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'lost');
    const from = s.bus.received.length;
    await run(6000);
    expect(s.fw.phase).toBe('lost');
    expect(s.fw.rescue).toBe(false);
    expect(after(s.bus, from)).toEqual(['app 01 02']);
  });

  it('Sd: choosing a file while writing changes nothing', async () => {
    const s = await demo('pro');
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'writing');
    const name = s.fw.file?.name;
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0080 }), 'other.bin'));
    expect(s.fw.file?.name).toBe(name);
    expect(s.fw.phase).toBe('writing');
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
  });

  it('Sj: retry while writing or after done does nothing', async () => {
    const s = await demo('pro');
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'writing' && s.fw.sent > 10);
    s.fw.retry();
    await until(ended(s));
    expect(s.fw.phase).toBe('done');
    s.fw.retry();
    await run(5000);
    expect(s.fw.phase).toBe('done');
    expect(s.bus.writes.length).toBe(2121);
    expect(s.bus.violations).toEqual([]);
  });

  it('Sf: rescue on a bootloader of board 0030000D: no write even with a file for that board and the risk box', async () => {
    const s = await demo('pro');
    s.fw.setEnabled(true);
    s.bus.replugAsBootloader();
    await run(1000);
    for (const d of await s.bus.list()) if (d instanceof MockBootloader) s.bus.unplug(d);
    const boot = new MockBootloader(s.bus, new Array(12).fill(0), 'boot-max', MAX_BOOT_BOARD);
    s.bus.plug(boot);
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.rescueBoard).toBe(FW_BOARD_MAX);
    await s.fw.chooseFile(fileOf(makeFw({ board: FW_BOARD_MAX })));
    s.fw.riskOk = true;
    expect(s.fw.canRescueWrite).toBe(false);
    await s.fw.rescueWrite();
    await run(2000);
    expect(sent08(s.bus)).toEqual([]);
  });

  it('Sg: rescue with the switch off: an XInput file stays refused even with the risk box ticked', async () => {
    const s = await demo('pro');
    s.fw.setEnabled(false);
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader)!;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    await s.fw.chooseFile(fileOf(makeFw({ crc: CRC.xinput081 })));
    s.fw.riskOk = true;
    expect(s.fw.rescueRefused).toBe(true);
    expect(s.fw.canRescueWrite).toBe(false);
    void s.fw.rescueWrite();
    await run(3000);
    expect(sent08(s.bus)).toEqual([]);
  });

  it('R2: a device that said run mode 7 gets nothing after its 01 02', async () => {
    const s = await demo('pro');
    const odd = new MockBootloader(s.bus, s.bus.serial, 'boot');
    const orig = s.bus.deviceInfo.bind(s.bus);
    s.bus.deviceInfo = (b, sr, _m, f) => orig(b, sr, 7, f);
    const p = odd.getDeviceInfo();
    await run(100);
    expect((await p).runMode).toBe(7);
    const q = odd.getProtocolVersion().then(() => null, (e: unknown) => e);
    await run(2000);
    expect((await q) instanceof UnsafeCommandError).toBe(true);
    expect(cmds(s.bus, 'boot')).toEqual(['01 02']);
    const again = odd.getDeviceInfo(); // 01 02 stays allowed
    await run(100);
    expect((await again).runMode).toBe(7);
    expect(cmds(s.bus, 'boot')).toEqual(['01 02', '01 02']);
  });

  it('Dc, Dd, De: while a session runs, Disconnect, leaving the keyboard and switching profile do nothing', async () => {
    const s = await demo('pro');
    s.bus.flags.enterFail = true; // the app stays connected while the session runs
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(1000);
    expect(s.fw.active).toBe(true);
    const from = s.bus.received.length;
    const sent: string[] = [];
    const off = s.t.onPacketRaw((d, b) => { if (d === 'out') sent.push(`${b[0]} ${b[1]}`); });
    await s.device.disconnect({ user: true });
    expect(tag(s.device.transport)).toBe(tag(s.t));
    expect(s.t.connected).toBe(true);
    await s.device.changeKeyboard();
    expect(tag(s.device.transport)).toBe(tag(s.t));
    await s.device.switchDemoModel('max');
    expect(tag(s.device.transport)).toBe(tag(s.t));
    const other = (s.device.activeProfile + 1) % 4;
    await expect(s.device.switchProfile(other)).rejects.toThrow(tr('fw.pill'));
    expect(s.device.activeProfile).not.toBe(other);
    expect(sent).toEqual([]);
    expect(after(s.bus, from)).toEqual([]);
    off();
  });
});
