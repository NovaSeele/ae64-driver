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
    expect(rules).toHaveLength(2);
    const dashed = rules.filter((r) => /dashed/.test(r.body));
    expect(dashed).toHaveLength(1);
    expect(dashed[0].sel).toContain('.cap--glow');
    expect(dashed[0].body).toMatch(/outline:\s*2px dashed var\(--fg-1\)/);
    expect(dashed[0].body).toMatch(/outline-offset:\s*3px/);
    const sel = rules.find((r) => r.sel.includes('.cap--sel.cap--glow'));
    expect(sel?.body).toMatch(/outline-offset:\s*5px/);
    for (const r of rules) expect(r.sel).toContain('.cap--glow'); // no outline for the bar style's focus
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
  beforeEach(() => setLocale('vi'));
  afterEach(async () => {
    page?.unmount();
    page = null;
    await flushPromises();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  const bands = () => page!.findAll('.ring__band');
  const sideOf = (index: number) => stripRing().find((l) => l.index === index)!.side;

  for (const model of ['max', 'pro'] as const) {
    it(`${model}: keys glow with no LED bar; the ring has a band per lit side`, async () => {
      const { lighting } = await mountPage(model);
      lighting.livePreview = true;
      lighting.liveColors = Object.fromEntries(PHYSICAL_KEYS.map((k) => [k.id, '#400000']));
      lighting.liveStripColors = Array.from({ length: 38 }, () => '#00ff00');
      await flushPromises();
      expect(page!.findAll('.cap__led')).toHaveLength(0);
      const caps = page!.findAll('.cap--glow');
      expect(caps.length).toBeGreaterThanOrEqual(60);
      expect((caps[0].element as HTMLElement).style.getPropertyValue('--led')).toBe('#ff0000');
      expect((caps[0].element as HTMLElement).style.getPropertyValue('--led-level')).toBe('0.251');
      expect(page!.find('.ring').classes()).toContain('ring--band');
      expect(bands().map((b) => b.classes().find((c) => c.startsWith('ring__band--')))).toEqual(['ring__band--top', 'ring__band--right', 'ring__band--bottom', 'ring__band--left']);
      for (const b of bands()) expect(b.attributes('aria-hidden')).toBe('true');
    });
  }

  it('an off side is not rendered; off LEDs are transparent stops; the band follows the ring order', async () => {
    const { lighting } = await mountPage('max');
    lighting.livePreview = true;
    const strip = Array.from({ length: 38 }, () => '#000000');
    const top = [...STRIP_SIDES.top];
    strip[top[0]] = '#ff0000'; // leftmost LED of the top edge (27)
    strip[top[top.length - 1]] = '#0000ff'; // rightmost (1)
    for (const i of STRIP_SIDES.left) strip[i] = '#00ff00';
    lighting.liveStripColors = strip;
    await flushPromises();
    const sides = bands().map((b) => b.classes().find((c) => c.startsWith('ring__band--')));
    expect(sides).toEqual(['ring__band--top', 'ring__band--left']); // right and bottom are dark
    const topBg = (bands()[0].element as HTMLElement).style.getPropertyValue('--band');
    expect(topBg.startsWith('linear-gradient(90deg, ')).toBe(true);
    expect(topBg.indexOf('#ff0000')).toBeLessThan(topBg.indexOf('#0000ff'));
    expect(topBg.match(/transparent \d/g)?.length).toBe(top.length - 2);
    expect(sideOf(top[0])).toBe('top');
  });

  it('dots: lit ones carry the normalised colour at ≥ 35 %, off ones keep the frame colour', async () => {
    const { lighting } = await mountPage('max');
    lighting.livePreview = true;
    const strip = Array.from({ length: 38 }, () => '#000000');
    strip[2] = '#100000'; // level 0.063 → the dot is drawn at 35 %
    strip[3] = '#ff8000';
    lighting.liveStripColors = strip;
    await flushPromises();
    const color = (n: number) => (page!.find(`.led[data-led="${n}"]`).element as HTMLElement).style.getPropertyValue('--led-color');
    expect(color(2)).toBe('color-mix(in srgb, #ff0000 35%, transparent)');
    expect(color(3)).toBe('color-mix(in srgb, #ff8000 100%, transparent)');
    expect(color(4)).not.toContain('color-mix');
  });
});
