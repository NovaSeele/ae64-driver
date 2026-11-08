// Macro slots (family 07). Follows reference AE64_PROTOCOL.md ("Advanced keys and macros") and macro.js:
// 16 slots, 15 actions per page (the offset byte is a page number), 6 playback modes, repeat 1–9999 for
// click modes and 65535 stored for hold modes, delays 1–32767 ms, capacity guard count + actNum ≤ capacity,
// "Xoá dữ liệu" keeps the slot valid with actNum = 0 and sends no pages.
// Save = meta + every page → commit(SAVE_GROUP.MACRO) (sync store) → full read-back verify; history undoes it.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef } from 'vue';
import { MACRO_ACTIONS_PER_PAGE, MACRO_MAX_DELAY_MS, MACRO_SLOTS, SAVE_GROUP } from '../protocol';
import type { Ae64Transport, MacroAction, MacroMeta } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';
import { KEYBOARD_CODES } from './advanced';

export const MACRO_DELAY_MIN = 1;
export const MACRO_DELAY_MAX = MACRO_MAX_DELAY_MS;
export const MACRO_CLICK_REPEAT_MAX = 9999;
export const MACRO_HOLD_REPEAT = 0xffff;
export const MACRO_PROTOCOL_EVENT_LIMIT = 64 * MACRO_ACTIONS_PER_PAGE;
/** Default capacity when 02 0E reports nothing (the Max reports 16 slots / 960). */
const DEFAULT_CAPACITY = 960;

/** Playback modes 0–3 repeat on click (count 1–9999); 4–5 repeat while held. */
export const MACRO_MODES = [0, 1, 2, 3, 4, 5] as const;
export type MacroMode = (typeof MACRO_MODES)[number];
export function isHoldMode(mode: number): boolean {
  return mode === 4 || mode === 5;
}

export interface MacroSlot { id: number; valid: boolean; mode: MacroMode; repeatCount: number; actions: MacroAction[] }
export interface MacroDraft { valid?: boolean; mode: MacroMode; repeatCount: number; actions: MacroAction[] }

export function storedRepeat(d: { mode: number; repeatCount: number }): number {
  return isHoldMode(d.mode) ? MACRO_HOLD_REPEAT : Math.round(Math.min(MACRO_CLICK_REPEAT_MAX, Math.max(1, d.repeatCount || 1)));
}

/** Per-slot action limit: macroCount + actNum ≤ capacity (macro.js macroActionLimit). */
export function actionLimit(space: { count: number; capacity: number }): number {
  const slots = Math.max(1, Math.min(MACRO_SLOTS, space.count || MACRO_SLOTS));
  const cap = space.capacity || DEFAULT_CAPACITY;
  const raw = Math.max(1, cap > slots ? cap - slots : cap);
  return Math.min(raw, MACRO_PROTOCOL_EVENT_LIMIT);
}

export function validateDraft(d: MacroDraft, limit: number): string | null {
  if (!d.actions.length) return tr('macro.errEmpty');
  if (d.actions.length > limit) return tr('macro.errCapacity', { n: limit });
  for (const [i, a] of d.actions.entries()) {
    if (!KEYBOARD_CODES.has(a.keycode)) return tr('macro.errKey', { i: i + 1 });
    if (!Number.isInteger(a.delay) || a.delay < MACRO_DELAY_MIN || a.delay > MACRO_DELAY_MAX) return tr('macro.errDelay', { i: i + 1, max: MACRO_DELAY_MAX });
  }
  return null;
}

/** Unbalanced press/release warnings (macro.js macroBalanceWarnings). */
export function balanceWarnings(actions: MacroAction[]): { early: number[]; stuck: number[] } {
  const held = new Map<number, number>();
  const early: number[] = [];
  actions.forEach((a, index) => {
    const n = held.get(a.keycode) ?? 0;
    if (a.down) held.set(a.keycode, n + 1);
    else if (!n) early.push(index);
    else held.set(a.keycode, n - 1);
  });
  return { early, stuck: [...held].filter(([, n]) => n > 0).map(([code]) => code) };
}

function sameActions(a: MacroAction[], b: MacroAction[]): boolean {
  return a.length === b.length && a.every((x, i) => x.down === b[i].down && x.delay === b[i].delay && x.keycode === b[i].keycode);
}

export const useMacroStore = defineStore('macro', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();

  const space = ref<{ count: number; capacity: number }>({ count: MACRO_SLOTS, capacity: DEFAULT_CAPACITY });
  const slots = shallowRef<MacroSlot[]>([]);
  const loading = ref(false);
  const loadedCount = ref(0);
  const loadError = ref<string | null>(null);
  const loaded = ref(false);
  let loadPromise: Promise<void> | null = null;
  /** Transport the slots were read from (a reconnect or demo switch reloads). */
  let loadedFor: unknown = null;

  const slotCount = computed(() => Math.max(1, Math.min(MACRO_SLOTS, space.value.count || MACRO_SLOTS)));
  const limit = computed(() => actionLimit(space.value));

  async function readSlot(t: Ae64Transport, id: number): Promise<MacroSlot> {
    const meta = await t.getMacroMeta(id);
    const actions = meta.actionCount ? (await t.readMacroActions(id, meta.actionCount)).slice(0, meta.actionCount) : [];
    return { id, valid: meta.valid, mode: (MACRO_MODES.includes(meta.mode as MacroMode) ? meta.mode : 0) as MacroMode, repeatCount: meta.repeatCount, actions };
  }

  /** Macros are device-wide (not per profile): read once per connection unless forced. */
  function load(force = false): Promise<void> {
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && loaded.value && loadedFor === device.transport) return Promise.resolve();
    loadPromise = (async () => {
      loading.value = true;
      loadError.value = null;
      loadedCount.value = 0;
      try {
        const next: MacroSlot[] = [];
        await device.withTransport(async (t) => {
          space.value = await t.getMacroSpace();
          for (let id = 0; id < slotCount.value; id++) {
            next.push(await readSlot(t, id));
            loadedCount.value++;
          }
        });
        slots.value = next;
        loaded.value = true;
        loadedFor = device.transport;
      } catch (err) {
        loadError.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  function jobFor(id: number, d: MacroDraft) {
    const actions = d.actions.map((a) => ({ ...a }));
    const valid = d.valid ?? true;
    const meta: MacroMeta = { id, valid, actionCount: actions.length, repeatCount: storedRepeat(d), mode: d.mode };
    return {
      key: `macro:${id}`,
      group: SAVE_GROUP.MACRO,
      label: tr('macro.slotName', { n: id }),
      write: async (t: Ae64Transport) => {
        await t.setMacroMeta(meta);
        if (actions.length) await t.writeMacroActions(id, actions);
      },
      verify: async (t: Ae64Transport) => {
        const read = await readSlot(t, id);
        slots.value = slots.value.map((s) => (s.id === id ? read : s));
        return read.valid === meta.valid && read.actions.length === actions.length && read.repeatCount === meta.repeatCount
          && read.mode === meta.mode && sameActions(read.actions, actions);
      },
    };
  }

  function commit(id: number, d: MacroDraft): void {
    slots.value = slots.value.map((s) => (s.id === id
      ? { id, valid: d.valid ?? true, mode: d.mode, repeatCount: storedRepeat(d), actions: d.actions.map((a) => ({ ...a })) }
      : s));
    sync.enqueue(jobFor(id, d));
  }

  function snapshot(s: MacroSlot): MacroDraft {
    return { valid: s.valid, mode: s.mode, repeatCount: s.repeatCount, actions: s.actions.map((a) => ({ ...a })) };
  }

  function push(id: number, before: MacroDraft, after: MacroDraft, label: string): void {
    commit(id, after);
    history.push({ label, undo: () => commit(id, before), redo: () => commit(id, after) });
  }

  /** Validate and write a slot's mode, repeat and full action list; resolves after read-back verification. */
  async function save(id: number, d: MacroDraft): Promise<void> {
    const err = validateDraft(d, limit.value);
    if (err) throw new Error(err);
    const slot = slots.value.find((s) => s.id === id)!;
    push(id, snapshot(slot), { valid: true, mode: d.mode, repeatCount: d.repeatCount, actions: d.actions }, tr('macro.histSave', { n: id }));
    await sync.flush();
  }

  /** "Xoá dữ liệu": slot stays valid, actNum = 0, no data pages; key mappings to the slot are untouched. */
  async function clearData(id: number): Promise<void> {
    const slot = slots.value.find((s) => s.id === id)!;
    push(id, snapshot(slot), { valid: true, mode: slot.mode, repeatCount: slot.repeatCount, actions: [] }, tr('macro.histClear', { n: id }));
    await sync.flush();
  }

  return { space, slots, slotCount, limit, loading, loadedCount, loadError, loaded, load, save, clearData };
});
