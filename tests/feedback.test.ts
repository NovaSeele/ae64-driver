import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PermanentSyncError, useSyncStore } from '../src/stores/sync';
import { useFlashStore } from '../src/stores/flash';
import { useDeviceStore } from '../src/stores/device';
import { useToast } from '../src/components/ui/toast';
import { t } from '../src/i18n/vi';

const job = (key: string, label: string, extra: Record<string, unknown> = {}) => ({
  key,
  label,
  write: async () => { throw new PermanentSyncError('nope'); },
  ...extra,
});

describe('dropped sync jobs', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    useToast().items.value = [];
    await useDeviceStore().connectDemo();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows one error toast per batch, truncated to two labels plus +N', async () => {
    const sync = useSyncStore();
    for (const l of ['A', 'B', 'C', 'D']) sync.enqueue(job(l, l));
    await sync.flush().catch(() => undefined);
    const items = useToast().items.value;
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('error');
    expect(items[0].text).toBe(t('sync.dropped', { labels: 'A, B +2' }));
    expect(items[0].text).not.toContain(t('sync.restored'));
    expect(sync.lastError).toContain('D');
  });

  it('appends the restored sentence when a dropped job had onDrop', async () => {
    const sync = useSyncStore();
    sync.enqueue(job('a', 'A', { onDrop: () => undefined }));
    await sync.flush().catch(() => undefined);
    expect(useToast().items.value[0].text).toBe(`${t('sync.dropped', { labels: 'A' })} ${t('sync.restored')}`);
  });

  it('does not toast for a failure that will be retried', async () => {
    const sync = useSyncStore();
    sync.enqueue({ key: 'a', label: 'A', write: async () => { throw new Error('usb'); } });
    await sync.flush().catch(() => undefined);
    expect(useToast().items.value).toHaveLength(0);
  });

  it('shows saved with lastProblem (no retry state) once everything failing was dropped', async () => {
    const sync = useSyncStore();
    sync.enqueue(job('a', 'A'));
    await expect(sync.flush()).rejects.toThrow();
    expect(sync.state).toBe('saved');
    expect(sync.lastProblem).toContain('A');
    sync.enqueue({ key: 'b', label: 'B', write: async () => undefined });
    await sync.flush();
    expect(sync.lastProblem).toBeNull();
  });

  it('keeps the error state while a failed job waits for retry', async () => {
    const sync = useSyncStore();
    sync.enqueue({ key: 'a', label: 'A', write: async () => { throw new Error('usb'); } });
    await expect(sync.flush()).rejects.toThrow();
    expect(sync.state).toBe('error');
    expect(sync.lastProblem).toBeNull();
  });

  it('reset() calls onDrop but shows no toast', () => {
    const sync = useSyncStore();
    const onDrop = vi.fn();
    sync.enqueue(job('a', 'A', { onDrop }));
    expect(sync.reset()).toBe(1);
    expect(onDrop).toHaveBeenCalledTimes(1);
    expect(useToast().items.value).toHaveLength(0);
  });

  it('flashes the union of the dropped jobs\' keys', async () => {
    vi.useFakeTimers();
    const sync = useSyncStore();
    const flash = useFlashStore();
    sync.enqueue(job('a', 'A', { keys: [1, 2] }));
    sync.enqueue(job('b', 'B', { keys: [2, 3] }));
    sync.enqueue(job('c', 'C'));
    await sync.flush().catch(() => undefined);
    expect([1, 2, 3, 4].map((id) => flash.isFlashing(id))).toEqual([true, true, true, false]);
    await vi.advanceTimersByTimeAsync(1001);
    expect(flash.isFlashing(1)).toBe(false);
  });
});
