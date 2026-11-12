// Gamepad configuration of the experimental AE64 Pro XInput firmware (one global 208-byte AGC1 block; protocol/gamepad.ts).
// Same pattern as the per-key pages (performance.ts): load → edit a draft through history + sync → verify by reading back.
//
// - load(): INFO, then READ the block in 48-byte chunks (CRC checked against INFO). An AE64 Max is never asked (support 'max');
//   stock Pro firmware answers INFO with `10 FF` (support 'stock'). Nothing but INFO is ever sent unless INFO confirmed the firmware.
// - apply(): changes the draft at once, records one undo step and queues the sync job `gamepad:blob` (edits coalesce: the job
//   writes the newest draft).
// - The job: INFO (same revision as read, else the block is re-read and the edit dropped), the keyboard's active profile is still
//   the one this app shows, every assigned key's travel (04 01 axisRangeMax) fits its record, then BEGIN (read revision, CRC, 208,
//   random nonzero token) → WRITE 40-byte chunks → COMMIT. A failure after BEGIN sends ABORT. A COMMIT whose reply is lost is
//   "unconfirmed" until a read shows which block the keyboard has.
// - verify: INFO + READ of the whole block, compared byte for byte with what was written.
// - setXboxDevice(): the Xbox USB switch (USB_STATUS / USB_SET), then reconnect the same keyboard (by serial) and require
//   phase 0 with the requested state.
// - Page helpers (K5): every key's switch travel comes from the performance store (04 01 axisRangeMax, read at load);
//   travelIssues lists assigned records the keyboard would refuse (unknown travel, Full deeper than the switch) and every
//   edit that would leave one is refused, except fitToTravel() which removes them. assign() fits an analog record to its
//   key's switch. A block changed elsewhere while editing is kept as `conflict` (keepKeyboard / writeMine).
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import {
  GP_CONFIG_BYTES, GP_CONTROLS, GP_DEADZONE_MAX, GP_READ_CHUNK, GP_STATUS, GP_TRAVEL_MAX_UM, GP_TRAVEL_MIN_UM, GP_WRITE_CHUNK, GamepadNewerError,
  GamepadStatusError, checkTravelLimits, cloneConfig, controlIndex, crc32, decodeConfig, encodeConfig, isAnalogIndex, keyIndexOf, keyPosOf,
  requiredTransportBit, usbSetAccepted, validateConfig,
} from '../protocol/gamepad';
import type { GamepadConfig, GamepadInfo, GamepadUsbState, GpBinding, GpCurve, GpIssue, GpMode, GpStick, GpTransport, GpTravelIssue } from '../protocol/gamepad';
import { USB_SWITCH_MS } from '../protocol/mockGamepad';
import type { Ae64Transport } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { usePerformanceStore } from './performance';
import { PermanentSyncError, useSyncStore } from './sync';
import type { SyncJob } from './sync';

/**
 * 'max': AE64 Max (no gamepad firmware exists); 'stock': a Pro without the gamepad firmware; 'newer': gamepad firmware
 * with a newer AGP1 version than this app (nothing is read or written); 'ready': loaded.
 */
export type GamepadSupport = 'unknown' | 'loading' | 'max' | 'stock' | 'newer' | 'ready' | 'error';

/** The keyboard's block replaced the draft while editing: revision `from` → `to`; `draft` is the edit that was not written. */
export interface GamepadConflict { from: number; to: number; draft: GamepadConfig }

/** Result of assign(): what happened, for the page's toast. */
export type GamepadAssignResult =
  | { ok: true; kind: 'assigned' }
  | { ok: true; kind: 'moved'; fromKey: number }
  | { ok: true; kind: 'replaced'; oldIndex: number }
  | { ok: false; reason: 'noTravel' | 'refused' };

/** Smallest gap between Start and Full (µm): the firmware needs start < end. */
export const GP_MIN_GAP_UM = 10;

const validTravel = (um: number | undefined): um is number =>
  um !== undefined && Number.isInteger(um) && um >= GP_TRAVEL_MIN_UM && um <= GP_TRAVEL_MAX_UM;

/** An analog record fitted to a switch of `travelUm`: declared = travel, Full ≤ travel, Start ≤ Full − 10 µm. */
export function fitBinding(b: GpBinding, travelUm: number): void {
  b.declaredUm = travelUm;
  b.endUm = Math.min(b.endUm, travelUm);
  b.startUm = Math.max(0, Math.min(b.startUm, b.endUm - GP_MIN_GAP_UM));
}

export const GAMEPAD_JOB_KEY = 'gamepad:blob';
/** After USB_SET: reconnect attempts for this long (the keyboard re-enumerates). */
export const USB_RECONNECT_TIMEOUT_MS = 15_000;
const USB_RECONNECT_STEP_MS = 250;
const USB_FIRST_WAIT_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>): boolean => a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
const sameConfig = (a: GamepadConfig, b: GamepadConfig): boolean => {
  try {
    return sameBytes(encodeConfig(a), encodeConfig(b));
  } catch {
    return JSON.stringify(a) === JSON.stringify(b);
  }
};

/** A random nonzero 8-byte transaction token. */
export function newToken(): number[] {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new PermanentSyncError('Secure random numbers are unavailable');
  const b = new Uint8Array(8);
  do c.getRandomValues(b); while (b.every((x) => x === 0));
  return Array.from(b);
}

/** The whole block, READ in 48-byte chunks at `info.revision`; its CRC must equal INFO's. */
export async function readBlock(t: Ae64Transport, info: GamepadInfo): Promise<number[]> {
  const bytes: number[] = [];
  for (let o = 0; o < GP_CONFIG_BYTES; o += GP_READ_CHUNK) bytes.push(...(await t.gamepadRead(info.revision, o, Math.min(GP_READ_CHUNK, GP_CONFIG_BYTES - o))));
  if (crc32(bytes) !== info.crc) throw new Error(tr('gp.readCrc'));
  return bytes;
}

/** A block read from the keyboard; one the firmware should never hold is a permanent error. */
function decodeRead(bytes: number[]): GamepadConfig {
  try {
    return decodeConfig(bytes);
  } catch {
    throw new PermanentSyncError(tr('gp.damaged'));
  }
}

/** Statuses retrying cannot fix: the keyboard refuses this block or command as such. */
const PERMANENT_STATUS: readonly number[] = [GP_STATUS.UNSUPPORTED, GP_STATUS.FORMAT, GP_STATUS.CONFIG, GP_STATUS.BACKEND];

export const useGamepadStore = defineStore('gamepad', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();
  const perf = usePerformanceStore();

  const support = ref<GamepadSupport>('unknown');
  const info = shallowRef<GamepadInfo | null>(null);
  /** The draft shown and edited (written by the sync job). */
  const config = shallowRef<GamepadConfig | null>(null);
  /** The block last read from (or verified on) the keyboard, and its revision. */
  const saved = shallowRef<GamepadConfig | null>(null);
  const revision = ref<number | null>(null);
  const loadError = ref<string | null>(null);
  /** A COMMIT was sent but its reply was lost: the keyboard may or may not have the new block until it is read again. */
  const unconfirmed = ref(false);
  /** One-off message for the page (another tool changed the block, …). */
  const notice = ref<string | null>(null);
  /** Why the last apply() was refused (the draft is unchanged). */
  const lastIssues = shallowRef<GpIssue[]>([]);
  const usb = shallowRef<GamepadUsbState | null>(null);
  const usbBusy = ref(false);
  const usbError = ref<string | null>(null);
  /** AGP1 version reported by firmware newer than this app (support 'newer'). */
  const protocolVersion = ref<number | null>(null);
  /** How that firmware describes itself ("AGP1 v2", "AGP1 v1 · caps 0x60"). */
  const newerProto = ref<string | null>(null);
  const conflict = shallowRef<GamepadConflict | null>(null);
  /** Why the last edit was refused by the travel check (the draft is unchanged). */
  const lastTravelIssues = shallowRef<GpTravelIssue[]>([]);

  const dirty = computed(() => !!config.value && !!saved.value && !sameConfig(config.value, saved.value));

  // Another keyboard (or the demo) was connected: nothing cached belongs to it.
  watch(() => device.connection, () => {
    support.value = 'unknown';
    info.value = null;
    config.value = null;
    saved.value = null;
    revision.value = null;
    loadError.value = null;
    unconfirmed.value = false;
    notice.value = null;
    usb.value = null;
    protocolVersion.value = null;
    newerProto.value = null;
    conflict.value = null;
    lastTravelIssues.value = [];
    stickMemory.clear();
    loadPromise = null;
  }, { flush: 'sync' });

  /** Dead zones of sticks switched to the square gate, restored when they go back to round (this page session only). */
  const stickMemory = new Map<number, number>();

  // The firmware keeps one block per onboard profile (and bumps the revision when it loads one): after a profile change
  // (in the app or on the keyboard) the block shown belongs to the old profile, so it is read again. A queued write of
  // the old profile is dropped by sync (job.profile); device.switchProfile also flushes and clears the history first.
  watch(() => device.activeProfile, (now, old) => {
    if (now === old) return;
    conflict.value = null;
    notice.value = null;
    lastTravelIssues.value = [];
    stickMemory.clear();
    if (support.value === 'ready' || support.value === 'loading' || support.value === 'error') void load(true);
  });

  /** INFO; a newer protocol becomes support 'newer' and a permanent error (nothing is written to it). */
  async function infoOf(t: Ae64Transport): Promise<GamepadInfo | null> {
    try {
      return await t.gamepadInfo();
    } catch (err) {
      if (err instanceof GamepadNewerError) {
        support.value = 'newer';
        protocolVersion.value = err.version;
        newerProto.value = err.proto;
        throw new PermanentSyncError(err.message);
      }
      throw err;
    }
  }

  /** Gamepad operations of this store run one at a time (an INFO in the middle of an upload would end its staging). */
  let chain: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  /** The keyboard's block became the truth (read or verified): draft follows it. */
  function adopt(cfg: GamepadConfig, rev: number, gpInfo: GamepadInfo): void {
    saved.value = cfg;
    revision.value = rev;
    info.value = { ...gpInfo, revision: rev };
    config.value = cloneConfig(cfg);
    support.value = 'ready';
  }

  let loadPromise: Promise<void> | null = null;

  /** INFO + READ of the block. Cached until `force`. Never sends anything to an AE64 Max. */
  function load(force = false): Promise<void> {
    if (loadPromise) return force ? loadPromise.then(() => load(true)) : loadPromise;
    if (!force && support.value !== 'unknown' && support.value !== 'error') return Promise.resolve();
    if (!device.connected) return Promise.resolve();
    if (device.model !== 'pro') {
      support.value = 'max';
      return Promise.resolve();
    }
    const gen = device.connection;
    const mine: Promise<void> = serial(async () => {
      support.value = 'loading';
      loadError.value = null;
      try {
        await device.withTransport(async (t) => {
          let gpInfo: GamepadInfo | null;
          try {
            gpInfo = await t.gamepadInfo();
          } catch (err) {
            if (!(err instanceof GamepadNewerError)) throw err;
            if (gen !== device.connection) return;
            support.value = 'newer';
            protocolVersion.value = err.version;
            newerProto.value = err.proto;
            return;
          }
          if (gen !== device.connection) return;
          if (!gpInfo) {
            support.value = 'stock';
            return;
          }
          const bytes = await readBlock(t, gpInfo);
          if (gen !== device.connection) return;
          let cfg: GamepadConfig;
          try {
            cfg = decodeConfig(bytes);
          } catch {
            throw new Error(tr('gp.damaged'));
          }
          adopt(cfg, gpInfo.revision, gpInfo);
          unconfirmed.value = false;
          conflict.value = null;
          if (gpInfo.usbSwitch) usb.value = await t.gamepadUsbStatus().catch(() => null);
        }, { exclusive: true });
      } catch (err) {
        if (gen !== device.connection) return;
        support.value = 'error';
        loadError.value = err instanceof Error ? err.message : String(err);
        return;
      }
      // Every key's switch travel (04 01 axisRangeMax), for the travel check and the curve. Never fatal here: the
      // write job reads the travel of every assigned key again before writing.
      if ((support.value as GamepadSupport) === 'ready' && gen === device.connection) await perf.load().catch(() => undefined);
    }).finally(() => {
      if (loadPromise === mine) loadPromise = null;
    });
    loadPromise = mine;
    return mine;
  }

  function travelMessage(issue: GpTravelIssue): string {
    const pos = keyPosOf(issue.key);
    const k = pos && device.keys.find((d) => d.row === pos.row && d.col === pos.col);
    const key = k ? device.legend(k) : `#${issue.key}`;
    if (issue.code === 'noTravel') return tr('gp.noTravel', { key });
    const end = config.value?.bindings[issue.index].endUm ?? 0;
    return tr('gp.overTravel', { key, control: GP_CONTROLS[issue.index].id, end: (end / 1000).toFixed(2), limit: (issue.limitUm / 1000).toFixed(2) });
  }

  function job(): SyncJob {
    let written: Uint8Array | null = null;
    let base: number | null = null; // revision the block was written over
    let lostCommit = false;
    return {
      key: GAMEPAD_JOB_KEY,
      label: tr('gp.jobLabel'),
      // The block belongs to this profile: sync drops the job if another profile is active by the time it runs.
      profile: device.activeProfile,
      write: (t) => serial(async () => {
        const draft = config.value;
        if (!draft || support.value !== 'ready') return 'skip';
        let block: Uint8Array;
        try {
          block = encodeConfig(draft);
        } catch (err) {
          throw new PermanentSyncError(err instanceof Error ? err.message : tr('gp.invalid'));
        }
        const gpInfo = await infoOf(t);
        if (!gpInfo) throw new PermanentSyncError(tr('gp.noFirmware'));
        if (gpInfo.revision !== revision.value) {
          // Another writer (or our own unconfirmed COMMIT) changed the block: the keyboard's block is the truth now.
          const from = revision.value ?? gpInfo.revision;
          const mine = cloneConfig(draft);
          const now = decodeRead(await readBlock(t, gpInfo));
          adopt(now, gpInfo.revision, gpInfo);
          unconfirmed.value = false;
          if (sameBytes(encodeConfig(now), block)) return 'skip'; // it already holds this draft
          conflict.value = { from, to: gpInfo.revision, draft: mine };
          notice.value = tr('gp.revisionChanged');
          throw new PermanentSyncError(tr('gp.revisionChanged'));
        }
        const bit = requiredTransportBit(draft);
        if (bit !== null && !(gpInfo.caps & bit)) {
          throw new PermanentSyncError(tr('gp.noTransport', { transport: draft.transport === 'hid' ? 'HID' : 'XInput' }));
        }
        if ((await t.getActiveProfile()) !== device.activeProfile) throw new PermanentSyncError(tr('gp.profileChanged'));
        const limits = new Map<number, number>();
        for (const b of draft.bindings) {
          if (b.key === null || limits.has(b.key)) continue;
          const pos = keyPosOf(b.key); // the record's key index is the firmware's logical key, read by its (row, col)
          if (pos) limits.set(b.key, (await t.getPerformance(pos)).axisRangeMax);
        }
        const issues = checkTravelLimits(draft, (k) => limits.get(k));
        if (issues.length) throw new PermanentSyncError(issues.map(travelMessage).join(' '));

        const token = newToken();
        const crc = crc32(block);
        base = gpInfo.revision;
        written = block;
        lostCommit = false;
        await t.gamepadBegin(gpInfo.revision, crc, token);
        try {
          for (let o = 0; o < GP_CONFIG_BYTES; o += GP_WRITE_CHUNK) await t.gamepadWrite(token, o, Array.from(block.slice(o, o + GP_WRITE_CHUNK)));
        } catch (err) {
          await t.gamepadAbort(token).catch(() => undefined); // abandoned uploads also expire on the keyboard
          throw err;
        }
        let result: { revision: number; persistent: boolean } | null;
        try {
          result = await t.gamepadCommit(token, crc, gpInfo.revision);
        } catch (err) {
          if (err instanceof GamepadStatusError) {
            // Refused: the keyboard kept its block.
            await t.gamepadAbort(token).catch(() => undefined);
            throw PERMANENT_STATUS.includes(err.status) ? new PermanentSyncError(err.message) : err;
          }
          // No reply: the COMMIT may have been applied. verify() reads which block the keyboard has.
          lostCommit = true;
          unconfirmed.value = true;
          return;
        }
        if (!result) {
          lostCommit = true;
          unconfirmed.value = true;
        }
      }),
      verify: (t) => serial(async () => {
        if (!written || base === null) return false;
        const gpInfo = await infoOf(t);
        if (!gpInfo) throw new PermanentSyncError(tr('gp.noFirmware'));
        const bytes = await readBlock(t, gpInfo);
        if (gpInfo.revision === ((base + 1) >>> 0) && sameBytes(bytes, written)) {
          const now = decodeRead(bytes);
          saved.value = now;
          revision.value = gpInfo.revision;
          info.value = gpInfo;
          unconfirmed.value = false;
          return true;
        }
        if (gpInfo.revision === base) {
          // The COMMIT did not land (its reply was lost, or the keyboard kept the old block): a retry writes again.
          if (lostCommit) unconfirmed.value = false;
          return false;
        }
        // Another block was committed (by another tool, or the keyboard changed ours): show what the keyboard has.
        const mine = (() => {
          try {
            return decodeConfig(written);
          } catch {
            return null;
          }
        })();
        adopt(decodeRead(bytes), gpInfo.revision, gpInfo);
        if (mine) conflict.value = { from: base, to: gpInfo.revision, draft: mine };
        unconfirmed.value = false;
        notice.value = tr('gp.revisionChanged');
        throw new PermanentSyncError(tr('gp.revisionChanged'));
      }),
      // Not saved: show the block the keyboard really has (unless a lost COMMIT leaves it unknown: keep the draft, the page offers a re-read).
      onDrop: () => {
        if (unconfirmed.value || !saved.value) return;
        config.value = cloneConfig(saved.value);
      },
    };
  }

  function commit(cfg: GamepadConfig): void {
    if (support.value !== 'ready') return;
    config.value = cloneConfig(cfg);
    sync.enqueue(job());
  }

  /**
   * Edit the draft: `mutate` changes a copy. Pushes one history entry (coalesced by `coalesce` for continuous gestures) and
   * queues the write. Returns false when nothing changed or the result would be refused by the keyboard (see lastIssues).
   */
  function apply(mutate: (draft: GamepadConfig) => void, what: string, coalesce?: string): boolean {
    if (support.value !== 'ready' || !config.value) return false;
    const before = cloneConfig(config.value);
    const after = cloneConfig(before);
    mutate(after);
    const issues = validateConfig(after);
    lastIssues.value = issues;
    // The keyboard refuses a block with an assigned key of unknown travel or a Full deeper than the switch: such an
    // edit is refused here (fitToTravel is how a block in that state is repaired).
    const travel = travelKnown.value ? checkTravelLimits(after, travelUm) : [];
    lastTravelIssues.value = travel;
    if (issues.length || travel.length || sameConfig(before, after)) return false;
    commit(after);
    history.push({
      label: tr('gp.editLabel', { what }),
      undo: () => commit(before),
      redo: () => commit(after),
      coalesce: coalesce ? `gamepad:${coalesce}` : undefined,
    });
    return true;
  }

  // ---------------------------------------------------------------- page helpers (K5)

  /** Switch travel (µm, 04 01 axisRangeMax) of a record key index; undefined until the performance store has it. */
  function travelUm(key: number): number | undefined {
    const pos = keyPosOf(key);
    if (!pos || perf.loadedProfile !== device.activeProfile) return undefined;
    const k = device.keys.find((d) => d.row === pos.row && d.col === pos.col);
    return k ? perf.values[k.id]?.axisRangeMax : undefined;
  }

  /** The travel of every key was read for the profile this page shows. */
  const travelKnown = computed(() => perf.loadedProfile === device.activeProfile && Object.keys(perf.values).length > 0);

  /** Assigned records the keyboard would refuse (unknown travel, or Full deeper than the switch): editing is locked. */
  const travelIssues = computed<GpTravelIssue[]>(() => {
    if (support.value !== 'ready' || !config.value || !travelKnown.value) return [];
    return checkTravelLimits(config.value, travelUm);
  });
  const locked = computed(() => travelIssues.value.length > 0);

  /** Fits every record of travelIssues to its key's switch (a key of unknown travel loses its output). One undo step. */
  function fitToTravel(): number {
    const issues = travelIssues.value;
    if (!issues.length) return 0;
    const ok = apply((d) => {
      for (const i of issues) {
        const b = d.bindings[i.index];
        if (i.code === 'noTravel') b.key = null;
        else fitBinding(b, i.limitUm);
      }
    }, tr('gp.fitAll'));
    return ok ? issues.length : 0;
  }

  /**
   * Give output `index` to `key` (record key index). The output leaves the key that had it and the key's previous output
   * loses its key; an analog record is fitted to the key's switch (fitBinding). One undo step.
   */
  function assign(index: number, key: number): GamepadAssignResult {
    const cfg = config.value;
    if (!cfg || index < 0 || index >= cfg.bindings.length || !keyPosOf(key)) return { ok: false, reason: 'refused' };
    const travel = travelUm(key);
    if (!validTravel(travel)) return { ok: false, reason: 'noTravel' };
    const fromKey = cfg.bindings[index].key;
    if (fromKey === key) return { ok: true, kind: 'assigned' };
    const oldIndex = cfg.bindings.findIndex((b, i) => i !== index && b.key === key);
    const ok = apply((d) => {
      if (oldIndex >= 0) d.bindings[oldIndex].key = null;
      const b = d.bindings[index];
      b.key = key;
      if (isAnalogIndex(index)) fitBinding(b, travel);
    }, GP_CONTROLS[index].id);
    if (!ok) return { ok: false, reason: 'refused' };
    if (fromKey !== null) return { ok: true, kind: 'moved', fromKey };
    if (oldIndex >= 0) return { ok: true, kind: 'replaced', oldIndex };
    return { ok: true, kind: 'assigned' };
  }

  /** W → LY+, A → LX−, S → LY−, D → LX+, fitted to each switch. One undo step; false when a key has no usable travel. */
  function assignWasd(): boolean {
    const plan: [string, number][] = [['W', controlIndex('LY+')], ['A', controlIndex('LX-')], ['S', controlIndex('LY-')], ['D', controlIndex('LX+')]];
    const keys = plan.map(([name, index]) => {
      const k = device.keys.find((d) => d.name === name);
      return { index, key: k ? keyIndexOf(k.row, k.col) : null };
    });
    if (keys.some((p) => p.key === null || !validTravel(travelUm(p.key)))) return false;
    return apply((d) => {
      for (const { index, key } of keys) {
        d.bindings.forEach((b, i) => { if (i !== index && b.key === key) b.key = null; });
        const b = d.bindings[index];
        b.key = key;
        fitBinding(b, travelUm(key!)!);
      }
    }, tr('gp.wasd'));
  }

  /** Unassign every output of these keys (all outputs when `keys` is null). One undo step; the number unassigned. */
  function unassign(keys: readonly number[] | null): number {
    const cfg = config.value;
    if (!cfg) return 0;
    const hit = cfg.bindings.filter((b) => b.key !== null && (keys === null || keys.includes(b.key))).length;
    if (!hit) return 0;
    const ok = apply((d) => {
      for (const b of d.bindings) if (b.key !== null && (keys === null || keys.includes(b.key))) b.key = null;
    }, keys === null ? tr('gp.clearAll') : tr('gp.unassign'));
    return ok ? hit : 0;
  }

  /**
   * Set the curve, Start and/or Full of analog outputs (absolute values, each clamped to its key's switch: 0 ≤ Start,
   * Start + 10 µm ≤ Full ≤ travel; a handle stops at the limit and never pushes the other). `coalesce` merges a drag.
   */
  function setCurve(indices: readonly number[], patch: { curve?: GpCurve; startUm?: number; endUm?: number }, coalesce?: string): boolean {
    const targets = indices.filter(isAnalogIndex);
    if (!targets.length) return false;
    return apply((d) => {
      for (const i of targets) {
        const b = d.bindings[i];
        const limit = b.key !== null && validTravel(travelUm(b.key)) ? travelUm(b.key)! : b.declaredUm;
        if (b.key !== null && limit !== b.declaredUm) fitBinding(b, limit);
        if (patch.curve) b.curve = patch.curve;
        if (patch.startUm !== undefined) b.startUm = Math.max(0, Math.min(Math.round(patch.startUm), b.endUm - GP_MIN_GAP_UM));
        if (patch.endUm !== undefined) b.endUm = Math.min(limit, Math.max(Math.round(patch.endUm), b.startUm + GP_MIN_GAP_UM));
      }
    }, tr('gp.curve'), coalesce);
  }

  /** Change a stick. The square gate needs dead zone 0: the round one's is remembered and restored when it is round again. */
  function setStick(stick: 0 | 1, patch: Partial<GpStick>, coalesce?: string): boolean {
    const cur = config.value?.sticks[stick];
    if (!cur) return false;
    const next: GpStick = { ...cur, ...patch };
    if (patch.circular === false && cur.circular) {
      stickMemory.set(stick, cur.deadzone);
      next.deadzone = 0;
    } else if (patch.circular === true && !cur.circular && patch.deadzone === undefined) {
      next.deadzone = stickMemory.get(stick) ?? 0;
    }
    if (!next.circular) next.deadzone = 0;
    next.deadzone = Math.max(0, Math.min(GP_DEADZONE_MAX, Math.round(next.deadzone)));
    return apply((d) => { d.sticks[stick] = next; }, tr('gp.stick'), coalesce);
  }

  function setMode(mode: GpMode): boolean {
    return apply((d) => { d.mode = mode; }, tr('gp.mode'));
  }

  function setTransport(transport: GpTransport): boolean {
    if (info.value && !info.value.transports[transport]) return false;
    return apply((d) => { d.transport = transport; }, tr('gp.transport'));
  }

  /** Close the conflict banner: the keyboard's block (already shown) stays. */
  function keepKeyboard(): void {
    conflict.value = null;
    notice.value = null;
  }

  /** Apply the edit the conflict dropped over the keyboard's block (one undo step, written like any edit). */
  function writeMine(): boolean {
    const c = conflict.value;
    if (!c) return false;
    const ok = apply((d) => {
      const mine = cloneConfig(c.draft);
      d.mode = mine.mode;
      d.transport = mine.transport;
      d.sticks = mine.sticks;
      d.bindings = mine.bindings;
    }, tr('gp.writeMine'));
    if (ok) keepKeyboard();
    return ok;
  }

  /** After an unconfirmed COMMIT: run the pending write again (it reads INFO first), then read the block if still unknown. */
  async function readBack(): Promise<void> {
    await sync.retry();
    if (unconfirmed.value) await load(true);
  }

  // ---------------------------------------------------------------- Xbox USB device switch (K4b)

  async function readUsb(): Promise<GamepadUsbState | null> {
    if (support.value !== 'ready' || !info.value?.usbSwitch) return null;
    return serial(() => device.withTransport(async (t) => {
      const gpInfo = await t.gamepadInfo();
      if (!gpInfo?.usbSwitch) throw new Error(tr('gp.usbUnsupported'));
      usb.value = await t.gamepadUsbStatus();
      return usb.value;
    }, { exclusive: true }));
  }

  const unknownSerial = (s: string | undefined): boolean => !s || /^0*$/.test(s) || s === '255'.repeat(12);

  /**
   * Show (true) or hide the Xbox controller device. The keyboard re-enumerates on USB; success only when the same keyboard
   * (serial) is back with the switch idle (phase 0) and both the current and the target state equal `enabled`.
   */
  async function setXboxDevice(enabled: boolean): Promise<boolean> {
    if (usbBusy.value) throw new Error(tr('gp.busy'));
    if (support.value !== 'ready' || !info.value?.usbSwitch) throw new Error(tr('gp.usbUnsupported'));
    usbBusy.value = true;
    usbError.value = null;
    try {
      await sync.flush(); // nothing of this keyboard may be pending when it re-enumerates
      const isDemo = device.demo;
      const original = device.info;
      if (!isDemo && unknownSerial(original?.serial)) throw new Error(tr('gp.usbNoSerial'));
      const current = await serial(() => device.withTransport(async (t) => {
        if (!(await t.gamepadInfo())?.usbSwitch) throw new Error(tr('gp.usbUnsupported'));
        return t.gamepadUsbStatus();
      }, { exclusive: true }));
      if (current.phase !== 0) throw new Error(tr('gp.usbPending'));
      if (current.enabled === enabled) {
        usb.value = current;
        return true;
      }
      const queued = await serial(() => device.withTransport((t) => t.gamepadUsbSet(enabled, current.revision), { exclusive: true }));
      if (!usbSetAccepted(queued, enabled, current.revision)) throw new Error(tr('gp.usbNotAccepted'));
      usb.value = queued;
      let state: GamepadUsbState | null = null;
      if (isDemo) {
        // The demo keyboard switches without re-enumerating: wait for it to settle.
        const until = Date.now() + USB_SWITCH_MS * 10;
        await sleep(USB_SWITCH_MS);
        while (Date.now() <= until) {
          state = await serial(() => device.withTransport((t) => t.gamepadUsbStatus(), { exclusive: true }));
          if (state.phase === 0) break;
          await sleep(USB_SWITCH_MS / 3);
        }
      } else {
        await device.disconnect({ flush: false });
        const until = Date.now() + USB_RECONNECT_TIMEOUT_MS;
        await sleep(USB_FIRST_WAIT_MS);
        while (Date.now() < until) {
          if (await device.tryAutoReconnect()) break;
          await sleep(USB_RECONNECT_STEP_MS);
        }
        if (!device.connected) throw new Error(tr('gp.usbReconnectFailed'));
        if (device.info?.serial !== original?.serial || device.info?.boardIdHex !== original?.boardIdHex) throw new Error(tr('gp.usbOtherKeyboard'));
        await load(true);
        state = await serial(() => device.withTransport(async (t) => {
          if (!(await t.gamepadInfo())?.usbSwitch) throw new Error(tr('gp.usbNotConfirmed'));
          return t.gamepadUsbStatus();
        }, { exclusive: true }));
      }
      if (!state || state.phase !== 0 || state.enabled !== enabled || state.targetEnabled !== enabled) throw new Error(tr('gp.usbNotConfirmed'));
      usb.value = state;
      return true;
    } catch (err) {
      usbError.value = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      usbBusy.value = false;
    }
  }

  return {
    support, info, config, saved, revision, loadError, unconfirmed, notice, lastIssues, lastTravelIssues, dirty, usb, usbBusy, usbError,
    protocolVersion, newerProto, conflict, travelKnown, travelIssues, locked,
    load, apply, readUsb, setXboxDevice, travelUm, fitToTravel, assign, assignWasd, unassign, setCurve, setStick, setMode, setTransport,
    keepKeyboard, writeMine, readBack,
  };
});
