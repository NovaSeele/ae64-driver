// The lighting effects' stand-in patterns (FXP, DESIGN FXP §9): one pure source for the demo keyboard (mock.ts), the
// effect tiles and the "Xem thử" preview on the Lighting page. Display only: nothing here is ever written to a keyboard.
//
// Geometry: the firmware draws on its own cell grid, rows 0–5 × columns 0–14 (cell = row·21 + col). Row 0 has no keys,
// rows 1–5 do, and a key shows its own cell. So x = col / 14 and y = row / 5 (the old cellXy squashed rows 4 and 5 onto
// one y and put no key at y = 0).
//
// Each stand-in was fitted to captures of a real AE64 Max (2026-11-12: keys and strip, rainbow and one colour, speed 50,
// direction 0). The fit and its scores live in the spec workspace, not here. Not measured, so inferred:
// - speed: every capture is at speed 50; how the rate scales with speed keeps the demo's T rule (T = 6 − 5.2·speed/100);
// - direction 1 is not captured: the stand-ins reverse their motion;
// - 17 (mode 16) lights only the pressed key: never captured, the other two reactive effects are block and row;
// - the reactive effects' colours: one capture shows 18 and 19 ignoring a one-colour palette; the stand-ins use the palette;
// - 11, 12, 18 and 19 (modes 10, 11, 17, 18) are approximate: they move the right way at about the right speed, but their
//   shapes match the keyboard less closely than the rest.
// Pure: every function takes `now` (seconds) and never reads a clock.

const COLS = 21;
const LASTCOL = 14;
const RING = 38;

export const frac = (v: number): number => v - Math.floor(v);
const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
/** 0 → 1 → 0 once per unit. */
const tri = (v: number): number => 1 - Math.abs(2 * frac(v) - 1);

/** Fixed hash of (n, salt) to 0…1. */
export function hash01(n: number, salt = 0): number {
  let h = Math.imul(n | 0, 0x85ebca6b) ^ Math.imul(salt + 1, 0x9e3779b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Ring distance between two strip LEDs (LED numbers run clockwise, 0…37). */
export const ringDist = (a: number, b: number): number => {
  const d = Math.abs(a - b) % RING;
  return Math.min(d, RING - d);
};

/** A key press as the reactive effects see it: the LED cell and the seconds since the press. */
export interface LedPress { cell: number; age: number }

/** One LED of a frame: hue on the colour wheel below (cycles) and level 0…1 (multiplies the colour). */
export interface LedSample { hue: number; lvl: number }

/** (cell for the keys, LED number for the strip) → sample. */
export type LedPattern = (index: number) => LedSample;

/**
 * One frame of an area's effect (area 0 keys, 1 edge strip; `mode` is the firmware mode, UI number − 1). The hue wheel is
 * the demo's: 0 red → 1/6 magenta → 1/3 blue → 1/2 cyan → 2/3 green → 5/6 yellow. `presses` feeds the reactive effects.
 * Modes without a known pattern (keys 5, 6, 8 and above 18) get a neutral dim static.
 */
export function frame(area: number, mode: number, speed: number, direction: number, rainbow: boolean, now: number,
  presses: readonly LedPress[] = []): LedPattern {
  const T = 6 - 5.2 * speed / 100;
  const dir = direction ? -1 : 1;
  const phi = now / T;
  const wave = (p: number) => 0.15 + 0.85 * (0.5 + 0.5 * Math.cos(2 * Math.PI * p));
  // about 2 s at speed 50 (18, from free typing); the speed scaling is inferred
  const fade = 0.5 + 3 * (1 - speed / 100);
  const live = presses.filter((p) => p.age >= 0 && p.age < fade);

  if (area === 1) {
    // Strip: LED numbers run clockwise, 0…37.
    const sband = (d: number, A: number, R: number, fl: number) => fl + (1 - fl) * clamp01((A + R - d) / R);
    return (led) => {
      switch (mode) {
        case 1: { // one lit run per ring, clockwise at ~16 LEDs/s; the rainbow turns the same way
          const q = led / RING - dir * phi * 1.43;
          return { hue: -q, lvl: rainbow ? 1 : sband(Math.abs(frac(q) - 0.5) * RING, 2, 8.5, 0.15) };
        }
        // the whole ring breathes every 2.4 s (one colour 4 %…100 %); with the rainbow it stays lit and its colour turns
        case 2: return rainbow
          ? { hue: phi * 1.44, lvl: 1 }
          : { hue: 0, lvl: 0.04 + 0.96 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phi * 1.43)) };
        case 3: { // mirrored at LED 18 / 37: one dip per half, leaving LED 18 at ~8 LEDs/s; the rainbow moves with it
          const p = ringDist(led, 18) / 19 - dir * phi * 1.5;
          return { hue: -p, lvl: rainbow ? 1 : wave(p) };
        }
        case 4: { // runs about 8 LEDs long, 9 apart, leaving LED 21 both ways at ~9 LEDs/s, meeting near LED 2
          const q = ringDist(led, 21) / 9 - dir * phi * 3.4;
          const f = frac(q);
          return { hue: -q, lvl: f < 0.9 ? Math.max(0.03, Math.sin(Math.PI * f / 0.9)) : 0.03 };
        }
        default: return { hue: 1 / 3 + led / 10, lvl: 1 }; // static: one rainbow every 10 LEDs, by LED number
      }
    };
  }

  // Keys (speed 50: phi = t / 3.4 s, so v columns/s = v·3.4 per phi).
  // band(d, A, R, fl): full within A of the band's centre, a linear ramp over R, floor fl outside.
  const band = (d: number, A: number, R: number, fl: number) => fl + (1 - fl) * clamp01((A + R - d) / R);
  return (cell) => {
    const row = Math.floor(cell / COLS);
    const col = cell % COLS;
    const x = col / LASTCOL;
    switch (mode) {
      case 0: return { hue: 1 / 3 + col / 10, lvl: 1 }; // static: one rainbow every 10 columns, blue at the left
      case 1: { // one band per 16 columns, left to right at ~7 columns/s; the rainbow runs the same way
        const q = col / 16 - dir * phi * 1.49;
        return { hue: -q, lvl: rainbow ? 1 : band(Math.abs(frac(q) - 0.5) * 16, 1, 3.5, 0.15) };
      }
      case 2: { // one band per 14 rows, top to bottom at ~6 rows/s (dark most of the time)
        const q = row / 14 - dir * phi * 1.46;
        return { hue: -q, lvl: rainbow ? 1 : band(Math.abs(frac(q) - 0.5) * 14, 0.5, 3.5, 0.15) };
      }
      case 3: { // wide rings from col 7, row 2 (a row counts 1.5 columns), one per 16, outward at ~7/s
        const q = Math.hypot(col - 7, (row - 2) * 1.5) / 16 - dir * phi * 1.49;
        return { hue: -q, lvl: rainbow ? 1 : band(Math.abs(frac(q) - 0.5) * 16, 2.5, 5.5, 0.15) };
      }
      case 4: { // one bright arm turning counter-clockwise on screen about once a second, trailing as it turns
        const kx = col - 7;
        const ky = row - 2.5; // rows grow downward, so a falling angle turns counter-clockwise on screen
        const s = Math.atan2(ky, kx) / (2 * Math.PI) - Math.hypot(kx, ky) / 10 + dir * phi * 3.54;
        return { hue: s, lvl: 0.05 + 0.95 * tri(s) };
      }
      case 7: { // breathing every 1.3 s, never dark (rainbow 55 %, one colour 28 %)
        const lo = rainbow ? 0.55 : 0.28;
        return { hue: 0.17 * Math.floor(phi * 2.6), lvl: lo + (1 - lo) * (0.5 - 0.5 * Math.cos(2 * Math.PI * phi * 2.6)) };
      }
      case 9: { // colour wipe: an edge sweeps across in ~0.46 s, then back; one colour: lit left of it, 35 % right of it
        const w = phi * 7.4;
        const k = Math.floor(w);
        const prog = Math.min(1, frac(w) * 1.05);
        const xs = dir > 0 ? (col + 0.5) / 15 : 1 - (col + 0.5) / 15;
        const even = k % 2 === 0;
        if (!rainbow) return { hue: 0, lvl: (even ? xs <= prog : xs <= 1 - prog) ? 1 : 0.35 };
        const fresh = even ? xs <= prog : xs >= 1 - prog; // the new colour comes in from the left, the next from the right
        return { hue: hash01(fresh ? k : k - 1, 11), lvl: 1 };
      }
      case 10: { // approximate: U bands, vertex on the bottom row, one per ~11 columns, right to left at ~8/s
        const q = frac(col / 11.1 + dir * phi * 2.51) - 0.5;
        const p = row / 5 + 4.5 * q * q;
        const qh = frac(col / 15.5 + dir * phi * 2.74) - 0.5;
        return { hue: -0.6 * (row / 5 + 4 * qh * qh), lvl: rainbow ? 1 : Math.max(0.15, 1 - Math.abs(p - 1) / 0.75) };
      }
      case 11: { // approximate: a V line whose ends run off the board, one per ~14 columns, left to right at ~21/s
        const yc = -0.25 + 6.5 * (1 - tri(col / 14.2 - dir * phi * 5.05));
        return { hue: x - dir * phi, lvl: Math.max(0, 1 - Math.abs(row - yc) / 2) };
      }
      case 12: // every key lit, its own colour drifting
        return { hue: hash01(cell, 3) + phi * 0.25, lvl: rainbow ? 1 : 0.35 + 0.65 * hash01(cell, 5) };
      case 13: { // each key lights at once and fades over ~3 s (about half the board above 50 %)
        const q = phi * 1.13 + hash01(cell);
        const s = frac(q);
        return { hue: hash01(cell, Math.floor(q) + 1), lvl: s < 0.95 ? 1 - s / 0.95 : 0 };
      }
      case 14: { // about 14 % of the keys on at a time, each for ~0.3 s, on and off at once
        const q = phi * 2.125 + hash01(cell);
        const s = frac(q);
        return { hue: hash01(cell, Math.floor(q) + 1), lvl: s < 0.19 && hash01(cell, Math.floor(q) + 9) < 0.75 ? 1 : 0 };
      }
      case 15: { // one soft glow sliding along the diagonal and past the corners, 4.2 s per round trip
        const u = tri(phi * 0.81);
        const cx = 1 + 18 * u;
        const cy = 1.25 + 6 * u;
        return { hue: phi * 0.3, lvl: clamp01(1 - Math.hypot(col - cx, (row - cy) * 1.2) / 4) ** 2 };
      }
      case 16: case 17: case 18: { // reactive: dark until a key is pressed
        let lvl = 0;
        for (const p of live) {
          const pr = Math.floor(p.cell / COLS);
          const pc = p.cell % COLS;
          const k = 1 - p.age / fade;
          if (mode === 16 && p.cell === cell) lvl = Math.max(lvl, k); // inferred, never captured: the pressed key
          else if (mode === 17 && Math.abs(pr - row) <= 1 && Math.abs(pc - col) <= 1) lvl = Math.max(lvl, k); // approximate: a block around the key
          else if (mode === 18 && pr === row && Math.abs(pc - col) <= p.age * 28) lvl = Math.max(lvl, k); // approximate: the key's row; the spread is a stand-in
        }
        return { hue: x, lvl };
      }
      default: return { hue: x, lvl: 0.45 }; // unknown: neutral
    }
  };
}

/** A palette colour, 0…255 per channel. */
export interface Rgb { r: number; g: number; b: number }

/** RGB 0…255 (not rounded) of one sample: the rainbow from the wheel, or the palette colour; k = brightness 0…1. */
export function rgb(px: LedSample, pal: Rgb | null, k: number): [number, number, number] {
  const kk = k * clamp01(px.lvl);
  if (pal) return [pal.r * kk, pal.g * kk, pal.b * kk];
  const h = frac(px.hue) * 6;
  const ch = (n: number) => 255 * kk * clamp01(Math.abs(((h + n) % 6) - 3) - 1);
  return [ch(0), ch(2), ch(4)];
}

/** The time (s) of the still shown under reduced motion: a moment that shows each effect's shape, per area and mode. */
export const STILL: readonly Readonly<Record<number, number>>[] = [
  { 0: 0, 1: 0.57, 2: 1.33, 3: 1.07, 4: 3.54, 7: 1.7, 9: 0.19, 10: 3.18, 11: 2.52, 12: 0, 13: 2.03, 14: 2.73, 15: 3.26, 16: 0.12, 17: 0.12, 18: 0.12 },
  { 0: 0, 1: 0, 2: 3.16, 3: 0, 4: 0.11 },
];
export const stillAt = (area: number, mode: number): number => STILL[area]?.[mode] ?? 0;

/** The reactive key modes (UI 17–19): their previews type by themselves. */
export const isReactive = (area: number, mode: number): boolean => area === 0 && mode >= 16 && mode <= 18;

/** The keys the scripted typing presses, in order. */
export const TYPING_KEYS = ['H', 'E', 'L', 'O', 'A', 'S', 'D', 'K'] as const;
/** One scripted press every this many seconds. */
export const TYPING_EVERY = 0.6;

/** Scripted typing for the reactive previews: the last three presses through `cells` (one every 0.6 s) at `now`. */
export function typingPresses(now: number, cells: readonly number[]): LedPress[] {
  if (!cells.length) return [];
  const out: LedPress[] = [];
  for (let i = 0; i < 3; i++) {
    const n = Math.floor(now / TYPING_EVERY) - i;
    if (n < 0) continue;
    out.push({ cell: cells[((n % cells.length) + cells.length) % cells.length], age: now - n * TYPING_EVERY });
  }
  return out;
}

/** A preview on the big keyboard never shows below this brightness (%), so the shape still shows at 0–14 %. */
export const PREVIEW_FLOOR = 15;
