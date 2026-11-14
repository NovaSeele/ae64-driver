// DESIGN FW §11 tests 4, 5, 6, 8, 9, 10 (the store part), 11 (rescue) and 12: the session on the demo bus (fake bootloader),
// fake timers with the real waits (6 s / 3 s per packet / 10 s / 3 s + 20 s).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FW_BOARD_PRO } from '../src/protocol/firmware';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { MockTransport } from '../src/protocol/mock';
import { BaseTransport } from '../src/protocol/client';
import { useCalibrationStore } from '../src/stores/calibration';
import { useGamepadStore } from '../src/stores/gamepad';
import { useHistoryStore } from '../src/stores/history';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { t as tr } from '../src/i18n/vi';
import { fwText } from '../src/components/firmware/fwText';
import { CRC, demo, fileOf, makeFw, run, seq, startWith } from './fw-helpers';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

type S = Awaited<ReturnType<typeof demo>>;
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
