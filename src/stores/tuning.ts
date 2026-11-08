// Hall tuning from before an advanced-key write that touched the keyboard but never finished, per profile and key.
// Shared by the advanced and performance stores (a separate module avoids a circular import): the firmware resets a
// key's tuning on such a write, so a later job must restore this snapshot instead of reading the reset values.
import type { Performance } from '../protocol';

const snapshots = new Map<string, Performance>();
const slot = (profile: number, keyId: number) => `${profile}:${keyId}`;

export const getTuningSnapshot = (profile: number, keyId: number): Performance | undefined => snapshots.get(slot(profile, keyId));
export const setTuningSnapshot = (profile: number, keyId: number, p: Performance): void => { snapshots.set(slot(profile, keyId), p); };
export const deleteTuningSnapshot = (profile: number, keyId: number): void => { snapshots.delete(slot(profile, keyId)); };
export const clearTuningSnapshots = (): void => snapshots.clear();
