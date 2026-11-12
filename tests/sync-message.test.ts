// The "Not saved" message stays short however many keys fail; the full list is kept in lastErrorDetail.
import { beforeEach, describe, expect, it } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { PermanentSyncError, useSyncStore } from '../src/stores/sync';
import { useDeviceStore } from '../src/stores/device';
import { t } from '../src/i18n/vi';

const job = (i: number, reason = 'nope') => ({
  key: `k${i}`,
  label: `Hành trình K${i}`,
  write: async () => { throw new PermanentSyncError(reason); },
});

describe('sync failure message', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await useDeviceStore().connectDemo();
  });

  it('64 failures with one reason: short, grouped, with the count', async () => {
    const sync = useSyncStore();
    for (let i = 0; i < 64; i++) sync.enqueue(job(i));
    await sync.flush().catch(() => undefined);
    expect(sync.lastError).toBe(t('sync.failedSame', { n: 64, group: 'Hành trình', reason: 'nope' }));
    expect(sync.lastError!.length).toBeLessThan(200);
    expect(sync.lastError).toContain('64');
    expect(sync.lastErrorDetail).toContain('Hành trình K63: nope');
    expect(sync.lastErrorDetail!.length).toBeGreaterThan(1000);
  });

  it('64 failures with different reasons: first 3 and a count of the rest', async () => {
    const sync = useSyncStore();
    for (let i = 0; i < 64; i++) sync.enqueue(job(i, `r${i}`));
    await sync.flush().catch(() => undefined);
    expect(sync.lastError!.length).toBeLessThan(200);
    expect(sync.lastError).toContain('Hành trình K0: r0; Hành trình K1: r1; Hành trình K2: r2');
    expect(sync.lastError).not.toContain('K3:');
    expect(sync.lastError).toContain('61');
  });

  it('labels without a shared prefix use the count form', async () => {
    const sync = useSyncStore();
    for (const l of ['A', 'B', 'C', 'D', 'E']) {
      sync.enqueue({ key: l, label: l, write: async () => { throw new PermanentSyncError('nope'); } });
    }
    await sync.flush().catch(() => undefined);
    expect(sync.lastError).toBe(t('sync.failedMore', { labels: 'A: nope; B: nope; C: nope', n: 2 }));
  });

  it('2 failures are listed in full', async () => {
    const sync = useSyncStore();
    sync.enqueue(job(1));
    sync.enqueue(job(2));
    await sync.flush().catch(() => undefined);
    expect(sync.lastError).toBe(t('sync.failed', { labels: 'Hành trình K1: nope; Hành trình K2: nope' }));
    expect(sync.lastErrorDetail).toBe('Hành trình K1: nope; Hành trình K2: nope');
  });

  it('a successful batch clears both', async () => {
    const sync = useSyncStore();
    sync.enqueue(job(1));
    await sync.flush().catch(() => undefined);
    sync.enqueue({ key: 'ok', label: 'ok', write: async () => undefined });
    await sync.flush();
    expect(sync.lastError).toBeNull();
    expect(sync.lastErrorDetail).toBeNull();
  });
});
