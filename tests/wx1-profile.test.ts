// WX1 (whole review W-01, W-02, W-09, W-10, U-10, stale axis): the app never writes into a profile it does not hold,
// and never writes an old job to a new connection. Demo keyboard only; `t.setActiveProfile(n)` called on the transport is
// what the keyboard's own P1–P4 keys do (the app is not told).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { SAVE_GROUP } from '../src/protocol';
import type { MockTransport, PhysicalKey } from '../src/protocol';
import { PROFILE_POLL_MS, useDeviceStore } from '../src/stores/device';
import { useSyncStore } from '../src/stores/sync';
import { usePerformanceStore } from '../src/stores/performance';
import { useKeymapStore } from '../src/stores/keymap';
import { useLightingStore } from '../src/stores/lighting';
import { useAdvancedStore } from '../src/stores/advanced';
import type { DksAssignment } from '../src/stores/advanced';
import { useDiagnosticsStore } from '../src/stores/diagnostics';
import { useHistoryStore } from '../src/stores/history';
import { useCalibrationStore } from '../src/stores/calibration';
import { useFirmwareStore } from '../src/stores/firmware';
import { clearTuningSnapshots } from '../src/stores/tuning';
import { useToast } from '../src/components/ui/toast';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Let pending promises (and the mock's replies) run; setTimeout stays real in this file. */
const settle = async (n = 20) => { for (let i = 0; i < n; i++) await sleep(0); };
const toasts = () => useToast().items.value.map((x) => `${x.kind}: ${x.text}`);
const followed = (n: number, m: number, k: number) => `warn: ${tr('device.keyboardSwitchedDropped', { n, m, k })}`;
/** The custom-coloured LEDs of a matrix (the demo animates the others, so only these are stable). */
const customs = (m: { r: number; g: number; b: number; custom: boolean }[]) => JSON.stringify(m.flatMap((l, i) => (l.custom ? [[i, l.r, l.g, l.b]] : [])));

async function boot(seed: 'max' | 'pro' = 'max') {
  setActivePinia(createPinia());
  clearTuningSnapshots();
  locale.value = 'vi';
  useToast().items.value = [];
  const device = useDeviceStore();
  await device.connectDemo(seed);
  const t = device.transport as MockTransport;
  const key = (name: string): PhysicalKey => device.keys.find((k) => k.name === name)!;
  return { device, t, key, sync: useSyncStore(), history: useHistoryStore() };
}

beforeEach(() => {
  // The idle profile poll (setInterval) runs only when a test advances it; the mock's replies (setTimeout) stay real.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  locale.value = 'vi';
  useToast().items.value = [];
});

describe('W-01: the keyboard switches profile by itself, then the queue writes', () => {
  it('S2 turned round (performance): the edit is dropped unwritten, the app follows, undo is empty, one toast', async () => {
    const { device, t, key, sync, history } = await boot();
    const perf = usePerformanceStore();
    await perf.load();
    const q = key('Q');
    await t.setActiveProfile(1); // the P2 key
    const before = await t.getPerformance(q); // demo profile 1: Q Standard, 1.2 mm
    expect([before.mode, before.normalPress]).toEqual([0, 1.2]);
    const set = vi.spyOn(t, 'setPerformance');
    const listener = vi.fn();
    device.onProfileChanged(listener);
    expect(perf.apply([q.id], () => ({ rtPress: 0.5 }), 'RT press')).toBe(1);
    expect(history.canUndo).toBe(true);
    await expect(sync.flush()).rejects.toThrow(tr('sync.keyboardChangedProfile'));
    expect(set).not.toHaveBeenCalled();
    expect(device.activeProfile).toBe(1);
    const after = await t.getPerformance(q);
    expect([after.mode, after.normalPress, after.rtPress]).toEqual([before.mode, before.normalPress, before.rtPress]);
    expect(history.canUndo).toBe(false);
    expect(history.canRedo).toBe(false);
    expect(sync.pendingCount()).toBe(0);
    expect(toasts()).toEqual([followed(2, 1, 1)]);
    expect(listener).toHaveBeenCalledTimes(1); // every mounted page reloads, as after a sidebar switch
  });

  it('the handler re-reads layer 0 of the profile the keyboard is on, and does nothing for a caller that is behind', async () => {
    const { device, t } = await boot();
    const k = device.keys[4];
    await t.setActiveProfile(2);
    await t.setKeycode(k, 0x1d, 0);
    await t.commit(SAVE_GROUP.LAYOUT);
    expect(device.layer0[k.id]).not.toBe(0x1d);
    await device.profileChangedOnKeyboard(2);
    expect(device.layer0[k.id]).toBe(0x1d);
    // A detection made while the app was on profile 1 (index 0) comes in after the app moved to 3: ignored.
    await device.profileChangedOnKeyboard(1, 1, 0);
    expect(device.activeProfile).toBe(2);
    expect(toasts()).toEqual([`warn: ${tr('device.keyboardSwitched', { n: 3 })}`]);
  });

  it('the toast in English, and without the second sentence when nothing was dropped', async () => {
    const { device, t } = await boot();
    locale.value = 'en';
    await t.setActiveProfile(3);
    await device.profileChangedOnKeyboard(3);
    expect(toasts()).toEqual(['warn: The keyboard switched to profile 4 by itself.']);
    useToast().items.value = [];
    await t.setActiveProfile(0);
    await device.profileChangedOnKeyboard(0, 2);
    expect(toasts()).toEqual(['warn: The keyboard switched to profile 1 by itself. Dropped 2 unsaved changes to profile 4, not written to profile 1.']);
  });

  it('keymap: the key keeps its code in the profile the keyboard went to', async () => {
    const { device, t, sync } = await boot();
    const keymap = useKeymapStore();
    await keymap.load();
    const k = device.keys[1];
    await t.setActiveProfile(2);
    const before = await t.getKeycode(k, 0);
    const set = vi.spyOn(t, 'setKeycode');
    keymap.applyKeycode([k.id], 0x04);
    await expect(sync.flush()).rejects.toThrow(tr('sync.keyboardChangedProfile'));
    expect(set).not.toHaveBeenCalled();
    expect(await t.getKeycode(k, 0)).toBe(before);
    expect(device.activeProfile).toBe(2);
    expect(device.layer0[k.id]).toBe(before); // layer 0 re-read from the profile the keyboard is on
    expect(toasts()).toEqual([followed(3, 1, 1)]);
  });

  it('lighting matrix: no LED write reaches the other profile', async () => {
    const { device, t, sync } = await boot();
    const light = useLightingStore();
    await light.load();
    await t.setActiveProfile(1);
    const before = customs(await t.readLedMatrix(0));
    const write = vi.spyOn(t, 'writeLedMatrix');
    light.applyKeyColors([device.keys[5].id], { r: 255, g: 0, b: 0 }, 'colour');
    await expect(sync.flush()).rejects.toThrow(tr('sync.keyboardChangedProfile'));
    expect(write).not.toHaveBeenCalled();
    expect(customs(await t.readLedMatrix(0))).toBe(before);
    expect(device.activeProfile).toBe(1);
    expect(toasts()).toEqual([followed(2, 1, 1)]);
  });

  it('advanced keys: a save is refused, nothing is cleared or written in the other profile', async () => {
    clearTuningSnapshots();
    const { device, t, key } = await boot();
    const adv = useAdvancedStore();
    await adv.load();
    const g = key('G');
    await t.setActiveProfile(1);
    const before = JSON.stringify(await t.getAdvanced(g));
    const clear = vi.spyOn(t, 'clearAdvanced');
    const dks = vi.spyOn(t, 'setDks');
    const setPerf = vi.spyOn(t, 'setPerformance');
    const a: DksAssignment = { type: 'DKS', keys: [g.id], keycodes: [0x04, 0x05, 0, 0], travels: [0xff, 0xff, 0, 0], dbs: [1.0, 2.0] };
    await expect(adv.save(a)).rejects.toThrow(tr('sync.keyboardChangedProfile'));
    expect(clear).not.toHaveBeenCalled();
    expect(dks).not.toHaveBeenCalled();
    expect(setPerf).not.toHaveBeenCalled();
    expect(JSON.stringify(await t.getAdvanced(g))).toBe(before);
    expect(device.activeProfile).toBe(1);
    expect(adv.byKey.get(g.id)).toBeUndefined(); // the optimistic row was taken back
  });

  it('backup restore: refused before the first write when the keyboard switched, then the app follows', async () => {
    const { device, t } = await boot();
    const diag = useDiagnosticsStore();
    const backup = await diag.generateBackup();
    const k = device.keys[2];
    backup.keymap[0][k.id] = 0x1d; // "Z": a change the restore would write
    const diff = await diag.parseAndDiffBackup(JSON.stringify(backup));
    await t.setActiveProfile(3);
    const codeBefore = await t.getKeycode(k, 0);
    const setKey = vi.spyOn(t, 'setKeycode');
    const setPerf = vi.spyOn(t, 'setPerformance');
    const commit = vi.spyOn(t, 'commit');
    await expect(diag.applyRestore(diff)).rejects.toThrow(tr('diagnostics.restoreProfileChanged', { n: 4 }));
    expect(setKey).not.toHaveBeenCalled();
    expect(setPerf).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(await t.getKeycode(k, 0)).toBe(codeBefore);
    expect(device.activeProfile).toBe(3);
  });

  it('jobs without a profile still run in a batch whose profile jobs were dropped', async () => {
    const { device, t, sync } = await boot();
    const perf = usePerformanceStore();
    await perf.load();
    await t.setActiveProfile(1);
    let globalWritten = false;
    perf.apply([device.keys[3].id], () => ({ rtPress: 0.4 }), 'RT press');
    sync.enqueue({ key: 'global:test', label: 'global', write: async () => { globalWritten = true; } });
    await expect(sync.flush()).rejects.toThrow();
    expect(globalWritten).toBe(true);
    expect(device.activeProfile).toBe(1);
  });

  it('a failed active-profile read writes none of the profile jobs (a failed attempt, kept for retry)', async () => {
    const { device, t, sync } = await boot();
    const perf = usePerformanceStore();
    await perf.load();
    const set = vi.spyOn(t, 'setPerformance');
    vi.spyOn(t, 'getActiveProfile').mockRejectedValueOnce(new Error('usb hiccup'));
    perf.apply([device.keys[3].id], () => ({ rtPress: 0.4 }), 'RT press');
    await expect(sync.flush()).rejects.toThrow(/usb hiccup/);
    expect(set).not.toHaveBeenCalled();
    expect(sync.pendingCount()).toBe(1);
    await sync.flush(); // the read works again: written to the profile the app holds
    expect(set).toHaveBeenCalledTimes(1);
    expect(device.activeProfile).toBe(0);
  });
});

describe('W-01: follow the keyboard while idle', () => {
  it('notices a switch within 2 s and follows it with one toast', async () => {
    const { device, t } = await boot();
    const read = vi.spyOn(t, 'getActiveProfile');
    await t.setActiveProfile(2);
    read.mockClear();
    vi.advanceTimersByTime(PROFILE_POLL_MS - 1);
    await settle();
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await vi.waitFor(() => expect(device.activeProfile).toBe(2));
    expect(read).toHaveBeenCalledTimes(1);
    await settle();
    expect(toasts()).toEqual([`warn: ${tr('device.keyboardSwitched', { n: 3 })}`]);
  });

  it('nothing changed: one read per tick, no toast, nothing else', async () => {
    const { device, t } = await boot();
    const read = vi.spyOn(t, 'getActiveProfile');
    const names = vi.spyOn(t, 'getKeymapRow');
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(PROFILE_POLL_MS);
      await settle();
    }
    expect(read).toHaveBeenCalledTimes(3);
    expect(names).not.toHaveBeenCalled();
    expect(device.activeProfile).toBe(0);
    expect(toasts()).toEqual([]);
  });

  it('a queued edit of the old profile is dropped by the poll, never written', async () => {
    const { device, t, sync } = await boot();
    const perf = usePerformanceStore();
    await perf.load();
    const set = vi.spyOn(t, 'setPerformance');
    await t.setActiveProfile(1);
    perf.apply([device.keys[3].id], () => ({ rtPress: 0.4 }), 'RT press'); // queued (350 ms debounce)
    vi.advanceTimersByTime(PROFILE_POLL_MS);
    await vi.waitFor(() => expect(device.activeProfile).toBe(1));
    await sleep(500); // past the debounce: the dropped job must not be written
    expect(set).not.toHaveBeenCalled();
    expect(sync.pendingCount()).toBe(0);
    expect(sync.state).toBe('saved');
    expect(toasts()).toEqual([followed(2, 1, 1)]);
  });

  it('when the window gets focus', async () => {
    const { device, t } = await boot();
    await t.setActiveProfile(1);
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(device.activeProfile).toBe(1));
  });

  it('no poll while exclusive, calibrating, in a firmware session or hidden', async () => {
    const { t, device } = await boot();
    const read = vi.spyOn(t, 'getActiveProfile');
    const tick = async () => { vi.advanceTimersByTime(PROFILE_POLL_MS); await settle(); };
    const release = device.holdExclusive();
    await tick();
    release();
    const cal = useCalibrationStore();
    cal.phase = 'running';
    await tick();
    cal.phase = 'idle';
    const fw = useFirmwareStore();
    fw.active = true;
    await tick();
    fw.active = false;
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await tick();
      window.dispatchEvent(new Event('focus'));
      await settle();
    } finally {
      delete (document as unknown as { visibilityState?: string }).visibilityState;
    }
    expect(read).not.toHaveBeenCalled();
    await tick();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('no poll after disconnect', async () => {
    const { t, device } = await boot();
    const read = vi.spyOn(t, 'getActiveProfile');
    const timers = vi.getTimerCount();
    await device.disconnect();
    expect(vi.getTimerCount()).toBe(timers - 2); // the latency refresh and the profile poll
    for (let i = 0; i < 3; i++) vi.advanceTimersByTime(PROFILE_POLL_MS);
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(read).not.toHaveBeenCalled();
  });

  it('a sidebar switch while a poll read is out is not undone by that read', async () => {
    const { device, t } = await boot();
    let answer: ((v: number) => void) | null = null;
    vi.spyOn(t, 'getActiveProfile').mockImplementationOnce(() => new Promise<number>((r) => { answer = r; }));
    vi.advanceTimersByTime(PROFILE_POLL_MS);
    await settle();
    expect(answer).not.toBeNull();
    await device.switchProfile(2);
    answer!(1); // the read went out before the switch (and saw a P-key switch the sidebar switch then replaced)
    await settle();
    expect(device.activeProfile).toBe(2);
    expect(await t.getActiveProfile()).toBe(2);
  });

  it('the packet log keeps one row for repeated polls', async () => {
    const { device } = await boot();
    const base = device.packetEntries().length;
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(PROFILE_POLL_MS);
      await settle();
    }
    let rows = device.packetEntries();
    expect(rows.length).toBe(base + 1);
    expect(rows[base].repeat).toBe(10);
    const t = device.transport as MockTransport;
    await t.getAxisData('route', 1);
    vi.advanceTimersByTime(PROFILE_POLL_MS);
    await settle();
    rows = device.packetEntries();
    expect(rows.length).toBe(base + 3); // a live-travel group and a profile-poll group never merge
    expect([rows[base + 1].repeat, rows[base + 2].repeat]).toEqual([2, 2]);
  });
});

describe('W-02: a batch in flight when the keyboard is lost', () => {
  it('S1 turned round: nothing is retried on the next keyboard; the lost count includes it', async () => {
    const { device, t: t1, sync } = await boot();
    const keymap = useKeymapStore();
    await keymap.load();
    const key = device.keys[1];
    keymap.applyKeycode([key.id], 0x04);
    const flushing = sync.flush().then(() => 'ok', () => 'rejected');
    t1.unplug();
    expect(await flushing).toBe('rejected');
    expect(device.connected).toBe(false);
    expect(sync.pendingCount()).toBe(0);
    expect(sync.state).toBe('saved');
    expect(toasts()).toEqual([`error: ${tr('device.unsavedLost', { n: 1 })}`]);
    await device.connectDemo('pro');
    const t2 = device.transport as MockTransport;
    const before = await t2.getKeycode(key, 0);
    const set = vi.spyOn(t2, 'setKeycode');
    await sync.retry();
    expect(set).not.toHaveBeenCalled();
    expect(await t2.getKeycode(key, 0)).toBe(before);
    expect(sync.state).toBe('saved');
  });

  it('a job already verified before the loss is not counted as lost', async () => {
    const { device, t, sync } = await boot();
    let verified = 0;
    let cut: (() => void) | null = null;
    sync.enqueue({ key: 'a', label: 'a', write: async () => undefined, verify: async () => { verified++; return true; } });
    sync.enqueue({
      key: 'b', label: 'b', write: async () => undefined,
      verify: () => new Promise<boolean>((r) => { cut = () => r(false); }),
    });
    const flushing = sync.flush().catch(() => undefined);
    await vi.waitFor(() => expect(cut).not.toBeNull());
    expect(verified).toBe(1);
    t.unplug();
    cut!();
    await flushing;
    expect(toasts()).toEqual([`error: ${tr('device.unsavedLost', { n: 1 })}`]);
    expect(device.connected).toBe(false);
  });
});

describe('W-09: a profile switch while an exclusive job runs', () => {
  it('DG3 turned round: refused during a backup, which holds one profile', async () => {
    const { device } = await boot();
    const diag = useDiagnosticsStore();
    const pending = diag.generateBackup();
    await sleep(30);
    await expect(device.switchProfile(1)).rejects.toThrow(tr('device.busyWith', { what: tr('diagnostics.whatBackup') }));
    const backup = await pending;
    const modes = device.keys.map((k) => backup.performance[k.id].mode);
    expect(backup.profileIndex).toBe(0);
    expect(modes.filter((m) => m === 1)).toHaveLength(64); // demo profile 0: every key RT
    expect(backup.advanced.some((r) => r.type === 'SOCD')).toBe(false); // profile 1's SOCD on A / D
    expect(device.activeProfile).toBe(0);
  });

  it('a job without a name gets the generic text', async () => {
    const { device } = await boot();
    const release = device.holdExclusive();
    try {
      await expect(device.switchProfile(1)).rejects.toThrow(tr('device.busy'));
    } finally {
      release();
    }
    await device.switchProfile(1);
    expect(device.activeProfile).toBe(1);
  });

  it('a backup fails when the keyboard switched while it was read', async () => {
    const { t } = await boot();
    const diag = useDiagnosticsStore();
    const pending = diag.generateBackup().then(() => 'ok', (e: unknown) => String(e));
    await sleep(30);
    await t.setActiveProfile(1);
    expect(await pending).toContain(tr('diagnostics.backupProfileChanged'));
  });
});

describe('W-10: load() keeps no rows of a profile switched to mid-read', () => {
  /** Runs `load` and switches the profile in the sidebar right after the `nth` call of `read` (mid-load), then back. */
  async function switchMidLoad(read: 'getKeymapRow' | 'getAdvanced' | 'getLightingAreas', nth: number, load: () => Promise<void>) {
    const device = useDeviceStore();
    const t = device.transport as MockTransport;
    const orig = (t[read] as (...a: unknown[]) => Promise<unknown>).bind(t);
    let n = 0;
    let sw: Promise<void> | null = null;
    vi.spyOn(t, read).mockImplementation((async (...a: unknown[]) => {
      if (++n === nth) sw = device.switchProfile(1);
      return orig(...a);
    }) as never);
    await load();
    await sw;
    vi.mocked(t[read]).mockRestore();
    expect(device.activeProfile).toBe(1);
    await device.switchProfile(0);
  }

  it('KM1 turned round: advanced keys', async () => {
    const { device } = await boot();
    const adv = useAdvancedStore();
    await switchMidLoad('getAdvanced', 3, () => adv.load());
    await adv.load(); // what a page does when it opens
    expect(device.activeProfile).toBe(0);
    expect(Object.values(adv.records).filter((r) => r.type === 'SOCD')).toHaveLength(0);
    expect(adv.loadedProfile).toBe(0);
  });

  it('keymap', async () => {
    const { device, t } = await boot();
    const keymap = useKeymapStore();
    const k = device.keys.at(-1)!; // read late: last row of the last layer
    await t.setActiveProfile(1);
    await t.setKeycode(k, 0x1d, 3);
    await t.commit(SAVE_GROUP.LAYOUT);
    await t.setActiveProfile(0);
    const own = await t.getKeycode(k, 3);
    expect(own).not.toBe(0x1d);
    await switchMidLoad('getKeymapRow', 3, () => keymap.load());
    await keymap.load();
    expect(keymap.loadedProfile).toBe(0);
    expect(keymap.values[3][k.id]).toBe(own);
  });

  it('lighting', async () => {
    const { device, t } = await boot();
    const light = useLightingStore();
    await t.setActiveProfile(1);
    const leds = await t.readLedMatrix(0);
    leds[5] = { r: 1, g: 2, b: 3, custom: true };
    await t.writeLedMatrix(0, leds);
    await t.commit(SAVE_GROUP.LIGHTING);
    await t.setActiveProfile(0);
    const own = customs(await t.readLedMatrix(0));
    expect(own).not.toContain('[5,1,2,3]');
    await switchMidLoad('getLightingAreas', 1, () => light.load());
    await light.load();
    expect(device.activeProfile).toBe(0);
    expect(light.loadedProfile).toBe(0);
    expect(customs(light.area0Matrix)).toBe(own);
  });
});

describe('U-10: the MPT depth limit and the calibration travel use the active profile only', () => {
  it('misc B turned round: performanceOf reads the active profile, not the Travel tab\'s older one', async () => {
    const { device, t, sync } = await boot();
    const perf = usePerformanceStore();
    const adv = useAdvancedStore();
    await perf.load();
    const key = device.keys[20];
    const other = perf.catalog!.find((e) => Math.floor(e.rangeMax / 100) !== Math.floor(perf.values[key.id].axisRangeMax / 100))!;
    perf.applySwitch([key.id], other);
    await sync.flush();
    await device.switchProfile(1); // no perf.load(true): the Travel tab is not open
    await adv.load(true);
    const real = await t.getPerformance(key);
    const used = await adv.performanceOf(key.id);
    expect(used.axisRangeMax).toBe(real.axisRangeMax);
  });

  it('calibration: the travel of the profile left is not used for "too shallow"', async () => {
    const { device } = await boot();
    const perf = usePerformanceStore();
    await perf.load();
    const id = device.keys[7].id;
    perf.values = { ...perf.values, [id]: { ...perf.values[id], axisRangeMax: 3000 } };
    await settle();
    const cal = useCalibrationStore();
    expect(cal.rangeUm(id)).toBe(3000);
    await device.switchProfile(1); // no perf.load(true)
    expect(cal.rangeUm(id)).not.toBe(3000);
    await device.switchProfile(0);
    expect(cal.rangeUm(id)).toBe(3000);
  });
});

describe('stale axis: an advanced-key write, then a travel edit of the same key', () => {
  it('the travel write carries the axis the keyboard has after the advanced write', async () => {
    const { t, key, sync } = await boot();
    const perf = usePerformanceStore();
    const adv = useAdvancedStore();
    await perf.load();
    await adv.load();
    const g = key('G');
    const old = await t.getPerformance(g);
    // The keyboard changes the key's axis on its own (what an assignment change can do): the store still has the old one.
    // (Set in the demo's record directly: the app itself never writes axis.) Reply byte 19 = record byte 15.
    const rec = (t as unknown as { profiles: { perf: Map<string, number[]> }[] }).profiles[0].perf.get(`${g.row}:${g.col}`)!;
    rec[15] = old.axis + 7;
    const a: DksAssignment = { type: 'DKS', keys: [g.id], keycodes: [0x04, 0x05, 0, 0], travels: [0xff, 0xff, 0, 0], dbs: [1.0, 2.0] };
    await adv.save(a);
    const set = vi.spyOn(t, 'setPerformance');
    perf.apply([g.id], () => ({ rtPress: 0.3 }), 'RT press');
    await sync.flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0][1].axis).toBe(old.axis + 7);
    expect(perf.values[g.id].axis).toBe(old.axis + 7);
  });
});
