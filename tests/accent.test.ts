// DESIGN J §3.2, §3.1, §9, §11 tests 1, 2, 5: the accent maths (port of design/J-appearance/src/jcalc.js and contrastJ.mjs).
// Every number below is the reference's (contrast.txt, vals.cjs, keep.cjs, near2.cjs, pairs.cjs). Pure maths, no DOM.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  SWATCHES, THEME_ROWS, NEAR, accSurfaces, accWorst, accentFor, accentVarsAllThemes, capSurfaces, capWorst, nearest,
  fromOklch, oklabDist, themeBase, themeSemantic, toOklch, type ThemeBase, type ThemeRow,
} from '../src/accent';
import { contrast, hexToRgb, lum, mix, rgbToHex, type Rgb } from '../src/color';
import { THEMES, type ThemeId } from '../src/theme';

// ---- themes.css, read as text (the table in accent.ts must match it) ----

function themeBlocks(css: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  for (const m of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const id = /data-theme='([\w-]+)'/.exec(m[1])?.[1];
    if (!id) continue;
    const toks: Record<string, string> = {};
    for (const d of m[2].matchAll(/(--[\w-]+|color-scheme)\s*:\s*([^;]+);/g)) toks[d[1]] = d[2].trim();
    out[id] = toks;
  }
  return out;
}
// read from disk: vitest hands CSS imports (even ?raw) to its CSS pipeline, which gives an empty string
const CSS = themeBlocks(readFileSync(resolve('src/styles/themes.css'), 'utf8'));
const tok = (id: string, k: string): string => CSS[id][k];
const rgb = (id: string, k: string): Rgb => hexToRgb(tok(id, k));
const pct = (id: string, k: string): number => parseFloat(tok(id, k)) / 100;

// ---- the 72 colours of contrastJ.mjs ----

let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const RANDOM = Array.from({ length: 60 }, () => rgbToHex([rnd() * 255, rnd() * 255, rnd() * 255]));
const EXTREMES = ['#000000', '#ffffff', '#808080', '#ff0000', '#0000ff', '#ffff00', '#00ff00'];
const COLOURS = [...SWATCHES.map((s) => s.hex), ...EXTREMES, ...RANDOM];

/** fg-1 on a selected key: --sel-fill (sel over cap-bottom) and --sel-bg (sel over bg-2), at --sel-pct. */
function legend(id: string, sel: Rgb): number {
  const p = pct(id, '--sel-pct');
  const fg1 = rgb(id, '--fg-1');
  return Math.min(contrast(fg1, mix(rgb(id, '--cap-bottom'), sel, p)), contrast(fg1, mix(rgb(id, '--bg-2'), sel, p)));
}

/** One full pass of test 1 over 11 themes × 72 colours; `variant` replays the mutants on the same maths. */
function sweep(variant: (hex: string, base: ThemeBase) => { acc: string; act: string; onAcc: string; sel: string } = (hex, base) => {
  const v = accentFor(hex, base).vars;
  return { acc: v['--acc'], act: v['--m-actuation'], onAcc: v['--on-acc'], sel: v['--sel'] };
}) {
  let fails = 0;
  const worst = { bg: 99, soft: 99, caps: 99, onAcc: 99, legend: 99 };
  for (const id of THEMES) {
    const base = themeBase(id);
    const ownLegend = legend(id, rgb(id, '--sel'));
    for (const hex of COLOURS) {
      const r = variant(hex, base);
      const acc = hexToRgb(r.acc);
      const act = hexToRgb(r.act);
      const s = accSurfaces(acc, base).map((x) => contrast(acc, x));
      const c = capSurfaces(act, base).map((x) => contrast(act, x));
      const onAcc = contrast(hexToRgb(r.onAcc), acc);
      const lg = legend(id, hexToRgb(r.sel));
      worst.bg = Math.min(worst.bg, ...s.slice(0, 3));
      worst.soft = Math.min(worst.soft, ...s.slice(3));
      worst.caps = Math.min(worst.caps, ...c);
      worst.onAcc = Math.min(worst.onAcc, onAcc);
      worst.legend = Math.min(worst.legend, lg);
      if (Math.min(...s, ...c) < 4.5 || onAcc < 4.5 || lg < Math.min(4.5, ownLegend - 0.3)) fails++;
    }
  }
  return { fails, worst };
}

describe('J test 1: the accent maths on 11 themes × 72 colours', () => {
  it('the theme table of accent.ts matches themes.css (a theme without a row turns this red)', () => {
    expect(Object.keys(CSS).sort()).toEqual([...THEMES].sort());
    expect(Object.keys(THEME_ROWS).sort()).toEqual([...THEMES].sort());
    const map: Record<keyof ThemeRow, string> = {
      scheme: 'color-scheme', softPct: '--soft-pct', bg0: '--bg-0', bg1: '--bg-1', bg2: '--bg-2', sel: '--sel',
      capTop: '--cap-top', capBottom: '--cap-bottom', capHoverTop: '--cap-hover-top', capHoverBottom: '--cap-hover-bottom',
      acc: '--acc', mPress: '--m-press', mRelease: '--m-release', ok: '--ok', warn: '--warn', danger: '--danger',
    };
    for (const id of THEMES) {
      for (const [k, cssKey] of Object.entries(map) as [keyof ThemeRow, string][]) {
        const want = k === 'softPct' ? pct(id, cssKey) : tok(id, cssKey);
        expect(THEME_ROWS[id][k], `${id} ${k}`).toBe(want);
      }
      // the scheme the reference derives from the luminance of bg-0
      expect(THEME_ROWS[id].scheme).toBe(lum(rgb(id, '--bg-0')) > 0.4 ? 'light' : 'dark');
    }
  });

  it('0 fails; worst values as in contrast.txt (bg 5.13, --acc-soft 4.50, keycap 4.50, on-acc 5.25, legend 5.04)', () => {
    const { fails, worst } = sweep();
    expect(fails).toBe(0);
    expect(worst.bg.toFixed(2)).toBe('5.13');
    expect(worst.soft.toFixed(2)).toBe('4.50');
    expect(worst.caps.toFixed(2)).toBe('4.50');
    expect(worst.onAcc.toFixed(2)).toBe('5.25');
    expect(worst.legend.toFixed(2)).toBe('5.04');
  });

  it('colours moved in lightness per theme, as in contrast.txt', () => {
    const moved = Object.fromEntries(THEMES.map((id) => [id, COLOURS.filter((h) => accentFor(h, themeBase(id)).adjusted).length]));
    expect(moved).toEqual({ graphite: 45, light: 55, indigo: 44, 'indigo-light': 55, gold: 45, ember: 39, aurora: 38, mint: 53, nord: 53, dracula: 52, rose: 44 });
  });

  it('mutant "no --m-actuation step" (keycap numbers use --acc): 633 / 792 fail', () => {
    let n = 0;
    for (const id of THEMES) for (const h of COLOURS) if (capWorst(hexToRgb(accentFor(h, themeBase(id)).vars['--acc']), themeBase(id)) < 4.5) n++;
    expect(n).toBe(633);
    const { fails } = sweep((hex, base) => { const v = accentFor(hex, base).vars; return { acc: v['--acc'], act: v['--acc'], onAcc: v['--on-acc'], sel: v['--sel'] }; });
    expect(fails).toBeGreaterThan(0);
  });

  it('mutant "drop the --acc-soft surfaces" (softPct 0): 523 / 792 fail', () => {
    let n = 0;
    for (const id of THEMES) {
      const base = themeBase(id);
      for (const h of COLOURS) if (accWorst(hexToRgb(accentFor(h, { ...base, softPct: 0 }).vars['--acc']), base) < 4.5) n++;
    }
    expect(n).toBe(523);
  });

  it('mutant "threshold 3" and mutant "wrong direction" both fail the sweep', () => {
    // threshold 3: walk only until 3:1 (a colour that passes 3 but not 4.5 is kept as it is)
    const at3 = sweep((hex, base) => {
      const v = accentFor(hex, base).vars;
      const pickedOk = accWorst(hexToRgb(hex), base) >= 3;
      return { acc: pickedOk ? hex : v['--acc'], act: pickedOk ? hex : v['--m-actuation'], onAcc: v['--on-acc'], sel: v['--sel'] };
    });
    expect(at3.fails).toBeGreaterThan(0);
    // wrong direction: a dark theme treated as light (darker), a light one as dark (lighter)
    const flipped = sweep((hex, base) => {
      const v = accentFor(hex, { ...base, scheme: base.scheme === 'dark' ? 'light' : 'dark' }).vars;
      return { acc: v['--acc'], act: v['--m-actuation'], onAcc: v['--on-acc'], sel: v['--sel'] };
    });
    expect(flipped.fails).toBeGreaterThan(0);
  });

  it('accSurfaces(#8394ff, graphite) and capSurfaces(#adbbff, graphite): every value, in §3.2 order', () => {
    const g = themeBase('graphite');
    const acc = hexToRgb('#8394ff');
    const s = accSurfaces(acc, g);
    expect(s.slice(0, 3)).toEqual([[0x18, 0x19, 0x1b], [0x11, 0x12, 0x13], [0x21, 0x23, 0x25]]);
    const soft = (b: number[], i: number) => b[i] * 0.86 + acc[i] * 0.14;
    [[0x18, 0x19, 0x1b], [0x11, 0x12, 0x13], [0x21, 0x23, 0x25]].forEach((b, k) => {
      for (let i = 0; i < 3; i++) expect(s[3 + k][i]).toBeCloseTo(soft(b, i), 9);
    });
    const m = hexToRgb('#adbbff');
    const c = capSurfaces(m, g);
    const faces: [number[], number][] = [[[0x36, 0x38, 0x3b], 0.04], [[0x2b, 0x2d, 0x31], 0.16], [[0x40, 0x42, 0x46], 0.04], [[0x36, 0x38, 0x3b], 0.16]];
    faces.forEach(([b, t], k) => { for (let i = 0; i < 3; i++) expect(c[k][i]).toBeCloseTo(b[i] * (1 - t) + m[i] * t, 9); });
    expect(s).toHaveLength(6);
    expect(c).toHaveLength(4);
  });
});

describe('J test 2: a colour that already passes is kept', () => {
  const g = themeBase('graphite');
  it('#4da3ff on Graphite: --acc #4da3ff, not adjusted, --m-actuation #8cc2ff', () => {
    const r = accentFor('#4da3ff', g);
    expect(r.vars['--acc']).toBe('#4da3ff');
    expect(r.adjusted).toBe(false);
    expect(r.vars['--m-actuation']).toBe('#8cc2ff');
  });
  it('#3a2bd1 on Graphite: --acc #8394ff, adjusted, --m-actuation #adbbff; hue within 2°, the step before fails', () => {
    const r = accentFor('#3a2bd1', g);
    expect(r).toMatchObject({ picked: '#3a2bd1', adjusted: true });
    expect(r.vars['--acc']).toBe('#8394ff');
    expect(r.vars['--m-actuation']).toBe('#adbbff');
    for (const id of THEMES) {
      const base = themeBase(id);
      for (const hex of COLOURS) {
        const x = accentFor(hex, base);
        if (!x.adjusted) continue;
        const p = toOklch(hexToRgb(hex));
        const a = toOklch(hexToRgb(x.vars['--acc']));
        // hue kept (chroma high enough for a hue to mean anything)
        if (p.C > 0.03 && a.C > 0.03) expect(Math.min(Math.abs(p.H - a.H), 360 - Math.abs(p.H - a.H)), `${id} ${hex}`).toBeLessThanOrEqual(2);
      }
    }
    // the move is the smallest: one step (0.005 L) less light does not pass
    const a = toOklch(hexToRgb('#8394ff'));
    const prev = accentFor(rgbToHex(hexToRgb('#8394ff')), g);
    expect(prev.adjusted).toBe(false);
    const p = toOklch(hexToRgb('#3a2bd1'));
    const lessLight = rgbToHex(fromL(a.L - 0.005, p.C, p.H));
    expect(accWorst(hexToRgb(lessLight), g) < 4.5 || contrast(hexToRgb(accentFor(lessLight, g).vars['--on-acc']), hexToRgb(lessLight)) < 4.5).toBe(true);
  });
  it('#808080 (grey, chroma < 0.03) keeps the theme --sel on every theme', () => {
    for (const id of THEMES) expect(accentFor('#808080', themeBase(id)).vars['--sel']).toBe(THEME_ROWS[id].sel);
  });
  it('the values quoted in DESIGN.md (vals.cjs)', () => {
    expect(accentFor('#b57bff', g).vars['--acc']).toBe('#b780ff');
    expect(accentFor('#b57bff', themeBase('light')).vars['--acc']).toBe('#8043c3');
    expect(accentFor('#3a2bd1', themeBase('light')).vars['--acc']).toBe('#3a2bd1');
  });
});

const fromL = (L: number, C: number, H: number): Rgb => fromOklch(L, C, H).map((x) => Math.round(x)) as unknown as Rgb;

/** The swatch table of contrast.txt: --acc / --m-actuation per theme, * = --acc moved. */
const SWATCH_TABLE: Record<ThemeId, string> = {
  graphite: '#4da3ff / #8cc2ff | #8891ff* / #afb9ff | #b780ff* / #cfb0ff | #e46cf0 / #f79cff | #f472b6 / #ffa0ce',
  light: '#0063b6* / #0059a4 | #5555cd* / #4b49bf | #8043c3* / #7436b6 | #a328af* / #9412a1 | #ad3077* / #9f216c',
  indigo: '#4da3ff / #8cc2ff | #8891ff* / #afb9ff | #b67eff* / #ceafff | #e46cf0 / #f79cff | #f472b6 / #ff9ecd',
  'indigo-light': '#0065b8* / #0058a2 | #5555cd* / #4b49bf | #8043c3* / #7436b6 | #a328af* / #9412a1 | #af3179* / #9f216c',
  gold: '#4da3ff / #8cc2ff | #8891ff* / #afb9ff | #b780ff* / #cfb0ff | #e46cf0 / #f79cff | #f472b6 / #ffa0ce',
  ember: '#4da3ff / #70b4ff | #7e85ff* / #a0aaff | #b57bff / #c69fff | #e46cf0 / #f482ff | #f472b6 / #ff88c4',
  aurora: '#4da3ff / #6ab0ff | #7c83ff / #9ca6ff | #b57bff / #c298ff | #e46cf0 / #f37bff | #f472b6 / #ff7fc1',
  mint: '#80bcff* / #c7e1ff | #a8b2ff* / #d8ddff | #cba8ff* / #e7d9ff | #f692ff* / #fcd1ff | #ff95c9* / #ffd3e7',
  nord: '#83bdff* / #c7e1ff | #aab4ff* / #d8ddff | #ccaaff* / #e7d9ff | #f692ff* / #fcd1ff | #ff98cb* / #ffd3e7',
  dracula: '#70b4ff* / #bcdbff | #a0aaff* / #cfd6ff | #c69fff* / #e1cfff | #f482ff* / #fbc7ff | #ff88c4* / #ffc9e1',
  rose: '#4da3ff / #89c0ff | #868fff* / #adb7ff | #b67eff* / #ceafff | #e46cf0 / #f699ff | #f472b6 / #ff9ecd',
};

/** The ⚠ cells (nearest < 0.08) of contrast.txt "Swatch ⚠": theme → swatch → [key, distance, via --m-actuation]. */
const NEAR_CELLS: Record<string, [string, string, boolean]> = {
  'mint blue': ['m-press', '0.025', false],
  'mint indigo': ['m-press', '0.054', false],
  'mint pink': ['danger', '0.072', false],
  'nord indigo': ['m-press', '0.047', false],
  'nord violet': ['m-press', '0.018', false],
  'nord pink': ['danger', '0.074', false],
  'indigo-light pink': ['danger', '0.079', false],
  'rose blue': ['m-press', '0.011', true],
  'rose indigo': ['m-press', '0.049', true],
};

describe('J test 5: the swatches', () => {
  it('what each swatch becomes on each theme (contrast.txt swatch table)', () => {
    for (const id of THEMES) {
      const row = SWATCHES.map((s) => { const r = accentFor(s.hex, themeBase(id)); return `${r.vars['--acc']}${r.adjusted ? '*' : ''} / ${r.vars['--m-actuation']}`; }).join(' | ');
      expect(row, id).toBe(SWATCH_TABLE[id]);
    }
  });

  it('the ⚠ cells are exactly the 9 of contrast.txt; every other cell is >= 0.08 (a new close cell turns this red)', () => {
    const got: Record<string, [string, string, boolean]> = {};
    for (const id of THEMES) {
      for (const s of SWATCHES) {
        const n = nearest(accentFor(s.hex, themeBase(id)).vars, themeSemantic(id));
        if (n.d < NEAR) got[`${id} ${s.id}`] = [n.key, n.d.toFixed(3), n.from === '--m-actuation'];
      }
    }
    expect(got).toEqual(NEAR_CELLS);
  });

  it('a few distances of the table (rule: closest of --acc × 5 and --m-actuation × 2)', () => {
    const d = (id: ThemeId, sw: string) => nearest(accentFor(SWATCHES.find((s) => s.id === sw)!.hex, themeBase(id)).vars, themeSemantic(id)).d.toFixed(3);
    expect(SWATCHES.map((s) => d('graphite', s.id))).toEqual(['0.139', '0.167', '0.202', '0.183', '0.098']);
    expect([d('nord', 'blue'), d('nord', 'magenta'), d('dracula', 'pink'), d('rose', 'violet'), d('rose', 'pink'), d('indigo', 'pink')])
      .toEqual(['0.094', '0.092', '0.081', '0.095', '0.081', '0.085']);
  });

  it('mutant "--acc only": Rose blue and Rose indigo lose their ⚠ (0.113 / 0.139)', () => {
    const accOnly = (sw: string) => {
      const v = accentFor(SWATCHES.find((s) => s.id === sw)!.hex, themeBase('rose')).vars;
      return nearest({ ...v, '--m-actuation': v['--acc'] }, themeSemantic('rose')).d;
    };
    expect(accOnly('blue').toFixed(3)).toBe('0.113');
    expect(accOnly('indigo').toFixed(3)).toBe('0.139');
    expect(accOnly('blue')).toBeGreaterThanOrEqual(NEAR);
    expect(accOnly('indigo')).toBeGreaterThanOrEqual(NEAR);
  });

  it('the swatches stay apart (pairs.cjs): >= 0.065 on 8 themes; Mint 0.051, Nord 0.049, Dracula 0.057', () => {
    const closest = (id: ThemeId) => {
      const accs = SWATCHES.map((s) => hexToRgb(accentFor(s.hex, themeBase(id)).vars['--acc']));
      let m = Infinity;
      for (let i = 0; i < accs.length; i++) for (let j = i + 1; j < accs.length; j++) m = Math.min(m, oklabDist(accs[i], accs[j]));
      return m;
    };
    for (const id of THEMES) {
      if (id === 'mint' || id === 'nord' || id === 'dracula') continue;
      expect(closest(id), id).toBeGreaterThanOrEqual(0.065);
    }
    expect(closest('mint').toFixed(3)).toBe('0.051');
    expect(closest('nord').toFixed(3)).toBe('0.049');
    expect(closest('dracula').toFixed(3)).toBe('0.057');
  });

  it('#66d9b0 on Graphite is close to RT press; #ff5c5c on Ember is close to the error colour', () => {
    expect(nearest(accentFor('#66d9b0', themeBase('graphite')).vars, themeSemantic('graphite'))).toMatchObject({ key: 'm-press' });
    expect(nearest(accentFor('#66d9b0', themeBase('graphite')).vars, themeSemantic('graphite')).d).toBeLessThan(NEAR);
    const e = nearest(accentFor('#ff5c5c', themeBase('ember')).vars, themeSemantic('ember'));
    expect(e.key).toBe('danger');
    expect(e.d).toBeLessThan(NEAR);
  });

  it('accentVarsAllThemes gives the same sets as accentFor on each theme', () => {
    const all = accentVarsAllThemes('#3a2bd1');
    expect(Object.keys(all).sort()).toEqual([...THEMES].sort());
    for (const id of THEMES) expect(all[id]).toEqual(accentFor('#3a2bd1', themeBase(id)).vars);
    expect(all.graphite['--acc']).toBe('#8394ff');
  });
});
