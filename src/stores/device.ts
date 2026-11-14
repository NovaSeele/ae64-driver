// Connection, device identity, profiles, physical layout and live layer-0 legends.
import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef } from 'vue';
import {
  ALLOWED_BOARDS, FIRMWARE_ROWS, NoDeviceSelectedError, PHYSICAL_KEYS, VENDOR_ID, connectHid, createMockTransport, keycodeLabel, keysFromLayoutStyles,
  isAe64, modelName as modelLabel, modelOf, reconnectGrantedHid, rememberDevice, webHidAvailable,
} from '../protocol';
import { isDemoSeed, type DemoSeed } from '../protocol/mock';
import type { Ae64Transport, DeviceInfo, FeatureBitmap, PacketLogEntry, PhysicalKey, ProtocolVersion } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useToast } from '../components/ui/toast';
import { useCalibrationStore } from './calibration';
import { useHistoryStore } from './history';
import { useSettingsStore } from './settings';
import { useSyncStore } from './sync';
import { useFirmwareStore } from './firmware';
import { BaseTransport } from '../protocol/client';

export type DeviceStatus = 'idle' | 'connecting' | 'connected' | 'error';

const PACKET_LOG_SIZE = 200;
const LATENCY_REFRESH_MS = 250;
const PACKET_SEQ_MS = 250;

/** Live-travel poll = axis data read `04 03 …` (FAMILY.PERFORMANCE, command 0x03), both the request and its reply. */
function isTravelPoll(bytes: Uint8Array): boolean {
  return bytes[0] === 0x04 && bytes[1] === 0x03;
}

const DEMO_MODEL_KEY = 'ae64.demoModel';

/** The keyboard of the last demo session (a UI pref); anything unreadable is 'max'. */
function readDemoModel(): DemoSeed {
  try {
    const v = localStorage.getItem(DEMO_MODEL_KEY);
    return isDemoSeed(v) ? v : 'max';
  } catch {
    return 'max';
  }
}

function writeDemoModel(m: DemoSeed): void {
  try {
    localStorage.setItem(DEMO_MODEL_KEY, m);
  } catch {
    // storage unavailable: the next demo starts as Max
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const useDeviceStore = defineStore('device', () => {
  const transport = shallowRef<Ae64Transport | null>(null);
  const status = ref<DeviceStatus>('idle');
  const error = ref<string | null>(null);
  const info = ref<DeviceInfo | null>(null);
  const version = ref<ProtocolVersion | null>(null);
  const features = ref<FeatureBitmap | null>(null);
  const boardAllowed = ref(false);
  const demo = ref(false);
  /** The keyboard the demo emulates ('pro-xinput': a Pro with the experimental gamepad firmware); null when not a demo. */
  const demoSeed = ref<DemoSeed | null>(null);
  const keys = shallowRef<PhysicalKey[]>(PHYSICAL_KEYS.map((k) => ({ ...k })));
  const profileCount = ref(0);
  const activeProfile = ref(0);
  const profileNames = ref<string[]>([]);
  const rtPrecision = ref(0.001);

  /** Layer-0 keycode per PhysicalKey.id for the active profile (drives keycap legends). */
  const layer0 = shallowRef<number[]>([]);
  const latencyMs = ref(0);
  /**
   * Bumped on every new connection (also demo ↔ real and the reconnect after a polling-rate change).
   * Stores holding per-profile data watch it and drop their cache: data read from another keyboard must
   * never be shown, or written back, as this one's.
   */
  const connection = ref(0);
  /** Bumped at most every PACKET_SEQ_MS while the packet log is watched and has new packets (the ring itself is not reactive). */
  const packetSeq = ref(0);
  /** Bumped every LATENCY_REFRESH_MS while connected so views of `transport.stats` re-read it. */
  const statsTick = ref(0);
  /** > 0 while an exclusive job runs; pollers (live travel, LED preview) pause while true. */
  const exclusiveCount = ref(0);
  const exclusiveActive = computed(() => exclusiveCount.value > 0);
  const connected = computed(() => status.value === 'connected');
  /** Max or Pro: from the board ID in 01 02, until it is read from the transport's USB product ID. */
  const model = computed(() => modelOf({ boardIdHex: info.value?.boardIdHex, productId: transport.value?.productId }));
  const modelName = computed(() => (model.value ? modelLabel(model.value) : null));
  const hidAvailable = webHidAvailable();

  /** Fixed-size ring of the newest packets, written without touching reactive state. */
  const packetRing: (PacketLogEntry | undefined)[] = markRaw(new Array(PACKET_LOG_SIZE).fill(undefined));
  let packetHead = 0;
  let packetCount = 0;
  let lastPacket: PacketLogEntry | null = null;
  const profileListeners = new Set<() => void>();
  let detach: (() => void)[] = [];
  /** Pages that show the packet log; the timer behind `packetSeq` only runs while > 0. */
  let packetWatchers = 0;
  let packetTimer: ReturnType<typeof setInterval> | null = null;
  let packetsDirty = false;
  let latencyTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Bumped on every reset: an exclusive job that started on an earlier connection must not decrement the
   * count of the current one (reset() zeroes it while that job may still be unwinding).
   */
  let session = 0;

  const activeProfileName = computed(() => profileNames.value[activeProfile.value] ?? `Profile ${activeProfile.value + 1}`);

  function legend(key: PhysicalKey): string {
    const code = layer0.value[key.id];
    return code === undefined ? key.name : keycodeLabel(code).label;
  }

  async function withTransport<T>(fn: (t: Ae64Transport) => Promise<T>, opts: { exclusive?: boolean } = {}): Promise<T> {
    const t = transport.value;
    if (!t || status.value !== 'connected') throw new Error(tr('error.notConnected'));
    const mine = session;
    if (opts.exclusive) exclusiveCount.value++;
    try {
      return await fn(t);
    } finally {
      if (opts.exclusive && mine === session) exclusiveCount.value = Math.max(0, exclusiveCount.value - 1);
    }
  }

  /** True while the keyboard is (or may still be) in calibration mode: only "stop calibration" may be written. */
  function calibrationLocked(): boolean {
    return transport.value?.calibrationLocked ?? false;
  }

  /** Calibration is running or the keyboard may still be in calibration mode: the user may not leave it (nothing here ever stops it). */
  function calibrationBusy(): boolean {
    return useCalibrationStore().phase !== 'idle' || calibrationLocked();
  }

  function onProfileChanged(cb: () => void): () => void {
    profileListeners.add(cb);
    return () => profileListeners.delete(cb);
  }

  async function readLayer0(t: Ae64Transport): Promise<void> {
    const rows = new Map<number, number[]>();
    for (const row of FIRMWARE_ROWS) rows.set(row, await t.getKeymapRow(0, row));
    layer0.value = keys.value.map((k) => rows.get(k.row)?.[k.col] ?? 0);
  }

  async function refreshLayer0(): Promise<void> {
    await withTransport(readLayer0);
  }

  async function readProfiles(t: Ae64Transport): Promise<void> {
    profileCount.value = await t.getProfileCount();
    activeProfile.value = await t.getActiveProfile();
    const names: string[] = [];
    for (let i = 0; i < profileCount.value; i++) names.push((await t.getProfileName(i)) || `Profile ${i + 1}`);
    profileNames.value = names;
  }

  /** `bytes` is the transport's buffer: nothing is allocated for a grouped poll, a stored row gets its own copy. */
  function handlePacket(dir: 'out' | 'in', bytes: Uint8Array, note?: string): void {
    packetsDirty = true;
    const t = Date.now();
    if (isTravelPoll(bytes)) {
      const last = lastPacket;
      if (last?.repeat !== undefined) {
        last.repeat++;
        last.tEnd = t;
        return;
      }
      lastPacket = packetRing[packetHead] = { t, dir, bytes: Array.from(bytes), note, repeat: 1, tEnd: t };
    } else {
      lastPacket = packetRing[packetHead] = { t, dir, bytes: Array.from(bytes), note };
    }
    packetHead = (packetHead + 1) % PACKET_LOG_SIZE;
    if (packetCount < PACKET_LOG_SIZE) packetCount++;
  }

  /** The recorded packets of this connection, oldest → newest (a collapsed poll group is one entry; `repeat` is live, copy it to freeze). */
  function packetEntries(): PacketLogEntry[] {
    const out: PacketLogEntry[] = [];
    const start = (packetHead - packetCount + PACKET_LOG_SIZE) % PACKET_LOG_SIZE;
    for (let i = 0; i < packetCount; i++) out.push(packetRing[(start + i) % PACKET_LOG_SIZE]!);
    return out;
  }

  function clearPackets(): void {
    packetRing.fill(undefined);
    packetHead = 0;
    packetCount = 0;
    lastPacket = null;
    packetsDirty = false;
  }

  function flushPackets(): void {
    if (!packetsDirty) return;
    packetsDirty = false;
    packetSeq.value++;
  }

  /** Let a page show the packet log: bumps `packetSeq` at most every PACKET_SEQ_MS while packets arrive. Returns the remover. */
  function watchPackets(): () => void {
    packetWatchers++;
    if (!packetTimer) packetTimer = setInterval(flushPackets, PACKET_SEQ_MS);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      packetWatchers--;
      if (packetWatchers === 0) {
        if (packetTimer) clearInterval(packetTimer);
        packetTimer = null;
        flushPackets();
      }
    };
  }

  /** Forget the connection. Returns how many unsaved edits were dropped. */
  function reset(): number {
    session++;
    detach.forEach((fn) => fn());
    detach = [];
    if (latencyTimer) clearInterval(latencyTimer);
    latencyTimer = null;
    transport.value = null;
    info.value = null;
    version.value = null;
    features.value = null;
    boardAllowed.value = false;
    demo.value = false;
    demoSeed.value = null;
    layer0.value = [];
    profileNames.value = [];
    exclusiveCount.value = 0;
    const lost = useSyncStore().reset();
    useHistoryStore().clear();
    return lost;
  }

  async function init(t: Ae64Transport, isDemo: boolean): Promise<void> {
    disarmReplug();
    // Another keyboard replaces an open one: drop its queue, history and transport before anything of the new one is read.
    const prev = transport.value;
    if (prev && prev !== t) {
      reset();
      void prev.close().catch(() => undefined);
    }
    status.value = 'connecting';
    error.value = null;
    connection.value++;
    transport.value = t;
    demo.value = isDemo;
    if (!isDemo) demoSeed.value = null;
    clearPackets();
    detach = [t.onDisconnect(handleDisconnect), t.onPacketRaw(handlePacket)];
    latencyTimer = setInterval(() => {
      if (transport.value !== t) return;
      latencyMs.value = t.stats.lastLatencyMs;
      statsTick.value++;
    }, LATENCY_REFRESH_MS);
    try {
      // `01 02` first (DESIGN FW §3.3): a keyboard not running its app gets nothing else.
      const first = await t.getDeviceInfo();
      if (first.runMode !== 0 || (t as { probeOnly?: boolean }).probeOnly) {
        await handOver(t, first, isDemo);
        return;
      }
      info.value = first;
      version.value = await t.getProtocolVersion();
      boardAllowed.value = ALLOWED_BOARDS.includes(info.value.boardIdHex);
      features.value = await t.getFeatures();
      await readProfiles(t);
      rtPrecision.value = (await t.getRtPrecision()) || 0.001;
      try {
        const styles = [];
        for (const row of FIRMWARE_ROWS) styles.push(await t.getLayoutStyle(row));
        keys.value = keysFromLayoutStyles(styles);
      } catch {
        keys.value = PHYSICAL_KEYS.map((k) => ({ ...k }));
      }
      await readLayer0(t);
      latencyMs.value = t.stats.lastLatencyMs;
      status.value = 'connected';
      if (!isDemo) rememberDevice(t.productId);
      if (!boardAllowed.value) useToast().show(tr('device.notAllowed', { board: info.value.boardIdHex.toUpperCase() }), 'warn');
    } catch (err) {
      reset();
      await t.close().catch(() => undefined);
      status.value = 'error';
      error.value = message(err);
      throw err;
    }
  }

  /**
   * A connection whose `01 02` says it is not an AE64 running its app: run mode 255 (bootloader) goes to the firmware page's
   * rescue mode; another run mode, or a device found through the PID-less probe filter that is not an AE64, is refused. Nothing
   * more is sent to it here.
   */
  async function handOver(t: Ae64Transport, first: DeviceInfo, isDemo: boolean): Promise<void> {
    reset();
    if (first.runMode === 255 && t instanceof BaseTransport) {
      status.value = 'idle';
      useFirmwareStore().openRescue(t, first, isDemo);
      return;
    }
    await t.close().catch(() => undefined);
    status.value = 'error';
    error.value = first.runMode === 0 ? tr('error.noAe64Selected') : tr('fw.rescue.unknownMode', { mode: first.runMode });
  }

  /** Keeps every poller paused (exclusiveActive) until the returned release runs, or the connection is reset. */
  function holdExclusive(): () => void {
    const mine = session;
    exclusiveCount.value++;
    let done = false;
    return () => {
      if (done) return;
      done = true;
      if (mine === session) exclusiveCount.value = Math.max(0, exclusiveCount.value - 1);
    };
  }

  /**
   * The firmware page hands a keyboard back (DESIGN FW §3.3): a new connection whatever came before (sync and undo history
   * empty, everything read again), `init` once.
   */
  async function adoptFromFirmware(t: Ae64Transport, isDemo: boolean, seed?: DemoSeed): Promise<void> {
    const prev = transport.value;
    reset();
    if (prev && prev !== t) void prev.close().catch(() => undefined);
    await init(t, isDemo);
    if (isDemo && seed) {
      demoSeed.value = seed;
      writeDemoModel(seed);
    }
  }

  /** The keyboard that was unplugged while connected; set only for a lost real connection, until it is replugged or anything else connects. */
  let replugProductId: number | null = null;
  let replugListener: ((e: HIDConnectionEvent) => void) | null = null;

  function disarmReplug(): void {
    if (replugListener && webHidAvailable()) navigator.hid.removeEventListener('connect', replugListener);
    replugListener = null;
    replugProductId = null;
  }

  function usbRestarting(): boolean {
    const state = useSettingsStore().pollingState;
    return state === 'applying' || state === 'reconnecting';
  }

  /** One 'connect' listener per lost connection: the same model plugged back in reconnects through tryAutoReconnect. */
  function armReplug(productId: number): void {
    disarmReplug();
    if (!webHidAvailable() || usbRestarting()) return;
    rememberDevice(productId); // reconnectGrantedHid prefers the lost keyboard
    replugProductId = productId;
    const listener = (e: HIDConnectionEvent): void => {
      if (transport.value || status.value === 'connecting' || usbRestarting()) return;
      if (!isAe64(e.device) || e.device.vendorId !== VENDOR_ID || e.device.productId !== replugProductId) return;
      void tryAutoReconnect();
    };
    replugListener = listener;
    navigator.hid.addEventListener('connect', listener);
  }

  function handleDisconnect(): void {
    // A firmware session expects the keyboard to leave USB: no reset, no toast, no replug (it finds the keyboard itself).
    if (useFirmwareStore().active) {
      detach.forEach((fn) => fn());
      detach = [];
      return;
    }
    const lostProductId = demo.value ? undefined : transport.value?.productId;
    const lost = reset();
    status.value = 'idle';
    if (lostProductId !== undefined) armReplug(lostProductId);
    useToast().show(lost > 0 ? tr('device.unsavedLost', { n: lost }) : tr('device.lost'), 'error');
  }

  /** `afterChange`: the chooser opens after an await, so the browser may refuse it (no user activation): back to the connect screen, not an error. */
  async function connect(opts: { afterChange?: boolean } = {}): Promise<void> {
    disarmReplug();
    status.value = 'connecting';
    error.value = null;
    let t: Ae64Transport;
    try {
      t = await connectHid();
    } catch (err) {
      // Closing the chooser without picking a device is not an error worth showing.
      const cancelled = err instanceof NoDeviceSelectedError
        || (err instanceof DOMException && (err.name === 'NotFoundError' || (opts.afterChange && err.name === 'SecurityError')));
      status.value = cancelled ? 'idle' : 'error';
      error.value = cancelled ? null : message(err);
      return;
    }
    await init(t, false).catch(() => undefined);
  }

  /** Without a seed: the keyboard of the last demo session. */
  async function connectDemo(seed?: DemoSeed): Promise<void> {
    const model = seed ?? readDemoModel();
    await init(createMockTransport({ seed: model }), true);
    demoSeed.value = model;
    writeDemoModel(model);
  }

  async function tryAutoReconnect(): Promise<boolean> {
    if (!hidAvailable || transport.value || useFirmwareStore().active) return false;
    try {
      status.value = 'connecting';
      const t = await reconnectGrantedHid();
      if (!t) {
        status.value = 'idle';
        return false;
      }
      await init(t, false);
      return true;
    } catch {
      if (status.value === 'connecting') status.value = 'idle';
      return false;
    }
  }

  /** `user`: the Disconnect button; refused while calibrating. Internal callers (polling-rate reconnect) omit it. */
  async function disconnect(opts: { flush?: boolean; user?: boolean } = {}): Promise<void> {
    const t = transport.value;
    if (!t) return;
    // The firmware page owns the connections while it runs (DESIGN FW §3.4): the sidebar buttons are off, this is the backstop.
    if (opts.user && useFirmwareStore().active) return;
    if (opts.user && calibrationBusy()) {
      useToast().show(tr('device.calibrating'), 'warn');
      return;
    }
    disarmReplug();
    if (opts.flush !== false) await useSyncStore().flush().catch(() => undefined);
    reset();
    status.value = 'idle';
    await t.close().catch(() => undefined);
  }

  /** True when the keyboard may be left: not calibrating, and every edit was saved (otherwise a toast says why and the connection stays). */
  async function readyToLeave(): Promise<boolean> {
    if (useFirmwareStore().active) return false;
    if (calibrationBusy()) {
      useToast().show(tr('device.calibrating'), 'warn');
      return false;
    }
    const sync = useSyncStore();
    let saved = true;
    try {
      await sync.flush();
    } catch {
      saved = false;
    }
    if (!saved || sync.state === 'error') {
      useToast().show(tr('device.changeBlocked'), 'warn');
      return false;
    }
    return true;
  }

  /**
   * Back to the connect screen to pick another keyboard (a real one opens the chooser at once). Unsaved edits are
   * flushed first; if they cannot be saved the connection stays, so none is lost or sent to the other keyboard.
   */
  async function changeKeyboard(): Promise<void> {
    if (!transport.value || !(await readyToLeave())) return;
    const wasDemo = demo.value;
    await disconnect({ flush: false });
    if (!wasDemo) await connect({ afterChange: true });
  }

  /** The demo keyboard becomes the other model: the same gates as changeKeyboard, then a fresh init resets every per-connection store. */
  async function switchDemoModel(m: DemoSeed): Promise<void> {
    if (!demo.value || !transport.value || m === (demoSeed.value ?? model.value) || !(await readyToLeave())) return;
    await init(createMockTransport({ seed: m }), true).then(() => { demoSeed.value = m; writeDemoModel(m); }, () => undefined);
  }

  async function switchProfile(i: number): Promise<void> {
    if (i === activeProfile.value) return;
    if (useFirmwareStore().active) throw new Error(tr('fw.pill'));
    if (calibrationLocked()) throw new Error(tr('device.calibrating'));
    // Rejects unless every edit of the current profile reached the keyboard: never carry one across.
    await useSyncStore().flush();
    await withTransport(async (t) => {
      activeProfile.value = await t.setActiveProfile(i);
      await readLayer0(t);
    }, { exclusive: true });
    useHistoryStore().clear();
    useToast().show(tr('device.switched', { name: activeProfileName.value }), 'success');
    for (const cb of [...profileListeners]) cb();
  }

  async function renameProfile(i: number, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || trimmed === profileNames.value[i]?.trim()) return;
    const verified = await withTransport(async (t) => {
      await t.setProfileName(i, trimmed);
      return t.getProfileName(i);
    });
    profileNames.value = profileNames.value.map((n, idx) => (idx === i ? verified : n));
    useToast().show(tr('device.renamed', { name: verified }), 'success');
  }

  return {
    transport, status, error, info, version, features, boardAllowed, demo, demoSeed, keys, profileCount, activeProfile,
    profileNames, rtPrecision, layer0, latencyMs, connection, packetSeq, statsTick, exclusiveActive, connected, hidAvailable, model, modelName, packetEntries, activeProfileName,
    legend, withTransport, calibrationLocked, watchPackets, onProfileChanged, refreshLayer0, connect, connectDemo,
    tryAutoReconnect, disconnect, changeKeyboard, switchDemoModel, switchProfile, renameProfile, holdExclusive, adoptFromFirmware,
  };
});
