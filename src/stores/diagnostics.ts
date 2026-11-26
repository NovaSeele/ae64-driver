// Diagnostics store: export/import configuration backup (JSON), validate schema & board, calculate diffs.
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import {
  ALLOWED_BOARDS, FIRMWARE_ROWS, KEYCODE_GROUPS, LAYER_COUNT, MACRO_SLOTS, SAVE_GROUP, decodeCombo, isRtMode, supportsIntervalRt,
} from '../protocol';
import type {
  AdvancedRecord, KeyPos, LedRecord, LightingBase, MacroAction, MacroMeta,
  PaletteEntry, Performance, SaveGroup,
} from '../protocol';
import { BLOCKED_KEYCODES, UnsafeCommandError, checkFrame, checkPerformanceWrite, isWritableKeycode } from '../protocol/safety';
import { restoreFrames } from '../protocol/client';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { LAYER_NAMES, breaksFnRule, useKeymapStore } from './keymap';
import { isKnownMode, perfMinMm, rangeMm, usePerformanceStore } from './performance';
import { useSettingsStore } from './settings';
import { useSyncStore } from './sync';

const ASSIGNABLE_KEYCODES = new Set<number>();
for (const g of KEYCODE_GROUPS) {
  for (const entry of g.codes) {
    ASSIGNABLE_KEYCODES.add(entry.code);
  }
}

const hex4 = (code: number) => `0x${code.toString(16).padStart(4, '0').toUpperCase()}`;
const whyOf = (err: unknown) => (err instanceof UnsafeCommandError ? err.reason : err instanceof Error ? err.message : String(err));

/** A refusal before the first write: the restore writes nothing (WX3 W-08). */
export class RestoreRefusedError extends Error {}
const refuse = (msg: string): never => { throw new RestoreRefusedError(tr('diagnostics.vRefused', { msg })); };

/** One key of one layer, and the keycode the file has there. */
export interface RestoreKey { layer: number; id: number; code: number }
/** A key the restore writes over a factory keycode (`factory`) the keyboard holds: only after the user confirmed (U-07). */
export interface FactoryOverwrite extends RestoreKey { factory: number }

/** What a restore writes, worked out from the file and the keyboard's values before anything is written. */
export interface RestorePlan {
  /** Keymap writes, in write order (layer 0–3, then key order). */
  keys: RestoreKey[];
  /** Of `keys`: the ones over a factory key (U-07). */
  factory: FactoryOverwrite[];
  /** Factory keycodes in the file where the keyboard has another code: left as they are on the keyboard, listed (U-01). */
  unrestorable: RestoreKey[];
  /** Travel writes, in key order (the file's record; the loop merges it into the key's record read just before). */
  perf: { id: number; next: Performance }[];
  /** Keys whose travel the file has but the app leaves alone (not read, or a mode the app does not know). */
  perfSkipped: number;
  /** Device-wide settings that differ from the keyboard's. */
  settings: { systemMode?: number; rgbSleep?: number; shakeOptimization?: boolean };
}

/** A travel record from the file merged into the key's record: the sensor and switch fields stay the key's own. */
export function mergePerf(base: Performance, next: Performance): Performance {
  return {
    ...base,
    ...next,
    axis: base.axis,
    calibrate: base.calibrate,
    axisV2Id: base.axisV2Id,
    axisRangeMax: base.axisRangeMax,
    axisCoefficient: base.axisCoefficient,
  };
}

function perfChanged(cur: Performance, next: Performance): boolean {
  return cur.mode !== next.mode
    || Math.abs(cur.normalPress - next.normalPress) > 0.0005
    || Math.abs(cur.rtFirstTouch - next.rtFirstTouch) > 0.0005
    || Math.abs(cur.rtPress - next.rtPress) > 0.0005
    || Math.abs(cur.rtRelease - next.rtRelease) > 0.0005
    || Math.abs(cur.pressDeadStroke - next.pressDeadStroke) > 0.0005
    || Math.abs(cur.releaseDeadStroke - next.releaseDeadStroke) > 0.0005;
}

type PlanKey = KeyPos & { id: number; name?: string };
const keyName = (keys: readonly PlanKey[], id: number) => keys[id]?.name ?? String(id);

/**
 * Checks the file against the keyboard's values and returns what a restore would write; throws RestoreRefusedError (with
 * the reason) when anything would be refused. Every write is checked by the transport's own guards here (checkFrame on the
 * exact frame, the travel guard on the exact merged record), so a restore never stops half-way on a refusal (W-08).
 */
export function planRestore(
  payload: BackupPayload,
  deviceKeys: readonly PlanKey[],
  currentKeymap: Record<number, Record<number, number>>,
  currentPerf: Record<number, Performance>,
  currentSettings: { systemMode: number; rgbSleep: number; shakeOptimization: boolean },
  opts: { intervalRt: boolean; boardIdHex?: string; rtPrecision: number },
): RestorePlan {
  const plan: RestorePlan = { keys: [], factory: [], unrestorable: [], perf: [], perfSkipped: 0, settings: {} };

  // 1. Keymap
  if (payload.keymap) {
    for (const [lStr, layerMap] of Object.entries(payload.keymap)) {
      const layer = Number(lStr);
      if (!Number.isInteger(layer) || layer < 0 || layer >= LAYER_COUNT || !layerMap) continue;
      for (const [idStr, code] of Object.entries(layerMap)) {
        const id = Number(idStr);
        if (!deviceKeys[id]) continue;
        const where = { layer: LAYER_NAMES[layer], key: keyName(deviceKeys, id) };
        if (typeof code !== 'number' || !Number.isInteger(code) || code < 0 || code > 0xffff) {
          refuse(tr('diagnostics.vBadKeycode', { code: String(code), ...where }));
        }
        // A code the keyboard already has is left alone, whatever it is (U-01).
        const cur = currentKeymap[layer]?.[id];
        if (cur !== undefined && cur === code) continue;
        // A factory code the keyboard does not have there: this app never writes it; the key stays as it is, listed (U-01).
        if (BLOCKED_KEYCODES.has(code)) {
          plan.unrestorable.push({ layer, id, code });
          continue;
        }
        if (!ASSIGNABLE_KEYCODES.has(code) && decodeCombo(code) === null) {
          refuse(tr('diagnostics.vUnassignable', { code: hex4(code), ...where }));
        }
        if (!isWritableKeycode(code)) refuse(tr('diagnostics.vUnwritable', { code: hex4(code), ...where }));
        try {
          checkFrame(restoreFrames.keycode(deviceKeys[id], code, layer));
        } catch (err) {
          refuse(tr('diagnostics.vGuardKey', { ...where, why: whyOf(err) }));
        }
        plan.keys.push({ layer, id, code });
        if (cur !== undefined && BLOCKED_KEYCODES.has(cur)) plan.factory.push({ layer, id, code, factory: cur });
      }
    }
    // U-08, the Fn release rule on the keymap the restore would leave: a written key on a layer above an Fn switch must be
    // Transparent, and a written Fn switch needs Transparent above it. Keys the file does not write stay as they are.
    const after: Record<number, Record<number, number>> = {};
    for (let l = 0; l < LAYER_COUNT; l++) after[l] = { ...currentKeymap[l] };
    for (const k of plan.keys) after[k.layer][k.id] = k.code;
    const fnBroken = [...new Set(plan.keys.filter((k) => breaksFnRule(after, k.layer, k.id, k.code)).map((k) => k.id))];
    if (fnBroken.length) refuse(tr('diagnostics.vFnRule', { keys: fnBroken.sort((a, b) => a - b).map((id) => keyName(deviceKeys, id)).join(', ') }));
    // the write order of the loop: layer, then key
    const order = (a: RestoreKey, b: RestoreKey) => a.layer - b.layer || a.id - b.id;
    plan.keys.sort(order);
    plan.factory.sort(order);
    plan.unrestorable.sort(order);
  }

  // 2. Performance
  if (payload.performance) {
    const min = perfMinMm(opts.rtPrecision);
    const distFields = [
      'normalPress', 'normalRelease', 'rtFirstTouch', 'rtPress', 'rtRelease', 'pressDeadStroke', 'releaseDeadStroke',
    ] as const;
    for (const [idStr, perf] of Object.entries(payload.performance)) {
      const id = Number(idStr);
      if (!deviceKeys[id] || !perf) continue;
      const key = keyName(deviceKeys, id);
      if (perf.mode !== 0 && perf.mode !== 1 && perf.mode !== 2) {
        refuse(tr('diagnostics.vBadMode', { mode: String(perf.mode), key }));
      }
      const cur = currentPerf[id];
      if (perf.mode === 2 && !opts.intervalRt && cur?.mode !== 2) refuse(tr('diagnostics.vMode2', { key }));
      const max = cur ? rangeMm(cur) : 4;
      for (const field of distFields) {
        const val = perf[field];
        if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > max + 0.0005) {
          refuse(tr('diagnostics.vBadDistance', { field, value: String(val), key, max: String(max) }));
        }
      }
      const minFields = isRtMode(perf.mode)
        ? (['normalPress', 'rtFirstTouch', 'rtPress', 'rtRelease'] as const)
        : (['normalPress'] as const);
      for (const field of minFields) {
        const val = perf[field];
        if (cur && Math.abs(val - cur[field]) <= 0.0005) continue;
        if (val < min - 1e-9) {
          refuse(tr('diagnostics.vBelowMin', { field, value: String(val), key, min: String(min) }));
        }
      }
    }
    for (const k of deviceKeys) {
      const next = payload.performance[k.id];
      const cur = currentPerf[k.id];
      if (!next) continue;
      // Keys reporting a mode this app does not know are left alone (as in the Performance page).
      if (!cur || !isKnownMode(cur.mode)) {
        plan.perfSkipped++;
        continue;
      }
      if (!perfChanged(cur, next)) continue;
      // The record the loop writes (merged into the key's record), through the transport's own checks.
      const merged = mergePerf(cur, next);
      const key = keyName(deviceKeys, k.id);
      const why = checkPerformanceWrite(merged, [cur], { intervalRt: opts.intervalRt, boardIdHex: opts.boardIdHex });
      if (why) refuse(tr('diagnostics.vGuardPerf', { key, why }));
      try {
        checkFrame(restoreFrames.performance(k, merged));
      } catch (err) {
        refuse(tr('diagnostics.vGuardPerf', { key, why: whyOf(err) }));
      }
      plan.perf.push({ id: k.id, next });
    }
  }

  // 3. Global settings (device-wide)
  if (payload.globalSettings) {
    const s = payload.globalSettings;
    const bad = (name: string, value: unknown) => refuse(tr('diagnostics.vBadSetting', { name, value: String(value) }));
    if (s.systemMode !== undefined && (typeof s.systemMode !== 'number' || !Number.isInteger(s.systemMode) || s.systemMode < 0)) {
      bad('systemMode', s.systemMode);
    }
    if (s.rgbSleep !== undefined && (typeof s.rgbSleep !== 'number' || !Number.isInteger(s.rgbSleep) || s.rgbSleep < 0)) {
      bad('rgbSleep', s.rgbSleep);
    }
    if (s.shakeOptimization !== undefined) {
      const isBool = typeof s.shakeOptimization === 'boolean';
      const isInt = typeof s.shakeOptimization === 'number' && Number.isInteger(s.shakeOptimization) && s.shakeOptimization >= 0;
      if (!isBool && !isInt) bad('shakeOptimization', s.shakeOptimization);
    }
    const guard = (name: string, value: number | boolean, frame: () => number[]) => {
      try {
        checkFrame(frame());
      } catch (err) {
        refuse(tr('diagnostics.vGuardSetting', { name, value: String(value), why: whyOf(err) }));
      }
    };
    if (s.systemMode !== undefined && s.systemMode !== currentSettings.systemMode) {
      guard('systemMode', s.systemMode, () => restoreFrames.systemMode(s.systemMode));
      plan.settings.systemMode = s.systemMode;
    }
    if (s.rgbSleep !== undefined && s.rgbSleep !== currentSettings.rgbSleep) {
      guard('rgbSleep', s.rgbSleep, () => restoreFrames.rgbSleep(s.rgbSleep));
      plan.settings.rgbSleep = s.rgbSleep;
    }
    // compared as a boolean: a file holding 0 / 1 is the same setting as false / true
    if (s.shakeOptimization !== undefined && Boolean(s.shakeOptimization) !== currentSettings.shakeOptimization) {
      const on = Boolean(s.shakeOptimization);
      guard('shakeOptimization', on, () => restoreFrames.shakeOptimization(on));
      plan.settings.shakeOptimization = on;
    }
  }
  return plan;
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
  /** Keys that change (factory keycodes the file has but this app cannot write are not counted: see unrestorable). */
  keymapDiffCount: number;
  perfDiffCount: number;
  settingsDiffCount: number;
  /** U-01: factory keycodes in the file where the keyboard has another code; left as they are, listed in the dialog. */
  unrestorable: RestoreKey[];
  /** U-07: factory keys on the keyboard the restore would write over; the dialog asks first. */
  factory: FactoryOverwrite[];
  /** W-08: why a restore of this file would be refused (nothing would be written), or null. */
  refused?: string | null;
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
  // A diff computed on another keyboard (Max ↔ Pro, or the demo) must never be restored onto this one.
  watch(() => device.connection, () => { importDiff.value = null; });

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

        // A backup holds one profile: the keyboard must still be on the one it was read from (its P1–P4 keys, a switch).
        if ((await t.getActiveProfile()) !== activeProfile) throw new Error(tr('diagnostics.backupProfileChanged'));

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
      }, { exclusive: true, what: tr('diagnostics.whatBackup') });
    } finally {
      isExporting.value = false;
    }
  }

  /** The plan against the stores' values (loaded just before). */
  function planNow(payload: BackupPayload): RestorePlan {
    return planRestore(
      payload, device.keys, keymapStore.values, perfStore.values,
      { systemMode: settingsStore.systemMode, rgbSleep: settingsStore.rgbSleep, shakeOptimization: settingsStore.shakeOptimization },
      { intervalRt: supportsIntervalRt(device.version), boardIdHex: device.info?.boardIdHex, rtPrecision: device.rtPrecision },
    );
  }

  /**
   * Validate JSON text and calculate diff against current device state. A file the restore would refuse comes back with
   * `refused` (the reason) and no counts: the page says so instead of opening the dialog; applyRestore refuses it too.
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

    let plan: RestorePlan | null = null;
    let refused: string | null = null;
    try {
      plan = planNow(payload);
    } catch (err) {
      if (!(err instanceof RestoreRefusedError)) throw err;
      refused = err.message;
    }
    const diff: ImportDiff = {
      payload,
      keymapDiffCount: plan?.keys.length ?? 0,
      perfDiffCount: plan?.perf.length ?? 0,
      settingsDiffCount: plan ? Object.keys(plan.settings).length : 0,
      unrestorable: plan?.unrestorable ?? [],
      factory: plan?.factory ?? [],
      refused,
    };
    importDiff.value = diff;
    return diff;
  }

  /**
   * Apply restore: writes keymap, performance and global settings through standard transport calls.
   * Only changed records are written to minimize bus traffic and wear. Every write is checked before the first one (W-08);
   * a section that fails half-way (a lost reply or keyboard) gets the records it wrote put back, and no commit.
   * `factoryOk`: the user confirmed overwriting the factory keys listed in `diff.factory` (U-07).
   */
  async function applyRestore(diff: ImportDiff, opts: { factoryOk?: boolean } = {}): Promise<{ skipped: number }> {
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

      let plan: RestorePlan;
      try {
        // Always re-read: the stores only follow a profile switch while their own page is open.
        await keymapStore.load(true);
        await perfStore.load(true);
        await settingsStore.load();
        if (
          keymapStore.loadError || perfStore.loadError || settingsStore.loadError || !settingsStore.loaded
          || keymapStore.loadedProfile !== device.activeProfile || perfStore.loadedProfile !== device.activeProfile
        ) {
          throw new Error(tr('diagnostics.importUnreadable'));
        }
        plan = planNow(payload);
        // Factory keys are written over only when the user confirmed exactly these (the keyboard may have changed since).
        const shown = new Set((diff.factory ?? []).map((f) => `${f.layer}:${f.id}`));
        if (plan.factory.length && (!opts.factoryOk || plan.factory.some((f) => !shown.has(`${f.layer}:${f.id}`)))) {
          throw new RestoreRefusedError(tr('diagnostics.restoreFactoryUnconfirmed'));
        }
      } catch (err) {
        release();
        throw err;
      }

      type Section = 'keymap' | 'performance' | 'settings';
      const done: Section[] = [];
      let restoreError: Error | null = null;
      /** The keyboard's own active profile when it is not the one the baseline was read from (nothing is written then). */
      let moved = null as number | null;
      const baseline = keymapStore.values;
      const old = { systemMode: settingsStore.systemMode, rgbSleep: settingsStore.rgbSleep, shakeOptimization: settingsStore.shakeOptimization };

      try {
        await device.withTransport(async (t) => {
          // The wire format has no profile byte: refuse before the first write when the keyboard switched by itself.
          const real = await t.getActiveProfile();
          if (real !== device.activeProfile) {
            moved = real;
            throw new Error(tr('diagnostics.restoreProfileChanged', { n: real + 1 }));
          }
          /** The section running, and how to put back each record it wrote or tried to write (the failing one too). */
          let section: Section | null = null;
          let putBack: (() => Promise<void>)[] = [];
          /** Factory keys this section wrote over: never written back (the guard refuses their codes). */
          let factoryHit: FactoryOverwrite[] = [];
          /** The section's commit (save group) once it was sent: a failure there may come after the keyboard saved. */
          let committing: number | null = null;
          const begin = (s: Section) => { section = s; putBack = []; factoryHit = []; committing = null; };
          try {
            // 1. Keymap (only changed keys)
            if (plan.keys.length) {
              begin('keymap');
              for (const k of plan.keys) {
                const key = device.keys[k.id];
                const was = baseline[k.layer]?.[k.id];
                const f = plan.factory.find((x) => x.layer === k.layer && x.id === k.id);
                if (f) factoryHit.push(f);
                else if (was !== undefined) putBack.push(() => t.setKeycode(key, was, k.layer));
                await t.setKeycode(key, k.code, k.layer);
              }
              committing = SAVE_GROUP.LAYOUT;
              await t.commit(SAVE_GROUP.LAYOUT);
              done.push('keymap');
            }

            // 2. Performance (only changed keys, the key's sensor fields as read just before)
            if (plan.perf.length) {
              begin('performance');
              for (const p of plan.perf) {
                const key = device.keys[p.id];
                const fresh = await t.getPerformance(key);
                putBack.push(() => t.setPerformance(key, fresh));
                await t.setPerformance(key, mergePerf(fresh, p.next));
              }
              committing = SAVE_GROUP.PERFORMANCE;
              await t.commit(SAVE_GROUP.PERFORMANCE);
              done.push('performance');
            }

            // 3. Global settings (device-wide; they need no commit)
            const st = plan.settings;
            if (st.systemMode !== undefined || st.rgbSleep !== undefined || st.shakeOptimization !== undefined) {
              begin('settings');
              if (st.systemMode !== undefined) {
                putBack.push(() => t.setSystemMode(old.systemMode));
                await t.setSystemMode(st.systemMode);
              }
              if (st.rgbSleep !== undefined) {
                putBack.push(() => t.setRgbSleep(old.rgbSleep));
                await t.setRgbSleep(st.rgbSleep);
              }
              if (st.shakeOptimization !== undefined) {
                putBack.push(() => t.setShakeOptimization(old.shakeOptimization));
                await t.setShakeOptimization(st.shakeOptimization);
              }
              // Polling rate is not restored here: changing it restarts the keyboard's USB interface, so it
              // must be the last command of a session (Settings page).
              done.push('settings');
            }
          } catch (err) {
            if (section === null) throw err;
            // WX3: the records this section wrote get their old values back (last first), and its commit is never sent.
            let back = true;
            for (const undo of putBack.reverse()) {
              if (!t.connected) { back = false; break; }
              try { await undo(); } catch { back = false; }
            }
            const name = (s: Section) => tr(s === 'keymap' ? 'diagnostics.secKeymap' : s === 'performance' ? 'diagnostics.secPerformance' : 'diagnostics.secSettings');
            const msg = err instanceof Error ? err.message : String(err);
            const parts: string[] = [];
            if (done.length) parts.push(tr('diagnostics.restoreDoneList', { list: done.map(name).join(', ') }));
            // N-WX3-1: the step that failed was the commit, which may have reached the keyboard (its reply lost): with the
            // records put back, that commit is sent once more, so flash holds the values from before the restore too.
            let saved = true;
            if (back && committing !== null) {
              try { await t.commit(committing as SaveGroup); } catch { saved = false; }
            }
            const said = !back ? 'diagnostics.restoreFailedUnsaved' : saved ? 'diagnostics.restoreFailedBack' : 'diagnostics.restoreFailedMayReturn';
            parts.push(tr(said, { section: name(section), msg }));
            if (factoryHit.length) {
              const keys = factoryHit.map((f) => `${LAYER_NAMES[f.layer]} · ${device.keys[f.id]?.name ?? f.id}`).join(', ');
              parts.push(tr('diagnostics.restoreFactoryLost', { n: factoryHit.length, keys }));
            }
            throw new Error(parts.join(' '));
          }
        }, { exclusive: true, what: tr('diagnostics.whatRestore') });
      } catch (err) {
        restoreError = err instanceof Error ? err : new Error(String(err));
        // Follow the keyboard (one toast; the reloads below then read the profile it is on).
        if (moved !== null) await device.profileChangedOnKeyboard(moved);
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
      return { skipped: plan.perfSkipped };
    } finally {
      isRestoring.value = false;
    }
  }

  return {
    isExporting, isRestoring, importDiff,
    generateBackup, parseAndDiffBackup, applyRestore,
  };
});
