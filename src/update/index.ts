import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useDeviceStore } from '../stores/device';
import { useCalibrationStore } from '../stores/calibration';
import { useSyncStore } from '../stores/sync';
import { useFirmwareStore } from '../stores/firmware';
import { t as tr } from '../i18n/vi';
import { isNewerVersion } from './version';

export * from './version';
export { installChunkGuard, isChunkLoadError } from './chunkGuard';

export type UpdateState = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'deferred' | 'error';

export interface AvailableVersion {
  version: string;
  builtAt: string;
}

/** The desktop app never updates itself: the user installs a newer setup.exe. */
export const DESKTOP = typeof __DESKTOP__ !== 'undefined' && __DESKTOP__;

/** Minimum interval between quiet background update checks (30 minutes). */
export const QUIET_CHECK_MIN_MS = 30 * 60 * 1000;
const QUIET_CHECK_DELAY_MS = 10_000;
const QUIET_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export function registerServiceWorker(): void {
  if (DESKTOP || !import.meta.env.PROD || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  // After `load` and when idle: the first visit's precache must not compete with the page's own chunks and font.
  const register = () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('ServiceWorker registration failed:', err);
    });
  };
  const whenIdle = () => {
    if ('requestIdleCallback' in window) window.requestIdleCallback(register, { timeout: 3000 });
    else setTimeout(register, 0);
  };
  if (document.readyState === 'complete') whenIdle();
  else window.addEventListener('load', whenIdle, { once: true });
  announceVersion(navigator.serviceWorker);
}

/**
 * WX7 4a: tell the worker which release this window runs, now and whenever a worker takes control of it. The worker
 * keeps that release's cache while the window is open, so its lazy chunks still load after a newer release is applied.
 */
export function announceVersion(sw: Pick<ServiceWorkerContainer, 'controller' | 'addEventListener'>, version: string = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''): void {
  if (!version) return;
  const hello = () => {
    try {
      sw.controller?.postMessage({ type: 'hello', version });
    } catch {
      // no worker to tell: nothing is pruned without it either
    }
  };
  hello();
  sw.addEventListener('controllerchange', hello);
}

export const useUpdateStore = defineStore('update', () => {
  const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  const state = ref<UpdateState>('idle');
  const availableInfo = ref<AvailableVersion | null>(null);
  /** True only when `checkQuietly()` moved the state to `available` (drives the one-shot screen-reader announcement). */
  const foundQuietly = ref(false);
  const error = ref<string | null>(null);
  /** Version downloaded but not yet applied (state 'deferred'). */
  const deferredVersion = ref('');
  /** The state 'error' came from Update (download), not from a check. */
  const applyFailed = ref(false);
  /** WX7 4a: a part of the app did not load (a newer release replaced this one): the page says so, the user reloads. */
  const chunkFailed = ref(false);
  function noteChunkFailed(): void {
    chunkFailed.value = true;
  }

  /** Why the page must not reload now (a reload mid-write or mid-calibration can leave the keyboard half-written). */
  const busyReason = computed<string | null>(() => {
    const device = useDeviceStore();
    const calibration = useCalibrationStore();
    // A firmware session (or rescue mode): a reload would cut the write or lose the bootloader (DESIGN FW §3.4).
    if (useFirmwareStore().active) return tr('update.busyFirmware');
    if (device.exclusiveActive) return tr('update.busyWrite');
    if (calibration.phase !== 'idle' || device.calibrationLocked()) return tr('update.busyCalibration');
    return null;
  });

  async function postSwMessage<T>(msg: { type: string; version?: string }, timeoutMs = 15000): Promise<T> {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) {
      throw new Error('ServiceWorker not supported');
    }
    let controller = navigator.serviceWorker.controller;
    if (!controller) {
      try {
        await Promise.race([
          navigator.serviceWorker.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('SW ready timeout')), 2000)),
        ]);
        controller = navigator.serviceWorker.controller;
      } catch {
        // fall through
      }
    }
    if (!controller) {
      throw new Error('No active ServiceWorker controller');
    }

    return new Promise<T>((resolve, reject) => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => {
        channel.port1.close();
        reject(new Error('ServiceWorker message timed out'));
      }, timeoutMs);

      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        resolve(event.data as T);
      };

      controller.postMessage(msg, [channel.port2]);
    });
  }

  async function lookupLatest(): Promise<AvailableVersion | null> {
    const hasSw =
      typeof navigator !== 'undefined' &&
      'serviceWorker' in navigator &&
      Boolean(navigator.serviceWorker.controller);

    if (hasSw) {
      interface CheckReply {
        ok: boolean;
        current?: string;
        latest?: string;
        builtAt?: string;
        available?: boolean;
        error?: string;
      }
      const reply = await postSwMessage<CheckReply>({ type: 'check' });
      if (!reply.ok) {
        throw new Error(reply.error || 'Failed to check for updates');
      }
      if (reply.available && reply.latest && isNewerVersion(reply.latest, currentVersion)) {
        return {
          version: reply.latest,
          builtAt: reply.builtAt || '',
        };
      }
      return null;
    }

    // No SW controller (e.g. dev server or unsupported browser): fetch release.json directly
    const res = await fetch('/release.json', { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(`Failed to fetch release.json (${res.status})`);
    }
    const data = await res.json();
    const latest = data.version;
    if (latest && isNewerVersion(latest, currentVersion)) {
      return {
        version: latest,
        builtAt: data.builtAt || '',
      };
    }
    return null;
  }

  let checkEpoch = 0;

  async function check(): Promise<void> {
    if (DESKTOP) return;
    checkEpoch++;
    foundQuietly.value = false;
    state.value = 'checking';
    error.value = null;
    applyFailed.value = false;

    try {
      const next = await lookupLatest();
      if (next) {
        state.value = 'available';
        availableInfo.value = next;
      } else {
        state.value = 'upToDate';
        availableInfo.value = null;
      }
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  let lastQuietCheckAt = -Infinity;

  async function checkQuietly(): Promise<void> {
    if (DESKTOP) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const startState = state.value;
    if (startState !== 'idle' && startState !== 'upToDate' && !(startState === 'error' && !applyFailed.value)) return;
    const now = Date.now();
    if (now - lastQuietCheckAt < QUIET_CHECK_MIN_MS) return;
    lastQuietCheckAt = now;
    const epoch = checkEpoch;

    try {
      const next = await lookupLatest();
      if (checkEpoch !== epoch || state.value !== startState) return;
      if (next) {
        state.value = 'available';
        availableInfo.value = next;
        error.value = null;
        foundQuietly.value = true;
      } else if (startState === 'error') {
        state.value = 'upToDate';
        error.value = null;
      }
    } catch {
      // Quiet check: ignore network, SW timeout, or bad JSON without touching user-facing state.
    }
  }

  function startQuietChecks(): () => void {
    if (DESKTOP || typeof document === 'undefined') return () => {};
    const firstTimer = setTimeout(() => {
      void checkQuietly();
    }, QUIET_CHECK_DELAY_MS);
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        void checkQuietly();
      }
    }, QUIET_CHECK_INTERVAL_MS);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void checkQuietly();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(firstTimer);
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  /** Checked fresh (the computed may cache device.calibrationLocked(), which is not reactive). */
  function busyNow(): string | null {
    const device = useDeviceStore();
    if (useFirmwareStore().active) return tr('update.busyFirmware');
    if (device.exclusiveActive) return tr('update.busyWrite');
    if (useCalibrationStore().phase !== 'idle' || device.calibrationLocked()) return tr('update.busyCalibration');
    return null;
  }

  /** The user chose to reload now (after a deferred update). Never called by the app itself. */
  async function reloadNow(): Promise<void> {
    if (busyNow() || typeof window === 'undefined') return;
    try {
      await useSyncStore().flush(); // queued edits reach the keyboard before the page goes away
    } catch {
      return; // not saved: stay, the sync pill shows why
    }
    if (busyNow()) return;
    window.location.reload();
  }

  async function apply(): Promise<void> {
    checkEpoch++;
    foundQuietly.value = false;
    const sync = useSyncStore();
    const busy = busyNow;
    /** Re-checked right before reloading: the download can take a while and the user keeps working meanwhile. */
    const readyToReload = async (): Promise<boolean> => {
      let why = busy();
      if (!why) {
        try {
          await sync.flush();
          why = busy();
        } catch (err) {
          why = err instanceof Error ? err.message : String(err);
        }
      }
      if (!why) return true;
      // Downloaded but not applied: not a failure; the user reloads when ready.
      state.value = 'deferred';
      deferredVersion.value = availableInfo.value?.version ?? '';
      error.value = null;
      return false;
    };

    const why = busy();
    if (why) {
      // Refused before downloading: a notice, not an error (the update stays available).
      state.value = 'available';
      error.value = why;
      return;
    }

    const offeredVersion = availableInfo.value?.version;
    if (!offeredVersion) {
      state.value = 'error';
      error.value = 'No update available to apply';
      return;
    }

    state.value = 'downloading';
    error.value = null;
    applyFailed.value = false;

    try {
      await sync.flush();
    } catch (err) {
      state.value = 'error';
      applyFailed.value = true;
      error.value = err instanceof Error ? err.message : String(err);
      return;
    }

    try {
      const hasSw =
        typeof navigator !== 'undefined' &&
        'serviceWorker' in navigator &&
        Boolean(navigator.serviceWorker.controller);

      if (hasSw) {
        interface ApplyReply {
          ok: boolean;
          version?: string;
          error?: string;
        }
        const reply = await postSwMessage<ApplyReply>(
          { type: 'apply', version: offeredVersion },
          120000
        );
        if (!reply.ok) {
          throw new Error(reply.error || 'Failed to apply update');
        }
        if (!(await readyToReload())) return;
        if (typeof window !== 'undefined') {
          window.location.reload();
        }
      } else {
        // Without service worker: reload, after the same check as above (the user kept working meanwhile).
        if (!(await readyToReload())) return;
        if (typeof window !== 'undefined') {
          window.location.reload();
        }
      }
    } catch (err) {
      // The worker kept the release this page runs (and its version): nothing switched.
      state.value = 'error';
      applyFailed.value = true;
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    currentVersion,
    state,
    availableInfo,
    foundQuietly,
    deferredVersion,
    applyFailed,
    chunkFailed,
    noteChunkFailed,
    error,
    busyReason,
    check,
    checkQuietly,
    startQuietChecks,
    apply,
    reloadNow,
  };
});
