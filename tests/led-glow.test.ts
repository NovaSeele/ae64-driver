// Part A (DESIGN A-led-glow): the LED lights the whole key on the Lighting page. Keycap glow style, the colour → glow
// helper, legend contrast on the tinted face for every theme, and the continuous edge band.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import Keycap from '../src/components/keyboard/Keycap.vue';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import { bandGradient, bandStopColor, ledGlow, parseLedColor } from '../src/ledGlow';
import { LIT_MARGIN, faceLook, litMask } from '../src/components/keyboard/liveLedPainter';
import type { LitGeometry } from '../src/components/keyboard/liveLedPainter';
import { contrast, luminance } from '../src/colorInk';
import { MockTransport, PHYSICAL_KEYS, STRIP_SIDES } from '../src/protocol';
import { stripRing } from '../src/protocol/ledLayout';
import { setLocale } from '../src/i18n/locale';
import { useDeviceStore } from '../src/stores/device';
import { useLightingStore } from '../src/stores/lighting';
import LightingPage from '../src/pages/LightingPage.vue';

vi.setConfig({ testTimeout: 30000 });

describe('Keycap glow style', () => {
  it('lights the key: no LED bar, .cap--glow, --led and --led-level on the cap', () => {
    const w = mount(Keycap, { props: { legend: 'A', ledStyle: 'glow', color: '#ff0000', glow: { led: '#ff0000', level: 0.251 } } });
    const cap = w.find('.cap');
    expect(w.find('.cap__led').exists()).toBe(false);
    expect(cap.classes()).toContain('cap--glow');
    const style = (cap.element as HTMLElement).style;
    expect(style.getPropertyValue('--led')).toBe('#ff0000');
    expect(style.getPropertyValue('--led-level')).toBe('0.251');
  });

  it('an LED that is off leaves the key normal: no bar, no glow class, no LED variables', () => {
    const w = mount(Keycap, { props: { legend: 'A', ledStyle: 'glow', color: '#ff0000' } });
    expect(w.find('.cap__led').exists()).toBe(false);
    expect(w.find('.cap').classes()).not.toContain('cap--glow');
    expect((w.find('.cap').element as HTMLElement).style.getPropertyValue('--led')).toBe('');
  });

  it('the bar style (default) is unchanged and ignores glow', () => {
    const w = mount(Keycap, { props: { legend: 'A', color: '#00ff00', glow: { led: '#ff0000', level: 1 }, tone: 'var(--k-dks)' } });
    expect(w.find('.cap__led').exists()).toBe(true);
    expect(w.find('.cap').classes()).not.toContain('cap--glow');
    const style = (w.find('.cap').element as HTMLElement).style;
    expect(style.getPropertyValue('--led')).toBe('');
    expect(style.getPropertyValue('--metric')).toBe('var(--k-dks)');
  });

  it('keeps the tone next to the glow variables', () => {
    const w = mount(Keycap, { props: { legend: 'A', ledStyle: 'glow', glow: { led: 'var(--ok)', level: 1 }, tone: 'var(--k-dks)' } });
    const style = (w.find('.cap').element as HTMLElement).style;
    expect(style.getPropertyValue('--led')).toBe('var(--ok)'); // parts C and D pass theme colours
    expect(style.getPropertyValue('--metric')).toBe('var(--k-dks)');
  });
});

describe('Keycap glow CSS', () => {
  const src = readFileSync(resolve('src/components/keyboard/Keycap.vue'), 'utf8');
  const css = src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
  const rule = (sel: string) => rules.filter((r) => r.sel === sel).map((r) => r.body).join(';');

  it('the inner glow at the foot is at most 30 % so the ● badge keeps ≥ 3:1 with a white LED', () => {
    // Source of the ceiling: review A pixel measurement on r98 (dot vs. the face 2–3 px away, LED #ffffff, level 1):
    // 55 % gave 2.67–2.76 on the 9 dark themes, 30 % gives 3.46–3.54 (light themes ≥ 14.5).
    const inner = /--led-inner:\s*inset[^;]*color-mix\(in srgb, var\(--led\) calc\((\d+(?:\.\d+)?)% \* var\(--lv\)\), transparent\)/.exec(rule('.cap.cap--glow'));
    expect(inner).not.toBeNull();
    expect(Number(inner![1])).toBeLessThanOrEqual(30);
  });

  it('the badge on a glowing key is --fg-1', () => {
    expect(rule('.cap.cap--glow .cap__badge, .cap .cap__face--live .cap__badge')).toMatch(/color:\s*var\(--fg-1\)/);
  });

  it('a glowing face has no transition (live colours up to ~60 Hz would keep 64 fades running)', () => {
    expect(rule('.cap.cap--glow .cap__face')).toMatch(/transition:\s*none/);
    expect(rule('.cap .cap__face.cap__face--live')).toMatch(/transition:\s*none/);
    for (const r of rules.filter((x) => x.sel.includes('cap--glow') || x.sel.includes('cap__face--live'))) {
      expect(r.body, r.sel).not.toMatch(/transition[^;]*(background|box-shadow|all)/);
    }
  });

  it('the live painter draws these rules: faceLook() + litMask() = .cap--glow and KeyboardView focus, the LED split off (LED60)', () => {
    const kvSrc = readFileSync(resolve('src/components/keyboard/KeyboardView.vue'), 'utf8');
    const kvCss = kvSrc.slice(kvSrc.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
    const kv = [...kvCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim().replace(/\s+/g, ' '), body: m[2] }));
    const kvRule = (sel: string) => kv.filter((r) => r.sel === sel).map((r) => r.body).join(';');
    const norm = (v: string) => v.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')').trim();
    const decls = (body: string): Record<string, string> => Object.fromEntries(body.split(';').map((d) => d.trim()).filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), norm(d.slice(d.indexOf(':') + 1))]));
    const vars = decls(rule('.cap.cap--glow'));
    expect(Object.keys(vars)).toEqual(['--lv', '--led-top', '--led-bottom', '--led-edge', '--led-inner', '--led-halo']);
    // the tint: the theme's stops x the level (litMask() is given --led-tint-top/bottom and the level)
    expect(vars['--led-top']).toBe('calc(var(--led-tint-top) * var(--lv))');
    expect(vars['--led-bottom']).toBe('calc(var(--led-tint-bottom) * var(--lv))');
    const share = (name: string) => Number(/calc\((\d+(?:\.\d+)?)% \* var\(--lv\)\)/.exec(vars[name])![1]) / 100;
    // the static part of a background: the LED's color-mix taken out of each stop
    const unLed = (v: string) => v.replace(/color-mix\(in srgb, var\(--led\) var\(--led-(?:top|bottom)\), (var\([^()]*\))\)/g, '$1');
    const border = (v: string) => {
      const m = /^color-mix\(in srgb, var\(--led\) calc\((\d+(?:\.\d+)?)% \* var\(--lv\)\), (.+)\)$/.exec(v === 'var(--led-edge)' ? vars['--led-edge'] : v);
      return m ? { borderColor: m[2], edge: Number(m[1]) / 100, rim: m[2] !== 'transparent' } : { borderColor: v, edge: 0, rim: true };
    };
    const topLevel = (v: string) => {
      const out: string[] = [];
      let depth = 0, cur = '';
      for (const ch of v) {
        if (ch === '(') depth++;
        if (ch === ')') depth--;
        if (ch === ',' && !depth) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      if (cur.trim()) out.push(cur.trim());
      return out;
    };
    const face = decls(rule('.cap.cap--glow .cap__face'));
    const hover = decls(rule('.cap.cap--glow:hover .cap__face'));
    const selected = decls(rule('.cap.cap--sel.cap--glow .cap__face'));
    const flash = decls(rule('.cap.cap--flash.cap--glow .cap__face'));
    const focus = decls(kvRule('.kb__key:focus-visible :deep(.cap.cap--glow .cap__face)'));
    const focusSel = decls(kvRule('.kb__key:focus-visible :deep(.cap.cap--sel.cap--glow .cap__face)'));
    for (const d of [face, hover, selected, flash, focus, focusSel]) expect(Object.keys(d).length).toBeGreaterThan(0);
    // the selection ring: what the selected rule adds before the glow (.cap__ring draws it, over the halo as in the rule)
    const ringShadow = topLevel(selected['box-shadow']).filter((p) => !p.startsWith('var(--led-')).join(', ');
    expect(ringShadow).toBe('0 0 0 1px var(--bg-1), 0 0 0 3px var(--acc)');
    const shadow = (v: string) => {
      let inner = 0, halo = 0;
      const rest: string[] = [];
      for (const p of topLevel(v)) {
        if (p === 'var(--led-inner)') inner = share('--led-inner');
        else if (p === 'var(--led-halo)') halo = share('--led-halo');
        else rest.push(p);
      }
      const ring = rest.join(', ').startsWith(ringShadow);
      const own = ring ? rest.slice(2) : rest;
      return { boxShadow: own.length ? own.join(', ') : 'none', ring, inner, halo };
    };
    for (let bits = 0; bits < 16; bits++) {
      const st = { hover: !!(bits & 1), selected: !!(bits & 2), focus: !!(bits & 4), flash: !!(bits & 8) };
      // the cascade: face < hover < selected < flash (same specificity, later wins) < KeyboardView focus < focus + selected
      const layers = [face, st.hover && hover, st.selected && selected, st.flash && flash, st.focus && focus, st.focus && st.selected && focusSel]
        .filter((l): l is Record<string, string> => !!l);
      const pick = (prop: string) => layers.reduce<string | undefined>((v, l) => l[prop] ?? v, undefined)!;
      expect(faceLook(st), JSON.stringify(st)).toEqual({ background: unLed(pick('background')), ...border(pick('border-color')), ...shadow(pick('box-shadow')) });
    }
    // litMask(): each part's alpha is its share x the level, the shadows' geometry is the rules'
    const geo: LitGeometry = { w: 54, h: 54, x: 18, y: 18, lw: 90, lh: 90, left: -19, top: -19, border: 1, radius: 7, tintTop: 0.22, tintBottom: 0.38 };
    const svg = (url: string) => decodeURIComponent(/^url\("data:image\/svg\+xml,(.*)"\)$/.exec(url)![1]);
    const geom = (name: string) => vars[name].replace(/ color-mix\(.*$/, '');
    const plain = svg(litMask(geo, faceLook({ hover: false, selected: false, focus: false, flash: false }), 0.5));
    expect(plain).toContain(`box-shadow:${geom('--led-inner')} rgba(0,0,0,${share('--led-inner') * 0.5}),${geom('--led-halo')} rgba(0,0,0,${share('--led-halo') * 0.5})`);
    expect(plain).toContain(`border:1px solid rgba(0,0,0,${share('--led-edge') * 0.5})`);
    expect(plain).toContain('background:linear-gradient(180deg,rgba(0,0,0,0.11),rgba(0,0,0,0.19))');
    expect(plain).toContain('left:18px;top:18px;width:54px;height:54px;border-radius:7px');
    expect(plain).toContain('width="90" height="90"');
    expect(plain).not.toContain('background-clip');
    const hovered = svg(litMask(geo, faceLook({ hover: true, selected: false, focus: false, flash: false }), 1));
    expect(hovered).toContain('border:1px solid rgba(0,0,0,0.8)');
    expect(hovered).toContain('background-clip:padding-box'); // an opaque border: the tint stays inside it
    const flashing = svg(litMask(geo, faceLook({ hover: false, selected: false, focus: false, flash: true }), 1));
    expect(flashing).toContain('border:1px solid transparent');
    expect(flashing).toContain('box-shadow:none');
    // .cap__lit reaches LIT_MARGIN past the face's border box (the face's 1px border, then the halo's room)
    expect(rule('.cap__face')).toMatch(/border:\s*1px solid/);
    expect(rule('.cap .cap__face--live > .cap__lit')).toMatch(new RegExp(`inset:\\s*-${LIT_MARGIN + 1}px`));
  });

  it('the bar style keeps the foot padding of ledHeight without a colour (an uncoloured key lines up with a coloured one)', () => {
    const face = (props: Record<string, unknown>) => (mount(Keycap, { props: { legend: 'A', ...props } }).find('.cap__face').element as HTMLElement).style.paddingBottom;
    expect(face({ ledHeight: 3 })).toBe('8px');
    expect(face({ ledHeight: 3, color: '#ff0000' })).toBe('8px');
    expect(face({ ledHeight: 3, ledStyle: 'glow', glow: { led: '#ff0000', level: 1 } })).toBe('');
    expect(face({})).toBe('');
  });
});

describe('KeyboardView glow', () => {
  const keys = PHYSICAL_KEYS.slice(0, 3);
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('passes glow only in the glow style; color draws the bar otherwise', () => {
    const glow = () => ({ led: '#ff0000', level: 1 });
    const color = () => '#00ff00';
    const g = mount(KeyboardView, { props: { keys, ledStyle: 'glow', glow, color } });
    expect(g.findAll('.cap--glow')).toHaveLength(3);
    expect(g.findAll('.cap__led')).toHaveLength(0);
    const b = mount(KeyboardView, { props: { keys, glow, color } });
    expect(b.findAll('.cap--glow')).toHaveLength(0);
    expect(b.findAll('.cap__led')).toHaveLength(3);
  });

  it('a key whose glow is undefined renders normal', () => {
    const g = mount(KeyboardView, { props: { keys, ledStyle: 'glow', glow: (k: { id: number }) => (k.id === keys[1].id ? { led: '#0000ff', level: 0.5 } : undefined) } });
    expect(g.findAll('.cap').map((c) => c.classes().includes('cap--glow'))).toEqual([false, true, false]);
  });

  it('the dashed focus outline is scoped to glowing keys', () => {
    const src = readFileSync(resolve('src/components/keyboard/KeyboardView.vue'), 'utf8');
    const css = src.slice(src.indexOf('<style')).replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] })).filter((r) => /outline/.test(r.body));
    expect(rules).toHaveLength(4); // glow and its live twin (LED60), each with the selected offset
    const dashed = rules.filter((r) => /dashed/.test(r.body));
    expect(dashed).toHaveLength(2);
    expect(dashed[0].sel).toContain('.cap--glow');
    expect(dashed[1].sel).toContain('.cap__face--live');
    for (const d of dashed) {
      expect(d.body).toMatch(/outline:\s*2px dashed var\(--fg-1\)/);
      expect(d.body).toMatch(/outline-offset:\s*3px/);
    }
    expect(rules.find((r) => r.sel.includes('.cap--sel.cap--glow'))?.body).toMatch(/outline-offset:\s*5px/);
    expect(rules.find((r) => r.sel.includes('.cap--sel .cap__face.cap__face--live'))?.body).toMatch(/outline-offset:\s*5px/);
    for (const r of rules) expect(r.sel).toMatch(/\.cap--glow|\.cap__face--live/); // no outline for the bar style's focus
  });
});

describe('ledGlow', () => {
  it('#000000 and #070707 are off', () => {
    expect(ledGlow('#000000')).toBeUndefined();
    expect(ledGlow('#070707')).toBeUndefined();
    expect(ledGlow('#000007')).toBeUndefined();
  });

  it('#080808 is lit: white at level ≈ 0.031', () => {
    const g = ledGlow('#080808')!;
    expect(g.led).toBe('#ffffff');
    expect(g.level).toBeCloseTo(8 / 255, 3);
  });

  it('a single channel at 8 is enough', () => {
    expect(ledGlow('#000800')).toEqual({ led: '#00ff00', level: 0.031 });
  });

  it('#400000 (25 % red) → #ff0000 at level 0.251', () => {
    expect(ledGlow('#400000')).toEqual({ led: '#ff0000', level: 0.251 });
  });

  it('keeps the hue: #204080 → #4080ff at 0.502', () => {
    expect(ledGlow('#204080')).toEqual({ led: '#4080ff', level: 0.502 });
  });

  it('full colours are unchanged at level 1', () => {
    expect(ledGlow('#73f0c0')).toEqual({ led: '#7affcc', level: 0.941 });
    expect(ledGlow('#ffffff')).toEqual({ led: '#ffffff', level: 1 });
    expect(ledGlow('#FF8000')).toEqual({ led: '#ff8000', level: 1 });
  });

  it('reads the rainbow stand-in hsl()', () => {
    expect(parseLedColor('hsl(0 80% 60%)')!.map(Math.round)).toEqual([235, 71, 71]);
    expect(ledGlow('hsl(0 80% 60%)')).toEqual({ led: '#ff4e4e', level: 0.92 });
    expect(ledGlow('hsl(120, 80%, 60%)')).toEqual({ led: '#4eff4e', level: 0.92 });
    expect(ledGlow('hsl(240 80% 0%)')).toBeUndefined();
  });

  it('reads rgb() and #rgb', () => {
    expect(ledGlow('rgb(64 0 0)')).toEqual({ led: '#ff0000', level: 0.251 });
    expect(ledGlow('#f00')).toEqual({ led: '#ff0000', level: 1 });
  });

  it('anything that is not a colour is off', () => {
    for (const c of [undefined, '', 'var(--bg-1)', 'var(--bg-3)', 'transparent', 'red', '#12345']) expect(ledGlow(c)).toBeUndefined();
  });
});

// ------------------------------------------------------------------ contrast (DESIGN A §4)
type Rgb = [number, number, number];
const THEMES_CSS = readFileSync(resolve('src/styles/themes.css'), 'utf8');
const hexRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;

function themeTokens(): Record<string, { top: Rgb; bottom: Rgb; fg1: Rgb; tintTop: number; tintBottom: number }> {
  const out: Record<string, { top: Rgb; bottom: Rgb; fg1: Rgb; tintTop: number; tintBottom: number }> = {};
  for (const m of THEMES_CSS.matchAll(/\[data-theme='([\w-]+)'\]\s*\{([^}]*)\}/g)) {
    const body = m[2];
    const tok = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(body)?.[1].trim();
    const pct = (name: string) => Number(/^(\d+(?:\.\d+)?)%$/.exec(tok(name) ?? '')?.[1]) / 100;
    out[m[1]] = { top: hexRgb(tok('cap-top')!), bottom: hexRgb(tok('cap-bottom')!), fg1: hexRgb(tok('fg-1')!), tintTop: pct('led-tint-top'), tintBottom: pct('led-tint-bottom') };
  }
  return out;
}
const L = (c: Rgb) => luminance(c[0], c[1], c[2]);
const cr = (a: Rgb, b: Rgb) => contrast(L(a), L(b));
/** color-mix(in srgb, led p, cap): a linear mix of the gamma-encoded channels */
const mix = (led: Rgb, cap: Rgb, p: number): Rgb => led.map((v, i) => v * p + cap[i] * (1 - p)) as Rgb;
const rgbOf = (c: string) => parseLedColor(c)!;

const COLORS: Record<string, string> = {
  'mint #73f0c0': '#73f0c0', white: '#ffffff', red: '#ff0000', green: '#00ff00', blue: '#0000ff', yellow: '#ffff00',
  cyan: '#00ffff', magenta: '#ff00ff', orange: '#ff8000',
  ...Object.fromEntries([0, 60, 120, 180, 240, 300].map((h) => [`rainbow ${h}`, `hsl(${h} 80% 60%)`])),
};
/** src/contrast.txt of the design: tints and the worst pair per theme */
const EXPECTED: Record<string, [number, number, string, number]> = {
  light: [22, 38, 'blue', 5.98], 'indigo-light': [22, 38, 'blue', 6.24], graphite: [11, 27, 'white', 4.76], indigo: [13, 29, 'white', 4.68],
  gold: [11, 27, 'white', 4.76], ember: [15, 31, 'white', 4.72], aurora: [16, 32, 'white', 4.78], mint: [6, 22, 'white', 4.69],
  nord: [5, 21, 'white', 4.73], dracula: [10, 26, 'white', 4.69], rose: [12, 28, 'white', 4.72],
};

describe('legend contrast on a glowing key (DESIGN A §4)', () => {
  const tokens = themeTokens();

  it('reads 11 themes with both tint tokens', () => {
    expect(Object.keys(tokens).sort()).toEqual(Object.keys(EXPECTED).sort());
    for (const [t, v] of Object.entries(tokens)) {
      expect([Math.round(v.tintTop * 100), Math.round(v.tintBottom * 100)], t).toEqual(EXPECTED[t].slice(0, 2));
    }
  });

  it('every theme × 15 LED colours keeps --fg-1 ≥ 4.5:1 on both ends of the face, worst pair as in contrast.txt', () => {
    for (const [t, v] of Object.entries(tokens)) {
      let worst = { name: '', r: Infinity };
      for (const [name, c] of Object.entries(COLORS)) {
        const led = rgbOf(c).map(Math.round) as Rgb;
        for (const [cap, p] of [[v.top, v.tintTop], [v.bottom, v.tintBottom]] as const) {
          const r = cr(v.fg1, mix(led, cap, p));
          expect(r, `${t} ${name}`).toBeGreaterThanOrEqual(4.5);
          if (r < worst.r) worst = { name, r };
        }
      }
      expect(worst.name, t).toBe(EXPECTED[t][2]);
      expect(Number(worst.r.toFixed(2)), t).toBe(EXPECTED[t][3]);
    }
    const all = Object.entries(EXPECTED).sort((a, b) => a[1][3] - b[1][3])[0];
    expect(all[0]).toBe('indigo');
  });

  it('as drawn: the normalised colour at level × tint stays ≥ 4.5 for any hue and brightness', () => {
    for (const [t, v] of Object.entries(tokens)) {
      for (let h = 0; h < 360; h += 15) {
        for (const l of [25, 50, 60, 75, 90, 100]) {
          for (const dim of [1, 0.6, 0.25, 0.05]) {
            const raw = rgbOf(`hsl(${h} 100% ${l}%)`).map((x) => x * dim);
            const hex = `#${raw.map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
            const g = ledGlow(hex);
            if (!g) continue;
            const led = hexRgb(g.led);
            for (const [cap, p] of [[v.top, v.tintTop], [v.bottom, v.tintBottom]] as const) {
              expect(cr(v.fg1, mix(led, cap, p * g.level)), `${t} ${hex}`).toBeGreaterThanOrEqual(4.5);
            }
          }
        }
      }
    }
  });
});

// ------------------------------------------------------------------ edge band (DESIGN A §3.3)
const lit = (c: string) => ledGlow(c);

describe('bandGradient', () => {
  const pos3 = [1 / 6, 0.5, 5 / 6];

  it('runs through the side colours in place order, left to right on top', () => {
    const g = bandGradient('top', pos3.map((pos, i) => ({ pos, glow: lit(['#ff0000', '#00ff00', '#0000ff'][i]) })))!;
    expect(g.startsWith('linear-gradient(90deg, ')).toBe(true);
    const order = ['#ff0000', '#00ff00', '#0000ff'].map((c) => g.indexOf(c));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(g).toContain('color-mix(in srgb, #ff0000 100%, transparent) 16.67%');
    expect(g).toContain('#0000ff 100%, transparent) 83.33%');
  });

  it('bottom and left run backwards like .led--bottom / .led--left', () => {
    const leds = pos3.map((pos, i) => ({ pos, glow: lit(['#ff0000', '#00ff00', '#0000ff'][i]) }));
    const bottom = bandGradient('bottom', leds)!;
    expect(bottom.startsWith('linear-gradient(90deg, ')).toBe(true);
    expect(bottom.indexOf('#0000ff')).toBeLessThan(bottom.indexOf('#ff0000'));
    expect(bottom).toContain('#0000ff 100%, transparent) 16.67%');
    const left = bandGradient('left', leds)!;
    expect(left.startsWith('linear-gradient(180deg, ')).toBe(true);
    expect(left.indexOf('#0000ff')).toBeLessThan(left.indexOf('#ff0000'));
    const right = bandGradient('right', leds)!;
    expect(right.startsWith('linear-gradient(180deg, ')).toBe(true);
    expect(right.indexOf('#ff0000')).toBeLessThan(right.indexOf('#0000ff'));
  });

  it('an LED that is off is a transparent stop; a dim one is mixed at its level', () => {
    const g = bandGradient('top', [{ pos: 0.25, glow: undefined }, { pos: 0.75, glow: lit('#400000') }])!;
    expect(g).toBe('linear-gradient(90deg, transparent 25%, color-mix(in srgb, #ff0000 25.1%, transparent) 75%)');
    expect(bandStopColor(undefined)).toBe('transparent');
  });

  it('a side with no lit LED has no band', () => {
    expect(bandGradient('right', [{ pos: 0.5, glow: undefined }, { pos: 0.7, glow: lit('#070707') }])).toBeUndefined();
    expect(bandGradient('left', [])).toBeUndefined();
  });
});

describe('Lighting page: glow keys and edge band', () => {
  let page: VueWrapper | null = null;
  async function mountPage(model: 'max' | 'pro') {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo(model);
    ((device.transport as MockTransport) as any).latencyMs = 0;
    const lighting = useLightingStore();
    await lighting.load();
    page = mount(LightingPage, { attachTo: document.body });
    await flushPromises();
    lighting.stopLivePolling();
    await new Promise((r) => setTimeout(r, 250));
    await flushPromises();
    return { lighting };
  }
  /** A live frame as the store publishes it (LED60: painted outside Vue on the next display frame). */
  async function live(lighting: ReturnType<typeof useLightingStore>, keyHex: string | null, strip: string[]) {
    const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const f = lighting.liveFrame;
    if (keyHex) for (const k of useDeviceStore().keys) f.keys.set(rgb(keyHex), (k.row * 21 + k.col) * 3);
    strip.forEach((h, i) => f.strip.set(rgb(h), i * 3));
    f.seq++;
    lighting.livePreview = true;
    lighting.liveError = false;
    lighting.liveHasFrame = true;
    await flushPromises();
    await new Promise((r) => requestAnimationFrame(r));
    await new Promise((r) => requestAnimationFrame(r));
  }
  beforeEach(() => setLocale('vi'));
  afterEach(async () => {
    page?.unmount();
    page = null;
    await flushPromises();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const bands = () => page!.findAll('.ring__band').filter((b) => (b.element as HTMLElement).style.getPropertyValue('--band') !== 'none');
  const sideOf = (index: number) => stripRing().find((l) => l.index === index)!.side;

  for (const model of ['max', 'pro'] as const) {
    it(`${model}: keys glow with no LED bar; the ring has a band per lit side`, async () => {
      const { lighting } = await mountPage(model);
      await live(lighting, '#400000', Array.from({ length: 38 }, () => '#00ff00'));
      expect(page!.findAll('.cap__led')).toHaveLength(0);
      const faces = page!.findAll('.cap__face--live');
      expect(faces.length).toBeGreaterThanOrEqual(60);
      const want = faceLook({ hover: false, selected: false, focus: false, flash: false });
      const st = (faces[0].element as HTMLElement).style;
      expect(st.getPropertyValue('background')).toBe(want.background);
      expect(st.getPropertyValue('box-shadow')).toBe('none');
      // the LED itself is on the face's colour layer
      expect((faces[0].element.querySelector(':scope > .cap__lit > .cap__ledc') as HTMLElement).style.getPropertyValue('background-color')).toBe('rgb(255, 0, 0)');
      expect(page!.find('.ring').classes()).toContain('ring--band');
      expect(bands().map((b) => b.classes().find((c) => /^ring__band--(top|right|bottom|left)$/.test(c)))).toEqual(['ring__band--top', 'ring__band--right', 'ring__band--bottom', 'ring__band--left']);
      for (const b of page!.findAll('.ring__band')) expect(b.attributes('aria-hidden')).toBe('true');
    });
  }

  it('an off side has no band; off LEDs are transparent stops; the band follows the ring order', async () => {
    const { lighting } = await mountPage('max');
    const strip = Array.from({ length: 38 }, () => '#000000');
    const top = [...STRIP_SIDES.top];
    strip[top[0]] = '#ff0000'; // leftmost LED of the top edge (27)
    strip[top[top.length - 1]] = '#0000ff'; // rightmost (1)
    for (const i of STRIP_SIDES.left) strip[i] = '#00ff00';
    await live(lighting, null, strip);
    const sides = bands().map((b) => b.classes().find((c) => /^ring__band--(top|right|bottom|left)$/.test(c)));
    expect(sides).toEqual(['ring__band--top', 'ring__band--left']); // right and bottom are dark
    const topBg = (bands()[0].element as HTMLElement).style.getPropertyValue('--band');
    expect(topBg.startsWith('linear-gradient(90deg, ')).toBe(true);
    expect(topBg.indexOf('#ff0000')).toBeLessThan(topBg.indexOf('#0000ff'));
    expect(topBg.match(/transparent \d/g)?.length).toBe(top.length - 2);
    expect(sideOf(top[0])).toBe('top');
  });

  it('dots: lit ones carry the normalised colour at ≥ 35 %, off ones keep the frame colour', async () => {
    const { lighting } = await mountPage('max');
    const strip = Array.from({ length: 38 }, () => '#000000');
    strip[2] = '#100000'; // level 0.063 → the dot is drawn at 35 %
    strip[3] = '#ff8000';
    await live(lighting, null, strip);
    const color = (n: number) => (page!.find(`.led[data-led="${n}"] .led__dot`).element as HTMLElement).style.getPropertyValue('--led-color');
    expect(color(2)).toBe('color-mix(in srgb, #ff0000 35%, transparent)');
    expect(color(3)).toBe('color-mix(in srgb, #ff8000 100%, transparent)');
    expect(color(4)).not.toContain('color-mix');
  });

  for (const how of ['the new profile is not loaded yet', 'the lighting is being read'] as const) {
    it(`while ${how}, the old colours do not glow: no band, no lit dot, no glowing key`, async () => {
      const { lighting } = await mountPage('max');
      await live(lighting, '#ff0000', Array.from({ length: 38 }, () => '#00ff00'));
      expect(bands()).toHaveLength(4);
      if (how === 'the new profile is not loaded yet') lighting.loadedProfile = null; // as after switching profile
      else lighting.loading = true;
      await flushPromises();
      expect(bands()).toHaveLength(0);
      expect(page!.findAll('.cap--glow')).toHaveLength(0);
      expect(page!.findAll('.cap__face--live')).toHaveLength(0);
      for (const l of page!.findAll('.led')) {
        expect((l.element as HTMLElement).style.getPropertyValue('--led-color')).toBe('var(--bg-3)'); // not the old green
        expect((l.find('.led__dot').element as HTMLElement).style.getPropertyValue('--led-color')).toBe('');
      }
    });
  }
});
