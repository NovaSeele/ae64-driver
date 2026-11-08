import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { MockTransport, SAVE_GROUP } from '../src/protocol';
import { useSyncStore } from '../src/stores/sync';
import { useDeviceStore } from '../src/stores/device';

describe('sync: jobs that skip', () => {
  beforeEach(async () => {
    setActivePinia(createPinia());
    await useDeviceStore().connectDemo();
  });
  afterEach(() => vi.restoreAllMocks());

  it("a job whose write resolves 'skip' is neither committed nor verified", async () => {
    const mock = useDeviceStore().transport as MockTransport;
    const commit = vi.spyOn(mock, 'commit');
    const sync = useSyncStore();
    const verify = vi.fn(async () => true);
    sync.enqueue({ key: 'skipped', group: SAVE_GROUP.ADVANCED, label: 'skipped', write: async () => 'skip', verify });
    await sync.flush();
    expect(commit).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(sync.state).toBe('saved');
  });

  it('a group is committed once when at least one of its jobs wrote; only that job is verified', async () => {
    const mock = useDeviceStore().transport as MockTransport;
    const commit = vi.spyOn(mock, 'commit');
    const sync = useSyncStore();
    const skippedVerify = vi.fn(async () => true);
    const writtenVerify = vi.fn(async () => true);
    sync.enqueue({ key: 'skipped', group: SAVE_GROUP.ADVANCED, label: 'skipped', write: async () => 'skip', verify: skippedVerify });
    sync.enqueue({ key: 'written', group: SAVE_GROUP.ADVANCED, label: 'written', write: async () => undefined, verify: writtenVerify });
    await sync.flush();
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(SAVE_GROUP.ADVANCED);
    expect(skippedVerify).not.toHaveBeenCalled();
    expect(writtenVerify).toHaveBeenCalledTimes(1);
  });
});
