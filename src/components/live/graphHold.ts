// Auto-hold for the travel graph: once the key has been back at rest for HOLD_MS after a stroke, the graph's
// clock stops at lastActiveT + HOLD_MS until the next active sample. Pure (no DOM, no Vue).

/** A sample at or above this depth (mm) is "active"; below it is rest. */
export const RESUME_MM = 0.15;
/** How long the key must stay at rest before the graph holds. */
export const HOLD_MS = 400;

export class HoldTracker {
  private lastActiveT: number | null = null;
  private latestMm = 0;

  /** Feed samples in time order. */
  feed(t: number, mm: number): void {
    this.latestMm = mm;
    if (mm >= RESUME_MM) this.lastActiveT = t;
  }

  /** The hold clock when holding, else null (live). */
  frozenAt(now: number): number | null {
    if (this.lastActiveT === null || this.latestMm >= RESUME_MM) return null;
    return now - this.lastActiveT >= HOLD_MS ? this.lastActiveT + HOLD_MS : null;
  }

  reset(): void {
    this.lastActiveT = null;
    this.latestMm = 0;
  }
}
