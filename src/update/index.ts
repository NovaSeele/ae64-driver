import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useDeviceStore } from '../stores/device';
import { useCalibrationStore } from '../stores/calibration';
import { useSyncStore } from '../stores/sync';
import { useFirmwareStore } from '../stores/firmware';
import { t as tr } from '../i18n/vi';
import { isNewerVersion } from './version';

export * from './version';

export type UpdateState = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'deferred' | 'error';

export interface AvailableVersion {
  version: string;
  builtAt: string;
}

/** The desktop app never updates itself: the user installs a newer setup.exe. */
const DESKTOP = typeof __DESKTOP__ !== 'undefined' && __DESKTOP__;

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
}

export const useUpdateStore = defineStore('update', () => {
  const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  const state = ref<UpdateState>('idle');
  const availableInfo = ref<AvailableVersion | null>(null);
  const error = ref<string | null>(null);
  /** Version downloaded but not yet applied (state 'deferred'). */
  const deferredVersion = ref('');

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

  async function check(): Promise<void> {
    if (DESKTOP) return;
    state.value = 'checking';
    error.value = null;

    try {
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
          state.value = 'available';
          availableInfo.value = {
            version: reply.latest,
            builtAt: reply.builtAt || '',
          };
        } else {
          state.value = 'upToDate';
          availableInfo.value = null;
        }
      } else {
        // No SW controller (e.g. dev server or unsupported browser): fetch release.json directly
        const res = await fetch('/release.json', { cache: 'no-store' });
        if (!res.ok) {
          throw new Error(`Failed to fetch release.json (${res.status})`);
        }
        const data = await res.json();
        const latest = data.version;
        if (latest && isNewerVersion(latest, currentVersion)) {
          state.value = 'available';
          availableInfo.value = {
            version: latest,
            builtAt: data.builtAt || '',
          };
        } else {
          state.value = 'upToDate';
          availableInfo.value = null;
        }
      }
    } catch (err) {
      state.value = 'error';
      error.value = err instanceof Error ? err.message : String(err);
    }
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

    try {
      await sync.flush();
    } catch (err) {
      state.value = 'error';
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
      state.value = 'error';
      error.value = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    currentVersion,
    state,
    availableInfo,
    deferredVersion,
    error,
    busyReason,
    check,
    apply,
    reloadNow,
  };
});
