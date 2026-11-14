// DESIGN J §3.6, §11 test 7: the wallpaper guard (port of wallFloors in design/J-appearance/src/jcalc.js) and the colour box
// scan at native resolution. Every number is the reference's (contrast.txt, extremes.txt, ladder.cjs). Pure maths except the
// getPropertyValue case.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { contrast, enc, hexToRgb, lum, MIN_CONTRAST, mix, type Rgb } from '../src/color';
import { ALL_TEXT, GLASS, PAGE_TEXT, readGuardTokens, wallFloors, worstIn, type GuardTokens } from '../src/data/wallpaperGuard';
import { scanBox, TILE } from '../src/data/wallpaperScan';
import { accentFor, themeBase } from '../src/accent';
import { THEMES, type ThemeId } from '../src/theme';
import type { ColourBox } from '../src/data/wallpaperStore';

// ---- each theme's text tokens, from themes.css (all plain hex) ----
const CSS: Record<string, Record<string, string>> = {};
for (const m of readFileSync(resolve('src/styles/themes.css'), 'utf8').matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  const id = /data-theme='([\w-]+)'/.exec(m[1])?.[1];
  if (!id) continue;
  CSS[id] = Object.fromEntries([...m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((d) => [d[1], d[2].trim()]));
}
function tokens(id: ThemeId, acc?: string): GuardTokens {
  const v = (k: string): Rgb => hexToRgb(k === '--acc' && acc ? acc : CSS[id][k]);
  return { bg0: v('--bg-0'), bg2: v('--bg-2'), page: PAGE_TEXT.map(v), all: ALL_TEXT.map(v) };
}

/** jimg.json: the colour boxes of the mockup images, measured at native resolution by ext.mjs. */
const IMG: Record<string, ColourBox> = {
  dusk: { lo: [4, 8, 23], hi: [89, 77, 129] },
  paper: { lo: [203, 214, 196], hi: [252, 242, 241] },
  bright: { lo: [6, 15, 28], hi: [255, 255, 255] },
  'paper+leaf': { lo: [0, 214, 1], hi: [252, 253, 241] },
};
const WORST: ColourBox = { lo: [0, 0, 0], hi: [255, 255, 255] };

/** contrast.txt: the veil floor (%) per theme for worst / dusk / paper / bright / paper+leaf; the panel is 75 % everywhere. */
const FLOORS: Record<ThemeId, [number, number, number, number, number]> = {
  graphite: [87, 48, 86, 87, 87],
  light: [97, 97, 71, 97, 90],
  indigo: [84, 38, 83, 84, 84],
  'indigo-light': [97, 97, 70, 96, 90],
  gold: [87, 48, 86, 87, 87],
  ember: [87, 51, 86, 87, 86],
  aurora: [82, 40, 81, 82, 82],
  mint: [86, 20, 85, 86, 85],
  nord: [85, 6, 84, 85, 85],
  dracula: [87, 31, 86, 87, 86],
  rose: [85, 42, 85, 85, 85],
};
const pct = (x: number) => Math.round(x * 100);

/** Does every text colour reach its target on one pixel at veil o and panel a? (the brute force the box check replaces) */
function pixelOk(t: GuardTokens, px: Rgb, o: number, a: number): boolean {
  return checker(t)(px, o, a);
}
const ratio = (y: number, z: number) => (Math.max(y, z) + 0.05) / (Math.min(y, z) + 0.05);
/** Same check with the text luminances and targets computed once per token set (the random sweep runs 530 000 pixels). */
function checker(t: GuardTokens) {
  const prep = (list: Rgb[], plain: Rgb) => list.map((c) => ({ y: lum(c), tgt: Math.min(MIN_CONTRAST, contrast(c, plain)) - 1e-9 }));
  const page = prep(t.page, t.bg0), glassT = prep(t.all, t.bg0), panelT = prep(t.all, t.bg2);
  return (px: Rgb, o: number, a: number): boolean => {
    const pg = mix(px, t.bg0, o);
    const yp = lum(pg), yg = lum(mix(pg, t.bg0, GLASS)), ya = lum(mix(pg, t.bg2, a));
    return page.every((c) => ratio(c.y, yp) >= c.tgt) && glassT.every((c) => ratio(c.y, yg) >= c.tgt) && panelT.every((c) => ratio(c.y, ya) >= c.tgt);
  };
}

describe('J test 7: the floors of contrast.txt', () => {
  it('veil and panel floors of the 3 images, "paper + leaf" and the worst case on all 11 themes', () => {
    for (const id of THEMES) {
      const t = tokens(id);
      const got = [WORST, IMG.dusk, IMG.paper, IMG.bright, IMG['paper+leaf']].map((b) => wallFloors(b, t));
      expect(got.map((f) => pct(f.overlay)), id).toEqual(FLOORS[id]);
      for (const f of got) {
        expect(f.panel, id).toBe(0.75);
        expect(f.overlayOk).toBe(true);
      }
    }
  });

  it('a custom accent counts: #3a2bd1 with "dusk" is 54 % on Graphite (it applies #8394ff) and 92 % on Light', () => {
    const g = accentFor('#3a2bd1', themeBase('graphite')).vars['--acc'];
    const l = accentFor('#3a2bd1', themeBase('light')).vars['--acc'];
    expect(pct(wallFloors(IMG.dusk, tokens('graphite', g)).overlay)).toBe(54);
    expect(pct(wallFloors(IMG.dusk, tokens('light', l)).overlay)).toBe(92);
  });

  it('the "bright" hint case: a light grey box [g..255] (Graphite / Light)', () => {
    const at = (g: number) => {
      const b: ColourBox = { lo: [g, g, g], hi: [255, 255, 255] };
      return [pct(wallFloors(b, tokens('graphite')).overlay), pct(wallFloors(b, tokens('light')).overlay)];
    };
    expect(at(200)).toEqual([87, 79]);
    expect(at(215)).toEqual([87, 66]);
    expect(at(230)).toEqual([87, 13]);
    expect(at(240)).toEqual([87, 0]);
  });

  it('a strong pixel: "paper" + a #00fd01 block on Light is 90 %, and --acc #6353da on the leaf there is 4.63:1', () => {
    const t = tokens('light');
    const f = wallFloors(IMG['paper+leaf'], t);
    expect(pct(f.overlay)).toBe(90);
    expect(contrast(hexToRgb('#6353da'), mix([0, 253, 1], t.bg0, f.overlay)).toFixed(2)).toBe('4.63');
  });

  it('mutant "two luminance extremes + 15 greys" gives 64 % there, and --acc on the leaf at 64 % is 4.19:1 (< 4.5)', () => {
    const t = tokens('light');
    // the old check (wallFloorsLadder of jcalc.js), with paper's old luminance extremes
    const ext = { bright: [246, 242, 233] as Rgb, dark: [208, 216, 237] as Rgb };
    const lo = lum(ext.dark), hi = lum(ext.bright);
    const pts: Rgb[] = [ext.bright, ext.dark, ...Array.from({ length: 15 }, (_, i) => { const v = enc(Math.min(1, lo + ((hi - lo) * (i + 1)) / 16)); return [v, v, v] as Rgb; })];
    const okOn = (list: Rgb[], bg: Rgb, plain: Rgb) => list.every((c) => contrast(c, bg) >= Math.min(MIN_CONTRAST, contrast(c, plain)) - 1e-9);
    const pageOk = (o: number) => pts.every((p) => { const v = mix(p, t.bg0, o); return okOn(t.page, v, t.bg0) && okOn(t.all, mix(v, t.bg0, GLASS), t.bg0); });
    let o = 0;
    while (o < 1 && !pageOk(o)) o = Math.round((o + 0.01) * 100) / 100;
    expect(pct(o)).toBe(64);
    const onLeaf = contrast(hexToRgb('#6353da'), mix([0, 253, 1], t.bg0, o));
    expect(onLeaf.toFixed(2)).toBe('4.19');
    expect(onLeaf).toBeLessThan(4.5);
  });

  it('the mid-tone text case (ladder.cjs): the box gives 100 %; "only the two extreme pixels" gives 0 % and a grey at 1.00:1', () => {
    const mid: Rgb = [97, 97, 97];
    const t: GuardTokens = { bg0: [16, 18, 22], bg2: [30, 32, 36], page: [mid], all: [] };
    expect(contrast(mid, t.bg0).toFixed(2)).toBe('3.03');
    expect(pct(wallFloors(WORST, t).overlay)).toBe(100);
    // mutant: check only the white and the black pixel
    const okOn = (bg: Rgb) => contrast(mid, bg) >= Math.min(4.5, contrast(mid, t.bg0)) - 1e-9;
    let o = 0;
    const extremes: Rgb[] = [[255, 255, 255], [0, 0, 0]];
    while (o < 1 && !extremes.every((p) => okOn(mix(p, t.bg0, o)))) o = Math.round((o + 0.01) * 100) / 100;
    expect(o).toBe(0);
    let worst = 99;
    for (let g = 0; g <= 255; g++) worst = Math.min(worst, contrast(mid, mix([g, g, g], t.bg0, o)));
    expect(worst.toFixed(2)).toBe('1.00');
  });

  it('random colours in each box (3000 + 8 corners) on every theme: 0 fail at the floor and at every veil above it', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    let tried = 0, failFloor = 0, failAbove = 0;
    for (const id of THEMES) {
      const t = tokens(id);
      const ok = checker(t);
      for (const box of Object.values(IMG)) {
        const f = wallFloors(box, t);
        const corners: Rgb[] = [];
        for (let i = 0; i < 8; i++) corners.push([0, 1, 2].map((k) => ((i >> k) & 1 ? box.hi[k] : box.lo[k])) as unknown as Rgb);
        const pts: Rgb[] = [...corners, ...Array.from({ length: 3000 }, () => [0, 1, 2].map((k) => box.lo[k] + rnd() * (box.hi[k] - box.lo[k])) as unknown as Rgb)];
        for (const p of pts) {
          tried++;
          if (!ok(p, f.overlay, f.panel)) failFloor++;
          for (let o = Math.round((f.overlay + 0.05) * 100) / 100; o <= 1; o = Math.round((o + 0.05) * 100) / 100) if (!ok(p, o, f.panel)) failAbove++;
        }
      }
    }
    expect(tried).toBe(11 * 4 * 3008);
    expect(failFloor).toBe(0);
    expect(failAbove).toBe(0);
  });

  it('the theme target: a colour below 4.5 on its plain surface keeps its own level; o = 1 and a = 1 always pass', () => {
    for (const id of THEMES) {
      const t = tokens(id);
      for (const box of [WORST, ...Object.values(IMG)]) {
        for (const p of [box.lo, box.hi]) expect(pixelOk(t, p, 1, 1), id).toBe(true);
      }
    }
    // worstIn: inside the interval is 1, outside the contrast at the nearer end
    expect(worstIn([128, 128, 128], 0, 1)).toBe(1);
    expect(worstIn([0, 0, 0], 0.5, 1)).toBeCloseTo(0.55 / 0.05, 9);
  });

  it('reads the tokens with getPropertyValue (inline hex on the root, a custom accent included)', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const t = tokens('graphite', '#8394ff');
    const hex = (c: Rgb) => '#' + c.map((x) => x.toString(16).padStart(2, '0')).join('');
    el.style.setProperty('--bg-0', hex(t.bg0));
    el.style.setProperty('--bg-2', hex(t.bg2));
    ALL_TEXT.forEach((k, i) => el.style.setProperty(k, hex(t.all[i])));
    expect(readGuardTokens(el)).toEqual(t);
    expect(readGuardTokens(el).page[3]).toEqual([0x83, 0x94, 0xff]);
    el.remove();
  });
});

describe('J test 7: the colour box at native resolution', () => {
  /** A black 4000 × 3000 image with a 3 × 3 white block at (bx, by), read like the Worker reads it. */
  function image(bx: number, by: number) {
    const W = 4000, H = 3000;
    let calls = 0;
    const read = (x: number, y: number, w: number, h: number) => {
      calls++;
      const d = new Uint8ClampedArray(w * h * 4);
      for (let yy = Math.max(by, y); yy < Math.min(by + 3, y + h); yy++) {
        for (let xx = Math.max(bx, x); xx < Math.min(bx + 3, x + w); xx++) d.fill(255, ((yy - y) * w + (xx - x)) * 4, ((yy - y) * w + (xx - x)) * 4 + 4);
      }
      return d;
    };
    return { W, H, read, calls: () => calls };
  }

  it('a 3 × 3 white block on a black 4000 × 3000 image: hi is white, lo is black; tiles of 1024', () => {
    const im = image(2001, 1503);
    expect(scanBox(im.W, im.H, im.read)).toEqual({ lo: [0, 0, 0], hi: [255, 255, 255] });
    expect(im.calls()).toBe(Math.ceil(4000 / TILE) * Math.ceil(3000 / TILE));
  });

  it('the block across the corner of four tiles (1023..1025) is still found', () => {
    const im = image(1023, 1023);
    expect(scanBox(im.W, im.H, im.read).hi).toEqual([255, 255, 255]);
  });

  it('mutant "average down to 256 px, then take the extremes" loses the block (10 here; [2, 2, 2] in Chromium, extremes.txt)', () => {
    // An area average to 256 px wide: the 3 × 3 block is diluted into a ~16 × 16 cell. Chromium's high-quality resampling
    // (extremes.txt) dilutes it further, to 2. Either way the box is not white, so the test above turns red under it.
    const im = image(2001, 1503);
    const sw = 256, sh = Math.round((256 * 3000) / 4000);
    const full = im.read(0, 0, im.W, im.H);
    let hi = 0;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        const x0 = Math.floor((x * im.W) / sw), x1 = Math.floor(((x + 1) * im.W) / sw);
        const y0 = Math.floor((y * im.H) / sh), y1 = Math.floor(((y + 1) * im.H) / sh);
        let s = 0, n = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { s += full[(yy * im.W + xx) * 4]; n++; }
        hi = Math.max(hi, Math.round(s / n));
      }
    }
    expect(hi).toBe(10);
    expect(scanBox(im.W, im.H, im.read).hi[0]).toBe(255);
  });

  it('a strong pixel sets one corner only: a #00fd01 block on "paper"-like pixels gives lo [0, 214, 1]', () => {
    const px: Rgb[] = [[203, 230, 196], [252, 214, 241], [230, 242, 200], [0, 253, 1]];
    const read = (x: number, y: number, w: number, h: number) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < w * h; i++) { const p = px[(x + y + i) % px.length]; d.set([p[0], p[1], p[2], 255], i * 4); }
      return d;
    };
    expect(scanBox(2, 2, read)).toEqual({ lo: [0, 214, 1], hi: [252, 253, 241] });
  });
});
