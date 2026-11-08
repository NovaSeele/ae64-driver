// Connection, device identity, profiles, physical layout and live layer-0 legends.
import { defineStore } from 'pinia';
import { computed, markRaw, ref, shallowRef } from 'vue';
import {
  ALLOWED_BOARDS, FIRMWARE_ROWS, NoDeviceSelectedError, PHYSICAL_KEYS, connectHid, createMockTransport, keycodeLabel, keysFromLayoutStyles,
  reconnectGrantedHid, webHidAvailable,
} from '../protocol';
import type { Ae64Transport, DeviceInfo, FeatureBitmap, PacketLogEntry, PhysicalKey, ProtocolVersion } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useToast } from '../components/ui/toast';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';

export type DeviceStatus = 'idle' | 'connecting' | 'connected' | 'error';

const PACKET_LOG_SIZE = 200;
const LATENCY_REFRESH_MS = 250;
const PACKET_SEQ_MS = 250;

/** Live-travel poll = axis data read `04 03 …` (FAMILY.PERFORMANCE, command 0x03), both the request and its reply. */
function isTravelPoll(bytes: Uint8Array): boolean {
  return bytes[0] === 0x04 && bytes[1] === 0x03;
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
    layer0.value = [];
    profileNames.value = [];
    exclusiveCount.value = 0;
    const lost = useSyncStore().reset();
    useHistoryStore().clear();
    return lost;
  }

  async function init(t: Ae64Transport, isDemo: boolean): Promise<void> {
    status.value = 'connecting';
    error.value = null;
    connection.value++;
    transport.value = t;
    demo.value = isDemo;
    clearPackets();
    detach = [t.onDisconnect(handleDisconnect), t.onPacketRaw(handlePacket)];
    latencyTimer = setInterval(() => {
      if (transport.value !== t) return;
      latencyMs.value = t.stats.lastLatencyMs;
      statsTick.value++;
    }, LATENCY_REFRESH_MS);
    try {
      version.value = await t.getProtocolVersion();
      info.value = await t.getDeviceInfo();
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
      if (!boardAllowed.value) useToast().show(tr('device.notAllowed', { board: info.value.boardIdHex.toUpperCase() }), 'warn');
    } catch (err) {
      reset();
      await t.close().catch(() => undefined);
      status.value = 'error';
      error.value = message(err);
      throw err;
    }
  }

  function handleDisconnect(): void {
    const lost = reset();
    status.value = 'idle';
    useToast().show(lost > 0 ? tr('device.unsavedLost', { n: lost }) : tr('device.lost'), 'error');
  }

  async function connect(): Promise<void> {
    status.value = 'connecting';
    error.value = null;
    let t: Ae64Transport;
    try {
      t = await connectHid();
    } catch (err) {
      // Closing the chooser without picking a device is not an error worth showing.
      const cancelled = err instanceof NoDeviceSelectedError || (err instanceof DOMException && err.name === 'NotFoundError');
      status.value = cancelled ? 'idle' : 'error';
      error.value = cancelled ? null : message(err);
      return;
    }
    await init(t, false).catch(() => undefined);
  }

  async function connectDemo(): Promise<void> {
    await init(createMockTransport({ seed: 'max' }), true);
  }

  async function tryAutoReconnect(): Promise<boolean> {
    if (!hidAvailable || transport.value) return false;
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

  async function disconnect(opts: { flush?: boolean } = {}): Promise<void> {
    const t = transport.value;
    if (!t) return;
    if (opts.flush !== false) await useSyncStore().flush().catch(() => undefined);
    reset();
    status.value = 'idle';
    await t.close().catch(() => undefined);
  }

  async function switchProfile(i: number): Promise<void> {
    if (i === activeProfile.value) return;
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
    if (!trimmed || trimmed === profileNames.value[i]) return;
    const verified = await withTransport(async (t) => {
      await t.setProfileName(i, trimmed);
      return t.getProfileName(i);
    });
    profileNames.value = profileNames.value.map((n, idx) => (idx === i ? verified : n));
    useToast().show(tr('device.renamed', { name: verified }), 'success');
  }

  return {
    transport, status, error, info, version, features, boardAllowed, demo, keys, profileCount, activeProfile,
    profileNames, rtPrecision, layer0, latencyMs, connection, packetSeq, statsTick, exclusiveActive, connected, hidAvailable, packetEntries, activeProfileName,
    legend, withTransport, calibrationLocked, watchPackets, onProfileChanged, refreshLayer0, connect, connectDemo,
    tryAutoReconnect, disconnect, switchProfile, renameProfile,
  };
});
