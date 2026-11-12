// stores/gamepad.ts page helpers (K5) on the demo AE64 Pro with the XInput firmware: a newer protocol, assigning with the
// switch-travel fit, the travel lock and fitToTravel, WASD, unassigning, curve and stick edits, conflicts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { MockTransport } from '../src/protocol';
import {
  GP_CMD, GamepadNewerError, controlIndex, emptyConfig, encodeConfig, evaluate, gamepadOutputs, keyIndexOf,
} from '../src/protocol/gamepad';
import type { GamepadConfig } from '../src/protocol/gamepad';
import { useDeviceStore } from '../src/stores/device';
import { GP_MIN_GAP_UM, fitBinding, useGamepadStore } from '../src/stores/gamepad';
import { useHistoryStore } from '../src/stores/history';
import { usePerformanceStore } from '../src/stores/performance';
import { useSyncStore } from '../src/stores/sync';
import { t as tr } from '../src/i18n/vi';

// A job left queued would run against the next test's keyboard (the sync store finds the device at run time).
afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
});

async function setup(opts: { empty?: boolean } = { empty: true }) {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo('pro-xinput');
  const t = device.transport as MockTransport;
  const fw = t.gamepadFirmware!;
  if (opts.empty !== false) {
    const cfg = emptyConfig();
    cfg.bindings.forEach((b) => { b.key = null; });
    fw.active = encodeConfig(cfg);
  }
  const frames: number[][] = [];
  t.onPacketRaw((dir, b) => { if (dir === 'out') frames.push(Array.from(b)); });
  const gp = useGamepadStore();
  await gp.load();
  return { device, t, fw, frames, gp, sync: useSyncStore(), history: useHistoryStore(), perf: usePerformanceStore() };
}
const agp = (frames: number[][]) => frames.filter((f) => f[0] === 0x10).map((f) => f[1]);
const block = (cfg: GamepadConfig) => Array.from(encodeConfig(cfg));
const key = (name: string) => {
  const k = useDeviceStore().keys.find((d) => d.name === name)!;
  return keyIndexOf(k.row, k.col)!;
};
const LT = controlIndex('LT');
const RT = controlIndex('RT');
const A = controlIndex('A');
/** The demo Pro's switches travel 3.40 mm. */
const TRAVEL = 3400;

describe('a newer AGP1 protocol', () => {
  it('INFO version 2: support "newer", nothing read or written, nothing can be applied', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('pro-xinput');
    const t = device.transport as MockTransport;
    const fw = t.gamepadFirmware!;
    const sent: number[] = [];
    t.useGamepadHandler((req) => {
      sent.push(req[1]);
      const r = fw.handle(req)!;
      if (req[1] === GP_CMD.INFO) r[16] = 2; // data byte 6: protocol version
      return Uint8Array.from(r);
    });
    await expect(t.gamepadInfo()).rejects.toBeInstanceOf(GamepadNewerError);
    sent.length = 0;
    const gp = useGamepadStore();
    await gp.load();
    expect(gp.support).toBe('newer');
    expect(gp.protocolVersion).toBe(2);
    expect(sent).toEqual([GP_CMD.INFO]);
    expect(gp.apply((d) => { d.mode = 'off'; }, 'x')).toBe(false);
    expect(useSyncStore().pendingCount()).toBe(0);
  });
  it('version 1 with a broken field is still unknown firmware (null), not "newer"', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('pro-xinput');
    const t = device.transport as MockTransport;
    t.useGamepadHandler((req) => {
      const r = t.gamepadFirmware!.handle(req)!;
      if (req[1] === GP_CMD.INFO) r[17] = 1; // reserved byte
      return Uint8Array.from(r);
    });
    expect(await t.gamepadInfo()).toBeNull();
  });
  it('version 1 with a capability bit this app does not know is "newer" too (not "stock"), and says which caps', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('pro-xinput');
    const t = device.transport as MockTransport;
    const fw = t.gamepadFirmware!;
    const sent: number[] = [];
    t.useGamepadHandler((req) => {
      sent.push(req[1]);
      const r = fw.handle(req)!;
      if (req[1] === GP_CMD.INFO) r[14] |= 0x40; // data byte 4: caps, bit 6 unknown
      return Uint8Array.from(r);
    });
    const err = await t.gamepadInfo().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GamepadNewerError);
    expect(err).toMatchObject({ version: 1, caps: 0x5e, proto: 'AGP1 v1 · caps 0x5E' });
    sent.length = 0;
    const gp = useGamepadStore();
    await gp.load();
    expect(gp.support).toBe('newer');
    expect(gp.newerProto).toBe('AGP1 v1 · caps 0x5E');
    expect(sent).toEqual([GP_CMD.INFO]);
    expect(gp.apply((d) => { d.mode = 'off'; }, 'x')).toBe(false);
  });
  it('an unknown caps bit on an INFO that is broken anyway stays unknown firmware (null)', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo('pro-xinput');
    const t = device.transport as MockTransport;
    t.useGamepadHandler((req) => {
      const r = t.gamepadFirmware!.handle(req)!;
      if (req[1] === GP_CMD.INFO) { r[14] |= 0x80; r[17] = 1; } // unknown caps bit + reserved byte set
      return Uint8Array.from(r);
    });
    expect(await t.gamepadInfo()).toBeNull();
  });
});

describe('Xbox controller switch', () => {
  it('an edit made just before hiding the Xbox controller is written and verified before USB_SET', async () => {
    const { gp, fw, frames } = await setup();
    expect(gp.info!.usbSwitch).toBe(true);
    frames.length = 0;
    expect(gp.setMode('mixed')).toBe(true);
    const want = block(gp.config!);
    expect(await gp.setXboxDevice(false)).toBe(true);
    const cmds = agp(frames);
    const usbSet = cmds.indexOf(GP_CMD.USB_SET);
    expect(usbSet).toBeGreaterThan(0);
    const before = cmds.slice(0, usbSet);
    for (const c of [GP_CMD.BEGIN, GP_CMD.WRITE, GP_CMD.COMMIT]) expect(before).toContain(c);
    expect(before.lastIndexOf(GP_CMD.READ)).toBeGreaterThan(before.lastIndexOf(GP_CMD.COMMIT)); // the verify read
    expect(Array.from(fw.active)).toEqual(want);
    expect(gp.usb!.enabled).toBe(false);
  });
});

describe('onboard profiles (one block per profile in the firmware)', () => {
  it('a profile switch reads the new profile’s block again', async () => {
    const { device, fw, frames, gp } = await setup();
    expect(gp.config!.bindings[LT].key).toBeNull();
    const other = emptyConfig(); // profile 1's block: mode mixed
    other.bindings.forEach((b) => { b.key = null; });
    other.mode = 'mixed';
    expect(gp.config!.mode).toBe('controller');
    fw.active = encodeConfig(other);
    fw.revision += 1; // the firmware bumps the revision when it loads a profile
    frames.length = 0;
    await device.switchProfile(1);
    await vi.waitFor(() => expect(gp.revision).toBe(fw.revision));
    expect(block(gp.config!)).toEqual(block(other));
    expect(agp(frames)).toContain(GP_CMD.READ);
    expect(gp.support).toBe('ready');
  });
  it('an edit queued for one profile is never written after the keyboard switched to another (job.profile)', async () => {
    const { device, t, frames, gp, sync } = await setup();
    expect(gp.setMode('mixed')).toBe(true);
    frames.length = 0;
    // The keyboard changed profile (Fn) before the write ran, and the app has seen it: keyboard and app agree on
    // profile 1, so only the job's own profile can keep profile 0's edit out of profile 1's block.
    await t.setActiveProfile(1);
    device.activeProfile = 1;
    await sync.flush().catch(() => undefined);
    expect(agp(frames).filter((c) => c === GP_CMD.BEGIN || c === GP_CMD.WRITE || c === GP_CMD.COMMIT)).toEqual([]);
  });
});

describe('the demo Pro + XInput', () => {
  it('reports the Pro board and firmware 0.1.0.0 in 01 02; the XInput firmware only shows through INFO (caps 30, no HID)', async () => {
    const { device, gp } = await setup();
    expect(device.info).toMatchObject({ boardIdHex: '0030000a', firmware: '0.1.0.0' });
    expect(gp.info).toMatchObject({ caps: 30, transports: { hid: false, xinput: true } });
  });
});

describe('assign', () => {
  it('fits an analog record to the key’s switch: declared = travel, Full ≤ travel, Start ≤ Full − 10 µm', async () => {
    const { gp, perf } = await setup();
    expect(gp.travelKnown).toBe(true);
    expect(gp.travelUm(key('Q'))).toBe(TRAVEL);
    expect(perf.values[key('Q')].axisRangeMax).toBe(TRAVEL);
    gp.apply((d) => { d.bindings[LT] = { key: null, curve: 'smooth', startUm: 3450, endUm: 9000, declaredUm: 9000 }; }, 'prep');
    expect(gp.assign(LT, key('Q'))).toEqual({ ok: true, kind: 'assigned' });
    expect(gp.config!.bindings[LT]).toEqual({ key: key('Q'), curve: 'smooth', startUm: TRAVEL - GP_MIN_GAP_UM, endUm: TRAVEL, declaredUm: TRAVEL });
  });
  it('a record already inside the switch keeps Start and Full', async () => {
    const { gp } = await setup();
    gp.apply((d) => { d.bindings[RT] = { key: null, curve: 'linear', startUm: 200, endUm: 2000, declaredUm: 4000 }; }, 'prep');
    gp.assign(RT, key('E'));
    expect(gp.config!.bindings[RT]).toEqual({ key: key('E'), curve: 'linear', startUm: 200, endUm: 2000, declaredUm: TRAVEL });
  });
  it('a button record is not refitted', async () => {
    const { gp } = await setup();
    const before = { ...gp.config!.bindings[A] };
    gp.assign(A, key('Space'));
    expect(gp.config!.bindings[A]).toEqual({ ...before, key: key('Space') });
  });
  it('moved / replaced / assigned, each one undo step', async () => {
    const { gp, history, sync } = await setup();
    expect(gp.assign(LT, key('Q'))).toEqual({ ok: true, kind: 'assigned' });
    expect(gp.assign(LT, key('W'))).toEqual({ ok: true, kind: 'moved', fromKey: key('Q') });
    expect(gp.config!.bindings[LT].key).toBe(key('W'));
    expect(gp.assign(RT, key('W'))).toEqual({ ok: true, kind: 'replaced', oldIndex: LT });
    expect(gp.config!.bindings[LT].key).toBeNull();
    expect(gp.config!.bindings[RT].key).toBe(key('W'));
    history.undo();
    expect(gp.config!.bindings[LT].key).toBe(key('W'));
    expect(gp.config!.bindings[RT].key).toBeNull();
    history.undo();
    expect(gp.config!.bindings[LT].key).toBe(key('Q'));
    history.undo();
    expect(gp.config!.bindings[LT].key).toBeNull();
    await sync.flush();
  });
  it('the same output to the same key changes nothing', async () => {
    const { gp, history } = await setup();
    gp.assign(LT, key('Q'));
    const undoId = history.undoId;
    expect(gp.assign(LT, key('Q'))).toEqual({ ok: true, kind: 'assigned' });
    expect(history.undoId).toBe(undoId);
  });
  it.each([0, 9, 10001, 3400.5, undefined])('a key reporting travel %s is refused for analog and button outputs alike', async (bad) => {
    const { gp, perf, sync } = await setup();
    const q = key('Q');
    perf.values = { ...perf.values, [q]: { ...perf.values[q], axisRangeMax: bad as number } };
    expect(gp.assign(LT, q)).toEqual({ ok: false, reason: 'noTravel' });
    expect(gp.assign(A, q)).toEqual({ ok: false, reason: 'noTravel' });
    expect(gp.config!.bindings.every((b) => b.key === null)).toBe(true);
    expect(sync.pendingCount()).toBe(0);
  });
  it('travel 10 and 10000 µm are usable', async () => {
    const { gp, perf } = await setup();
    const q = key('Q');
    const w = key('W');
    perf.values = { ...perf.values, [q]: { ...perf.values[q], axisRangeMax: 10 }, [w]: { ...perf.values[w], axisRangeMax: 10000 } };
    expect(gp.assign(LT, q).ok).toBe(true);
    expect(gp.config!.bindings[LT]).toMatchObject({ startUm: 0, endUm: 10, declaredUm: 10 });
    expect(gp.assign(RT, w).ok).toBe(true);
    expect(gp.config!.bindings[RT]).toMatchObject({ declaredUm: 10000 });
  });
  it('the assigned block is written and read back from the firmware', async () => {
    const { gp, fw, sync } = await setup();
    gp.assign(LT, key('Q'));
    gp.assign(A, key('Space'));
    await sync.flush();
    expect(Array.from(fw.active)).toEqual(block(gp.config!));
    expect(gp.dirty).toBe(false);
  });
});

describe('the travel lock (a saved Full deeper than the switch, or an assigned key with no travel)', () => {
  async function over() {
    const s = await setup();
    const cfg = emptyConfig();
    cfg.bindings.forEach((b) => { b.key = null; });
    cfg.bindings[LT] = { key: key('Q'), curve: 'linear', startUm: 3450, endUm: 3800, declaredUm: 4000 };
    cfg.bindings[RT] = { key: key('E'), curve: 'linear', startUm: 100, endUm: 3000, declaredUm: 4000 };
    cfg.bindings[A] = { key: key('Space'), curve: 'linear', startUm: 500, endUm: 3500, declaredUm: 4000 };
    s.fw.active = encodeConfig(cfg);
    s.fw.revision = 9;
    await s.gp.load(true);
    return s;
  }
  it('travelIssues lists it and every edit is refused before anything is queued', async () => {
    const { gp, sync } = await over();
    expect(gp.travelIssues).toEqual([{ code: 'overTravel', index: LT, key: key('Q'), limitUm: TRAVEL }]);
    expect(gp.locked).toBe(true);
    expect(gp.setMode('mixed')).toBe(false);
    expect(gp.assign(A, key('Z')).ok).toBe(false);
    expect(gp.unassign([key('Space')])).toBe(0);
    expect(gp.setStick(0, { deadzone: 900 })).toBe(false);
    expect(gp.setCurve([RT], { curve: 'smooth' })).toBe(false);
    expect(gp.lastTravelIssues.length).toBe(1);
    expect(sync.pendingCount()).toBe(0);
  });
  it('a button whose key has no usable travel is an issue too', async () => {
    const { gp, perf } = await over();
    const sp = key('Space');
    perf.values = { ...perf.values, [sp]: { ...perf.values[sp], axisRangeMax: 0 } };
    expect(gp.travelIssues).toContainEqual({ code: 'noTravel', index: A, key: sp });
  });
  it('fitToTravel: one undo step that fits Full and Start and drops the key without travel; it is written', async () => {
    const { gp, perf, history, sync, fw } = await over();
    const sp = key('Space');
    perf.values = { ...perf.values, [sp]: { ...perf.values[sp], axisRangeMax: 0 } };
    expect(gp.fitToTravel()).toBe(2);
    expect(gp.config!.bindings[LT]).toEqual({ key: key('Q'), curve: 'linear', startUm: TRAVEL - GP_MIN_GAP_UM, endUm: TRAVEL, declaredUm: TRAVEL });
    expect(gp.config!.bindings[A].key).toBeNull();
    expect(gp.config!.bindings[RT]).toMatchObject({ endUm: 3000, declaredUm: 4000 }); // fine already: untouched
    expect(gp.locked).toBe(false);
    perf.values = { ...perf.values, [sp]: { ...perf.values[sp], axisRangeMax: TRAVEL } };
    await sync.flush();
    expect(Array.from(fw.active)).toEqual(block(gp.config!));
    expect(history.undoLabel).toContain(tr('gp.fitAll'));
    expect(gp.fitToTravel()).toBe(0);
  });
  it('the page never creates the state itself: Full above the travel is clamped', async () => {
    const { gp } = await setup();
    gp.assign(LT, key('Q'));
    gp.setCurve([LT], { endUm: 9000 });
    expect(gp.config!.bindings[LT].endUm).toBe(TRAVEL);
    expect(gp.travelIssues).toEqual([]);
  });
});

describe('WASD, unassign', () => {
  it('WASD → left stick in one undo step, each fitted; a key that had another output loses it', async () => {
    const { gp, history } = await setup();
    gp.assign(A, key('W'));
    const undoId = history.undoId;
    expect(gp.assignWasd()).toBe(true);
    const b = gp.config!.bindings;
    expect([b[controlIndex('LY+')].key, b[controlIndex('LX-')].key, b[controlIndex('LY-')].key, b[controlIndex('LX+')].key])
      .toEqual([key('W'), key('A'), key('S'), key('D')]);
    expect(b[A].key).toBeNull();
    for (const id of ['LY+', 'LX-', 'LY-', 'LX+'] as const) expect(b[controlIndex(id)].declaredUm).toBe(TRAVEL);
    history.undo();
    expect(history.undoId).toBe(undoId);
    expect(gp.config!.bindings[A].key).toBe(key('W'));
  });
  it('WASD is refused when one of them has no travel', async () => {
    const { gp, perf } = await setup();
    const s = key('S');
    perf.values = { ...perf.values, [s]: { ...perf.values[s], axisRangeMax: 0 } };
    expect(gp.assignWasd()).toBe(false);
    expect(gp.config!.bindings.every((x) => x.key === null)).toBe(true);
  });
  it('unassign selected keys / all: counts, one undo step each', async () => {
    const { gp, history } = await setup();
    gp.assignWasd();
    gp.assign(A, key('Space'));
    expect(gp.unassign([key('W'), key('Space'), key('Z')])).toBe(2);
    expect(gp.unassign([key('Z')])).toBe(0);
    expect(gp.unassign(null)).toBe(3);
    expect(gp.config!.bindings.every((x) => x.key === null)).toBe(true);
    history.undo();
    expect(gp.config!.bindings.filter((x) => x.key !== null).length).toBe(3);
  });
});

describe('curve and stick edits', () => {
  it('Start stops below Full and Full stops above Start (10 µm) and at the travel; values are absolute for every output', async () => {
    const { gp } = await setup();
    gp.assign(LT, key('Q'));
    gp.assign(RT, key('E'));
    expect(gp.setCurve([LT, RT, A], { startUm: 5000 })).toBe(true);
    expect(gp.config!.bindings[LT].startUm).toBe(gp.config!.bindings[LT].endUm - GP_MIN_GAP_UM);
    gp.setCurve([LT], { startUm: 1000 });
    gp.setCurve([LT], { endUm: 500 });
    expect(gp.config!.bindings[LT]).toMatchObject({ startUm: 1000, endUm: 1000 + GP_MIN_GAP_UM });
    gp.setCurve([LT], { startUm: -40 });
    expect(gp.config!.bindings[LT].startUm).toBe(0);
    expect(gp.setCurve([A], { startUm: 100 })).toBe(false); // a button has no curve
    gp.setCurve([LT, RT], { curve: 'smooth' });
    expect([gp.config!.bindings[LT].curve, gp.config!.bindings[RT].curve]).toEqual(['smooth', 'smooth']);
    // Full past the switch stops at the travel (an accepted edit, not a refused one).
    expect(gp.setCurve([LT], { endUm: 99999 })).toBe(true);
    expect(gp.config!.bindings[LT].endUm).toBe(TRAVEL);
  });
  it('an edit of a key whose switch got shallower (Full still inside) also fits the record to the new travel', async () => {
    const { gp, perf } = await setup();
    const q = key('Q');
    gp.assign(LT, q);
    gp.setCurve([LT], { endUm: 2500 });
    const id = useDeviceStore().keys.find((d) => d.name === 'Q')!.id;
    perf.values = { ...perf.values, [id]: { ...perf.values[id], axisRangeMax: 3000 } };
    expect(gp.travelIssues).toEqual([]); // Full 2.50 mm still fits: no lock
    expect(gp.config!.bindings[LT].declaredUm).toBe(TRAVEL);
    expect(gp.setCurve([LT], { curve: 'smooth' })).toBe(true);
    expect(gp.config!.bindings[LT]).toMatchObject({ curve: 'smooth', endUm: 2500, declaredUm: 3000 });
  });
  it('travel read for another profile is not used: unknown until the performance store has this profile', async () => {
    const { gp, perf, device } = await setup();
    perf.loadedProfile = device.activeProfile + 1;
    expect(gp.travelKnown).toBe(false);
    expect(gp.travelUm(key('Q'))).toBeUndefined();
    expect(gp.assign(LT, key('Q'))).toEqual({ ok: false, reason: 'noTravel' });
  });
  it('a drag (same coalesce key) is one undo step', async () => {
    const { gp, history } = await setup();
    gp.assign(LT, key('Q'));
    const undoId = history.undoId;
    for (const v of [1000, 1200, 1400, 1600]) gp.setCurve([LT], { startUm: v }, `curve:${LT}`);
    expect(gp.config!.bindings[LT].startUm).toBe(1600);
    history.undo();
    expect(history.undoId).toBe(undoId);
    expect(gp.config!.bindings[LT].startUm).toBe(500);
  });
  it('square gate: dead zone 0 in the same step; back to round restores the remembered dead zone', async () => {
    const { gp, history } = await setup();
    gp.setStick(1, { deadzone: 1234 });
    expect(gp.setStick(1, { circular: false })).toBe(true);
    expect(gp.config!.sticks[1]).toMatchObject({ circular: false, deadzone: 0 });
    expect(gp.setStick(1, { deadzone: 500 })).toBe(false); // square has none
    gp.setStick(1, { opposition: 'deeper' });
    gp.setStick(1, { circular: true });
    expect(gp.config!.sticks[1]).toEqual({ circular: true, deadzone: 1234, opposition: 'deeper' });
    history.undo();
    history.undo();
    history.undo();
    expect(gp.config!.sticks[1]).toMatchObject({ circular: true, deadzone: 1234 });
  });
  it('dead zone is kept within 0–9499', async () => {
    const { gp } = await setup();
    gp.setStick(0, { deadzone: 99999 });
    expect(gp.config!.sticks[0].deadzone).toBe(9499);
    expect(gp.setStick(0, { deadzone: -5 })).toBe(true);
    expect(gp.config!.sticks[0].deadzone).toBe(0);
  });
  it('mode, and an output type the firmware does not offer is refused', async () => {
    const { gp } = await setup();
    expect(gp.setMode('off')).toBe(true);
    expect(gp.setTransport('hid')).toBe(false);
    expect(gp.config!.transport).toBe('xinput');
  });
});

describe('conflict', () => {
  it('another writer: the keyboard’s block is shown and the dropped edit kept; writeMine writes it in one undo step', async () => {
    const { gp, fw, sync, history, frames } = await setup();
    gp.assign(LT, key('Q'));
    await sync.flush();
    const other = emptyConfig();
    other.bindings.forEach((b) => { b.key = null; });
    other.bindings[A].key = key('Z');
    fw.active = encodeConfig(other);
    fw.revision = 20;
    gp.setMode('mixed');
    await expect(sync.flush()).rejects.toThrow();
    expect(gp.conflict).toMatchObject({ from: 2, to: 20 });
    expect(gp.conflict!.draft.mode).toBe('mixed');
    expect(gp.conflict!.draft.bindings[LT].key).toBe(key('Q'));
    expect(block(gp.config!)).toEqual(block(other));
    frames.length = 0;
    const undoId = history.undoId;
    expect(gp.writeMine()).toBe(true);
    expect(gp.conflict).toBeNull();
    expect(gp.notice).toBeNull();
    await sync.flush();
    expect(agp(frames)).toContain(GP_CMD.COMMIT);
    expect(fw.revision).toBe(21);
    expect(gp.config!.mode).toBe('mixed');
    history.undo();
    expect(history.undoId).toBe(undoId);
  });
  it('keepKeyboard closes it and writes nothing', async () => {
    const { gp, fw, sync, frames } = await setup();
    const other = emptyConfig();
    fw.active = encodeConfig(other);
    fw.revision = 7;
    gp.setMode('mixed');
    await expect(sync.flush()).rejects.toThrow();
    expect(gp.conflict).not.toBeNull();
    frames.length = 0;
    gp.keepKeyboard();
    expect(gp.conflict).toBeNull();
    expect(sync.pendingCount()).toBe(0);
    expect(agp(frames)).toEqual([]);
  });
  it('a reload clears it', async () => {
    const { gp, fw, sync } = await setup();
    fw.active = encodeConfig(emptyConfig());
    fw.revision = 7;
    gp.setMode('mixed');
    await expect(sync.flush()).rejects.toThrow();
    await gp.load(true);
    expect(gp.conflict).toBeNull();
  });
});

describe('fitBinding and gamepadOutputs', () => {
  it('fitBinding', () => {
    const b = { key: 1, curve: 'linear' as const, startUm: 4000, endUm: 5000, declaredUm: 6000 };
    fitBinding(b, 3000);
    expect(b).toEqual({ key: 1, curve: 'linear', startUm: 2990, endUm: 3000, declaredUm: 3000 });
  });
  it('gamepadOutputs is evaluate over per-key arrays', () => {
    const cfg = emptyConfig();
    cfg.bindings.forEach((b) => { b.key = null; });
    cfg.bindings[LT] = { key: 3, curve: 'smooth', startUm: 200, endUm: 3000, declaredUm: 3400 };
    cfg.bindings[controlIndex('LX+')] = { key: 4, curve: 'linear', startUm: 0, endUm: 2000, declaredUm: 3400 };
    cfg.bindings[A] = { key: 5, curve: 'linear', startUm: 500, endUm: 3500, declaredUm: 4000 };
    const depth = Array(64).fill(0);
    const max = Array(64).fill(3400);
    const pressed = Array(64).fill(false);
    for (const d of [0, 150, 900, 1900, 2999, 3400]) {
      depth[3] = d; depth[4] = d; depth[5] = d; pressed[5] = d > 1000;
      expect(gamepadOutputs(cfg, depth, max, pressed)).toEqual(evaluate(cfg, (k) => depth[k], (k) => pressed[k], (k) => max[k]));
    }
    expect(gamepadOutputs(cfg, depth, [])).toMatchObject({ neutral: 'noTravel' });
  });
  it('one bound key the firmware does not see as calibrated makes every frame neutral (valid); by default every key is', () => {
    const cfg = emptyConfig();
    cfg.bindings.forEach((b) => { b.key = null; });
    cfg.bindings[LT] = { key: 15, curve: 'linear', startUm: 0, endUm: 3000, declaredUm: 3400 };
    cfg.bindings[A] = { key: 5, curve: 'linear', startUm: 500, endUm: 3000, declaredUm: 3400 };
    const depth = Array(64).fill(0);
    const max = Array(64).fill(3400);
    const pressed = Array(64).fill(false);
    depth[15] = 3000; depth[5] = 3000; pressed[5] = true;
    const live = gamepadOutputs(cfg, depth, max, pressed);
    expect(live).toMatchObject({ lt: 255, buttons: ['A'], neutral: null });
    expect(gamepadOutputs(cfg, depth, max, pressed, () => true)).toEqual(live);
    // The key that is not calibrated is not even pressed: the firmware still sends a neutral report for everything.
    expect(gamepadOutputs(cfg, depth, max, pressed, (k) => k !== 40)).toEqual(live); // 40 is not bound
    const off = gamepadOutputs(cfg, depth, max, pressed, (k) => k !== 15);
    expect(off).toMatchObject({ lt: 0, rt: 0, lx: 0, buttons: [], dpad: [], neutral: 'notCalibrated' });
    expect(off.levels.every((l) => l === 0)).toBe(true);
    expect(evaluate(cfg, (k) => depth[k], (k) => pressed[k], (k) => max[k], (k) => k !== 5).neutral).toBe('notCalibrated');
    // Mode off wins over it, as in the firmware (nothing is scanned while off).
    expect(gamepadOutputs({ ...cfg, mode: 'off' }, depth, max, pressed, () => false).neutral).toBe('off');
  });
});
