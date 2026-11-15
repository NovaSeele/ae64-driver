// WX3 item 0: the N-WX2-4 note after "Allow…" for a device that has not answered yet, and the reviewer's R7 (a rescue
// opened at connect time does not take a keyboard by the app serial of an earlier W-06 session). Demo bus only, fake timers.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import FwEnterStep from '../src/components/firmware/FwEnterStep.vue';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { MockTransport } from '../src/protocol/mock';
import { t as tr } from '../src/i18n/vi';
import { CRC, demo, makeFw, run, startWith } from './fw-helpers';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function until(pred: () => boolean, max = 60_000, step = 250): Promise<number> {
  let ms = 0;
  while (!pred() && ms < max) { await run(step); ms += step; }
  return ms;
}
async function go<T>(p: Promise<T>, ms = 1000): Promise<T> {
  await run(ms);
  return p;
}
const probesOf = (bus: MockFwBus, dev: string, from = 0) => bus.received.slice(from).filter((r) => r.dev === dev && r.cmd === '01 02').length;
const writesOut = (bus: MockFwBus) => bus.received.filter((r) => r.cmd !== '01 02').length;

describe('N-WX2-4: Allow returns a device that has not answered', { timeout: 120_000 }, () => {
  it('a silent bootloader: the neutral note (role=status), no "wrong device", 0 writes', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNeedsPermission = true;
    s.bus.flags.bootQuiet = 1000; // never answers its 01 02
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 10_000, 50);
    expect(s.fw.notAnswered).toBe(false);
    await go(s.fw.allow(), 2000);
    expect(s.fw.phase).toBe('needPermission');
    expect(s.fw.notAnswered).toBe(true); // d028465: nothing said at all
    expect(s.fw.wrongDevice).toBe(false);
    expect(s.fw.otherSerial).toBe(false);
    expect(s.bus.writes).toEqual([]);
    // rendered under the buttons, as a status line (not an alert)
    vi.useRealTimers();
    const w = mount(FwEnterStep, { attachTo: document.body });
    await nextTick();
    const note = w.find('[data-test="not-answered"]');
    expect(note.exists()).toBe(true);
    expect(note.attributes('role')).toBe('status');
    expect(note.text()).toContain(tr('fw.s2.notAnswered'));
    expect(w.find('[role="alert"]').exists()).toBe(false);
    w.unmount();
  });

  it('"Search again" and the next Allow take the note away', async () => {
    const s = await demo('pro');
    s.bus.flags.bootNeedsPermission = true;
    s.bus.flags.bootQuiet = 1000;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 10_000, 50);
    await go(s.fw.allow(), 2000);
    expect(s.fw.notAnswered).toBe(true);
    s.fw.findAgain();
    expect(s.fw.notAnswered).toBe(false);
    await go(s.fw.allow(), 2000);
    expect(s.fw.notAnswered).toBe(true);
    const again = s.fw.allow();
    expect(s.fw.notAnswered).toBe(false); // gone as soon as Allow is pressed again
    await go(again, 2000);
    expect(s.bus.writes).toEqual([]);
  });

  it('Allow during the search\'s unanswered probe: the note, then gone once the device answered, then writing', async () => {
    const s = await demo('pro');
    s.bus.flags.bootQuiet = 2; // busy: its first two 01 02 go unanswered
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 15_000, 50);
    const n = probesOf(s.bus, 'boot');
    await until(() => probesOf(s.bus, 'boot') > n, 5_000, 50); // the search's second probe is out (unanswered)
    await run(100);
    await go(s.fw.allow(), 2000);
    expect(s.fw.notAnswered).toBe(true);
    expect(s.fw.wrongDevice).toBe(false);
    await until(() => s.fw.phase === 'writing', 20_000, 50);
    expect(s.fw.phase).toBe('writing');
    expect(s.fw.notAnswered).toBe(false); // the session attached
  });
});

describe('R7: a rescue opened at connect time forgets the app serial of the W-06 session before it', { timeout: 180_000 }, () => {
  it('keyboard A done through W-06, then a rescue on keyboard B: A back in its app is not taken', async () => {
    // A: the bootloader answers 01 02 with another serial than its app (W-06), "Continue in rescue mode", written → done
    const s = await demo('pro');
    const orig = s.bus.deviceInfo.bind(s.bus);
    s.bus.deviceInfo = (board, serial, runMode, firmware) => orig(board, runMode === 255 ? serial.map((b) => b ^ 0x5a) : serial, runMode, firmware);
    s.bus.flags.bootNeedsPermission = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.phase === 'needPermission', 10_000);
    await go(s.fw.allow(), 20);
    expect(s.fw.otherSerial).toBe(true);
    await go(s.fw.continueRescue(), 500);
    void s.fw.rescueWrite();
    await run(0);
    await until(() => !['rescue', 'writing', 'verifying', 'rebooting', 'finding'].includes(s.fw.phase), 60_000);
    expect(s.fw.phase).toBe('done');
    const appA = (await s.bus.list()).find((d) => d instanceof MockTransport) as MockTransport;
    expect(appA).toBeTruthy();
    // B: another keyboard (another serial) in update mode, opened at connect time
    s.bus.unplug(appA);
    await run(500);
    const serialB = s.bus.serial.map((b) => b ^ 0x33);
    const bootB = new MockBootloader(s.bus, serialB, 'boot-twin');
    s.bus.plug(bootB);
    const p = s.device.adoptFromFirmware(bootB, true);
    await run(500);
    await p;
    expect(s.fw.phase).toBe('rescue');
    const sent = writesOut(s.bus);
    // B's bootloader leaves; A shows up running its app
    s.bus.unplug(bootB);
    setTimeout(() => s.bus.plug(new MockTransport({ seed: 'pro', serial: [...s.bus.serial], fwBus: s.bus })), 1500);
    await run(10_000);
    expect(s.fw.phase).toBe('rescue'); // with appIdent kept from A's session: appBack (A taken)
    expect(s.fw.active).toBe(true);
    expect(writesOut(s.bus)).toBe(sent);
    expect(s.bus.violations).toEqual([]);
  });
});
