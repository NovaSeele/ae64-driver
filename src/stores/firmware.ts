// The firmware page's session (DESIGN FW §3.3, §3.4, §3.6): file → preflight → `08 01` → bootloader → write → check → restart →
// find the keyboard again, and rescue mode. Family 08 is never built here: the protocol layer (client.ts) does, for a ticket it
// issued; this store only holds the ticket and drives the steps. Nothing is sent before the user presses the start (or, in rescue
// mode, the write) button, apart from the `01 02` reads of the steps.
import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef, watch } from 'vue';
import {
  BaseTransport, FirmwarePacketError, FirmwareSessionError, fwAppBack, fwAttach, fwFind, fwForgetProbes, sessionFile,
  FW_PROBE_TIMEOUT_MS,
} from '../protocol/client';
import type { FwTicket } from '../protocol/client';
import { FW_BOARD_PRO, FW_MAX_FILE, checkFile } from '../protocol/firmware';
import type { FwCheck, KnownFw } from '../protocol/firmware';
import type { FwPort } from '../protocol/fwPort';
import { HidFwPort } from '../protocol/hid';
import { MockTransport } from '../protocol/mock';
import { MockBootloader } from '../protocol/mockFirmware';
import type { DemoSeed } from '../protocol/mock';
import type { DeviceInfo } from '../protocol/types';
import type { MessageKey } from '../i18n/vi';
import { useCalibrationStore } from './calibration';
import { useDeviceStore } from './device';
import { useGamepadStore } from './gamepad';
import { useHistoryStore } from './history';
import { useSettingsStore } from './settings';
import { useSyncStore } from './sync';
import { holdWindowClose } from '../data/desktopClose';

/** localStorage: '1' shows the Firmware page (DESIGN FW §3.8). Not exported or imported; a reset removes it. */
export const LABS_FIRMWARE_KEY = 'ae64.labs.firmware';

/** Wait after `08 01` before looking for the bootloader (as the maker's page), then every FW_LOOK_MS. */
export const FW_ENTER_WAIT_MS = 6_000;
export const FW_LOOK_MS = 500;
/** No bootloader and the app connection still there this long after `08 01`: ask the app (`01 02`) whether it left. */
export const FW_ENTER_CHECK_MS = 10_000;
export const FW_ENTER_PROBE_TIMEOUT_MS = 3_000;
/** After `08 04`: wait, then look for the keyboard in its app for at most FW_FIND_MS. */
export const FW_RESTART_WAIT_MS = 3_000;
export const FW_FIND_MS = 20_000;

export type FwPhase =
  | 'idle' | 'preflight' | 'preflightFail' | 'entering' | 'needPermission' | 'enterFail' | 'manyBoot'
  | 'writing' | 'packetFail' | 'verifying' | 'verifyFail' | 'rebooting' | 'finding' | 'notFound' | 'manyApp' | 'lost'
  | 'done' | 'doneUnknown' | 'versionMismatch' | 'noGamepad' | 'rescue';

/** A message with its parameters; a parameter that is itself a message key is translated when shown (the locale may change). */
export interface FwMessage {
  key: MessageKey;
  params?: Record<string, string | number>;
  paramKeys?: Record<string, MessageKey>;
}

export interface FwFile {
  name: string;
  size: number;
  /** The store's own copy (never the File again); null when the file was too big to read. */
  bytes: Uint8Array | null;
  check: FwCheck | null;
}

export type FwRow = 'todo' | 'now' | 'done' | 'fail';

const readFlag = (): boolean => {
  try { return localStorage.getItem(LABS_FIRMWARE_KEY) === '1'; } catch { return false; }
};

/** The typed confirmation: surrounding spaces and case ignored, inner spaces collapsed. */
export const typedOk = (typed: string): boolean => typed.trim().replace(/\s+/g, ' ').toLowerCase() === 'ae64 pro';

let hidPort: HidFwPort | null = null;
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
  /** The step the session was in when the keyboard was lost (to mark that row failed). */
  const lostIn = ref<'write' | 'verify' | 'reboot' | null>(null);
  /** Rescue: what the bootloader's `01 02` reported. board null = not readable (read-only page). */
  const rescueBoard = ref<number | null>(null);
  /** Shown in the done banner / mismatch message. */
  const doneVersion = ref('');
  const port = shallowRef<FwPort | null>(null);

  let ticket: FwTicket | null = null;
  let app: BaseTransport | null = null;
  let boot: BaseTransport | null = null;
  let isDemo = false;
  let releaseExclusive: (() => void) | null = null;
  let timers: ReturnType<typeof setTimeout>[] = [];
  let unsub: (() => void)[] = [];
  let looking = false;
  let probedHere = new WeakSet<BaseTransport>();
  let wakeLock: { release(): Promise<void> } | null = null;
  /** Bumped whenever a session ends or restarts: callbacks of an older one do nothing. */
  let epoch = 0;

  function setEnabled(on: boolean): void {
    enabled.value = on;
    try {
      if (on) localStorage.setItem(LABS_FIRMWARE_KEY, '1');
      else localStorage.removeItem(LABS_FIRMWARE_KEY);
    } catch {
      // storage unavailable: on for this page only
    }
  }

  const known = computed<KnownFw | null>(() => file.value?.check?.known ?? null);
  const fileOk = computed(() => !!file.value?.check?.ok && !!file.value.bytes);
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
  const isPro = computed(() => deviceBoard.value === FW_BOARD_PRO);
  const canStart = computed(() => !active.value && isPro.value && fileOk.value && typedOk(typed.value)
    && (!needsRisk.value || riskOk.value) && !busy.value && useDeviceStore().connected);
  const canRescueWrite = computed(() => rescue.value && phase.value === 'rescue' && !!boot && boot.connected && rescueBoard.value === FW_BOARD_PRO
    && fileOk.value && !rescueRefused.value && (!needsRisk.value || riskOk.value) && bootTick.value >= 0);
  /** Bumped when the rescue bootloader comes or goes (canRescueWrite reads `boot`, which is not reactive). */
  const bootTick = ref(0);

  // ---------------------------------------------------------------- file (step 1): no HID

  async function chooseFile(f: File): Promise<void> {
    if (active.value && phase.value !== 'rescue') return; // the file of a running session never changes
    riskOk.value = false;
    error.value = null;
    if (!active.value) {
      // a new file after a finished or refused session: the page starts again at step 1
      stopTimers();
      phase.value = 'idle';
      wrongDevice.value = false;
      sent.value = 0;
    }
    if (f.size > FW_MAX_FILE) {
      file.value = markRaw({ name: f.name, size: f.size, bytes: null, check: null });
      return;
    }
    const bytes = new Uint8Array(await f.arrayBuffer()).slice();
    file.value = markRaw({ name: f.name, size: f.size, bytes, check: checkFile(bytes, deviceBoard.value) });
  }

  /** The device's board changed (rescue opened, another keyboard): check the chosen file again. */
  watch(deviceBoard, (b) => {
    const f = file.value;
    if (f?.bytes) file.value = markRaw({ ...f, check: checkFile(f.bytes, b) });
  });

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
    epoch++;
    active.value = true;
    phase.value = 'preflight';
    error.value = null;
    wrongDevice.value = false;
    sent.value = 0;
    lostIn.value = null;
    // 1. the typed name and the risk box, again at the press
    if (!typedOk(typed.value) || (needsRisk.value && !riskOk.value)) return preflightFail(null);
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
    // 4. the session: the protocol layer copies the file, checks it and reads a fresh `01 02`
    try {
      ticket = await t.beginFirmwareSession(file.value.bytes);
    } catch (err) {
      const reason: MessageKey = err instanceof FirmwareSessionError
        ? ({ mode: 'fw.why.mode', serial: 'fw.why.serial', board: 'fw.why.board', file: 'fw.why.file', official: 'fw.why.file' } as const)[err.reason]
        : 'fw.why.mode';
      const dev = err instanceof FirmwareSessionError && err.board !== undefined ? err.board.toString(16).toUpperCase().padStart(8, '0') : '';
      return preflightFail({ key: 'fw.err.recheck', params: { dev }, paramKeys: { reason } });
    }
    app = t;
    isDemo = device.demo;
    port.value = markRaw(portFor(t));
    total.value = sessionFile(ticket).packets;
    phase.value = 'entering';
    const mine = epoch;
    void t.fwEnter(ticket);
    // Nothing is asked of any device for the first 6 s (the keyboard copies its app meanwhile), then every 500 ms and on every
    // new device; "Allow…" shows after 6 s when no bootloader was found, and looking goes on.
    const port0 = port.value;
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
    if (info?.runMode === 0) return void enterFailed();
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
      if (r.ok) return void attached(r.transport);
      if (r.why === 'many') return fail('manyBoot', { key: 'fw.err.manyBoot' });
      if (r.why === 'appBack') return void enterFailed(fwAppBack(ticket));
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
    const chosen = await port.value.request();
    if (mine !== epoch || !chosen.length) return;
    const r = await fwAttach(ticket, chosen).catch(() => null);
    if (mine !== epoch || !r) return;
    if (r.ok) return void attached(r.transport);
    if (r.why === 'many') return fail('manyBoot', { key: 'fw.err.manyBoot' });
    wrongDevice.value = true;
  }

  // ---------------------------------------------------------------- write → check → restart → find

  function watchBoot(t: BaseTransport): void {
    const mine = epoch;
    unsub.push(t.onDisconnect(() => {
      if (mine !== epoch) return;
      const p = phase.value;
      if (p === 'writing' || p === 'verifying') {
        lostIn.value = p === 'writing' ? 'write' : 'verify';
        return void lost();
      }
      if (p === 'rescue') {
        boot = null;
        bootTick.value++;
        void watchForBootloader();
      }
    }));
  }

  function attached(t: BaseTransport): void {
    stopTimers();
    boot = t;
    wrongDevice.value = false;
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
      if (err instanceof FirmwarePacketError) return fail('packetFail', { key: 'fw.err.packet', params: { n: err.index } });
      return fail('packetFail', { key: 'fw.err.recheck', paramKeys: { reason: 'fw.why.file' } });
    }
    if (mine !== epoch) return;
    phase.value = 'verifying';
    const ok = await t.fwVerify(ticket).catch(() => false);
    if (mine !== epoch || (phase.value as FwPhase) === 'lost') return;
    if (!ok) return fail('verifyFail', { key: 'fw.err.verify' });
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
      if (r.why === 'many') return fail('manyApp', { key: 'fw.err.manyApp' });
      if (r.why === 'boot') {
        const b = list.find((d) => d.connected && d.runModeSeen === 255);
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
      try {
        gi = await t.gamepadInfo();
      } catch {
        gi = 'error';
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
    const seed: DemoSeed | undefined = isDemo ? (gamepad ? 'pro-xinput' : 'pro') : undefined;
    await endSession(t, seed);
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
    releaseExclusive?.();
    releaseExclusive = null;
    typed.value = '';
    riskOk.value = false;
    const mine = epoch;
    let ok = false;
    try {
      if (p && t) p.keep(t);
      if (p) for (const d of await p.list().catch(() => [])) if (d !== t) await p.release(d).catch(() => undefined);
      if (t) ok = await device.adoptFromFirmware(t, isDemo, seed).then(() => device.connected && device.transport === t, () => false);
      // set before the unlock, so the page never shows the other message
      if (!ok && mine === epoch) onNotAdopted?.();
    } finally {
      if (mine === epoch) active.value = false; // (init found a bootloader: openRescue took over)
    }
    return ok;
  }

  /** Lost during write or check: stop; wait for the keyboard to come back (in its bootloader: rescue). */
  function lost(): void {
    fail('lost', { key: 'fw.err.lost' });
    void watchForBootloader();
  }

  /** While locked without a bootloader: every new device gets one `01 02`; a Pro bootloader opens rescue mode. */
  async function watchForBootloader(): Promise<void> {
    const p = port.value;
    if (!p) return;
    const mine = epoch;
    const check = async (): Promise<void> => {
      if (mine !== epoch) return;
      for (const d of await p.list()) {
        if (!d.connected || probedHere.has(d) || d === boot) continue;
        probedHere.add(d);
        const info = await d.getDeviceInfo(FW_PROBE_TIMEOUT_MS).catch(() => null);
        if (mine !== epoch) return;
        if (info?.runMode === 255) return void openRescueOn(d, info);
      }
    };
    unsub.push(p.onConnect(() => later(0, () => void check())));
    const tick = (): void => later(1000, () => { void check().then(() => { if (mine === epoch) tick(); }); });
    tick();
  }

  // ---------------------------------------------------------------- rescue mode (DESIGN FW §3.6)

  /** device.init found a keyboard in its bootloader (`01 02` said run mode 255). Nothing more was sent to it. */
  function openRescue(t: BaseTransport, info: DeviceInfo, demo: boolean): void {
    isDemo = demo;
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
    phase.value = 'rescue';
    error.value = null;
    sent.value = 0;
    watchBoot(t);
  }

  /** "Write firmware" in rescue mode: a session on the bootloader (its own `01 02`), then the same steps. */
  async function rescueWrite(): Promise<void> {
    if (!canRescueWrite.value || !boot || !file.value?.bytes) return;
    const t = boot;
    error.value = null;
    try {
      ticket = await t.beginRescueSession(file.value.bytes, { officialOnly: officialOnly.value });
    } catch (err) {
      const reason: MessageKey = err instanceof FirmwareSessionError && err.reason === 'board' ? 'fw.why.board'
        : err instanceof FirmwareSessionError && err.reason === 'mode' ? 'fw.why.mode' : 'fw.why.file';
      error.value = { key: 'fw.err.recheck', params: { dev: '' }, paramKeys: { reason } };
      return;
    }
    total.value = sessionFile(ticket).packets;
    void runWrite();
  }

  /** "Write again from the start" (packetFail / verifyFail): same file, same bootloader connection, never `08 01` again. */
  function retry(): void {
    if ((phase.value !== 'packetFail' && phase.value !== 'verifyFail') || !boot || !ticket) return;
    void runWrite();
  }

  /** "Search again" (several bootloaders / keyboards): every device gets its `01 02` again. */
  function findAgain(): void {
    if (!ticket) return;
    fwForgetProbes(ticket);
    if (phase.value === 'manyBoot') {
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
    if (p === 'lost') {
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
    holdWindowClose(on); // the desktop app: a window close asks first (no-op on the web)
    if (on) {
      window.addEventListener('beforeunload', onBeforeUnload);
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } }).wakeLock;
        wakeLock = wl ? await wl.request('screen') : null;
      } catch {
        wakeLock = null; // not allowed: the note card still says not to let the computer sleep
      }
      if (!active.value) void releaseWake();
    } else {
      window.removeEventListener('beforeunload', onBeforeUnload);
      void releaseWake();
    }
  });

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
    sent.value = 0;
    probedHere = new WeakSet();
  }

  return {
    enabled, active, rescue, phase, file, typed, riskOk, sent, total, error, wrongDevice, rescueBoard, doneVersion, port, rows,
    known, fileOk, needsRisk, officialOnly, rescueRefused, busy, isPro, canStart, canRescueWrite, deviceBoard,
    setEnabled, chooseFile, start, allow, retry, findAgain, rescueWrite, openRescue, clear,
    /** Test hook: wait for queued microtasks of the store. */
    _sleep: sleep,
  };
});
