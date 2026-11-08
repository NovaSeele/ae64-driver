import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, SAVE_GROUP, WriteNotAllowedError } from '../src/protocol';
import type { MacroAction } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { MacroRecorder } from '../src/components/macro/recorder';
import { MACRO_HOLD_REPEAT, MACRO_PROTOCOL_EVENT_LIMIT, actionLimit, balanceWarnings, useMacroStore, validateDraft } from '../src/stores/macro';

async function setup() {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo();
  const mock = device.transport as MockTransport;
  const macro = useMacroStore();
  await macro.load();
  return { device, mock, macro };
}

function sequence(n: number): MacroAction[] {
  return Array.from({ length: n }, (_, i) => ({ down: i % 2 === 0, delay: 1 + (i * 37) % 2000, keycode: 4 + Math.floor(i / 2) % 26 }));
}

describe('macro store', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loads capacity and every slot', async () => {
    const { macro } = await setup();
    expect(macro.space).toEqual({ count: 16, capacity: 960 });
    expect(macro.slots).toHaveLength(16);
    expect(macro.slots[0].actions).toHaveLength(6);
    expect(macro.slots[0].actions[0]).toEqual({ down: true, delay: 10, keycode: 0xe0 });
  });

  it('writes 31 actions as 3 pages, commits MACRO and verifies the full read-back', async () => {
    const { macro, mock } = await setup();
    const pages: number[] = [];
    mock.onPacket((e) => { if (e.dir === 'out' && e.bytes[0] === 0x07 && e.bytes[1] === 0x04) pages.push(e.bytes[3]); });
    const commit = vi.spyOn(mock, 'commit');
    const actions = sequence(31);

    await macro.save(3, { mode: 1, repeatCount: 12, actions });

    expect(pages).toEqual([0, 1, 2]);
    expect(commit.mock.calls.map((c) => c[0])).toEqual([SAVE_GROUP.MACRO]);
    expect(await mock.getMacroMeta(3)).toEqual({ id: 3, valid: true, actionCount: 31, repeatCount: 12, mode: 1 });
    expect((await mock.readMacroActions(3, 31)).slice(0, 31)).toEqual(actions);
    expect(useSyncStore().state).toBe('saved');

    // A fresh load reads the same 31 actions back.
    await macro.load(true);
    expect(macro.slots[3].actions).toEqual(actions);
  });

  it('stores 65535 repeats for hold modes and clamps click repeats to 1–9999', async () => {
    const { macro, mock } = await setup();
    await macro.save(1, { mode: 4, repeatCount: 3, actions: sequence(2) });
    expect((await mock.getMacroMeta(1)).repeatCount).toBe(MACRO_HOLD_REPEAT);
    await macro.save(1, { mode: 0, repeatCount: 50000, actions: sequence(2) });
    expect((await mock.getMacroMeta(1)).repeatCount).toBe(9999);
  });

  it('capacity guard: macroCount + actNum ≤ capacity', async () => {
    const { macro } = await setup();
    expect(actionLimit({ count: 16, capacity: 960 })).toBe(944);
    expect(macro.limit).toBe(944);
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: sequence(944) }, 944)).toBeNull();
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: sequence(945) }, 944)).not.toBeNull();
    await expect(macro.save(2, { mode: 0, repeatCount: 1, actions: sequence(945) })).rejects.toThrow();
  });

  it('rejects empty sequences, bad delays and non-keyboard keycodes', () => {
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: [] }, 944)).not.toBeNull();
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: [{ down: true, delay: 0, keycode: 4 }] }, 944)).not.toBeNull();
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: [{ down: true, delay: 32768, keycode: 4 }] }, 944)).not.toBeNull();
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: [{ down: true, delay: 32767, keycode: 4 }] }, 944)).toBeNull();
    expect(validateDraft({ mode: 0, repeatCount: 1, actions: [{ down: true, delay: 5, keycode: 0xf501 }] }, 944)).not.toBeNull();
  });

  it('"Xoá dữ liệu" keeps the slot valid with 0 actions and sends no pages; undo restores', async () => {
    const { macro, mock } = await setup();
    const pages: number[] = [];
    mock.onPacket((e) => { if (e.dir === 'out' && e.bytes[0] === 0x07 && e.bytes[1] === 0x04) pages.push(e.bytes[3]); });
    await macro.clearData(0);
    expect(pages).toEqual([]);
    expect(await mock.getMacroMeta(0)).toMatchObject({ valid: true, actionCount: 0 });
    expect(macro.slots[0].actions).toEqual([]);

    useHistoryStore().undo();
    await useSyncStore().flush();
    expect((await mock.getMacroMeta(0)).actionCount).toBe(6);
  });

  it('balance warnings', () => {
    expect(balanceWarnings([{ down: false, delay: 1, keycode: 4 }])).toEqual({ early: [0], stuck: [] });
    expect(balanceWarnings([{ down: true, delay: 1, keycode: 4 }])).toEqual({ early: [], stuck: [4] });
  });

  it('actionLimit clamps to at most MACRO_PROTOCOL_EVENT_LIMIT (960)', () => {
    expect(MACRO_PROTOCOL_EVENT_LIMIT).toBe(960);
    // E.g. capacity 2000, count 16 -> 960, not 1984
    expect(actionLimit({ count: 16, capacity: 2000 })).toBe(960);
    expect(actionLimit({ count: 16, capacity: 960 })).toBe(944);
  });

  it('undoing a save on an unused slot writes "Clear Data" (valid, 0 actions), never valid=0', async () => {
    const { macro, mock } = await setup();
    // Slot 1 is initially unused in mock
    expect(macro.slots[1].valid).toBe(false);
    const meta = vi.spyOn(mock, 'setMacroMeta');

    await macro.save(1, { mode: 0, repeatCount: 1, actions: sequence(2) });
    expect((await mock.getMacroMeta(1)).valid).toBe(true);

    useHistoryStore().undo();
    await useSyncStore().flush();
    const m = await mock.getMacroMeta(1);
    expect(m.valid).toBe(true);
    expect(m.actionCount).toBe(0);
    expect(macro.slots[1].valid).toBe(true);
    expect(macro.slots[1].actions).toEqual([]);
    expect(meta.mock.calls.every(([x]) => x.valid)).toBe(true);
  });

  it('a failed save rolls the slot back to what the keyboard has', async () => {
    const { macro, mock } = await setup();
    const before = macro.slots[3];
    vi.spyOn(mock, 'setMacroMeta').mockRejectedValue(new Error('usb error'));
    await expect(macro.save(3, { mode: 1, repeatCount: 2, actions: sequence(4) })).rejects.toThrow();
    expect(macro.slots[3]).toEqual(before);
    expect(macro.slots[3].actions).not.toHaveLength(4);
    useSyncStore().reset();
  });

  it('a dropped write (permanent error) restores the slot through onDrop', async () => {
    const { macro, mock } = await setup();
    const before = macro.slots[0];
    vi.spyOn(mock, 'setMacroMeta').mockRejectedValue(new WriteNotAllowedError());
    await expect(macro.clearData(0)).rejects.toThrow();
    expect(macro.slots[0]).toEqual(before);
    expect(macro.slots[0].actions).toHaveLength(6);
  });
});

describe('macro recorder', () => {
  const ev = (code: string, type: 'keydown' | 'keyup', repeat = false) => ({ code, type, repeat });

  /** Feed events, appending recorded actions like the page does. */
  function run(rec: MacroRecorder, events: ReturnType<typeof ev>[], start: MacroAction[] = []) {
    const list = [...start];
    let stop: string | undefined;
    let now = 100;
    for (const e of events) {
      const r = rec.handle(e, list.length, (now += 20));
      if (r.action) list.push(r.action);
      if (r.stop) { stop = r.stop; break; }
    }
    return { list, stop, now };
  }

  it('releases every held key when recording ends (window blur)', () => {
    const rec = new MacroRecorder(944);
    const { list, now } = run(rec, [ev('AltLeft', 'keydown'), ev('ControlLeft', 'keydown')]);
    const extra = rec.finish(now + 50);
    expect(extra.map((a) => [a.keycode, a.down])).toEqual([[226, false], [224, false]]);
    expect(balanceWarnings([...list, ...extra])).toEqual({ early: [], stuck: [] });
    expect(rec.finish(now + 100)).toEqual([]);
  });

  it('keeps room for the releases when the limit is reached', () => {
    const rec = new MacroRecorder(6);
    const { list, stop, now } = run(rec, [ev('ShiftLeft', 'keydown'), ev('AltLeft', 'keydown'), ev('KeyA', 'keydown'), ev('KeyB', 'keydown')]);
    expect(stop).toBe('limit');
    const all = [...list, ...rec.finish(now)];
    expect(all.length).toBeLessThanOrEqual(6);
    expect(balanceWarnings(all).stuck).toEqual([]);
  });

  it('keyups of held keys still fit at the limit', () => {
    const rec = new MacroRecorder(4);
    const { list, stop } = run(rec, [ev('KeyA', 'keydown'), ev('KeyA', 'keyup'), ev('KeyB', 'keydown'), ev('KeyB', 'keyup')]);
    expect(stop).toBeUndefined();
    expect(list).toHaveLength(4);
  });

  it('Esc stops and is not recorded; repeats and stray keyups are ignored', () => {
    const rec = new MacroRecorder(944);
    const { list, stop } = run(rec, [ev('KeyA', 'keydown'), ev('KeyA', 'keydown', true), ev('KeyB', 'keyup'), ev('Escape', 'keydown'), ev('KeyC', 'keydown')]);
    expect(stop).toBe('escape');
    expect(list.map((a) => a.keycode)).toEqual([4]);
    expect(rec.heldCount).toBe(1);
  });
});
