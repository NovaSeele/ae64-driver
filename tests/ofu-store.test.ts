// DESIGN OFU §3–§8, §12: the Firmware page's online source on the demo keyboards (no network: a fake fetch; no keyboard: the
// demo bus). The HID counts (a Max gets nothing; a Pro one INFO per connection, through the gamepad store's chain), the list
// and the download, the version boxes, the AE64 Max flow, the bootloader version, FW_DIRECT and the desktop list line.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Component } from 'vue';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import FwFileStep from '../src/components/firmware/FwFileStep.vue';
import FwEnterStep from '../src/components/firmware/FwEnterStep.vue';
import FirmwarePage from '../src/pages/FirmwarePage.vue';
import { FW_BOARD_MAX, FW_BOARD_PRO } from '../src/protocol/firmware';
import { GP_CMD } from '../src/protocol/gamepad';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockTransport } from '../src/protocol/mock';
import type { DemoSeed } from '../src/protocol/mock';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { useGamepadStore } from '../src/stores/gamepad';
import { useSyncStore } from '../src/stores/sync';
import { kib, num, shaShort } from '../src/components/firmware/fwText';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';
import { CRC, FAKE, fileOf, makeFw, run } from './fw-helpers';
import { isProfilePoll } from './helpers/profilePoll';

// FW_DIRECT and FW_DESKTOP are one constant per build (FW_DIRECT on in both from r134, FW_DESKTOP only in the desktop app): switched here per test
const flags = vi.hoisted(() => ({ direct: true, desktop: false }));
vi.mock('../src/protocol/fwDownload', async (orig) => {
  const m = await orig<typeof import('../src/protocol/fwDownload')>();
  return { ...m, get FW_DIRECT() { return flags.direct; }, get FW_DESKTOP() { return flags.desktop; } };
});

const TEXT = fs.readFileSync(path.resolve('public/firmware/manifest.json'), 'utf8');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Synthetic files with the listed builds' payload CRC-32 (no firmware byte anywhere). */
const MAX_FILE = makeFw({ crc: CRC.max0040, board: FW_BOARD_MAX, pad: 0xff, seed: 11 });
const PRO_FILE = makeFw({ crc: CRC.v0100, seed: 12 });
const PRO_0080 = makeFw({ crc: CRC.v0080, seed: 13 });
/** The shipped list with the Max 0.0.4.0, Pro 0.1.0.0 and Pro 0.0.8.0 entries pointing at the synthetic files' size and SHA-256. */
function listText(o: { maxSha?: string } = {}): string {
  const d = JSON.parse(TEXT) as { builds: Record<string, unknown>[] };
  for (const b of d.builds) {
    const f = b.version === '0.0.4.0' ? MAX_FILE : b.version === '0.1.0.0' ? PRO_FILE : b.version === '0.0.8.0' ? PRO_0080 : null;
    if (!f) continue;
    b.size = f.length;
    b.sha256 = b.version === '0.0.4.0' && o.maxSha ? o.maxSha : sha(f);
  }
  return JSON.stringify(d);
}
const fileFor = (url: string) => (url.includes('MAX') ? MAX_FILE : url.includes('0.1.0.0') ? PRO_FILE : url.includes('0.0.8.0') ? PRO_0080 : null);

interface Call { url: string; init: RequestInit }
let calls: Call[] = [];
/** A fake fetch: the list at its relative URL, the synthetic files at the listed URLs; `hang`: a file stops after 4 KiB. */
function serve(o: { list?: string; listStatus?: number; hang?: boolean } = {}) {
  calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url === '/firmware/manifest.json') {
      return new Response(o.list ?? listText(), { status: o.listStatus ?? 200, headers: { 'content-type': 'application/json' } });
    }
    const f = fileFor(url);
    if (!f) return new Response('no', { status: 404 });
    let i = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (o.hang && i > 0) return new Promise(() => undefined);
        if (i * 4096 >= f.length) { c.close(); return; }
        c.enqueue(f.slice(i * 4096, ++i * 4096));
      },
    });
    return new Response(body, { status: 200 });
  }));
}
const fileCalls = () => calls.filter((c) => c.url !== '/firmware/manifest.json');

let wrappers: VueWrapper[] = [];
const keep = <T extends VueWrapper>(w: T): T => { wrappers.push(w); return w; };
beforeEach(() => { flags.direct = true; flags.desktop = false; locale.value = 'vi'; });
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  locale.value = 'vi';
});

/** Record outgoing reports, ignoring the periodic active-profile read (02 03 01) sent by watchKeyboardProfile every PROFILE_POLL_MS. */
function recordOut(t: MockTransport): number[][] {
  const frames: number[][] = [];
  t.onPacketRaw((dir, b) => {
    if (dir === 'out' && !isProfilePoll(b)) frames.push(Array.from(b));
  });
  return frames;
}

/** A demo keyboard with real timers; `frames`: every report the app sent from here on. */
async function setup(seed: DemoSeed) {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(seed);
  const t = device.transport as MockTransport;
  const frames = recordOut(t);
  const fw = useFirmwareStore();
  fw.setEnabled(true);
  return { device, t, frames, fw, gp: useGamepadStore() };
}
const infos = (frames: number[][]) => frames.filter((f) => f[0] === 0x10 && f[1] === GP_CMD.INFO).length;
async function listed(fw: ReturnType<typeof useFirmwareStore>) {
  fw.openPage();
  await vi.waitFor(() => expect(fw.listState).toBe('ok'));
}
async function downloaded(fw: ReturnType<typeof useFirmwareStore>, version: string) {
  const b = fw.builds.find((x) => x.version === version)!;
  await fw.download(b);
  return b;
}
function makeRouter() {
  const page = { template: '<div />' } as Component;
  return createRouter({ history: createMemoryHistory(), routes: ['/firmware', '/diagnostics', '/performance'].map((p) => ({ path: p, component: page })) });
}

describe('OFU §8: what the page sends', () => {
  it('AE64 Max: opening the page, the list, a download and the checks send 0 reports; the list once, at its URL; no file before a press', async () => {
    serve();
    const s = await setup('max');
    await listed(s.fw);
    expect(calls.map((c) => c.url)).toEqual(['/firmware/manifest.json']); // the list only (mutant 11), no query (mutant 10)
    expect(s.fw.status.status).toBe('uptodate');
    expect(s.fw.kind).toBeNull(); // a Max is never asked
    const b = await downloaded(s.fw, '0.0.4.0');
    expect(fileCalls().map((c) => c.url)).toEqual([b.url]);
    expect(fileCalls()[0].init).toMatchObject({ cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors' });
    expect(s.fw.file?.via).toBe('online');
    expect(s.fw.file?.lines).toEqual([{ key: 'listSize', ok: true }, { key: 'listSha', ok: true }]);
    expect(s.fw.file?.check?.ok).toBe(true);
    expect(s.fw.fileOk).toBe(true);
    expect(s.frames).toEqual([]);
  });

  it('AE64 Pro: one INFO per connection and nothing else; a second visit sends none; Đọc lại one more; a new connection reads again', async () => {
    serve();
    const s = await setup('pro');
    await listed(s.fw);
    await vi.waitFor(() => expect(s.fw.kind).toBe('stock'));
    expect(infos(s.frames)).toBe(1);
    expect(s.frames.length).toBe(1);
    expect(s.fw.status.status).toBe('uptodate');
    s.fw.leavePage();
    await listed(s.fw);
    await s.fw.readKind();
    expect(s.frames.length).toBe(1);
    await s.fw.readKind(true);
    expect(infos(s.frames)).toBe(2);
    // firmwareKind() never changes the gamepad store's support, info or draft
    expect([s.gp.support, s.gp.info, s.gp.config]).toEqual(['unknown', null, null]);
    s.frames.length = 0;
    await s.device.switchDemoModel('max');
    await s.device.switchDemoModel('pro');
    expect(s.fw.kind).toBeNull();
    const again = recordOut(s.device.transport as MockTransport);
    await s.fw.readKind();
    expect(infos(again)).toBe(1);
    expect(again.length).toBe(1);
  });

  it('AE64 Pro: none when the gamepad store already holds stock, ready or newer', async () => {
    serve();
    for (const seed of ['pro', 'pro-xinput'] as const) {
      const s = await setup(seed);
      await s.gp.load();
      s.frames.length = 0;
      await listed(s.fw);
      await vi.waitFor(() => expect(s.fw.kind).not.toBeNull());
      expect(s.fw.kind, seed).toBe(seed === 'pro' ? 'stock' : 'agp1');
      expect(s.frames, seed).toEqual([]);
    }
  });

  it('XInput first (the Gamepad page never opened): the card is "third"; INFO failing → kindUnknown, never "same"', async () => {
    serve();
    const s = await setup('pro-xinput');
    await listed(s.fw);
    await vi.waitFor(() => expect(s.fw.status.status).toBe('third'));
    expect(s.gp.support).toBe('unknown');
    await downloaded(s.fw, '0.1.0.0');
    expect(s.fw.relation).toBe('third');
    expect(s.fw.needsVer).toBe(true);
    // the INFO fails (a timeout): kind unknown
    const s2 = await setup('pro');
    vi.spyOn(s2.t, 'gamepadInfo').mockRejectedValue(new Error('timeout'));
    await listed(s2.fw);
    await vi.waitFor(() => expect(s2.fw.kind).toBe('unknown'));
    expect(s2.fw.status.status).toBe('kindUnknown');
    await downloaded(s2.fw, '0.1.0.0');
    expect(s2.fw.relation).toBe('kindUnknown');
    expect(s2.fw.needsVer).toBe(true);
  });

  it('the INFO waits in the gamepad chain: a load() already running finishes first and its answer is used (one INFO; mutant 19)', async () => {
    const s = await setup('pro-xinput');
    const load = s.gp.load();
    const kind = s.gp.firmwareKind(true);
    await Promise.all([load, kind]);
    expect(await kind).toBe('agp1');
    expect(infos(s.frames)).toBe(1);
    const cmds = s.frames.filter((f) => f[0] === 0x10).map((f) => f[1]);
    expect(cmds[0]).toBe(GP_CMD.INFO); // load()'s own INFO, then its reads; the Firmware page's read reused its answer
    expect(cmds).toContain(GP_CMD.READ);
    expect(s.gp.support).toBe('ready');
  });

  it('upload first (OFU-10): Apply on Gamepad, then Firmware opens and Đọc lại is pressed: the upload ends saved, no INFO cuts it', async () => {
    serve();
    const s = await setup('pro-xinput');
    await s.gp.load();
    const rev = s.gp.revision!;
    s.frames.length = 0;
    expect(s.gp.apply((d) => { d.mode = 'mixed'; }, 'mode')).toBe(true);
    const flush = useSyncStore().flush();
    s.fw.openPage();
    const reread = s.fw.readKind(true);
    await Promise.all([flush, reread]);
    await vi.waitFor(() => expect(s.fw.listState).toBe('ok'));
    expect(s.gp.dirty).toBe(false);
    expect(s.gp.revision).toBe(rev + 1);
    const cmds = s.frames.filter((f) => f[0] === 0x10).map((f) => f[1]);
    const begin = cmds.indexOf(GP_CMD.BEGIN);
    const commit = cmds.indexOf(GP_CMD.COMMIT);
    expect(cmds.slice(begin + 1, commit).every((c) => c === GP_CMD.WRITE)).toBe(true);
    expect(s.fw.kind).toBe('agp1');
    expect(s.fw.status.status).toBe('third');
  });
});

describe('OFU §3.3: the download in the store', () => {
  it('a file that does not match the list is refused: no bytes kept, step 2 locked, no session starts, 0 × 08', async () => {
    serve({ list: listText({ maxSha: 'e'.repeat(64) }) });
    const s = await setup('max');
    await listed(s.fw);
    await downloaded(s.fw, '0.0.4.0');
    expect(s.fw.file?.lines).toEqual([{ key: 'listSize', ok: true }, { key: 'listSha', ok: false }]);
    expect(s.fw.file?.bytes).toBeNull();
    expect(s.fw.fileOk).toBe(false);
    s.fw.typed = 'AE64 Max';
    s.fw.verOk = true;
    expect(s.fw.canStart).toBe(false);
    await s.fw.start();
    expect(s.frames.filter((f) => f[0] === 0x08)).toEqual([]);
    expect(s.fw.active).toBe(false);
  });

  it('Dừng tải aborts (cut, nothing kept); leaving the page aborts a running download', async () => {
    serve({ hang: true });
    const s = await setup('max');
    await listed(s.fw);
    const b = s.fw.builds[0];
    const p = s.fw.download(b);
    await vi.waitFor(() => expect(s.fw.dl?.done).toBe(4096));
    s.fw.stopDownload();
    await p;
    expect(s.fw.dl?.state).toBe('cut');
    expect(s.fw.file).toBeNull();
    const q = s.fw.download(b);
    await vi.waitFor(() => expect(s.fw.dl?.done).toBe(4096));
    s.fw.leavePage();
    await q;
    expect(s.fw.dl).toBeNull();
    expect(s.fw.file).toBeNull();
    expect((fileCalls()[1].init.signal as AbortSignal).aborted).toBe(true);
  });

  it('FW_DIRECT off (a build whose CSP does not allow the file path): the link look from the start, no file is ever requested', async () => {
    flags.direct = false;
    serve();
    const s = await setup('pro');
    s.device.info!.firmware = '0.0.7.0';
    await listed(s.fw);
    await vi.waitFor(() => expect(s.fw.status.status).toBe('newer'));
    const w = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    const card = w.find('[data-test="ofu-card"]');
    expect(card.text()).toContain(tr('fw.on.linkBody'));
    const link = card.find('a.btn');
    expect(link.attributes('href')).toBe(s.fw.status.newest!.url);
    expect(link.attributes('rel')).toBe('noopener noreferrer');
    expect(link.attributes('referrerpolicy')).toBe('no-referrer');
    expect(card.text()).toContain(tr('fw.on.pickSaved'));
    expect(card.text()).not.toContain(tr('fw.on.download'));
    await w.find('details[data-test="ofu-others"] summary').trigger('click');
    expect(w.find('[data-test="ofu-others"]').text()).toContain(tr('fw.on.getLink'));
    expect(w.find('[data-test="ofu-others"]').text()).not.toContain(tr('fw.on.get') + ' ');
    await s.fw.download(s.fw.builds[0]); // a press cannot reach the network either (mutant 20)
    expect(fileCalls()).toEqual([]);
    expect(w.find('[data-test="ofu-fallback"]').exists()).toBe(false);
    // and with it on, the same card downloads
    flags.direct = true;
    const w2 = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    expect(w2.find('[data-test="ofu-card"]').text()).toContain(tr('fw.on.download'));
  });

  it('the desktop list line (built in) has no "Kiểm tra lại"; the web line has it', async () => {
    serve();
    const s = await setup('max');
    await listed(s.fw);
    const web = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    expect(web.find('[data-test="ofu-list"]').text()).toContain(tr('fw.on.recheck'));
    expect(web.find('[data-test="ofu-list"]').text()).toContain('Danh sách của AE64 Control');
    flags.desktop = true;
    const desk = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    expect(desk.find('[data-test="ofu-list"]').text()).toContain('Danh sách đi kèm bản app này');
    expect(desk.find('[data-test="ofu-list"]').text()).not.toContain(tr('fw.on.recheck'));
  });

  it('list replies: 200 text/html and 404 → offline (File trên máy still works); bad JSON → invalid', async () => {
    for (const [o, want] of [[{ listStatus: 404 }, 'offline'], [{ list: '{"schema":2}' }, 'invalid']] as const) {
      serve(o);
      const s = await setup('max');
      s.fw.openPage();
      await vi.waitFor(() => expect(s.fw.listState).toBe(want));
      expect(s.fw.status.status).toBe(want);
    }
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })));
    const s = await setup('max');
    s.fw.openPage();
    await vi.waitFor(() => expect(s.fw.listState).toBe('offline'));
    await s.fw.chooseFile(fileOf(MAX_FILE));
    expect(s.fw.source).toBe('local');
    expect(s.fw.fileOk).toBe(true);
    expect(s.fw.file?.lines).toEqual([]); // without the list, File trên máy works as before
  });
});

describe('OFU §3.5: a local file and the list', () => {
  it('a listed build\'s SHA-256 adds the line; the same firmware part with another SHA-256 is an unknown file (risk box)', async () => {
    serve();
    const s = await setup('pro');
    await listed(s.fw);
    await s.fw.chooseFile(fileOf(PRO_FILE));
    expect(s.fw.file?.lines).toEqual([{ key: 'listSha', ok: true }]);
    expect(s.fw.known?.version).toBe('0.1.0.0');
    expect(s.fw.needsRisk).toBe(false);
    const other = PRO_FILE.slice();
    other[100] ^= 0xff; // the header's padding: same payload CRC, another file
    await s.fw.chooseFile(fileOf(other));
    expect(s.fw.file?.lines).toEqual([{ key: 'listOther', ok: false }]);
    expect(s.fw.fileOk).toBe(true);
    expect(s.fw.known).toBeNull();
    expect(s.fw.needsRisk).toBe(true);
    expect(s.fw.relation).toBeNull();
  });
});

describe('OFU §4.1: the version line and box', () => {
  it('same → box and "Ghi lại firmware"; older → box and "Ghi bản cũ hơn"; newer → no box; a new file clears the box (mutants 5, 6)', async () => {
    serve();
    const s = await setup('pro');
    await listed(s.fw);
    await vi.waitFor(() => expect(s.fw.kind).toBe('stock'));
    const w = keep(mount(FwEnterStep, { attachTo: document.body }));
    await s.fw.chooseFile(fileOf(PRO_FILE));
    s.fw.typed = 'AE64 Pro';
    await flushPromises();
    expect(s.fw.relation).toBe('same');
    expect(s.fw.canStart).toBe(false);
    expect(w.find('[data-test="ofu-verbox"]').text()).toBe(tr('fw.box.same', { v: '0.1.0.0' }));
    expect(w.find('[data-test="ofu-verbox"] input').attributes('aria-describedby')).toBe('fw-ver-line');
    expect(w.find('button.btn--danger').text()).toBe(tr('fw.s2.startSame'));
    s.fw.verOk = true;
    expect(s.fw.canStart).toBe(true);
    await s.fw.chooseFile(fileOf(PRO_0080));
    await flushPromises();
    expect(s.fw.verOk).toBe(false);
    expect(s.fw.relation).toBe('older');
    expect(s.fw.canStart).toBe(false);
    expect(w.find('[data-test="ofu-verbox"]').text()).toBe(tr('fw.box.older', { v: '0.0.8.0' }));
    expect(w.find('button.btn--danger').text()).toBe(tr('fw.s2.startOlder'));
    s.device.info!.firmware = '0.0.7.0';
    await flushPromises();
    expect(s.fw.relation).toBe('newer');
    expect(s.fw.needsVer).toBe(false);
    expect(w.find('[data-test="ofu-verbox"]').exists()).toBe(false);
    expect(w.find('button.btn--danger').text()).toBe(tr('fw.s2.start'));
    expect(s.fw.canStart).toBe(true);
    // the version line in step 1
    const f = keep(mount(FwFileStep, { attachTo: document.body }));
    s.fw.setSource('local');
    await s.fw.chooseFile(fileOf(PRO_0080));
    await flushPromises();
    expect(f.find('#fw-ver-line').text()).toBe(tr('fw.ver.newer', { cur: '0.0.7.0', v: '0.0.8.0' }));
  });

  it('step 2 per model: the Max text and "AE64 Max"; the Pro text; "AE64 Pro" never confirms a Max (mutant 7)', async () => {
    serve();
    const m = await setup('max');
    await m.fw.chooseFile(fileOf(MAX_FILE));
    const w = keep(mount(FwEnterStep, { attachTo: document.body }));
    await flushPromises();
    expect(w.text()).toContain(`${tr('fw.s2.bodyMax')} ${tr('fw.s2.time')}`);
    expect(w.find('label[for="fw-type"] code').text()).toBe('AE64 Max');
    m.fw.typed = 'AE64 Pro';
    expect(m.fw.canStart).toBe(false);
    m.fw.typed = ' ae64   max ';
    m.fw.verOk = true;
    expect(m.fw.canStart).toBe(true);
    w.unmount();
    const p = await setup('pro');
    await p.fw.chooseFile(fileOf(PRO_0080));
    const w2 = keep(mount(FwEnterStep, { attachTo: document.body }));
    await flushPromises();
    expect(w2.text()).toContain(`${tr('fw.s2.body')} ${tr('fw.s2.time')}`);
    p.fw.typed = 'AE64 Max';
    p.fw.verOk = true;
    expect(p.fw.canStart).toBe(false);
  });
});

describe('OFU §5, §6: the AE64 Max flow on the demo', () => {
  it('download, seven lines, "AE64 Max", the box, then the demo write ends "Đã ghi lại bản 0.0.4.0"; Bootloader 1.0.5.0 only in the bootloader', async () => {
    serve();
    const s = await setup('max');
    const router = makeRouter();
    await router.push('/firmware');
    const page = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await vi.waitFor(() => expect(s.fw.listState).toBe('ok'));
    await flushPromises();
    expect(page.find('[data-test="ofu-card"]').attributes('data-status')).toBe('uptodate');
    expect(page.find('[data-test="fw-boot-version"]').exists()).toBe(false);
    await downloaded(s.fw, '0.0.4.0');
    await flushPromises();
    expect(page.findAll('.fw-chk li.ok').length).toBe(7);
    expect(s.fw.relation).toBe('same');
    s.fw.typed = 'AE64 Max';
    s.fw.verOk = true;
    expect(s.fw.canStart).toBe(true);
    s.frames.length = 0;
    vi.useFakeTimers({ toFake: [...FAKE.toFake] });
    void s.fw.start();
    let ms = 0;
    while (s.fw.phase !== 'writing' && ms < 30_000) { await run(100); ms += 100; }
    expect(s.fw.phase).toBe('writing');
    await flushPromises();
    const dd = (label: string) => page.findAll('.fw-dl dt').find((d) => d.text() === label)?.element.nextElementSibling?.textContent;
    expect(dd(tr('fw.dev.version'))).toBe('—'); // the bootloader's version never in the Firmware row (mutant 9)
    expect(dd(tr('fw.dev.boot'))).toBe('1.0.5.0');
    while (!['done', 'doneUnknown', 'packetFail', 'verifyFail', 'lost', 'notFound', 'enterFail', 'preflightFail'].includes(s.fw.phase) && ms < 120_000) { await run(250); ms += 250; }
    expect(s.fw.phase).toBe('done');
    expect(s.fw.doneVersion).toBe('0.0.4.0');
    expect(s.fw.doneSame).toBe(true);
    await flushPromises();
    expect(page.find('.fw-ban__t').text()).toBe(tr('fw.done.titleSame', { version: '0.0.4.0' }));
    expect(page.find('[data-test="fw-boot-version"]').exists()).toBe(false);
    expect(s.frames.some((f) => f[0] === 0x08)).toBe(true);
  });

  it('a Pro file fails the board line on a Max (mutant 8); rescue opens for a Max bootloader and takes a Max file', async () => {
    const s = await setup('max');
    await s.fw.chooseFile(fileOf(PRO_FILE));
    expect(s.fw.file?.check?.lines.find((l) => l.key === 'board')?.ok).toBe(false);
    expect(s.fw.fileOk).toBe(false);
    const bus = s.t.fwMock!;
    bus.replugAsBootloader();
    await new Promise((r) => setTimeout(r, 1200)); // the bootloader shows up 800 ms after the replug
    const boot = (await bus.list()).find((d) => d instanceof MockBootloader) as MockBootloader;
    expect(boot).toBeDefined();
    await s.device.adoptFromFirmware(boot, true);
    await vi.waitFor(() => expect(s.fw.rescue).toBe(true));
    await vi.waitFor(() => expect(s.fw.rescueBoard).toBe(FW_BOARD_MAX));
    expect(s.fw.model).toBe('AE64 Max');
    await s.fw.chooseFile(fileOf(MAX_FILE));
    expect(s.fw.fileOk).toBe(true);
    expect(s.fw.canRescueWrite).toBe(true);
    expect(s.fw.bootVersion).toBe('1.0.5.0');
  });

  it('the demo Pro bootloader does not say its version: the Bootloader row reads "—"', async () => {
    const s = await setup('pro');
    const bus = s.t.fwMock!;
    bus.replugAsBootloader();
    await new Promise((r) => setTimeout(r, 1200)); // the bootloader shows up 800 ms after the replug
    const boot = (await bus.list()).find((d) => d instanceof MockBootloader) as MockBootloader;
    const router = makeRouter();
    await router.push('/firmware');
    const page = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await s.device.adoptFromFirmware(boot, true);
    await vi.waitFor(() => expect(s.fw.rescueBoard).toBe(FW_BOARD_PRO));
    await flushPromises();
    expect(s.fw.bootVersion).toBe('0.0.0.0');
    expect(page.find('[data-test="fw-boot-version"]').text()).toBe('—');
  });
});

describe("OFU review P3-1: a red list line shows the file's value and the list's", () => {
  it("SHA-256: the file's hash and the list's; size: the file's bytes and the list's", async () => {
    serve({ list: listText({ maxSha: 'e'.repeat(64) }) });
    const s = await setup('max');
    await listed(s.fw);
    await downloaded(s.fw, '0.0.4.0');
    const w = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    const bad = () => w.findAll('.fw-chk li.bad').map((l) => l.text());
    expect(bad()).toEqual([tr('fw.chk.listShaBad', { h: shaShort(sha(MAX_FILE)), want: 'eeee…eeee' })]);
    w.unmount();
    // the list says 4 KiB more than the server sends: a short body (the server's own smaller file)
    const d = JSON.parse(listText()) as { builds: Record<string, unknown>[] };
    const m = d.builds.find((b) => b.version === '0.0.4.0')!;
    m.size = MAX_FILE.length + 4096;
    serve({ list: JSON.stringify(d) });
    const s2 = await setup('max');
    await listed(s2.fw);
    await downloaded(s2.fw, '0.0.4.0');
    const w2 = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    // the bytes are the listed file's, so only the size line is red
    expect(w2.findAll('.fw-chk li.bad').map((l) => l.text())).toEqual([tr('fw.chk.listSizeBad', { n: num(MAX_FILE.length), want: num(MAX_FILE.length + 4096) })]);
  });
});

describe('OFU review P3-2: the backstops behind the disabled buttons', () => {
  it('A2: bytes changed after the checks → the press re-checks the SHA-256: preflightFail (fw.why.file), 0 × 08', async () => {
    serve();
    const s = await setup('max');
    await listed(s.fw);
    await downloaded(s.fw, '0.0.4.0');
    expect(s.fw.fileOk).toBe(true);
    s.fw.typed = 'AE64 Max';
    s.fw.verOk = true;
    expect(s.fw.canStart).toBe(true);
    // a byte of the header's padding (28..4095): the five checks and the CRC-32 still pass; only the SHA-256 re-check sees it
    s.fw.file!.bytes![100] ^= 1;
    await s.fw.start();
    expect(s.fw.phase).toBe('preflightFail');
    expect(s.fw.error?.paramKeys?.reason).toBe('fw.why.file');
    expect(s.frames.filter((f) => f[0] === 0x08)).toEqual([]);
    expect(s.fw.active).toBe(false);
  });

  it("A3: the same in rescue mode: rescueWrite() re-checks a download's SHA-256 and writes nothing", async () => {
    serve();
    const s = await setup('max');
    await listed(s.fw);
    const bus = s.t.fwMock!;
    bus.replugAsBootloader();
    await new Promise((r) => setTimeout(r, 1200)); // the bootloader shows up 800 ms after the replug
    const boot = (await bus.list()).find((d) => d instanceof MockBootloader) as MockBootloader;
    await s.device.adoptFromFirmware(boot, true);
    await vi.waitFor(() => expect(s.fw.rescueBoard).toBe(FW_BOARD_MAX));
    await downloaded(s.fw, '0.0.4.0');
    expect(s.fw.canRescueWrite).toBe(true);
    // a byte of the header's padding (28..4095): the five checks and the CRC-32 still pass; only the SHA-256 re-check sees it
    s.fw.file!.bytes![100] ^= 1;
    await s.fw.rescueWrite();
    await new Promise((r) => setTimeout(r, 500));
    expect(bus.writes).toEqual([]);
    expect(s.fw.phase).toBe('rescue'); // still waiting for a good file: no session began
    expect(s.fw.sent).toBe(0);
    expect(bus.violations).toEqual([]);
  });

  it("H6: start() with the box unticked on a rewrite → preflightFail, 0 × 08 (the button is disabled; this is the store's own check)", async () => {
    serve();
    const s = await setup('max');
    await listed(s.fw);
    await downloaded(s.fw, '0.0.4.0');
    s.fw.typed = 'AE64 Max';
    expect(s.fw.relation).toBe('same');
    s.fw.verOk = true;
    expect(s.fw.canStart).toBe(true);
    // a real keyboard waits for the firmware lock first (W-11); the box is unticked during that wait
    s.device.demo = false;
    const p = s.fw.start();
    s.fw.verOk = false;
    await p;
    expect(s.fw.phase).toBe('preflightFail');
    expect(s.frames.filter((f) => f[0] === 0x08)).toEqual([]);
    expect(s.fw.active).toBe(false);
  });

  it('H4: the box ticked for "kind unknown" does not carry over when Đọc lại answers XInput (same file, new sentence)', async () => {
    serve();
    const s = await setup('pro-xinput');
    vi.spyOn(s.t, 'gamepadInfo').mockRejectedValueOnce(new Error('timeout'));
    await listed(s.fw);
    await vi.waitFor(() => expect(s.fw.kind).toBe('unknown'));
    await downloaded(s.fw, '0.1.0.0');
    expect(s.fw.relation).toBe('kindUnknown');
    s.fw.typed = 'AE64 Pro';
    s.fw.verOk = true;
    expect(s.fw.canStart).toBe(true);
    await s.fw.readKind(true);
    await vi.waitFor(() => expect(s.fw.kind).toBe('agp1'));
    expect(s.fw.relation).toBe('third');
    expect(s.fw.verOk).toBe(false);
    expect(s.fw.canStart).toBe(false);
  });

  it('E5: a listed build with fetch: false gets the link look (card and "Các bản khác"), and download(b) requests nothing', async () => {
    const d = JSON.parse(listText()) as { builds: Record<string, unknown>[] };
    for (const b of d.builds) if (b.board === '0030000A') b.fetch = false;
    serve({ list: JSON.stringify(d) });
    const s = await setup('pro');
    s.device.info!.firmware = '0.0.7.0';
    await listed(s.fw);
    await vi.waitFor(() => expect(s.fw.status.status).toBe('newer'));
    const w = keep(mount(FwFileStep, { attachTo: document.body }));
    await flushPromises();
    const card = w.find('[data-test="ofu-card"]');
    expect(card.find('a.btn').attributes('href')).toBe(s.fw.status.newest!.url);
    expect(card.text()).not.toContain(tr('fw.on.download'));
    await w.find('details[data-test="ofu-others"] summary').trigger('click');
    expect(w.find('[data-test="ofu-others"]').text()).toContain(tr('fw.on.getLink'));
    for (const b of s.fw.builds) await s.fw.download(b);
    expect(fileCalls()).toEqual([]);
    expect(s.fw.file).toBeNull();
  });

  it('E2: download() of a build for another board (the Pro build on a Max) requests nothing', async () => {
    serve();
    const s = await setup('max');
    await listed(s.fw);
    const pro = s.fw.list!.builds.find((b) => b.board === FW_BOARD_PRO)!;
    expect(pro).toBeDefined();
    await s.fw.download(pro);
    expect(fileCalls()).toEqual([]);
    expect(s.fw.file).toBeNull();
    expect(s.fw.dl).toBeNull();
  });
});

describe('OFU §9: numbers in the locale', () => {
  it('vi "155,0 KiB", "262.144 byte"; en "155.0 KiB", "262,144 bytes"', () => {
    locale.value = 'vi';
    expect(kib(158_720)).toBe('155,0');
    expect(num(262_144)).toBe('262.144');
    expect(tr('fw.types')).toContain('262.144 byte');
    locale.value = 'en';
    expect(kib(158_720)).toBe('155.0');
    expect(num(262_144)).toBe('262,144');
    expect(tr('fw.chk.size')).toContain('262,144 bytes');
  });
});

describe('OFU §8 (v1.4): the desktop CSP', () => {
  it('connect-src is exactly \'self\' https://hub.xsyd.top/storage/firmware/; every other directive unchanged', () => {
    const conf = JSON.parse(fs.readFileSync(path.resolve('src-tauri/tauri.conf.json'), 'utf8')) as { app: { security: { csp: string } } };
    const dirs = conf.app.security.csp.split(';').map((d) => d.trim()).filter(Boolean);
    expect(dirs).toEqual([
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:", "font-src 'self' data:",
      "connect-src 'self' https://hub.xsyd.top/storage/firmware/", "worker-src 'self'", "manifest-src 'self'", "base-uri 'self'", "form-action 'none'",
    ]);
  });
});
