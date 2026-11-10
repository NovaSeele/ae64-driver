// Graph-owned sample history for the travel graph: a time-ordered ring, much longer than the live store's ring,
// so a frozen or panned view can look back far past what the store still holds. Pure (no DOM, no Vue).
// 65536 samples ≈ 39 s at 1,670 Hz, ≈ 2 min at 531 Hz (≈ 786 KB).

export class GraphHistory {
  private readonly t: Float64Array;
  private readonly mm: Float32Array;
  private head = 0;
  size = 0;

  constructor(readonly capacity = 65536) {
    this.t = new Float64Array(capacity);
    this.mm = new Float32Array(capacity);
  }

  /** Append a sample; a time not after the newest one is ignored. */
  push(t: number, mm: number): void {
    if (this.size > 0 && t <= this.newestT()) return;
    this.t[this.head] = t;
    this.mm[this.head] = mm;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }

  private at(i: number): number {
    return (this.head - this.size + i + this.capacity) % this.capacity;
  }

  oldestT(): number {
    return this.size ? this.t[this.at(0)] : NaN;
  }

  newestT(): number {
    return this.size ? this.t[this.at(this.size - 1)] : NaN;
  }

  /** Visit samples oldest → newest with from ≤ t ≤ to. */
  forEach(from: number, to: number, cb: (t: number, mm: number) => void): void {
    // first logical index with t ≥ from (samples are time-ordered)
    let lo = 0;
    let hi = this.size;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.t[this.at(mid)] < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < this.size; i++) {
      const k = this.at(i);
      if (this.t[k] > to) break;
      cb(this.t[k], this.mm[k]);
    }
  }
}
