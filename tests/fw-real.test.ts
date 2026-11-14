// DESIGN FW §11 tests 1 (the real files) and 13 (byte compare, M3). The seven firmware files are read from the folder named by
// the environment variable AE64_FW_DIR; without it every test here is skipped. No path of the user's machine and no firmware
// byte is in the repo: the fixture below holds only numbers (CRC-32, sizes, packet counts, SHA-256 of the packet stream).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FW_BOARD_PRO, KNOWN_FW, checkFile, chunkCount, crcHex, fwCrc32, FW_HEADER_BYTES } from '../src/protocol/firmware';
import { demo, run, seq, startWith } from './fw-helpers';

const DIR = process.env.AE64_FW_DIR ?? '';

/** The real files, keyed by the CRC-32 of their payload (KNOWN_FW), with what they must be identified as. */
const REAL = [
  { crc: 'e7e8a423', size: 118_776, kind: 'official', version: '0.1.0.0', appVersion: '0.1.0.0', gamepad: null, packets: 2121, sha: '65d4dc06ff06decf4ed2a7de39e13eef8cdcd5bd901f560752b95ec95ab7e3e6' },
  { crc: 'ae146e4d', size: 118_232, kind: 'official', version: '0.0.8.0', appVersion: '0.0.8.0', gamepad: null, packets: 2112, sha: '03e65ac1d94c029e2a51bc919bbad2b03a02e6a8d14ddcae3d2bf3322dcbd484' },
  { crc: '157ec1ea', size: 116_992, kind: 'official', version: '0.0.7.0', appVersion: '0.0.7.0', gamepad: null, packets: 2090, sha: 'a907207a82ff127787533d86c97c90667f1f400354500f224daf2a0e98b3d20b' },
  { crc: '518247de', size: 116_608, kind: 'official', version: '0.0.6.0', appVersion: '0.0.6.0', gamepad: null, packets: 2083, sha: '61eb3c63f1c8d7c686f989db58a446600c0f96cb0d73f144f863d0d842be2308' },
  { crc: '872a56bd', size: 116_464, kind: 'official', version: '0.0.5.0', appVersion: '0.0.5.0', gamepad: null, packets: 2080, sha: '817f57a75092c046270378681134e7853570a9bfc5831a8ce1072682ed222c72' },
  { crc: '9d0c07b0', size: 143_696, kind: 'third', version: '0.8.1', appVersion: '0.1.0.0', gamepad: { agp: 1, caps: 30 }, packets: 2566, sha: null },
  { crc: '497b6355', size: 142_888, kind: 'third', version: '0.8', appVersion: '0.1.0.0', gamepad: { agp: 1, caps: null }, packets: 2552, sha: null },
] as const;

function readAll(): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const e of readdirSync(DIR, { withFileTypes: true }).filter((x) => x.isFile() && x.name.toLowerCase().endsWith('.bin'))) {
    const text = readFileSync(join(DIR, e.name), 'latin1'); // one char per byte
    const b = Uint8Array.from(text, (c) => c.charCodeAt(0));
    out.set(crcHex(fwCrc32(b, FW_HEADER_BYTES)), b);
  }
  return out;
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.skipIf(!DIR)('real firmware files (AE64_FW_DIR)', { timeout: 120_000 }, () => {
  it('1. the seven files: five ✓ each, identified as the right build (version, appVersion, gamepad)', () => {
    const files = readAll();
    expect([...files.keys()].sort()).toEqual(REAL.map((r) => r.crc).sort());
    expect(KNOWN_FW.map((k) => crcHex(k.crc)).sort()).toEqual(REAL.map((r) => r.crc).sort());
    for (const r of REAL) {
      const b = files.get(r.crc)!;
      expect(b.length, r.crc).toBe(r.size);
      expect(chunkCount(b.length), r.crc).toBe(r.packets);
      const c = checkFile(b, FW_BOARD_PRO);
      expect(c.lines.map((l) => `${l.key}:${l.ok}`), r.crc).toEqual(['sig:true', 'board:true', 'len:true', 'crc:true', 'size:true']);
      expect(c.ok).toBe(true);
      expect(c.known, r.crc).not.toBeNull();
      const k = c.known!;
      expect({ kind: k.kind, version: k.version, appVersion: k.appVersion, gamepad: k.gamepad }, r.crc)
        .toEqual({ kind: r.kind, version: r.version, appVersion: r.appVersion, gamepad: r.gamepad });
      // an AE64 Max board refuses every one of them
      expect(checkFile(b, 0x0030000d).lines.find((l) => l.key === 'board')!.ok).toBe(false);
    }
  });

  it.each(REAL.filter((r) => r.sha))('13. $version: the 08 02 frames the mock got (64 B each) hash to the vendor reference; order of P06', async (r) => {
    const b = readAll().get(r.crc)!;
    const s = await demo('pro');
    await startWith(s.fw, b);
    let ms = 0;
    while (s.fw.active && ms < 60_000) { await run(250); ms += 250; }
    expect(s.fw.phase).toBe('done');
    expect(s.fw.doneVersion).toBe(r.version);
    expect(s.bus.writes.length).toBe(r.packets);
    expect(s.bus.writes.every((w) => w.length === 64)).toBe(true);
    const stream = new Uint8Array(s.bus.writes.length * 64);
    s.bus.writes.forEach((w, i) => stream.set(w, i * 64));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', stream));
    expect([...digest].map((x) => x.toString(16).padStart(2, '0')).join('')).toBe(r.sha);
    // P06: DeviceInfo, AppToBoot, DeviceInfo on the bootloader, the whole file in 56-byte packets, validate, BootToApp, find
    expect(seq(s.bus).slice(0, 7)).toEqual(['app 01 02', 'app 08 01', 'boot 01 02', `boot 08 02 ×${r.packets}`, 'boot 08 03', 'boot 08 04', 'app 01 02']);
    expect(s.bus.violations).toEqual([]);
  });
});
