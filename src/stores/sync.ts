// Write queue: coalesce edits by key, debounce, write → one commit per group → verify by reading back.
//
// Failure handling (each job is isolated, so one bad job never blocks the others):
// - A job that throws, whose commit fails, or whose read-back does not match is a failed attempt. It is
//   retried with the next flush, at most MAX_ATTEMPTS times, unless a newer job with the same key replaced it.
// - Permanent errors are never retried: the transport safety guard (UnsafeCommandError), a read-only board
//   (WriteNotAllowedError) and PermanentSyncError (e.g. an advanced-key conflict found on the device).
// - A job tagged with `profile` is only written while that profile is active (the wire format has no profile
//   byte, so writing it later would land in another profile). Otherwise it is dropped.
// - Dropped jobs call `onDrop` so their store can put back the value the keyboard really has.
// - flush() rejects unless everything that was pending has been written and verified.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { UnsafeCommandError, WriteNotAllowedError } from '../protocol';
import type { Ae64Transport, SaveGroup } from '../protocol';
import { t as tr } from '../i18n/vi';
import { useToast } from '../components/ui/toast';
import { useDeviceStore } from './device';
import { useFlashStore } from './flash';

export interface SyncJob {
  /** Jobs with the same key coalesce (last wins), e.g. `perf:<profile>:<keyId>`. */
  key: string;
  /** Commit group written after the batch; omit for commands the firmware applies without a commit (global settings). */
  group?: SaveGroup;
  /** Onboard profile this job belongs to; never written while another profile is active. Omit for global data. */
  profile?: number;
  /** Resolve `'skip'` when nothing was written: the job is then neither committed nor verified. */
  write: (t: Ae64Transport) => Promise<void | 'skip'>;
  verify?: (t: Ae64Transport) => Promise<boolean>;
  label: string;
  /** The job was given up without being saved; restore the state the keyboard really has. */
  onDrop?: (reason: string) => void;
  /** PhysicalKey ids this job writes (per-key data only): flashed on the keyboard view when the job is dropped. */
  keys?: number[];
}

/** An error that retrying cannot fix (the job is dropped at once). */
export class PermanentSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentSyncError';
  }
}

export type SyncState = 'saved' | 'pending' | 'writing' | 'error';

export const SYNC_DEBOUNCE_MS = 350;
/** Attempts per job before it is dropped (transient USB errors, read-back mismatches). */
export const MAX_ATTEMPTS = 3;

interface Entry { job: SyncJob; attempts: number }
/** A job given up on, with the bare reason (no label) the drop toast summarizes. */
interface Dropped { entry: Entry; reason: string }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPermanent(err: unknown): boolean {
  return err instanceof UnsafeCommandError || err instanceof WriteNotAllowedError || err instanceof PermanentSyncError;
}

interface Problem { label: string; reason: string }

/** Problems shown in full up to this many; beyond it the message shows a group or the first few and a count. */
const MAX_LISTED = 3;

/** The leading words every label shares (e.g. "Hành trình"), or '' when there is none. */
function commonPrefix(labels: string[]): string {
  const words = labels.map((l) => l.split(' '));
  const n = Math.min(...words.map((w) => w.length - 1));
  let i = 0;
  while (i < n && words.every((w) => w[i] === words[0][i])) i++;
  return words[0].slice(0, i).join(' ');
}

/** Reason as shown after a colon: no trailing ".", first letter lowercase. */
function inlineReason(reason: string): string {
  const r = reason.replace(/\.+$/, '');
  return r.charAt(0).toLocaleLowerCase() + r.slice(1);
}

/** Distinct reasons with counts (most frequent first, ties in first-seen order), at most MAX_LISTED, then "+k other errors". */
function reasonList(problems: Problem[]): string {
  const counts = new Map<string, number>();
  for (const p of problems) {
    const r = inlineReason(p.reason);
    counts.set(r, (counts.get(r) ?? 0) + 1);
  }
  if (counts.size === 1) return [...counts.keys()][0];
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const parts = sorted.slice(0, MAX_LISTED).map(([r, n]) => `${r} (${n})`);
  if (sorted.length > MAX_LISTED) parts.push(tr('sync.reasonsMore', { k: sorted.length - MAX_LISTED }));
  return parts.join(', ');
}

/** A short "Not saved" message: all of them when few, else "N items (group): reasons" or the first few + a count. */
function summarize(problems: Problem[]): string {
  if (problems.length <= MAX_LISTED) return tr('sync.failed', { labels: problems.map((p) => `${p.label}: ${p.reason}`).join('; ') });
  const group = commonPrefix(problems.map((p) => p.label));
  if (group) return tr('sync.failedSame', { n: problems.length, group, reasons: reasonList(problems) });
  const first = problems.slice(0, MAX_LISTED).map((p) => `${p.label}: ${p.reason}`).join('; ');
  return tr('sync.failedMore', { labels: first, n: problems.length - MAX_LISTED });
}

export const useSyncStore = defineStore('sync', () => {
  const state = ref<SyncState>('saved');
  const lastError = ref<string | null>(null);
  /** Every problem of the last failed batch, in full (lastError is the short form shown to the user). */
  const lastErrorDetail = ref<string | null>(null);
  /** Problem of the last batch whose failed jobs were all dropped (nothing to retry); cleared by a successful batch. */
  const lastProblem = ref<string | null>(null);

  let queued = new Map<string, Entry>();
  /** Jobs from a failed batch; retried with the next flush unless a newer job with the same key replaced them. */
  let failed = new Map<string, Entry>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<boolean> | null = null;
  /** > 0 while something else writes the keyboard directly (backup restore): nothing is written meanwhile. */
  let holds = 0;

  function schedule(delay = SYNC_DEBOUNCE_MS): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { void flush().catch(() => undefined); }, delay);
    if (state.value !== 'writing') state.value = 'pending';
  }

  function enqueue(job: SyncJob): void {
    queued.delete(job.key);
    failed.delete(job.key);
    queued.set(job.key, { job, attempts: 0 });
    schedule();
  }

  /** Dropped jobs are collected per batch and reported once (toast + flashing keys) by reportDropped. */
  function drop(e: Entry, reason: string, dropped: Dropped[], bareReason = reason): void {
    dropped.push({ entry: e, reason: bareReason });
    try {
      e.job.onDrop?.(reason);
    } catch {
      // a store callback must never break the queue
    }
  }

  /** One error toast per batch that gave up on jobs, and the keys they write flash on the keyboard view. */
  function reportDropped(dropped: Dropped[]): void {
    if (!dropped.length) return;
    const summary = summarize(dropped.map((d) => ({ label: d.entry.job.label, reason: d.reason })));
    const restored = dropped.every((d) => d.entry.job.onDrop);
    useToast().show(tr('sync.dropped', { summary: summary.replace(/\.+$/, '') }) + (restored ? ` ${tr('sync.restored')}` : ''), 'error');
    useFlashStore().flash([...new Set(dropped.flatMap((d) => d.entry.job.keys ?? []))]);
  }

  /** Runs one batch; returns true when every job was written and verified. */
  async function runBatch(entries: Entry[]): Promise<boolean> {
    const device = useDeviceStore();
    const problems: Problem[] = [];
    const retry: Entry[] = [];
    const dropped: Dropped[] = [];
    const fail = (e: Entry, err: unknown) => {
      const msg = `${e.job.label}: ${messageOf(err)}`;
      problems.push({ label: e.job.label, reason: messageOf(err) });
      e.attempts++;
      if (isPermanent(err) || e.attempts >= MAX_ATTEMPTS) drop(e, msg, dropped, messageOf(err));
      else retry.push(e);
    };
    try {
      await device.withTransport(async (t) => {
        const written: Entry[] = [];
        for (const e of entries) {
          if (e.job.profile !== undefined && e.job.profile !== device.activeProfile) {
            const msg = `${e.job.label}: ${tr('sync.otherProfile')}`;
            problems.push({ label: e.job.label, reason: tr('sync.otherProfile') });
            drop(e, msg, dropped, tr('sync.otherProfile'));
            continue;
          }
          try {
            if ((await e.job.write(t)) !== 'skip') written.push(e);
          } catch (err) {
            fail(e, err);
          }
        }
        const committed: Entry[] = [];
        for (const group of new Set(written.map((e) => e.job.group))) {
          const members = written.filter((e) => e.job.group === group);
          if (group === undefined) { committed.push(...members); continue; }
          try {
            await t.commit(group);
            committed.push(...members);
          } catch (err) {
            for (const e of members) fail(e, err);
          }
        }
        for (const e of committed) {
          if (!e.job.verify) continue;
          try {
            if (!(await e.job.verify(t))) fail(e, new Error(tr('sync.verifyMismatch')));
          } catch (err) {
            fail(e, err);
          }
        }
      }, { exclusive: true });
    } catch (err) {
      // Not connected / transport gone before anything ran: every job is a failed attempt.
      // (Every step inside is caught per job, so this only happens when withTransport itself refused.)
      for (const e of entries) fail(e, err);
    }
    reportDropped(dropped);
    for (const e of retry) if (!queued.has(e.job.key)) failed.set(e.job.key, e);
    if (problems.length) {
      lastErrorDetail.value = problems.map((p) => `${p.label}: ${p.reason}`).join('; ');
      lastError.value = summarize(problems);
      if (failed.size) {
        state.value = 'error';
      } else {
        // Everything that failed was dropped and restored (the drop toast said so): nothing to retry.
        lastProblem.value = lastError.value;
        state.value = queued.size ? 'pending' : 'saved';
      }
      return false;
    }
    lastError.value = null;
    lastErrorDetail.value = null;
    lastProblem.value = null;
    state.value = queued.size ? 'pending' : 'saved';
    return true;
  }

  /**
   * Write everything queued now (also used before profile switches, updates and disconnects).
   * Rejects unless every pending edit — including ones from a batch that was already running — was saved.
   */
  async function flush(): Promise<void> {
    if (timer) { clearTimeout(timer); timer = null; }
    if (holds > 0) {
      if (queued.size || failed.size) throw new Error(tr('sync.held'));
      return;
    }
    if (running) {
      const ok = await running;
      if (queued.size || failed.size) return flush();
      if (!ok) throw new Error(lastError.value ?? 'sync failed');
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

  /**
   * Pause writing (edits keep queueing). Call after a successful flush(); the returned release resumes
   * and schedules whatever was queued meanwhile. Releasing twice is a no-op.
   */
  function hold(): () => void {
    holds++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds--;
      if (holds === 0 && (queued.size || failed.size)) schedule();
    };
  }

  function retry(): Promise<void> {
    return flush().catch(() => undefined);
  }

  /** Unsaved jobs (queued, retrying or being written). */
  function pendingCount(): number {
    return queued.size + failed.size;
  }

  /** Drop everything (disconnect). Returns how many unsaved edits were lost. */
  function reset(): number {
    if (timer) clearTimeout(timer);
    timer = null;
    const lost = [...queued.values(), ...failed.values()];
    queued = new Map();
    failed = new Map();
    // No drop toast or key flash: the disconnect path already reports the lost count.
    for (const e of lost) drop(e, tr('sync.lost'), []);
    state.value = 'saved';
    lastError.value = null;
    lastErrorDetail.value = null;
    lastProblem.value = null;
    return lost.length;
  }

  return { state, lastError, lastErrorDetail, lastProblem, enqueue, flush, retry, reset, pendingCount, hold };
});
