import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import AdvancedPage from '../src/pages/AdvancedPage.vue';
import { MockTransport, SAVE_GROUP } from '../src/protocol';
import type { Performance, PhysicalKey } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { t as tr } from '../src/i18n/vi';
import { PermanentSyncError, useSyncStore } from '../src/stores/sync';
import { clearTuningSnapshots, getTuningSnapshot, setTuningSnapshot, tuningSnapshotsFor } from '../src/stores/tuning';
import {
  AdvancedConflictError, KEYBOARD_CODES, assignmentsFrom, fixUnusedStage3, mptBounds, normalizeDksMask, normalizeMptDepths, pickPairKey,
  setDksCell, swapPair, useAdvancedStore, validateAssignment,
} from '../src/stores/advanced';
import type { DksAssignment, MptAssignment, RsAssignment, SocdAssignment } from '../src/stores/advanced';

async function setup(profile = 0) {
  setActivePinia(createPinia());
  clearTuningSnapshots(); // module state outlives a pinia; a real new connection clears it
  const device = useDeviceStore();
  await device.connectDemo();
  if (profile) await device.switchProfile(profile);
  const mock = device.transport as MockTransport;
  const adv = useAdvancedStore();
  await adv.load();
  const key = (name: string): PhysicalKey => device.keys.find((k) => k.name === name)!;
  return { device, mock, adv, key };
}

/** Make the mock behave like the firmware: an advanced write resets the key's Hall tuning. */
function resetTuningOnAdvancedWrite(mock: MockTransport) {
  const reset = async (pos: { row: number; col: number }) => {
    const p = await mock.getPerformance(pos);
    await mock.setPerformance(pos, { ...p, mode: 0, normalPress: 2, rtFirstTouch: 2, rtPress: 0.5, rtRelease: 0.5, pressDeadStroke: 0, releaseDeadStroke: 0 });
  };
  for (const m of ['setDks', 'setMpt'] as const) {
    const orig = mock[m].bind(mock) as (a: { pos: { row: number; col: number } }) => Promise<unknown>;
    vi.spyOn(mock, m).mockImplementation((async (a: { pos: { row: number; col: number } }) => {
      const r = await orig(a);
      await reset(a.pos);
      return r;
    }) as never);
  }
  for (const m of ['setSocdPair', 'setRappySnappyPair'] as const) {
    const orig = mock[m].bind(mock) as (a: { first: { row: number; col: number }; second: { row: number; col: number } }) => Promise<unknown>;
    vi.spyOn(mock, m).mockImplementation((async (a: { first: { row: number; col: number }; second: { row: number; col: number } }) => {
      const r = await orig(a);
      await reset(a.first);
      await reset(a.second);
      return r;
    }) as never);
  }
  const clear = mock.clearAdvanced.bind(mock);
  vi.spyOn(mock, 'clearAdvanced').mockImplementation(async (pos) => {
    await clear(pos);
    await reset(pos);
  });
}

describe('advanced store', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  it('loads all 64 keys and lists a SOCD pair once with its UI mode', async () => {
    const { adv, key } = await setup(1);
    expect(adv.loadedCount).toBe(64);
    expect(adv.assignments).toHaveLength(1);
    const a = adv.assignments[0] as SocdAssignment;
    expect(a.type).toBe('SOCD');
    expect([...a.keys].sort()).toEqual([key('A').id, key('D').id].sort());
    expect(a.mode).toBe(0);
    expect(adv.byKey.get(key('D').id)).toBe(a);
  });

  it('DKS: write → commit ADVANCED → read-back verify → Hall restore → commit PERFORMANCE', async () => {
    const { adv, mock, key } = await setup();
    const host = key('F');
    const order: string[] = [];
    const commit = vi.spyOn(mock, 'commit').mockImplementation(async (g) => { order.push(`commit:${g}`); });
    const origDks = mock.setDks.bind(mock);
    vi.spyOn(mock, 'setDks').mockImplementation(async (a) => { order.push('setDks'); return origDks(a); });
    const origPerf = mock.setPerformance.bind(mock);
    vi.spyOn(mock, 'setPerformance').mockImplementation(async (pos, p) => { order.push('setPerformance'); return origPerf(pos, p); });

    const dks: DksAssignment = { type: 'DKS', keys: [host.id], keycodes: [0x04, 0x2c, 0, 0], travels: [0xff, 0x01, 0, 0], dbs: [1.2, 2.8] };
    await adv.save(dks);

    expect(order).toEqual(['setDks', `commit:${SAVE_GROUP.ADVANCED}`, 'setPerformance', `commit:${SAVE_GROUP.PERFORMANCE}`]);
    expect(commit).toHaveBeenCalledTimes(2);
    const rec = await mock.getAdvanced(host);
    expect(rec).toMatchObject({ type: 'DKS', keycodes: [0x04, 0x2c, 0, 0], travels: [0xff, 0x01, 0, 0] });
    if (rec.type === 'DKS') expect(rec.deadzones).toEqual([1.2, 2.8]);
    expect(adv.byKey.get(host.id)?.type).toBe('DKS');
  });

  it('restores the Hall tuning the firmware resets (MPT)', async () => {
    const { adv, mock, key, device } = await setup(1); // FPS profile: W is Rapid Trigger 0.3 / 0.1 / 0.1
    resetTuningOnAdvancedWrite(mock);
    const host = key('W');
    const before: Performance = await device.withTransport((t) => t.getPerformance(host));
    expect(before.mode).toBe(1);

    const mpt: MptAssignment = { type: 'MPT', keys: [host.id], keycodes: [0x1a, 0x08, 0], depths: [0.5, 1.2, 2.0] };
    await adv.save(mpt);

    const after = await mock.getPerformance(host);
    expect(after).toEqual(before);
    expect(await mock.getAdvanced(host)).toMatchObject({ type: 'MPT', keycodes: [0x1a, 0x08, 0], depths: [0.5, 1.2, 2.0] });
  });

  it('refuses to overwrite a key that belongs to another assignment', async () => {
    const { adv, mock, key } = await setup(1);
    const setDks = vi.spyOn(mock, 'setDks');
    const dks: DksAssignment = { type: 'DKS', keys: [key('A').id], keycodes: [0x04, 0, 0, 0], travels: [0xff, 0, 0, 0], dbs: [1.5, 3] };
    await expect(adv.save(dks)).rejects.toBeInstanceOf(AdvancedConflictError);
    try { await adv.save(dks); } catch (e) { expect((e as AdvancedConflictError).conflict.type).toBe('SOCD'); }
    expect(setDks).not.toHaveBeenCalled();

    // The device itself is also checked: a record the store did not know about stops the write.
    const f = key('F');
    await mock.setMpt({ pos: f, keycodes: [4, 5, 0], depths: [0.5, 1, 1.5] });
    await expect(adv.save({ ...dks, keys: [f.id] })).rejects.toThrow();
    expect(setDks).not.toHaveBeenCalled();
    expect(await mock.getAdvanced(f)).toMatchObject({ type: 'MPT' });
  });

  it('SOCD writes reciprocal records with the paired mode bytes and verifies both', async () => {
    const { adv, mock, key } = await setup();
    const [a, b] = [key('J'), key('L')];
    const socd: SocdAssignment = { type: 'SOCD', keys: [a.id, b.id], keycodes: [0x0d, 0x0f], delay: 5, mode: 1 };
    await adv.save(socd);
    expect(await mock.getAdvanced(a)).toEqual({ mode: 6, row: a.row, col: a.col, type: 'SOCD', pairedRow: b.row, pairedCol: b.col, keycodes: [0x0d, 0x0f], delay: 5, socdMode: 1 });
    expect(await mock.getAdvanced(b)).toEqual({ mode: 6, row: b.row, col: b.col, type: 'SOCD', pairedRow: a.row, pairedCol: a.col, keycodes: [0x0f, 0x0d], delay: 5, socdMode: 2 });
    expect(adv.assignments).toHaveLength(1);
    expect(adv.assignments[0]).toMatchObject({ type: 'SOCD', mode: 1, delay: 5 });
  });

  it('editing a pair onto a new key clears the key that left; delete clears both; undo restores', async () => {
    const { adv, mock, key } = await setup();
    resetTuningOnAdvancedWrite(mock);
    const [a, b, c] = [key('J'), key('K'), key('L')];
    const rs: RsAssignment = { type: 'RS', keys: [a.id, b.id], keycodes: [0x0d, 0x0e], delay: 0 };
    await adv.save(rs);
    const moved: RsAssignment = { ...rs, keys: [a.id, c.id], keycodes: [0x0d, 0x0f] };
    await adv.save(moved, rs);
    expect((await mock.getAdvanced(b)).type).toBe('NONE');
    expect(await mock.getAdvanced(c)).toMatchObject({ type: 'RS', pairedRow: a.row, pairedCol: a.col, keycodes: [0x0f, 0x0d] });

    const tuningBefore = await mock.getPerformance(c);
    await adv.remove(adv.byKey.get(a.id)!);
    expect((await mock.getAdvanced(a)).type).toBe('NONE');
    expect((await mock.getAdvanced(c)).type).toBe('NONE');
    expect(await mock.getPerformance(c)).toEqual(tuningBefore);
    expect(adv.assignments).toHaveLength(0);

    useHistoryStore().undo();
    await (await import('../src/stores/sync')).useSyncStore().flush();
    expect(await mock.getAdvanced(c)).toMatchObject({ type: 'RS' });
  });

  it('rejects invalid drafts before touching the device', async () => {
    const { adv, mock, key } = await setup();
    const setMpt = vi.spyOn(mock, 'setMpt');
    const host = key('G');
    await expect(adv.save({ type: 'MPT', keys: [host.id], keycodes: [4, 0, 0], depths: [0.5, 1, 1.5] })).rejects.toThrow();
    await expect(adv.save({ type: 'MPT', keys: [host.id], keycodes: [4, 4, 0], depths: [0.5, 1, 1.5] })).rejects.toThrow();
    await expect(adv.save({ type: 'MPT', keys: [host.id], keycodes: [4, 5, 0], depths: [0.5, 9, 9] })).rejects.toThrow();
    await expect(adv.save({ type: 'MPT', keys: [host.id], keycodes: [4, 0xe7, 0], depths: [0.5, 1, 1.5] })).rejects.toThrow(); // RWin not in MPT palette
    expect(setMpt).not.toHaveBeenCalled();
  });
});

describe('advanced store: failed writes', () => {
  beforeEach(() => vi.useRealTimers());
  afterEach(() => vi.restoreAllMocks());

  const dksOn = (id: number): DksAssignment => ({ type: 'DKS', keys: [id], keycodes: [0x04, 0x2c, 0, 0], travels: [0xff, 0x01, 0, 0], dbs: [1.2, 2.8] });

  it('a failed create is rolled back, leaves no history entry, and saving again really writes', async () => {
    const { adv, mock, key } = await setup();
    const host = key('K');
    vi.spyOn(mock, 'setDks').mockRejectedValue(new Error('usb'));
    await expect(adv.save(dksOn(host.id))).rejects.toThrow();
    vi.restoreAllMocks();
    expect(adv.byKey.get(host.id)).toBeUndefined();
    expect((await mock.getAdvanced(host)).type).toBe('NONE');
    expect(useHistoryStore().undoLabel).toBeNull();

    await adv.save(dksOn(host.id));
    expect(await mock.getAdvanced(host)).toMatchObject({ type: 'DKS', keycodes: [0x04, 0x2c, 0, 0] });
    expect(adv.byKey.get(host.id)?.type).toBe('DKS');
    expect(useHistoryStore().undoLabel).not.toBeNull();
  });

  it('a failed delete keeps the binding in the list', async () => {
    const { adv, mock, key } = await setup();
    const host = key('K');
    await adv.save(dksOn(host.id));
    vi.spyOn(mock, 'clearAdvanced').mockRejectedValue(new Error('usb'));
    await expect(adv.remove(adv.byKey.get(host.id)!)).rejects.toThrow();
    expect(adv.byKey.get(host.id)?.type).toBe('DKS');
    expect((await mock.getAdvanced(host)).type).toBe('DKS');
  });

  it('a save that matches an unwritten optimistic record flushes instead of returning early', async () => {
    const { adv, mock, key } = await setup();
    const [j, k] = [key('J'), key('K')];
    const first = dksOn(j.id);
    await adv.save(first);
    const moved = { ...first, keys: [k.id] as [number] };
    await adv.save(moved, adv.byKey.get(j.id)!);
    useHistoryStore().undo(); // J's binding is shown again, its write is only queued
    expect((await mock.getAdvanced(j)).type).toBe('NONE');
    await adv.save(first); // same as what is shown: must still wait for the write
    expect(await mock.getAdvanced(j)).toMatchObject({ type: 'DKS' });

    useHistoryStore().undo(); // queued again (undo of the save on J … back to K)
    vi.spyOn(mock, 'setDks').mockRejectedValue(new Error('usb'));
    await expect(adv.save(moved)).rejects.toThrow();
  });

  it('A1: a transient read error during verify after the write is retried and the Hall tuning is restored', async () => {
    const { device, mock, adv, key } = await setup(1);
    resetTuningOnAdvancedWrite(mock);
    const host = key('W');
    const before = await device.withTransport((t) => t.getPerformance(host));
    expect(before.mode).toBe(1);
    const origGet = mock.getAdvanced.bind(mock);
    let calls = 0;
    vi.spyOn(mock, 'getAdvanced').mockImplementation(async (pos) => {
      calls++;
      if (calls === 2) throw new Error('usb hiccup'); // the verify read-back, after write + commit
      return origGet(pos);
    });
    const mpt: MptAssignment = { type: 'MPT', keys: [host.id], keycodes: [0x1a, 0x08, 0], depths: [0.5, 1.2, 2.0] };
    await adv.save(mpt);
    expect(await origGet(host)).toMatchObject({ type: 'MPT', keycodes: [0x1a, 0x08, 0], depths: [0.5, 1.2, 2.0] });
    expect(await mock.getPerformance(host)).toEqual(before);
    expect(adv.byKey.get(host.id)?.type).toBe('MPT');
    expect(useSyncStore().state).toBe('saved');
  });

  it('a partial write (clear done, next write fails once) is retried: binding written, ORIGINAL tuning restored', async () => {
    const { adv, mock, key } = await setup();
    resetTuningOnAdvancedWrite(mock);
    const [j, k, l] = [key('J'), key('K'), key('L')];
    const original: Performance[] = [];
    for (const pos of [j, k, l]) {
      const p = await mock.getPerformance(pos);
      const tuned: Performance = { ...p, mode: 1, normalPress: 1.3, rtPress: 0.3, rtRelease: 0.2 };
      await mock.setPerformance(pos, tuned);
      original.push(await mock.getPerformance(pos));
    }
    expect(original[0].normalPress).not.toBe(2);
    const rs: RsAssignment = { type: 'RS', keys: [j.id, k.id], keycodes: [0x0d, 0x0e], delay: 0 };
    await adv.save(rs);
    // the first save itself reset the tuning and restored it
    expect(await mock.getPerformance(j)).toEqual(original[0]);

    const moved: RsAssignment = { ...rs, keys: [j.id, l.id], keycodes: [0x0d, 0x0f] };
    vi.spyOn(mock, 'setRappySnappyPair').mockRejectedValueOnce(new Error('usb')); // after clearAdvanced(K) succeeded
    await adv.save(moved, rs);
    expect((await mock.getAdvanced(k)).type).toBe('NONE');
    expect(await mock.getAdvanced(l)).toMatchObject({ type: 'RS', pairedRow: j.row, pairedCol: j.col });
    for (const [i, pos] of [j, k, l].entries()) expect(await mock.getPerformance(pos)).toEqual(original[i]);
  });

  it('a job that replaces an unfinished, touched one inherits its tuning snapshot', async () => {
    const { device, mock, adv, key } = await setup(1);
    resetTuningOnAdvancedWrite(mock);
    const perf = usePerformanceStore();
    const host = key('W');
    const before = await device.withTransport((t) => t.getPerformance(host));
    const origGet = mock.getAdvanced.bind(mock);
    const origSet = (vi.mocked(mock.setMpt).getMockImplementation() ?? mock.setMpt.bind(mock)) as unknown as (a: unknown) => Promise<unknown>;
    let wrote = false;
    vi.spyOn(mock, 'setMpt').mockImplementation((async (a: unknown) => { wrote = true; return origSet(a); }) as never);
    let failing = true;
    vi.spyOn(mock, 'getAdvanced').mockImplementation(async (pos) => {
      if (failing && wrote) throw new Error('usb');
      return origGet(pos);
    });
    perf.loadedProfile = 1;
    const first: MptAssignment = { type: 'MPT', keys: [host.id], keycodes: [0x1a, 0x08, 0], depths: [0.5, 1.2, 2.0] };
    await expect(adv.save(first)).rejects.toThrow();
    // given up after being written: no pretence that the old state is on the keyboard, perf store marked stale, label names the keys
    expect(adv.byKey.get(host.id)?.type).toBe('MPT');
    expect(perf.loadedProfile).toBeNull();
    expect(useSyncStore().lastError).toContain(tr('advanced.jobLabelReset', { keys: 'W' }));
    expect((await mock.getPerformance(host)).mode).toBe(0); // reset by the firmware, never restored

    failing = false;
    // Nor could the keys be re-read: the page shows "read again" (the snapshot outlives the reload).
    await vi.waitFor(() => expect(adv.loadError).toBe(tr('advanced.notLoaded')));
    await adv.load(true);
    await adv.save({ ...first, depths: [0.6, 1.3, 2.1] });
    expect(await mock.getAdvanced(host)).toMatchObject({ type: 'MPT', depths: [0.6, 1.3, 2.1] });
    expect(await mock.getPerformance(host)).toEqual(before);
  });

  /** MPT on W is written (the firmware resets W's tuning), never verified, and given up. Returns W's original tuning. */
  async function dropTouchedMpt() {
    const ctx = await setup(1);
    resetTuningOnAdvancedWrite(ctx.mock);
    const host = ctx.key('W');
    const before = await ctx.device.withTransport((t) => t.getPerformance(host));
    const origGet = ctx.mock.getAdvanced.bind(ctx.mock);
    const origSet = (vi.mocked(ctx.mock.setMpt).getMockImplementation() ?? ctx.mock.setMpt.bind(ctx.mock)) as unknown as (a: unknown) => Promise<unknown>;
    let wrote = false;
    let failing = true;
    vi.spyOn(ctx.mock, 'setMpt').mockImplementation((async (a: unknown) => { wrote = true; return origSet(a); }) as never);
    vi.spyOn(ctx.mock, 'getAdvanced').mockImplementation(async (pos) => {
      if (failing && wrote) throw new Error('usb');
      return origGet(pos);
    });
    const first: MptAssignment = { type: 'MPT', keys: [host.id], keycodes: [0x1a, 0x08, 0], depths: [0.5, 1.2, 2.0] };
    await expect(ctx.adv.save(first)).rejects.toThrow();
    expect((await ctx.mock.getPerformance(host)).mode).toBe(0); // reset by the firmware, never restored
    failing = false;
    // The keys could not be re-read after the drop: the page shows "read again", and the user clicks it.
    await vi.waitFor(() => expect(ctx.adv.loadError).toBe(tr('advanced.notLoaded')));
    await ctx.adv.load(true);
    return { ...ctx, host, before };
  }

  it('a touched, dropped job on W: a later SOCD on W+E still restores W\'s ORIGINAL tuning', async () => {
    const { adv, mock, key, host, before } = await dropTouchedMpt();
    const e = key('E');
    const eBefore = await mock.getPerformance(e);
    await adv.save({ type: 'SOCD', keys: [host.id, e.id], keycodes: [0x1a, 0x08], delay: 5, mode: 0 }, adv.byKey.get(host.id)!);
    expect(await mock.getAdvanced(host)).toMatchObject({ type: 'SOCD' });
    expect(await mock.getPerformance(host)).toEqual(before);
    expect(await mock.getPerformance(e)).toEqual(eBefore);
  });

  it('a verified hand edit of the key clears the snapshot: a later advanced save restores the hand-edited tuning', async () => {
    const { adv, mock, host } = await dropTouchedMpt();
    const perf = usePerformanceStore();
    await perf.load(true);
    perf.apply([host.id], () => ({ normalPress: 1.0 }), 'test');
    await useSyncStore().flush();
    const edited = await mock.getPerformance(host);
    expect(edited.normalPress).toBe(1);

    await adv.save({ type: 'MPT', keys: [host.id], keycodes: [0x1a, 0x08, 0], depths: [0.6, 1.3, 2.1] });
    expect(await mock.getAdvanced(host)).toMatchObject({ type: 'MPT', depths: [0.6, 1.3, 2.1] });
    expect(await mock.getPerformance(host)).toEqual(edited);
  });

  it('an undo that is written in part and then given up re-reads the keys: the list shows what the board has', async () => {
    const { adv, mock, key } = await setup();
    const [j, k] = [key('J'), key('K')];
    const rs: RsAssignment = { type: 'RS', keys: [j.id, k.id], keycodes: [0x0d, 0x0e], delay: 0 };
    await adv.save(rs);
    await adv.remove(adv.byKey.get(j.id)!);
    vi.spyOn(mock, 'setRappySnappyPair').mockRejectedValue(new Error('usb'));
    useHistoryStore().undo(); // puts RS back optimistically; the write keeps failing until the job is dropped
    expect(adv.byKey.get(j.id)?.type).toBe('RS');
    const sync = useSyncStore();
    for (let i = 0; i < 3; i++) await sync.flush().catch(() => undefined);
    await vi.waitFor(() => expect(adv.byKey.get(j.id)).toBeUndefined());
    expect((await mock.getAdvanced(j)).type).toBe('NONE');
    expect(adv.byKey.get(k.id)).toBeUndefined();
  });

  it('a failure of another job does not fail a change that was saved', async () => {
    const { adv, mock, key } = await setup();
    const host = key('F');
    const sync = useSyncStore();
    sync.enqueue({ key: 'other', label: 'other', write: async () => { throw new PermanentSyncError('nope'); } });
    await adv.save(dksOn(host.id));
    expect(await mock.getAdvanced(host)).toMatchObject({ type: 'DKS' });
    expect(useHistoryStore().undoLabel).not.toBeNull();
  });

  it('editing onto an occupied key of the same type is a conflict, not a silent overwrite', async () => {
    const { adv, key } = await setup();
    const [j, k] = [key('J'), key('K')];
    await adv.save(dksOn(j.id));
    await adv.save(dksOn(k.id));
    const mine = adv.byKey.get(j.id)!;
    await expect(adv.save({ ...dksOn(k.id) }, mine)).rejects.toBeInstanceOf(AdvancedConflictError);
    expect(adv.byKey.get(j.id)?.type).toBe('DKS');
  });
});

describe('tuning snapshots follow the keyboard', () => {
  it('kept when the same keyboard is plugged in again, dropped for another or an unknown one', () => {
    clearTuningSnapshots();
    const p = { mode: 1, normalPress: 1.3 } as unknown as Performance;
    tuningSnapshotsFor('0030000d:A1');
    setTuningSnapshot(0, 5, p);
    tuningSnapshotsFor('0030000d:A1'); // cable pulled mid-write, same keyboard back
    expect(getTuningSnapshot(0, 5)).toBe(p);
    tuningSnapshotsFor('0030000d:B2');
    expect(getTuningSnapshot(0, 5)).toBeUndefined();
    setTuningSnapshot(0, 5, p);
    tuningSnapshotsFor(null); // demo, or a serial that cannot tell keyboards apart
    expect(getTuningSnapshot(0, 5)).toBeUndefined();
    setTuningSnapshot(0, 5, p);
    tuningSnapshotsFor(null);
    expect(getTuningSnapshot(0, 5)).toBeUndefined();
  });
});

describe('pair picking', () => {
  const pair = (over: Partial<SocdAssignment> = {}): SocdAssignment => ({ type: 'SOCD', keys: [-1, -1], keycodes: [0, 0], delay: 0, mode: 1, ...over });

  it('fills A then B and moves to slot B', () => {
    const a = pickPairKey(pair(), 0, 10, 0x04)!;
    expect(a).toMatchObject({ slot: 1, draft: { keys: [10, -1], keycodes: [0x04, 0] } });
    const b = pickPairKey(a.draft, 1, 11, 0x07)!;
    expect(b).toMatchObject({ slot: 1, draft: { keys: [10, 11], keycodes: [0x04, 0x07] } });
  });

  it('clicking key A again while filling B changes nothing', () => {
    const a = pickPairKey(pair(), 0, 10, 0x04)!;
    expect(pickPairKey(a.draft, 1, 10, 0x04)).toBeNull();
  });

  it('with both slots filled the other key swaps, and the A/B priority follows the key', () => {
    const full = pair({ keys: [10, 11], keycodes: [0x04, 0x07], mode: 1 });
    const r = pickPairKey(full, 1, 10, 0x04)!;
    expect(r.slot).toBe(1);
    expect(r.draft).toMatchObject({ keys: [11, 10], keycodes: [0x07, 0x04], mode: 2 });
    expect(swapPair(r.draft).mode).toBe(1);
    expect(swapPair(pair({ keys: [1, 2], keycodes: [4, 5], mode: 3 })).mode).toBe(3);
  });

  it('auto-fills an output only from a keyboard code', () => {
    expect(pickPairKey(pair(), 0, 10, 0x04)!.draft.keycodes[0]).toBe(0x04);
    expect(pickPairKey(pair(), 0, 10, 0x1000)!.draft.keycodes[0]).toBe(0); // not a plain keyboard code
    expect(pickPairKey(pair(), 0, 10, undefined)!.draft.keycodes[0]).toBe(0);
  });

  it('SOCD / RS outputs must be keyboard codes', () => {
    const ctx = { layer0: () => 4 };
    expect(KEYBOARD_CODES.has(0x04)).toBe(true);
    expect(validateAssignment(pair({ keys: [1, 2], keycodes: [0x04, 0x05] }), ctx)).toBeNull();
    expect(validateAssignment(pair({ keys: [1, 2], keycodes: [0x04, 0x4000] }), ctx)).not.toBeNull();
    expect(validateAssignment({ type: 'RS', keys: [1, 2], keycodes: [0x2000, 0x05], delay: 0 }, ctx)).not.toBeNull();
  });
});

describe('MPT without stage 3', () => {
  it('stage 2 may use the travel up to one step short of the end while stage 3 has no output', () => {
    expect(mptBounds(1, [0.5, 1, 1.5], 3.3, true).max).toBe(1.4);
    expect(mptBounds(1, [0.5, 1, 1.5], 3.3, false).max).toBe(3.2);
  });

  it('validation always wants strictly increasing depths inside the travel', () => {
    const ctx = { layer0: () => 4, mptMax: 3.3 };
    expect(validateAssignment({ type: 'MPT', keys: [0], keycodes: [4, 5, 0], depths: [0.5, 3.2, 3.3] }, ctx)).toBeNull();
    expect(validateAssignment({ type: 'MPT', keys: [0], keycodes: [4, 5, 0], depths: [0.5, 3.3, 3.3] }, ctx)).not.toBeNull();
    expect(validateAssignment({ type: 'MPT', keys: [0], keycodes: [4, 5, 6], depths: [0.5, 3.3, 0.2] }, ctx)).not.toBeNull();
    expect(validateAssignment({ type: 'MPT', keys: [0], keycodes: [4, 5, 0], depths: [0.5, 3.4, 4] }, ctx)).not.toBeNull();
  });

  it('an unused stage 3 is moved just past stage 2 when it is not already past it', () => {
    const a: MptAssignment = { type: 'MPT', keys: [0], keycodes: [4, 5, 0], depths: [0.5, 2, 1] };
    expect(fixUnusedStage3(a, 3.3).depths).toEqual([0.5, 2, 2.1]);
    expect(fixUnusedStage3({ ...a, depths: [0.5, 3.2, 1] }, 3.3).depths).toEqual([0.5, 3.2, 3.3]);
    expect(fixUnusedStage3({ ...a, depths: [0.5, 1, 9] }, 3.3).depths).toEqual([0.5, 1, 1.1]);
    const ok = { ...a, depths: [0.5, 1, 1.5] as MptAssignment['depths'] };
    expect(fixUnusedStage3(ok, 3.3)).toBe(ok);
    const used = { ...a, keycodes: [4, 5, 6] as MptAssignment['keycodes'] };
    expect(fixUnusedStage3(used, 3.3)).toBe(used);
  });
});

describe('advanced helpers', () => {
  it('DKS cell masks: centre cell owns both turnaround bits; partial bits are dropped', () => {
    expect(normalizeDksMask(0x08)).toBe(0);
    expect(normalizeDksMask(0x18)).toBe(0x18);
    expect(setDksCell(0, 3, true)).toBe(0x18);
    expect(setDksCell(0xff, 3, false)).toBe(0xe7);
    expect(setDksCell(0x01, 1, true)).toBe(0x03);
  });

  it('MPT depths stay strictly increasing inside the switch range', () => {
    expect(normalizeMptDepths([2, 1, 3], 3.3)).toEqual([0.9, 1, 3]);
    expect(normalizeMptDepths([1, 2, 4], 3.3)).toEqual([1, 2, 3.3]);
  });

  it('a pair whose partner record is missing is shown read-only', () => {
    const keys = [
      { id: 0, uiRow: 0, row: 1, col: 1, x: 0, y: 0, w: 1, name: 'X' },
      { id: 1, uiRow: 0, row: 1, col: 2, x: 1, y: 0, w: 1, name: 'Y' },
    ];
    const list = assignmentsFrom({
      0: { mode: 7, row: 1, col: 1, type: 'RS', pairedRow: 1, pairedCol: 2, keycodes: [4, 5], delay: 0 },
      1: { mode: 0, row: 1, col: 2, type: 'NONE' },
    }, keys);
    expect(list).toEqual([expect.objectContaining({ type: 'READONLY', keys: [0] })]);
  });
});

describe('Advanced list layout', () => {
  let w: VueWrapper | null = null;
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 900 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; vi.unstubAllGlobals(); });
  async function page(profile: number) {
    await setup(profile);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    w = mount(AdvancedPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return w;
  }

  it('with configured items the list is followed by the dashed add slot that fills the rest of the card', async () => {
    const p = await page(1);
    expect(p.findAll('.item')).toHaveLength(1);
    expect(p.find('.cfg .addslot').exists()).toBe(true);
    expect(p.find('.cfg .empty').exists()).toBe(false);
  });

  it('with none configured the empty state is shown and there is no add slot', async () => {
    const p = await page(0);
    expect(p.findAll('.item')).toHaveLength(0);
    expect(p.find('.cfg .empty').exists()).toBe(true);
    expect(p.find('.addslot').exists()).toBe(false);
  });
});
