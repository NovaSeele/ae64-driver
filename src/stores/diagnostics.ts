// Diagnostics store: export/import configuration backup (JSON), validate schema & board, calculate diffs.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  ALLOWED_BOARDS, FIRMWARE_ROWS, LAYER_COUNT, MACRO_SLOTS, SAVE_GROUP,
} from '../protocol';
import type {
  AdvancedRecord, LedRecord, LightingBase, MacroAction, MacroMeta,
  PaletteEntry, Performance,
} from '../protocol';
import { BLOCKED_KEYCODES } from '../protocol/safety';
import { useDeviceStore } from './device';
import { useKeymapStore } from './keymap';
import { usePerformanceStore } from './performance';
import { useSettingsStore } from './settings';

export interface BackupPayload {
  schemaVersion: 1;
  appName: 'ae64max';
  boardIdHex: string;
  timestamp: string;
  profileIndex: number;
  profileName: string;
  globalSettings: {
    systemMode: number;
    pollingRate: number;
    rgbSleep: number;
    shakeOptimization: boolean;
  };
  keymap: Record<number, Record<number, number>>;
  performance: Record<number, Performance>;
  lighting: {
    areas: {
      area: number;
      base: LightingBase;
      palette: PaletteEntry[];
      leds: LedRecord[];
    }[];
  };
  advanced: AdvancedRecord[];
  macros: { meta: MacroMeta; actions: MacroAction[] }[];
}

export interface ImportDiff {
  payload: BackupPayload;
  keymapDiffCount: number;
  perfDiffCount: number;
  settingsDiffCount: number;
}

export const useDiagnosticsStore = defineStore('diagnostics', () => {
  const device = useDeviceStore();
  const keymapStore = useKeymapStore();
  const perfStore = usePerformanceStore();
  const settingsStore = useSettingsStore();

  const isExporting = ref(false);
  const isRestoring = ref(false);
  const importDiff = ref<ImportDiff | null>(null);

  /**
   * Reads the active profile's full configuration from device and returns the versioned JSON payload.
   */
  async function generateBackup(): Promise<BackupPayload> {
    isExporting.value = true;
    try {
      return await device.withTransport(async (t) => {
        const info = await t.getDeviceInfo();
        const activeProfile = await t.getActiveProfile();
        const profileName = (await t.getProfileName(activeProfile)) || `Profile ${activeProfile + 1}`;

        // Global settings
        const globalSettings = {
          systemMode: await t.getSystemMode(),
          pollingRate: await t.getPollingRate(),
          rgbSleep: await t.getRgbSleep(),
          shakeOptimization: await t.getShakeOptimization(),
        };

        // Keymap (4 layers × 64 keys)
        const keymap: Record<number, Record<number, number>> = { 0: {}, 1: {}, 2: {}, 3: {} };
        for (let layer = 0; layer < LAYER_COUNT; layer++) {
          for (const row of FIRMWARE_ROWS) {
            const rowCodes = await t.getKeymapRow(layer, row);
            for (const key of device.keys) {
              if (key.row === row) {
                keymap[layer][key.id] = rowCodes[key.col] ?? 0;
              }
            }
          }
        }

        // Performance (64 keys)
        const performance: Record<number, Performance> = {};
        for (const key of device.keys) {
          performance[key.id] = await t.getPerformance(key);
        }

        // Lighting (area 0 keyboard + area 1 strip)
        const lightingAreas = [0, 1];
        const lightingList = [];
        for (const area of lightingAreas) {
          lightingList.push({
            area,
            base: await t.getLightingBase(area),
            palette: await t.getPalette(area),
            leds: await t.readLedMatrix(area),
          });
        }

        // Advanced records (64 keys)
        const advanced: AdvancedRecord[] = [];
        for (const key of device.keys) {
          advanced.push(await t.getAdvanced(key));
        }

        // Macros (16 slots)
        const macros: { meta: MacroMeta; actions: MacroAction[] }[] = [];
        for (let slot = 0; slot < MACRO_SLOTS; slot++) {
          const meta = await t.getMacroMeta(slot);
          const actions = meta.actionCount > 0 ? await t.readMacroActions(slot, meta.actionCount) : [];
          macros.push({ meta, actions });
        }

        const payload: BackupPayload = {
          schemaVersion: 1,
          appName: 'ae64max',
          boardIdHex: info.boardIdHex,
          timestamp: new Date().toISOString(),
          profileIndex: activeProfile,
          profileName,
          globalSettings,
          keymap,
          performance,
          lighting: { areas: lightingList },
          advanced,
          macros,
        };

        return payload;
      }, { exclusive: true });
    } finally {
      isExporting.value = false;
    }
  }

  /**
   * Validate JSON text and calculate diff against current device state.
   */
  async function parseAndDiffBackup(jsonText: string): Promise<ImportDiff> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      throw new Error('invalid_json');
    }

    if (!parsed || typeof parsed !== 'object' || (parsed as BackupPayload).schemaVersion !== 1) {
      throw new Error('invalid_schema');
    }

    const payload = parsed as BackupPayload;
    if (!payload.boardIdHex || !ALLOWED_BOARDS.includes(payload.boardIdHex.toLowerCase())) {
      throw new Error('invalid_board');
    }

    // Ensure stores are populated for comparison
    await keymapStore.load();
    await perfStore.load();
    await settingsStore.load();

    // Keymap diff count
    let keymapDiffCount = 0;
    for (let layer = 0; layer < LAYER_COUNT; layer++) {
      const layerMap = payload.keymap?.[layer] ?? {};
      for (const key of device.keys) {
        const cur = keymapStore.values[layer]?.[key.id];
        const next = layerMap[key.id];
        if (next !== undefined && cur !== next) {
          keymapDiffCount++;
        }
      }
    }

    // Performance diff count
    let perfDiffCount = 0;
    for (const key of device.keys) {
      const cur = perfStore.values[key.id];
      const next = payload.performance?.[key.id];
      if (cur && next) {
        if (
          cur.mode !== next.mode
          || Math.abs(cur.normalPress - next.normalPress) > 0.001
          || Math.abs(cur.rtFirstTouch - next.rtFirstTouch) > 0.001
          || Math.abs(cur.rtPress - next.rtPress) > 0.001
          || Math.abs(cur.rtRelease - next.rtRelease) > 0.001
          || Math.abs(cur.pressDeadStroke - next.pressDeadStroke) > 0.001
          || Math.abs(cur.releaseDeadStroke - next.releaseDeadStroke) > 0.001
        ) {
          perfDiffCount++;
        }
      }
    }

    // Settings diff count
    let settingsDiffCount = 0;
    if (payload.globalSettings) {
      if (payload.globalSettings.systemMode !== undefined && payload.globalSettings.systemMode !== settingsStore.systemMode) {
        settingsDiffCount++;
      }
      if (payload.globalSettings.rgbSleep !== undefined && payload.globalSettings.rgbSleep !== settingsStore.rgbSleep) {
        settingsDiffCount++;
      }
      if (payload.globalSettings.shakeOptimization !== undefined && payload.globalSettings.shakeOptimization !== settingsStore.shakeOptimization) {
        settingsDiffCount++;
      }
    }

    const diff: ImportDiff = {
      payload,
      keymapDiffCount,
      perfDiffCount,
      settingsDiffCount,
    };
    importDiff.value = diff;
    return diff;
  }

  /**
   * Apply restore: writes keymap, performance and global settings through standard transport calls.
   * Only changed records are written to minimize bus traffic and wear.
   */
  async function applyRestore(diff: ImportDiff): Promise<void> {
    isRestoring.value = true;
    const { payload } = diff;
    try {
      await device.withTransport(async (t) => {
        // 1. Keymap restore (only changed keys)
        if (payload.keymap) {
          let layoutCommitted = false;
          for (let layer = 0; layer < LAYER_COUNT; layer++) {
            const layerMap = payload.keymap[layer];
            if (!layerMap) continue;
            for (const key of device.keys) {
              const code = layerMap[key.id];
              if (code !== undefined && keymapStore.values[layer]?.[key.id] !== code && !BLOCKED_KEYCODES.has(code)) {
                await t.setKeycode(key, code, layer);
                layoutCommitted = true;
              }
            }
          }
          if (layoutCommitted) {
            await t.commit(SAVE_GROUP.LAYOUT);
          }
        }

        // 2. Performance restore (only changed keys, preserving hardware-owned fields)
        if (payload.performance) {
          let perfCommitted = false;
          for (const key of device.keys) {
            const next = payload.performance[key.id];
            const cur = perfStore.values[key.id];
            if (next && cur) {
              const changed = cur.mode !== next.mode
                || Math.abs(cur.normalPress - next.normalPress) > 0.001
                || Math.abs(cur.rtFirstTouch - next.rtFirstTouch) > 0.001
                || Math.abs(cur.rtPress - next.rtPress) > 0.001
                || Math.abs(cur.rtRelease - next.rtRelease) > 0.001
                || Math.abs(cur.pressDeadStroke - next.pressDeadStroke) > 0.001
                || Math.abs(cur.releaseDeadStroke - next.releaseDeadStroke) > 0.001;
              if (changed) {
                const fresh = await t.getPerformance(key);
                await t.setPerformance(key, {
                  ...fresh,
                  ...next,
                  axis: fresh.axis,
                  calibrate: fresh.calibrate,
                  axisV2Id: fresh.axisV2Id,
                  axisRangeMax: fresh.axisRangeMax,
                  axisCoefficient: fresh.axisCoefficient,
                });
                perfCommitted = true;
              }
            }
          }
          if (perfCommitted) {
            await t.commit(SAVE_GROUP.PERFORMANCE);
          }
        }

        // 3. Global settings restore
        if (payload.globalSettings) {
          const s = payload.globalSettings;
          let settingsCommitted = false;
          if (s.systemMode !== undefined && s.systemMode !== settingsStore.systemMode) {
            await t.setSystemMode(s.systemMode);
            settingsCommitted = true;
          }
          if (s.rgbSleep !== undefined && s.rgbSleep !== settingsStore.rgbSleep) {
            await t.setRgbSleep(s.rgbSleep);
            settingsCommitted = true;
          }
          if (s.shakeOptimization !== undefined && s.shakeOptimization !== settingsStore.shakeOptimization) {
            await t.setShakeOptimization(s.shakeOptimization);
            settingsCommitted = true;
          }
          // Polling rate is not restored here: changing it restarts the keyboard's USB interface, so it
          // must be the last command of a session (Settings page). Global settings need no commit.
          void settingsCommitted;
        }
      }, { exclusive: true });

      // Refresh stores
      await Promise.all([
        keymapStore.load(true),
        perfStore.load(true),
        settingsStore.load(),
        device.refreshLayer0(),
      ]);
      importDiff.value = null;
    } finally {
      isRestoring.value = false;
    }
  }

  return {
    isExporting, isRestoring, importDiff,
    generateBackup, parseAndDiffBackup, applyRestore,
  };
});
