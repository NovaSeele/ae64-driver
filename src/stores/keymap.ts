// Per-layer keymap for the active profile (layers 0=Main, 1=Fn1, 2=Fn2, 3=Fn3).
// Follows the per-key page pattern: load all 4 layers → edit through history + sync (SAVE_GROUP.LAYOUT) → verify by read-back.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import { FIRMWARE_ROWS, LAYER_COUNT, SAVE_GROUP, keycodeLabel } from '../protocol';
import { BLOCKED_KEYCODES } from '../protocol/safety';
import type { Ae64Transport, PhysicalKey } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';

export const LAYER_NAMES = ['Main', 'Fn1', 'Fn2', 'Fn3'] as const;
export type LayerIndex = 0 | 1 | 2 | 3;

/** An assignment touching more keys than this needs a confirmation. */
export const BULK_CONFIRM_KEYS = 8;

/** True when an assignment changing `changed` keys needs the user's confirmation first. */
export function needsAssignConfirm(changed: number, factoryLost: readonly FactoryKey[]): boolean {
  return changed > BULK_CONFIRM_KEYS || factoryLost.length > 0;
}

export interface FactoryKey { layer: number; id: number; code: number }

export interface DefaultDiff {
  diffCount: number;
  defaultCodes: Record<number, number>;
  /** Keys whose factory default is a blocked keycode: left as they are. */
  skipped: number;
  /** Key ids holding a factory keycode now that the restore would overwrite for good. */
  factoryLost: number[];
}

export interface KeycodePlan {
  /** Layer:key tokens that would change, with the keycode they hold now / would hold after. */
  before: Record<string, number>;
  after: Record<string, number>;
  fnGuarded: boolean;
  /** Keys holding a factory keycode (Reset/Link/wireless) that the assignment would overwrite for good. */
  factoryLost: FactoryKey[];
}

export function isFnSwitch(code: number): boolean {
  return code >= 0xf101 && code <= 0xf103;
}

export const useKeymapStore = defineStore('keymap', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();

  const activeLayer = ref<LayerIndex>(0);
  /** Keycodes by layer index (0..3) and PhysicalKey.id (0..63). */
  const values = shallowRef<Record<number, Record<number, number>>>({ 0: {}, 1: {}, 2: {}, 3: {} });
  const loading = ref(false);
  const loadedCount = ref(0);
  const loadError = ref<string | null>(null);
  const loadedProfile = ref<number | null>(null);
  const fnNoticeTriggered = ref(false);

  /** Last keycode read from the board per layer:keyId. */
  const fresh = new Map<string, number>();
  // Another keyboard (or the demo) was connected: nothing cached belongs to it.
  watch(() => device.connection, () => {
    values.value = { 0: {}, 1: {}, 2: {}, 3: {} };
    fresh.clear();
    loadedProfile.value = null;
    fnNoticeTriggered.value = false;
  });
  // The Fn-rule notice belongs to the profile it was triggered in.
  device.onProfileChanged(() => { fnNoticeTriggered.value = false; });
  let loadPromise: Promise<void> | null = null;

  function token(layer: number, id: number): string {
    return `${layer}:${id}`;
  }

  function keyById(id: number): PhysicalKey {
    return device.keys[id];
  }

  /** Sequentially load 4 layers × 5 rows for the active profile. */
  function load(force = false): Promise<void> {
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && loadedProfile.value === device.activeProfile && Object.keys(values.value[0] || {}).length) {
      return Promise.resolve();
    }
    loadPromise = (async () => {
      loading.value = true;
      loadError.value = null;
      loadedCount.value = 0;
      values.value = { 0: {}, 1: {}, 2: {}, 3: {} };
      fresh.clear();
      const profile = device.activeProfile;
      try {
        const next: Record<number, Record<number, number>> = { 0: {}, 1: {}, 2: {}, 3: {} };
        await device.withTransport(async (t) => {
          for (let layer = 0; layer < LAYER_COUNT; layer++) {
            for (const row of FIRMWARE_ROWS) {
              const rowCodes = await t.getKeymapRow(layer, row);
              for (const key of device.keys) {
                if (key.row === row) {
                  const code = rowCodes[key.col] ?? 0;
                  next[layer][key.id] = code;
                  fresh.set(token(layer, key.id), code);
                }
              }
              loadedCount.value++;
            }
          }
        });
        values.value = next;
        loadedProfile.value = profile;
      } catch (err) {
        loadError.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  /** Find the keycode inherited from lower layers when this key is Transparent (0x0001). */
  function inheritedKeycode(keyId: number, fromLayer: number): number {
    for (let l = fromLayer - 1; l >= 0; l--) {
      const code = values.value[l]?.[keyId];
      if (code !== undefined && code !== 0x0001) return code;
    }
    return values.value[0]?.[keyId] ?? 0;
  }

  /** What to display on the keycap legend (top). Transparent shows faint '▽', Empty shows '—'. */
  function legendFor(key: PhysicalKey, layer = activeLayer.value): string {
    const code = values.value[layer]?.[key.id];
    if (code === undefined) return key.name;
    if (code === 0x0000) return '—';
    if (code === 0x0001) return '▽';
    return keycodeLabel(code).label;
  }

  /** Secondary sublabel (underneath). For Transparent keys, shows inherited key label. */
  function sublabelFor(key: PhysicalKey, layer = activeLayer.value): string | undefined {
    const code = values.value[layer]?.[key.id];
    if (code === 0x0001) {
      const inh = inheritedKeycode(key.id, layer);
      if (inh === 0x0000) return '—';
      if (inh === 0x0001) return key.name;
      return keycodeLabel(inh).label;
    }
    return undefined;
  }

  function jobFor(layer: number, id: number, profile: number, keycode: number) {
    const key = keyById(id);
    return {
      key: `keymap:${profile}:${layer}:${id}`,
      group: SAVE_GROUP.LAYOUT,
      profile,
      label: tr('keymap.keyLabel', { layer: LAYER_NAMES[layer], key: device.legend(key) }),
      write: async (t: Ae64Transport) => {
        await t.setKeycode(key, keycode, layer);
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.getKeycode(key, layer);
        fresh.set(token(layer, id), read);
        if (layer === 0 && loadedProfile.value === profile) {
          const nextLayer0 = [...device.layer0];
          nextLayer0[id] = read;
          device.layer0 = nextLayer0;
        }
        return read === keycode;
      },
      // Not saved: show the keycode the key really has.
      onDrop: () => {
        const real = fresh.get(token(layer, id));
        if (real === undefined || loadedProfile.value !== profile || !values.value[layer]) return;
        values.value = { ...values.value, [layer]: { ...values.value[layer], [id]: real } };
        if (layer === 0) device.layer0 = device.keys.map((k) => values.value[0]?.[k.id] ?? 0);
      },
    };
  }

  function commit(map: Record<string, number>): void {
    const profile = device.activeProfile;
    if (profile !== loadedProfile.value) return;
    const next: Record<number, Record<number, number>> = {
      0: { ...values.value[0] },
      1: { ...values.value[1] },
      2: { ...values.value[2] },
      3: { ...values.value[3] },
    };
    let layer0Changed = false;
    for (const [tok, code] of Object.entries(map)) {
      if (BLOCKED_KEYCODES.has(code)) continue;
      const [lStr, idStr] = tok.split(':');
      const layer = Number(lStr);
      const id = Number(idStr);
      if (next[layer]) next[layer][id] = code;
      if (layer === 0) layer0Changed = true;
      sync.enqueue(jobFor(layer, id, profile, code));
    }
    values.value = next;
    if (layer0Changed) {
      device.layer0 = device.keys.map((k) => next[0][k.id] ?? 0);
    }
  }

  /** Keys on any layer that hold a factory keycode: this app can never write those back. */
  const factoryKeys = computed<FactoryKey[]>(() => {
    const list: FactoryKey[] = [];
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      for (const [idStr, code] of Object.entries(values.value[layer] ?? {})) {
        if (BLOCKED_KEYCODES.has(code)) list.push({ layer, id: Number(idStr), code });
      }
    }
    return list;
  });

  /**
   * What assigning a keycode to keys on the active layer would change.
   * If keycode is an Fn-layer switch (F101–F103), higher layers at the same position
   * automatically receive Transparent (0x0001) per reference rule.
   */
  function planKeycode(ids: number[], keycode: number): KeycodePlan {
    const plan: KeycodePlan = { before: {}, after: {}, fnGuarded: false, factoryLost: [] };
    if (BLOCKED_KEYCODES.has(keycode)) return plan;
    if (loadedProfile.value !== device.activeProfile || !ids.length) return plan;
    const currentL = activeLayer.value;
    const note = (layer: number, id: number, prev: number, next: number) => {
      plan.before[token(layer, id)] = prev;
      plan.after[token(layer, id)] = next;
      if (BLOCKED_KEYCODES.has(prev)) plan.factoryLost.push({ layer, id, code: prev });
    };
    for (const id of ids) {
      const prev = values.value[currentL]?.[id] ?? 0;
      if (prev !== keycode) note(currentL, id, prev, keycode);

      // Fn release rule: higher layers get Transparent (0x0001)
      if (isFnSwitch(keycode)) {
        for (let higher = currentL + 1; higher < LAYER_COUNT; higher++) {
          const higherPrev = values.value[higher]?.[id] ?? 0;
          if (higherPrev !== 0x0001) {
            note(higher, id, higherPrev, 0x0001);
            plan.fnGuarded = true;
          }
        }
      }
    }
    return plan;
  }

  /** Assign a keycode to multiple keys on the active layer (see planKeycode). */
  function applyKeycode(ids: number[], keycode: number): { fnGuarded: boolean } {
    const { before, after, fnGuarded } = planKeycode(ids, keycode);
    if (!Object.keys(after).length) return { fnGuarded: false };
    if (fnGuarded) fnNoticeTriggered.value = true;

    commit(after);
    history.push({
      label: tr('keymap.editLabel', { n: ids.length }),
      undo: () => commit(before),
      redo: () => commit(after),
    });

    return { fnGuarded };
  }

  /**
   * Read the factory default keycodes for a layer (using current systemMode) and compute diff.
   */
  async function computeDefaultDiff(layer = activeLayer.value): Promise<DefaultDiff> {
    if (loadedProfile.value !== device.activeProfile) throw new Error(tr('keymap.notLoaded'));
    const defaultCodes: Record<number, number> = {};
    let diffCount = 0;
    let skipped = 0;
    const factoryLost: number[] = [];
    await device.withTransport(async (t) => {
      const sys = await t.getSystemMode();
      for (const row of FIRMWARE_ROWS) {
        const rowCodes = await t.getDefaultKeymapRow(sys, layer, row);
        for (const key of device.keys) {
          if (key.row === row) {
            const defCode = rowCodes[key.col] ?? 0;
            // Factory reset / wireless codes are never written by this app (protocol/safety.ts).
            if (BLOCKED_KEYCODES.has(defCode)) {
              skipped++;
              continue;
            }
            defaultCodes[key.id] = defCode;
            const cur = values.value[layer]?.[key.id];
            if (cur !== defCode) {
              diffCount++;
              if (cur !== undefined && BLOCKED_KEYCODES.has(cur)) factoryLost.push(key.id);
            }
          }
        }
      }
    });
    return { diffCount, defaultCodes, skipped, factoryLost };
  }

  /** Apply default keymap to the layer. Returns how many keys were really queued for writing. */
  function applyDefault(layer: number, defaultCodes: Record<number, number>): number {
    if (loadedProfile.value !== device.activeProfile) return 0;
    const before: Record<string, number> = {};
    const after: Record<string, number> = {};
    for (const [idStr, defCode] of Object.entries(defaultCodes)) {
      const id = Number(idStr);
      const cur = values.value[layer]?.[id] ?? 0;
      if (cur !== defCode) {
        before[token(layer, id)] = cur;
        after[token(layer, id)] = defCode;
      }
    }
    const n = Object.keys(after).length;
    if (!n) return 0;
    commit(after);
    history.push({
      label: tr('keymap.restoreDefaultTitle'),
      undo: () => commit(before),
      redo: () => commit(after),
    });
    return n;
  }

  return {
    activeLayer, values, loading, loadedCount, loadError, loadedProfile, fnNoticeTriggered,
    factoryKeys, load, legendFor, sublabelFor, inheritedKeycode, planKeycode, applyKeycode, computeDefaultDiff, applyDefault,
  };
});
