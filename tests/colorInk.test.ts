import { describe, expect, it } from 'vitest';
import { contrast, inkFor, luminance } from '../src/colorInk';

const DARK_L = luminance(0x11, 0x13, 0x18);
const inkContrast = (r: number, g: number, b: number) => {
  const l = luminance(r, g, b);
  return contrast(l, inkFor(r, g, b) === 'dark' ? DARK_L : 1);
};

describe('swatch ink', () => {
  it('uses dark ink on bright colours', () => {
    expect(inkFor(255, 0, 255)).toBe('dark'); // magenta
    expect(inkFor(255, 105, 180)).toBe('dark'); // hot pink
    expect(inkFor(255, 0, 0)).toBe('dark'); // red
    expect(inkFor(255, 255, 0)).toBe('dark');
    expect(inkFor(255, 255, 255)).toBe('dark');
  });

  it('uses white ink on dark colours', () => {
    expect(inkFor(160, 32, 240)).toBe('light'); // purple
    expect(inkFor(0, 0, 255)).toBe('light');
    expect(inkFor(0, 0, 0)).toBe('light');
  });

  it('keeps at least 4.29:1 across a 16-step RGB grid', () => {
    let min = Infinity;
    for (let r = 0; r < 256; r += 17)
      for (let g = 0; g < 256; g += 17)
        for (let b = 0; b < 256; b += 17) min = Math.min(min, inkContrast(r, g, b));
    expect(min).toBeGreaterThanOrEqual(4.29);
  });
});
