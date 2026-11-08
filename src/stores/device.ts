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
  /** > 0 while an exclusive job runs; pollers (live travel, LED preview) pause while true. */
  const exclusiveCount = ref(0);
  const exclusiveActive = computed(() => exclusiveCount.value > 0);
  const connected = computed(() => status.value === 'connected');
  const hidAvailable = webHidAvailable();

  const packetLog: PacketLogEntry[] = markRaw([]);
  const profileListeners = new Set<() => void>();
  let detach: (() => void)[] = [];
  let lastLatencyAt = 0;

  const activeProfileName = computed(() => profileNames.value[activeProfile.value] ?? `Profile ${activeProfile.value + 1}`);

  function legend(key: PhysicalKey): string {
    const code = layer0.value[key.id];
    return code === undefined ? key.name : keycodeLabel(code).label;
  }

  async function withTransport<T>(fn: (t: Ae64Transport) => Promise<T>, opts: { exclusive?: boolean } = {}): Promise<T> {
    const t = transport.value;
    if (!t || status.value !== 'connected') throw new Error(tr('error.notConnected'));
    if (opts.exclusive) exclusiveCount.value++;
    try {
      return await fn(t);
    } finally {
      if (opts.exclusive) exclusiveCount.value--;
    }
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

  function handlePacket(e: PacketLogEntry): void {
    packetLog.push(e);
    if (packetLog.length > PACKET_LOG_SIZE) packetLog.splice(0, packetLog.length - PACKET_LOG_SIZE);
    const now = performance.now();
    if (e.dir === 'in' && transport.value && now - lastLatencyAt > LATENCY_REFRESH_MS) {
      lastLatencyAt = now;
      latencyMs.value = transport.value.stats.lastLatencyMs;
    }
  }

  function reset(): void {
    detach.forEach((fn) => fn());
    detach = [];
    transport.value = null;
    info.value = null;
    version.value = null;
    features.value = null;
    boardAllowed.value = false;
    demo.value = false;
    layer0.value = [];
    profileNames.value = [];
    exclusiveCount.value = 0;
    useSyncStore().reset();
    useHistoryStore().clear();
  }

  async function init(t: Ae64Transport, isDemo: boolean): Promise<void> {
    status.value = 'connecting';
    error.value = null;
    transport.value = t;
    demo.value = isDemo;
    detach = [t.onPacket(handlePacket), t.onDisconnect(handleDisconnect)];
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
    reset();
    status.value = 'idle';
    useToast().show(tr('device.lost'), 'error');
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

  async function disconnect(): Promise<void> {
    const t = transport.value;
    if (!t) return;
    await useSyncStore().flush().catch(() => undefined);
    reset();
    status.value = 'idle';
    await t.close().catch(() => undefined);
  }

  async function switchProfile(i: number): Promise<void> {
    if (i === activeProfile.value) return;
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
    profileNames, rtPrecision, layer0, latencyMs, exclusiveActive, connected, hidAvailable, packetLog, activeProfileName,
    legend, withTransport, onProfileChanged, refreshLayer0, connect, connectDemo, tryAutoReconnect, disconnect,
    switchProfile, renameProfile,
  };
});
