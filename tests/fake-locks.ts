// navigator.locks for the tests (W-11, N-WX4-1): an in-memory lock manager that frees a released lock as Chrome does.
/**
 * navigator.locks in memory, freed as Chrome frees them: a lock its holder releases is free again only after a macrotask (not
 * in the same task, not after a microtask; measured on r127, N-WX4-1). `other(name)` is another page holding `name` until its
 * release (a closed tab: freed at once).
 */
export class FakeLocks {
  readonly held = new Map<string, 'page' | 'other'>();
  readonly asked: string[] = [];
  constructor(private readonly order: string[] = []) {}
  async request(name: string, opts: { ifAvailable?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown> {
    this.asked.push(name);
    this.order.push(`lock ${name}`);
    if (!opts.ifAvailable) throw new Error('the app always asks ifAvailable');
    if (this.held.has(name)) return cb(null);
    this.held.set(name, 'page');
    try {
      return await cb({ name, mode: 'exclusive' });
    } finally {
      this.order.push(`free ${name}`);
      setTimeout(() => { if (this.held.get(name) === 'page') this.held.delete(name); }, 0);
    }
  }
  async query() {
    return { held: [...this.held.keys()].map((name) => ({ name, mode: 'exclusive' })), pending: [] };
  }
  other(name: string): () => void {
    this.held.set(name, 'other');
    return () => { if (this.held.get(name) === 'other') this.held.delete(name); };
  }
}
export function installLocks(order: string[] = []): FakeLocks {
  const locks = new FakeLocks(order);
  Object.defineProperty(navigator, 'locks', { value: locks, configurable: true, writable: true });
  return locks;
}
export function removeLocks(): void {
  delete (navigator as unknown as { locks?: unknown }).locks;
}
