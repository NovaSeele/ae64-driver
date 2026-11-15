// One page per keyboard (W-11): Chrome lets two pages open the same HID device, and both get every input report, so a reply can
// be taken by the wrong page and stale stores in one undo the other's edits. A real connection holds a Web Lock named after its
// USB product while it is open; a page that cannot get it opens nothing and sends nothing. The browser releases the lock when
// the page goes away. Without `navigator.locks` (an old browser, some WebViews) the page connects as before (Diagnostics says so).

type LockManagerLike = {
  request(name: string, opts: { ifAvailable: boolean }, cb: (lock: unknown) => Promise<void> | void): Promise<unknown>;
  query?(): Promise<{ held?: { name?: string }[] }>;
};

function manager(): LockManagerLike | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManagerLike }).locks : undefined;
  return locks && typeof locks.request === 'function' ? locks : null;
}

/** Web Locks are there: the one-tab check runs. */
export function locksAvailable(): boolean {
  return manager() !== null;
}

/** The lock of one USB product (vendor id + product id): a Max and a Pro may be open in two tabs. */
export function deviceLockName(vendorId: number, productId: number): string {
  return `ae64-hid-${vendorId.toString(16).padStart(4, '0')}-${productId.toString(16).padStart(4, '0')}`;
}

/** Held by the page that runs a firmware session or rescue mode. */
export const FIRMWARE_LOCK = 'ae64-firmware';

/** The keyboard is open in another tab or window of this app (its lock is held there). */
export class TabLockedError extends Error {
  constructor(readonly productId: number) {
    super('tab-locked');
    this.name = 'TabLockedError';
  }
}

/** This page's locks: one Web Lock per name, shared by every user in the page (counted). */
const held = new Map<string, { count: number; free: () => void }>();
const pending = new Map<string, Promise<boolean>>();

async function acquire(name: string): Promise<boolean> {
  const m = manager()!;
  return new Promise<boolean>((resolve) => {
    m.request(name, { ifAvailable: true }, (lock) => {
      if (!lock) {
        resolve(false);
        return undefined;
      }
      // Held until the last user in this page lets go (or the page goes away).
      return new Promise<void>((free) => {
        held.set(name, { count: 0, free });
        resolve(true);
      });
    }).catch(() => resolve(false));
  });
}

/**
 * Chrome frees a released lock one task later, not at once (measured on r127: refused in the same task and after a microtask,
 * free after `setTimeout(0)`). So a close-then-open in one task would see this page's own lock as taken: ask once more after
 * `setTimeout(0)`, and only a second refusal means another page holds it (N-WX4-1).
 */
async function acquireOrRetry(name: string): Promise<boolean> {
  if (await acquire(name)) return true;
  await new Promise<void>((r) => setTimeout(r, 0));
  return held.has(name) || acquire(name);
}

/**
 * Takes a share of `name` for this page. Resolves to the share's release (call it once), or null when another page holds the
 * lock. Without Web Locks: a release that does nothing (the page goes on as before).
 */
export async function takeLock(name: string): Promise<(() => void) | null> {
  if (!manager()) return () => undefined;
  if (!held.has(name)) {
    let p = pending.get(name);
    if (!p) {
      p = acquireOrRetry(name).finally(() => pending.delete(name));
      pending.set(name, p);
    }
    if (!(await p) && !held.has(name)) return null;
  }
  const h = held.get(name);
  if (!h) return null;
  h.count++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const cur = held.get(name);
    if (cur !== h) return;
    h.count--;
    if (h.count <= 0) {
      held.delete(name);
      h.free();
    }
  };
}

/** This page holds `name` now. */
export function holdsLock(name: string): boolean {
  return held.has(name);
}

/** Another page holds `name` now (false without Web Locks, or when the query is not there). */
export async function heldElsewhere(name: string): Promise<boolean> {
  const m = manager();
  if (!m?.query || held.has(name)) return false;
  try {
    const snap = await m.query();
    return (snap.held ?? []).some((l) => l.name === name);
  } catch {
    return false;
  }
}
