// WX2 fix round (review of 827f7d8): N-WX2-1 (the W-06 rescue knows the serial the keyboard reports from its app), N-WX2-2
// (Allow during a probe of the same bootloader), and tests for the reviewer's surviving mutants X3, X20, X21, C6, X12.
// Demo bus only (fake bootloader), fake timers with the real waits. The reviewer's zz-wx2-n1 / zz-wx2-n2 are here turned round.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { MockTransport } from '../src/protocol/mock';
import { FW_CHUNK } from '../src/protocol/firmware';
import { CRC, demo, fileOf, makeFw, run, startWith } from './fw-helpers';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function until(pred: () => boolean, max = 60_000, step = 250): Promise<number> {
  let ms = 0;
  while (!pred() && ms < max) { await run(step); ms += step; }
  return ms;
}
/** Runs the clock while `p` (a step that reads `01 02`) settles. */
async function go<T>(p: Promise<T>, ms = 1000): Promise<T> {
  await run(ms);
  return p;
}
const bootOf = async (bus: MockFwBus, label = 'boot') =>
  (await bus.list()).find((d) => d instanceof MockBootloader && d.label === label) as MockBootloader;
const probesOf = (bus: MockFwBus, dev: string, from = 0) => bus.received.slice(from).filter((r) => r.dev === dev && r.cmd === '01 02').length;
const setSerial = (bus: MockFwBus, serial: number[]) => { (bus as unknown as { serial: number[] }).serial = serial; };

/** The demo keyboard whose bootloader answers `01 02` with another serial than its app (W-06); "Continue in rescue mode". */
async function otherSerialRescue() {
  const s = await demo('pro');
  const orig = s.bus.deviceInfo.bind(s.bus);
  s.bus.deviceInfo = (board, serial, runMode, firmware) => orig(board, runMode === 255 ? serial.map((b) => b ^ 0x5a) : serial, runMode, firmware);
  s.bus.flags.bootNeedsPermission = true;
  const bytes = makeFw({ crc: CRC.v0100 });
  await startWith(s.fw, bytes);
  await until(() => s.fw.phase === 'needPermission', 10_000);
  await go(s.fw.allow(), 20);
  expect(s.fw.otherSerial).toBe(true);
  await go(s.fw.continueRescue(), 500);
  expect(s.fw.phase).toBe('rescue');
  expect(s.bus.writes).toEqual([]);
  return { ...s, bytes };
}
const third = (bus: MockFwBus) => bus.serial.map((b) => b ^ 0x33);

describe('N-WX2-1: after "Continue in rescue mode" the keyboard back in its app is found by the serial its app reports', { timeout: 120_000 }, () => {
  it('after the verified write: done, unlocked, the app connected (no reload)', async () => {
    const s = await otherSerialRescue();
    void s.fw.rescueWrite();
    await run(0);
    await until(() => s.fw.phase === 'writing', 10_000);
    await until(() => !['writing', 'verifying', 'rebooting', 'finding'].includes(s.fw.phase), 60_000);
    expect(s.bus.writes.length).toBe(Math.ceil(s.bytes.length / FW_CHUNK));
    expect(s.fw.phase).toBe('done'); // 827f7d8: notFound after 20 s, locked; "Search again" never matched
    expect(s.fw.active).toBe(false);
    expect(s.device.connected).toBe(true);
    expect(s.bus.violations).toEqual([]);
  });

  it('the bootloader leaves rescue mode and the keyboard comes back in its app → appBack, nothing written', async () => {
    const s = await otherSerialRescue();
    s.bus.unplug(await bootOf(s.bus));
    setTimeout(() => s.bus.plug(new MockTransport({ seed: 'pro', serial: [...s.bus.serial], fwBus: s.bus })), 1500);
    await until(() => !s.fw.active, 10_000);
    expect(s.fw.phase).toBe('appBack'); // 827f7d8: stays rescue with no bootloader, locked
    expect(s.device.connected).toBe(true);
    expect(s.bus.writes).toEqual([]);
  });

  it('an AE64 Pro in its app with a third serial is not taken after the write: notFound, nothing more written', async () => {
    const s = await otherSerialRescue();
    void s.fw.rescueWrite();
    await run(0);
    await until(() => s.fw.phase === 'rebooting', 30_000);
    const n = s.bus.writes.length;
    const from = s.bus.received.length;
    setSerial(s.bus, third(s.bus)); // the keyboard that comes back in its app reports neither serial
    await until(() => s.fw.phase !== 'rebooting' && s.fw.phase !== 'finding', 40_000);
    expect(s.fw.phase).toBe('notFound');
    expect(s.fw.active).toBe(true);
    s.fw.findAgain();
    await run(25_000);
    expect(s.fw.phase).toBe('notFound');
    expect(s.bus.writes.length).toBe(n);
    expect(s.bus.received.slice(from).filter((r) => r.cmd.startsWith('08 '))).toEqual([]);
  });

  it('…nor in rescue mode: a third serial in its app leaves the page in rescue, nothing written', async () => {
    const s = await otherSerialRescue();
    s.bus.unplug(await bootOf(s.bus));
    setTimeout(() => s.bus.plug(new MockTransport({ seed: 'pro', serial: third(s.bus), fwBus: s.bus })), 1500);
    await run(10_000);
    expect(s.fw.phase).toBe('rescue');
    expect(s.fw.active).toBe(true);
    expect(s.bus.writes).toEqual([]);
  });

  it('choosing a bootloader still uses the bootloader\'s serial: one reporting the app\'s serial is not taken', async () => {
    const s = await otherSerialRescue();
    s.bus.unplug(await bootOf(s.bus));
    setTimeout(() => {
      // reports the app's serial (its own serial ^ 0x5a through the override): another keyboard's bootloader, listed first
      s.bus.plug(new MockBootloader(s.bus, s.bus.serial.map((b) => b ^ 0x5a), 'boot-other'));
      s.bus.plug(new MockBootloader(s.bus, [...s.bus.serial], 'boot')); // reports the session's bootloader serial
    }, 1500);
    await run(100);
    expect(s.fw.canRescueWrite).toBe(false); // its bootloader left
    await until(() => s.fw.phase === 'rescue' && s.fw.canRescueWrite, 10_000);
    expect(s.fw.canRescueWrite).toBe(true); // 827f7d8: stayed off (the computed lost its bootTick dependency)
    const from = s.bus.received.length;
    void s.fw.rescueWrite();
    await run(0);
    await run(3000);
    expect([...new Set(s.bus.received.slice(from).filter((r) => r.cmd === '08 02').map((r) => r.dev))]).toEqual(['boot']);
  });

  it('a rescue opened at connect time still takes only its bootloader\'s serial (the app\'s is not known)', async () => {
    const s = await demo('pro');
    const orig = s.bus.deviceInfo.bind(s.bus);
    s.bus.deviceInfo = (board, serial, runMode, firmware) => orig(board, runMode === 255 ? serial.map((b) => b ^ 0x5a) : serial, runMode, firmware);
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader) as MockBootloader;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    expect(s.fw.phase).toBe('rescue');
    s.bus.unplug(boot);
    setTimeout(() => s.bus.plug(new MockTransport({ seed: 'pro', serial: [...s.bus.serial], fwBus: s.bus })), 1500);
    await run(10_000);
    expect(s.fw.phase).toBe('rescue'); // stays on the reload list (FW2 "If something stops")
    expect(s.bus.writes).toEqual([]);
  });
});

describe('N-WX2-3 (found in this round): rescue mode, the bootloader leaves and comes back', { timeout: 120_000 }, () => {
  it('"Write firmware" turns on again for the bootloader that came back, and a write started there reaches it', async () => {
    const s = await demo('pro');
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader) as MockBootloader;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    await go(s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 }), 'official.bin')), 500);
    expect(s.fw.phase).toBe('rescue');
    expect(s.fw.canRescueWrite).toBe(true);
    s.bus.unplug(boot);
    await run(100);
    expect(s.fw.canRescueWrite).toBe(false);
    setTimeout(() => s.bus.plug(new MockBootloader(s.bus, [...s.bus.serial], 'boot')), 1500);
    await until(() => s.fw.canRescueWrite, 10_000);
    expect(s.fw.canRescueWrite).toBe(true); // 827f7d8: stayed off until a reload
    expect(s.bus.writes).toEqual([]);
    void s.fw.rescueWrite();
    await run(0);
    await until(() => !s.fw.active, 60_000);
    expect(s.fw.phase).toBe('done');
    expect(s.bus.violations).toEqual([]);
  });
});

describe('N-WX2-2: Allow while the search\'s probe of the same bootloader is out', { timeout: 120_000 }, () => {
  it('Allow waits for that answer: no "wrong device" about the session\'s own bootloader, then writing', async () => {
    const s = await demo('pro');
    s.bus.flags.bootQuiet = 2; // busy: its first two 01 02 go unanswered (1.5 s each)
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 15_000, 50);
    const n = probesOf(s.bus, 'boot');
    await until(() => probesOf(s.bus, 'boot') > n, 5_000, 50); // the search's next probe is out now (and goes unanswered)
    await run(100);
    const before = probesOf(s.bus, 'boot');
    const allowed = s.fw.allow();
    await run(20);
    expect(probesOf(s.bus, 'boot')).toBe(before); // still one 01 02 at a time to that device
    await go(allowed, 2000);
    expect(s.fw.wrongDevice).toBe(false); // 827f7d8: true
    await until(() => s.fw.phase === 'writing', 20_000, 50);
    expect(s.fw.phase).toBe('writing');
  });
});

describe('X3: a failed write whose bootloader is gone without an event', { timeout: 60_000 }, () => {
  it('step 1 takes no file: no rescue, no 01 02', async () => {
    const s = await demo('pro');
    s.bus.flags.wrongEchoAt = 5;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'packetFail');
    expect(s.fw.canChoose).toBe(true);
    const boot = await bootOf(s.bus);
    Object.defineProperty(boot, 'connected', { get: () => false, configurable: true }); // gone, and its event never came
    s.fw.retry(); // the page notices (the button's refusal), as the page would on any update
    expect(s.fw.canChoose).toBe(false);
    const from = s.bus.received.length;
    await go(s.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 }), 'other.bin')), 3000);
    await run(5000);
    expect(s.fw.phase).toBe('packetFail');
    expect(s.fw.rescue).toBe(false);
    expect(s.bus.received.length).toBe(from);
  });
});

describe('X20, X21: the watch after lost asks a busy bootloader again, three times at most', { timeout: 120_000 }, () => {
  it('lost, the bootloader comes back busy (its first 01 02 unanswered) → rescue on it', async () => {
    const s = await demo('pro');
    s.bus.flags.unplugAt = 50;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'lost', 30_000);
    s.bus.flags.bootQuiet = 1; // the new bootloader ignores its first 01 02
    const from = s.bus.received.length;
    const n = s.bus.writes.length;
    await until(() => s.fw.phase === 'rescue', 15_000);
    expect(s.fw.phase).toBe('rescue');
    expect(probesOf(s.bus, 'boot', from)).toBe(2);
    expect(s.bus.writes.length).toBe(n);
  });

  it('a device that never answers gets exactly 3 probes in 20 s; the page stays lost', async () => {
    const s = await demo('pro');
    s.bus.flags.unplugAt = 50;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'lost', 30_000);
    s.bus.flags.bootQuiet = 1000; // the bootloader that comes back never answers
    const from = s.bus.received.length;
    await run(20_000);
    expect(probesOf(s.bus, 'boot', from)).toBe(3);
    expect(s.fw.phase).toBe('lost');
  });
});

describe('C6: two Pro bootloaders, neither with the session\'s serial', { timeout: 60_000 }, () => {
  it('no offer: "choose the right keyboard"', async () => {
    const s = await demo('pro');
    const orig = s.bus.deviceInfo.bind(s.bus);
    s.bus.deviceInfo = (board, serial, runMode, firmware) => orig(board, runMode === 255 ? serial.map((b) => b ^ 0x5a) : serial, runMode, firmware);
    s.bus.flags.bootNeedsPermission = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 10_000);
    s.bus.plug(new MockBootloader(s.bus, s.bus.serial.map((b) => b ^ 0x33), 'boot-other'), false);
    await go(s.fw.allow(), 3000);
    expect(s.fw.otherSerial).toBe(false);
    expect(s.fw.wrongDevice).toBe(true);
    await go(s.fw.continueRescue());
    expect(s.fw.phase).toBe('needPermission');
    expect(s.bus.writes).toEqual([]);
  });
});

describe('X12: a keyboard that never enters', { timeout: 60_000 }, () => {
  it('ends in enterFail within 15 s of the 08 01 reply (two answers 3 s apart)', async () => {
    const s = await demo('pro');
    s.bus.flags.enterFail = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    const ms = await until(() => s.fw.phase === 'enterFail', 30_000);
    expect(s.fw.phase).toBe('enterFail');
    expect(ms).toBeLessThanOrEqual(15_000);
    expect(ms).toBeGreaterThanOrEqual(12_000);
  });
});
