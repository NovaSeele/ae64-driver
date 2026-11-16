// When the "Xem thử" preview on the big keyboard starts and ends (FXP §7). Pure timing and pointer/focus/Esc rules: the
// page says which tile is under the pointer or has keyboard focus, and gets back which effect to show (or none). Nothing
// here talks to a keyboard: a preview is display only.
//
// - Start: the pointer rests on a tile for REST_MS; while a preview (or the "no preview" cue) is showing, moving to another
//   tile switches after SWITCH_MS; a tile that gets keyboard focus starts at once. A touch pointer never starts one.
// - It does not start where `allowed(n)` says no (the view "Tắt", the area off, the chosen effect): that ends a running one.
// - End, at once: the pointer leaves the grid (unless a tile in it keeps keyboard focus: that tile is shown), focus leaves
//   the grid, Esc, a click, or the page calls end() (a view, tab or power change, leaving the page).
// - After Esc the tile under the pointer stays ended until the pointer reaches another tile or leaves the grid; moves inside
//   the same tile do not restart it (review F4).

export const REST_MS = 300;
export const SWITCH_MS = 100;

/** The tile being shown: its UI number. */
export type PreviewTarget = number | null;

export interface PreviewHost {
  /** Effect `n` may be previewed (or get the "no preview" cue) now. */
  allowed(n: number): boolean;
  /** The shown tile changed (null = none). */
  show(n: PreviewTarget): void;
}

type Timer = ReturnType<typeof setTimeout>;

export class PreviewControl {
  /** The tile shown now (null = none). */
  shown: PreviewTarget = null;
  private pending = 0;
  private hover = 0;
  /** The tile Esc ended: ignored until the pointer reaches another tile or leaves the grid. */
  private held = 0;
  private timer: Timer | null = null;

  constructor(private readonly host: PreviewHost) {}

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.pending = 0;
  }

  private set(n: PreviewTarget): void {
    if (this.shown === n) return;
    this.shown = n;
    this.host.show(n);
  }

  /** Show tile `n` now, if allowed; otherwise end. */
  private startNow(n: number): void {
    this.clearTimer();
    if (this.host.allowed(n)) this.set(n);
    else this.set(null);
  }

  /** The pointer is over tile `n` (pointerover on the tile or anything in it). */
  over(n: number, pointerType: string): void {
    if (pointerType === 'touch') return;
    this.hover = n;
    if (n === this.held) return; // Esc ended this tile: small moves inside it do not restart it
    this.held = 0;
    if (n === this.pending || (n === this.shown && this.timer === null)) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.pending = n;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.pending = 0;
      this.startNow(n);
    }, this.shown !== null ? SWITCH_MS : REST_MS);
  }

  /** The pointer left the grid. `focused` = the tile in the grid with keyboard focus, if any: it is shown instead. */
  leave(focused: number | null): void {
    this.hover = 0;
    this.held = 0;
    if (focused) this.startNow(focused);
    else this.end();
  }

  /** Tile `n` got keyboard focus (:focus-visible). */
  focus(n: number): void {
    this.startNow(n);
  }

  /** Focus left the grid. */
  blur(): void {
    this.end();
  }

  /** Esc: ends a preview (or a pending one). Returns whether there was one to end. */
  escape(): boolean {
    const had = this.shown !== null || this.timer !== null;
    if (!had) return false;
    this.end();
    this.held = this.hover;
    return true;
  }

  /** End now (a click, a view, tab or power change, leaving the page). */
  end(): void {
    this.clearTimer();
    this.set(null);
  }

  /** Leaving the page: no timer may fire afterwards. */
  dispose(): void {
    this.end();
    this.hover = 0;
    this.held = 0;
  }
}
