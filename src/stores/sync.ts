// Write queue: coalesce edits by key, debounce, write → one commit per group → verify by reading back.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { Ae64Transport, SaveGroup } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useDeviceStore } from './device';

export interface SyncJob {
  /** Jobs with the same key coalesce (last wins), e.g. `perf:<profile>:<keyId>`. */
  key: string;
  /** Commit group written after the batch; omit for commands the firmware applies without a commit (global settings). */
  group?: SaveGroup;
  write: (t: Ae64Transport) => Promise<void>;
  verify?: (t: Ae64Transport) => Promise<boolean>;
  label: string;
}

export type SyncState = 'saved' | 'pending' | 'writing' | 'error';

export const SYNC_DEBOUNCE_MS = 350;

export const useSyncStore = defineStore('sync', () => {
  const state = ref<SyncState>('saved');
  const lastError = ref<string | null>(null);

  let queued = new Map<string, SyncJob>();
  /** Jobs from a failed batch; retried with the next flush unless a newer job with the same key replaced them. */
  let failed = new Map<string, SyncJob>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<boolean> | null = null;

  function schedule(delay = SYNC_DEBOUNCE_MS): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(() => undefined); }, delay);
    if (state.value !== 'writing') state.value = 'pending';
  }

  function enqueue(job: SyncJob): void {
    queued.delete(job.key);
    failed.delete(job.key);
    queued.set(job.key, job);
    schedule();
  }

  async function runBatch(jobs: SyncJob[]): Promise<boolean> {
    try {
      await useDeviceStore().withTransport(async (t) => {
        for (const job of jobs) await job.write(t);
        for (const group of new Set(jobs.map((j) => j.group))) if (group !== undefined) await t.commit(group);
        const mismatched: string[] = [];
        for (const job of jobs) if (job.verify && !(await job.verify(t))) mismatched.push(job.label);
        if (mismatched.length) throw new Error(tr('sync.verifyFailed', { labels: mismatched.join(', ') }));
      }, { exclusive: true });
      lastError.value = null;
      state.value = queued.size ? 'pending' : 'saved';
      return true;
    } catch (err) {
      for (const job of jobs) if (!queued.has(job.key)) failed.set(job.key, job);
      lastError.value = err instanceof Error ? err.message : String(err);
      state.value = 'error';
      return false;
    }
  }

  /** Write everything queued now (also used before profile switches and disconnects). */
  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (running) {
      await running;
      if (queued.size) return flush();
      return;
    }
    if (!queued.size && !failed.size) return;
    const batch = new Map([...failed, ...queued]);
    failed = new Map();
    queued = new Map();
    state.value = 'writing';
    running = runBatch([...batch.values()]);
    let ok: boolean;
    try {
      ok = await running;
    } finally {
      running = null;
    }
    if (queued.size) schedule();
    if (!ok) throw new Error(lastError.value ?? 'sync failed');
  }

  function retry(): Promise<void> {
    return flush().catch(() => undefined);
  }

  /** Drop everything (disconnect). */
  function reset(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    queued = new Map();
    failed = new Map();
    state.value = 'saved';
    lastError.value = null;
  }

  return { state, lastError, enqueue, flush, retry, reset };
});
