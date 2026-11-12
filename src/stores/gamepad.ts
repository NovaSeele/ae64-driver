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
import { defineStore } from 'pinia';
import { computed, ref, shallowRef, watch } from 'vue';
import {
  GP_CONFIG_BYTES, GP_CONTROLS, GP_READ_CHUNK, GP_STATUS, GP_WRITE_CHUNK, GamepadStatusError, checkTravelLimits, cloneConfig, crc32, keyPosOf,
  decodeConfig, encodeConfig, requiredTransportBit, usbSetAccepted, validateConfig,
} from '../protocol/gamepad';
import type { GamepadConfig, GamepadInfo, GamepadUsbState, GpIssue, GpTravelIssue } from '../protocol/gamepad';
import { USB_SWITCH_MS } from '../protocol/mockGamepad';
import type { Ae64Transport } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { PermanentSyncError, useSyncStore } from './sync';
import type { SyncJob } from './sync';

/** 'max': AE64 Max (no gamepad firmware exists); 'stock': a Pro without the gamepad firmware; 'ready': loaded. */
export type GamepadSupport = 'unknown' | 'loading' | 'max' | 'stock' | 'ready' | 'error';

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
    loadPromise = null;
  }, { flush: 'sync' });

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
          const gpInfo = await t.gamepadInfo();
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
          if (gpInfo.usbSwitch) usb.value = await t.gamepadUsbStatus().catch(() => null);
        }, { exclusive: true });
      } catch (err) {
        if (gen !== device.connection) return;
        support.value = 'error';
        loadError.value = err instanceof Error ? err.message : String(err);
      }
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
      write: (t) => serial(async () => {
        const draft = config.value;
        if (!draft || support.value !== 'ready') return 'skip';
        let block: Uint8Array;
        try {
          block = encodeConfig(draft);
        } catch (err) {
          throw new PermanentSyncError(err instanceof Error ? err.message : tr('gp.invalid'));
        }
        const gpInfo = await t.gamepadInfo();
        if (!gpInfo) throw new PermanentSyncError(tr('gp.noFirmware'));
        if (gpInfo.revision !== revision.value) {
          // Another writer (or our own unconfirmed COMMIT) changed the block: the keyboard's block is the truth now.
          const now = decodeRead(await readBlock(t, gpInfo));
          adopt(now, gpInfo.revision, gpInfo);
          unconfirmed.value = false;
          if (sameBytes(encodeConfig(now), block)) return 'skip'; // it already holds this draft
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
        const gpInfo = await t.gamepadInfo();
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
        adopt(decodeRead(bytes), gpInfo.revision, gpInfo);
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
    if (issues.length || sameConfig(before, after)) return false;
    commit(after);
    history.push({
      label: tr('gp.editLabel', { what }),
      undo: () => commit(before),
      redo: () => commit(after),
      coalesce: coalesce ? `gamepad:${coalesce}` : undefined,
    });
    return true;
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
    support, info, config, saved, revision, loadError, unconfirmed, notice, lastIssues, dirty, usb, usbBusy, usbError,
    load, apply, readUsb, setXboxDevice,
  };
});
