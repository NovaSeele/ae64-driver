import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockTransport, STRIP_ORDER } from '../src/protocol';
import type { LightingBase } from '../src/protocol';
import { PHYSICAL_KEYS } from '../src/protocol/layout';

const base = (o: Partial<LightingBase> = {}): LightingBase => ({
  area: 0, open: true, openMode: 3, mode: 0, brightness: 100, speed: 50, direction: 0, paletteIndex: 0, ...o,
});

async function make(): Promise<MockTransport> {
  const mock = new MockTransport({ latencyMs: 0 });
  await mock.getDeviceInfo();
  return mock;
}

/** One frame as 126 (keys) / 38 (strip) [b, g, r] triples at an absolute time. */
function frame(mock: MockTransport, area: number, ms: number): number[][] {
  vi.setSystemTime(ms);
  const m = mock as any;
  const n = area === 0 ? 126 : 38;
  const out: number[] = [];
  for (let p = 0; p * 15 < n; p++) out.push(...m.ledPacket(m.profiles[m.active], area, p));
  return Array.from({ length: n }, (_, i) => [out[i * 4], out[i * 4 + 1], out[i * 4 + 2]]);
}

const lum = (px: number[]) => px[0] + px[1] + px[2];
const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const cellOf = (k: { row: number; col: number }) => k.row * 21 + k.col;

describe('mock LED stand-ins', () => {
  afterEach(() => { vi.useRealTimers(); });
  const fake = () => vi.useFakeTimers({ toFake: ['Date'] });

  it('several modes give visibly different frames at the same instant', async () => {
    fake();
    const mock = await make();
    const seen = new Set<string>();
    for (const mode of [0, 1, 2, 3, 4, 7, 9, 10, 11, 12, 13, 15]) {
      await mock.setLightingBase(base({ mode }));
      seen.add(JSON.stringify(frame(mock, 0, 20_000)));
    }
    expect(seen.size).toBe(12);
  });

  it('the spiral differs from the ripple', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ mode: 3, paletteIndex: 1 }));
    const ripple = frame(mock, 0, 20_300);
    await mock.setLightingBase(base({ mode: 4, paletteIndex: 1 }));
    const spiral = frame(mock, 0, 20_300);
    expect(spiral.filter((px, i) => Math.abs(lum(px) - lum(ripple[i])) > 20).length).toBeGreaterThan(20);
  });

  it('the colour wipe fills from the left', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ mode: 9, paletteIndex: 1 }));
    const f = frame(mock, 0, 0); // phase 0: the wipe has just started
    const early = frame(mock, 0, 1500); // part way through the first colour
    const lvlAt = (fr: number[][], col: number) => Math.max(...PHYSICAL_KEYS.filter((k) => k.col === col).map((k) => lum(fr[cellOf(k)])));
    expect(lvlAt(early, 0)).toBeGreaterThanOrEqual(lvlAt(early, 14));
    expect(lvlAt(f, 14)).toBeLessThan(lvlAt(early, 0) + 1);
    const filledCols = [0, 3, 6, 9, 12, 14].map((c) => lvlAt(early, c));
    for (let i = 1; i < filledCols.length; i++) expect(filledCols[i]).toBeLessThanOrEqual(filledCols[i - 1]);
  });

  it('a reactive mode is dark without presses and lights the pressed key only after one', async () => {
    fake();
    const mock = await make();
    for (const mode of [16, 17, 18]) {
      await mock.setLightingBase(base({ mode, paletteIndex: 1 }));
      expect(frame(mock, 0, 30_000).every((px) => lum(px) === 0), `mode ${mode} dark`).toBe(true);
    }
    const g = key('G');
    await mock.setLightingBase(base({ mode: 16, paletteIndex: 1 }));
    mock.simulatePress(g.id, 4);
    const lit = frame(mock, 0, 30_050);
    expect(lum(lit[cellOf(g)])).toBeGreaterThan(0);
    expect(lit.filter((px) => lum(px) > 0)).toHaveLength(1);
    // the row mode lights the whole row
    await mock.setLightingBase(base({ mode: 18, paletteIndex: 1 }));
    const row = frame(mock, 0, 30_100);
    const rowKeys = PHYSICAL_KEYS.filter((k) => k.row === g.row);
    expect(rowKeys.every((k) => lum(row[cellOf(k)]) > 0)).toBe(true);
    // released and faded: dark again
    mock.simulatePress(g.id, 0);
    expect(frame(mock, 0, 36_000).every((px) => lum(px) === 0)).toBe(true);
  });

  const litKeys = (fr: number[][]) => PHYSICAL_KEYS.map((k) => fr[cellOf(k)]);
  const T = 6 - 5.2 * 50 / 100; // seconds per cycle at the default speed 50

  it('breathing: one colour across the board, fading in and out, the next hue on each breath (p0)', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ mode: 7, paletteIndex: 0 }));
    const at = (cycle: number) => litKeys(frame(mock, 0, (cycle * T) * 1000));
    const peak = (cycle: number) => litKeys(frame(mock, 0, (cycle + 0.5) * T * 1000));
    const a = peak(10);
    const top = Math.max(...a.map(lum));
    expect(top).toBeGreaterThan(0);
    for (const px of a) for (let c = 0; c < 3; c++) expect(Math.abs(px[c] - a[0][c])).toBeLessThanOrEqual(2);
    expect(lum(at(10)[0])).toBeLessThan(lum(a[0]) * 0.3); // dim at the start of a breath, bright at the middle
    const b = peak(11);
    expect(b.map((px) => px.join()).every((s, i) => s !== a[i].join())).toBe(true); // the hue moved
  });

  it('arc wave (keys 11) differs from the horizontal wave', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ mode: 10 }));
    const arc = litKeys(frame(mock, 0, 20_300));
    await mock.setLightingBase(base({ mode: 1 }));
    const horizontal = litKeys(frame(mock, 0, 20_300));
    expect(arc.filter((px, i) => px.join() !== horizontal[i].join()).length).toBeGreaterThan(20);
    // a U shape: the colour in one column changes with the row, unlike the horizontal wave
    const colours = (fr: number[][]) => new Set(PHYSICAL_KEYS.filter((k) => k.col === 6).map((k) => fr[cellOf(k)].join()));
    expect(colours(frame(mock, 0, 20_300)).size).toBe(1); // mode 1 is still set: one colour per column
    await mock.setLightingBase(base({ mode: 10 }));
    expect(colours(frame(mock, 0, 20_300)).size).toBeGreaterThan(1);
  });

  it('strip chase (strip 2): every LED lit, colours shift over time', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ area: 1, mode: 1 }));
    const f0 = frame(mock, 1, 10_000);
    const f1 = frame(mock, 1, 10_800);
    expect(f0.every((px) => lum(px) > 0)).toBe(true);
    expect(f1.every((px) => lum(px) > 0)).toBe(true);
    expect(f0.filter((px, i) => px.join() !== f1[i].join()).length).toBeGreaterThan(20);
  });

  it('static strip (strip 1): the rainbow goes about 3 times around the ring', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ area: 1, mode: 0 }));
    const f = frame(mock, 1, 10_000);
    const hue = ([b, g, r]: number[]) => {
      const mx = Math.max(b, g, r), d = mx - Math.min(b, g, r);
      const h = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return h / 6;
    };
    const hs = STRIP_ORDER.map((led) => hue(f[led]));
    let wraps = 0;
    for (let i = 0; i < hs.length; i++) if (Math.abs(hs[(i + 1) % hs.length] - hs[i]) > 0.5) wraps++; // incl. the step back to the start
    expect(wraps).toBe(3);
  });

  it('starlight (keys 15): about 10 keys flash per frame, averaged over frames', async () => {
    fake();
    const mock = await make();
    await mock.setLightingBase(base({ mode: 14 }));
    let total = 0;
    const N = 40;
    for (let i = 0; i < N; i++) total += litKeys(frame(mock, 0, 10_000 + i * 370)).filter((px) => lum(px) > 0).length;
    const avg = total / N;
    expect(avg).toBeGreaterThan(7);
    expect(avg).toBeLessThan(14);
  });

  it('is deterministic for the same time', async () => {
    fake();
    const mock = await make();
    for (const mode of [12, 13, 14, 15]) {
      await mock.setLightingBase(base({ mode }));
      expect(frame(mock, 0, 50_000)).toEqual(frame(mock, 0, 50_000));
    }
  });
});
