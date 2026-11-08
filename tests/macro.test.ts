import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, SAVE_GROUP } from '../src/protocol';
import type { MacroAction } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { MACRO_HOLD_REPEAT, actionLimit, balanceWarnings, useMacroStore, validateDraft } from '../src/stores/macro';

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
});
