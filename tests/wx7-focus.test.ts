// WX7 item 1: the keyboard focus ring is at least 3:1 against every surface and keycap of every theme, controls with
// their own box-shadow still show it, and forced-colors mode gets an outline. Reads the CSS sources.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const src = (p: string) => readFileSync(resolve(p), 'utf8').replace(/\r\n/g, '\n');
const themes = src('src/styles/themes.css');

type Rgb = [number, number, number];
const hex = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const lin = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const lum = (c: Rgb) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const contrast = (a: Rgb, b: Rgb) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const over = (top: Rgb, alpha: number, under: Rgb): Rgb => top.map((v, i) => v * alpha + under[i] * (1 - alpha)) as Rgb;

const blocks = [...themes.matchAll(/(?:^|\n)(?::root,\s*)?\[data-theme='([a-z-]+)'\]\s*\{([^}]*)\}/g)].map((m) => ({ name: m[1], body: m[2] }));
const derived = /\n:root,\n\[data-theme\] \{([^}]*)\}/.exec(themes)![1];
const tok = (body: string, k: string) => { const r = new RegExp(`--${k}:[ ]*(#[0-9a-fA-F]{6})`).exec(body); return r ? hex(r[1]) : null; };
const SURFACES = ['bg-0', 'bg-1', 'bg-2', 'bg-3', 'cap-top', 'cap-bottom', 'cap-hover-top', 'cap-hover-bottom'];

/** The ring colour on a surface, from the derived `--focus-ring` (an opaque token, or `--acc-line` = the accent at 45 %). */
function ringOn(body: string, surface: Rgb): Rgb {
  const ring = /--focus-ring:\s*0 0 0 2px var\(--([a-z-]+)\);/.exec(derived);
  expect(ring, '--focus-ring is a 2px ring of one token').not.toBeNull();
  const acc = tok(body, 'acc')!;
  if (ring![1] === 'acc') return acc;
  if (ring![1] === 'acc-line') return over(acc, 0.45, surface);
  const own = tok(body, ring![1]);
  expect(own, `--${ring![1]} is a colour of the theme`).not.toBeNull();
  return own!;
}

describe('WX7 item 1: focus ring contrast', () => {
  it('there are 11 themes, each with the surfaces checked', () => {
    expect(blocks.map((b) => b.name)).toEqual(['graphite', 'light', 'indigo', 'indigo-light', 'gold', 'ember', 'aurora', 'mint', 'nord', 'dracula', 'rose']);
    for (const b of blocks) for (const k of SURFACES) expect(tok(b.body, k), `${b.name} --${k}`).not.toBeNull();
  });

  it('the ring is at least 3:1 against bg-0…bg-3 and the keycap faces in every theme', () => {
    const low: string[] = [];
    for (const b of blocks) {
      for (const k of SURFACES) {
        const s = tok(b.body, k)!;
        const c = contrast(ringOn(b.body, s), s);
        if (c < 3) low.push(`${b.name} ${k} ${c.toFixed(2)}`);
      }
    }
    expect(low).toEqual([]);
  });
});

describe('WX7 item 1: every control shows the ring', () => {
  it('the KeyPicker key (its own box-shadow) carries the ring when focused', () => {
    const css = src('src/components/ui/KeyPicker.vue');
    expect(/\.kp__key\s*\{[^}]*box-shadow:/.test(css)).toBe(true); // why it needs its own rule
    expect(css).toMatch(/\.kp__key:focus-visible\s*\{[^}]*box-shadow:\s*var\(--focus-ring\)/);
  });

  it('the other controls with their own box-shadow carry it too', () => {
    const cases: [string, RegExp][] = [
      ['src/components/advanced/OutputPicker.vue', /\.op__key:focus-visible\s*\{[^}]*var\(--focus-ring\)/],
      ['src/components/advanced/OutputSlot.vue', /\.os:focus-visible\s*\{[^}]*var\(--focus-ring\)/],
      ['src/components/shell/ProfileSelect.vue', /\.ps__item--on:focus-visible\s*\{[^}]*var\(--focus-ring\)/],
      ['src/components/performance/SwitchPicker.vue', /\.sw-opt\[aria-checked='true'\]:focus-visible\s*\{[^}]*var\(--focus-ring\)/],
      ['src/components/keyboard/KeyboardView.vue', /\.kb__key:focus-visible :deep\(\.cap__face\)\s*\{\s*box-shadow:\s*var\(--focus-ring\)/],
      ['src/components/ui/Slider.vue', /\.sl__thumb:focus-visible\s*\{\s*box-shadow:\s*var\(--focus-ring\)/],
    ];
    for (const [file, re] of cases) expect(src(file), file).toMatch(re);
  });

  // WX7 tail (reviewer FC1): the chosen colour chip's own box-shadow would hide the base ring, and an accent ring can vanish
  // on a chip of the accent's hue: the chip draws an outline in the text colour, outside its "--on" ring.
  it('the Lighting quick chip has a focus outline of its own, outside its chosen ring', () => {
    const css = src('src/pages/LightingPage.vue');
    const rule = css.match(/\.quick__chip:focus-visible\s*\{([^}]*)\}/);
    expect(rule, 'a .quick__chip:focus-visible rule').not.toBeNull();
    expect(rule![1]).toMatch(/outline:\s*2px solid var\(--fg-1\)/);
    const offset = Number((rule![1].match(/outline-offset:\s*(\d+)px/) ?? [])[1]);
    const on = css.match(/\.quick__chip--on\s*\{[^}]*0 0 0 (\d+)px var\(--acc\)/);
    expect(on, 'the chosen chip ring').not.toBeNull();
    expect(offset).toBeGreaterThanOrEqual(Number(on![1])); // drawn beyond the chosen ring, not under it
  });

  it('no focus style draws its ring in the 45 % accent', () => {
    const files = ['src/components/keyboard/KeyboardView.vue', 'src/components/ui/Slider.vue', 'src/styles/base.css'];
    for (const f of files) expect(src(f), f).not.toMatch(/:focus-visible[^{]*\{[^}]*box-shadow:[^;}]*var\(--acc-line\)/);
  });

  it('forced colors: the ring is an outline in the system highlight colour', () => {
    const base = src('src/styles/base.css');
    expect(base).toMatch(/@media \(forced-colors: active\)\s*\{\s*:focus-visible\s*\{\s*outline: 2px solid Highlight !important;/);
  });
});
