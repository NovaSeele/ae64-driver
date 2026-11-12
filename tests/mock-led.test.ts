import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockTransport } from '../src/protocol';
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

  it('is deterministic for the same time', async () => {
    fake();
    const mock = await make();
    for (const mode of [12, 13, 14, 15]) {
      await mock.setLightingBase(base({ mode }));
      expect(frame(mock, 0, 50_000)).toEqual(frame(mock, 0, 50_000));
    }
  });
});
