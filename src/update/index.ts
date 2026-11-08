import { defineStore } from 'pinia';
import { ref } from 'vue';

export type UpdateState = 'idle' | 'checking' | 'upToDate' | 'available' | 'downloading' | 'error';

export interface AvailableVersion {
  version: string;
  builtAt: string;
}

export function registerServiceWorker(): void {
  if (import.meta.env.PROD && typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.error('ServiceWorker registration failed:', err);
    });
  }
}

export const useUpdateStore = defineStore('update', () => {
  const currentVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0';
  const state = ref<UpdateState>('idle');
  const availableInfo = ref<AvailableVersion | null>(null);
  const error = ref<string | null>(null);

  async function postSwMessage<T>(msg: { type: string }, timeoutMs = 15000): Promise<T> {
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
        if (reply.available && reply.latest) {
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
        if (latest && latest !== currentVersion) {
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

  async function apply(): Promise<void> {
    state.value = 'downloading';
    error.value = null;

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
        const reply = await postSwMessage<ApplyReply>({ type: 'apply' }, 120000);
        if (!reply.ok) {
          throw new Error(reply.error || 'Failed to apply update');
        }
        if (typeof window !== 'undefined') {
          window.location.reload();
        }
      } else {
        // Without service worker: reload
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
    error,
    check,
    apply,
  };
});
