// The edge strip drawn as a ring on the keyboard frame (Đèn workbench): where each of the 38 LEDs sits.
import { describe, expect, it } from 'vitest';
import { STRIP_ORDER, STRIP_SIDES, stripRing } from '../src/protocol/ledLayout';

const side = (s: 'top' | 'right' | 'bottom' | 'left') => stripRing().filter((l) => l.side === s);
const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

describe('stripRing', () => {
  it('has 38 entries, each LED index once', () => {
    const ring = stripRing();
    expect(ring).toHaveLength(38);
    expect(ring.map((l) => l.index).sort((a, b) => a - b)).toEqual(range(0, 37));
  });

  it('draws the top edge 27…37, 0, 1 from left to right', () => {
    expect(side('top').map((l) => l.index)).toEqual([...range(27, 37), 0, 1]);
  });

  it('draws the right edge 2…6 from top to bottom', () => {
    expect(side('right').map((l) => l.index)).toEqual(range(2, 6));
  });

  it('draws the bottom edge 7…20 from right to left (LED 7 is bottom right, LED 20 bottom left)', () => {
    expect(side('bottom').map((l) => l.index)).toEqual(range(7, 20));
  });

  it('draws the left edge 21…26 from bottom to top (LED 21 the lowest, LED 26 the highest)', () => {
    expect(side('left').map((l) => l.index)).toEqual(range(21, 26));
  });

  it('runs t from 0 to 1 in drawing order on each side, inside the side', () => {
    for (const s of ['top', 'right', 'bottom', 'left'] as const) {
      const ts = side(s).map((l) => l.t);
      expect(ts).toHaveLength(STRIP_SIDES[s].length);
      for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
      expect(ts[0]).toBeGreaterThan(0);
      expect(ts[ts.length - 1]).toBeLessThan(1);
    }
  });

  it('walks the ring clockwise in the same order as STRIP_ORDER', () => {
    expect(stripRing().map((l) => l.index)).toEqual(STRIP_ORDER);
  });
});
