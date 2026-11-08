// Global keyboard settings (System mode, Polling rate, RGB sleep, Shake optimization, hardware info).
//
// Write sequence follows the factory driver (reference js/app/profiles.js applyChanges): system mode,
// RGB sleep and shake optimization are written directly — the firmware applies them without a
// `02 02` commit — and verified by read-back. The polling rate is special: the keyboard restarts its
// USB interface right after `02 05 02`, so it is written last, on its own, with nothing sent after it;
// the app then closes the session and reconnects once the keyboard is back.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Ae64Transport, LightingAreas } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';
import { useHistoryStore } from './history';
import { useSyncStore } from './sync';

const RECONNECT_TIMEOUT_MS = 10_000;
const RECONNECT_STEP_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

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

  const loading = ref(false);
  const loadError = ref<string | null>(null);
  let loadPromise: Promise<void> | null = null;

  async function load(): Promise<void> {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      loading.value = true;
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
          state.value = got;
          return got === v;
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
    pollingState.value = 'applying';
    try {
      await sync.flush();
      if (sync.state === 'error') throw new Error(sync.lastError ?? tr('sync.error'));
      const isDemo = device.demo;
      // The reply may or may not arrive before the USB restart; either way nothing else is sent.
      await device.withTransport((t) => t.setPollingRate(rate), { exclusive: true }).catch((err: unknown) => {
        if (isDemo) throw err;
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
    }
  }

  return {
    systemMode, pollingRate, supportedRates, rgbSleep, shakeOptimization, macroSpace, lightingAreas,
    pollingState, pollingError,
    loading, loadError, load, setSystemMode, setPollingRate, setRgbSleep, setShakeOptimization,
  };
});
