// Firmware files for the AE64 Pro (DESIGN FW §3.2): header parse, the five checks, the table of known builds and the 56-byte
// chunks of `08 02`. Pure functions: nothing is sent and no frame is built here (only client.ts builds family 08, §3.5).
//
// Header (measured on all 7 reference files): bytes 0–3 A5 5A AF BE; LE32 at 4 = board; LE32 at 8 = 0x1000 (payload offset);
// LE32 at 12 = payload length; LE32 at 16 = CRC-32 (IEEE, as zlib) of the payload; 20–4095 zero. The payload starts at 4096.

export const FW_SIGNATURE: readonly number[] = Object.freeze([0xa5, 0x5a, 0xaf, 0xbe]);
export const FW_HEADER_BYTES = 0x1000;
/** Whole file at most 256 KiB: `08 02` offsets count from the start of the file, and `08 01` copies 256 KiB (DESIGN FW §3.2). */
export const FW_MAX_FILE = 262_144;
/** Data bytes per `08 02` packet (64-byte report: 08 02, LE32 offset, LE16 length, up to 56 bytes). */
export const FW_CHUNK = 56;
/** The only board this app writes firmware to: AE64 Pro. Compared as a number everywhere. */
export const FW_BOARD_PRO = 0x0030000a;
export const FW_BOARD_MAX = 0x0030000d;

export interface FwHeader {
  sig: boolean;
  /** LE32 at byte 4. */
  board: number;
  offset: number;
  length: number;
  crc: number;
}

export interface KnownFw {
  crc: number;
  name: string;
  /** Shown to the user ("0.8.1"). */
  version: string;
  kind: 'official' | 'third';
  /** What `01 02` must report once the keyboard runs it ("0.1.0.0"). */
  appVersion: string;
  /** null: INFO must answer `10 FF` (no gamepad firmware); otherwise the AGP1 version and caps INFO must show (caps null = not checked). */
  gamepad: null | { agp: number; caps: number | null };
}

export type FwCheckKey = 'sig' | 'board' | 'len' | 'crc' | 'size';
export interface FwCheck {
  header: FwHeader;
  ok: boolean;
  lines: { key: FwCheckKey; ok: boolean }[];
  known: KnownFw | null;
  /** CRC-32 computed over the payload (bytes 4096…). */
  crc: number;
  size: number;
}

/** Known builds by payload CRC-32 (DESIGN FW §3.2). Numbers only: no firmware byte is in the app. */
const KNOWN_LIST: KnownFw[] = [
  { crc: 0xe7e8a423, name: 'AE64 Pro App', version: '0.1.0.0', kind: 'official', appVersion: '0.1.0.0', gamepad: null },
  { crc: 0xae146e4d, name: 'AE64 Pro App', version: '0.0.8.0', kind: 'official', appVersion: '0.0.8.0', gamepad: null },
  { crc: 0x157ec1ea, name: 'AE64 Pro App', version: '0.0.7.0', kind: 'official', appVersion: '0.0.7.0', gamepad: null },
  { crc: 0x518247de, name: 'AE64 Pro App', version: '0.0.6.0', kind: 'official', appVersion: '0.0.6.0', gamepad: null },
  { crc: 0x872a56bd, name: 'AE64 Pro App', version: '0.0.5.0', kind: 'official', appVersion: '0.0.5.0', gamepad: null },
  { crc: 0x9d0c07b0, name: 'AE64 Pro XInput (FnRGB)', version: '0.8.1', kind: 'third', appVersion: '0.1.0.0', gamepad: { agp: 1, caps: 30 } },
  { crc: 0x497b6355, name: 'AE64 Pro XInput (FnRGB)', version: '0.8', kind: 'third', appVersion: '0.1.0.0', gamepad: { agp: 1, caps: null } },
];
export const KNOWN_FW: readonly Readonly<KnownFw>[] = Object.freeze(KNOWN_LIST.map((k) => Object.freeze(k)));

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE 802.3, as zlib's crc32) of bytes [start, end). */
export function fwCrc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const le32 = (b: Uint8Array, o: number): number => (o + 3 < b.length ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : 0);

/** The first 32 bytes, little-endian. A file shorter than that reads as zeros there (and fails the checks). */
export function parseHeader(buf: Uint8Array): FwHeader {
  return {
    sig: FW_SIGNATURE.every((b, i) => buf[i] === b),
    board: le32(buf, 4),
    offset: le32(buf, 8),
    length: le32(buf, 12),
    crc: le32(buf, 16),
  };
}

export const knownFw = (crc: number): KnownFw | null => KNOWN_FW.find((k) => k.crc === crc >>> 0) ?? null;

/**
 * The five checks of DESIGN FW §3.2, all against numbers: signature, board in the file (LE) = board of the keyboard (`01 02`
 * reports it big-endian; both are numbers here), length + offset, CRC-32 of the payload, whole file ≤ 262 144 bytes.
 * `deviceBoard` null (unknown): the board line fails.
 */
export function checkFile(buf: Uint8Array, deviceBoard: number | null): FwCheck {
  const header = parseHeader(buf);
  const size = buf.length;
  const payloadOk = size > FW_HEADER_BYTES;
  const crc = payloadOk ? fwCrc32(buf, FW_HEADER_BYTES) : 0;
  const lines: FwCheck['lines'] = [
    { key: 'sig', ok: header.sig },
    { key: 'board', ok: deviceBoard !== null && header.board === deviceBoard >>> 0 },
    { key: 'len', ok: payloadOk && header.offset === FW_HEADER_BYTES && header.length === size - FW_HEADER_BYTES },
    { key: 'crc', ok: payloadOk && crc === header.crc },
    { key: 'size', ok: size <= FW_MAX_FILE },
  ];
  const ok = lines.every((l) => l.ok);
  return { header, ok, lines, known: ok ? knownFw(crc) : null, crc, size };
}

/** The `08 02` chunks: the whole file from offset 0 (the 4096-byte header too), 56 bytes each, the last one shorter. */
export function chunks(buf: Uint8Array): { offset: number; data: Uint8Array }[] {
  const out: { offset: number; data: Uint8Array }[] = [];
  for (let o = 0; o < buf.length; o += FW_CHUNK) out.push({ offset: o, data: buf.subarray(o, Math.min(o + FW_CHUNK, buf.length)) });
  return out;
}

export const chunkCount = (size: number): number => Math.ceil(size / FW_CHUNK);

/** A serial (`serialHex` of `01 02`) the keyboard really reports: 24 hex digits, not all 00 and not all FF. */
export function serialReadable(serialHex: string | null | undefined): serialHex is string {
  return !!serialHex && /^[0-9a-f]{24}$/.test(serialHex) && !/^(00)+$/.test(serialHex) && !/^(ff)+$/.test(serialHex);
}

/** Board as shown to people: 8 upper-case hex digits. */
export const boardHex = (board: number): string => (board >>> 0).toString(16).toUpperCase().padStart(8, '0');
export const crcHex = (crc: number): string => (crc >>> 0).toString(16).padStart(8, '0');
