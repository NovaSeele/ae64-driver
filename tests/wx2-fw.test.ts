// WX2 (whole review W-03…W-07, W-13, N-FW3, N-FW4): every firmware state has a way out on the page itself, and nothing writes
// unless the user starts it. Demo bus only (fake bootloader), fake timers with the real waits. The reproductions F1, F3, F4
// and F9 of the review (zz-whole-1, zz-whole-2) are here turned round.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { MockTransport } from '../src/protocol/mock';
import { HidTransport } from '../src/protocol/hid';
import { FW_CHUNK } from '../src/protocol/firmware';
import { fwText } from '../src/components/firmware/fwText';
import FwWriteStep from '../src/components/firmware/FwWriteStep.vue';
import FwEnterStep from '../src/components/firmware/FwEnterStep.vue';
import FwFileStep from '../src/components/firmware/FwFileStep.vue';
import DeviceCard from '../src/components/shell/DeviceCard.vue';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';
import { CRC, demo, fileOf, makeFw, run, startWith } from './fw-helpers';
import { hidKeyboard, removeFakeHid } from './fw-hid';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); locale.value = 'vi'; });

async function until(pred: () => boolean, max = 60_000): Promise<number> {
  let ms = 0;
  while (!pred() && ms < max) { await run(250); ms += 250; }
  return ms;
}
const bootOf = async (bus: MockFwBus, label = 'boot') =>
  (await bus.list()).find((d) => d instanceof MockBootloader && d.label === label) as MockBootloader;
/** The bytes the bootloaders got in the `08 02` frames from index `from` on, in order. */
function stream(bus: MockFwBus, from: number): Uint8Array {
  const parts = bus.writes.slice(from).map((f) => f.subarray(8, 8 + (f[6] | (f[7] << 8))));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
/** Runs the clock while `p` (a step that reads `01 02`) settles. */
async function go<T>(p: Promise<T>, ms = 1000): Promise<T> {
  await run(ms);
  return p;
}
const packets = (bytes: Uint8Array) => Math.ceil(bytes.length / FW_CHUNK);
/** The device labels that got `cmd` from index `from` on. */
const devsOf = (bus: MockFwBus, cmd: string, from = 0) => [...new Set(bus.received.slice(from).filter((r) => r.cmd === cmd).map((r) => r.dev))];

describe('W-13: the screen wake lock is asked again when the page shows', { timeout: 60_000 }, () => {
  it('hidden then visible while writing → a new request; while waiting for the bootloader → none', async () => {
    const sentinels: { released: boolean; release: () => Promise<void> }[] = [];
    const request = vi.fn(async () => {
      const w = { released: false, release: async () => { w.released = true; } };
      sentinels.push(w);
      return w;
    });
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    let vis: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { get: () => vis, configurable: true });
    const flip = (v: DocumentVisibilityState) => { vis = v; if (v === 'hidden') sentinels.at(-1)!.released = true; document.dispatchEvent(new Event('visibilitychange')); };
    try {
      const s = await demo('pro');
      s.bus.flags.delayAt = { packet: 200, ms: 2500 };
      await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
      await run(0);
      expect(request).toHaveBeenCalledTimes(1);
      flip('hidden');
      flip('visible');
      await run(0);
      expect(request).toHaveBeenCalledTimes(1); // entering: no write runs yet
      await until(() => s.fw.phase === 'writing');
      flip('hidden');
      flip('visible');
      await run(0);
      expect(request).toHaveBeenCalledTimes(2);
      flip('visible'); // still held: not asked twice
      await run(0);
      expect(request).toHaveBeenCalledTimes(2);
      await until(() => s.fw.phase === 'done');
      expect(sentinels.every((w) => w.released)).toBe(true);
      flip('hidden');
      flip('visible');
      expect(request).toHaveBeenCalledTimes(2); // the session ended: the listener is gone
    } finally {
      delete (navigator as unknown as { wakeLock?: unknown }).wakeLock;
      delete (document as unknown as { visibilityState?: unknown }).visibilityState;
    }
  });
});

describe('W-03: after packetFail / verifyFail the bootloader is still watched', { timeout: 60_000 }, () => {
  it('F1: packetFail, the bootloader is unplugged → lost; it comes back → rescue on it; a write started there reaches it', async () => {
    const s = await demo('pro');
    s.bus.flags.wrongEchoAt = 5;
    const fw0 = makeFw({ crc: CRC.v0100 });
    await startWith(s.fw, fw0);
    await until(() => s.fw.phase === 'packetFail');
    const boot = await bootOf(s.bus);
    s.bus.lose(boot);
    await run(0);
    expect(s.fw.phase).toBe('lost');
    expect(s.fw.rows.write).toBe('fail');
    await until(() => s.fw.phase === 'rescue', 10_000);
    expect(s.fw.rescue).toBe(true);
    const fresh = await bootOf(s.bus);
    expect(fresh).not.toBe(boot);
    const from = s.bus.writes.length;
    await run(5000);
    expect(s.bus.writes.length).toBe(from); // nothing until the user starts
    expect(s.fw.canRescueWrite).toBe(true);
    void s.fw.rescueWrite();
    await run(0);
    await until(() => s.fw.phase === 'done', 60_000);
    expect(s.fw.phase).toBe('done');
    expect(stream(s.bus, from)).toEqual(fw0);
    expect(s.bus.violations).toEqual([]);
  });

  it('F1b: the same after verifyFail', async () => {
    const s = await demo('pro');
    s.bus.flags.verifyFail = true;
    const fw0 = makeFw({ crc: CRC.v0100 });
    await startWith(s.fw, fw0);
    await until(() => s.fw.phase === 'verifyFail');
    s.bus.lose(await bootOf(s.bus));
    await run(0);
    expect(s.fw.phase).toBe('lost');
    expect(s.fw.rows.write).toBe('done');
    expect(s.fw.rows.verify).toBe('fail');
    await until(() => s.fw.phase === 'rescue', 10_000);
    s.bus.flags.verifyFail = false;
    const from = s.bus.writes.length;
    void s.fw.rescueWrite();
    await run(0);
    await until(() => s.fw.phase === 'done', 60_000);
    expect(s.fw.phase).toBe('done');
    expect(stream(s.bus, from)).toEqual(fw0);
  });

  it('retry() refuses when the bootloader connection is gone, and the button says why', async () => {
    const s = await demo('pro');
    s.bus.flags.wrongEchoAt = 5;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'packetFail');
    const w = mount(FwWriteStep);
    await nextTick();
    const btn = () => w.findAll('button').find((b) => b.text() === tr('fw.err.retry'))!;
    expect(btn().attributes('disabled')).toBeUndefined();
    expect(w.text()).toContain(tr('fw.err.retryHelp'));
    const boot = await bootOf(s.bus);
    Object.defineProperty(boot, 'connected', { get: () => false, configurable: true }); // gone, and its event never came
    const from = s.bus.received.length;
    await btn().trigger('click');
    await run(5000);
    expect(s.bus.received.length).toBe(from);
    expect(s.fw.phase).toBe('packetFail');
    expect(btn().attributes('disabled')).toBeDefined();
    expect(w.text()).toContain(tr('fw.err.retryNoBoot'));
    w.unmount();
  });

  it('a disconnect while rebooting (the 08 04 restart) changes nothing', async () => {
    const s = await demo('pro');
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'rebooting');
    await run(100); // the bootloader left USB after 08 04
    expect(s.fw.phase).toBe('rebooting');
    await until(() => s.fw.phase === 'done');
    expect(s.fw.phase).toBe('done');
  });
});

describe('W-04: another file after packetFail / verifyFail', { timeout: 60_000 }, () => {
  it('F9: after verifyFail another file can be chosen, its checks show, and the write uses it', async () => {
    const s = await demo('pro');
    s.bus.flags.verifyFail = true;
    await startWith(s.fw, makeFw({ crc: CRC.xinput081 }), { risk: true });
    await until(() => s.fw.phase === 'verifyFail');
    expect(s.fw.canChoose).toBe(true);
    const step1 = mount(FwFileStep);
    await nextTick();
    expect(step1.findAll('button').some((b) => b.text() === tr('fw.change') && b.attributes('disabled') === undefined)).toBe(true);
    step1.unmount();
    const official = makeFw({ crc: CRC.v0100, seed: 7 });
    await go(s.fw.chooseFile(fileOf(official, 'official.bin')));
    await run(0);
    expect(s.fw.file?.name).toBe('official.bin');
    expect(s.fw.known?.kind).toBe('official');
    expect(s.fw.fileOk).toBe(true);
    expect(s.fw.phase).toBe('rescue');
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.rescueBoard).not.toBeNull();
    const from = s.bus.writes.length;
    await run(5000);
    expect(s.bus.writes.length).toBe(from); // rescue keeps its own button
    s.bus.flags.verifyFail = false;
    void s.fw.rescueWrite();
    await run(0);
    await until(() => s.fw.phase === 'done', 60_000);
    expect(s.fw.phase).toBe('done');
    expect(stream(s.bus, from)).toEqual(official);
    expect(s.bus.writes.length - from).toBe(packets(official));
  });

  it('after packetFail too; a file the checks refuse cannot be written', async () => {
    const s = await demo('pro');
    s.bus.flags.wrongEchoAt = 3;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'packetFail');
    await go(s.fw.chooseFile(fileOf(makeFw({ board: 0x0030000d }), 'max.bin')));
    await run(0);
    expect(s.fw.phase).toBe('rescue');
    expect(s.fw.fileOk).toBe(false);
    expect(s.fw.canRescueWrite).toBe(false);
    const from = s.bus.writes.length;
    void s.fw.rescueWrite();
    await run(0);
    await run(5000);
    expect(s.bus.writes.length).toBe(from);
  });

  it('the help under the button says what the page offers (vi, en)', () => {
    expect(tr('fw.err.retryHelp')).toMatch(/bước 1.*chế độ cứu/);
    locale.value = 'en';
    expect(tr('fw.err.retryHelp')).toMatch(/step 1.*rescue mode/);
  });
});

describe('W-05: the probe is asked again, and the clocks start when 08 01 settled', { timeout: 60_000 }, () => {
  it('F3: the bootloader ignores its first 01 02 → asked again → the write goes ahead by itself', async () => {
    const s = await demo('pro');
    s.bus.flags.bootQuiet = 1;
    const times: number[] = [];
    const log = s.bus.log.bind(s.bus);
    s.bus.log = (dev, cmd, ...rest) => { if (dev === 'boot' && cmd === '01 02') times.push(Date.now()); log(dev, cmd, ...rest); };
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'writing', 30_000);
    expect(s.fw.phase).toBe('writing');
    expect(times.length).toBe(2);
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(2000); // about 2 s after the unanswered one
  });

  it('three probes without an answer, then "Search again" (needPermission) asks again, with fresh tries', async () => {
    const s = await demo('pro');
    s.bus.flags.bootQuiet = 4; // the first probe after "Search again" is not answered either: it must be asked again
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(30_000);
    expect(s.fw.phase).toBe('needPermission');
    expect(s.bus.received.filter((r) => r.dev === 'boot' && r.cmd === '01 02').length).toBe(3);
    const w = mount(FwEnterStep);
    await nextTick();
    const again = w.findAll('button').find((b) => b.text() === tr('fw.findAgain'));
    expect(again).toBeTruthy();
    await again!.trigger('click');
    await until(() => s.fw.phase === 'writing', 10_000);
    expect(s.fw.phase).toBe('writing');
    expect(s.bus.received.filter((r) => r.dev === 'boot' && r.cmd === '01 02').length).toBe(5);
    w.unmount();
  });

  it('08 01 never settles, but the app connection leaves USB: the clocks start then', async () => {
    const s = await demo('pro');
    // The keyboard leaves USB 30 ms after 08 01; this transport does not fail the pending 08 01 when it goes, and the late
    // reply comes at 9.5 s. The clocks must start at the leave: the bootloader (on USB at 11.5 s) is taken at once.
    s.bus.flags.enterLate = 9500;
    const entered = s.bus.entered.bind(s.bus);
    s.bus.entered = (app) => { const r = entered(app); setTimeout(() => s.bus.unplug(app), 30); return r; };
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(13_000);
    expect(s.fw.phase).toBe('writing');
  });

  it('appLingers 11 s: the keyboard answers run mode 0 for 11 s, then enters → no enterFail, the write goes ahead', async () => {
    const s = await demo('pro');
    s.bus.flags.appLingers = 11_000;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'writing' || s.fw.phase === 'enterFail', 40_000);
    expect(s.fw.phase).toBe('writing');
    expect(s.bus.received.filter((r) => r.dev === 'app' && r.cmd === '01 02').length).toBeGreaterThanOrEqual(1);
    await until(() => s.fw.phase === 'done');
    expect(s.fw.phase).toBe('done');
  });

  it('enterLate 8 s: nothing is asked of any device before the reply + 6 s', async () => {
    const s = await demo('pro');
    s.bus.flags.enterLate = 8000;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(10);
    const from = s.bus.received.findIndex((r) => r.cmd === '08 01') + 1;
    expect(from).toBeGreaterThan(0);
    await run(8000 + 6000 - 300);
    expect(s.fw.phase).toBe('entering');
    expect(s.bus.received.slice(from).filter((r) => r.cmd === '01 02')).toEqual([]);
    await until(() => s.fw.phase === 'writing', 5000);
    expect(s.fw.phase).toBe('writing');
  });

  it('a keyboard that never enters still ends in enterFail (two run-mode-0 answers ≥ 3 s apart), the app connected again', async () => {
    const s = await demo('pro');
    s.bus.flags.enterFail = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await run(12_000);
    expect(s.fw.phase).not.toBe('enterFail'); // one answer at 10 s is not enough
    await until(() => s.fw.phase === 'enterFail', 10_000);
    expect(s.fw.phase).toBe('enterFail');
    expect(s.fw.active).toBe(false);
    expect(s.device.connected).toBe(true);
    expect(s.bus.writes).toEqual([]);
  });
});

describe('W-06: a bootloader with another serial', { timeout: 60_000 }, () => {
  async function otherSerial() {
    const s = await demo('pro');
    const orig = s.bus.deviceInfo.bind(s.bus);
    s.bus.deviceInfo = (board, serial, runMode, firmware) => orig(board, runMode === 255 ? serial.map((b) => b ^ 0x5a) : serial, runMode, firmware);
    s.bus.flags.bootNeedsPermission = true;
    const bytes = makeFw({ crc: CRC.v0100 });
    await startWith(s.fw, bytes);
    await until(() => s.fw.phase === 'needPermission', 10_000);
    return { ...s, bytes };
  }

  it('F4: Allow → the message → the user confirms → rescue on it; 0 writes until the user starts; a full write reaches it', async () => {
    const s = await otherSerial();
    const allowed = s.fw.allow();
    await run(20);
    await allowed;
    expect(s.fw.otherSerial).toBe(true); // from Allow itself, not the next search round
    expect(s.fw.wrongDevice).toBe(false);
    await run(3000);
    expect(s.fw.otherSerial).toBe(true);
    expect(s.fw.wrongDevice).toBe(false);
    expect(s.fw.phase).toBe('needPermission');
    const w = mount(FwEnterStep);
    await nextTick();
    expect(w.text()).toContain(tr('fw.s2.otherSerial', { model: 'AE64 Pro' }));
    await run(10_000);
    expect(s.bus.writes).toEqual([]);
    await w.findAll('button').find((b) => b.text() === tr('fw.s2.otherSerialBtn'))!.trigger('click');
    await run(500);
    expect(s.fw.phase).toBe('rescue');
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.active).toBe(true);
    await run(10_000);
    expect(s.bus.writes).toEqual([]);
    void s.fw.rescueWrite();
    await run(0);
    await until(() => s.fw.phase !== 'writing' && s.fw.phase !== 'rescue', 30_000);
    expect(s.bus.writes.length).toBe(packets(s.bytes));
    expect(stream(s.bus, 0)).toEqual(s.bytes);
    expect(s.bus.violations).toEqual([]);
    w.unmount();
  });

  it('the search finds it by itself (already allowed): the same offer shows without "Allow…"; nothing is written', async () => {
    const s = await demo('pro');
    const orig = s.bus.deviceInfo.bind(s.bus);
    s.bus.deviceInfo = (board, serial, runMode, firmware) => orig(board, runMode === 255 ? serial.map((b) => b ^ 0x5a) : serial, runMode, firmware);
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.otherSerial, 15_000);
    expect(s.fw.phase).toBe('needPermission');
    expect(s.fw.otherSerial).toBe(true);
    await run(20_000);
    expect(s.fw.phase).toBe('needPermission');
    expect(s.bus.writes).toEqual([]);
  });

  it('any other device keeps "choose the right keyboard"', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNeedsPermission = true;
    s.bus.flags.extra = ['pro-twin']; // an AE64 Pro running its app, with another (readable) serial
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 10_000);
    const twin = (s.bus as unknown as { devices: MockTransport[] }).devices.find((d) => d.fwLabel === 'pro-twin')!;
    expect(twin).toBeTruthy();
    s.bus.request = async () => [twin];
    await go(s.fw.allow(), 3000);
    await run(3000);
    expect(s.fw.wrongDevice).toBe(true);
    expect(s.fw.otherSerial).toBe(false);
    await go(s.fw.continueRescue());
    expect(s.fw.phase).toBe('needPermission');
    expect(s.fw.rescue).toBe(false);
  });

  it('the bootloader offered is unplugged before the click: "Continue" does nothing', async () => {
    const s = await otherSerial();
    await go(s.fw.allow(), 3000);
    expect(s.fw.otherSerial).toBe(true);
    s.bus.unplug(await bootOf(s.bus));
    await go(s.fw.continueRescue());
    expect(s.fw.phase).toBe('needPermission');
    expect(s.fw.rescue).toBe(false);
  });
});

describe('W-13: rescue picks the session\'s bootloader', { timeout: 60_000 }, () => {
  it('after 08 04 the keyboard is back in its bootloader next to another Pro bootloader → rescue on the session\'s one', async () => {
    const s = await demo('pro');
    s.bus.flags.restartIntoBoot = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'rebooting');
    await run(100);
    s.bus.plug(new MockBootloader(s.bus, s.bus.serial.map((b) => b ^ 0x5a), 'boot-other')); // listed first
    await until(() => s.fw.phase === 'rescue', 30_000);
    const from = s.bus.received.length;
    void s.fw.rescueWrite();
    await run(0);
    await run(3000);
    expect(devsOf(s.bus, '08 02', from)).toEqual(['boot']);
  });

  it('lost, then two Pro bootloaders come back → rescue on the one with the session\'s serial', async () => {
    const s = await demo('pro');
    s.bus.flags.unplugAt = 50;
    s.bus.lose = (b: MockBootloader) => {
      s.bus.unplug(b);
      setTimeout(() => {
        s.bus.plug(new MockBootloader(s.bus, s.bus.serial.map((x) => x ^ 0x5a), 'boot-other'));
        s.bus.plug(new MockBootloader(s.bus, s.bus.serial, 'boot'));
      }, 1500);
    };
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'rescue', 40_000);
    const from = s.bus.received.length;
    void s.fw.rescueWrite();
    await run(0);
    await run(3000);
    expect(devsOf(s.bus, '08 02', from)).toEqual(['boot']);
  });
});

describe('W-13: a file read while a session starts', { timeout: 60_000 }, () => {
  it('a slow file read that ends after the start is dropped: the session and the page keep the first file', async () => {
    const s = await demo('pro');
    const first = makeFw({ crc: CRC.v0100 });
    await s.fw.chooseFile(fileOf(first, 'first.bin'));
    s.fw.typed = 'AE64 Pro';
    if (s.fw.needsVer) s.fw.verOk = true; // DESIGN OFU §4.1: 0.1.0.0 on the demo Pro (0.1.0.0) asks for the version box
    let finish!: () => void;
    const second = makeFw({ crc: CRC.v0080, seed: 3 });
    const slow = { name: 'second.bin', size: second.length, arrayBuffer: () => new Promise<ArrayBuffer>((r) => { finish = () => r(second.slice().buffer); }) } as unknown as File;
    const choosing = s.fw.chooseFile(slow);
    void s.fw.start();
    await run(0);
    expect(s.fw.active).toBe(true);
    finish();
    await choosing;
    expect(s.fw.file?.name).toBe('first.bin');
    await until(() => s.fw.phase === 'done');
    expect(stream(s.bus, 0)).toEqual(first);
  });

  it('the same in rescue mode: a write started during the read keeps its file', async () => {
    const s = await demo('pro');
    s.bus.flags.verifyFail = true;
    const first = makeFw({ crc: CRC.v0100 });
    await startWith(s.fw, first);
    await until(() => s.fw.phase === 'verifyFail');
    await go(s.fw.chooseFile(fileOf(first, 'again.bin')));
    await run(0);
    expect(s.fw.phase).toBe('rescue');
    s.bus.flags.verifyFail = false;
    let finish!: () => void;
    const other = makeFw({ crc: CRC.v0080, seed: 5 });
    const slow = { name: 'other.bin', size: other.length, arrayBuffer: () => new Promise<ArrayBuffer>((r) => { finish = () => r(other.slice().buffer); }) } as unknown as File;
    const choosing = s.fw.chooseFile(slow);
    const from = s.bus.writes.length;
    void s.fw.rescueWrite();
    await run(0);
    await run(0);
    finish();
    await choosing;
    expect(s.fw.file?.name).toBe('again.bin');
    await until(() => s.fw.phase === 'done');
    expect(stream(s.bus, from)).toEqual(first);
  });
});

describe('W-13: HidTransport.close() and other connections of the same device', { timeout: 60_000 }, () => {
  afterEach(() => removeFakeHid());

  it('a closed non-owner reports connected false and refuses at once; the owner keeps working', async () => {
    const k = await hidKeyboard();
    const owner = k.t;
    const second = new HidTransport(owner.hidDevice);
    await second.open();
    expect(second.connected).toBe(true);
    await second.close();
    expect(second.connected).toBe(false);
    const at = Date.now();
    await expect(second.getDeviceInfo(3000)).rejects.toThrow();
    expect(Date.now() - at).toBe(0); // no timeout waited
    expect(owner.connected).toBe(true);
    const info = owner.getDeviceInfo(3000);
    await run(100);
    expect((await info).runMode).toBe(0);
  });

  it("the owner's close leaves the device open for the other connection, which still works; its close then closes it", async () => {
    const k = await hidKeyboard();
    const owner = k.t;
    const dev = k.hid.of(k.app);
    const second = new HidTransport(owner.hidDevice);
    await second.open();
    await owner.close();
    expect(owner.connected).toBe(false);
    expect(dev.opened).toBe(true);
    expect(second.connected).toBe(true);
    const info = second.getDeviceInfo(3000);
    await run(100);
    expect((await info).runMode).toBe(0);
    await second.close();
    expect(second.connected).toBe(false);
    expect(dev.opened).toBe(false);
  });
});

describe('N-FW3, N-FW4: what the sidebar and step 3 say during a session', { timeout: 60_000 }, () => {
  it('the device card shows the firmware state, not the latency and version (vi, en)', async () => {
    const s = await demo('pro');
    const w = mount(DeviceCard);
    await nextTick();
    expect(w.text()).toContain(s.device.info!.firmware);
    s.bus.flags.delayAt = { packet: 100, ms: 2500 };
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'writing');
    await nextTick();
    expect(w.text()).toContain(tr('fw.cardUpdating'));
    expect(w.text()).not.toMatch(/\d ms/);
    expect(w.text()).not.toContain(tr('device.firmware'));
    locale.value = 'en';
    await nextTick();
    expect(w.text()).toContain('Updating firmware');
    expect(s.device.connected).toBe(true); // UI only: endSession relies on it
    w.unmount();
  });

  it('rescue mode: "Chế độ cập nhật" / "Update mode"; view-only rescue (no board) does not show step 3 as running', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNoBoard = true;
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader)!;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    expect(s.fw.phase).toBe('rescue');
    expect(s.fw.rescueBoard).toBeNull();
    const w = mount(DeviceCard);
    await nextTick();
    expect(w.text()).toContain(tr('fw.cardRescue'));
    locale.value = 'en';
    await nextTick();
    expect(w.text()).toContain('Update mode');
    w.unmount();
  });
});

describe('W-07 in rescue mode: the bootloader leaves and the keyboard comes back in its app', { timeout: 60_000 }, () => {
  it('the session ends with the version message; step 3 shows nothing running', async () => {
    const s = await demo('pro');
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader) as MockBootloader;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    expect(s.fw.phase).toBe('rescue');
    s.bus.unplug(boot);
    setTimeout(() => s.bus.plug(new MockTransport({ seed: 'pro', serial: [...s.bus.serial], fwBus: s.bus })), 1500);
    await until(() => !s.fw.active, 10_000);
    expect(s.fw.phase).toBe('appBack');
    expect(s.device.connected).toBe(true);
    expect(s.fw.rows.write).toBe('todo');
    expect(fwText(s.fw.error)).toContain(s.device.info!.firmware);
    expect(s.bus.writes).toEqual([]);
  });
});
