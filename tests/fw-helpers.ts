// Helpers of the firmware tests (DESIGN FW §11). Synthetic files only: no firmware byte of a real file is in the repo. A file
// can be given the CRC-32 of a known build (its last 4 payload bytes are solved for it), so the "known build" branches run
// without the real files; the real ones are read through AE64_FW_DIR (fw-real.test.ts).
import { vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { FW_BOARD_PRO, FW_HEADER_BYTES, fwCrc32 } from '../src/protocol/firmware';
import type { MockTransport } from '../src/protocol/mock';
import type { DemoSeed } from '../src/protocol/mock';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
const BY_TOP = new Map([...TABLE].map((v, i) => [v >>> 24, i]));

/** The 4 bytes that, appended to `data`, give the CRC-32 `target` (CRC-32 is invertible over its last 4 bytes). */
export function crcTail(data: Uint8Array, target: number): number[] {
  let s = (~target) >>> 0;
  const idx: number[] = [];
  for (let k = 3; k >= 0; k--) {
    const i = BY_TOP.get(s >>> 24)!;
    idx[k] = i;
    s = ((s ^ TABLE[i]) << 8) >>> 0;
  }
  let r = (~fwCrc32(data)) >>> 0;
  return idx.map((i) => {
    const x = (r ^ i) & 0xff;
    r = ((r >>> 8) ^ TABLE[i]) >>> 0;
    return x;
  });
}

const le32 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff; };

/** A file with a right header: signature, board, offset 0x1000, payload length and CRC; payload from a fixed seed. */
export function makeFw(o: { size?: number; board?: number; crc?: number; seed?: number } = {}): Uint8Array {
  const size = o.size ?? 118_776;
  const b = new Uint8Array(size);
  b.set([0xa5, 0x5a, 0xaf, 0xbe], 0);
  le32(b, 4, o.board ?? FW_BOARD_PRO);
  le32(b, 8, FW_HEADER_BYTES);
  le32(b, 12, size - FW_HEADER_BYTES);
  let x = (o.seed ?? 1) >>> 0 || 1;
  for (let i = FW_HEADER_BYTES; i < size; i++) {
    x ^= x << 13; x >>>= 0; x ^= x >>> 17; x ^= x << 5; x >>>= 0;
    b[i] = x & 0xff;
  }
  if (o.crc !== undefined) b.set(crcTail(b.subarray(FW_HEADER_BYTES, size - 4), o.crc), size - 4);
  le32(b, 16, fwCrc32(b, FW_HEADER_BYTES, size));
  return b;
}

/** CRC-32 of the known builds (KNOWN_FW): a synthetic file with one of them is taken for that build. */
export const CRC = {
  v0100: 0xe7e8a423, v0080: 0xae146e4d, v0070: 0x157ec1ea, v0060: 0x518247de, v0050: 0x872a56bd,
  xinput081: 0x9d0c07b0, xinput08: 0x497b6355,
} as const;

/** A File as the page gets it (name, size, bytes). */
export function fileOf(bytes: Uint8Array, name = 'fw.bin'): File {
  const copy = bytes.slice();
  return { name, size: copy.length, arrayBuffer: async () => copy.buffer } as unknown as File;
}

export const FAKE = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const };

/** A demo keyboard (real timers while it connects), then fake timers. `t.fwMock` is its USB bus. */
export async function demo(seed: DemoSeed = 'pro') {
  vi.useRealTimers();
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(seed);
  const t = device.transport as MockTransport;
  const bus = (t.fwMock ?? null) as MockFwBus; // an AE64 Max has none
  const fw = useFirmwareStore();
  if (bus) bus.received.length = 0; // the connection's own init is not part of a test
  vi.useFakeTimers({ toFake: [...FAKE.toFake] });
  return { device, t, bus, fw };
}

export const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/** Commands the bus saw, as "dev cmd" strings, `08 02` collapsed to one entry with its count. */
export function seq(bus: MockFwBus): string[] {
  const out: string[] = [];
  let n = 0;
  for (const r of bus.received) {
    const s = `${r.dev} ${r.cmd}`;
    if (r.cmd === '08 02') { n++; continue; }
    if (n) { out.push(`${r.dev} 08 02 ×${n}`); n = 0; }
    out.push(s);
  }
  if (n) out.push(`boot 08 02 ×${n}`);
  return out;
}

/** Choose `bytes`, type the confirmation (and the risk box when asked), press start. */
export async function startWith(fw: ReturnType<typeof useFirmwareStore>, bytes: Uint8Array, opts: { risk?: boolean } = {}) {
  await fw.chooseFile(fileOf(bytes));
  fw.typed = 'AE64 Pro';
  if (opts.risk ?? fw.needsRisk) fw.riskOk = true;
  const started = fw.start();
  await run(0);
  return { started };
}
