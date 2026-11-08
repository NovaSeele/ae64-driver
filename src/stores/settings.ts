// Global keyboard settings (System mode, Polling rate, RGB sleep, Shake optimization, hardware info).
//
// Write sequence follows the factory driver (reference js/app/profiles.js applyChanges): system mode,
// RGB sleep and shake optimization are written directly — the firmware applies them without a
// `02 02` commit — and verified by read-back. The polling rate is special: the keyboard restarts its
// USB interface right after `02 05 02`, so it is written last, on its own, with nothing sent after it;
// the app then closes the session and reconnects once the keyboard is back.
import { defineStore } from 'pinia';
import { ref, watch } from 'vue';
import { UnsafeCommandError, WriteNotAllowedError } from '../protocol';
import type { Ae64Transport, LightingAreas } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';

const RECONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_STEP_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The keyboard stores profile names as UTF-8 truncated to this many bytes (codec.encodeProfileName). */
export const PROFILE_NAME_MAX_BYTES = 32;

export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Longest prefix of `s` that fits in `maxBytes` of UTF-8, never splitting a character. */
export function truncateUtf8(s: string, maxBytes: number): string {
  let used = 0;
  let out = '';
  for (const ch of s) {
    const n = utf8Bytes(ch);
    if (used + n > maxBytes) break;
    used += n;
    out += ch;
  }
  return out;
}

export type PollingRateState = 'idle' | 'applying' | 'reconnecting' | 'error';

export const useSettingsStore = defineStore('settings', () => {
  const device = useDeviceStore();
  const history = useHistoryStore();
  const sync = useSyncStore();

  const systemMode = ref<number>(0); // 0 = Windows, 1 = macOS
  const pollingRate = ref<number>(0); // 0=8000Hz ... 5=250Hz
  const supportedRates = ref<number[]>([0, 1, 2, 3, 4, 5]);
  const rgbSleep = ref<number>(10); // minutes (0 = disabled / always on)
  const shakeOptimization = ref<boolean>(false);
  const macroSpace = ref<{ count: number; capacity: number }>({ count: 16, capacity: 960 });
  const lightingAreas = ref<LightingAreas | null>(null);
  const pollingState = ref<PollingRateState>('idle');
  const pollingError = ref<string | null>(null);
  /** Rate being applied while pollingState is applying/reconnecting (the UI shows it as pending). */
  const pollingTarget = ref<number | null>(null);

  const loading = ref(false);
  /** True once the values above were read from the connected keyboard (not the built-in defaults). */
  const loaded = ref(false);
  const loadError = ref<string | null>(null);
  let loadPromise: Promise<void> | null = null;
  /** Last value of each undoable setting read from the keyboard (load or verify): what a dropped write puts back. */
  const boardValue = new Map<string, unknown>();

  // New connection: the defaults above are not this keyboard's values until load() has run.
  watch(() => device.transport, () => { loaded.value = false; loadError.value = null; boardValue.clear(); });
  // A failed polling change is only worth showing until the keyboard is connected again.
  watch(() => device.connected, (c) => {
    if (c && pollingState.value === 'error') { pollingState.value = 'idle'; pollingError.value = null; }
  });

  async function load(): Promise<void> {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      loading.value = true;
      loaded.value = false;
      loadError.value = null;
      try {
        await device.withTransport(async (t) => {
          systemMode.value = await t.getSystemMode();
          try {
            const rates = await t.getPollingRates();
            if (rates.length) supportedRates.value = rates;
          } catch {
            supportedRates.value = [0, 1, 2, 3, 4, 5];
          }
          pollingRate.value = await t.getPollingRate();
          rgbSleep.value = await t.getRgbSleep();
          shakeOptimization.value = await t.getShakeOptimization();
          macroSpace.value = await t.getMacroSpace();
          lightingAreas.value = await t.getLightingAreas();
        });
        boardValue.set('systemMode', systemMode.value);
        boardValue.set('rgbSleep', rgbSleep.value);
        boardValue.set('shakeOptimization', shakeOptimization.value);
        loaded.value = true;
      } catch (err) {
        loadError.value = err instanceof Error ? err.message : String(err);
      } finally {
        loading.value = false;
        loadPromise = null;
      }
    })();
    return loadPromise;
  }

  /** One undoable global setting: optimistic state, a sync job without commit, read-back verify. */
  function setting<T>(
    key: string,
    label: () => string,
    state: { value: T },
    write: (t: Ae64Transport, v: T) => Promise<void>,
    read: (t: Ae64Transport) => Promise<T>,
  ) {
    function apply(v: T): void {
      state.value = v;
      sync.enqueue({
        key: `settings:${key}`,
        label: label(),
        write: (t) => write(t, v),
        verify: async (t) => {
          const got = await read(t);
          boardValue.set(key, got);
          state.value = got;
          return got === v;
        },
        // Not saved: show what the keyboard really has, unless a newer change is already showing.
        onDrop: () => {
          if (state.value !== v) return;
          if (boardValue.has(key)) state.value = boardValue.get(key) as T;
          else loaded.value = false; // never read: the Settings page reloads
        },
      });
    }
    return (v: T): void => {
      const prev = state.value;
      if (prev === v) return;
      apply(v);
      history.push({ label: label(), undo: () => apply(prev), redo: () => apply(v) });
    };
  }

  const setSystemMode = setting('systemMode', () => tr('settings.systemMode'), systemMode,
    (t, v) => t.setSystemMode(v), (t) => t.getSystemMode());
  const setRgbSleep = setting('rgbSleep', () => tr('settings.rgbSleep'), rgbSleep,
    (t, v) => t.setRgbSleep(v), (t) => t.getRgbSleep());
  const setShakeOptimization = setting('shakeOptimization', () => tr('settings.shakeOptimization'), shakeOptimization,
    (t, v) => t.setShakeOptimization(v), (t) => t.getShakeOptimization());

  /**
   * Change the polling rate. Not undoable and not queued: pending writes are flushed first, then
   * `02 05 02` is the last command of the session. The keyboard re-enumerates; we close and reconnect.
   */
  async function setPollingRate(rate: number): Promise<void> {
    if (rate === pollingRate.value || pollingState.value === 'applying' || pollingState.value === 'reconnecting') return;
    if (!supportedRates.value.includes(rate)) return;
    pollingError.value = null;
    pollingTarget.value = rate;
    pollingState.value = 'applying';
    try {
      await sync.flush();
      if (sync.state === 'error') throw new Error(sync.lastError ?? tr('sync.error'));
      const isDemo = device.demo;
      // The reply may or may not arrive before the USB restart; either way nothing else is sent.
      await device.withTransport((t) => t.setPollingRate(rate), { exclusive: true }).catch((err: unknown) => {
        // Refused before anything was sent (safety guard, read-only board): nothing to reconnect.
        if (isDemo || err instanceof UnsafeCommandError || err instanceof WriteNotAllowedError) throw err;
        // Otherwise the USB restart may have beaten the reply: carry on and reconnect.
      });
      if (isDemo) {
        pollingRate.value = await device.withTransport((t) => t.getPollingRate());
        pollingState.value = 'idle';
        return;
      }
      pollingState.value = 'reconnecting';
      await device.disconnect({ flush: false });
      const until = Date.now() + RECONNECT_TIMEOUT_MS;
      await sleep(1000);
      while (Date.now() < until) {
        if (await device.tryAutoReconnect()) break;
        await sleep(RECONNECT_STEP_MS);
      }
      if (!device.connected) throw new Error(tr('settings.pollingReconnectFailed'));
      await load();
      pollingState.value = pollingRate.value === rate ? 'idle' : 'error';
      if (pollingState.value === 'error') pollingError.value = tr('sync.verifyFailed', { labels: tr('settings.pollingRate') });
    } catch (err) {
      pollingState.value = 'error';
      pollingError.value = err instanceof Error ? err.message : String(err);
    } finally {
      pollingTarget.value = null;
    }
  }

  return {
    systemMode, pollingRate, supportedRates, rgbSleep, shakeOptimization, macroSpace, lightingAreas,
    pollingState, pollingError, pollingTarget,
    loading, loaded, loadError, load, setSystemMode, setPollingRate, setRgbSleep, setShakeOptimization,
  };
});
