// DESIGN FW §11 test 3 (P1-6): family 08 is built only in client.ts, only for a session client.ts opened, in order; and a
// connection whose keyboard is not running its app gets nothing but `01 02`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  BaseTransport, FirmwareSessionError, frameOf, fwAttach, fwFind, sessionFile,
} from '../src/protocol/client';
import type { FwTicket } from '../src/protocol/client';
import { UnsafeCommandError, checkFirmwareFrame, checkFrame } from '../src/protocol/safety';
import type { FirmwareGuard } from '../src/protocol/safety';
import { FW_BOARD_MAX, FW_BOARD_PRO } from '../src/protocol/firmware';
import { MockBootloader } from '../src/protocol/mockFirmware';
import { MockTransport } from '../src/protocol/mock';
import { CRC, demo, makeFw, run } from './fw-helpers';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

/** Every family-08 frame a transport sends (out reports). */
function outs08(t: BaseTransport): number[][] {
  const got: number[][] = [];
  t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x08) got.push(Array.from(b.subarray(0, 8))); });
  return got;
}

async function attached() {
  const s = await demo('pro');
  const sent = outs08(s.t);
  const ticket = await withTimers(s.t.beginFirmwareSession(makeFw({ crc: CRC.v0100 })));
  void s.t.fwEnter(ticket);
  await run(2100); // the demo bootloader shows up after 2 s
  const r = await withTimers(fwAttach(ticket, await s.bus.list()));
  if (!r.ok) throw new Error(`not attached: ${r.why}`);
  return { ...s, ticket, boot: r.transport, sent };
}
async function withTimers<T>(p: Promise<T>): Promise<T> {
  const out = p.then((v) => ({ v }), (e: unknown) => ({ e }));
  for (let i = 0; i < 50; i++) await run(100);
  const r = await out;
  if ('e' in r) throw r.e;
  return r.v;
}

describe('3. the 08 lock', () => {
  it('outside a session: frameOf, checkFrame and raw() refuse every 08; nothing is sent', async () => {
    const { t, bus } = await demo('pro');
    const sent = outs08(t);
    for (const p of [[8, 1], [8, 2, 0, 0, 0, 0, 56, 0], [8, 3], [8, 4], [8, 0x80]]) {
      expect(() => frameOf(p)).toThrow();
      expect(() => checkFrame(p)).toThrow(UnsafeCommandError);
      await expect(t.raw(p)).rejects.toThrow();
    }
    expect(sent).toEqual([]);
    expect(bus.received.filter((r) => r.cmd.startsWith('08'))).toEqual([]);
  });

  it('raw([8, 2, …]) is refused while a session runs (and on the bootloader too)', async () => {
    const { t, boot, sent } = await attached();
    await expect(t.raw([8, 2, 0, 0, 0, 0, 56, 0])).rejects.toThrow();
    await expect(boot.raw([8, 2, 0, 0, 0, 0, 56, 0])).rejects.toThrow();
    expect(sent.map((f) => f[1])).toEqual([0x01]); // only the session's 08 01
  });

  it('a forged ticket or a look-alike object: every fw* function throws, 0 frames of 08', async () => {
    const { t, bus } = await demo('pro');
    const sent = outs08(t);
    const fakes = [Object.freeze({}), {}, { active: true, board: FW_BOARD_PRO, fileOk: true }] as unknown as FwTicket[];
    for (const f of fakes) {
      await expect(t.fwEnter(f)).rejects.toThrow(UnsafeCommandError);
      await expect(t.fwWrite(f)).rejects.toThrow(UnsafeCommandError);
      await expect(t.fwVerify(f)).rejects.toThrow(UnsafeCommandError);
      await expect(t.fwRestart(f)).rejects.toThrow(UnsafeCommandError);
      expect(() => sessionFile(f)).toThrow(UnsafeCommandError);
      await expect(fwAttach(f, [t])).rejects.toThrow(UnsafeCommandError);
      await expect(fwFind(f, [t])).rejects.toThrow(UnsafeCommandError);
    }
    expect(sent).toEqual([]);
    expect(bus.received.filter((r) => r.cmd.startsWith('08'))).toEqual([]);
  });

  it('out of order: 08 02 / 08 03 / 08 04 before 08 01; 08 02 from the app; 08 01 twice', async () => {
    const { t } = await demo('pro');
    const sent = outs08(t);
    const ticket = await withTimers(t.beginFirmwareSession(makeFw({ crc: CRC.v0100 })));
    await expect(t.fwWrite(ticket)).rejects.toThrow(UnsafeCommandError); // not the bootloader
    await expect(t.fwVerify(ticket)).rejects.toThrow(UnsafeCommandError);
    await expect(t.fwRestart(ticket)).rejects.toThrow(UnsafeCommandError);
    void t.fwEnter(ticket);
    await run(50);
    await expect(t.fwEnter(ticket)).rejects.toThrow(UnsafeCommandError); // once only
    expect(sent.map((f) => f[1])).toEqual([0x01]);
  });

  it('after a failed 08 03: no 08 04; the bootloader of another session (or none) cannot write this one', async () => {
    const { boot, ticket, bus, t } = await attached();
    bus.flags.verifyFail = true;
    await withTimers(boot.fwWrite(ticket));
    expect(await withTimers(boot.fwVerify(ticket))).toBe(false);
    await expect(boot.fwRestart(ticket)).rejects.toThrow(UnsafeCommandError);
    const stranger = new MockBootloader(bus, [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9], 'boot');
    await expect(stranger.fwWrite(ticket)).rejects.toThrow(UnsafeCommandError);
    await expect(t.fwWrite(ticket)).rejects.toThrow(UnsafeCommandError);
    expect(bus.received.filter((r) => r.cmd === '08 04')).toEqual([]);
    expect(bus.violations).toEqual([]);
  });

  it('fwWrite(ticket A) on the bootloader attached to ticket B throws', async () => {
    const a = await attached();
    // a second session on a second demo Pro: its own ticket, never A's bootloader
    const other = new MockTransport({ seed: 'pro', serial: [7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7] });
    const ticketB = await withTimers(other.beginFirmwareSession(makeFw({ crc: CRC.v0100 })));
    await expect(a.boot.fwWrite(ticketB)).rejects.toThrow(UnsafeCommandError);
    expect(a.bus.writes).toEqual([]);
  });

  it('an AE64 Max (board 0030000D) cannot open a session; nor can a file for another board', async () => {
    const { t } = await demo('max');
    const sent = outs08(t);
    await expect(withTimers(t.beginFirmwareSession(makeFw({ crc: CRC.v0100 })))).rejects.toMatchObject({ reason: 'board', board: FW_BOARD_MAX });
    await expect(withTimers(t.beginFirmwareSession(makeFw({ board: FW_BOARD_MAX })))).rejects.toBeInstanceOf(FirmwareSessionError);
    expect(sent).toEqual([]);
  });

  it('a Pro whose 01 02 reports no readable serial (all 00 / all FF) cannot open a session (client check, not only the page)', async () => {
    for (const hex of ['00', 'ff']) {
      const { t } = await demo('pro');
      const sent = outs08(t);
      const real = t.getDeviceInfo.bind(t);
      vi.spyOn(t, 'getDeviceInfo').mockImplementation(async (...a: Parameters<typeof t.getDeviceInfo>) => ({ ...(await real(...a)), serialHex: hex.repeat(12) }));
      await expect(withTimers(t.beginFirmwareSession(makeFw({ crc: CRC.v0100 })))).rejects.toMatchObject({ reason: 'serial' });
      expect(sent).toEqual([]);
    }
  });

  describe('checkFirmwareFrame: every condition', () => {
    const g = (o: Partial<FirmwareGuard> = {}): FirmwareGuard => ({ board: FW_BOARD_PRO, step: 'writing', sender: 'boot', nextOffset: 112, size: 200, ...o });
    const pkt = (off: number, len: number, data = len) => [8, 2, off & 0xff, off >> 8, 0, 0, len & 0xff, len >> 8, ...new Array(data).fill(0x5a)];
    it('accepts exactly the next packet, of the right length and data', () => {
      expect(checkFirmwareFrame(pkt(112, 56), g())).toBeNull();
      expect(checkFirmwareFrame(pkt(168, 32), g({ nextOffset: 168 }))).toBeNull(); // the last, shorter packet
      expect(checkFirmwareFrame([8, 1], g({ step: 'open', sender: 'app' }))).toBeNull();
      expect(checkFirmwareFrame([8, 3], g({ step: 'written' }))).toBeNull();
      expect(checkFirmwareFrame([8, 4], g({ step: 'verified' }))).toBeNull();
    });
    it('refuses each broken condition', () => {
      expect(checkFirmwareFrame([1, 2], g())).not.toBeNull();
      const notFw = pkt(112, 56); notFw[0] = 0x01; // a right 08 02 in every byte but the family
      expect(checkFirmwareFrame(notFw, g())).not.toBeNull();
      expect(checkFirmwareFrame(pkt(112, 56), null)).not.toBeNull();
      expect(checkFirmwareFrame(pkt(112, 56), g({ board: FW_BOARD_MAX }))).not.toBeNull();
      expect(checkFirmwareFrame(pkt(112, 56), g({ step: 'attached' }))).not.toBeNull();
      expect(checkFirmwareFrame(pkt(112, 56), g({ sender: 'app' }))).not.toBeNull();
      expect(checkFirmwareFrame(pkt(112, 56), g({ sender: 'other' }))).not.toBeNull();
      expect(checkFirmwareFrame(pkt(56, 56), g())).not.toBeNull(); // offset behind
      expect(checkFirmwareFrame(pkt(168, 56), g())).not.toBeNull(); // offset ahead
      expect(checkFirmwareFrame(pkt(112, 55), g())).not.toBeNull(); // length short
      expect(checkFirmwareFrame(pkt(168, 56, 56), g({ nextOffset: 168 }))).not.toBeNull(); // past the end of the file
      expect(checkFirmwareFrame(pkt(112, 56, 55), g())).not.toBeNull(); // data shorter than the length
      expect(checkFirmwareFrame(pkt(112, 56, 57), g())).not.toBeNull(); // data longer
      expect(checkFirmwareFrame(pkt(200, 0, 0), g({ nextOffset: 200 }))).not.toBeNull(); // nothing left
      expect(checkFirmwareFrame([8, 1], g({ step: 'open', sender: 'boot' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 1], g({ step: 'entered', sender: 'app' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 1, 0], g({ step: 'open', sender: 'app' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 3], g({ step: 'writing' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 3], g({ step: 'written', sender: 'app' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 4], g({ step: 'written' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 4], g({ step: 'verifyFail' }))).not.toBeNull();
      expect(checkFirmwareFrame([8, 4], g({ step: 'verified', sender: 'app' }))).not.toBeNull();
      for (const c of [0, 5, 6, 0x7f, 0x80, 0xff]) expect(checkFirmwareFrame([8, c], g({ step: 'verified' }))).not.toBeNull();
    });
  });

  it('only client.ts builds a family-08 frame (code scan of src/**)', () => {
    // A frame of family 08 is recognised as: an array literal whose first element is 8 / 0x08 / FIRMWARE_FAMILY / FAMILY.<…FW…>;
    // `[0] = 8` (or 0x08 / FIRMWARE_FAMILY); `Uint8Array.of(8, …)`; any use of FIRMWARE_FAMILY (the constant is defined in
    // constants.ts). The fake bootloader's replies (`reply = [0x08, …]` in mockFirmware.ts) are answers, not frames sent.
    const HEAD = /(?<![\w\])$.])\[\s*(?:0x0*8|0*8|FIRMWARE_FAMILY|FAMILY\.\w*(?:FW|FIRM)\w*)\s*[,\]]/; // a literal, not an index (d[8])
    const AT0 = /\[\s*0\s*\]\s*=\s*(?:0x0*8|0*8|FIRMWARE_FAMILY)\b/;
    const OF = /\.of\(\s*(?:0x0*8|0*8|FIRMWARE_FAMILY)\s*[,)]/;
    const NAME = /\bFIRMWARE_FAMILY\b/;
    const REPLY = /^\s*(?:if \([^)]*\) \{ )?reply = \[0x08, /;
    const root = resolve('src');
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|vue|js|mjs)$/.test(e.name)) files.push(p);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const f of files) {
      const rel = f.slice(root.length + 1).replace(/\\/g, '/');
      if (rel === 'protocol/client.ts') continue;
      // CRLF or LF (a Git for Windows checkout is CRLF): `.` does not match `\r`, so a comment would not be stripped
      readFileSync(f, 'utf8').split(/\r?\n/).forEach((line, i) => {
        const code = line.replace(/\/\/.*$/, '');
        const head = HEAD.test(code) || AT0.test(code) || OF.test(code);
        const name = NAME.test(code) && !(rel === 'protocol/constants.ts' && /export const FIRMWARE_FAMILY = 0x08;/.test(code));
        if ((head && !(rel === 'protocol/mockFirmware.ts' && REPLY.test(code))) || name) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
    // the scanner itself: each way of building 08 elsewhere is caught
    for (const bad of ['t.raw([8, 2, 0])', 'frame[0] = 0x08;', 'Uint8Array.of(8, 1)', 'send([FIRMWARE_FAMILY, 1])', 'x = [0x8, 4]', 'p = [FAMILY.FW, 1]']) {
      expect(HEAD.test(bad) || AT0.test(bad) || OF.test(bad) || NAME.test(bad), bad).toBe(true);
    }
    for (const fine of ['const s = reply[8];', 'mode: d[8] };', 'x = arr[0x08]', 'f(a)[8]']) expect(HEAD.test(fine) || AT0.test(fine), fine).toBe(false);
    expect(REPLY.test('      reply = [0x08, 0x03, this.verified ? 1 : 0];')).toBe(true);
    // a CRLF file: split as above, the comment is stripped and a real frame is still caught
    const lines = 'const status = d[3]; // [8] status\r\nt.raw([8, 2])\r\nx = 1;\r\n'.split(/\r?\n/);
    expect(lines.some((l) => l.endsWith('\r'))).toBe(false);
    const hit = (l: string) => { const c = l.replace(/\/\/.*$/, ''); return HEAD.test(c) || AT0.test(c) || OF.test(c); };
    expect(lines.map(hit)).toEqual([false, true, false, false]);
    // what split('\n') left: the `\r` kept the comment in the code
    expect(hit('// [8] status\r')).toBe(true);
    expect(hit('// [8] status')).toBe(false);
  });
});

describe('a keyboard that is not running its app gets only 01 02', () => {
  it('01 02 reported run mode 255 on this connection: every other command is refused before it is sent', async () => {
    const { bus } = await demo('pro');
    const b = new MockBootloader(bus, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 'boot');
    const sent: number[][] = [];
    b.onPacketRaw((dir, x) => { if (dir === 'out') sent.push([x[0], x[1]]); });
    const info = await withTimers(b.getDeviceInfo());
    expect(info.runMode).toBe(255);
    expect(b.runModeSeen).toBe(255);
    await expect(b.getProtocolVersion()).rejects.toThrow(UnsafeCommandError);
    await expect(b.raw([1, 1])).rejects.toThrow(UnsafeCommandError);
    expect(sent).toEqual([[1, 2]]);
    expect(bus.violations).toEqual([]);
  });
  it('after 08 01 the app connection sends only 01 02', async () => {
    const { t } = await demo('pro');
    const ticket = await withTimers(t.beginFirmwareSession(makeFw({ crc: CRC.v0100 })));
    void t.fwEnter(ticket);
    await run(10);
    await expect(t.getProtocolVersion()).rejects.toThrow(UnsafeCommandError);
    const info = withTimers(t.getDeviceInfo()).then(() => 'answered', (e: unknown) => (e instanceof UnsafeCommandError ? 'refused' : 'failed'));
    expect(await info).not.toBe('refused'); // 01 02 may go (the app left USB, so it fails otherwise)
  });
});
