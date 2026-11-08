import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, SAVE_GROUP } from '../src/protocol';
import type { Performance, PhysicalKey } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import {
  AdvancedConflictError, assignmentsFrom, normalizeDksMask, normalizeMptDepths, setDksCell, useAdvancedStore,
} from '../src/stores/advanced';
import type { DksAssignment, MptAssignment, RsAssignment, SocdAssignment } from '../src/stores/advanced';

async function setup(profile = 0) {
  setActivePinia(createPinia());
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
    await expect(adv.save({ type: 'MPT', keys: [host.id], keycodes: [4, 5, 0], depths: [0.5, 1, 9] })).rejects.toThrow();
    await expect(adv.save({ type: 'MPT', keys: [host.id], keycodes: [4, 0xe7, 0], depths: [0.5, 1, 1.5] })).rejects.toThrow(); // RWin not in MPT palette
    expect(setMpt).not.toHaveBeenCalled();
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
