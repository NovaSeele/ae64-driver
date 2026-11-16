// "Chi tiết" effect tiles (FXP §11): one small canvas per effect button, each a mini keyboard (keys at their real places
// and widths, coloured from their own LED cell) or, on the strip tab, the unlit keys with the 38 ring LEDs around them.
// One shared requestAnimationFrame loop at most 30 frames a second draws every tile straight to its canvas (no Vue render
// per frame). It runs only while the view is Chi tiết, the grid is on screen (IntersectionObserver), the tab is visible,
// the area is on and motion is not reduced. Reduced motion: each tile shows one still (STILL) and never moves. Area off:
// unlit keyboards. Display only: nothing here talks to a keyboard.
import { frame, rgb, stillAt, isReactive, typingPresses } from '../../data/ledPatterns';
import type { Rgb } from '../../data/ledPatterns';
import { LED_MATRIX_COLS } from '../../protocol/constants';
import type { PhysicalKey } from '../../protocol/types';
import type { StripRingLed } from '../../protocol/ledLayout';

/** At most one tile frame per this many ms (30 fps). */
export const TILE_FRAME_MS = 1000 / 30;

export interface TileSpec {
  canvas: HTMLCanvasElement;
  /** firmware mode (UI number − 1) */
  mode: number;
  /** the effect's look is known; an unknown one is an unlit keyboard (the "?" is the page's) */
  known: boolean;
}

export interface TileParams {
  area: 0 | 1;
  open: boolean;
  speed: number;
  direction: number;
  /** the palette colour, null = the rainbow */
  pal: Rgb | null;
  /** the cells the scripted typing presses (reactive effects) */
  typing: readonly number[];
  /** the keyboard picture's dark values: plate, unlit key, unlit ring LED */
  plate: string;
  cap: string;
  ringOff: string;
}

export interface TileGate {
  /** the view is Chi tiết */
  detail: boolean;
  /** the grid is on screen */
  onScreen: boolean;
  /** the browser tab is visible */
  tabVisible: boolean;
  reduced: boolean;
}

interface Tile extends TileSpec {
  ctx: CanvasRenderingContext2D | null;
  w: number;
  h: number;
}

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class TileDriver {
  /** Frames the loop drew (each draws every tile); for tests and measuring. */
  loopFrames = 0;
  /** Tile pictures drawn in all (loop and one-off draws); for tests and measuring. */
  draws = 0;
  private tiles: Tile[] = [];
  private params: TileParams | null = null;
  private gate: TileGate = { detail: false, onScreen: true, tabVisible: true, reduced: false };
  private raf: number | null = null;
  private last = -Infinity;
  private destroyed = false;

  constructor(private readonly keys: () => readonly PhysicalKey[], private readonly ring: readonly StripRingLed[]) {}

  get running(): boolean {
    return this.raf !== null;
  }

  private shouldRun(): boolean {
    const g = this.gate;
    return !this.destroyed && g.detail && g.onScreen && g.tabVisible && !g.reduced && !!this.params?.open && this.tiles.length > 0;
  }

  /** The tiles of the grid now (after Vue rendered them): sized for the screen and drawn once. */
  setTiles(specs: readonly TileSpec[]): void {
    this.tiles = specs.map((s) => ({ ...s, ctx: null, w: 0, h: 0 }));
    this.resize();
  }

  setParams(p: TileParams): void {
    this.params = p;
    this.update();
  }

  setGate(g: Partial<TileGate>): void {
    this.gate = { ...this.gate, ...g };
    this.update();
  }

  /** The canvases may have changed size (window, theme, DPR): resized and drawn again. */
  resize(): void {
    const dpr = Math.min(2, typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1);
    for (const t of this.tiles) {
      const r = t.canvas.getBoundingClientRect();
      t.w = Math.max(1, Math.round(r.width));
      t.h = Math.max(1, Math.round(r.height));
      t.canvas.width = Math.round(t.w * dpr);
      t.canvas.height = Math.round(t.h * dpr);
      let ctx: CanvasRenderingContext2D | null = null;
      try { ctx = t.canvas.getContext('2d'); } catch { ctx = null; }
      t.ctx = ctx;
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    this.update();
  }

  /** Start or stop the loop as the gate says; when it does not run, draw one still picture of each tile. */
  private update(): void {
    if (this.shouldRun()) {
      if (this.raf === null) {
        this.last = -Infinity;
        this.raf = requestAnimationFrame(this.tick);
      }
      return;
    }
    this.stop();
    // stills: reduced motion shows each effect's STILL; area off an unlit keyboard; off screen or a hidden tab draw nothing
    if (!this.gate.detail || this.destroyed) return;
    if (this.gate.reduced || !this.params?.open) this.drawAll(0, true);
  }

  private stop(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
  }

  private readonly tick = (): void => {
    this.raf = null;
    if (!this.shouldRun()) return;
    this.raf = requestAnimationFrame(this.tick);
    const t = now();
    if (t - this.last < TILE_FRAME_MS - 1) return;
    this.last = t;
    this.loopFrames++;
    this.drawAll(t / 1000, false);
  };

  private drawAll(sec: number, still: boolean): void {
    for (const t of this.tiles) this.draw(t, still ? stillAt(this.params?.area ?? 0, t.mode) : sec);
  }

  private draw(t: Tile, sec: number): void {
    this.draws++;
    const p = this.params;
    const ctx = t.ctx;
    if (!p || !ctx) return;
    const keys = this.keys();
    let bw = 0, bh = 0;
    for (const k of keys) { bw = Math.max(bw, k.x + k.w); bh = Math.max(bh, k.y + 1); }
    if (!bw || !bh) return;
    const { w, h } = t;
    const ring = p.area === 1;
    ctx.fillStyle = p.plate;
    ctx.fillRect(0, 0, w, h);
    const pad = ring ? 7 : 2;
    const u = Math.min((w - 2 * pad) / bw, (h - 2 * pad) / bh);
    const ox = (w - u * bw) / 2;
    const oy = (h - u * bh) / 2;
    const lit = p.open && t.known;
    const presses = lit && isReactive(p.area, t.mode) ? typingPresses(sec, p.typing) : [];
    const pattern = lit ? frame(p.area, t.mode, p.speed, p.direction, !p.pal, sec, presses) : null;
    const colour = (i: number): string | null => {
      if (!pattern) return null;
      const [r, g, b] = rgb(pattern(i), p.pal, 1); // full brightness: a low brightness still shows the pattern
      const m = Math.max(r, g, b);
      if (m <= 3) return null;
      const k = 255 / m;
      return `rgba(${(r * k) | 0},${(g * k) | 0},${(b * k) | 0},${(0.15 + 0.85 * m / 255).toFixed(3)})`;
    };
    const gap = Math.max(0.8, u * 0.12);
    for (const k of keys) {
      const x = ox + k.x * u + gap / 2, y = oy + k.y * u + gap / 2, kw = k.w * u - gap, kh = u - gap;
      ctx.fillStyle = p.cap;
      ctx.fillRect(x, y, kw, kh);
      if (!ring) {
        const c = colour(k.row * LED_MATRIX_COLS + k.col);
        if (c) {
          ctx.fillStyle = c;
          ctx.fillRect(x, y, kw, kh);
        }
      }
    }
    if (ring) {
      const x0 = ox - 4, y0 = oy - 4, x1 = ox + u * bw + 4, y1 = oy + u * bh + 4;
      for (const l of this.ring) {
        let px: number, py: number;
        if (l.side === 'top') { px = x0 + (x1 - x0) * l.t; py = y0; }
        else if (l.side === 'right') { px = x1; py = y0 + (y1 - y0) * l.t; }
        else if (l.side === 'bottom') { px = x1 - (x1 - x0) * l.t; py = y1; }
        else { px = x0; py = y1 - (y1 - y0) * l.t; }
        ctx.fillStyle = colour(l.index) ?? p.ringOff;
        ctx.beginPath();
        ctx.arc(px, py, 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
    this.tiles = [];
  }
}
