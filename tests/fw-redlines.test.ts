// DESIGN OFU v1.8 §9 "The header lines" (review P3-4): a red len or crc line says what differs, with both values, and no red
// check line ever says "khớp" / "matches". Synthetic files only (no firmware byte), demo keyboards only (no HID device), a fake
// fetch for the online source.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import FwFileStep from '../src/components/firmware/FwFileStep.vue';
import { FW_BOARD_MAX, FW_HEADER_BYTES, crcHex, fwCrc32 } from '../src/protocol/firmware';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockTransport } from '../src/protocol/mock';
import type { DemoSeed } from '../src/protocol/mock';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { locale } from '../src/i18n/locale';
import { CRC, fileOf, makeFw } from './fw-helpers';

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const le32 = (b: Uint8Array, at: number, v: number) => { b[at] = v & 0xff; b[at + 1] = (v >>> 8) & 0xff; b[at + 2] = (v >>> 16) & 0xff; b[at + 3] = (v >>> 24) & 0xff; };

/** The four broken files of §9, from one good file (118 776 bytes: a 4 096-byte header and 114 680 bytes of firmware). */
function broken(good: Uint8Array) {
  const cut = good.slice(0, 100_000);
  const offset = good.slice();
  le32(offset, 8, 8192);
  const flipped = good.slice();
  flipped[5000] ^= 1;
  const headerOnly = good.slice(0, FW_HEADER_BYTES);
  return { cut, offset, flipped, headerOnly };
}
const PRO = makeFw({ crc: CRC.v0100, seed: 21 });
const MAX = makeFw({ crc: CRC.max0040, board: FW_BOARD_MAX, pad: 0xff, seed: 22 });
const hdr = (b: Uint8Array) => crcHex(fwCrc32(b, FW_HEADER_BYTES)); // the file's own CRC-32 of its firmware part

let wrappers: VueWrapper[] = [];
beforeEach(() => { locale.value = 'vi'; });
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  locale.value = 'vi';
});

async function setup(seed: DemoSeed) {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(seed);
  const fw = useFirmwareStore();
  fw.setEnabled(true);
  return { device, fw, t: device.transport as MockTransport };
}
/** The step's check lines as the page shows them: [class, text]. */
async function linesOf(): Promise<[string, string][]> {
  const w = mount(FwFileStep, { attachTo: document.body });
  wrappers.push(w);
  await flushPromises();
  const out = w.findAll('.fw-chk li').map((l) => [l.classes().find((c) => c === 'ok' || c === 'bad' || c === 'warn') ?? '', l.text()] as [string, string]);
  w.unmount();
  wrappers = wrappers.filter((x) => x !== w);
  return out;
}
const bad = (ls: [string, string][]) => ls.filter(([c]) => c === 'bad').map(([, t]) => t);
const line = (ls: [string, string][], start: string) => ls.find(([, t]) => t.startsWith(start));

describe('OFU v1.8 §9: the red header lines say what differs (local file, vi and en)', () => {
  it('a cut file: length "file 95.904 byte, đầu file 114.680 byte" and the CRC-32 of both (mutants 26, 27)', async () => {
    const s = await setup('pro');
    const f = broken(PRO).cut;
    s.fw.setSource('local');
    await s.fw.chooseFile(fileOf(f));
    let ls = await linesOf();
    expect(bad(ls)).toEqual([
      'Độ dài phần firmware khác đầu file: file 95.904 byte, đầu file 114.680 byte',
      `CRC-32 khác đầu file: file ${hdr(f)}, đầu file ${crcHex(fwCrc32(PRO, FW_HEADER_BYTES))}`,
    ]);
    expect(hdr(f)).not.toBe(crcHex(fwCrc32(PRO, FW_HEADER_BYTES)));
    locale.value = 'en';
    ls = await linesOf();
    expect(bad(ls)).toEqual([
      'Firmware length differs from the header: file 95,904 bytes, header 114,680 bytes',
      `CRC-32 differs from the header: file ${hdr(f)}, header ${crcHex(fwCrc32(PRO, FW_HEADER_BYTES))}`,
    ]);
  });

  it('an offset other than 4096: the offset line, not two equal lengths (mutant 28); the CRC-32 line stays green', async () => {
    const s = await setup('pro');
    s.fw.setSource('local');
    await s.fw.chooseFile(fileOf(broken(PRO).offset));
    let ls = await linesOf();
    expect(bad(ls)).toEqual(['Đầu file ghi phần firmware bắt đầu ở byte 8.192, không phải 4.096']);
    expect(line(ls, 'CRC-32')).toEqual(['ok', `CRC-32 khớp đầu file (${crcHex(fwCrc32(PRO, FW_HEADER_BYTES))})`]);
    locale.value = 'en';
    ls = await linesOf();
    expect(bad(ls)).toEqual(['The header puts the firmware at byte 8,192, not 4,096']);
  });

  it('a flipped firmware byte: only the CRC-32 line is red, with the computed CRC and the header\'s; the length line stays green', async () => {
    const s = await setup('pro');
    const f = broken(PRO).flipped;
    s.fw.setSource('local');
    await s.fw.chooseFile(fileOf(f));
    let ls = await linesOf();
    expect(bad(ls)).toEqual([`CRC-32 khác đầu file: file ${hdr(f)}, đầu file ${crcHex(fwCrc32(PRO, FW_HEADER_BYTES))}`]);
    expect(line(ls, 'Độ dài')).toEqual(['ok', 'Độ dài phần firmware khớp đầu file (114.680 byte)']);
    locale.value = 'en';
    ls = await linesOf();
    expect(bad(ls)).toEqual([`CRC-32 differs from the header: file ${hdr(f)}, header ${crcHex(fwCrc32(PRO, FW_HEADER_BYTES))}`]);
    expect(line(ls, 'Firmware length')).toEqual(['ok', 'Firmware length matches the header (114,680 bytes)']);
  });

  it('a header-only file: length "file 0 byte", and the CRC-32 line says there is nothing after the header (mutant 29)', async () => {
    const s = await setup('pro');
    s.fw.setSource('local');
    await s.fw.chooseFile(fileOf(broken(PRO).headerOnly));
    let ls = await linesOf();
    expect(bad(ls)).toEqual([
      'Độ dài phần firmware khác đầu file: file 0 byte, đầu file 114.680 byte',
      'CRC-32: file không có gì sau 4.096 byte đầu',
    ]);
    locale.value = 'en';
    ls = await linesOf();
    expect(bad(ls)).toEqual([
      'Firmware length differs from the header: file 0 bytes, header 114,680 bytes',
      'CRC-32: the file has nothing after its 4,096-byte header',
    ]);
  });

  it('a good file: the green lines are unchanged (signature, board, length, CRC-32, size)', async () => {
    const s = await setup('pro');
    s.fw.setSource('local');
    await s.fw.chooseFile(fileOf(PRO));
    const ls = await linesOf();
    expect(ls.filter(([c]) => c !== 'ok')).toEqual([]);
    expect(ls.map(([, t]) => t)).toEqual([
      'Chữ ký đầu file A5 5A AF BE',
      'Bo mạch trong file 0030000A khớp bàn phím đang cắm 0030000A',
      'Độ dài phần firmware khớp đầu file (114.680 byte)',
      `CRC-32 khớp đầu file (${crcHex(CRC.v0100)})`,
      'Cả file không quá 262.144 byte',
    ]);
  });
});

/** The rule: no red line says "khớp" / "matches", for every broken file, in both languages. */
async function noMatchWordOnRed(where: string) {
  for (const lang of ['vi', 'en'] as const) {
    locale.value = lang;
    const ls = await linesOf();
    const red = bad(ls);
    expect(red.length, `${where} ${lang}: some red line`).toBeGreaterThan(0);
    for (const t of red) expect(t, `${where} ${lang}`).not.toMatch(/khớp|matches/i);
  }
  locale.value = 'vi';
}

describe('OFU v1.8 §9: the rule, "khớp" / "matches" is never on a red line', () => {
  it('local files', async () => {
    for (const [name, f] of Object.entries(broken(PRO))) {
      const s = await setup('pro');
      s.fw.setSource('local');
      await s.fw.chooseFile(fileOf(f));
      await noMatchWordOnRed(`local ${name}`);
    }
  });

  it('downloads (the server sends a broken file; the list has the good one)', async () => {
    const text = fs.readFileSync(path.resolve('public/firmware/manifest.json'), 'utf8');
    const d = JSON.parse(text) as { builds: Record<string, unknown>[] };
    const pro = d.builds.find((b) => b.version === '0.1.0.0')!;
    pro.size = PRO.length;
    pro.sha256 = sha(PRO);
    for (const [name, f] of Object.entries(broken(PRO))) {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => (url === '/firmware/manifest.json'
        ? new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response(f.slice(), { status: 200 }))));
      const s = await setup('pro');
      s.fw.openPage();
      await vi.waitFor(() => expect(s.fw.listState).toBe('ok'));
      await s.fw.download(s.fw.builds.find((b) => b.version === '0.1.0.0')!);
      expect(s.fw.file?.via).toBe('online');
      expect(s.fw.file?.bytes).toBeNull(); // a mismatch keeps no bytes
      await noMatchWordOnRed(`online ${name}`);
      s.fw.leavePage();
    }
  });

  it('rescue mode (an AE64 Max bootloader, a local file)', async () => {
    const s = await setup('max');
    const bus = s.t.fwMock!;
    bus.replugAsBootloader();
    await new Promise((r) => setTimeout(r, 1200)); // the bootloader shows up 800 ms after the replug
    const boot = (await bus.list()).find((x) => x instanceof MockBootloader) as MockBootloader;
    await s.device.adoptFromFirmware(boot, true);
    await vi.waitFor(() => expect(s.fw.rescueBoard).toBe(FW_BOARD_MAX));
    s.fw.setSource('local');
    for (const [name, f] of Object.entries(broken(MAX))) {
      await s.fw.chooseFile(fileOf(f));
      await noMatchWordOnRed(`rescue ${name}`);
    }
    expect(bus.writes).toEqual([]);
  });
});
