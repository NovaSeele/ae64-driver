// FXP §9: the effects' stand-in patterns (src/data/ledPatterns.ts), one source for the demo keyboard, the effect tiles
// and the "Xem thử" preview. Each test checks the stand-in's own shape at speed 50, measured from frame(): period,
// direction, rate (±10 %) and floor. The approximate effects (11, 12, 18, 19) are checked for their shape only; nothing
// here claims a match with a real keyboard.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frame, rgb, stillAt, typingPresses, PREVIEW_FLOOR } from '../src/data/ledPatterns';
import type { LedPress } from '../src/data/ledPatterns';
import { MockTransport } from '../src/protocol';
import type { LightingBase } from '../src/protocol';

const cell = (row: number, col: number) => row * 21 + col;
const DT = 0.01;
const times = (t0: number, t1: number) => Array.from({ length: Math.round((t1 - t0) / DT) + 1 }, (_, i) => t0 + i * DT);

/** The level of one LED (cell for keys, LED number for the strip) over time; speed 50, one colour unless said. */
function levels(area: number, mode: number, idx: number, ts: number[], direction = 0, rainbow = false): number[] {
  return ts.map((t) => frame(area, mode, 50, direction, rainbow, t)(idx).lvl);
}

/** The lag (s, within ±maxLag) that best matches A(t) to B(t + lag): positive = B follows A. */
function bestLag(A: number[], B: number[], maxLag: number): number {
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const ma = mean(A);
  const mb = mean(B);
  const steps = Math.round(maxLag / DT);
  let best = -Infinity;
  let lag = 0;
  for (let L = -steps; L <= steps; L++) {
    let s = 0;
    for (let k = steps; k < A.length - steps; k++) s += (A[k] - ma) * (B[k + L] - mb);
    if (s > best) { best = s; lag = L; }
  }
  return lag * DT;
}

/** The repeat time (s) of a level series: the first lag ≥ minLag where it matches itself best. */
function period(A: number[], minLag: number, maxLag: number): number {
  const m = A.reduce((s, v) => s + v, 0) / A.length;
  let best = -Infinity;
  let at = 0;
  for (let L = Math.round(minLag / DT); L <= Math.round(maxLag / DT); L++) {
    let s = 0;
    for (let k = 0; k + L < A.length; k++) s += (A[k] - m) * (A[k + L] - m);
    s /= A.length - L;
    if (s > best + 1e-9) { best = s; at = L; }
  }
  return at * DT;
}

const near = (v: number, want: number, rel = 0.1) => {
  expect(v).toBeGreaterThan(want * (1 - rel));
  expect(v).toBeLessThan(want * (1 + rel));
};
const hueDist = (a: number, b: number) => { const d = Math.abs(a - b) % 1; return Math.min(d, 1 - d); };

describe('ledPatterns: the module', () => {
  it('is deterministic: the same arguments give the same frame', () => {
    for (const area of [0, 1]) {
      for (let mode = 0; mode < 20; mode++) {
        const presses: LedPress[] = [{ cell: cell(3, 7), age: 0.2 }];
        const a = frame(area, mode, 37, 1, mode % 2 === 0, 12.345, presses);
        const b = frame(area, mode, 37, 1, mode % 2 === 0, 12.345, presses);
        for (let i = 0; i < (area ? 38 : 126); i++) expect(a(i)).toEqual(b(i));
      }
    }
  });

  it('gives every row 0–5 its own place (no two rows share a y)', () => {
    // the vertical wave's rainbow: hue = −(row/14 − phi·1.46), so each row has its own hue at every instant
    for (const t of [0, 0.7, 2.2]) {
      const f = frame(0, 2, 50, 0, true, t);
      const hues = [0, 1, 2, 3, 4, 5].map((r) => f(cell(r, 4)).hue);
      for (let r = 1; r < 6; r++) near(hues[r - 1] - hues[r], 1 / 14, 0.001);
    }
  });

  it('rgb: the palette colour times level and brightness; the rainbow wheel starts red, blue at 1/3', () => {
    expect(rgb({ hue: 0, lvl: 0.5 }, { r: 200, g: 100, b: 50 }, 0.8)).toEqual([80, 40, 20]);
    const red = rgb({ hue: 0, lvl: 1 }, null, 1);
    const blue = rgb({ hue: 1 / 3, lvl: 1 }, null, 1);
    expect(red.map(Math.round)).toEqual([255, 0, 0]);
    expect(blue.map(Math.round)).toEqual([0, 0, 255]);
    expect(rgb({ hue: 0, lvl: 2 }, null, 0.5).map(Math.round)).toEqual([128, 0, 0]); // level is clamped to 0…1
  });

  it('a preview never paints below 15 % brightness', () => {
    expect(PREVIEW_FLOOR).toBe(15);
  });

  it('every known effect has a still for reduced motion; unknown ones fall back to 0', () => {
    expect(stillAt(0, 4)).toBeGreaterThan(0);
    expect(stillAt(1, 2)).toBeGreaterThan(0);
    expect(stillAt(0, 19)).toBe(0);
    expect(stillAt(5, 0)).toBe(0);
  });

  it('scripted typing: the last three presses, one every 0.6 s, through the given keys in turn', () => {
    const cells = [10, 20, 30];
    expect(typingPresses(0.1, cells)).toEqual([{ cell: 10, age: 0.1 }]);
    const p = typingPresses(1.9, cells);
    expect(p.map((x) => x.cell)).toEqual([10, 30, 20]); // presses 3, 2, 1
    expect(p.map((x) => +x.age.toFixed(3))).toEqual([0.1, 0.7, 1.3]);
    expect(typingPresses(5, [])).toEqual([]);
  });
});

describe('ledPatterns: keys, each stand-in at speed 50 (FXP §9)', () => {
  const ts = times(0, 8);

  it('1 Tĩnh: a still rainbow every 10 columns, blue at the left, the same in every row', () => {
    const a = frame(0, 0, 50, 0, true, 0);
    const b = frame(0, 0, 50, 0, true, 3.3);
    for (let r = 1; r <= 5; r++) {
      expect(hueDist(a(cell(r, 0)).hue, 1 / 3)).toBeLessThan(1e-9);
      for (let c = 0; c + 10 <= 14; c++) expect(hueDist(a(cell(r, c)).hue, a(cell(r, c + 10)).hue)).toBeLessThan(1e-9);
      expect(hueDist(a(cell(r, 0)).hue, a(cell(r, 5)).hue)).toBeCloseTo(0.5, 9);
      for (let c = 0; c <= 14; c++) expect(b(cell(r, c))).toEqual(a(cell(1, c)));
    }
  });

  it('2 Sóng ngang: one band per 16 columns, moving right at ~7 columns/s, floor 15 %', () => {
    const A = levels(0, 1, cell(3, 2), ts);
    const B = levels(0, 1, cell(3, 5), ts);
    const lag = bestLag(A, B, 1);
    expect(lag).toBeGreaterThan(0); // column 5 follows column 2: it moves right
    const v = 3 / lag;
    near(v, 7);
    near(v * period(A, 0.5, 4), 16);
    near(Math.min(...A), 0.15, 0.01);
    expect(Math.max(...A)).toBeCloseTo(1, 2);
    // direction 1 runs the other way
    expect(bestLag(levels(0, 1, cell(3, 2), ts, 1), levels(0, 1, cell(3, 5), ts, 1), 1)).toBeLessThan(0);
  });

  it('3 Sóng dọc: one band per 14 rows, moving down at ~6 rows/s', () => {
    const A = levels(0, 2, cell(1, 6), ts);
    const B = levels(0, 2, cell(4, 6), ts);
    const lag = bestLag(A, B, 1);
    expect(lag).toBeGreaterThan(0); // row 4 follows row 1: it moves down
    const v = 3 / lag;
    near(v, 6);
    near(v * period(A, 0.5, 4), 14);
    near(Math.min(...A), 0.15, 0.01);
  });

  it('4 Gợn sóng: rings centred at col 7, row 2 (a row counts 1.5 columns), moving outward at ~7/s', () => {
    // cells at the same distance from the centre always match
    for (const t of [0.3, 1.1, 2.9]) {
      const f = frame(0, 3, 50, 0, false, t);
      expect(f(cell(2, 4)).lvl).toBeCloseTo(f(cell(2, 10)).lvl, 9);
      expect(f(cell(0, 7)).lvl).toBeCloseTo(f(cell(4, 7)).lvl, 9);
      expect(f(cell(2, 4)).lvl).toBeCloseTo(f(cell(4, 7)).lvl, 9); // 3 columns = 2 rows
    }
    const lag = bestLag(levels(0, 3, cell(2, 7), ts), levels(0, 3, cell(2, 10), ts), 1);
    expect(lag).toBeGreaterThan(0); // the outer cell follows the centre: outward
    near(3 / lag, 7);
  });

  // Six cells on one circle round col 7, row 2.5; rows grow downward, so a falling angle turns counter-clockwise on screen.
  const RING6 = [[1, 5], [0, 7], [1, 9], [4, 9], [5, 7], [4, 5]].map(([r, c]) => ({ cell: cell(r, c), a: Math.atan2(r - 2.5, c - 7) }));
  /** Turns per second for each neighbouring pair (negative = counter-clockwise on screen). */
  function armSpeeds(direction: number): number[] {
    const tt = times(0, 8);
    const series = RING6.map(({ cell: c }) => levels(0, 4, c, tt, direction));
    return RING6.map((_, i) => {
      const j = (i + 1) % RING6.length;
      const lag = bestLag(series[i], series[j], 0.3);
      let da = RING6[j].a - RING6[i].a;
      da = (((da + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
      return da / lag / (2 * Math.PI);
    });
  }

  it('5 Xoáy: one bright arm turning counter-clockwise on screen at ~1 turn/s (review F7); direction 1 the other way', () => {
    const ccw = armSpeeds(0);
    for (const v of ccw) {
      expect(v).toBeLessThan(0);
      expect(Math.abs(v)).toBeGreaterThan(0.75);
      expect(Math.abs(v)).toBeLessThan(1.4);
    }
    for (const v of armSpeeds(1)) expect(v).toBeGreaterThan(0);
    // one arm: each cell on the circle lights once per turn (two arms would light it twice)
    const tt = times(0, 8);
    for (const { cell: c } of RING6) near(period(levels(0, 4, c, tt), 0.3, 1.5), 1 / 1.04);
  });

  it('8 Thở: one breath every 1.3 s, never below 28 % (one colour) or 55 % (rainbow)', () => {
    const A = levels(0, 7, cell(3, 7), ts);
    near(period(A, 0.6, 2.5), 1.3);
    expect(Math.min(...A)).toBeGreaterThanOrEqual(0.28 - 1e-9);
    near(Math.min(...A), 0.28, 0.02);
    expect(Math.max(...A)).toBeCloseTo(1, 2);
    expect(Math.min(...levels(0, 7, cell(3, 7), ts, 0, true))).toBeGreaterThanOrEqual(0.55 - 1e-9);
    // the whole board is one level
    const f = frame(0, 7, 50, 0, false, 0.4);
    expect(f(cell(1, 0)).lvl).toBe(f(cell(5, 14)).lvl);
  });

  it('10 Quét màu: an edge sweeps across in ~0.46 s; one colour is lit left of it and 35 % right of it', () => {
    const tt = times(0, 6);
    for (const t of tt) {
      const f = frame(0, 9, 50, 0, false, t);
      const lit = Array.from({ length: 15 }, (_, c) => f(cell(3, c)).lvl);
      for (const l of lit) expect([1, 0.35]).toContain(l);
      const firstDim = lit.indexOf(0.35);
      if (firstDim >= 0) expect(lit.slice(firstDim).every((l) => l === 0.35)).toBe(true); // lit from the left only
    }
    // the middle key lights once every two sweeps
    const mid = levels(0, 9, cell(3, 7), tt);
    const ons = mid.map((l, i) => (i > 0 && l === 1 && mid[i - 1] !== 1 ? tt[i] : -1)).filter((t) => t >= 0);
    expect(ons.length).toBeGreaterThan(3);
    for (let i = 1; i < ons.length; i++) near((ons[i] - ons[i - 1]) / 2, 0.46);
  });

  it('11 Sóng cong (approximate): U bands with the vertex on the bottom row, moving right to left at ~8/s', () => {
    const A = levels(0, 10, cell(5, 10), ts);
    const B = levels(0, 10, cell(5, 7), ts);
    const lag = bestLag(A, B, 1);
    expect(lag).toBeGreaterThan(0); // column 7 follows column 10: it moves left
    near(3 / lag, 8.2);
    // where the vertex sits, the bottom row is lit and the top is dimmer (a U)
    const f = frame(0, 10, 50, 0, false, 0); // at t = 0 the vertex is between columns 5 and 6
    expect(f(cell(5, 5)).lvl).toBeGreaterThan(0.95);
    expect(f(cell(5, 6)).lvl).toBeGreaterThan(0.95);
    expect(f(cell(1, 5)).lvl).toBeLessThan(0.5);
  });

  it('16 Đốm nảy: one glow on the diagonal, 4.2 s per round trip', () => {
    near(period(levels(0, 15, cell(3, 7), times(0, 12)), 2.5, 6), 4.2);
    for (const t of [0.5, 1.2, 3.0]) { // times with the glow on the board (it runs past the corners)
      const f = frame(0, 15, 50, 0, false, t);
      let best = { lvl: -1, row: 0, col: 0 };
      for (let r = 1; r <= 5; r++) for (let c = 0; c <= 14; c++) { const l = f(cell(r, c)).lvl; if (l > best.lvl) best = { lvl: l, row: r, col: c }; }
      expect(best.lvl).toBeGreaterThan(0.4);
      expect(Math.abs(best.row - (1.25 + (6 * (best.col - 1)) / 18))).toBeLessThanOrEqual(1);
    }
  });

  it('17 Phản hồi khi gõ: dark until a press, then only the pressed key, fading over ~2 s', () => {
    const k = cell(3, 7);
    expect(frame(0, 16, 50, 0, false, 1)(k).lvl).toBe(0);
    const f = frame(0, 16, 50, 0, false, 1, [{ cell: k, age: 0.5 }]);
    expect(f(k).lvl).toBeCloseTo(0.75, 6);
    expect(f(cell(3, 8)).lvl).toBe(0);
    expect(frame(0, 16, 50, 0, false, 1, [{ cell: k, age: 2.1 }])(k).lvl).toBe(0);
  });

  it('18 Phản hồi lan (approximate): the full 3 × 3 block round the key', () => {
    const f = frame(0, 17, 50, 0, false, 1, [{ cell: cell(3, 7), age: 0.1 }]);
    for (let r = 1; r <= 5; r++) {
      for (let c = 0; c <= 14; c++) {
        const inBlock = Math.abs(r - 3) <= 1 && Math.abs(c - 7) <= 1;
        expect(f(cell(r, c)).lvl > 0, `row ${r} col ${c}`).toBe(inBlock);
      }
    }
  });

  it('19 Phản hồi hàng (approximate): the key\'s row, spreading out as the press ages', () => {
    const lit = (age: number) => {
      const f = frame(0, 18, 50, 0, false, 1, [{ cell: cell(3, 7), age }]);
      for (const r of [1, 2, 4, 5]) for (let c = 0; c <= 14; c++) expect(f(cell(r, c)).lvl).toBe(0);
      return Array.from({ length: 15 }, (_, c) => c).filter((c) => f(cell(3, c)).lvl > 0);
    };
    expect(lit(0.02)).toEqual([7]);
    expect(lit(0.1)).toEqual([5, 6, 7, 8, 9]);
    expect(lit(0.3)).toHaveLength(15);
  });
});

describe('ledPatterns: the edge strip (LED numbers run clockwise)', () => {
  const ts = times(0, 8);

  it('S1: a still rainbow every 10 LEDs, by LED number', () => {
    const f = frame(1, 0, 50, 0, true, 2);
    for (let led = 0; led + 10 < 38; led++) expect(hueDist(f(led).hue, f(led + 10).hue)).toBeLessThan(1e-9);
    expect(hueDist(f(0).hue, 1 / 3)).toBeLessThan(1e-9);
  });

  it('S2: one lit run per ring, clockwise at ~16 LEDs/s', () => {
    const lag = bestLag(levels(1, 1, 0, ts), levels(1, 1, 4, ts), 1);
    expect(lag).toBeGreaterThan(0); // LED 4 follows LED 0: clockwise
    near(4 / lag, 16);
    for (const t of [0.4, 1.5, 2.6]) {
      const f = frame(1, 1, 50, 0, false, t);
      const on = Array.from({ length: 38 }, (_, led) => f(led).lvl > 0.5);
      expect(on.filter((v, i) => v && !on[(i + 37) % 38]).length).toBe(1);
    }
  });

  it('S4: mirrored at LED 18 / 37, moving away from LED 18', () => {
    for (const t of [0.3, 1.7, 2.4]) {
      const f = frame(1, 3, 50, 0, false, t);
      for (let k = 1; k < 19; k++) expect(f((18 + k) % 38).lvl).toBeCloseTo(f((18 - k + 38) % 38).lvl, 9);
    }
    expect(bestLag(levels(1, 3, 18, ts), levels(1, 3, 14, ts), 1)).toBeGreaterThan(0);
  });

  it('S5: runs leaving LED 21 both ways and meeting near LED 2', () => {
    for (const t of [0.3, 1.7, 2.4]) {
      const f = frame(1, 4, 50, 0, false, t);
      for (let k = 1; k < 19; k++) expect(f((21 + k) % 38).lvl).toBeCloseTo(f((21 - k + 38) % 38).lvl, 9);
    }
    // runs 9 LEDs apart at ~9 LEDs/s: one a second, so look within half of that
    const out = bestLag(levels(1, 4, 21, ts), levels(1, 4, 24, ts), 0.45);
    expect(out).toBeGreaterThan(0); // away from 21
    near(3 / out, 9);
    expect(bestLag(levels(1, 4, 21, ts), levels(1, 4, 18, ts), 0.45)).toBeGreaterThan(0); // both ways
    // and they meet at LED 2, opposite LED 21: LED 2 is the last to light
    expect(bestLag(levels(1, 4, 37, ts), levels(1, 4, 2, ts), 0.45)).toBeGreaterThan(0);
    expect(bestLag(levels(1, 4, 5, ts), levels(1, 4, 2, ts), 0.45)).toBeGreaterThan(0);
  });
});

describe('the demo keyboard draws from the same module', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('mock frames equal ledPatterns frames (keys and strip, rainbow and one colour)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const mock = new MockTransport({ latencyMs: 0 });
    await mock.getDeviceInfo();
    const m = mock as any;
    for (const [area, mode, paletteIndex] of [[0, 4, 0], [0, 1, 1], [1, 3, 0], [1, 4, 1]] as const) {
      const b: LightingBase = { area, open: true, openMode: 3, mode, brightness: 80, speed: 50, direction: 0, paletteIndex };
      await mock.setLightingBase(b);
      vi.setSystemTime(41_230);
      const prof = m.profiles[m.active];
      const n = area === 0 ? 126 : 38;
      const out: number[] = [];
      for (let p = 0; p * 15 < n; p++) out.push(...m.ledPacket(prof, area, p));
      const pal: number[] | null = paletteIndex === 0 ? null : prof.palette[area].slice(paletteIndex * 4, paletteIndex * 4 + 3); // B, G, R
      const f = frame(area, mode, 50, 0, paletteIndex === 0, 41.23);
      let lit = 0;
      // a record with its own colour (rec[3] = 0xff) keeps it; the demo seeds none on these areas
      expect(prof.leds[area].slice(0, n).some((r: number[]) => r?.[3] === 0xff)).toBe(false);
      for (let i = 0; i < n; i++) {
        const got = [out[i * 4 + 2], out[i * 4 + 1], out[i * 4]];
        if (paletteIndex === 0) {
          const want = rgb(f(i), null, 0.8).map(Math.round);
          expect(got, `area ${area} mode ${mode} led ${i}`).toEqual(want);
        } else {
          // one colour: every LED is the palette colour times the pattern's level
          const k = f(i).lvl * 0.8;
          if (k > 0.2) lit++;
          expect(got).toEqual([Math.round(pal![2] * k), Math.round(pal![1] * k), Math.round(pal![0] * k)]);
        }
      }
      if (paletteIndex !== 0) expect(lit).toBeGreaterThan(0);
    }
  });
});
