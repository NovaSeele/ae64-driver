// The colour box of an image (DESIGN J §3.6, review fixes 3 and 7): the min and max of each channel over every pixel, read at
// native resolution in tiles of 1024 × 1024. Never a downscale: a downscale averages, and a small bright area (a star, a thin
// white line) disappears. Pure: the reader of a tile is passed in (the Worker draws the bitmap; tests use plain arrays).
import type { ColourBox } from './wallpaperStore';

export const TILE = 1024;

/**
 * `readTile(x, y, w, h)` returns the RGBA bytes of that rectangle (row by row, w × h × 4). Alpha is ignored: a transparent
 * pixel counts as its stored colour (black where a PNG was erased), which is stricter, never looser.
 */
export function scanBox(width: number, height: number, readTile: (x: number, y: number, w: number, h: number) => Uint8ClampedArray, tile = TILE): ColourBox {
  let r0 = 255, g0 = 255, b0 = 255, r1 = 0, g1 = 0, b1 = 0;
  for (let y = 0; y < height; y += tile) {
    for (let x = 0; x < width; x += tile) {
      const w = Math.min(tile, width - x);
      const h = Math.min(tile, height - y);
      const d = readTile(x, y, w, h);
      const n = w * h * 4;
      for (let i = 0; i < n; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2];
        if (r < r0) r0 = r; if (r > r1) r1 = r;
        if (g < g0) g0 = g; if (g > g1) g1 = g;
        if (b < b0) b0 = b; if (b > b1) b1 = b;
      }
    }
  }
  if (width <= 0 || height <= 0) return { lo: [0, 0, 0], hi: [0, 0, 0] };
  return { lo: [r0, g0, b0], hi: [r1, g1, b1] };
}
