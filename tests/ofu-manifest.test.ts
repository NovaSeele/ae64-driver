// DESIGN OFU §7.3, §3.2, §4.1: the firmware list's checks (fail closed), the allow-list, versions, the status card and the
// version relation. Pure functions; the list is the one shipped in public/firmware/ (no firmware bytes in it).
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { FW_BOARD_MAX, FW_BOARD_PRO, KNOWN_FW, checkFile, forgetLearnedFw, knownFw, learnFw } from '../src/protocol/firmware';
import {
  FW_FILE_HOST, FW_FILE_PATH, FW_LIST_URL, allowedFileUrl, asKnown, buildsFor, compareVersions, fwRelation, fwStatus, parseFwList,
} from '../src/protocol/fwManifest';
import type { FwKind, FwList, FwListState } from '../src/protocol/fwManifest';
import { makeFw } from './fw-helpers';

const TEXT = fs.readFileSync(path.resolve('public/firmware/manifest.json'), 'utf8');
const SAMPLE = JSON.parse(TEXT) as { schema: number; updated: string; builds: Record<string, unknown>[] };
const clone = () => JSON.parse(TEXT) as typeof SAMPLE;
const listOf = (): FwList => {
  const r = parseFwList(TEXT);
  if (!r.ok) throw new Error(r.why);
  return r.list;
};
/** The list with one field of the first build (the Max) set to `v` (undefined: removed). */
function withField(k: string, v: unknown, i = 0): string {
  const d = clone();
  if (v === undefined) delete d.builds[i][k];
  else d.builds[i][k] = v;
  return JSON.stringify(d);
}
const refused = (text: string) => parseFwList(text).ok === false;

describe('OFU §7: the shipped list', () => {
  it('passes every check: five Pro builds and the Max build, all fetch: true, at the fixed relative URL', () => {
    const l = listOf();
    expect(FW_LIST_URL).toBe('/firmware/manifest.json');
    expect(l.updated).toBe(SAMPLE.updated);
    expect(l.builds.map((b) => `${b.board.toString(16)} ${b.version}`)).toEqual([
      '30000d 0.0.4.0', '30000a 0.1.0.0', '30000a 0.0.8.0', '30000a 0.0.7.0', '30000a 0.0.6.0', '30000a 0.0.5.0',
    ]);
    expect(l.builds.every((b) => b.fetch && b.kind === 'official')).toBe(true);
    // every listed build agrees with the app's table
    for (const b of l.builds) expect(knownFw(b.crc32, b.board)?.version, b.version).toBe(b.version);
  });

  it('holds no firmware bytes, and no .bin file is tracked in the repo', () => {
    expect(TEXT.length).toBeLessThan(16_384);
    expect(Object.keys(SAMPLE.builds[0]).sort()).toEqual(['appVersion', 'board', 'crc32', 'date', 'fetch', 'file', 'kind', 'name', 'notes', 'sha256', 'size', 'url', 'version']);
    let tracked: string[];
    try {
      tracked = execFileSync('git', ['ls-files', '*.bin', '**/*.bin'], { encoding: 'utf8' }).split('\n').filter(Boolean);
    } catch {
      // a copy that is not a git checkout (the gates' LF / CRLF copies): every file but the dependencies and the build output
      const skip = new Set(['node_modules', '.git', 'dist', 'dist-desktop', 'target', 'coverage']);
      const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        skip.has(e.name) ? [] : e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.bin') ? [path.join(dir, e.name)] : []);
      tracked = walk(path.resolve('.'));
    }
    expect(tracked).toEqual([]);
  });
});

describe('OFU §7.3: one bad field refuses the whole list', () => {
  const cases: [string, unknown][] = [
    ['board', '0030000d'], ['board', '30000D'], ['board', 0x0030000d],
    ['name', ''], ['name', 'x'.repeat(81)],
    ['version', '0.0.4'], ['version', '0.0.256.0'], ['version', 'v0.0.4.0'], ['appVersion', '0.0.4.0.1'],
    ['date', '2026-13-01'], ['date', '2026-02-30'], ['date', '12/10/2026'],
    ['kind', 'third'], ['kind', undefined],
    ['file', 'x.zip'], ['file', '../x.bin'],
    ['size', 4096], ['size', 262_145], ['size', 158_672.5], ['size', '158672'],
    ['sha256', 'D587ADEED7A2A6856470F039569BF907965DF2BD517DD938BABA7B3DBE422FD1'], ['sha256', 'd587'],
    ['crc32', 'F1A65817'], ['crc32', 'f1a6581'],
    ['url', undefined], ['fetch', 'true'], ['fetch', undefined],
    ['notes', 'x'], ['notes', { vi: 'x'.repeat(281) }], ['notes', { de: 'x' }], ['notes', { vi: 1 }],
  ];
  for (const [k, v] of cases) {
    it(`${k} = ${JSON.stringify(v)}`, () => {
      expect(refused(withField(k, v))).toBe(true);
      // a bad field in the LAST build refuses the list too: nothing of it is kept (mutant 3)
      expect(refused(withField(k, v, SAMPLE.builds.length - 1))).toBe(true);
    });
  }

  it('the list itself: schema, updated, builds 1–64, size cap, not JSON', () => {
    const d = clone();
    expect(refused(JSON.stringify({ ...d, schema: 2 }))).toBe(true);
    expect(refused(JSON.stringify({ ...d, schema: '1' }))).toBe(true);
    expect(refused(JSON.stringify({ ...d, updated: '2026-11-31' }))).toBe(true);
    expect(refused(JSON.stringify({ ...d, builds: [] }))).toBe(true);
    expect(refused(JSON.stringify({ ...d, builds: {} }))).toBe(true);
    expect(refused('{"schema":1,')).toBe(true);
    expect(refused('[]')).toBe(true);
    // 65 builds: refused on the count; and a text over 64 KiB is refused before it is parsed
    const many = Array.from({ length: 65 }, (_, i) => ({ ...d.builds[0], version: `0.0.${i}.0`, sha256: i.toString(16).padStart(64, '0') }));
    expect(refused(JSON.stringify({ ...d, builds: many }))).toBe(true);
    expect(refused(TEXT + ' '.repeat(65_536))).toBe(true);
    expect(parseFwList(TEXT + ' '.repeat(100)).ok).toBe(true);
  });

  it('duplicates: the same sha256, or the same board + version', () => {
    const d = clone();
    expect(refused(JSON.stringify({ ...d, builds: [...d.builds, { ...d.builds[1], version: '0.2.0.0', appVersion: '0.2.0.0', crc32: '00000001' }] }))).toBe(true);
    expect(refused(JSON.stringify({ ...d, builds: [...d.builds, { ...d.builds[1], sha256: 'a'.repeat(64), crc32: '00000001' }] }))).toBe(true);
  });

  it('a CRC-32 in KNOWN_FW must agree with it (board, name, version, appVersion, kind)', () => {
    for (const [k, v] of [['name', 'AE64 Max'], ['version', '0.0.5.0'], ['appVersion', '0.0.5.0'], ['board', '0030000A']] as const) {
      expect(refused(withField(k, v)), k).toBe(true);
    }
    // a third-party build's CRC listed as official disagrees too (and kind 'third' is refused on its own: mutant 15)
    const xinput = KNOWN_FW.find((x) => x.kind === 'third')!;
    expect(refused(withField('crc32', xinput.crc.toString(16).padStart(8, '0'), 1))).toBe(true);
  });
});

describe('OFU §7.3 (answer (a), v1.4): the allow-list is hub.xsyd.top/storage/firmware/ exactly', () => {
  const ok = 'https://hub.xsyd.top/storage/firmware/cos/202610/x.bin';
  it('passes the maker host under its firmware path', () => {
    expect(FW_FILE_HOST).toBe('hub.xsyd.top');
    expect(FW_FILE_PATH).toBe('/storage/firmware/');
    expect(allowedFileUrl(ok)).toBe(true);
    expect(parseFwList(withField('url', ok)).ok).toBe(true);
  });
  const bad = [
    'https://ae64.novaseele.com/storage/firmware/x.bin', // our host (mutant 17)
    'https://x.hub.xsyd.top/storage/firmware/x.bin', // a subdomain
    'https://hub.xsyd.top.example.com/storage/firmware/x.bin', // a look-alike
    'https://evilhub.xsyd.top/storage/firmware/x.bin',
    'https://hub.xsyd.top:8443/storage/firmware/x.bin', // a port
    'https://hub.xsyd.top:443/storage/firmware/x.bin', // the default port written out: not the URL the CSP check saw
    'https://u:p@hub.xsyd.top/storage/firmware/x.bin', // user info
    'https://u@hub.xsyd.top/storage/firmware/x.bin',
    'http://hub.xsyd.top/storage/firmware/x.bin', // http:
    'https://hub.xsyd.top/keyboard/x.bin', // outside the path (mutant 21)
    'https://hub.xsyd.top/storage/x.bin',
    'https://hub.xsyd.top/storage/firmwarex/x.bin',
    'https://hub.xsyd.top/storage/firmware/../keyboard/x.bin', // dot segments
    'https://hub.xsyd.top/storage/firmware/%2e%2e/keyboard/x.bin',
    'https://hub.xsyd.top/storage/firmware/a%2Fb.bin', // escapes
    'https://HUB.xsyd.top/storage/firmware/x.bin', // not written as the browser requests it
    'https://hub.xsyd.top/storage/firmware/x.bin?board=0030000A', // a query string
    'https://hub.xsyd.top/storage/firmware/x.bin?',
    'https://hub.xsyd.top/storage/firmware/x.bin#a', // a fragment
    'https://hub.xsyd.top/storage/firmware/x.zip', // not .bin
    'hub.xsyd.top/storage/firmware/x.bin',
    'https://api.sparklinkplayjoy.com/storage/firmware/x.bin',
  ];
  for (const u of bad) {
    it(`refuses ${u} (and with it the whole list)`, () => {
      expect(allowedFileUrl(u)).toBe(false);
      expect(refused(withField('url', u))).toBe(true);
    });
  }
});

describe('OFU §7.3: boards and new builds', () => {
  it('builds for a board the app does not write are kept out of every view (not an error)', () => {
    const d = clone();
    const other = { ...d.builds[0], board: '0030000B', name: 'Other', version: '9.0.0.0', appVersion: '9.0.0.0', sha256: 'b'.repeat(64), crc32: '12345678' };
    const r = parseFwList(JSON.stringify({ ...d, builds: [...d.builds, other] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(buildsFor(r.list, 0x0030000b)).toEqual([]);
    expect(buildsFor(r.list, FW_BOARD_PRO).map((b) => b.version)).toEqual(['0.1.0.0', '0.0.8.0', '0.0.7.0', '0.0.6.0', '0.0.5.0']);
    expect(buildsFor(r.list, FW_BOARD_MAX).map((b) => b.version)).toEqual(['0.0.4.0']);
    expect(buildsFor(r.list, null)).toEqual([]);
  });

  it('a new official build not in KNOWN_FW is recognised by its CRC-32 once learned from the list', () => {
    const file = makeFw({ crc: 0x1234abcd, board: FW_BOARD_MAX, seed: 7 });
    expect(checkFile(file, FW_BOARD_MAX).known).toBeNull();
    const d = clone();
    const nb = { ...d.builds[0], version: '0.0.5.0', appVersion: '0.0.5.0', sha256: 'c'.repeat(64), crc32: '1234abcd' };
    const r = parseFwList(JSON.stringify({ ...d, builds: [...d.builds, nb] }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    try {
      for (const b of r.list.builds) learnFw(asKnown(b));
      expect(checkFile(file, FW_BOARD_MAX).known).toMatchObject({ name: 'AE64 Max App', version: '0.0.5.0', kind: 'official' });
      expect(buildsFor(r.list, FW_BOARD_MAX)[0].version).toBe('0.0.5.0');
    } finally {
      forgetLearnedFw();
    }
    expect(checkFile(file, FW_BOARD_MAX).known).toBeNull();
  });
});

describe('OFU §3.2, §4.1: versions, the status card, the version relation', () => {
  it('versions compare as numbers, part by part (mutant 14)', () => {
    expect(compareVersions('0.0.10.0', '0.0.9.0')).toBeGreaterThan(0);
    expect(compareVersions('0.1.0.0', '0.0.255.0')).toBeGreaterThan(0);
    expect(compareVersions('0.0.4.0', '0.0.4.0')).toBe(0);
    expect(compareVersions('1.0.5.0', '10.0.0.0')).toBeLessThan(0);
    expect(() => compareVersions('0.0.4', '0.0.4.0')).toThrow();
  });

  const list = listOf();
  const st = (o: Partial<{ listState: FwListState; board: number | null; rescue: boolean; current: string | null; kind: FwKind | null }>) =>
    fwStatus({ listState: 'ok', list, board: FW_BOARD_PRO, rescue: false, current: '0.0.8.0', kind: 'stock', ...o }).status;

  it('every status of §3.2, Pro and Max', () => {
    expect(st({ listState: 'idle' })).toBe('loading');
    expect(st({ listState: 'loading' })).toBe('loading');
    expect(st({ listState: 'offline' })).toBe('offline');
    expect(st({ listState: 'invalid' })).toBe('invalid');
    // Pro
    expect(st({ current: '0.0.8.0' })).toBe('newer');
    expect(st({ current: '0.1.0.0' })).toBe('uptodate');
    expect(st({ current: '0.2.0.0' })).toBe('ahead');
    expect(st({ current: '0.1.0.0', kind: 'agp1' })).toBe('third');
    expect(st({ current: '0.1.0.0', kind: 'unknown' })).toBe('kindUnknown');
    expect(st({ current: '0.0.8.0', kind: 'unknown' })).toBe('newer'); // a version no XInput build reports
    expect(st({ current: '0.1.0.0', kind: null })).toBe('loading'); // the INFO is being read
    expect(st({ rescue: true, current: null, kind: null })).toBe('rescue');
    expect(st({ current: null })).toBe('noVersion');
    expect(st({ current: '0.0.0' })).toBe('noVersion');
    // Max: no kind is asked
    expect(st({ board: FW_BOARD_MAX, current: '0.0.4.0', kind: null })).toBe('uptodate');
    expect(st({ board: FW_BOARD_MAX, current: '0.0.3.0', kind: null })).toBe('newer');
    expect(st({ board: FW_BOARD_MAX, current: '0.0.5.0', kind: null })).toBe('ahead');
    expect(st({ board: FW_BOARD_MAX, rescue: true, current: null, kind: null })).toBe('rescue');
    expect(st({ board: FW_BOARD_MAX, current: null, kind: null })).toBe('noVersion');
    expect(st({ board: 0x0030000b })).toBe('none');
    expect(st({ board: null })).toBe('none');
  });

  it('the version relation: newer / same / older, third and kindUnknown replace the compare; null for no line', () => {
    const v0100 = knownFw(0xe7e8a423)!;
    const v0080 = knownFw(0xae146e4d)!;
    const max = knownFw(0xf1a65817)!;
    const rel = (k: typeof v0100 | null, o: Partial<{ board: number | null; current: string | null; kind: FwKind | null; rescue: boolean }>) =>
      fwRelation(k, { board: FW_BOARD_PRO, current: '0.0.8.0', kind: 'stock', rescue: false, ...o });
    expect(rel(v0100, {})).toBe('newer');
    expect(rel(v0080, {})).toBe('same');
    expect(rel(v0080, { current: '0.1.0.0' })).toBe('older');
    expect(rel(v0100, { current: '0.1.0.0' })).toBe('same');
    expect(rel(v0100, { current: '0.1.0.0', kind: 'agp1' })).toBe('third');
    expect(rel(v0080, { current: '0.1.0.0', kind: 'agp1' })).toBe('third'); // not "older": an XInput version says nothing
    expect(rel(v0100, { current: '0.1.0.0', kind: 'unknown' })).toBe('kindUnknown'); // never "same"
    expect(rel(v0100, { current: '0.1.0.0', kind: null })).toBe('kindUnknown');
    expect(rel(KNOWN_FW.find((k) => k.kind === 'third')!, {})).toBeNull();
    expect(rel(null, {})).toBeNull();
    expect(rel(v0100, { rescue: true })).toBeNull();
    expect(rel(v0100, { current: null })).toBeNull();
    expect(fwRelation(max, { board: FW_BOARD_MAX, current: '0.0.4.0', kind: null, rescue: false })).toBe('same');
    expect(fwRelation(max, { board: FW_BOARD_MAX, current: '0.0.3.0', kind: null, rescue: false })).toBe('newer');
  });
});
