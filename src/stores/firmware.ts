// The firmware page's session (DESIGN FW §3.3, §3.4, §3.6): file → preflight → `08 01` → bootloader → write → check → restart →
// find the keyboard again, and rescue mode. Family 08 is never built here: the protocol layer (client.ts) does, for a ticket it
// issued; this store only holds the ticket and drives the steps. Nothing is sent before the user presses the start (or, in rescue
// mode, the write) button, apart from the `01 02` reads of the steps.
//
// Step 1 has two sources (DESIGN OFU §3): the online list (our `/firmware/manifest.json`; a build's file downloaded from the
// maker's server only on a press, checked against the list's size and SHA-256) and a file on this computer. Neither sends
// anything to the keyboard; on an AE64 Pro the page asks the gamepad store once per connection whether it runs XInput.
import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import {
  BaseTransport, FirmwarePacketError, FirmwareSessionError, fwAppBack, fwAttach, fwFind, fwForgetProbes, fwFoundBoot,
  fwOtherBoot, fwSessionKeyboard, sessionFile, FW_PROBE_AGAIN_MS, FW_PROBE_TIMEOUT_MS, FW_PROBE_TRIES,
} from '../protocol/client';
import type { FwTicket } from '../protocol/client';
import { FW_MAX_FILE, KNOWN_FW, checkFile, fwModel, isFwBoard, learnFw, serialReadable, thirdPartyVersions } from '../protocol/firmware';
import type { FwCheck, KnownFw } from '../protocol/firmware';
import { asKnown, buildsFor, compareVersions, fwRelation, fwStatus } from '../protocol/fwManifest';
import type { FwBuild, FwKind, FwList, FwListState, FwRelation } from '../protocol/fwManifest';
import { FW_DIRECT, downloadBuild, fetchFwList, sha256Hex } from '../protocol/fwDownload';
import type { FwPort } from '../protocol/fwPort';
import { HidFwPort } from '../protocol/hid';
import { FIRMWARE_LOCK, heldElsewhere, takeLock } from '../protocol/tabLock';
import { MockTransport } from '../protocol/mock';
import { MockBootloader } from '../protocol/mockFirmware';
import type { DemoSeed } from '../protocol/mock';
import { supportsIntervalRt } from '../protocol/codec';
import { checkPerformanceWrite } from '../protocol/safety';
import { FW_AXIS, isCatalogTriple, isCustomTriple, switchCatalogFor } from '../protocol/switches';
import type { SwitchTriple } from '../protocol/switches';
import type { DeviceInfo } from '../protocol/types';
import {
  compare, isBackupExpired, loadBackup, readAllBackups, removeBackup, saveBackup, writeAllBackups,
} from '../data/axisBackup';
import type { AxisBackup, Compare, RestoreCheck, Triple } from '../data/axisBackup';
import type { MessageKey } from '../i18n/vi';
import { useCalibrationStore } from './calibration';
import { useDeviceStore } from './device';
import { useGamepadStore } from './gamepad';
import { useHistoryStore } from './history';
import { usePerformanceStore } from './performance';
import { useSettingsStore } from './settings';
import { useSyncStore } from './sync';
import { holdWindowClose } from '../data/desktopClose';

/** localStorage: '1' shows the Firmware page (DESIGN FW §3.8). Not exported or imported; a reset removes it. */
export const LABS_FIRMWARE_KEY = 'ae64.labs.firmware';

/**
 * Wait after the `08 01` exchange settled (its reply, its timeout, or the app connection leaving USB; the maker's page waits
 * after its reply too) before looking for the bootloader, then every FW_LOOK_MS.
 */
export const FW_ENTER_WAIT_MS = 6_000;
export const FW_LOOK_MS = 500;
/** No bootloader and the app connection still there this long after `08 01` settled: ask the app (`01 02`) whether it left. */
export const FW_ENTER_CHECK_MS = 10_000;
export const FW_ENTER_PROBE_TIMEOUT_MS = 3_000;
/** "Did not enter" needs a second run-mode-0 answer at least this long after the first (the app may linger before it leaves). */
export const FW_ENTER_CONFIRM_MS = 3_000;
/** After `08 04`: wait, then look for the keyboard in its app for at most FW_FIND_MS. */
export const FW_RESTART_WAIT_MS = 3_000;
export const FW_FIND_MS = 20_000;

export type FwPhase =
  | 'idle' | 'preflight' | 'preflightFail' | 'entering' | 'needPermission' | 'enterFail' | 'manyBoot'
  | 'writing' | 'packetFail' | 'verifying' | 'verifyFail' | 'rebooting' | 'finding' | 'notFound' | 'manyApp' | 'lost'
  | 'done' | 'doneUnknown' | 'versionMismatch' | 'noGamepad' | 'rescue'
  /** Lost (or rescue mode), then the session's keyboard came back running its app: the session ended, nothing more was written. */
  | 'appBack';

/** A message with its parameters; a parameter that is itself a message key is translated when shown (the locale may change). */
export interface FwMessage {
  key: MessageKey;
  params?: Record<string, string | number>;
  paramKeys?: Record<string, MessageKey>;
}

/** A check line the online list adds (DESIGN OFU §3.4, §3.5): size and SHA-256 against the list, or "same firmware, other file". */
export interface FwListLine {
  key: 'listSize' | 'listSha' | 'listOther';
  ok: boolean;
}

export interface FwFile {
  name: string;
  size: number;
  /** The store's own copy (never the File again); null when the file was too big to read, or did not match the list. */
  bytes: Uint8Array | null;
  check: FwCheck | null;
  /** Where it came from: downloaded from the online list, or a file on this computer. */
  via: 'online' | 'local';
  /** The listed build it was downloaded as, or whose payload CRC-32 it has (a local file). */
  build: FwBuild | null;
  /** The file's SHA-256, when the list was involved. */
  sha256: string | null;
  lines: FwListLine[];
  /** A local file with a listed build's firmware part but another SHA-256: treated as unknown (the risk box). */
  unlisted: boolean;
}

/** The download block of the online source (DESIGN OFU §3.3); a finished download becomes `file`. */
export interface FwDownload {
  build: FwBuild;
  done: number;
  state: 'run' | 'cut' | 'tooBig' | 'fallback' | 'noNet';
}

export type FwRow = 'todo' | 'now' | 'done' | 'fail';

/** Result of the user pressing "Khôi phục {n} phím" (OFU v1.10 addendum §4.3). */
export interface AxisRestoreResult {
  restored: number[];
  failed: number[];
  cant: number[];
  blocked: number[];
}

const DONE_PHASES: readonly FwPhase[] = ['done', 'doneUnknown', 'versionMismatch', 'noGamepad'];

const readFlag = (): boolean => {
  try { return localStorage.getItem(LABS_FIRMWARE_KEY) === '1'; } catch { return false; }
};

/** The typed confirmation: the keyboard's own model; surrounding spaces and case ignored, inner spaces collapsed. */
export const typedOk = (typed: string, model: string | null): boolean =>
  !!model && typed.trim().replace(/\s+/g, ' ').toLowerCase() === model.toLowerCase();

let hidPort: HidFwPort | null = null;
/** The demo seed of a keyboard back in its app after a session (DESIGN OFU §5: a Max comes back as the demo Max). */
const demoSeedOf = (board: number, gamepad: boolean): DemoSeed => (fwModel(board) === 'AE64 Max' ? 'max' : gamepad ? 'pro-xinput' : 'pro');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const useFirmwareStore = defineStore('firmware', () => {
  const enabled = ref(readFlag());
  /** True from preflight (before `08 01`) until the keyboard is back in its app, and in rescue mode: the whole app is locked. */
  const active = ref(false);
  const rescue = ref(false);
  const phase = ref<FwPhase>('idle');
  const file = shallowRef<FwFile | null>(null);
  const typed = ref('');
  const riskOk = ref(false);
  const sent = ref(0);
  const total = ref(0);
  const error = shallowRef<FwMessage | null>(null);
  const wrongDevice = ref(false);
  /**
   * "Allow…" returned a device that has not answered its `01 02` yet (N-WX2-4): a neutral note, not an error. Gone on
   * "Search again", on the next "Allow…", when the session attaches, and wherever wrongDevice is cleared.
   */
  const notAnswered = ref(false);
  /**
   * W-11: another tab or window of the app holds the firmware lock (it runs a session or rescue mode): this page offers no write
   * ("Start", "Write firmware") until "Try again" finds the lock free.
   */
  const otherWindow = ref(false);
  /** > 0 while the firmware lock is being asked for: no write meanwhile. */
  const lockAsking = ref(0);
  /** "Allow…" (or the search) found an AE64 Pro bootloader with another serial: the page offers rescue mode on it (W-06). */
  const otherSerial = ref(false);
  /** The step the session was in when the keyboard was lost (to mark that row failed). */
  const lostIn = ref<'write' | 'verify' | 'reboot' | null>(null);
  /** Rescue: what the bootloader's `01 02` reported. board null = not readable (read-only page). */
  const rescueBoard = ref<number | null>(null);
  /** Shown in the done banner / mismatch message. */
  const doneVersion = ref('');
  /** The session wrote the version the keyboard already ran ("Đã ghi lại bản {v}"). */
  const doneSame = ref(false);
  const port = shallowRef<FwPort | null>(null);
  /** The version field of the bootloader's `01 02` (the card's Bootloader row), while the keyboard is in it. */
  const bootVersion = ref<string | null>(null);

  // ---- step 1's source and the online list (DESIGN OFU §3, §7, §8)
  const source = ref<'online' | 'local'>('online');
  const listState = ref<FwListState>('idle');
  const list = shallowRef<FwList | null>(null);
  /** On an AE64 Pro: official firmware or XInput (the gamepad store's INFO); null while not read yet. */
  const kind = ref<FwKind | null>(null);
  const dl = shallowRef<FwDownload | null>(null);
  /** The version box of step 2 (DESIGN OFU §4.1). */
  const verOk = ref(false);
  // ---- switch-values backup & restore across a firmware update (OFU v1.10 addendum)
  const axSaveFailed = ref(false);
  const axSame = ref(false);
  const axDismissed = ref(false);
  const axRestoring = ref(false);
  const axBackup = shallowRef<AxisBackup | null>(null);
  const axCompare = shallowRef<Compare | null>(null);
  const axResult = shallowRef<AxisRestoreResult | null>(null);
  const axStorageTick = ref(0);
  let dlCtl: AbortController | null = null;
  let dlGen = 0;
  let listGen = 0;
  let kindGen = 0;

  let ticket: FwTicket | null = null;
  let app: BaseTransport | null = null;
  let boot: BaseTransport | null = null;
  let isDemo = false;
  let releaseExclusive: (() => void) | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let unsub: (() => void)[] = [];
  let looking = false;
  /** watchForBootloader's probes: the answer, or how many went unanswered and when the last one was sent. */
  let probedHere = new WeakMap<BaseTransport, { info: DeviceInfo | null; n: number; at: number }>();
  /** The keyboard of the session or of rescue mode: its board and serial (null: not reported), to recognise it again. */
  let ident: { board: number; serialHex: string | null } | null = null;
  /**
   * The serial the keyboard reported from its app when this session started on it (W-06, N-WX2-1: its bootloader may report
   * another). Accepted only for the keyboard back in its app; null after a rescue opened at connect time (never known).
   */
  let appIdent: { board: number; serialHex: string } | null = null;
  /** The bootloader with another serial that W-06 may continue on. */
  let other: BaseTransport | null = null;
  /** The first run-mode-0 answer of the enter check (ms). */
  let zeroAt: number | null = null;
  let wakeLock: { release(): Promise<void>; released?: boolean } | null = null;
  /** This page's firmware lock (W-11): from start() to the end of the session, and while rescue mode is open (real keyboards). */
  let fwUnlock: (() => void) | null = null;
  /** Bumped whenever a session ends or restarts: callbacks of an older one do nothing. */
  let epoch = 0;
  /** Bumped by every start and rescue write, at the press: a file read that was out meanwhile is dropped (W-13). */
  let starts = 0;

  function setEnabled(on: boolean): void {
    enabled.value = on;
    try {
      if (on) localStorage.setItem(LABS_FIRMWARE_KEY, '1');
      else localStorage.removeItem(LABS_FIRMWARE_KEY);
    } catch {
      // storage unavailable: on for this page only
    }
  }

  /** Takes the firmware lock for this page (true when held, or when the browser has no Web Locks). */
  async function takeFwLock(): Promise<boolean> {
    if (fwUnlock) return true;
    lockAsking.value++;
    const u = await takeLock(FIRMWARE_LOCK).finally(() => { lockAsking.value--; });
    if (!u) {
      otherWindow.value = true;
      return false;
    }
    fwUnlock = u;
    otherWindow.value = false;
    return true;
  }

  function dropFwLock(): void {
    const u = fwUnlock;
    fwUnlock = null;
    u?.();
  }

  /** The page opens, or "Try again": is another window updating firmware now? */
  async function checkOtherWindow(): Promise<void> {
    if (fwUnlock) {
      otherWindow.value = false;
      return;
    }
    // rescue mode open without the lock: take it now (no write until it is held)
    if (rescue.value && !isDemo) {
      await takeFwLock();
      return;
    }
    otherWindow.value = await heldElsewhere(FIRMWARE_LOCK);
  }

  const known = computed<KnownFw | null>(() => (file.value?.unlisted ? null : file.value?.check?.known ?? null));
  /** The five checks, the bytes, and (a download) size and SHA-256 against the list. */
  const fileOk = computed(() => !!file.value?.check?.ok && !!file.value.bytes && file.value.lines.every((l) => l.ok || l.key === 'listOther'));
  const needsRisk = computed(() => fileOk.value && known.value?.kind !== 'official');
  /** Rescue with the switch off: only an official build the app knows. */
  const officialOnly = computed(() => rescue.value && !enabled.value);
  const rescueRefused = computed(() => officialOnly.value && fileOk.value && known.value?.kind !== 'official');

  /** Why the keyboard is busy (the same conditions as the H reload guard): a key of fw.busy.*, or null. */
  function busyKey(): MessageKey | null {
    const device = useDeviceStore();
    if (useCalibrationStore().phase !== 'idle' || device.calibrationLocked()) return 'fw.busy.calib';
    const polling = useSettingsStore().pollingState;
    if (polling === 'applying' || polling === 'reconnecting' || useGamepadStore().usbBusy) return 'fw.busy.usb';
    if (device.exclusiveActive || useSyncStore().pendingCount() > 0) return 'fw.busy.write';
    return null;
  }
  const busy = computed(() => (active.value ? null : busyKey()));

  const deviceBoard = computed<number | null>(() => (rescue.value ? rescueBoard.value : useDeviceStore().info?.boardId ?? null));
  /** The keyboard's board is one this app writes (AE64 Pro or AE64 Max). */
  const boardOk = computed(() => isFwBoard(deviceBoard.value));
  /** "AE64 Pro" / "AE64 Max": the word step 2 asks for. */
  const model = computed(() => fwModel(deviceBoard.value));
  /** The example of rescue mode's "official only" line: the board's newest official build the app knows. */
  const officialExample = computed(() => {
    const b = deviceBoard.value;
    const best = KNOWN_FW.filter((k) => k.kind === 'official' && isFwBoard(b) && k.board === b >>> 0)
      .sort((x, y) => compareVersions(y.appVersion, x.appVersion))[0];
    return best ? `${best.name} ${best.version}` : 'AE64 Pro App 0.1.0.0';
  });
  /** The version the keyboard reports from its app (`01 02`, run mode 0); null in its bootloader or when not read. */
  const current = computed<string | null>(() => {
    const info = useDeviceStore().info;
    return !rescue.value && info && info.runMode === 0 && info.firmware ? info.firmware : null;
  });
  const status = computed(() => fwStatus({
    listState: listState.value, list: list.value, board: deviceBoard.value, rescue: rescue.value, current: current.value, kind: kind.value,
  }));
  /** The board's listed builds, newest first. */
  const builds = computed(() => buildsFor(list.value, deviceBoard.value));
  /** The chosen build against the keyboard (DESIGN OFU §4.1). */
  const relation = computed<FwRelation | null>(() => (fileOk.value
    ? fwRelation(known.value, { board: deviceBoard.value, current: current.value, kind: kind.value, rescue: rescue.value })
    : null));
  const needsVer = computed(() => relation.value !== null && relation.value !== 'newer');
  const canStart = computed(() => !active.value && boardOk.value && fileOk.value && typedOk(typed.value, model.value)
    && (!needsRisk.value || riskOk.value) && (!needsVer.value || verOk.value) && !busy.value && useDeviceStore().connected && !otherWindow.value);
  // bootTick is read first: `boot` is not reactive, so the computed must depend on the tick whatever it short-circuits on
  // (after the rescue bootloader left and another opened, the button stayed off).
  const canRescueWrite = computed(() => bootTick.value >= 0 && rescue.value && phase.value === 'rescue' && !!boot && boot.connected
    && isFwBoard(rescueBoard.value) && fileOk.value && !rescueRefused.value && (!needsRisk.value || riskOk.value) && !otherWindow.value && lockAsking.value === 0);
  /** Bumped when the rescue bootloader comes or goes (canRescueWrite reads `boot`, which is not reactive). */
  const bootTick = ref(0);
  /** The session's bootloader connection is there (packetFail / verifyFail: "Write again" needs it). */
  const bootLive = computed(() => bootTick.value >= 0 && !!boot && boot.connected);
  const failedOnBoot = computed(() => active.value && (phase.value === 'packetFail' || phase.value === 'verifyFail'));
  /** Step 1 takes a file: before a session, in rescue mode before its write, and after a failed write or check (W-04). */
  const canChoose = computed(() => !active.value || phase.value === 'rescue' || (failedOnBoot.value && bootLive.value));

  // ---- switch-values backup & restore helpers (OFU v1.10 addendum §2, §3, §4)

  function hasGoodPerfRead(serialHex: string | null | undefined): boolean {
    if (!serialReadable(serialHex)) return false;
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    if (perf.loading || perf.loadError || perf.loadedSerial !== serialHex || !device.keys.length) return false;
    return device.keys.every((k) => {
      const p = perf.values[k.id];
      return p !== undefined && Number.isFinite(p.axisV2Id) && Number.isFinite(p.axisRangeMax) && Number.isFinite(p.axisCoefficient);
    });
  }

  /** Step 2 warning: the performance store has no good read of this keyboard, so no backup can be taken (§3). */
  const axNoSave = computed(() => !hasGoodPerfRead(useDeviceStore().info?.serialHex));
  const axShowSaveFailed = computed(() => !active.value && !rescue.value && axSaveFailed.value && DONE_PHASES.includes(phase.value));
  const axHasBackup = computed(() => {
    void axStorageTick.value;
    const device = useDeviceStore();
    if (!device.connected || device.info?.runMode !== 0) return false;
    return loadBackup(readAllBackups(), device.info.serialHex, device.info.boardId) !== null;
  });
  const axReadError = computed(() => !active.value && !rescue.value && !axSaveFailed.value && !axDismissed.value
    && axResult.value === null && axHasBackup.value && Boolean(usePerformanceStore().loadError));
  const axOfferedCount = computed(() => {
    const c = axCompare.value;
    return c ? c.restore.length + c.cant.length + c.blocked.length : 0;
  });
  /** True while the card is offering keys before a restore or "Để sau" (steps down the done banner's button to secondary). */
  const axOffering = computed(() => !active.value && !rescue.value && !axSaveFailed.value && !axDismissed.value
    && axResult.value === null && axBackup.value !== null && axOfferedCount.value > 0);
  const axShowCard = computed(() => !active.value && !rescue.value && !axSaveFailed.value && !axDismissed.value
    && (axResult.value !== null || (axBackup.value !== null && axOfferedCount.value > 0)));

  function resetAxisView(keepSaveFailed = false): void {
    if (!keepSaveFailed) axSaveFailed.value = false;
    axSame.value = false;
    axDismissed.value = false;
    axBackup.value = null;
    axCompare.value = null;
    axResult.value = null;
  }

  /** Synchronous pre-update backup right after beginFirmwareSession succeeds and before 08 01 (§2). No HID, no await. */
  function saveAxisBackupBeforeEnter(id: { board: number; serialHex: string | null }, fwBefore: string): void {
    if (id.serialHex === null || !hasGoodPerfRead(id.serialHex)) return;
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    const keys: Record<number, Triple> = {};
    for (const k of device.keys) {
      const p = perf.values[k.id];
      keys[k.id] = [p.axisV2Id, p.axisRangeMax, p.axisCoefficient];
    }
    try {
      const next = saveBackup(readAllBackups(), {
        v: 1,
        serialHex: id.serialHex,
        board: id.board,
        fwBefore,
        takenAt: Date.now(),
        keys,
      });
      writeAllBackups(next);
      axStorageTick.value++;
    } catch {
      axSaveFailed.value = true;
    }
  }

  function makeRestoreCheck(): RestoreCheck {
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    const boardIdHex = device.info?.boardIdHex?.toLowerCase();
    const catalog = switchCatalogFor(boardIdHex);
    const intervalRt = supportsIntervalRt(device.version);
    return {
      tripleOk: (keyId, t) => {
        const cur = perf.values[keyId];
        if (!cur) return false;
        if (!Number.isInteger(t[0]) || !Number.isInteger(t[1]) || !Number.isInteger(t[2])) return false;
        if (t[1] < FW_AXIS.rangeMin || t[2] < FW_AXIS.coefMin) return false;
        const triple: SwitchTriple = { axisV2Id: t[0], axisRangeMax: t[1], axisCoefficient: t[2] };
        return isCatalogTriple(catalog, triple) || isCustomTriple(catalog, triple, cur.axisV2Id);
      },
      write: (keyId, next) => checkPerformanceWrite(next, perf.seenFor(keyId), { intervalRt, boardIdHex }),
    };
  }

  function evaluateAxisBackup(): void {
    if (active.value || rescue.value || axRestoring.value || axResult.value !== null) return;
    if (axSaveFailed.value) {
      axBackup.value = null;
      axCompare.value = null;
      return;
    }
    const inDone = DONE_PHASES.includes(phase.value);
    const device = useDeviceStore();
    const serial = device.info?.serialHex;
    const board = device.info?.boardId;
    if (!device.connected || device.info?.runMode !== 0 || !serialReadable(serial) || board === undefined) {
      axBackup.value = null;
      axCompare.value = null;
      return;
    }
    const all = readAllBackups();
    const raw = all[serial];
    if (raw && isBackupExpired(raw)) {
      try { writeAllBackups(removeBackup(all, serial)); } catch { /* ignore */ }
      axStorageTick.value++;
      axBackup.value = null;
      axCompare.value = null;
      return;
    }
    let b = loadBackup(all, serial, board);
    if (!b || !hasGoodPerfRead(serial)) {
      axBackup.value = null;
      axCompare.value = null;
      return;
    }
    const perf = usePerformanceStore();
    if (!b.after) {
      const after: Record<number, Triple> = {};
      for (const k of device.keys) {
        const p = perf.values[k.id];
        after[k.id] = [p.axisV2Id, p.axisRangeMax, p.axisCoefficient];
      }
      b = { ...b, after };
      try {
        writeAllBackups(saveBackup(all, b));
        axStorageTick.value++;
      } catch {
        // keep `after` in memory if storage write fails
      }
    }
    const cmp = compare(b, perf.values, makeRestoreCheck());
    const offered = cmp.restore.length + cmp.cant.length + cmp.blocked.length;
    if (offered === 0) {
      try { writeAllBackups(removeBackup(readAllBackups(), serial)); } catch { /* ignore */ }
      axStorageTick.value++;
      axBackup.value = null;
      axCompare.value = null;
      const totalSaved = Object.keys(b.keys).length;
      if (inDone && totalSaved > 0 && cmp.same.length === totalSaved) axSame.value = true;
      return;
    }
    axBackup.value = markRaw(b);
    axCompare.value = markRaw(cmp);
    axSame.value = false;
  }

  /** If a valid backup exists for the connected keyboard, ensures performance is read (or compares immediately if already read). */
  function ensurePerfReadForBackup(): void {
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    const serial = device.info?.serialHex;
    const board = device.info?.boardId;
    if (!device.connected || device.info?.runMode !== 0 || !serialReadable(serial) || board === undefined) return;
    axStorageTick.value++;
    const all = readAllBackups();
    const raw = all[serial];
    if (raw && isBackupExpired(raw)) {
      try { writeAllBackups(removeBackup(all, serial)); } catch { /* ignore */ }
      axStorageTick.value++;
      return;
    }
    const b = loadBackup(all, serial, board);
    if (!b) return;
    if (hasGoodPerfRead(serial)) evaluateAxisBackup();
    else if (!perf.loading && !perf.loadError) void perf.load();
  }

  function refreshAxisBackup(): void {
    axStorageTick.value++;
    evaluateAxisBackup();
  }

  /** "Để sau": hides the restore card for this visit; keeps the backup in localStorage; 0 HID (§4.2). */
  function dismissAxisRestore(): void {
    if (axRestoring.value) return;
    axDismissed.value = true;
  }

  /** User press on "Khôi phục {n} phím" (§4.3): re-compares, writes only `restore` keys through perf.restoreAxis, verifies, updates backup. */
  async function restoreSwitchValues(): Promise<AxisRestoreResult | null> {
    if (axRestoring.value || active.value || rescue.value) return null;
    const device = useDeviceStore();
    const perf = usePerformanceStore();
    const serial = device.info?.serialHex;
    const board = device.info?.boardId;
    if (!device.connected || device.info?.runMode !== 0 || !serialReadable(serial) || board === undefined) return null;
    if (!hasGoodPerfRead(serial)) return null;
    const all = readAllBackups();
    const b = loadBackup(all, serial, board);
    if (!b) return null;

    axRestoring.value = true;
    try {
      const check = makeRestoreCheck();
      const cmp = compare(b, perf.values, check);
      const cantSet = new Set<number>(cmp.cant);
      const blockedSet = new Set<number>(cmp.blocked);
      const res = cmp.restore.length ? await perf.restoreAxis(cmp.next) : { restored: [], failed: [], refused: [] };
      for (const item of res.refused) {
        const saved = b.keys[item.id];
        if (saved && !check.tripleOk(item.id, saved)) cantSet.add(item.id);
        else blockedSet.add(item.id);
      }
      const restored = [...res.restored].sort((a, c) => a - c);
      const failed = [...res.failed].sort((a, c) => a - c);
      const cant = [...cantSet].sort((a, c) => a - c);
      const blocked = [...blockedSet].sort((a, c) => a - c);

      const remainingOffered = failed.length + cant.length + blocked.length;
      let updated: AxisBackup | null = null;
      try {
        const latestAll = readAllBackups();
        if (remainingOffered === 0) {
          writeAllBackups(removeBackup(latestAll, serial));
        } else {
          const nextKeys: Record<number, Triple> = { ...b.keys };
          const nextAfter: Record<number, Triple> | undefined = b.after ? { ...b.after } : undefined;
          for (const id of restored) {
            delete nextKeys[id];
            if (nextAfter) delete nextAfter[id];
          }
          updated = nextAfter ? { ...b, keys: nextKeys, after: nextAfter } : { ...b, keys: nextKeys };
          writeAllBackups(saveBackup(latestAll, updated));
        }
        axStorageTick.value++;
      } catch {
        // hardware writes already settled
      }

      const result: AxisRestoreResult = { restored, failed, cant, blocked };
      const hasResult = restored.length + failed.length + cant.length + blocked.length > 0;
      axResult.value = hasResult ? markRaw(result) : null;
      axBackup.value = updated ? markRaw(updated) : null;
      axCompare.value = null;
      return result;
    } finally {
      axRestoring.value = false;
    }
  }

  // ---------------------------------------------------------------- file (step 1): no HID

  async function chooseFile(f: File): Promise<void> {
    if (!canChoose.value) return; // the file of a running session never changes
    const mine = epoch;
    const started = starts;
    const p0 = phase.value;
    const wasActive = active.value;
    const bytes = f.size > FW_MAX_FILE ? null : new Uint8Array(await f.arrayBuffer()).slice();
    // DESIGN OFU §3.5: a file with a listed build's firmware part gets the SHA-256 line (the list is only read here)
    const pre = bytes ? checkFile(bytes, deviceBoard.value) : null;
    const listed = pre && listState.value === 'ok' ? buildsFor(list.value, pre.header.board).find((b) => b.crc32 === pre.crc) ?? null : null;
    const sha = listed && bytes ? await sha256Hex(bytes) : null;
    // W-13: a session may have started (or moved on) while the file was read: it keeps its own file.
    if (mine !== epoch || started !== starts || phase.value !== p0 || active.value !== wasActive || !canChoose.value) return;
    source.value = 'local';
    endDownload();
    await take({
      name: f.name, size: f.size, bytes, via: 'local', build: listed, sha256: sha,
      lines: listed ? [sha === listed.sha256 ? { key: 'listSha', ok: true } : { key: 'listOther', ok: false }] : [],
      unlisted: !!listed && sha !== listed.sha256,
    }, wasActive, p0);
  }

  /** The new file of step 1, from either source (W-04: after a failed write it opens rescue mode on the same bootloader). */
  async function take(f: Omit<FwFile, 'check'>, wasActive: boolean, p0: FwPhase): Promise<void> {
    if (wasActive && p0 !== 'rescue') {
      // packetFail / verifyFail (W-04): rescue mode on the same bootloader connection, with a fresh `01 02` and its own checks.
      await openRescueOn(boot!);
      if (phase.value !== 'rescue') return;
    }
    riskOk.value = false;
    verOk.value = false;
    error.value = null;
    if (!active.value) {
      // a new file after a finished or refused session: the page starts again at step 1
      stopTimers();
      phase.value = 'idle';
      wrongDevice.value = false;
      notAnswered.value = false;
      otherSerial.value = false;
      sent.value = 0;
    }
    file.value = markRaw({ ...f, check: f.bytes ? checkFile(f.bytes, deviceBoard.value) : null });
  }

  // ---------------------------------------------------------------- step 1, online (DESIGN OFU §3.2, §3.3): no HID

  /** Fetches the list (the page opened with Trực tuyến, "Thử lại", "Kiểm tra lại"). The fixed relative URL only. */
  async function loadList(): Promise<void> {
    if (listState.value === 'loading') return;
    const mine = ++listGen;
    listState.value = 'loading';
    const r = await fetchFwList();
    if (mine !== listGen) return;
    if (r.kind === 'ok') {
      // a listed official build not in KNOWN_FW is recognised by its CRC-32 for this page's life (§7.3)
      for (const b of r.list.builds) if (isFwBoard(b.board)) learnFw(asKnown(b));
      list.value = markRaw(r.list);
    } else {
      list.value = null;
    }
    listState.value = r.kind;
  }

  /** On an AE64 Pro running its app: official or XInput, through the gamepad store (once per connection; `force`: "Đọc lại"). */
  async function readKind(force = false): Promise<void> {
    const device = useDeviceStore();
    if (active.value || rescue.value || !device.connected || device.model !== 'pro' || device.info?.runMode !== 0) return;
    const mine = ++kindGen;
    const gen = device.connection;
    kind.value = null;
    const k = await useGamepadStore().firmwareKind(force);
    if (mine === kindGen && gen === device.connection) kind.value = k;
  }

  /** Ends a running download and drops its result (another source, "Đổi bản…", leaving the page). */
  function endDownload(): void {
    dlGen++;
    dlCtl?.abort();
    dlCtl = null;
    dl.value = null;
  }

  /** The app downloads this build itself: the list allows it and this build of the app does (FW_DIRECT, DESIGN OFU v1.4 §8). */
  function canFetch(b: FwBuild): boolean {
    return FW_DIRECT && b.fetch;
  }

  /** "Tải về và kiểm tra" (and every other download button): the build's file, checked against the list. */
  async function download(b: FwBuild): Promise<void> {
    if (!canChoose.value || !builds.value.includes(b) || !canFetch(b)) return;
    endDownload();
    const mine = dlGen;
    const started = starts;
    const ctl = new AbortController();
    dlCtl = ctl;
    dl.value = markRaw<FwDownload>({ build: b, done: 0, state: 'run' });
    const r = await downloadBuild(b, {
      signal: ctl.signal,
      onProgress: (done) => { if (mine === dlGen) dl.value = markRaw<FwDownload>({ build: b, done, state: 'run' }); },
    });
    if (mine !== dlGen) return;
    dlCtl = null;
    if (r.kind !== 'ok' && r.kind !== 'mismatch') {
      dl.value = markRaw({ build: b, done: 'done' in r ? r.done : dl.value?.done ?? 0, state: r.kind });
      return;
    }
    dl.value = null;
    // a session may have started meanwhile: it keeps its own file (W-13)
    if (started !== starts || !canChoose.value || source.value !== 'online') return;
    const match = r.kind === 'ok';
    await take({
      name: b.file, size: r.bytes.length, bytes: match ? r.bytes : null, via: 'online', build: b, sha256: r.sha256,
      lines: [{ key: 'listSize', ok: match || r.sizeOk }, { key: 'listSha', ok: match || r.shaOk }], unlisted: false,
    }, active.value, phase.value);
    // a mismatch keeps no bytes: its five checks are shown from this one look
    const f = file.value;
    if (!match && f?.via === 'online' && f.build === b) file.value = markRaw({ ...f, check: checkFile(r.bytes, deviceBoard.value) });
  }

  /** "Dừng tải": the download stops; the partial bytes are dropped. */
  function stopDownload(): void {
    dlCtl?.abort();
  }

  /** "Đổi bản…": back to the status card (a downloaded file is dropped). */
  function backToList(): void {
    if (!canChoose.value) return;
    endDownload();
    if (file.value?.via !== 'online') return;
    file.value = null;
    riskOk.value = false;
    verOk.value = false;
    if (!active.value) clear();
  }

  /** The source switch (DESIGN OFU §3.1): a running download ends, and a file not taken from the new source is cleared. */
  function setSource(s: 'online' | 'local'): void {
    if (!canChoose.value || s === source.value) return;
    endDownload();
    source.value = s;
    if (file.value && file.value.via !== s) {
      file.value = null;
      riskOk.value = false;
      verOk.value = false;
      if (!active.value) clear();
    }
    if (s === 'online' && listState.value === 'idle') void loadList();
  }

  /** The page opens: Trực tuyến, the list (unless it is loaded or loading), the Pro's kind. Nothing is downloaded. */
  function openPage(): void {
    if (canChoose.value) source.value = 'online';
    if (source.value === 'online' && listState.value !== 'ok' && listState.value !== 'loading') void loadList();
    if (kind.value === null) void readKind();
    if (!active.value && !rescue.value) {
      axDismissed.value = false;
      axResult.value = null;
      ensurePerfReadForBackup();
    }
  }

  /** The page closes: a running download stops. */
  function leavePage(): void {
    endDownload();
  }

  /** The device's board changed (rescue opened, another keyboard): check the chosen file again. */
  watch(deviceBoard, (b) => {
    const f = file.value;
    if (f?.bytes) file.value = markRaw({ ...f, check: checkFile(f.bytes, b) });
  });
  // another connection: its kind is read again (the gamepad store keeps one answer per connection)
  watch(() => useDeviceStore().connection, () => {
    kindGen++;
    kind.value = null;
    // Keep axSaveFailed across adoptFromFirmware while the session is still unwinding (active === true).
    resetAxisView(active.value);
  }, { flush: 'sync' });
  /** Re-run switch-backup compare on every good performance read of the connected keyboard (§4.1). */
  watch(
    () => {
      const device = useDeviceStore();
      const perf = usePerformanceStore();
      return [
        active.value,
        rescue.value,
        phase.value,
        device.connected,
        device.connection,
        device.info?.serialHex ?? null,
        device.info?.boardId ?? null,
        perf.loading,
        perf.loadError,
        perf.loadedSerial,
        perf.readSeq,
      ] as const;
    },
    () => { evaluateAxisBackup(); },
  );
  /** A new file, or a new keyboard state (its version or kind), clears the version box. */
  watch(relation, () => { verOk.value = false; });

  // ---------------------------------------------------------------- timers and listeners of one session

  function later(ms: number, fn: () => void): void {
    const mine = epoch;
    timers.push(setTimeout(() => { if (mine === epoch) fn(); }, ms));
  }

  function stopTimers(): void {
    timers.forEach(clearTimeout);
    timers = [];
    unsub.forEach((u) => u());
    unsub = [];
    looking = false;
  }

  function fail(p: FwPhase, msg: FwMessage | null): void {
    stopTimers();
    phase.value = p;
    error.value = msg;
  }

  /** packetFail / verifyFail: the keyboard sits in its bootloader; keep watching that connection (W-03). */
  function failOnBoot(p: 'packetFail' | 'verifyFail', msg: FwMessage): void {
    fail(p, msg);
    bootTick.value++;
    if (!boot?.connected) {
      lostIn.value = p === 'packetFail' ? 'write' : 'verify';
      return lost();
    }
    watchBoot(boot);
  }

  function portFor(t: BaseTransport | null): FwPort {
    if (t instanceof MockTransport && t.fwMock) return t.fwMock;
    if (t instanceof MockBootloader) return t.bus;
    hidPort ??= new HidFwPort();
    hidPort.adopt(t);
    return hidPort;
  }

  // ---------------------------------------------------------------- preflight → 08 01 (DESIGN FW §3.3)

  async function start(): Promise<void> {
    const device = useDeviceStore();
    if (!canStart.value) return;
    const t = device.transport;
    if (!(t instanceof BaseTransport) || !file.value?.bytes) return;
    starts++;
    epoch++;
    active.value = true;
    phase.value = 'preflight';
    error.value = null;
    wrongDevice.value = false;
    notAnswered.value = false;
    sent.value = 0;
    lostIn.value = null;
    resetAxisView();
    // 0. one window at a time (W-11): the firmware lock, for a real keyboard
    if (!device.demo && !(await takeFwLock())) return preflightFail({ key: 'fw.err.otherWindow' });
    // 1. the typed name, the risk box and the version box, again at the press
    if (!typedOk(typed.value, model.value) || (needsRisk.value && !riskOk.value) || (needsVer.value && !verOk.value)) return preflightFail(null);
    const rewrite = relation.value === 'same';
    const f0 = file.value;
    // 2. nothing to write, pending or running
    try {
      await useSyncStore().flush();
    } catch {
      return preflightFail({ key: 'fw.err.busy', paramKeys: { reason: 'fw.busy.write' } });
    }
    const why = busyKey();
    if (why) return preflightFail({ key: 'fw.err.busy', paramKeys: { reason: why } });
    // 3. every poller stops (exclusive), until the keyboard is handed back
    releaseExclusive = device.holdExclusive();
    // 4. the list's SHA-256 again, on the very bytes handed to the session (DESIGN OFU §11)
    const bytes = f0?.bytes;
    if (!f0 || !bytes || file.value !== f0) return preflightFail({ key: 'fw.err.recheck', params: { dev: '' }, paramKeys: { reason: 'fw.why.file' } });
    const want = f0.via === 'online' ? f0.build?.sha256 ?? '' : f0.lines.some((l) => l.key === 'listSha') ? f0.build?.sha256 ?? '' : null;
    if (want !== null && (await sha256Hex(bytes)) !== want) {
      return preflightFail({ key: 'fw.err.recheck', params: { dev: '' }, paramKeys: { reason: 'fw.why.file' } });
    }
    // 5. the session: the protocol layer copies the file, checks it and reads a fresh `01 02`
    try {
      ticket = await t.beginFirmwareSession(bytes);
    } catch (err) {
      const reason: MessageKey = err instanceof FirmwareSessionError
        ? ({ mode: 'fw.why.mode', serial: 'fw.why.serial', board: 'fw.why.board', file: 'fw.why.file', official: 'fw.why.file' } as const)[err.reason]
        : 'fw.why.mode';
      const dev = err instanceof FirmwareSessionError && err.board !== undefined ? err.board.toString(16).toUpperCase().padStart(8, '0') : '';
      return preflightFail({ key: 'fw.err.recheck', params: { dev }, paramKeys: { reason } });
    }
    app = t;
    isDemo = device.demo;
    doneSame.value = rewrite;
    port.value = markRaw(portFor(t));
    total.value = sessionFile(ticket).packets;
    ident = fwSessionKeyboard(ticket);
    appIdent = ident.serialHex !== null ? { board: ident.board, serialHex: ident.serialHex } : null;
    saveAxisBackupBeforeEnter(ident, device.info?.firmware ?? '');
    zeroAt = null;
    phase.value = 'entering';
    const mine = epoch;
    // The clocks start when the `08 01` exchange settled: its reply, its timeout, or the app connection leaving USB (W-05).
    let leftUsb = (): void => undefined;
    const left = new Promise<void>((r) => { leftUsb = r; });
    unsub.push(t.onDisconnect(() => leftUsb()));
    await Promise.race([t.fwEnter(ticket).catch(() => undefined), left]);
    if (mine !== epoch) return;
    // Nothing is asked of any device for the first 6 s (the keyboard copies its app meanwhile), then every 500 ms and on every
    // new device; "Allow…" shows after 6 s when no bootloader was found, and looking goes on.
    const port0 = port.value!;
    later(FW_ENTER_WAIT_MS, () => {
      void look().then(() => { if (mine === epoch && phase.value === 'entering') phase.value = 'needPermission'; });
      const tick = () => later(FW_LOOK_MS, () => { void look(); if (phase.value === 'entering' || phase.value === 'needPermission') tick(); });
      tick();
      unsub.push(port0.onConnect(() => { if (phase.value === 'entering' || phase.value === 'needPermission') later(0, () => void look()); }));
    });
    later(FW_ENTER_CHECK_MS, () => void enterCheck());
  }

  function preflightFail(msg: FwMessage | null): void {
    stopTimers();
    dropFwLock();
    releaseExclusive?.();
    releaseExclusive = null;
    ticket = null;
    phase.value = 'preflightFail';
    error.value = msg;
    active.value = false;
  }

  /** 10 s after `08 01` the app connection is still there: one `01 02` (3 s). Run mode 0: it did not enter update mode. */
  async function enterCheck(): Promise<void> {
    const mine = epoch;
    if (phase.value !== 'entering' && phase.value !== 'needPermission') return;
    if (!app?.connected) return;
    let info: DeviceInfo | null = null;
    try {
      info = await app.getDeviceInfo(FW_ENTER_PROBE_TIMEOUT_MS);
    } catch {
      info = null; // no answer: it may still be copying its flash; ask again in 10 s
    }
    if (mine !== epoch) return;
    if (info?.runMode === 0) {
      // Two run-mode-0 answers at least 3 s apart: it really stays in its app (W-05).
      const now = Date.now();
      if (zeroAt !== null && now - zeroAt >= FW_ENTER_CONFIRM_MS) return void enterFailed();
      zeroAt ??= now;
      return later(FW_ENTER_CONFIRM_MS, () => void enterCheck());
    }
    later(FW_ENTER_CHECK_MS, () => void enterCheck());
  }

  /** The keyboard stayed in (or came back to) its app: nothing was written. `back`: it left USB and came back in its app on
   * another connection (fwAppBack, it got only `01 02`): that one goes to device.init. Otherwise the app connection is opened
   * again (after `08 01` it may only send `01 02`). The message says the app reconnected only when it did (FW review FW-1).
   */
  async function enterFailed(back: BaseTransport | null = null): Promise<void> {
    const device = useDeviceStore();
    const p = port.value;
    const old = app;
    fail('enterFail', { key: 'fw.err.enter' });
    epoch++;
    ticket = null;
    let fresh: BaseTransport | null = back?.connected ? back : null;
    if (!fresh && p && old) {
      try {
        fresh = await p.reopen(old);
      } catch {
        fresh = null;
      }
    }
    const reconnected = await endSession(fresh, undefined, () => { error.value = { key: 'fw.err.enterNoApp' }; });
    if (!reconnected && device.transport) await device.disconnect({ flush: false });
  }

  /** Looks for the bootloader once (one `01 02` per device). */
  async function look(): Promise<void> {
    if (looking || !ticket || !port.value) return;
    const mine = epoch;
    looking = true;
    try {
      const r = await fwAttach(ticket, await port.value.list());
      if (mine !== epoch) return;
      if (r.ok) return void attached(r.transport, r.info);
      if (r.why === 'many') return fail('manyBoot', { key: 'fw.err.manyBoot' });
      if (r.why === 'appBack') return void enterFailed(fwAppBack(ticket));
      if (r.why === 'wrong' && phase.value === 'needPermission') offerOther();
    } catch {
      // a step of an ended session
    } finally {
      if (mine === epoch) looking = false;
    }
  }

  /** "Allow the keyboard in update mode": the browser's chooser (a real click). A wrong device only got `01 02`. */
  async function allow(): Promise<void> {
    if (phase.value !== 'needPermission' || !ticket || !port.value) return;
    const mine = epoch;
    wrongDevice.value = false;
    notAnswered.value = false;
    const chosen = await port.value.request();
    if (mine !== epoch || !chosen.length) return;
    const r = await fwAttach(ticket, chosen).catch(() => null);
    if (mine !== epoch || !r) return;
    if (r.ok) return void attached(r.transport, r.info);
    if (r.why === 'many') return fail('manyBoot', { key: 'fw.err.manyBoot' });
    // 'none': the device chosen has not answered yet (busy); the search goes on and asks it again (N-WX2-2), and the page
    // says so (N-WX2-4) until it answers, "Search again", the next "Allow…" or the session attaches
    if (r.why === 'none') notAnswered.value = true;
    else if (r.why === 'wrong' && !offerOther()) wrongDevice.value = true;
  }

  /** W-06: the device found is an AE64 Pro bootloader with another serial: say so, and offer rescue mode on it (never by itself). */
  function offerOther(): boolean {
    const o = ticket ? fwOtherBoot(ticket) : null;
    other = o;
    otherSerial.value = !!o;
    if (o) {
      wrongDevice.value = false;
      notAnswered.value = false;
    }
    return !!o;
  }

  /** "Continue in rescue mode" on that bootloader: the session ends; rescue reads its `01 02` and runs its own checks. */
  async function continueRescue(): Promise<void> {
    const t = other;
    if (phase.value !== 'needPermission' || !otherSerial.value || !t?.connected) return;
    // the serial the keyboard reported from its app, read before the ticket is dropped (N-WX2-1)
    const k = ticket ? fwSessionKeyboard(ticket) : null;
    if (k?.appSerialHex) appIdent = { board: k.board, serialHex: k.appSerialHex };
    other = null;
    otherSerial.value = false;
    ident = null;
    await openRescueOn(t);
  }

  // ---------------------------------------------------------------- write → check → restart → find

  function watchBoot(t: BaseTransport): void {
    const mine = epoch;
    unsub.push(t.onDisconnect(() => {
      if (mine !== epoch) return;
      const p = phase.value;
      if (p === 'writing' || p === 'verifying' || p === 'packetFail' || p === 'verifyFail') {
        lostIn.value = p === 'writing' || p === 'packetFail' ? 'write' : 'verify';
        boot = null;
        bootTick.value++;
        return void lost();
      }
      if (p === 'rescue') {
        boot = null;
        bootTick.value++;
        void watchForBootloader();
      }
    }));
  }

  function attached(t: BaseTransport, info: DeviceInfo): void {
    stopTimers();
    boot = t;
    bootVersion.value = info.firmware;
    wrongDevice.value = false;
    notAnswered.value = false;
    otherSerial.value = false;
    other = null;
    void runWrite();
  }

  async function runWrite(): Promise<void> {
    const t = boot;
    if (!t || !ticket) return;
    epoch++;
    const mine = epoch;
    stopTimers();
    watchBoot(t);
    error.value = null;
    lostIn.value = null;
    sent.value = 0;
    phase.value = 'writing';
    try {
      await t.fwWrite(ticket, (n, all) => { if (mine === epoch) { sent.value = n; total.value = all; } });
    } catch (err) {
      if (mine !== epoch || (phase.value as FwPhase) === 'lost') return;
      if (err instanceof FirmwarePacketError) return failOnBoot('packetFail', { key: 'fw.err.packet', params: { n: err.index } });
      return failOnBoot('packetFail', { key: 'fw.err.recheck', paramKeys: { reason: 'fw.why.file' } });
    }
    if (mine !== epoch) return;
    phase.value = 'verifying';
    const ok = await t.fwVerify(ticket).catch(() => false);
    if (mine !== epoch || (phase.value as FwPhase) === 'lost') return;
    if (!ok) return failOnBoot('verifyFail', { key: 'fw.err.verify' });
    phase.value = 'rebooting';
    await t.fwRestart(ticket).catch(() => undefined);
    if (mine !== epoch) return;
    later(FW_RESTART_WAIT_MS, () => startFinding());
  }

  function startFinding(): void {
    if (!ticket || !port.value) return;
    phase.value = 'finding';
    error.value = null;
    const mine = epoch;
    const until = Date.now() + FW_FIND_MS;
    const tick = (): void => later(FW_LOOK_MS, () => {
      void find().then(() => {
        if (mine !== epoch || phase.value !== 'finding') return;
        if (Date.now() >= until) {
          phase.value = 'notFound';
          error.value = { key: 'fw.err.notFound' };
          return;
        }
        tick();
      });
    });
    void find().then(() => { if (mine === epoch && phase.value === 'finding') tick(); });
    unsub.push(port.value.onConnect(() => {
      if (phase.value === 'finding' || phase.value === 'notFound') later(0, () => void find());
    }));
  }

  async function find(): Promise<void> {
    if (looking || !ticket || !port.value) return;
    const mine = epoch;
    looking = true;
    try {
      const list = await port.value.list();
      const r = await fwFind(ticket, list);
      if (mine !== epoch) return;
      if (r.ok) return void found(r.transport, r.info);
      if (r.why === 'many') return fail('manyApp', { key: 'fw.err.manyApp', params: { model: model.value ?? 'AE64' } });
      if (r.why === 'boot') {
        const b = fwFoundBoot(ticket);
        if (b) return void openRescueOn(b);
      }
    } catch {
      // ended session
    } finally {
      if (mine === epoch) looking = false;
    }
  }

  /** The keyboard is back in its app: compare versions (`01 02`, then INFO), then hand it to device.init. */
  async function found(t: BaseTransport, info: DeviceInfo): Promise<void> {
    if (!ticket) return;
    const mine = epoch;
    stopTimers();
    const k = sessionFile(ticket).known;
    let result: FwPhase = 'done';
    let msg: FwMessage | null = null;
    let gamepad = false;
    doneVersion.value = k?.version ?? info.firmware;
    if (!k) {
      result = 'doneUnknown';
      doneVersion.value = info.firmware;
    } else if (info.firmware !== k.appVersion) {
      result = 'versionMismatch';
    } else {
      let gi: Awaited<ReturnType<BaseTransport['gamepadInfo']>> | 'error' = null;
      // only a board with an XInput build (the Pro) is asked: an AE64 Max never gets a family-0x10 frame (DESIGN OFU §5, §8)
      if (thirdPartyVersions(info.boardId).length > 0) {
        try {
          gi = await t.gamepadInfo();
        } catch {
          gi = 'error';
        }
      }
      if (mine !== epoch) return;
      gamepad = gi !== null && gi !== 'error';
      if (k.gamepad === null) {
        if (gi !== null) result = 'versionMismatch'; // AGP1 answered: the old XInput build still runs
      } else if (gi === null || gi === 'error' || (k.gamepad.caps !== null && gi.caps !== k.gamepad.caps)) {
        result = 'noGamepad';
      }
    }
    const want = k ? `${k.name} ${k.version}` : '';
    const got = `${info.firmware}${gamepad ? ' + AGP1' : ''}`;
    if (result === 'versionMismatch') msg = { key: 'fw.err.version', params: { got, want } };
    if (result === 'noGamepad') msg = { key: 'fw.err.noGamepad', params: { got } };
    phase.value = result;
    error.value = msg;
    const adopted = await endSession(t, isDemo ? demoSeedOf(info.boardId, gamepad) : undefined);
    if (adopted && !axSaveFailed.value) ensurePerfReadForBackup();
  }

  /**
   * The keyboard is in its app again (or never left): device.init on `t` as a new connection, then unlock. The app stays locked
   * (and the page kept: App's keepPage) until init is done, so the connect screen never flashes between the session and the
   * keyboard handed back, and the page's focus (banner / failed step) is not lost. True when `t` is now the app's connection.
   */
  async function endSession(t: BaseTransport | null, seed: DemoSeed | undefined, onNotAdopted?: () => void): Promise<boolean> {
    const device = useDeviceStore();
    const p = port.value;
    stopTimers();
    epoch++;
    ticket = null;
    boot = null;
    app = null;
    rescue.value = false;
    rescueBoard.value = null;
    bootVersion.value = null;
    other = null;
    otherSerial.value = false;
    releaseExclusive?.();
    releaseExclusive = null;
    typed.value = '';
    riskOk.value = false;
    verOk.value = false;
    const mine = epoch;
    let ok = false;
    try {
      if (p && t) p.keep(t);
      if (p) for (const d of await p.list().catch(() => [])) if (d !== t) await p.release(d).catch(() => undefined);
      if (t) ok = await device.adoptFromFirmware(t, isDemo, seed).then(() => device.connected && device.transport === t, () => false);
      // set before the unlock, so the page never shows the other message
      if (!ok && mine === epoch) onNotAdopted?.();
    } finally {
      if (mine === epoch) {
        active.value = false; // (init found a bootloader: openRescue took over)
        dropFwLock();
      }
    }
    return ok;
  }

  /** Lost during write or check: stop; wait for the keyboard to come back (in its bootloader: rescue). */
  function lost(): void {
    fail('lost', { key: 'fw.err.lost' });
    void watchForBootloader();
  }

  /** One `01 02` per device; one without an answer is asked again (FW_PROBE_TRIES in all, FW_PROBE_AGAIN_MS apart). */
  async function probeHere(d: BaseTransport): Promise<DeviceInfo | null> {
    const seen = probedHere.get(d);
    if (seen?.info) return seen.info;
    if (seen && (seen.n >= FW_PROBE_TRIES || Date.now() - seen.at < FW_PROBE_AGAIN_MS)) return null;
    const at = Date.now();
    probedHere.set(d, { info: null, n: (seen?.n ?? 0) + 1, at });
    const info = await d.getDeviceInfo(FW_PROBE_TIMEOUT_MS).catch(() => null);
    if (info) probedHere.set(d, { info, n: 0, at });
    return info;
  }

  const isOurs = (i: DeviceInfo): boolean => !!ident && i.boardId === ident.board && ident.serialHex !== null && i.serialHex === ident.serialHex;
  /** The session's keyboard in its app: the serial of `ident`, or the one it reported from its app (N-WX2-1). */
  const isOursInApp = (i: DeviceInfo): boolean => isOurs(i) || (!!appIdent && i.boardId === appIdent.board && i.serialHex === appIdent.serialHex);

  /**
   * While locked without a bootloader: every new device gets its `01 02`. A Pro bootloader opens rescue mode (the session's
   * keyboard first, W-13); the session's keyboard back in its app (its board and serial, run mode 0) ends the session (W-07).
   */
  async function watchForBootloader(): Promise<void> {
    const p = port.value;
    if (!p) return;
    const mine = epoch;
    let checking = false;
    const check = async (): Promise<void> => {
      if (mine !== epoch || checking) return;
      checking = true;
      try {
        const boots: [BaseTransport, DeviceInfo][] = [];
        for (const d of await p.list()) {
          if (!d.connected || d === boot) continue;
          const info = await probeHere(d);
          if (mine !== epoch) return;
          if (info?.runMode === 255) boots.push([d, info]);
          else if (info?.runMode === 0 && isOursInApp(info)) return void backInApp(d, info);
        }
        const pick = boots.find(([, i]) => isOurs(i)) ?? boots[0];
        if (pick) return void openRescueOn(pick[0], pick[1]);
      } finally {
        if (mine === epoch) checking = false;
      }
    };
    unsub.push(p.onConnect(() => later(0, () => void check())));
    const tick = (): void => later(1000, () => { void check().then(() => { if (mine === epoch) tick(); }); });
    tick();
  }

  /** W-07: the session's keyboard runs its app again. Nothing more is sent but device.init's reads; the app unlocks. */
  async function backInApp(t: BaseTransport, info: DeviceInfo): Promise<void> {
    fail('appBack', { key: 'fw.err.appBack', params: { v: info.firmware } });
    await endSession(t, isDemo ? demoSeedOf(info.boardId, false) : undefined, () => { error.value = { key: 'fw.err.appBackNoApp', params: { v: info.firmware } }; });
  }

  // ---------------------------------------------------------------- rescue mode (DESIGN FW §3.6)

  /** device.init found a keyboard in its bootloader (`01 02` said run mode 255). Nothing more was sent to it. */
  function openRescue(t: BaseTransport, info: DeviceInfo, demo: boolean): void {
    isDemo = demo;
    appIdent = null; // opened at connect time: the app's serial is not known
    resetAxisView();
    port.value = markRaw(portFor(t));
    void openRescueOn(t, info);
  }

  async function openRescueOn(t: BaseTransport, info?: DeviceInfo): Promise<void> {
    stopTimers();
    epoch++;
    const i = info ?? await t.getDeviceInfo(FW_PROBE_TIMEOUT_MS).catch(() => null);
    ticket = null;
    boot = t;
    bootTick.value++;
    active.value = true;
    rescue.value = true;
    rescueBoard.value = i && i.boardId !== 0 && i.boardId !== 0xffffffff ? i.boardId : null;
    bootVersion.value = i?.firmware ?? null;
    if (rescueBoard.value !== null) {
      ident = { board: rescueBoard.value, serialHex: serialReadable(i!.serialHex) ? i!.serialHex : ident?.serialHex ?? null };
    }
    phase.value = 'rescue';
    error.value = null;
    wrongDevice.value = false;
    notAnswered.value = false;
    otherSerial.value = false;
    other = null;
    sent.value = 0;
    lostIn.value = null;
    watchBoot(t);
    // W-11: rescue mode holds the firmware lock (a session's own rescue already has it); no write until it is held. Without it
    // the page shows rescue mode with no write, and says another window is updating firmware.
    if (!isDemo && !fwUnlock) void takeFwLock();
  }

  /** "Write firmware" in rescue mode: a session on the bootloader (its own `01 02`), then the same steps. */
  async function rescueWrite(): Promise<void> {
    if (!canRescueWrite.value || !boot || !file.value?.bytes) return;
    // a download: the list's SHA-256 again on its bytes (DESIGN OFU §11); the press stays synchronous for a local file (W-13)
    const f0 = file.value;
    if (f0.via === 'online' && (!f0.build || !f0.bytes || (await sha256Hex(f0.bytes)) !== f0.build.sha256 || file.value !== f0 || !canRescueWrite.value)) return;
    // the lock was taken when rescue mode opened; a backstop only (no await when held: the press stays synchronous, W-13)
    if (!isDemo && !fwUnlock && (!(await takeFwLock()) || !canRescueWrite.value || !boot || !file.value?.bytes)) return;
    starts++;
    const t = boot;
    error.value = null;
    resetAxisView(true);
    try {
      ticket = await t.beginRescueSession(file.value.bytes, { officialOnly: officialOnly.value, appSerialHex: appIdent?.serialHex ?? null });
    } catch (err) {
      const reason: MessageKey = err instanceof FirmwareSessionError && err.reason === 'board' ? 'fw.why.board'
        : err instanceof FirmwareSessionError && err.reason === 'mode' ? 'fw.why.mode' : 'fw.why.file';
      error.value = { key: 'fw.err.recheck', params: { dev: '' }, paramKeys: { reason } };
      return;
    }
    total.value = sessionFile(ticket).packets;
    const k = fwSessionKeyboard(ticket);
    ident = { board: k.board, serialHex: k.serialHex ?? ident?.serialHex ?? null };
    void runWrite();
  }

  /**
   * "Write again from the start" (packetFail / verifyFail): same file, same bootloader connection, never `08 01` again. Refused
   * when that connection is gone (the button says so, W-03).
   */
  function retry(): void {
    if ((phase.value !== 'packetFail' && phase.value !== 'verifyFail') || !ticket) return;
    if (!boot?.connected) {
      bootTick.value++; // the button turns off and says why
      return;
    }
    void runWrite();
  }

  /** "Search again" (several bootloaders / keyboards, or no bootloader seen yet): every device gets its `01 02` again. */
  function findAgain(): void {
    if (!ticket) return;
    fwForgetProbes(ticket);
    if (phase.value === 'needPermission') {
      // the look loop of start() still runs: it asks every device again from now on (W-05)
      wrongDevice.value = false;
      notAnswered.value = false;
      otherSerial.value = false;
      void look();
    } else if (phase.value === 'manyBoot') {
      phase.value = 'needPermission';
      error.value = null;
      const tick = () => later(FW_LOOK_MS, () => { void look(); if (phase.value === 'needPermission') tick(); });
      void look();
      tick();
    } else if (phase.value === 'manyApp' || phase.value === 'notFound') {
      startFinding();
    }
  }

  // ---------------------------------------------------------------- the four rows of step 3

  const rows = computed<Record<'write' | 'verify' | 'reboot' | 'find', FwRow>>(() => {
    const p = phase.value;
    const order = ['write', 'verify', 'reboot', 'find'] as const;
    const at = ({ writing: 0, packetFail: 0, verifying: 1, verifyFail: 1, rebooting: 2, finding: 3, notFound: 3, manyApp: 3 } as Partial<Record<FwPhase, number>>)[p];
    const out = { write: 'todo', verify: 'todo', reboot: 'todo', find: 'todo' } as Record<(typeof order)[number], FwRow>;
    if (p === 'done' || p === 'doneUnknown' || p === 'versionMismatch' || p === 'noGamepad') {
      for (const k of order) out[k] = 'done';
      if (p === 'versionMismatch' || p === 'noGamepad') out.find = 'fail';
      return out;
    }
    if (p === 'appBack' && lostIn.value === null) return out;
    if (p === 'lost' || p === 'appBack') {
      const li = order.indexOf(lostIn.value ?? 'write');
      order.forEach((k, i) => { out[k] = i < li ? 'done' : i === li ? 'fail' : 'todo'; });
      return out;
    }
    if (at === undefined) return out;
    const failed = p === 'packetFail' || p === 'verifyFail' || p === 'notFound' || p === 'manyApp';
    order.forEach((k, i) => { out[k] = i < at ? 'done' : i === at ? (failed ? 'fail' : 'now') : 'todo'; });
    return out;
  });

  // ---------------------------------------------------------------- page protection while active (DESIGN FW §3.4)

  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    e.preventDefault();
    e.returnValue = '';
  };

  let releaseHistory: (() => void) | null = null;
  watch(active, async (on) => {
    // Undo / redo off (they would write to a keyboard that is not in its app).
    if (on) releaseHistory ??= useHistoryStore().suspend();
    else {
      releaseHistory?.();
      releaseHistory = null;
    }
    if (typeof window === 'undefined') return;
    holdWindowClose(on || useCalibrationStore().holdsWindow); // the desktop app: a window close asks first (no-op on the web)
    if (on) {
      window.addEventListener('beforeunload', onBeforeUnload);
      document.addEventListener('visibilitychange', onVisible);
      await requestWake();
    } else {
      window.removeEventListener('beforeunload', onBeforeUnload);
      document.removeEventListener('visibilitychange', onVisible);
      void releaseWake();
    }
  });

  async function requestWake(): Promise<void> {
    try {
      const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void>; released?: boolean }> } }).wakeLock;
      wakeLock = wl ? await wl.request('screen') : null;
    } catch {
      wakeLock = null; // not allowed: the note card still says not to let the computer sleep
    }
    if (!active.value) void releaseWake();
  }

  /** The browser drops the wake lock when the tab is hidden: ask again when it shows, while writing or checking (W-13). */
  function onVisible(): void {
    if (document.visibilityState !== 'visible' || !active.value) return;
    if (phase.value !== 'writing' && phase.value !== 'verifying') return;
    if (wakeLock && (wakeLock as { released?: boolean }).released !== true) return;
    void requestWake();
  }

  async function releaseWake(): Promise<void> {
    const w = wakeLock;
    wakeLock = null;
    await w?.release().catch(() => undefined);
  }

  /** Back to the page's start (a new file, after done or a failure that unlocked the app). */
  function clear(): void {
    if (active.value) return;
    stopTimers();
    epoch++;
    phase.value = 'idle';
    error.value = null;
    wrongDevice.value = false;
    notAnswered.value = false;
    otherSerial.value = false;
    sent.value = 0;
    probedHere = new WeakMap();
    resetAxisView();
  }

  return {
    enabled, active, rescue, phase, file, typed, riskOk, sent, total, error, wrongDevice, notAnswered, otherWindow, checkOtherWindow, otherSerial, rescueBoard, doneVersion, port,
    rows, known, fileOk, needsRisk, officialOnly, officialExample, rescueRefused, busy, boardOk, model, canStart, canRescueWrite, deviceBoard, bootLive,
    canChoose, setEnabled, chooseFile, start, allow, continueRescue, retry, findAgain, rescueWrite, openRescue, clear,
    doneSame, bootVersion, source, listState, list, kind, dl, verOk, current, status, builds, relation, needsVer,
    loadList, readKind, canFetch, download, stopDownload, backToList, setSource, openPage, leavePage,
    axSaveFailed, axShowSaveFailed, axSame, axNoSave, axRestoring, axBackup, axCompare, axResult, axShowCard, axOffering, axReadError,
    refreshAxisBackup, dismissAxisRestore, restoreSwitchValues,
    /** Test hook: wait for queued microtasks of the store. */
    _sleep: sleep,
  };
});
