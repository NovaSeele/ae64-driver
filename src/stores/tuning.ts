// Hall tuning from before an advanced-key write that touched the keyboard but never finished, per profile and key.
// Shared by the advanced and performance stores (a separate module avoids a circular import): the firmware resets a
// key's tuning on such a write, so a later job must restore this snapshot instead of reading the reset values.
// The snapshots belong to one keyboard: they survive unplugging and replugging it (a cable pulled mid-write must not
// lose the original tuning) and are dropped when another keyboard, or one that cannot be identified, connects.
import type { Performance } from '../protocol';

const snapshots = new Map<string, Performance>();
let owner: string | null = null;
const slot = (profile: number, keyId: number) => `${profile}:${keyId}`;

export const getTuningSnapshot = (profile: number, keyId: number): Performance | undefined => snapshots.get(slot(profile, keyId));
export const setTuningSnapshot = (profile: number, keyId: number, p: Performance): void => { snapshots.set(slot(profile, keyId), p); };
export const deleteTuningSnapshot = (profile: number, keyId: number): void => { snapshots.delete(slot(profile, keyId)); };
export const clearTuningSnapshots = (): void => { snapshots.clear(); owner = null; };

/** A keyboard connected: keep the snapshots only if it is the one they were taken on (`id` null = cannot tell). */
export function tuningSnapshotsFor(id: string | null): void {
  if (id === null || id !== owner) snapshots.clear();
  owner = id;
}
