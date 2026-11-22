// OFU v1.10 addendum §8 tests 1–12 and mutants A1–A13: preflight backup timing (0 HID between 01 02 and 08 01),
// step-2 noSave, demo wipeAxis() restore flow, cant, lostBefore, all-same, other serial/board, "Để sau" + changedSince,
// rescue mode, no undo / no export / no network leak, fitTravel distances (C2), and blocked mode 7 → restore.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Component } from 'vue';
import FirmwarePage from '../src/pages/FirmwarePage.vue';
import FwEnterStep from '../src/components/firmware/FwEnterStep.vue';
import FwBanner from '../src/components/firmware/FwBanner.vue';
import AxisRestoreCard from '../src/components/firmware/AxisRestoreCard.vue';
import { AXIS_BACKUP_KEY, AXIS_BACKUP_OLD_MS, loadBackup, readAllBackups, saveBackup, writeAllBackups } from '../src/data/axisBackup';
import type { AxisBackup, Triple } from '../src/data/axisBackup';
import { buildExport } from '../src/data/appSettings';
import { readyToCustomLike, setAssignments } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { BaseTransport, FirmwareSessionError } from '../src/protocol/client';
import { FW_BOARD_MAX, FW_BOARD_PRO } from '../src/protocol/firmware';
import { MockTransport } from '../src/protocol/mock';
import type { DemoSeed } from '../src/protocol/mock';
import { MockBootloader } from '../src/protocol/mockFirmware';
import { PHYSICAL_KEYS } from '../src/protocol/layout';
import { checkPerformanceWrite } from '../src/protocol/safety';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';
import { CRC, demo, fileOf, makeFw, run, startWith } from './fw-helpers';

const MAX_FILE = makeFw({ crc: CRC.max0040, board: FW_BOARD_MAX, pad: 0xff, seed: 31 });
const PRO_FILE = makeFw({ crc: CRC.v0100, board: FW_BOARD_PRO, seed: 32 });
const FLUX_READY = READY_SWITCHES.find((s) => s.uid === 'r-wuque-ws-flux-clacky')!;
const FLUX = readyToCustomLike(FLUX_READY);
const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const A = key('A');
const S_KEY = key('S');
const D = key('D');
const F = key('F');
const G = key('G');
const SPACE = key('Space');

let wrappers: VueWrapper[] = [];
const keep = <T extends VueWrapper>(w: T): T => { wrappers.push(w); return w; };

beforeEach(() => {
  localStorage.clear();
  locale.value = 'vi';
});

afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  locale.value = 'vi';
});

function makeRouter() {
  const page = { template: '<div />' } as Component;
  return createRouter({
    history: createMemoryHistory(),
    routes: ['/firmware', '/performance', '/diagnostics'].map((p) => ({ path: p, component: page })),
  });
}

async function until(pred: () => boolean, max = 60_000): Promise<void> {
  let ms = 0;
  while (!pred() && ms < max) {
    await run(200);
    ms += 200;
  }
}

/** Runs `perf.load()` cleanly while fake timers are active. */
async function loadPerf(perf: ReturnType<typeof usePerformanceStore>): Promise<void> {
  const p = perf.load(true);
  let ms = 0;
  while (perf.loading && ms < 10_000) {
    await run(50);
    ms += 50;
  }
  await p;
  await run(0);
}

/** Mutates a mock keyboard's raw performance record bytes and/or global axis entry for test setups. */
function setMockKey(
  mock: MockTransport,
  k: typeof W,
  o: { mode?: number; normalPress?: number; normalRelease?: number; pressDeadStroke?: number; axisV2Id?: number; axisRangeMax?: number; axisCoefficient?: number; calibrate?: number },
): void {
  const m = mock as unknown as {
    profiles: { perf: Map<string, number[]> }[];
    active: number;
    axis: Map<string, { axisV2Id: number; axisRangeMax: number; axisCoefficient: number; calibrate: number }>;
  };
  const pos = `${k.row}:${k.col}`;
  const rec = m.profiles[m.active].perf.get(pos)!;
  const wr16 = (off: number, mm: number) => {
    const um = Math.round(mm * 1000);
    rec[off] = um & 0xff;
    rec[off + 1] = (um >> 8) & 0xff;
  };
  if (o.mode !== undefined) rec[0] = o.mode;
  if (o.normalPress !== undefined) wr16(1, o.normalPress);
  if (o.normalRelease !== undefined) wr16(3, o.normalRelease);
  if (o.pressDeadStroke !== undefined) wr16(11, o.pressDeadStroke);
  const ax = m.axis.get(pos)!;
  if (o.axisV2Id !== undefined) ax.axisV2Id = o.axisV2Id;
  if (o.axisRangeMax !== undefined) ax.axisRangeMax = o.axisRangeMax;
  if (o.axisCoefficient !== undefined) ax.axisCoefficient = o.axisCoefficient;
  if (o.calibrate !== undefined) ax.calibrate = o.calibrate;
}

/** Seeds a 64-key backup in localStorage matching a board/serial, with optional per-key triple overrides. */
function seedBackup(
  serialHex: string,
  board: number,
  o: { base?: Triple; overrides?: Record<number, Triple>; after?: Record<number, Triple>; takenAt?: number; fwBefore?: string } = {},
): AxisBackup {
  const base: Triple = o.base ?? (board === FW_BOARD_MAX ? [12432, 3310, 20500] : [14544, 3400, 17664]);
  const keys: Record<number, Triple> = {};
  for (const k of PHYSICAL_KEYS) keys[k.id] = o.overrides?.[k.id] ?? [...base];
  const b: AxisBackup = {
    v: 1,
    serialHex,
    board,
    fwBefore: o.fwBefore ?? (board === FW_BOARD_MAX ? '0.0.4.0' : '0.1.0.0'),
    takenAt: o.takenAt ?? Date.now(),
    keys,
    ...(o.after ? { after: o.after } : {}),
  };
  writeAllBackups(saveBackup(readAllBackups(), b));
  return b;
}

/** Runs a full demo update from start to done (and waits for post-update perf.load if triggered). */
async function runFullUpdate(
  seed: DemoSeed,
  file: Uint8Array,
  opts: { preloadPerf?: boolean; beforeStart?: (s: Awaited<ReturnType<typeof demo>> & { perf: ReturnType<typeof usePerformanceStore> }) => Promise<void> | void } = {},
) {
  const s = await demo(seed);
  const perf = usePerformanceStore();
  if (opts.preloadPerf !== false) await loadPerf(perf);
  if (opts.beforeStart) await opts.beforeStart({ ...s, perf });
  const model = seed === 'max' ? 'AE64 Max' : 'AE64 Pro';
  await startWith(s.fw, file, { typed: model });
  await until(() => ['done', 'doneUnknown', 'versionMismatch', 'noGamepad', 'preflightFail', 'enterFail'].includes(s.fw.phase) && !s.fw.active);
  // Let any post-update perf.load() settle
  for (let i = 0; i < 40 && perf.loading; i++) await run(50);
  await run(200);
  await flushPromises();
  return { ...s, perf };
}

describe('Test 1: preflight backup timing, 0 HID between 01 02 and 08 01, failure branches (kills A4, A12, A13)', { timeout: 60_000 }, () => {
  it('saves 64 triples right after beginFirmwareSession and BEFORE 08 01 with 0 HID in between; second run replaces only its serial (kills A4)', async () => {
    const otherSerial = '11223344556677889900aabb';
    seedBackup(otherSerial, FW_BOARD_PRO, { fwBefore: '0.0.8.0' });

    const s = await demo('max');
    const perf = usePerformanceStore();
    await loadPerf(perf);

    const outCmds: string[] = [];
    s.t.onPacketRaw((dir, b) => { if (dir === 'out') outCmds.push(`${b[0].toString(16).padStart(2, '0')} ${b[1].toString(16).padStart(2, '0')}`); });

    let backupAtFwEnter: AxisBackup | null = null;
    const realFwEnter = s.t.fwEnter.bind(s.t);
    vi.spyOn(s.t, 'fwEnter').mockImplementation(async (ticket) => {
      // Snapshot localStorage at the exact instant fwEnter is called (BEFORE 08 01 is sent!)
      backupAtFwEnter = loadBackup(readAllBackups(), s.device.info!.serialHex, FW_BOARD_MAX);
      return realFwEnter(ticket);
    });

    await startWith(s.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s.fw.phase === 'done' && !s.fw.active);
    for (let i = 0; i < 40 && perf.loading; i++) await run(50);
    await run(100);

    // Backup existed BEFORE 08 01 (kills A4)
    expect(backupAtFwEnter).not.toBeNull();
    expect(backupAtFwEnter!.serialHex).toBe(s.device.info!.serialHex);
    expect(backupAtFwEnter!.board).toBe(FW_BOARD_MAX);
    expect(backupAtFwEnter!.fwBefore).toBe('0.0.4.0');
    expect(Object.keys(backupAtFwEnter!.keys)).toHaveLength(64);
    expect(backupAtFwEnter!.keys[W.id]).toEqual([12432, 3310, 20500]);
    expect(typeof backupAtFwEnter!.takenAt).toBe('number');

    // Mock's HID log between the session's 01 02 and 08 01 is completely empty!
    const i0102 = outCmds.indexOf('01 02');
    const i0801 = outCmds.indexOf('08 01');
    expect(i0102).toBeGreaterThanOrEqual(0);
    expect(i0801).toBe(i0102 + 1);
    expect(outCmds.slice(i0102 + 1, i0801)).toEqual([]);
    const bus0102 = s.bus.received.findIndex((r) => r.dev === 'app' && r.cmd === '01 02');
    const bus0801 = s.bus.received.findIndex((r) => r.dev === 'app' && r.cmd === '08 01');
    expect(bus0801).toBe(bus0102 + 1);

    // Other serial's record was not touched
    const all = readAllBackups();
    expect(all[otherSerial]?.fwBefore).toBe('0.0.8.0');
    expect(all[s.device.info!.serialHex]).toBeDefined();

    // Second run on the same serial replaces only this serial's record (restore W to a valid switch first so post-wipe still offers it)
    const prevTakenAt = all[s.device.info!.serialHex].takenAt;
    setMockKey(s.device.transport as MockTransport, W, { axisV2Id: 4128, axisRangeMax: 3390, axisCoefficient: 20000 });
    await loadPerf(perf);
    await run(5000);
    await startWith(s.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s.fw.phase === 'done' && !s.fw.active);
    for (let i = 0; i < 40 && perf.loading; i++) await run(50);
    await run(100);
    const all2 = readAllBackups();
    expect(all2[otherSerial]?.fwBefore).toBe('0.0.8.0');
    expect(all2[s.device.info!.serialHex].takenAt).toBeGreaterThan(prevTakenAt);
    expect(all2[s.device.info!.serialHex].keys[W.id]).toEqual([4128, 3390, 20000]);
  });

  it('failing SHA-256 recheck or failing beginFirmwareSession saves nothing (kills A12)', async () => {
    // 1. Failing beginFirmwareSession
    const s1 = await demo('max');
    const perf1 = usePerformanceStore();
    await loadPerf(perf1);
    const setSpy1 = vi.spyOn(Storage.prototype, 'setItem');
    vi.spyOn(BaseTransport.prototype, 'beginFirmwareSession').mockRejectedValueOnce(new FirmwareSessionError('mode'));
    await startWith(s1.fw, MAX_FILE, { typed: 'AE64 Max' });
    await run(500);
    expect(s1.fw.phase).toBe('preflightFail');
    expect(setSpy1.mock.calls.filter(([k]) => k === AXIS_BACKUP_KEY)).toEqual([]);
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();

    // 2. Failing SHA-256 recheck before beginFirmwareSession (step 4)
    vi.restoreAllMocks();
    const s2 = await demo('max');
    const perf2 = usePerformanceStore();
    await loadPerf(perf2);
    const setSpy2 = vi.spyOn(Storage.prototype, 'setItem');
    const beginSpy = vi.spyOn(BaseTransport.prototype, 'beginFirmwareSession');
    await s2.fw.chooseFile(fileOf(MAX_FILE));
    // Simulate a listed online file whose bytes were tampered after download
    s2.fw.file = { ...s2.fw.file!, via: 'online', build: { sha256: '0'.repeat(64) } as never, lines: [{ key: 'listSha', ok: true }] };
    s2.fw.typed = 'AE64 Max';
    if (s2.fw.needsVer) s2.fw.verOk = true;
    await s2.fw.start();
    await run(500);
    expect(s2.fw.phase).toBe('preflightFail');
    expect(beginSpy).not.toHaveBeenCalled();
    expect(setSpy2.mock.calls.filter(([k]) => k === AXIS_BACKUP_KEY)).toEqual([]);
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();
  });

  it('throwing localStorage.setItem lets the update finish and done shows fw.ax.saveFailed with no card (kills A13)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    await loadPerf(perf);
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      if (k === AXIS_BACKUP_KEY) throw new DOMException('QuotaExceededError', 'QuotaExceededError');
      return realSet.call(this, k, v);
    });

    const router = makeRouter();
    await router.push('/firmware');
    const page = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));

    await startWith(s.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s.fw.phase === 'done' && !s.fw.active);
    await run(200);
    await flushPromises();

    expect(s.fw.phase).toBe('done');
    expect(s.fw.axSaveFailed).toBe(true);
    expect(s.fw.axShowSaveFailed).toBe(true);
    expect(s.fw.axShowCard).toBe(false);
    expect(page.find('[data-test="fw-ax-save-failed"]').text()).toBe(tr('fw.ax.saveFailed'));
    expect(page.find('[data-test="ax-card"]').exists()).toBe(false);
  });
});

describe('Test 2: no good read or read of another serial → no backup, step 2 shows fw.ax.noSave, Start stays enabled', { timeout: 60_000 }, () => {
  it('no perf read: shows fw.ax.noSave, canStart stays true, update saves no backup', async () => {
    const s = await demo('max');
    await s.fw.chooseFile(fileOf(MAX_FILE));
    s.fw.typed = 'AE64 Max';
    if (s.fw.needsVer) s.fw.verOk = true;
    expect(s.fw.axNoSave).toBe(true);
    expect(s.fw.canStart).toBe(true);

    const w = keep(mount(FwEnterStep, { attachTo: document.body }));
    await flushPromises();
    expect(w.find('[data-test="fw-ax-nosave"]').text()).toBe(tr('fw.ax.noSave'));
    const startBtn = w.find('button.btn--danger');
    expect(startBtn.attributes('disabled')).toBeUndefined();

    // Update still runs and saves no backup
    void s.fw.start();
    await until(() => s.fw.phase === 'done' && !s.fw.active);
    await run(200);
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();
    expect(s.fw.axShowCard).toBe(false);
  });

  it('perf read belongs to another serial: shows fw.ax.noSave, saves no backup', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    await loadPerf(perf);
    expect(s.fw.axNoSave).toBe(false);

    // Device now reports a different serial than the one perf read
    s.device.info = { ...s.device.info!, serialHex: '11223344556677889900aabb' };
    await s.fw.chooseFile(fileOf(MAX_FILE));
    s.fw.typed = 'AE64 Max';
    if (s.fw.needsVer) s.fw.verOk = true;
    expect(s.fw.axNoSave).toBe(true);
    expect(s.fw.canStart).toBe(true);

    const w = keep(mount(FwEnterStep, { attachTo: document.body }));
    await flushPromises();
    expect(w.find('[data-test="fw-ax-nosave"]').exists()).toBe(true);
  });
});

describe('Test 3: demo update with wipeAxis(), card names/counts, 0 writes before press, restore writes differing keys only (kills A1, A7)', { timeout: 60_000 }, () => {
  it('shows names/counts + fw.ax.note + secondary banner button; 0 writes before press; press writes differing keys only, verifies, removes backup', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const sync = useSyncStore();
    await loadPerf(perf);

    // Put WS Flux (custom) on W, A, S, D so the card shows two rows: UR Ice HE-Ex (60) and WS Flux custom (4)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id, A.id, S_KEY.id, D.id], 'notReplaced');
    const flushP = sync.flush();
    await run(200);
    await flushP;
    expect(perf.assignments[W.id]).toBe(FLUX.uid);

    const router = makeRouter();
    await router.push('/firmware');
    const page = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();

    // "Trước khi cập nhật" has fw.ax.note as its 3rd line
    const noteItems = page.findAll('.fw-notes > li');
    expect(noteItems[2].text()).toBe(tr('fw.ax.note'));

    // Run full update (mockFirmware calls wipeAxis() on reboot!)
    await startWith(s.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s.fw.phase === 'done' && !s.fw.active);
    for (let i = 0; i < 40 && perf.loading; i++) await run(50);
    await run(200);
    await flushPromises();

    const postTransport = s.device.transport as MockTransport;
    const writes: number[][] = [];
    postTransport.onPacketRaw((dir, b) => {
      if (dir === 'out' && b[0] === 0x04 && b[1] === 0x02) writes.push(Array.from(b));
    });

    // Simulate 2 keys (F, G) already having their saved triple so we also kill A7 (`same` keys never written)
    setMockKey(postTransport, F, { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 });
    setMockKey(postTransport, G, { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 });
    await loadPerf(perf);
    await flushPromises();

    // Card shows with 2 rows (58 UR Ice HE-Ex, 4 WS Flux custom); 0 writes before press (kills A1!)
    expect(writes).toEqual([]);
    expect(s.fw.axShowCard).toBe(true);
    expect(s.fw.axOffering).toBe(true);
    expect(s.fw.axCompare!.same.sort((a, b) => a - b)).toEqual([F.id, G.id].sort((a, b) => a - b));
    expect(s.fw.axCompare!.restore).toHaveLength(62);

    const rowTexts = page.findAll('[data-test="ax-rows"] li').map((li) => li.text());
    expect(rowTexts).toHaveLength(2);
    expect(rowTexts[0]).toContain('UR Ice HE-Ex');
    expect(rowTexts[0]).toContain(tr('fw.ax.row', { n: 58 }));
    expect(rowTexts[1]).toContain('WS Flux');
    expect(rowTexts[1]).toContain(tr('fw.ax.custom'));
    expect(rowTexts[1]).toContain(tr('fw.ax.row', { n: 4 }));

    // Banner's "Hiệu chuẩn lại" steps down to secondary while offered
    expect(page.find('.fw-ban__btn').classes()).toContain('btn--secondary');

    // Press Restore
    const goBtn = page.find('[data-test="ax-go"]');
    expect(goBtn.text()).toBe(tr('fw.ax.go', { n: 62 }));
    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    const res = await restoreP;
    await flushPromises();

    // Exactly 62 differing keys written (NOT F or G: kills A7!), verified, backup removed, assignments preserved
    expect(writes).toHaveLength(62);
    const writtenPositions = new Set(writes.map((f) => `${f[2]}:${f[3]}`));
    expect(writtenPositions.has(`${F.row}:${F.col}`)).toBe(false);
    expect(writtenPositions.has(`${G.row}:${G.col}`)).toBe(false);
    expect(res).toEqual({ restored: expect.any(Array), failed: [], cant: [], blocked: [] });
    expect(res!.restored).toHaveLength(62);

    // Result card with fw.ax.done, focus moved to result line, banner button back to primary, backup gone
    const doneEl = page.find('[data-test="ax-done"]');
    expect(doneEl.exists()).toBe(true);
    expect(doneEl.text()).toBe(tr('fw.ax.done', { n: 62 }));
    expect(document.activeElement).toBe(doneEl.element);
    expect(page.find('.fw-ban__btn').classes()).toContain('btn--primary');
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();
    // CSW assignments were never touched
    expect(perf.assignments[W.id]).toBe(FLUX.uid);
    // Hardware now holds the restored triples
    expect(perf.values[W.id]).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3500, axisCoefficient: 17536 });
    expect(perf.values[SPACE.id]).toMatchObject({ axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 });
  });

  it('read-back mismatch lists failed keys with fw.ax.fail and keeps them in the backup', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    s.t.wipeAxis();
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX);
    await loadPerf(perf);

    // Simulate firmware silently refusing the axis write on key W (returns 0/0/0 on read-back)
    const realGet = s.t.getPerformance.bind(s.t);
    let wroteW = false;
    const realSet = s.t.setPerformance.bind(s.t);
    vi.spyOn(s.t, 'setPerformance').mockImplementation(async (pos, p) => {
      if (pos.row === W.row && pos.col === W.col) wroteW = true;
      return realSet(pos, p);
    });
    vi.spyOn(s.t, 'getPerformance').mockImplementation(async (pos) => {
      const r = await realGet(pos);
      if (wroteW && pos.row === W.row && pos.col === W.col) return { ...r, axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 };
      return r;
    });

    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    const res = await restoreP;
    expect(res!.restored).toHaveLength(63);
    expect(res!.failed).toEqual([W.id]);
    // Restored keys left the backup; only W remains
    const remaining = loadBackup(readAllBackups(), s.device.info!.serialHex, FW_BOARD_MAX);
    expect(remaining).not.toBeNull();
    expect(Object.keys(remaining!.keys).map(Number)).toEqual([W.id]);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(card.find('[data-test="ax-fail"]').text()).toContain(tr('fw.ax.fail', { n: 1, keys: 'W' }));
  });
});

describe('Test 4 & Test 5: cant (guard-refused triple) and lostBefore (saved R < 1000) never sent (kills A2, A3)', { timeout: 60_000 }, () => {
  it('Test 4: unlisted id in backup → cant, never sent; "Chọn switch" selects those keys and opens Switch tab (kills A2)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const sel = useSelectionStore();
    s.t.wipeAxis();
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX, {
      overrides: { [F.id]: [0x2222, 3400, 20000], [G.id]: [0x2223, 3400, 20000] },
    });
    await loadPerf(perf);

    expect(s.fw.axCompare!.cant).toEqual([F.id, G.id].sort((a, b) => a - b));
    expect(s.fw.axCompare!.restore).toHaveLength(62);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(card.find('[data-test="ax-cant"]').text()).toContain('F, G');

    // Click "Chọn switch" → selects F & G and routes to /performance?tab=switch
    await card.find('[data-test="ax-cant"] button').trigger('click');
    await flushPromises();
    expect(sel.ids).toEqual([F.id, G.id].sort((a, b) => a - b));
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=switch');

    // Press restore: F and G are NEVER sent (kills A2)
    const sentPos: string[] = [];
    s.t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x04 && b[1] === 0x02) sentPos.push(`${b[2]}:${b[3]}`); });
    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    const res = await restoreP;
    expect(sentPos).not.toContain(`${F.row}:${F.col}`);
    expect(sentPos).not.toContain(`${G.row}:${G.col}`);
    expect(sentPos).toHaveLength(62);
    expect(res!.cant).toEqual([F.id, G.id].sort((a, b) => a - b));
  });

  it('Test 5: saved lost triple (R < 1000) → lostBefore, never sent (kills A3)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    s.t.wipeAxis();
    // Set W to a valid switch currently so it differs from its lost saved triple [0,0,0]
    setMockKey(s.t, W, { axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500 });
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX, {
      overrides: { [W.id]: [0, 0, 0], [A.id]: [12432, 500, 20000] },
    });
    await loadPerf(perf);

    expect(s.fw.axCompare!.lostBefore).toEqual([W.id, A.id].sort((a, b) => a - b));
    expect(s.fw.axCompare!.restore).toHaveLength(62);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(card.find('[data-test="ax-lost-before"]').text()).toBe(tr('fw.ax.lostBefore', { n: 2, keys: 'W, A' }));

    const sentPos: string[] = [];
    s.t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x04 && b[1] === 0x02) sentPos.push(`${b[2]}:${b[3]}`); });
    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    await restoreP;
    expect(sentPos).not.toContain(`${W.row}:${W.col}`);
    expect(sentPos).not.toContain(`${A.row}:${A.col}`);
    expect(sentPos).toHaveLength(62);
  });
});

describe('Test 6 & Test 7: all-same banner line (0 writes, backup removed) and other serial/board (kills A5)', { timeout: 60_000 }, () => {
  it('Test 6: update keeps all 64 switch values → fw.ax.same on banner, no card, 0 write HID, backup removed', async () => {
    // Do not wipe on simulated reboot (firmware preserved the switch values)
    vi.spyOn(MockTransport.prototype, 'wipeAxis').mockImplementation(() => undefined);

    const s = await runFullUpdate('max', MAX_FILE);
    const post = s.device.transport as MockTransport;
    const writes: number[][] = [];
    post.onPacketRaw((dir, b) => { if (dir === 'out' && (b[0] === 0x04 && b[1] === 0x02 || b[0] === 0x02 && b[1] === 0x02)) writes.push(Array.from(b)); });

    expect(s.fw.phase).toBe('done');
    expect(s.fw.axSame).toBe(true);
    expect(s.fw.axShowCard).toBe(false);
    expect(writes).toEqual([]);
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();

    const router = makeRouter();
    await router.push('/firmware');
    const ban = keep(mount(FwBanner, { props: { kind: 'done' }, global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(ban.find('[data-test="fw-ax-same"]').text()).toBe(tr('fw.ax.same'));
    expect(ban.find('.fw-ban__btn').classes()).toContain('btn--primary');
  });

  it('Test 7: another serial or board after the update → no card, backup stays (kills A5)', async () => {
    const serialA = '360812504339463536051657';
    seedBackup(serialA, FW_BOARD_MAX);

    // Same board (Max), different serial
    const s1 = await demo('max');
    s1.device.info = { ...s1.device.info!, serialHex: '11223344556677889900aabb' };
    s1.t.wipeAxis();
    await loadPerf(usePerformanceStore());
    expect(s1.fw.axShowCard).toBe(false);
    expect(loadBackup(readAllBackups(), serialA, FW_BOARD_MAX)).not.toBeNull();

    // Same serial as backup, different board (Pro 0030000A)
    const s2 = await demo('pro');
    expect(s2.device.info!.serialHex).toBe(serialA);
    expect(s2.device.info!.boardId).toBe(FW_BOARD_PRO);
    s2.t.wipeAxis();
    await loadPerf(usePerformanceStore());
    expect(s2.fw.axShowCard).toBe(false);
    expect(loadBackup(readAllBackups(), serialA, FW_BOARD_MAX)).not.toBeNull();
  });
});

describe('Test 8: "Để sau", reopening page, changedSince, old-backup note, failed read retry (kills A8)', { timeout: 60_000 }, () => {
  it('"Để sau" hides card and keeps backup; openPage() shows it again; user-changed key becomes changedSince; empty offer removes backup (kills A8)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const sync = useSyncStore();
    s.t.wipeAxis();
    // Seed a backup older than 24 h to also verify fw.ax.old
    const oldAt = Date.now() - AXIS_BACKUP_OLD_MS - 3_600_000;
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX, { takenAt: oldAt });
    await loadPerf(perf);
    expect(s.fw.axShowCard).toBe(true);

    // Check `after` was recorded on first good read
    const stored = loadBackup(readAllBackups(), s.device.info!.serialHex, FW_BOARD_MAX)!;
    expect(stored.after?.[W.id]).toEqual([0, 0, 0]);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(card.find('[data-test="ax-old"]').exists()).toBe(true);

    // Press "Để sau": hides card, backup stays, 0 HID
    const sent: number[][] = [];
    s.t.onPacketRaw((dir, b) => { if (dir === 'out') sent.push(Array.from(b)); });
    await card.find('[data-test="ax-later"]').trigger('click');
    await flushPromises();
    expect(s.fw.axShowCard).toBe(false);
    expect(sent).toEqual([]);
    expect(loadBackup(readAllBackups(), s.device.info!.serialHex, FW_BOARD_MAX)).not.toBeNull();

    // Reopening the page shows the card again
    s.fw.openPage();
    await flushPromises();
    expect(s.fw.axShowCard).toBe(true);

    // User changes W to WS Flux after the update → W leaves offer as changedSince (kills A8!)
    perf.applySwitch({ kind: 'custom', custom: FLUX }, [W.id]);
    const fp = sync.flush();
    await run(200);
    await fp;
    await run(50);
    await flushPromises();
    expect(s.fw.axCompare!.changedSince).toContain(W.id);
    expect(s.fw.axCompare!.restore).not.toContain(W.id);
    expect(s.fw.axCompare!.restore).toHaveLength(63);

    // Change ALL remaining 63 keys to WS Flux → nothing left to offer → backup removed
    const rest = PHYSICAL_KEYS.map((k) => k.id).filter((id) => id !== W.id);
    perf.applySwitch({ kind: 'custom', custom: FLUX }, rest);
    const fp2 = sync.flush();
    await run(2000);
    await fp2;
    await run(50);
    expect(s.fw.axShowCard).toBe(false);
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();
  });

  it('failed performance read after update shows retry card with "Thử lại", and card appears after a good read', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    s.t.wipeAxis();
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX);

    // Fail the first perf.load()
    const spy = vi.spyOn(s.t, 'getPerformance').mockRejectedValueOnce(new Error('timeout'));
    await loadPerf(perf);
    expect(perf.loadError).toBeTruthy();
    expect(s.fw.axShowCard).toBe(false);
    expect(s.fw.axReadError).toBe(true);

    const router = makeRouter();
    await router.push('/firmware');
    const page = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    const errCard = page.find('[data-test="fw-ax-read-error"]');
    expect(errCard.exists()).toBe(true);
    expect(errCard.text()).toContain(tr('fw.on.retry'));

    // Succeed on retry → restore card appears
    spy.mockRestore();
    await errCard.find('button').trigger('click');
    for (let i = 0; i < 40 && perf.loading; i++) await run(50);
    await run(100);
    await flushPromises();
    expect(s.fw.axReadError).toBe(false);
    expect(s.fw.axShowCard).toBe(true);
    expect(page.find('[data-test="ax-card"]').exists()).toBe(true);
  });
});

describe('Test 9: rescue mode with and without an earlier backup', { timeout: 60_000 }, () => {
  it('backup from an interrupted run gives the card after rescue write; no backup gives no card', async () => {
    // 1. Interrupted run saves backup before 08 01 → unplugged mid-write → rescue write → done → card appears
    const s1 = await demo('pro');
    const perf1 = usePerformanceStore();
    await loadPerf(perf1);
    s1.bus.flags.unplugAt = 50;
    await startWith(s1.fw, PRO_FILE, { typed: 'AE64 Pro' });
    await until(() => s1.fw.phase === 'rescue');
    expect(s1.fw.rescue).toBe(true);
    expect(loadBackup(readAllBackups(), s1.bus.serial.map((b) => b.toString(16).padStart(2, '0')).join(''), FW_BOARD_PRO)).not.toBeNull();

    void s1.fw.rescueWrite();
    await until(() => s1.fw.phase === 'done' && !s1.fw.active);
    for (let i = 0; i < 40 && perf1.loading; i++) await run(50);
    await run(200);
    expect(s1.fw.axShowCard).toBe(true);
    expect(s1.fw.axCompare!.restore).toHaveLength(64);

    // 2. Rescue without any prior backup → done → no card
    localStorage.clear();
    const s2 = await demo('pro');
    const perf2 = usePerformanceStore();
    s2.fw.setEnabled(true);
    s2.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s2.bus.list()).find((d) => d instanceof MockBootloader)!;
    const adoptP = s2.device.adoptFromFirmware(boot, true);
    await run(500);
    await adoptP;
    expect(s2.fw.phase).toBe('rescue');
    await s2.fw.chooseFile(fileOf(PRO_FILE));
    void s2.fw.rescueWrite();
    await until(() => s2.fw.phase === 'done' && !s2.fw.active);
    for (let i = 0; i < 40 && perf2.loading; i++) await run(50);
    await run(200);
    expect(s2.fw.axShowCard).toBe(false);
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();
  });
});

describe('Test 10: no undo entry, no export, no network request carries the backup (kills A6, A9)', { timeout: 60_000 }, () => {
  it('restore pushes no undo entry; settings export omits backup; fetch never carries it (kills A6, A9)', async () => {
    const fetchCalls: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response('{}', { status: 404 });
    }));

    const s = await demo('max');
    const perf = usePerformanceStore();
    const history = useHistoryStore();
    s.t.wipeAxis();
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX);
    await loadPerf(perf);

    // Export while backup is in localStorage: must NOT contain ae64.fw.axisBackup (kills A6)
    expect(buildExport().json).not.toContain(AXIS_BACKUP_KEY);

    // Open page (triggers list fetch) and restore
    s.fw.openPage();
    await run(50);
    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    await restoreP;

    // No undo entry (kills A9)
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    // No network call carried the backup key or serial
    for (const c of fetchCalls) {
      expect(c.url).not.toContain(AXIS_BACKUP_KEY);
      expect(c.url).not.toContain(s.device.info!.serialHex);
      expect(JSON.stringify(c.init ?? {})).not.toContain(AXIS_BACKUP_KEY);
    }
  });
});

describe('Test 11: distances fitted to saved R (review C2, kills A10)', { timeout: 60_000 }, () => {
  it('after wipeAxis(), normalPress 3.6 and pressDeadStroke 3.5 with saved R=3390 → fitted, fw.ax.fit shown, press writes 3.39 and 1.0, restored (kills A10)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    s.t.wipeAxis();
    setMockKey(s.t, SPACE, { normalPress: 3.6, normalRelease: 3.6, pressDeadStroke: 3.5 });
    // Saved R = 3390 (Magnetic Jade Pro 4128 / 3390 / 20000) on Space
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX, {
      overrides: { [SPACE.id]: [4128, 3390, 20000] },
    });
    await loadPerf(perf);

    expect(s.fw.axCompare!.restore).toContain(SPACE.id);
    expect(s.fw.axCompare!.fitted).toEqual([SPACE.id]);

    // Without fitTravel (mutant A10), the guard refuses Space!
    const unfitted = { ...perf.values[SPACE.id], axisV2Id: 4128, axisRangeMax: 3390, axisCoefficient: 20000 };
    expect(checkPerformanceWrite(unfitted, perf.seenFor(SPACE.id), { intervalRt: true, boardIdHex: '0030000d' })).not.toBeNull();

    // Card shows fw.ax.fit naming Space BEFORE the press (vi and en)
    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(card.find('[data-test="ax-fitted"]').text()).toBe(tr('fw.ax.fit', { n: 1, keys: 'Space' }));
    locale.value = 'en';
    await flushPromises();
    expect(card.find('[data-test="ax-fitted"]').text()).toContain('On 1 key');
    expect(card.find('[data-test="ax-fitted"]').text()).toContain('Space');
    locale.value = 'vi';

    // Press restore: writes 3.39 and 1.0 (not 3.6 / 3.5 / 3.39), guard accepts, read-back marks restored
    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    const res = await restoreP;
    await flushPromises();
    expect(res!.restored).toContain(SPACE.id);
    expect(res!.failed).toEqual([]);
    expect(res!.blocked).toEqual([]);
    expect(perf.values[SPACE.id]).toMatchObject({
      axisV2Id: 4128,
      axisRangeMax: 3390,
      axisCoefficient: 20000,
      normalPress: 3.39,
      normalRelease: 3.39,
      pressDeadStroke: 1.0,
    });
    // Result card does NOT repeat the fitted line
    expect(card.find('[data-test="ax-done"]').exists()).toBe(true);
    expect(card.find('[data-test="ax-fitted"]').exists()).toBe(false);
  });
});

describe('Test 12: blocked key (unknown mode 7) → fw.ax.blocked, Travel tab, never cant, moves to restore when fixed (kills A11)', { timeout: 60_000 }, () => {
  it('mode 7 with restorable saved triple lands in blocked (not cant), opens Travel tab, never sent, moves to restore after mode=1 read (kills A11)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const sel = useSelectionStore();
    s.t.wipeAxis();
    setMockKey(s.t, W, { mode: 7 });
    seedBackup(s.device.info!.serialHex, FW_BOARD_MAX);
    await loadPerf(perf);

    expect(s.fw.axCompare!.blocked).toEqual([W.id]);
    expect(s.fw.axCompare!.cant).toEqual([]);
    expect(s.fw.axCompare!.restore).not.toContain(W.id);
    expect(s.fw.axCompare!.restore).toHaveLength(63);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    expect(card.find('[data-test="ax-blocked"]').text()).toContain(tr('fw.ax.blocked', { n: 1, keys: 'W' }));
    expect(card.find('[data-test="ax-cant"]').exists()).toBe(false);

    // Click "Mở tab Hành trình" → selects W and routes to /performance?tab=travel
    await card.find('[data-test="ax-blocked"] button').trigger('click');
    await flushPromises();
    expect(sel.ids).toEqual([W.id]);
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=travel');

    // Never sent if user restores the other 63 keys
    const sentPos: string[] = [];
    s.t.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x04 && b[1] === 0x02) sentPos.push(`${b[2]}:${b[3]}`); });
    const restoreP = s.fw.restoreSwitchValues();
    await run(2000);
    const res = await restoreP;
    expect(sentPos).not.toContain(`${W.row}:${W.col}`);
    expect(sentPos).toHaveLength(63);
    expect(res!.blocked).toEqual([W.id]);
    expect(res!.cant).toEqual([]);

    // Reopen Firmware page, fix mode back to 1 on mock, read again → W moves from blocked to restore!
    s.fw.openPage();
    await flushPromises();
    expect(s.fw.axCompare!.blocked).toEqual([W.id]);
    setMockKey(s.t, W, { mode: 1 });
    await loadPerf(perf);
    await flushPromises();
    expect(s.fw.axCompare!.blocked).toEqual([]);
    expect(s.fw.axCompare!.restore).toEqual([W.id]);
  });
});

describe('AxisRestoreCard row names follow switchIdentity on the saved triple (kills mutant: row name trusts a stale assignment)', { timeout: 60_000 }, () => {
  it('stale custom assignment whose R/c differ from saved listed triple shows the list name without fw.ax.custom; matching custom triple shows custom row with badge', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const serial = s.device.info!.serialHex;
    s.t.wipeAxis();

    // All 4 keys W/A/S/D (16/29/30/31) carry assignment r-wuque-ws-flux-clacky (R=3500, c=17536).
    setAssignments(serial, [W.id, A.id, S_KEY.id, D.id], FLUX.uid);

    // Case 1: every saved triple in backup is UR Ice [12432, 3310, 20500] (so all 4 assignments are stale)
    seedBackup(serial, FW_BOARD_MAX);
    await loadPerf(perf);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();

    const rowsStale = card.findAll('[data-test="ax-rows"] li');
    expect(rowsStale).toHaveLength(1);
    expect(rowsStale[0].text()).toContain('UR Ice HE-Ex');
    expect(rowsStale[0].text()).toContain(tr('fw.ax.row', { n: 64 }));
    expect(rowsStale[0].text()).not.toContain('WS Flux');
    expect(rowsStale[0].text()).not.toContain(tr('fw.ax.custom'));
    expect(rowsStale[0].find('.ax__sw--custom').exists()).toBe(false);

    // Case 2: W/A stay stale (saved UR Ice), S/D have saved WS Flux triple [12432, 3500, 17536] matching their assignment
    seedBackup(serial, FW_BOARD_MAX, {
      overrides: { [S_KEY.id]: [12432, 3500, 17536], [D.id]: [12432, 3500, 17536] },
    });
    s.fw.refreshAxisBackup();
    await flushPromises();

    const rowsMixed = card.findAll('[data-test="ax-rows"] li');
    expect(rowsMixed).toHaveLength(2);
    expect(rowsMixed[0].text()).toContain('UR Ice HE-Ex');
    expect(rowsMixed[0].text()).toContain(tr('fw.ax.row', { n: 62 }));
    expect(rowsMixed[0].text()).not.toContain(tr('fw.ax.custom'));
    expect(rowsMixed[0].find('.ax__sw--custom').exists()).toBe(false);

    expect(rowsMixed[1].text()).toContain('WS Flux');
    expect(rowsMixed[1].text()).toContain(tr('fw.ax.custom'));
    expect(rowsMixed[1].text()).toContain(tr('fw.ax.row', { n: 2 }));
    expect(rowsMixed[1].find('.ax__sw--custom').exists()).toBe(true);
  });
});

describe('Test 12b: press-time refusal splits triple failure (cant) from non-triple failure (blocked)', { timeout: 60_000 }, () => {
  it('classifies a press-time refusal with a failing triple under cant and a fine triple under blocked (kills A11b: a press-time refusal of a fine triple is listed under cant)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const serial = s.device.info!.serialHex;
    s.t.wipeAxis();

    // Key F currently reports unlisted id 0x5555 (R=3400) and has saved custom triple [0x5555, 3500, 17536],
    // so pre-press compare accepts both F (via isCustomTriple matching cur.axisV2Id) and W (listed UR Ice).
    setMockKey(s.t, F, { axisV2Id: 0x5555, axisRangeMax: 3400, axisCoefficient: 20000 });
    seedBackup(serial, FW_BOARD_MAX, {
      overrides: { [F.id]: [0x5555, 3500, 17536] },
    });
    await loadPerf(perf);

    expect(s.fw.axCompare!.restore).toHaveLength(64);
    expect(s.fw.axCompare!.cant).toEqual([]);
    expect(s.fw.axCompare!.blocked).toEqual([]);

    const router = makeRouter();
    await router.push('/firmware');
    const card = keep(mount(AxisRestoreCard, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();

    // At press time, the write path refuses F (whose reported id changed away from 0x5555 so its saved triple
    // now fails tripleOk) and W (whose saved listed triple is still fine, refused for another guard rule).
    vi.spyOn(perf, 'restoreAxis').mockImplementationOnce(async (records) => {
      const ids = Object.keys(records).map(Number).sort((a, b) => a - b);
      expect(ids).toContain(F.id);
      expect(ids).toContain(W.id);
      perf.values = {
        ...perf.values,
        [F.id]: { ...perf.values[F.id], axisV2Id: 0, axisRangeMax: 0, axisCoefficient: 0 },
      };
      return {
        restored: ids.filter((id) => id !== F.id && id !== W.id),
        failed: [],
        refused: [
          { id: F.id, reason: 'switch fields axisV2Id/axisRangeMax/axisCoefficient' },
          { id: W.id, reason: 'mode 7 is not a known key mode' },
        ],
      };
    });

    const res = await s.fw.restoreSwitchValues();
    await flushPromises();

    expect(res!.cant).toEqual([F.id]);
    expect(res!.blocked).toEqual([W.id]);
    expect(res!.failed).toEqual([]);
    expect(res!.restored).toHaveLength(62);
    expect(res!.restored).not.toContain(F.id);
    expect(res!.restored).not.toContain(W.id);

    const cantRow = card.find('[data-test="ax-cant"]');
    expect(cantRow.exists()).toBe(true);
    expect(cantRow.text()).toContain(tr('fw.ax.cant', { n: 1, keys: 'F' }));
    expect(cantRow.find('button').text()).toBe(tr('fw.ax.pick'));

    const blockedRow = card.find('[data-test="ax-blocked"]');
    expect(blockedRow.exists()).toBe(true);
    expect(blockedRow.text()).toContain(tr('fw.ax.blocked', { n: 1, keys: 'W' }));
    expect(blockedRow.find('button').text()).toBe(tr('fw.ax.openTravel'));

    // Backup drops the 62 restored keys and still holds both refused keys
    const remaining = loadBackup(readAllBackups(), serial, FW_BOARD_MAX);
    expect(remaining).not.toBeNull();
    expect(Object.keys(remaining!.keys).map(Number).sort((a, b) => a - b)).toEqual([F.id, W.id].sort((a, b) => a - b));
  });
});

describe('CSW-R1: evaluateAxisBackup runs in non-done inactive phases (enterFail, appBack)', { timeout: 60_000 }, () => {
  it('enterFail: removes backup on fresh perf read so a later switch Apply + clear() never offers to undo it (kills CSW-R1 phase-gate mutant)', async () => {
    const s = await demo('max');
    const perf = usePerformanceStore();
    const sync = useSyncStore();
    const serial = s.device.info!.serialHex;
    await loadPerf(perf);

    // Trigger enterFail after preflight saved the backup (before 08 01)
    s.bus.flags.enterFail = true;
    await startWith(s.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s.fw.phase === 'enterFail' && !s.fw.active);
    expect(s.fw.phase).toBe('enterFail');
    expect(s.fw.active).toBe(false);
    expect(s.device.connected).toBe(true);
    // adoptFromFirmware bumped device.connection and cleared perf.loadedSerial, so pre-update read is never reused
    expect(perf.loadedSerial).toBeNull();
    expect(loadBackup(readAllBackups(), serial, FW_BOARD_MAX)).not.toBeNull();

    // Fresh read on the reconnected keyboard (still in phase 'enterFail'): all 64 keys match the backup → removed at once
    await loadPerf(perf);
    await flushPromises();
    expect(loadBackup(readAllBackups(), serial, FW_BOARD_MAX)).toBeNull();
    expect(localStorage.getItem(AXIS_BACKUP_KEY)).toBeNull();
    expect(s.fw.axShowCard).toBe(false);
    expect(s.fw.axCompare).toBeNull();
    expect(s.fw.axSame).toBe(false);

    // User now changes W to another listed switch (Magnetic Jade Pro, id 4128)
    const jade = perf.catalog!.find((e) => e.id === 4128)!;
    expect(jade).toBeDefined();
    const applied = perf.applySwitch({ kind: 'catalog', entry: jade }, [W.id]);
    expect(applied.status).toBe('applied');
    const flushP = sync.flush();
    await run(200);
    await flushP;
    await flushPromises();
    expect(perf.values[W.id].axisV2Id).toBe(4128);

    // Clear back to idle and re-evaluate: no restore card, no fw.ax.same, and 0 HID from evaluation
    s.fw.clear();
    expect(s.fw.phase).toBe('idle');
    const evalFrames: number[][] = [];
    (s.device.transport as MockTransport).onPacketRaw((dir, b) => { if (dir === 'out') evalFrames.push(Array.from(b)); });
    s.fw.refreshAxisBackup();
    await flushPromises();
    expect(s.fw.axShowCard).toBe(false);
    expect(s.fw.axCompare).toBeNull();
    expect(s.fw.axSame).toBe(false);
    expect(evalFrames).toEqual([]);
  });

  it('appBack: lost mid-write then keyboard returns in its app — fresh perf.load() captures true after, removes unchanged backup, and never sets axSame', async () => {
    // 1. Reconnected app still has intact switches equal to the backup → backup removed on fresh load, axSame stays false
    const s1 = await demo('max');
    const perf1 = usePerformanceStore();
    const serial1 = s1.device.info!.serialHex;
    await loadPerf(perf1);

    s1.bus.flags.unplugAt = 50;
    s1.bus.flags.lostIntoApp = true;
    await startWith(s1.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s1.fw.phase === 'appBack' && !s1.fw.active);
    expect(s1.fw.phase).toBe('appBack');
    expect(s1.fw.active).toBe(false);
    expect(s1.device.connected).toBe(true);
    expect(perf1.loadedSerial).toBeNull();
    // Backup is still present before the fresh read (pre-update read was cleared on reconnect)
    expect(loadBackup(readAllBackups(), serial1, FW_BOARD_MAX)).not.toBeNull();

    await loadPerf(perf1);
    await flushPromises();
    expect(loadBackup(readAllBackups(), serial1, FW_BOARD_MAX)).toBeNull();
    expect(s1.fw.axShowCard).toBe(false);
    expect(s1.fw.axSame).toBe(false);

    // 2. Reconnected app came back with wiped switches → fresh perf.load() records true `after` in appBack, axSame stays false
    localStorage.clear();
    const s2 = await demo('max');
    const perf2 = usePerformanceStore();
    const serial2 = s2.device.info!.serialHex;
    await loadPerf(perf2);

    s2.bus.flags.unplugAt = 50;
    s2.bus.flags.lostIntoApp = true;
    await startWith(s2.fw, MAX_FILE, { typed: 'AE64 Max' });
    await until(() => s2.fw.phase === 'appBack' && !s2.fw.active);
    expect(s2.fw.phase).toBe('appBack');
    (s2.device.transport as MockTransport).wipeAxis();

    await loadPerf(perf2);
    await flushPromises();
    const stored = loadBackup(readAllBackups(), serial2, FW_BOARD_MAX);
    expect(stored).not.toBeNull();
    expect(stored!.after?.[W.id]).toEqual([0, 0, 0]);
    expect(s2.fw.axShowCard).toBe(true);
    expect(s2.fw.axCompare!.restore).toHaveLength(64);
    expect(s2.fw.axSame).toBe(false);
  });
});
