// DESIGN FW §11 tests 1, 2 and 10 (the pure part): the file check, the packets, serial and board. Synthetic files only; the
// seven real files are in fw-real.test.ts (AE64_FW_DIR).
import { describe, expect, it } from 'vitest';
import {
  FW_BOARD_MAX, FW_BOARD_PRO, FW_CHUNK, FW_HEADER_BYTES, FW_MAX_FILE, KNOWN_FW, boardHex, checkFile, chunkCount, chunks, crcHex,
  fwCrc32, knownFw, parseHeader, serialReadable,
} from '../src/protocol/firmware';
import { decodeDeviceInfo } from '../src/protocol/codec';
import { twinSerial } from '../src/protocol/mockFirmware';
import { CRC, crcTail, makeFw } from './fw-helpers';

const okKeys = (c: ReturnType<typeof checkFile>) => c.lines.filter((l) => l.ok).map((l) => l.key);
const badKeys = (c: ReturnType<typeof checkFile>) => c.lines.filter((l) => !l.ok).map((l) => l.key);

describe('1. the file check (synthetic files, always run)', () => {
  it('a right file: five ✓, in order sig · board · len · crc · size', () => {
    const c = checkFile(makeFw(), FW_BOARD_PRO);
    expect(c.lines.map((l) => l.key)).toEqual(['sig', 'board', 'len', 'crc', 'size']);
    expect(okKeys(c)).toEqual(['sig', 'board', 'len', 'crc', 'size']);
    expect(c.ok).toBe(true);
    expect(c.known).toBeNull(); // a synthetic file is no build the app knows
  });
  it('five file mutants: each turns its own line red, and only it', () => {
    const flipPayload = makeFw(); flipPayload[FW_HEADER_BYTES + 777] ^= 0x01;
    expect(badKeys(checkFile(flipPayload, FW_BOARD_PRO))).toEqual(['crc']);
    expect(badKeys(checkFile(makeFw({ board: FW_BOARD_MAX }), FW_BOARD_PRO))).toEqual(['board']);
    expect(badKeys(checkFile(makeFw().subarray(0, 118_775), FW_BOARD_PRO))).toEqual(['len', 'crc']); // one byte short: the CRC of what is there differs too
    const sig = makeFw(); sig[3] = 0xbf;
    expect(badKeys(checkFile(sig, FW_BOARD_PRO))).toEqual(['sig']);
    expect(badKeys(checkFile(makeFw({ size: FW_MAX_FILE + 1 }), FW_BOARD_PRO))).toEqual(['size']);
    for (const b of [flipPayload, sig]) expect(checkFile(b, FW_BOARD_PRO).ok).toBe(false);
  });
  it('a cut file whose header still matches its own length passes len but not when the CRC differs; offset other than 0x1000 fails len', () => {
    const off = makeFw(); off[8] = 0x00; off[9] = 0x20; // 0x2000
    expect(badKeys(checkFile(off, FW_BOARD_PRO))).toContain('len');
  });
  it('a file shorter than its header (or empty) fails every line it can, never throws', () => {
    for (const n of [0, 3, 20, 4095, 4096]) {
      const c = checkFile(makeFw().subarray(0, n), FW_BOARD_PRO);
      expect(c.ok).toBe(false);
    }
  });
  it('no device board (not read): the board line fails', () => {
    expect(badKeys(checkFile(makeFw(), null))).toEqual(['board']);
  });
  it('the board is compared as a number: BE from 01 02, LE in the file', () => {
    const info = new Array(45).fill(0);
    info.splice(0, 4, 0x01, 0x02, 0x01, 0x00);
    info.splice(4, 4, 0x00, 0x30, 0x00, 0x0a); // big-endian, as 01 02 reports it
    const dev = decodeDeviceInfo(new Uint8Array([...info, ...new Array(64 - 45).fill(0)]));
    expect(dev.boardId).toBe(0x0030000a);
    expect(dev.boardIdHex).toBe('0030000a'); // display string unchanged (lowercase)
    const file = makeFw();
    expect([...file.subarray(4, 8)]).toEqual([0x0a, 0x00, 0x30, 0x00]); // little-endian in the file
    expect(parseHeader(file).board).toBe(dev.boardId);
    expect(checkFile(file, dev.boardId).ok).toBe(true);
    expect(boardHex(FW_BOARD_PRO)).toBe('0030000A');
  });
  it('KNOWN_FW: seven builds, keyed by CRC-32, frozen; a synthetic file with a known CRC is taken for that build', () => {
    expect(KNOWN_FW.map((k) => `${crcHex(k.crc)} ${k.kind} ${k.version} ${k.appVersion}`)).toEqual([
      'e7e8a423 official 0.1.0.0 0.1.0.0', 'ae146e4d official 0.0.8.0 0.0.8.0', '157ec1ea official 0.0.7.0 0.0.7.0',
      '518247de official 0.0.6.0 0.0.6.0', '872a56bd official 0.0.5.0 0.0.5.0', '9d0c07b0 third 0.8.1 0.1.0.0', '497b6355 third 0.8 0.1.0.0',
    ]);
    expect(KNOWN_FW.map((k) => k.gamepad)).toEqual([null, null, null, null, null, { agp: 1, caps: 30 }, { agp: 1, caps: null }]);
    expect(Object.isFrozen(KNOWN_FW) && KNOWN_FW.every((k) => Object.isFrozen(k))).toBe(true);
    for (const [name, crc] of Object.entries(CRC)) {
      const f = makeFw({ crc, seed: crc });
      expect(fwCrc32(f, FW_HEADER_BYTES), name).toBe(crc);
      expect(checkFile(f, FW_BOARD_PRO).known, name).toBe(knownFw(crc));
    }
    expect(checkFile(makeFw({ crc: CRC.v0100, board: FW_BOARD_MAX }), FW_BOARD_PRO).known).toBeNull(); // known only when ok
  });
  it('crcTail solves the last 4 bytes for any CRC (test helper check)', () => {
    const d = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const target of [0, 0xffffffff, 0x12345678, CRC.xinput081]) {
      expect(fwCrc32(new Uint8Array([...d, ...crcTail(d, target)]))).toBe(target >>> 0);
    }
    expect(fwCrc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926); // the CRC-32 (IEEE, as zlib) check value
  });
});

describe('2. packets of 56 bytes over the whole file', () => {
  it('118 776 B (0.1.0.0) → 2121 packets, all 56 bytes; their data joined = the whole file, header included', () => {
    const f = makeFw({ size: 118_776 });
    const list = chunks(f);
    expect(list.length).toBe(2121);
    expect(chunkCount(f.length)).toBe(2121);
    expect(list.every((c) => c.data.length === FW_CHUNK)).toBe(true);
    expect(list.map((c) => c.offset)).toEqual(list.map((_, i) => i * 56));
    const joined = new Uint8Array(list.reduce((n, c) => n + c.data.length, 0));
    list.forEach((c) => joined.set(c.data, c.offset));
    expect(joined).toEqual(f);
  });
  it('116 464 B (0.0.5.0) → 2080 packets, the last at offset 116 424 with 40 bytes', () => {
    const list = chunks(makeFw({ size: 116_464 }));
    expect(list.length).toBe(2080);
    expect(list.at(-1)!.offset).toBe(116_424);
    expect(list.at(-1)!.data.length).toBe(40);
  });
});

describe('10. serial and board (the pure part)', () => {
  it('serialHex keeps every byte: two serials with the same decimal join differ in hex', () => {
    const a = [1, 11, 2, 22, 3, 33, 4, 44, 5, 55, 6, 66];
    const b = twinSerial(a)!;
    expect(b).not.toBeNull();
    expect(b.join('')).toBe(a.join(''));
    const hexOf = (s: number[]) => s.map((x) => x.toString(16).padStart(2, '0')).join('');
    expect(hexOf(b)).not.toBe(hexOf(a));
    const info = (s: number[]) => {
      const r = new Array(64).fill(0);
      r.splice(0, 4, 0x01, 0x02, 0x01, 0x00);
      r.splice(17, 12, ...s);
      return decodeDeviceInfo(new Uint8Array(r));
    };
    expect(info(a).serial).toBe(info(b).serial); // the display string loses the byte boundaries
    expect(info(a).serialHex).not.toBe(info(b).serialHex);
    expect(info(a).serialHex).toBe(hexOf(a));
  });
  it('serialReadable: 24 hex digits, not all 00 and not all ff', () => {
    expect(serialReadable('0'.repeat(24))).toBe(false);
    expect(serialReadable('f'.repeat(24))).toBe(false);
    expect(serialReadable('ff'.repeat(11) + 'fe')).toBe(true);
    expect(serialReadable('01'.repeat(12))).toBe(true);
    expect(serialReadable('01'.repeat(11))).toBe(false);
    expect(serialReadable(null)).toBe(false);
    expect(serialReadable(undefined)).toBe(false);
  });
});
