// Store for Lighting (area 0: keyboard keys, area 1: perimeter LED strip).
// Follows the per-key page pattern: load -> edit through history + sync -> verify by read-back.
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import {
  LED_MATRIX_COLS, LED_MATRIX_ROWS, LED_STRIP_COUNT, PALETTE_SIZE, SAVE_GROUP,
} from '../protocol';
import type {
  Ae64Transport, LedRecord, LightingBase, PaletteEntry, PhysicalKey,
} from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';

export const LED_MATRIX_TOTAL = LED_MATRIX_ROWS * LED_MATRIX_COLS; // 126

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

export function rgbToHex(c: { r: number; g: number; b: number }): string {
  const h = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

export function hexToRgb(hex: string): RgbColor {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/**
 * Returns matrix cell indices for key. Space maps to 5 cells: [-2, -1, 0, 1, 2] around row 5, col 6.
 * Normal keys map to row * 21 + col.
 */
export function keyMatrixIndices(key: PhysicalKey): number[] {
  if (key.name === 'Space') {
    return [-2, -1, 0, 1, 2]
      .map((off) => key.row * LED_MATRIX_COLS + (key.col + off))
      .filter((idx) => idx >= 0 && idx < LED_MATRIX_TOTAL);
  }
  return [key.row * LED_MATRIX_COLS + key.col];
}

const DEFAULT_BASE_0: LightingBase = {
  area: 0, open: true, openMode: 3, mode: 0, brightness: 80, speed: 50, direction: 0, paletteIndex: 0,
};

const DEFAULT_BASE_1: LightingBase = {
  area: 1, open: true, openMode: 1, mode: 0, brightness: 80, speed: 50, direction: 0, paletteIndex: 0,
};

export const useLightingStore = defineStore('lighting', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();

  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const loadedProfile = ref<number | null>(null);

  // Area 0 (Keyboard)
  const area0Base = ref<LightingBase>({ ...DEFAULT_BASE_0 });
  const area0Palette = ref<PaletteEntry[]>([]);
  const area0Matrix = shallowRef<LedRecord[]>([]);
  const area0ModeCount = ref(19);

  // Area 1 (Strip)
  const area1Base = ref<LightingBase>({ ...DEFAULT_BASE_1 });
  const area1Palette = ref<PaletteEntry[]>([]);
  const area1Matrix = shallowRef<LedRecord[]>([]);
  const area1ModeCount = ref(5);

  // Fresh hardware snapshots for verification & safety
  const freshBase = new Map<number, LightingBase>();
  const freshPalette = new Map<number, PaletteEntry[]>();
  const freshMatrix = new Map<number, LedRecord[]>();
  // Another keyboard (or the demo) was connected: nothing cached belongs to it (load() refetches; every
  // apply is refused until it has, because loadedProfile no longer matches).
  watch(() => device.connection, () => {
    area0Matrix.value = [];
    area1Matrix.value = [];
    freshBase.clear();
    freshPalette.clear();
    freshMatrix.clear();
    loadedProfile.value = null;
  });

  // Live preview poller state
  const livePreview = ref(true);
  const liveColors = shallowRef<Record<number, string>>({});
  const liveStripColors = shallowRef<string[]>([]);
  const polling = ref(false);

  let loadPromise: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollCycle = 0;
  let pollInFlight = false;

  // Key custom color statuses
  const keyCustomColors = computed<Record<number, { custom: boolean; colorHex: string }>>(() => {
    const res: Record<number, { custom: boolean; colorHex: string }> = {};
    const matrix = area0Matrix.value;
    for (const key of device.keys) {
      const indices = keyMatrixIndices(key);
      if (key.name === 'Space') {
        const records = indices.map((i) => matrix[i]).filter(Boolean);
        const custom = records.some((r) => r?.custom);
        const center = records[2] ?? records[0];
        res[key.id] = {
          custom,
          colorHex: center ? rgbToHex(center) : '#73f0c0',
        };
      } else {
        const rec = matrix[indices[0]];
        res[key.id] = {
          custom: Boolean(rec?.custom),
          colorHex: rec ? rgbToHex(rec) : '#73f0c0',
        };
      }
    }
    return res;
  });

  // Strip custom color statuses (38 LEDs)
  const stripCustomColors = computed<{ custom: boolean; colorHex: string }[]>(() => {
    const matrix = area1Matrix.value;
    return Array.from({ length: LED_STRIP_COUNT }, (_, i) => {
      const rec = matrix[i];
      return {
        custom: Boolean(rec?.custom),
        colorHex: rec ? rgbToHex(rec) : '#73f0c0',
      };
    });
  });

  function keyById(id: number): PhysicalKey | undefined {
    return device.keys[id];
  }

  // ------------------------------------------------------------------ Load
  function load(force = false): Promise<void> {
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && loadedProfile.value === device.activeProfile && area0Matrix.value.length > 0) {
      return Promise.resolve();
    }

    loadPromise = (async () => {
      loading.value = true;
      loadError.value = null;
      const profile = device.activeProfile;
      try {
        await device.withTransport(async (t) => {
          try {
            const areas = await t.getLightingAreas();
            if (areas.areas[0]?.modes) area0ModeCount.value = areas.areas[0].modes;
            if (areas.areas[1]?.modes) area1ModeCount.value = areas.areas[1].modes;
          } catch {
            // Use defaults if getLightingAreas unsupported
          }

          const [b0, p0, m0, b1, p1, m1] = await Promise.all([
            t.getLightingBase(0),
            t.getPalette(0),
            t.readLedMatrix(0),
            t.getLightingBase(1),
            t.getPalette(1),
            t.readLedMatrix(1),
          ]);

          area0Base.value = { ...b0 };
          area0Palette.value = p0.map((e) => ({ ...e }));
          area0Matrix.value = m0.map((e) => ({ ...e }));
          freshBase.set(0, { ...b0 });
          freshPalette.set(0, p0.map((e) => ({ ...e })));
          freshMatrix.set(0, m0.map((e) => ({ ...e })));

          area1Base.value = { ...b1 };
          area1Palette.value = p1.map((e) => ({ ...e }));
          area1Matrix.value = m1.map((e) => ({ ...e }));
          freshBase.set(1, { ...b1 });
          freshPalette.set(1, p1.map((e) => ({ ...e })));
          freshMatrix.set(1, m1.map((e) => ({ ...e })));
        });
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

  // ------------------------------------------------------------------ Sync jobs
  function baseJob(area: number, profile: number, base: LightingBase) {
    const written = { ...base };
    return {
      key: `light:base:${profile}:${area}`,
      group: SAVE_GROUP.LIGHTING,
      profile,
      label: tr('lighting.syncBase', { area: area === 0 ? tr('lighting.tabKeys') : tr('lighting.tabStrip') }),
      write: async (t: Ae64Transport) => {
        await t.setLightingBase(written);
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.getLightingBase(area);
        freshBase.set(area, { ...read });
        const expOpenMode = written.open ? (written.openMode || 1) : 0;
        return read.openMode === expOpenMode &&
          read.mode === written.mode &&
          read.brightness === written.brightness &&
          read.speed === written.speed &&
          read.direction === written.direction &&
          read.paletteIndex === written.paletteIndex;
      },
    };
  }

  function paletteJob(area: number, profile: number, palette: PaletteEntry[]) {
    const written = palette.map((e) => ({ ...e }));
    return {
      key: `light:palette:${profile}:${area}`,
      group: SAVE_GROUP.LIGHTING,
      profile,
      label: tr('lighting.syncPalette', { area: area === 0 ? tr('lighting.tabKeys') : tr('lighting.tabStrip') }),
      write: async (t: Ae64Transport) => {
        await t.setPalette(area, written);
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.getPalette(area);
        freshPalette.set(area, read.map((e) => ({ ...e })));
        return written.every((w, i) =>
          read[i] && read[i].r === w.r && read[i].g === w.g && read[i].b === w.b,
        );
      },
    };
  }

  function matrixJob(area: number, profile: number, matrix: LedRecord[]) {
    const written = matrix.map((e) => ({ ...e }));
    return {
      key: `light:matrix:${profile}:${area}`,
      group: SAVE_GROUP.LIGHTING,
      profile,
      label: tr('lighting.syncMatrix', { area: area === 0 ? tr('lighting.tabKeys') : tr('lighting.tabStrip') }),
      write: async (t: Ae64Transport) => {
        await t.writeLedMatrix(area, written);
      },
      verify: async (t: Ae64Transport) => {
        const read = await t.readLedMatrix(area);
        freshMatrix.set(area, read.map((e) => ({ ...e })));
        return written.every((w, i) => {
          const r = read[i];
          if (!r) return false;
          if (w.custom) {
            return r.custom && r.r === w.r && r.g === w.g && r.b === w.b;
          }
          return !r.custom;
        });
      },
    };
  }

  // ------------------------------------------------------------------ Edits & History
  function applyBase(area: number, patch: Partial<LightingBase>, label: string, coalesce?: string): void {
    const profile = device.activeProfile;
    if (loadedProfile.value !== profile) return;
    const target = area === 0 ? area0Base : area1Base;
    const before = { ...target.value };
    const maxMode = (area === 0 ? area0ModeCount.value : area1ModeCount.value) - 1;

    const next: LightingBase = { ...before, ...patch };
    if (next.brightness !== undefined) next.brightness = Math.max(0, Math.min(100, Math.round(next.brightness)));
    if (next.speed !== undefined) next.speed = Math.max(0, Math.min(100, Math.round(next.speed)));
    if (next.direction !== undefined) next.direction = next.direction ? 1 : 0;
    if (next.paletteIndex !== undefined) next.paletteIndex = Math.max(0, Math.min(PALETTE_SIZE - 1, Math.round(next.paletteIndex)));
    if (next.mode !== undefined) next.mode = Math.max(0, Math.min(Math.max(maxMode, 0), Math.round(next.mode)));

    if (patch.openMode !== undefined) {
      next.openMode = patch.openMode;
      next.open = patch.openMode !== 0;
    } else if (patch.open !== undefined) {
      next.open = patch.open;
      if (!patch.open) {
        next.openMode = 0;
      } else if (next.openMode === 0) {
        next.openMode = area === 0 ? 3 : 1;
      }
    }

    const same = before.open === next.open &&
      before.openMode === next.openMode &&
      before.mode === next.mode &&
      before.brightness === next.brightness &&
      before.speed === next.speed &&
      before.direction === next.direction &&
      before.paletteIndex === next.paletteIndex;
    if (same) return;

    const commit = (val: LightingBase) => {
      if (device.activeProfile !== profile) return;
      target.value = { ...val };
      sync.enqueue(baseJob(area, profile, val));
    };

    commit(next);
    history.push({
      label,
      undo: () => commit(before),
      redo: () => commit(next),
      coalesce: coalesce ? `light:base:${area}:${coalesce}` : undefined,
    });
  }

  function applyPaletteColor(
    area: number,
    index: number,
    color: { r: number; g: number; b: number },
    label: string,
    coalesce?: string,
  ): void {
    const profile = device.activeProfile;
    if (loadedProfile.value !== profile || index < 1 || index >= PALETTE_SIZE) return;
    const target = area === 0 ? area0Palette : area1Palette;
    const current = target.value;
    if (!current[index]) return;

    const before = current.map((e) => ({ ...e }));
    const after = current.map((e, i) =>
      i === index
        ? { ...e, r: Math.max(0, Math.min(255, Math.round(color.r))), g: Math.max(0, Math.min(255, Math.round(color.g))), b: Math.max(0, Math.min(255, Math.round(color.b))) }
        : { ...e },
    );

    const same = current[index].r === after[index].r &&
      current[index].g === after[index].g &&
      current[index].b === after[index].b;
    if (same) return;

    const commit = (val: PaletteEntry[]) => {
      if (device.activeProfile !== profile) return;
      target.value = val.map((e) => ({ ...e }));
      sync.enqueue(paletteJob(area, profile, val));
    };

    commit(after);
    history.push({
      label,
      undo: () => commit(before),
      redo: () => commit(after),
      coalesce: coalesce ? `light:pal:${area}:${index}:${coalesce}` : undefined,
    });
  }

  function applyKeyColors(keyIds: number[], color: { r: number; g: number; b: number }, label: string): void {
    const profile = device.activeProfile;
    if (loadedProfile.value !== profile || !keyIds.length) return;
    const before = area0Matrix.value.map((e) => ({ ...e }));
    const after = area0Matrix.value.map((e) => ({ ...e }));

    const targetIndices = new Set<number>();
    for (const id of keyIds) {
      const k = keyById(id);
      if (!k) continue;
      for (const idx of keyMatrixIndices(k)) targetIndices.add(idx);
    }

    const r = Math.max(0, Math.min(255, Math.round(color.r)));
    const g = Math.max(0, Math.min(255, Math.round(color.g)));
    const b = Math.max(0, Math.min(255, Math.round(color.b)));

    let changed = false;
    for (const idx of targetIndices) {
      if (idx >= after.length) continue;
      const cur = after[idx];
      if (!cur.custom || cur.r !== r || cur.g !== g || cur.b !== b) {
        after[idx] = { r, g, b, custom: true };
        changed = true;
      }
    }
    if (!changed) return;

    const commit = (val: LedRecord[]) => {
      if (device.activeProfile !== profile) return;
      area0Matrix.value = val.map((e) => ({ ...e }));
      sync.enqueue(matrixJob(0, profile, val));
    };

    commit(after);
    history.push({
      label,
      undo: () => commit(before),
      redo: () => commit(after),
    });
  }

  function clearKeyColors(keyIds: number[], label: string): void {
    const profile = device.activeProfile;
    if (loadedProfile.value !== profile || !keyIds.length) return;
    const before = area0Matrix.value.map((e) => ({ ...e }));
    const after = area0Matrix.value.map((e) => ({ ...e }));

    const targetIndices = new Set<number>();
    for (const id of keyIds) {
      const k = keyById(id);
      if (!k) continue;
      for (const idx of keyMatrixIndices(k)) targetIndices.add(idx);
    }

    let changed = false;
    for (const idx of targetIndices) {
      if (idx >= after.length) continue;
      if (after[idx].custom) {
        after[idx] = { ...after[idx], custom: false };
        changed = true;
      }
    }
    if (!changed) return;

    const commit = (val: LedRecord[]) => {
      if (device.activeProfile !== profile) return;
      area0Matrix.value = val.map((e) => ({ ...e }));
      sync.enqueue(matrixJob(0, profile, val));
    };

    commit(after);
    history.push({
      label,
      undo: () => commit(before),
      redo: () => commit(after),
    });
  }

  function clearAllKeyColors(label: string): void {
    clearKeyColors(device.keys.map((k) => k.id), label);
  }

  function applyStripColors(ledIndices: number[], color: { r: number; g: number; b: number }, label: string): void {
    const profile = device.activeProfile;
    if (loadedProfile.value !== profile || !ledIndices.length) return;
    const before = area1Matrix.value.map((e) => ({ ...e }));
    const after = area1Matrix.value.map((e) => ({ ...e }));

    const r = Math.max(0, Math.min(255, Math.round(color.r)));
    const g = Math.max(0, Math.min(255, Math.round(color.g)));
    const b = Math.max(0, Math.min(255, Math.round(color.b)));

    let changed = false;
    for (const idx of ledIndices) {
      if (idx < 0 || idx >= LED_STRIP_COUNT || idx >= after.length) continue;
      const cur = after[idx];
      if (!cur.custom || cur.r !== r || cur.g !== g || cur.b !== b) {
        after[idx] = { r, g, b, custom: true };
        changed = true;
      }
    }
    if (!changed) return;

    const commit = (val: LedRecord[]) => {
      if (device.activeProfile !== profile) return;
      area1Matrix.value = val.map((e) => ({ ...e }));
      sync.enqueue(matrixJob(1, profile, val));
    };

    commit(after);
    history.push({
      label,
      undo: () => commit(before),
      redo: () => commit(after),
    });
  }

  function clearStripColors(ledIndices: number[], label: string): void {
    const profile = device.activeProfile;
    if (loadedProfile.value !== profile || !ledIndices.length) return;
    const before = area1Matrix.value.map((e) => ({ ...e }));
    const after = area1Matrix.value.map((e) => ({ ...e }));

    let changed = false;
    for (const idx of ledIndices) {
      if (idx < 0 || idx >= LED_STRIP_COUNT || idx >= after.length) continue;
      if (after[idx].custom) {
        after[idx] = { ...after[idx], custom: false };
        changed = true;
      }
    }
    if (!changed) return;

    const commit = (val: LedRecord[]) => {
      if (device.activeProfile !== profile) return;
      area1Matrix.value = val.map((e) => ({ ...e }));
      sync.enqueue(matrixJob(1, profile, val));
    };

    commit(after);
    history.push({
      label,
      undo: () => commit(before),
      redo: () => commit(after),
    });
  }

  function clearAllStripColors(label: string): void {
    const all = Array.from({ length: LED_STRIP_COUNT }, (_, i) => i);
    clearStripColors(all, label);
  }

  // ------------------------------------------------------------------ Live preview poller (~10 Hz)
  async function tickLivePreview() {
    if (!polling.value) return;
    const canPoll = device.connected &&
      livePreview.value &&
      !device.exclusiveActive &&
      sync.state !== 'writing' &&
      sync.state !== 'pending' &&
      !pollInFlight;

    if (canPoll) {
      pollInFlight = true;
      try {
        await device.withTransport(async (t) => {
          // Read area 0 every tick
          const m0 = await t.readLedMatrix(0);
          const nextKeys: Record<number, string> = {};
          for (const k of device.keys) {
            // Space key uses center LED cell
            const idx = k.row * LED_MATRIX_COLS + k.col;
            const rec = m0[idx];
            if (rec) nextKeys[k.id] = rgbToHex(rec);
          }
          liveColors.value = nextKeys;

          // Read area 1 (strip) every other tick
          if (pollCycle % 2 === 0) {
            const m1 = await t.readLedMatrix(1);
            liveStripColors.value = m1.slice(0, LED_STRIP_COUNT).map(rgbToHex);
          }
          pollCycle++;
        }, { exclusive: false });
      } catch {
        // Suppress poller frame errors
      } finally {
        pollInFlight = false;
      }
    }

    if (polling.value) {
      pollTimer = setTimeout(tickLivePreview, 100);
    }
  }

  function startLivePolling() {
    if (polling.value) return;
    polling.value = true;
    pollCycle = 0;
    pollInFlight = false;
    tickLivePreview();
  }

  function stopLivePolling() {
    polling.value = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  return {
    loading,
    loadError,
    loadedProfile,

    area0Base,
    area0Palette,
    area0Matrix,
    area0ModeCount,

    area1Base,
    area1Palette,
    area1Matrix,
    area1ModeCount,

    keyCustomColors,
    stripCustomColors,

    livePreview,
    liveColors,
    liveStripColors,
    polling,

    load,
    applyBase,
    applyPaletteColor,
    applyKeyColors,
    clearKeyColors,
    clearAllKeyColors,
    applyStripColors,
    clearStripColors,
    clearAllStripColors,

    startLivePolling,
    stopLivePolling,
  };
});
