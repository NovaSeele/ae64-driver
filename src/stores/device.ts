// Connection, device identity, profiles, physical layout and live layer-0 legends.
import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef } from 'vue';
import {
  FIRMWARE_ROWS, GENERIC_ROWS, NoDeviceSelectedError, PHYSICAL_KEYS, TransportTimeoutError, VENDOR_ID,
  buildGenericLayout, classify, connectHid, createMockTransport, genericDisplayName, hasReceiverCollection,
  isAe64, keycodeLabel, keysFromLayoutStyles, matchesPlatform, modelName as modelLabel, modelOf,
  reconnectGrantedHid, rememberDevice, webHidAvailable,
} from '../protocol';
import { isDemoSeed, type DemoSeed } from '../protocol/mock';
import type {
  Ae64Transport, DeviceInfo, FeatureBitmap, PacketLogEntry, PhysicalKey, ProtocolVersion,
  RefusalReason, SupportLevel, TransportIdentity,
} from '../protocol';
import type { LayoutStyleEntry } from '../protocol/codec';
import type { GenericMockName, GenericMockOptions } from '../protocol/mockGeneric';
import { t as tr } from '../i18n/vi';
import { locale } from '../i18n/locale';
import { useToast } from '../components/ui/toast';
import { useCalibrationStore } from './calibration';
import { useHistoryStore } from './history';
import { useSettingsStore } from './settings';
import { useSyncStore } from './sync';
import { useFirmwareStore } from './firmware';
import { BaseTransport } from '../protocol/client';
import { TabLockedError } from '../protocol/tabLock';
import { clearCalibrationFlag, readCalibrationFlag } from '../data/calibrationFlag';
import { leaveTakenOver } from '../composables/leaveGate';

export type DeviceStatus = 'idle' | 'connecting' | 'connected' | 'error';

/** USB facts of the last refused non-AE64 connect (DESIGN MKB §5.4: "Sao chép thông tin thiết bị"). */
export interface ConnectRefusal {
  reason: RefusalReason;
  identity: TransportIdentity;
  version?: ProtocolVersion;
}

/** Per-feature unknown / note flags collected during a generic connect (DESIGN MKB §5.2, §8). */
export interface GenericUnknown {
  features: boolean;
  profiles: boolean;
  rtPrecision: boolean;
  missingLayoutRows: number[];
  layoutPadding: number[];
  layoutOverlap: boolean;
}

const emptyUnknown = (): GenericUnknown => ({
  features: false,
  profiles: false,
  rtPrecision: false,
  missingLayoutRows: [],
  layoutPadding: [],
  layoutOverlap: false,
});

/** Consecutive read timeouts that close a generic connection after the gates (DESIGN MKB §5.2). */
const GENERIC_TIMEOUT_LIMIT = 3;
const TIMEOUT_LIMIT_EXCEEDED = Symbol('genericTimeoutLimit');

const PACKET_LOG_SIZE = 200;
const LATENCY_REFRESH_MS = 250;
const PACKET_SEQ_MS = 250;
/** While connected and idle the keyboard's active profile is read this often (its P1–P4 keys switch it without telling the app). */
export const PROFILE_POLL_MS = 2000;

/**
 * Packets of a poll that the log collapses into one entry while they repeat (both the request and its reply):
 * 'travel' = live-travel axis read `04 03 …` (FAMILY.PERFORMANCE, command 0x03); 'profile' = the idle active-profile read
 * `02 03 01`; null for anything else.
 */
export function pollKind(bytes: Uint8Array | number[]): 'travel' | 'profile' | null {
  if (bytes[0] === 0x04 && bytes[1] === 0x03) return 'travel';
  if (bytes[0] === 0x02 && bytes[1] === 0x03 && bytes[2] === 0x01) return 'profile';
  return null;
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
  /** Connection support level (DESIGN MKB §3.2–§3.3); mirrors `transport.support`. */
  const support = ref<SupportLevel | undefined>(undefined);
  /** Firmware rows active on this connection: FIRMWARE_ROWS (1–5) on AE64 kinds; sorted present rows (0–5) on generic (DESIGN MKB §8.7). */
  const rows = ref<readonly number[]>([...FIRMWARE_ROWS]);
  /** Last refused non-AE64 connect (§5.4), kept while `status === 'error'` so the error panel can copy USB facts. */
  const refusal = ref<ConnectRefusal | null>(null);
  /** Per-feature unknown / layout notes from generic init (§5.2, §8). */
  const unknown = ref<GenericUnknown>(emptyUnknown());
  const boardAllowed = ref(false);
  const demo = ref(false);
  /** W-11: the last real connection was refused because the keyboard is open in another tab or window of the app. */
  const otherTab = ref(false);
  /**
   * W-12: the previous page left this keyboard calibrating and the stop sent at connect failed: writes stay refused (the
   * transport's calibration lock) until "Try again" gets a stop answered.
   */
  const staleCalibration = ref(false);
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
  /** Max or Pro (AE64 kinds only, DESIGN MKB §3.4): from the board ID in 01 02, until it is read from the transport's USB product ID. */
  const model = computed(() => {
    if (support.value === 'ae64' || support.value === 'ae64-unlisted') {
      return modelOf({ boardIdHex: info.value?.boardIdHex, productId: transport.value?.productId });
    }
    if (support.value === undefined && transport.value && isAe64(transport.value.identity)) {
      return modelOf({ boardIdHex: info.value?.boardIdHex, productId: transport.value?.productId });
    }
    return null;
  });
  const modelName = computed(() => (model.value ? modelLabel(model.value) : null));
  /** Shown name (DESIGN MKB §7): AE64 kinds keep DeviceCard's expression; generic uses the public name table / raw productName / VID:PID. */
  const displayName = computed(() => {
    const t = transport.value;
    if (support.value === 'generic' || (t && !isAe64(t.identity))) {
      return t ? genericDisplayName(t.identity, info.value?.boardIdHex, locale.value) : 'AE64';
    }
    return modelName.value ?? t?.productName ?? 'AE64';
  });
  const hidAvailable = webHidAvailable();

  /** Fixed-size ring of the newest packets, written without touching reactive state. */
  const packetRing: (PacketLogEntry | undefined)[] = markRaw(new Array(PACKET_LOG_SIZE).fill(undefined));
  let packetHead = 0;
  let packetCount = 0;
  /** The open row of each poll kind: a poll continues it while only poll rows came after it (any other packet closes both). */
  let pollRows: Record<'travel' | 'profile', PacketLogEntry | null> = { travel: null, profile: null };
  const profileListeners = new Set<() => void>();
  let detach: (() => void)[] = [];
  /** Pages that show the packet log; the timer behind `packetSeq` only runs while > 0. */
  let packetWatchers = 0;
  let packetTimer: ReturnType<typeof setInterval> | null = null;
  let packetsDirty = false;
  let latencyTimer: ReturnType<typeof setInterval> | null = null;
  let profileTimer: ReturnType<typeof setInterval> | null = null;
  /** Names of the exclusive jobs running now that gave one (a refused profile switch says what it waits for). */
  const busyWith: string[] = [];
  /**
   * Bumped on every reset: an exclusive job that started on an earlier connection must not decrement the
   * count of the current one (reset() zeroes it while that job may still be unwinding).
   */
  let session = 0;
  /** Consecutive read timeouts on a generic connection after G4 (resets on any answered read). */
  let consecutiveTimeouts = 0;
  let lastStatsRequests = 0;
  let lastStatsTimeouts = 0;
  let pendingTimeoutClose: { t: Ae64Transport; promise: Promise<void> } | null = null;

  const activeProfileName = computed(() => profileNames.value[activeProfile.value] ?? `Profile ${activeProfile.value + 1}`);

  function legend(key: PhysicalKey): string {
    const code = layer0.value[key.id];
    if (code === undefined) return key.name;
    if (support.value === 'generic') {
      if (code === 0) return key.name;
      const lbl = keycodeLabel(code);
      return lbl.group === 'unknown' ? key.name : lbl.label;
    }
    return keycodeLabel(code).label;
  }

  function resetTimeoutTracker(t?: Ae64Transport | null): void {
    consecutiveTimeouts = 0;
    lastStatsRequests = t?.stats.requests ?? 0;
    lastStatsTimeouts = t?.stats.timeouts ?? 0;
  }

  /** Closes a generic connection after GENERIC_TIMEOUT_LIMIT timeouts in a row (DESIGN MKB §5.2). */
  function closeAfterTimeouts(t: Ae64Transport): Promise<void> {
    if (pendingTimeoutClose?.t === t) return pendingTimeoutClose.promise;
    const identity = t.identity;
    const board = info.value?.boardIdHex;
    const ver = version.value;
    const name = genericDisplayName(identity, board, locale.value);
    reset();
    status.value = 'error';
    error.value = tr('error.protocolUnknown', { name });
    refusal.value = { reason: 'protocol', identity, ...(ver ? { version: ver } : {}) };
    const promise = t.close().catch(() => undefined).finally(() => {
      if (pendingTimeoutClose?.t === t) pendingTimeoutClose = null;
    });
    pendingTimeoutClose = { t, promise };
    return promise;
  }

  /** `what`: for an exclusive job, its name in "Running {what}" (a profile switch refused meanwhile). */
  async function withTransport<T>(fn: (t: Ae64Transport) => Promise<T>, opts: { exclusive?: boolean; what?: string } = {}): Promise<T> {
    const t = transport.value;
    if (!t || status.value !== 'connected') throw new Error(tr('error.notConnected'));
    const mine = session;
    const beforeTo = t.stats.timeouts;
    if (opts.exclusive) exclusiveCount.value++;
    const what = opts.exclusive ? opts.what : undefined;
    if (what) busyWith.push(what);
    try {
      // An answered read resets the generic timeout count in trackGenericIn; a call that sent nothing is not a read.
      return await fn(t);
    } catch (err) {
      if (mine === session && transport.value === t && t.support === 'generic' && err instanceof TransportTimeoutError && t.stats.timeouts === beforeTo) {
        consecutiveTimeouts++;
        if (consecutiveTimeouts >= GENERIC_TIMEOUT_LIMIT) await closeAfterTimeouts(t);
      }
      throw err;
    } finally {
      if (pendingTimeoutClose?.t === t) await pendingTimeoutClose.promise;
      if (opts.exclusive && mine === session) exclusiveCount.value = Math.max(0, exclusiveCount.value - 1);
      if (what && mine === session) {
        const i = busyWith.lastIndexOf(what);
        if (i >= 0) busyWith.splice(i, 1);
      }
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
    const map = new Map<number, number[]>();
    for (const row of rows.value) map.set(row, await t.getKeymapRow(0, row));
    layer0.value = keys.value.map((k) => map.get(k.row)?.[k.col] ?? 0);
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

  /** Updates the generic 3-consecutive-timeout counter on every `in` packet, including grouped poll replies. */
  function trackGenericIn(): void {
    const cur = transport.value;
    if (!cur || cur.support !== 'generic') return;
    if (cur.stats.requests > lastStatsRequests) {
      lastStatsRequests = cur.stats.requests;
      consecutiveTimeouts = 0;
    } else if (cur.stats.timeouts > lastStatsTimeouts) {
      lastStatsTimeouts = cur.stats.timeouts;
      consecutiveTimeouts++;
      if (consecutiveTimeouts >= GENERIC_TIMEOUT_LIMIT && status.value === 'connected') {
        void closeAfterTimeouts(cur);
      }
    }
  }

  /** `bytes` is the transport's buffer: nothing is allocated for a grouped poll, a stored row gets its own copy. */
  function handlePacket(dir: 'out' | 'in', bytes: Uint8Array, note?: string): void {
    if (dir === 'in') trackGenericIn();
    packetsDirty = true;
    const t = Date.now();
    const kind = pollKind(bytes);
    if (kind) {
      // The live view polls travel and the idle check polls the profile at the same time: each continues its own row.
      const open = pollRows[kind];
      if (open?.repeat !== undefined) {
        open.repeat++;
        open.tEnd = t;
        return;
      }
      pollRows[kind] = packetRing[packetHead] = { t, dir, bytes: Array.from(bytes), note, repeat: 1, tEnd: t };
    } else {
      packetRing[packetHead] = { t, dir, bytes: Array.from(bytes), note };
      pollRows = { travel: null, profile: null };
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
    pollRows = { travel: null, profile: null };
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
    if (profileTimer) clearInterval(profileTimer);
    profileTimer = null;
    busyWith.length = 0;
    transport.value = null;
    info.value = null;
    version.value = null;
    features.value = null;
    support.value = undefined;
    rows.value = [...FIRMWARE_ROWS];
    refusal.value = null;
    unknown.value = emptyUnknown();
    boardAllowed.value = false;
    demo.value = false;
    demoSeed.value = null;
    staleCalibration.value = false;
    keys.value = PHYSICAL_KEYS.map((k) => ({ ...k }));
    profileCount.value = 0;
    activeProfile.value = 0;
    rtPrecision.value = 0.001;
    layer0.value = [];
    profileNames.value = [];
    exclusiveCount.value = 0;
    resetTimeoutTracker();
    const lost = useSyncStore().reset();
    useHistoryStore().clear();
    return lost;
  }

  /** Clean refusal of a non-AE64 device (DESIGN MKB §5.1, §5.3, §5.4): close, record USB facts, no unhandled throw. */
  async function refuse(t: Ae64Transport, reason: RefusalReason, msg: string, ver?: ProtocolVersion): Promise<void> {
    const identity = t.identity;
    reset();
    await t.close().catch(() => undefined);
    status.value = 'error';
    error.value = msg;
    refusal.value = { reason, identity, ...(ver ? { version: ver } : {}) };
  }

  /** Gates G0–G4 and read-only view-mode init for a non-AE64 identity (DESIGN MKB §5.1–§5.3). */
  async function initGeneric(t: Ae64Transport, isDemo: boolean): Promise<void> {
    demoSeed.value = null;
    const identityName = genericDisplayName(t.identity, null, locale.value);
    // G0: wireless receiver collection — refuse before sending any command.
    if (hasReceiverCollection(t.identity)) {
      await refuse(t, 'receiver', tr('error.receiver'));
      return;
    }
    // G1: `01 02` must answer and match.
    let first: DeviceInfo;
    try {
      first = await t.getDeviceInfo();
    } catch (err) {
      if (err instanceof TransportTimeoutError) {
        await refuse(t, 'protocol', tr('error.protocolUnknown', { name: identityName }));
        return;
      }
      throw err;
    }
    const boardName = genericDisplayName(t.identity, first.boardIdHex, locale.value);
    // G2 & §5.3 (S1): run mode 255 goes to rescue ONLY when classify returns 'rescue' (1CA6 + AE64/0/FFFFFFFF board).
    if (first.runMode !== 0) {
      const modeCls = classify(t.identity, first);
      if (modeCls.ok && modeCls.support === 'rescue') {
        await handOver(t, first, isDemo);
        return;
      }
      if (!modeCls.ok && modeCls.reason === 'bootOther') {
        await refuse(t, 'bootOther', tr('error.bootOther', { name: boardName }));
        return;
      }
      await refuse(t, 'mode', tr('fw.rescue.unknownMode', { mode: first.runMode }));
      return;
    }
    // G3: board 0 / FFFFFFFF refused before sending `01 01`.
    const preVer = classify(t.identity, first, null);
    if (!preVer.ok && preVer.reason === 'protocol') {
      await refuse(t, 'protocol', tr('error.protocolUnknown', { name: identityName }));
      return;
    }
    // G4: `01 01` with main === 1 (v2 dialect).
    let ver: ProtocolVersion;
    try {
      ver = await t.getProtocolVersion();
    } catch (err) {
      if (err instanceof TransportTimeoutError) {
        await refuse(t, 'protocol', tr('error.protocolUnknown', { name: boardName }));
        return;
      }
      throw err;
    }
    const cls = classify(t.identity, first, ver);
    if (!cls.ok || cls.support !== 'generic') {
      await refuse(t, 'version', tr('error.protocolVersion', { name: boardName, version: `${ver.main}.${ver.sub}` }), ver);
      return;
    }

    t.setSupport('generic');
    support.value = t.support;
    info.value = first;
    version.value = ver;
    boardAllowed.value = t instanceof BaseTransport ? t.boardAllowed : false;
    resetTimeoutTracker(t);

    const tryRead = async <T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> => {
      const beforeTo = t.stats.timeouts;
      try {
        const value = await fn();
        consecutiveTimeouts = 0;
        lastStatsRequests = t.stats.requests;
        return { ok: true, value };
      } catch (err) {
        if (err instanceof TransportTimeoutError) {
          if (t.stats.timeouts === beforeTo) consecutiveTimeouts++;
          if (consecutiveTimeouts >= GENERIC_TIMEOUT_LIMIT) throw TIMEOUT_LIMIT_EXCEEDED;
          return { ok: false };
        }
        throw err;
      }
    };

    const unk = emptyUnknown();
    let activeAnswered = false;
    try {
      // §5.2 exact order: 1. 01 03
      const feat = await tryRead(() => t.getFeatures());
      if (feat.ok) features.value = feat.value;
      else { features.value = null; unk.features = true; }

      // 2. Profiles (R10): 02 03 00; only if 1–4: 02 03 01 then 02 03 03 p.
      const pCount = await tryRead(() => t.getProfileCount());
      if (pCount.ok && pCount.value >= 1 && pCount.value <= 4) {
        profileCount.value = pCount.value;
        const active = await tryRead(() => t.getActiveProfile());
        if (active.ok) {
          activeProfile.value = active.value;
          activeAnswered = true;
        } else {
          unk.profiles = true;
        }
        const names: string[] = [];
        for (let p = 0; p < pCount.value; p++) {
          const nameRes = await tryRead(() => t.getProfileName(p));
          names.push(nameRes.ok ? (nameRes.value || `Profile ${p + 1}`) : `Profile ${p + 1}`);
        }
        profileNames.value = names;
      } else {
        profileCount.value = 0;
        activeProfile.value = 0;
        profileNames.value = [];
        unk.profiles = true;
      }

      // 3. 02 0C 00 (RT precision): no answer / 0 -> unknown, never the AE64 `|| 0.001` fallback (S4).
      const prec = await tryRead(() => t.getRtPrecision());
      if (prec.ok && prec.value > 0) {
        rtPrecision.value = prec.value;
      } else {
        rtPrecision.value = 0;
        unk.rtPrecision = true;
      }

      // 4. 03 05 r for r = 0..5 -> generic layout builder (never PHYSICAL_KEYS).
      const styles: (LayoutStyleEntry[] | null)[] = [];
      for (const r of GENERIC_ROWS) {
        const rowStyle = await tryRead(() => t.getLayoutStyle(r));
        styles.push(rowStyle.ok ? rowStyle.value : null);
      }
      const layout = buildGenericLayout(styles);
      keys.value = layout.keys;
      rows.value = layout.rows;
      unk.missingLayoutRows = layout.missingRows;
      unk.layoutPadding = layout.layoutPadding;
      unk.layoutOverlap = layout.hasOverlap;

      // 5. 03 01 0 r for every row with at least one key.
      const l0Map = new Map<number, number[]>();
      for (const r of layout.rows) {
        const rowCodes = await tryRead(() => t.getKeymapRow(0, r));
        if (rowCodes.ok) l0Map.set(r, rowCodes.value);
      }
      layer0.value = layout.keys.map((k) => l0Map.get(k.row)?.[k.col] ?? 0);
    } catch (err) {
      if (err === TIMEOUT_LIMIT_EXCEEDED) {
        await refuse(t, 'protocol', tr('error.protocolUnknown', { name: boardName }), ver);
        return;
      }
      throw err;
    }

    unknown.value = unk;
    latencyMs.value = t.stats.lastLatencyMs;
    status.value = 'connected';
    // Poll only when 02 03 01 answered at init (R13): otherwise it would time out every 2 s and close after 3.
    if (activeAnswered) watchKeyboardProfile(t);
    if (!isDemo) rememberDevice(t.identity.vendorId, t.identity.productId);
  }

  async function init(t: Ae64Transport, isDemo: boolean): Promise<void> {
    disarmReplug();
    otherTab.value = false;
    refusal.value = null;
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
      if (!isAe64(t.identity)) {
        await initGeneric(t, isDemo);
        return;
      }
      // `01 02` first (DESIGN FW §3.3): a keyboard not running its app gets nothing else.
      const first = await t.getDeviceInfo();
      if (first.runMode !== 0) {
        await handOver(t, first, isDemo);
        return;
      }
      support.value = t.support;
      info.value = first;
      // W-12: this app put this keyboard into calibration and no stop was answered (a reload, a crash, a closed tab): `02 06 01`
      // before anything else is written, nothing committed. A flag naming another keyboard is left alone.
      const left = readCalibrationFlag();
      if (left && first.serialHex && left.serial === first.serialHex) await stopLeftCalibration(t, true);
      version.value = await t.getProtocolVersion();
      boardAllowed.value = t instanceof BaseTransport ? t.boardAllowed : false;
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
      rows.value = [...FIRMWARE_ROWS];
      await readLayer0(t);
      latencyMs.value = t.stats.lastLatencyMs;
      status.value = 'connected';
      watchKeyboardProfile(t);
      if (!isDemo) rememberDevice(t.identity.vendorId, t.productId);
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
   * W-12: `02 06 01` (no commit) to a keyboard the previous page left calibrating. Writes are refused until it is answered (the
   * transport's calibration lock, as after `02 06 00`); a failed stop keeps the flag and the lock, and says so with "Try again".
   */
  async function stopLeftCalibration(t: Ae64Transport, atConnect: boolean): Promise<boolean> {
    const serial = info.value?.serialHex ?? null;
    t.lockCalibration();
    try {
      await t.stopCalibration();
    } catch {
      if (transport.value !== t) return false;
      staleCalibration.value = true;
      useToast().show(tr('calibration.leftStopFailed'), 'error', 20000, { label: tr('calibration.leftRetry'), run: () => void retryLeftCalibration() });
      return false;
    }
    clearCalibrationFlag(serial);
    staleCalibration.value = false;
    useToast().show(tr(atConnect ? 'calibration.leftStopped' : 'calibration.leftStoppedRetry'), atConnect ? 'warn' : 'success', 8000);
    return true;
  }

  /** "Try again" after the stop at connect failed (W-12). */
  async function retryLeftCalibration(): Promise<boolean> {
    const t = transport.value;
    if (!t || !staleCalibration.value) return false;
    return withTransport((tt) => stopLeftCalibration(tt, false), { exclusive: true }).catch(() => false);
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
  let replugVendorId: number | null = null;
  let replugProductId: number | null = null;
  let replugAe64 = true;
  let replugListener: ((e: HIDConnectionEvent) => void) | null = null;

  function disarmReplug(): void {
    if (replugListener && webHidAvailable()) navigator.hid.removeEventListener('connect', replugListener);
    replugListener = null;
    replugVendorId = null;
    replugProductId = null;
  }

  function usbRestarting(): boolean {
    const state = useSettingsStore().pollingState;
    return state === 'applying' || state === 'reconnecting';
  }

  /** One 'connect' listener per lost connection: the same model plugged back in reconnects through tryAutoReconnect (DESIGN MKB §4). */
  function armReplug(vendorId: number, productId: number, ae64: boolean): void {
    disarmReplug();
    if (!webHidAvailable() || usbRestarting()) return;
    rememberDevice(vendorId, productId); // reconnectGrantedHid prefers the lost keyboard
    replugVendorId = vendorId;
    replugProductId = productId;
    replugAe64 = ae64;
    const listener = (e: HIDConnectionEvent): void => {
      if (transport.value || status.value === 'connecting' || usbRestarting()) return;
      const matched = replugAe64
        ? isAe64(e.device) && e.device.vendorId === VENDOR_ID && e.device.productId === replugProductId
        : matchesPlatform(e.device) && e.device.vendorId === replugVendorId && e.device.productId === replugProductId;
      if (!matched) return;
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
    const lostTransport = demo.value ? null : transport.value;
    const lostVendorId = lostTransport?.identity.vendorId;
    const lostProductId = lostTransport?.productId;
    const lostAe64 = lostTransport ? isAe64(lostTransport.identity) : true;
    // W-14: a polling-rate change restarts the keyboard's USB interface, which may beat the reply to `02 05 02`: that is the
    // restart the page already shows, not a lost keyboard.
    const restarting = usbRestarting();
    const lost = reset();
    status.value = 'idle';
    if (lostVendorId !== undefined && lostProductId !== undefined) armReplug(lostVendorId, lostProductId, lostAe64);
    if (restarting && lost === 0) return;
    useToast().show(lost > 0 ? tr('device.unsavedLost', { n: lost }) : tr('device.lost'), 'error');
  }

  /** `afterChange`: the chooser opens after an await, so the browser may refuse it (no user activation): back to the connect screen, not an error. */
  async function connect(opts: { afterChange?: boolean } = {}): Promise<void> {
    disarmReplug();
    status.value = 'connecting';
    error.value = null;
    refusal.value = null;
    otherTab.value = false;
    let t: Ae64Transport;
    try {
      t = await connectHid();
    } catch (err) {
      if (err instanceof TabLockedError) return lockedByOtherTab(err);
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

  /** Dev/test-only generic mock keyboard (DESIGN MKB §15); runs through `init` so the classifier decides. */
  async function connectGenericMock(name: GenericMockName, opts?: GenericMockOptions): Promise<void> {
    if (!import.meta.env.DEV) return;
    const { createGenericMock } = await import('../protocol/mockGeneric');
    await init(createGenericMock(name, opts), true);
  }

  async function tryAutoReconnect(): Promise<boolean> {
    if (!hidAvailable || transport.value || useFirmwareStore().active) return false;
    try {
      status.value = 'connecting';
      const t = await reconnectGrantedHid();
      if (!t) {
        status.value = 'idle';
        otherTab.value = false;
        return false;
      }
      await init(t, false);
      return isAe64(t.identity) ? true : connected.value || useFirmwareStore().rescue;
    } catch (err) {
      if (err instanceof TabLockedError) {
        lockedByOtherTab(err);
        return false;
      }
      if (status.value === 'connecting') status.value = 'idle';
      return false;
    }
  }

  /** W-11: the keyboard is open in another tab or window: nothing was opened or sent; "Try again" reconnects to it. */
  function lockedByOtherTab(err: TabLockedError): void {
    rememberDevice(err.vendorId, err.productId); // "Try again" (tryAutoReconnect) takes this keyboard first
    status.value = 'error';
    error.value = tr('device.otherTab');
    otherTab.value = true;
  }

  /** "Try again" after the other tab was closed (W-11): the granted keyboard, no chooser. */
  async function retryOtherTab(): Promise<boolean> {
    if (transport.value) return false;
    return tryAutoReconnect();
  }

  /**
   * `user`: the Disconnect button; refused while calibrating, and a page with an unsaved draft asks first (U-06; `asked`
   * marks the call its "Bỏ thay đổi" makes). Internal callers (polling-rate reconnect) omit it.
   */
  async function disconnect(opts: { flush?: boolean; user?: boolean; asked?: boolean } = {}): Promise<void> {
    const t = transport.value;
    if (!t) return;
    // The firmware page owns the connections while it runs (DESIGN FW §3.4): the sidebar buttons are off, this is the backstop.
    if (opts.user && useFirmwareStore().active) return;
    if (opts.user && calibrationBusy()) {
      useToast().show(tr('device.calibrating'), 'warn');
      return;
    }
    if (opts.user && !opts.asked && leaveTakenOver(() => void disconnect({ ...opts, asked: true }))) return;
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
  async function changeKeyboard(opts: { asked?: boolean } = {}): Promise<void> {
    if (!transport.value) return;
    if (!opts.asked && leaveTakenOver(() => void changeKeyboard({ asked: true }))) return;
    if (!(await readyToLeave())) return;
    const wasDemo = demo.value;
    await disconnect({ flush: false });
    if (!wasDemo) await connect({ afterChange: true });
  }

  /** The demo keyboard becomes the other model: the same gates as changeKeyboard, then a fresh init resets every per-connection store. */
  async function switchDemoModel(m: DemoSeed, opts: { asked?: boolean } = {}): Promise<void> {
    if (!demo.value || !transport.value || m === (demoSeed.value ?? model.value)) return;
    if (!opts.asked && leaveTakenOver(() => void switchDemoModel(m, { asked: true }))) return;
    if (!(await readyToLeave())) return;
    await init(createMockTransport({ seed: m }), true).then(() => { demoSeed.value = m; writeDemoModel(m); }, () => undefined);
  }

  /** Refuse a profile switch while another exclusive job (backup, restore, gamepad write, …) talks to the keyboard. */
  function refuseWhileBusy(): void {
    // The write queue's own batch is not "another job": the switch flushes (waits for) it.
    if (!exclusiveActive.value || useSyncStore().busy()) return;
    const what = busyWith[busyWith.length - 1];
    throw new Error(what ? tr('device.busyWith', { what }) : tr('device.busy'));
  }

  async function switchProfile(i: number): Promise<void> {
    if (i === activeProfile.value) return;
    if (useFirmwareStore().active) throw new Error(tr('fw.pill'));
    if (calibrationLocked()) throw new Error(tr('device.calibrating'));
    refuseWhileBusy();
    // Rejects unless every edit of the current profile reached the keyboard: never carry one across.
    await useSyncStore().flush();
    // The flush ran the queue's own exclusive batch; anything still exclusive is someone else's job.
    refuseWhileBusy();
    await withTransport(async (t) => {
      activeProfile.value = await t.setActiveProfile(i);
      await readLayer0(t);
    }, { exclusive: true });
    useHistoryStore().clear();
    useToast().show(tr('device.switched', { name: activeProfileName.value }), 'success');
    for (const cb of [...profileListeners]) cb();
  }

  /**
   * The keyboard is on profile `real`, not the one the app holds (its P1–P4 keys or another app switched it). Follow it
   * without writing anything: the unsaved edits of the profile it left are dropped, never written to `real` (`dropped`:
   * how many a running batch already dropped), undo / redo forget the old profile's steps, every page reloads, one toast.
   * `from`: the profile the caller saw; nothing happens when the app already moved on. `message`: the toast's text instead
   * of the default one (a switch noticed only after a batch wrote).
   */
  async function profileChangedOnKeyboard(real: number, dropped = 0, from = activeProfile.value, message?: string): Promise<void> {
    if (real === activeProfile.value || from !== activeProfile.value || !transport.value) return;
    const mine = session;
    activeProfile.value = real;
    const k = dropped + useSyncStore().dropProfile(from);
    useHistoryStore().clear();
    let text: string;
    if (message !== undefined) text = k > 0 ? `${message} ${tr('device.keyboardSwitchedAlsoDropped', { m: from + 1, k })}` : message;
    else text = k > 0 ? tr('device.keyboardSwitchedDropped', { n: real + 1, m: from + 1, k }) : tr('device.keyboardSwitched', { n: real + 1 });
    useToast().show(text, 'warn', message !== undefined || k > 0 ? 8000 : 4000);
    try {
      await withTransport(readLayer0);
    } catch {
      // lost meanwhile: the keycaps show their names until the next read
    }
    if (mine !== session || activeProfile.value !== real) return;
    for (const cb of [...profileListeners]) cb();
  }

  /** Connected, and nothing else talks to the keyboard: no write batch, no exclusive job, no calibration or firmware session, tab visible. */
  function idleForProfilePoll(): boolean {
    if (status.value !== 'connected' || !transport.value || exclusiveActive.value) return false;
    if (useSyncStore().busy() || calibrationBusy() || useFirmwareStore().active) return false;
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
  }

  let profileCheck: Promise<void> | null = null;
  /** Read the keyboard's active profile once (when idle) and follow it if it changed. */
  function checkKeyboardProfile(): Promise<void> {
    if (profileCheck || !idleForProfilePoll()) return profileCheck ?? Promise.resolve();
    const mine = session;
    const seen = activeProfile.value;
    const run = (async () => {
      try {
        const real = await withTransport((t) => t.getActiveProfile());
        // Anything that started meanwhile (a write batch reads it itself, a sidebar switch) wins over this read.
        if (mine !== session || activeProfile.value !== seen || !idleForProfilePoll()) return;
        if (real !== seen) await profileChangedOnKeyboard(real, 0, seen);
      } catch {
        // busy or lost: the next tick reads again
      } finally {
        profileCheck = null;
      }
    })();
    profileCheck = run;
    return run;
  }

  /** Follow the keyboard while connected: every PROFILE_POLL_MS when idle, and when the window gets focus. Undone by reset(). */
  function watchKeyboardProfile(t: Ae64Transport): void {
    if (profileTimer) clearInterval(profileTimer);
    profileTimer = setInterval(() => {
      if (transport.value === t) void checkKeyboardProfile();
    }, PROFILE_POLL_MS);
    if (typeof window !== 'undefined') {
      const onFocus = (): void => { if (transport.value === t) void checkKeyboardProfile(); };
      window.addEventListener('focus', onFocus);
      detach.push(() => window.removeEventListener('focus', onFocus));
    }
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
    transport, status, error, info, version, features, support, rows, refusal, unknown, boardAllowed, demo, otherTab, retryOtherTab, staleCalibration, retryLeftCalibration, demoSeed, keys, profileCount, activeProfile,
    profileNames, rtPrecision, layer0, latencyMs, connection, packetSeq, statsTick, exclusiveActive, connected, hidAvailable, model, modelName, displayName, packetEntries, activeProfileName,
    legend, withTransport, calibrationLocked, watchPackets, onProfileChanged, refreshLayer0, connect, connectDemo, connectGenericMock,
    tryAutoReconnect, disconnect, changeKeyboard, switchDemoModel, switchProfile, renameProfile, holdExclusive, adoptFromFirmware,
    profileChangedOnKeyboard, checkKeyboardProfile,
  };
});
