// Worker: the colour box of an ImageBitmap (DESIGN J §3.6). A thin layer over scanBox(): each 1024 × 1024 tile is drawn at
// native size on an OffscreenCanvas and read back, so the page never stalls on a 40 MP image.
import { TILE, scanBox } from './wallpaperScan';

self.onmessage = (e: MessageEvent<{ bitmap: ImageBitmap }>) => {
  const { bitmap } = e.data;
  try {
    const cv = new OffscreenCanvas(Math.min(TILE, bitmap.width), Math.min(TILE, bitmap.height));
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2d context');
    const box = scanBox(bitmap.width, bitmap.height, (x, y, w, h) => {
      ctx.clearRect(0, 0, cv.width, cv.height);
      ctx.drawImage(bitmap, x, y, w, h, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    });
    (self as unknown as Worker).postMessage({ box });
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: err instanceof Error ? err.message : String(err) });
  } finally {
    bitmap.close();
  }
};
