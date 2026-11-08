// Diagnostics store: export/import configuration backup (JSON), validate schema & board, calculate diffs.
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  ALLOWED_BOARDS, FIRMWARE_ROWS, KEYCODE_GROUPS, LAYER_COUNT, MACRO_SLOTS, SAVE_GROUP, decodeCombo, supportsIntervalRt,
} from '../protocol';
import type {
  AdvancedRecord, LedRecord, LightingBase, MacroAction, MacroMeta,
  PaletteEntry, Performance,
} from '../protocol';
import { BLOCKED_KEYCODES, isWritableKeycode } from '../protocol/safety';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useKeymapStore } from './keymap';
import { isKnownMode, rangeMm, usePerformanceStore } from './performance';
import { useSettingsStore } from './settings';
import { useSyncStore } from './sync';

const ASSIGNABLE_KEYCODES = new Set<number>();
for (const g of KEYCODE_GROUPS) {
  for (const entry of g.codes) {
    ASSIGNABLE_KEYCODES.add(entry.code);
  }
}

function validateBackupPayload(
  payload: BackupPayload,
  deviceKeys: readonly { id: number }[],
  currentKeymap: Record<number, Record<number, number>>,
  currentPerf: Record<number, Performance>,
  intervalRt: boolean,
): void {
  // 1. Keymap validation
  if (payload.keymap) {
    for (const [lStr, layerMap] of Object.entries(payload.keymap)) {
      const layer = Number(lStr);
      if (!Number.isInteger(layer) || layer < 0 || layer >= LAYER_COUNT || !layerMap) continue;
      for (const [idStr, code] of Object.entries(layerMap)) {
        const id = Number(idStr);
        if (!deviceKeys[id]) continue;
        if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 0xffff) {
          throw new Error(`Invalid keycode ${code} at layer ${layer}, key ${id}`);
        }
        if (BLOCKED_KEYCODES.has(code)) {
          throw new Error(`Blocked keycode 0x${code.toString(16).padStart(4, '0')} at layer ${layer}, key ${id}`);
        }
        const cur = currentKeymap[layer]?.[id];
        const isCurrent = cur !== undefined && cur === code;
        const isAssignable = ASSIGNABLE_KEYCODES.has(code) || decodeCombo(code) !== null;
        if (!isCurrent && !isAssignable) {
          throw new Error(`Unassignable keycode 0x${code.toString(16).padStart(4, '0')} at layer ${layer}, key ${id}`);
        }
        // A code the keyboard already has is left alone (the write loop skips it); a different one must be writable.
        if (!isCurrent && !isWritableKeycode(code)) {
          throw new Error(`Unwritable keycode 0x${code.toString(16).padStart(4, '0')} at layer ${layer}, key ${id}`);
        }
      }
    }
  }

  // 2. Performance validation
  if (payload.performance) {
    const distFields = [
      'normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke',
    ] as const;
    for (const [idStr, perf] of Object.entries(payload.performance)) {
      const id = Number(idStr);
      if (!deviceKeys[id] || !perf) continue;
      if (perf.mode !== 0 && perf.mode !== 1 && perf.mode !== 2) {
        throw new Error(`Invalid performance mode ${perf.mode} at key ${id}`);
      }
      const cur = currentPerf[id];
      // Same rule as the transport guard, checked up front so a restore never stops half-way.
      if (perf.mode === 2 && !intervalRt && cur?.mode !== 2) {
        throw new Error(`Performance mode 2 at key ${id} needs firmware protocol 1.3.0.0 or newer`);
      }
      const max = cur ? rangeMm(cur) : 4;
      for (const field of distFields) {
        const val = perf[field];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > max + 0.0005) {
          throw new Error(`Invalid performance distance ${field}=${val} at key ${id} (key travel ${max} mm)`);
        }
      }
    }
  }

  // 3. Global settings validation
  if (payload.globalSettings) {
    const s = payload.globalSettings;
    if (s.systemMode !== undefined && (typeof s.systemMode !== 'number' || !Number.isInteger(s.systemMode) || s.systemMode < 0)) {
      throw new Error(`Invalid systemMode ${s.systemMode}`);
    }
    if (s.rgbSleep !== undefined && (typeof s.rgbSleep !== 'number' || !Number.isInteger(s.rgbSleep) || s.rgbSleep < 0)) {
      throw new Error(`Invalid rgbSleep ${s.rgbSleep}`);
    }
    if (s.shakeOptimization !== undefined) {
      const isBool = typeof s.shakeOptimization === 'boolean';
      const isInt = typeof s.shakeOptimization === 'number' && Number.isInteger(s.shakeOptimization) && s.shakeOptimization >= 0;
      if (!isBool && !isInt) {
        throw new Error(`Invalid shakeOptimization ${s.shakeOptimization}`);
      }
    }
  }
}

/** Build time as reported by the board ("YYYYMMDDHH:MM:SS") → "YYYY-MM-DD HH:MM:SS"; anything else is shown as is. */
export function formatBuildTime(raw: string | undefined): string {
  if (!raw) return '—';
  const m = /^(\d{4})(\d{2})(\d{2})\s*(\d{2}:\d{2}:\d{2})$/.exec(raw.trim());
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}` : raw;
}

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
  // A diff was computed against another profile: it no longer describes what a restore would change.
  watch(() => device.activeProfile, () => { importDiff.value = null; });

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
    const fileBoard = typeof payload.boardIdHex === 'string' ? payload.boardIdHex.toLowerCase() : '';
    if (!fileBoard || !ALLOWED_BOARDS.includes(fileBoard)) {
      throw new Error(`invalid_board:${fileBoard.toUpperCase()}`);
    }
    // A backup of another allowed board (Pro onto Max) must never be written to this one.
    const deviceBoard = device.info?.boardIdHex?.toLowerCase();
    if (deviceBoard !== fileBoard) {
      throw new Error(`invalid_board_mismatch:${fileBoard.toUpperCase()}:${(deviceBoard ?? '').toUpperCase()}`);
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
  async function applyRestore(diff: ImportDiff): Promise<{ skipped: number }> {
    const { payload } = diff;
    if (payload.boardIdHex?.toLowerCase() !== device.info?.boardIdHex?.toLowerCase()) {
      throw new Error(`invalid_board_mismatch:${String(payload.boardIdHex).toUpperCase()}:${(device.info?.boardIdHex ?? '').toUpperCase()}`);
    }
    isRestoring.value = true;
    try {
      const sync = useSyncStore();
      const history = useHistoryStore();

      await sync.flush(); // pending edits reach the keyboard before the baseline is read
      // No write may reach the keyboard behind the restore: pause the queue and undo/redo from here on
      // (loads are reads through withTransport; hold does not block them).
      const holdRelease = sync.hold();
      const resume = history.suspend();
      const release = () => { holdRelease(); resume(); };

      try {
        // Always re-read: the stores only follow a profile switch while their own page is open.
        await keymapStore.load(true);
        await perfStore.load(true);
        if (
          keymapStore.loadError || perfStore.loadError
          || keymapStore.loadedProfile !== device.activeProfile || perfStore.loadedProfile !== device.activeProfile
        ) {
          throw new Error(tr('diagnostics.importUnreadable'));
        }
        validateBackupPayload(payload, device.keys, keymapStore.values, perfStore.values, supportsIntervalRt(device.version));
      } catch (err) {
        release();
        throw err;
      }

      const writtenSections: string[] = [];
      let skipped = 0;
      let currentSection = '';
      let restoreError: Error | null = null;

      try {
        await device.withTransport(async (t) => {
          // 1. Keymap restore (only changed keys)
          if (payload.keymap) {
            currentSection = 'keymap';
            let layoutCommitted = false;
            for (let layer = 0; layer < LAYER_COUNT; layer++) {
              const layerMap = payload.keymap[layer];
              if (!layerMap) continue;
              for (const key of device.keys) {
                const code = layerMap[key.id];
                if (code !== undefined && keymapStore.values[layer]?.[key.id] !== code && isWritableKeycode(code)) {
                  await t.setKeycode(key, code, layer);
                  layoutCommitted = true;
                }
              }
            }
            if (layoutCommitted) {
              await t.commit(SAVE_GROUP.LAYOUT);
            }
            writtenSections.push('keymap');
          }

          // 2. Performance restore (only changed keys, preserving hardware-owned fields)
          if (payload.performance) {
            currentSection = 'performance';
            let perfCommitted = false;
            for (const key of device.keys) {
              const next = payload.performance[key.id];
              const cur = perfStore.values[key.id];
              // Keys reporting a mode this app does not know are left alone (as in the Performance page).
              if (next && (!cur || !isKnownMode(cur.mode))) skipped++;
              if (next && cur && isKnownMode(cur.mode)) {
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
            writtenSections.push('performance');
          }

          // 3. Global settings restore
          if (payload.globalSettings) {
            currentSection = 'settings';
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
            if (s.shakeOptimization !== undefined && Boolean(s.shakeOptimization) !== settingsStore.shakeOptimization) {
              await t.setShakeOptimization(Boolean(s.shakeOptimization));
              settingsCommitted = true;
            }
            // Polling rate is not restored here: changing it restarts the keyboard's USB interface, so it
            // must be the last command of a session (Settings page). Global settings need no commit.
            void settingsCommitted;
            writtenSections.push('settings');
          }
        }, { exclusive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const prefix = writtenSections.length > 0 ? `${writtenSections.join(', ')} written; ` : '';
        restoreError = new Error(`${prefix}${currentSection} failed: ${msg}`);
      } finally {
        try {
          await Promise.all([
            keymapStore.load(true),
            perfStore.load(true),
            settingsStore.load(),
            device.refreshLayer0(),
          ]);
        } catch {
          // ignore refresh errors
        }
        history.clear();
        if (!restoreError) {
          importDiff.value = null;
        }
        release();
        if (restoreError) throw restoreError;
      }
      return { skipped };
    } finally {
      isRestoring.value = false;
    }
  }

  return {
    isExporting, isRestoring, importDiff,
    generateBackup, parseAndDiffBackup, applyRestore,
  };
});
