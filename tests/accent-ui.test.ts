// DESIGN J §3.1, §3.3, §7, §11 tests 3, 4, 14 (and the ColorPicker `recent` prop, the ThemePicker tiles, the AccentPicker
// row): applying and removing the five tokens, the early copy in theme-boot.js, the strings. No keyboard here.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import AccentPicker from '../src/components/settings/AccentPicker.vue';
import ThemePicker from '../src/components/settings/ThemePicker.vue';
import ColorPicker from '../src/components/ui/ColorPicker.vue';
import { setTheme, THEMES } from '../src/theme';
import { ACC_VAR_KEYS, ACCENT_KEY, ACCENT_VARS_KEY, accentState, applyAccent, readAccentState } from '../src/accentCache';
import { accentFor, accentVarsAllThemes, setAccent, SWATCHES, themeBase } from '../src/accent';
import { RECENT_KEY } from '../src/components/ui/recentColors';
import { hexToRgb, lum } from '../src/color';
import { setLocale } from '../src/i18n/locale';
import { vi as viDict } from '../src/i18n/vi';
import { en } from '../src/i18n/en';
import { t } from '../src/i18n/vi';

const root = document.documentElement;
const inline = () => ACC_VAR_KEYS.filter((k) => root.style.getPropertyValue(k) !== '');
const inlineVars = () => Object.fromEntries(ACC_VAR_KEYS.map((k) => [k, root.style.getPropertyValue(k)]));
let wrapper: VueWrapper | null = null;

beforeAll(() => {
  const st = document.createElement('style');
  st.textContent = readFileSync(resolve('src/styles/themes.css'), 'utf8');
  document.head.appendChild(st);
});
beforeEach(() => {
  setLocale('vi');
  setAccent(null);
  setTheme('graphite');
  localStorage.clear();
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  setAccent(null);
  setTheme('graphite');
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('J test 3: apply and remove', () => {
  it('a custom colour puts exactly the 5 tokens of the theme open now on :root, and stores the colour and its cache', () => {
    setAccent('#3a2bd1');
    expect(inline().sort()).toEqual([...ACC_VAR_KEYS].sort());
    expect(inlineVars()).toEqual(accentFor('#3a2bd1', themeBase('graphite')).vars);
    expect(root.style.getPropertyValue('--acc')).toBe('#8394ff');
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#3a2bd1');
    const c = JSON.parse(localStorage.getItem(ACCENT_VARS_KEY)!);
    expect(c).toMatchObject({ v: 1, hex: '#3a2bd1' });
    expect(Object.keys(c.themes).sort()).toEqual([...THEMES].sort());
    expect(c.themes).toEqual(accentVarsAllThemes('#3a2bd1'));
    // inline beats the theme block: what the page computes
    expect(getComputedStyle(root).getPropertyValue('--acc').trim()).toBe('#8394ff');
  });

  it('a theme change applies that theme\'s set (Light: #3a2bd1 kept as it is)', () => {
    setAccent('#3a2bd1');
    setTheme('light');
    expect(inlineVars()).toEqual(accentFor('#3a2bd1', themeBase('light')).vars);
    expect(root.style.getPropertyValue('--acc')).toBe('#3a2bd1');
    setTheme('nord');
    expect(inlineVars()).toEqual(accentFor('#3a2bd1', themeBase('nord')).vars);
  });

  it('"Theme colour": 0 inline tokens, both keys gone, --acc computes to the theme\'s own', () => {
    setAccent('#3a2bd1');
    setAccent(null);
    expect(inline()).toEqual([]);
    expect(localStorage.getItem(ACCENT_KEY)).toBeNull();
    expect(localStorage.getItem(ACCENT_VARS_KEY)).toBeNull();
    expect(getComputedStyle(root).getPropertyValue('--acc').trim()).toBe('#c4bbff');
    setTheme('light');
    expect(getComputedStyle(root).getPropertyValue('--acc').trim()).toBe('#6353da');
  });

  it('applyAccent(vars, el) / applyAccent(null, el) on any element', () => {
    const el = document.createElement('div');
    applyAccent(accentFor('#4da3ff', themeBase('graphite')).vars, el);
    expect(el.style.getPropertyValue('--m-actuation')).toBe('#8cc2ff');
    applyAccent(null, el);
    expect(el.getAttribute('style') ?? '').toBe('');
  });

  it('--acc-hover is lighter than --acc on a dark theme and darker on a light one (every theme, every swatch, #3a2bd1)', () => {
    for (const id of THEMES) {
      const b = themeBase(id);
      for (const hx of [...SWATCHES.map((s) => s.hex), '#3a2bd1']) {
        const v = accentFor(hx, b).vars;
        const [a, h] = [lum(hexToRgb(v['--acc'])), lum(hexToRgb(v['--acc-hover']))];
        if (b.scheme === 'dark') expect(h, `${id} ${hx}`).toBeGreaterThanOrEqual(a);
        else expect(h, `${id} ${hx}`).toBeLessThan(a);
      }
    }
  });

  it('another tab writes the colour before its cache: the colour applied now stays until the new cache arrives', () => {
    setAccent('#4da3ff');
    const blue = inlineVars();
    localStorage.setItem(ACCENT_KEY, '#b57bff'); // the other tab's first write; ae64.accentVars still holds blue's set
    window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_KEY }));
    expect(inlineVars()).toEqual(blue);
    expect(accentState.value.hex).toBe('#4da3ff');
    localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify({ v: 1, hex: '#b57bff', themes: accentVarsAllThemes('#b57bff') }));
    window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_VARS_KEY }));
    expect(root.style.getPropertyValue('--acc')).toBe('#b780ff');
  });

  it('another tab: follows once the colour and its cache agree; never writes', () => {
    const vars = accentVarsAllThemes('#b57bff');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    localStorage.setItem(ACCENT_KEY, '#b57bff');
    set.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_KEY }));
    expect(inline()).toEqual([]); // the cache has not arrived yet
    localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify({ v: 1, hex: '#b57bff', themes: vars }));
    set.mockClear();
    window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_VARS_KEY }));
    expect(root.style.getPropertyValue('--acc')).toBe('#b780ff');
    expect(set).not.toHaveBeenCalled();
    localStorage.removeItem(ACCENT_KEY);
    window.dispatchEvent(new StorageEvent('storage', { key: ACCENT_KEY }));
    expect(inline()).toEqual([]);
  });

  it('start-up: a colour without its cache rebuilds it (maths loaded on demand); a cache without a colour is removed', async () => {
    vi.resetModules();
    setAccent(null);
    localStorage.setItem(ACCENT_KEY, '#3a2bd1');
    localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify({ v: 1, hex: '#000000', themes: {} }));
    const cache = await import('../src/accentCache');
    await import('../src/theme');
    await vi.waitFor(() => expect(cache.accentState.value.cache).not.toBeNull());
    expect(JSON.parse(localStorage.getItem(ACCENT_VARS_KEY)!).hex).toBe('#3a2bd1');
    expect(root.style.getPropertyValue('--acc')).toBe('#8394ff');
    vi.resetModules();
    localStorage.removeItem(ACCENT_KEY);
    await import('../src/theme');
    expect(localStorage.getItem(ACCENT_VARS_KEY)).toBeNull();
    vi.resetModules();
  });

  it('readAccentState refuses a cache with a missing theme, a non-hex value or another colour', () => {
    const ok = { v: 1, hex: '#3a2bd1', themes: accentVarsAllThemes('#3a2bd1') };
    localStorage.setItem(ACCENT_KEY, '#3a2bd1');
    const read = (c: unknown) => { localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify(c)); return readAccentState(THEMES).cache; };
    expect(read(ok)).not.toBeNull();
    const { rose: _r, ...noRose } = ok.themes;
    expect(read({ ...ok, themes: noRose })).toBeNull();
    expect(read({ ...ok, themes: { ...ok.themes, nord: { ...ok.themes.nord, '--sel': 'red' } } })).toBeNull();
    expect(read({ ...ok, hex: '#000000' })).toBeNull();
    expect(read({ ...ok, v: 2 })).toBeNull();
    localStorage.setItem(ACCENT_KEY, '#3A2BD1');
    expect(readAccentState(THEMES)).toEqual({ hex: null, cache: null });
  });
});

describe('J test 4: theme-boot.js copies the cache before the first paint', () => {
  const BOOT = readFileSync(resolve('public/theme-boot.js'), 'utf8');
  const run = (light = false) => {
    for (const k of ACC_VAR_KEYS) root.style.removeProperty(k);
    root.removeAttribute('data-theme');
    const had = Object.getOwnPropertyDescriptor(window, 'matchMedia');
    Object.defineProperty(window, 'matchMedia', { configurable: true, writable: true, value: (q: string) => ({ matches: light && q.includes('light'), media: q, addEventListener() {}, removeEventListener() {} }) });
    try {
      // eslint-disable-next-line no-new-func
      new Function(BOOT)();
    } finally {
      if (had) Object.defineProperty(window, 'matchMedia', had);
      else delete (window as { matchMedia?: unknown }).matchMedia;
    }
  };
  const cacheOf = (hex: string) => JSON.stringify({ v: 1, hex, themes: accentVarsAllThemes(hex) });
  afterEach(() => { for (const k of ACC_VAR_KEYS) root.style.removeProperty(k); });

  it('cache matches: the 5 tokens of the resolved theme', () => {
    localStorage.setItem('ae64.theme', 'ember');
    localStorage.setItem(ACCENT_KEY, '#3a2bd1');
    localStorage.setItem(ACCENT_VARS_KEY, cacheOf('#3a2bd1'));
    run();
    expect(root.dataset.theme).toBe('ember');
    expect(inlineVars()).toEqual(accentFor('#3a2bd1', themeBase('ember')).vars);
  });
  it('"auto" on a light OS: the light entry', () => {
    localStorage.setItem('ae64.theme', 'auto');
    localStorage.setItem(ACCENT_KEY, '#3a2bd1');
    localStorage.setItem(ACCENT_VARS_KEY, cacheOf('#3a2bd1'));
    run(true);
    expect(root.dataset.theme).toBe('light');
    expect(inlineVars()).toEqual(accentFor('#3a2bd1', themeBase('light')).vars);
  });
  it('hex differs: 0 tokens', () => {
    localStorage.setItem(ACCENT_KEY, '#4da3ff');
    localStorage.setItem(ACCENT_VARS_KEY, cacheOf('#3a2bd1'));
    run();
    expect(inline()).toEqual([]);
  });
  it('broken JSON or values that are not hex: 0 tokens, no error', () => {
    localStorage.setItem(ACCENT_KEY, '#3a2bd1');
    localStorage.setItem(ACCENT_VARS_KEY, '{nope');
    expect(() => run()).not.toThrow();
    expect(inline()).toEqual([]);
    const bad = { v: 1, hex: '#3a2bd1', themes: { graphite: { '--acc': 'red;background:url(x)', '--acc-hover': 'x', '--on-acc': '', '--sel': '#12', '--m-actuation': 'var(--x)' } } };
    localStorage.setItem(ACCENT_VARS_KEY, JSON.stringify(bad));
    localStorage.setItem('ae64.theme', 'graphite');
    expect(() => run()).not.toThrow();
    expect(inline()).toEqual([]);
  });
  it('no colour: 0 tokens even with a cache', () => {
    localStorage.setItem(ACCENT_VARS_KEY, cacheOf('#3a2bd1'));
    run();
    expect(inline()).toEqual([]);
  });
});

describe('ColorPicker recent=false (DESIGN J §3.1)', () => {
  it('no recent row, and ae64.recentColors is neither read nor written', async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['#ff0000']));
    const get = vi.spyOn(Storage.prototype, 'getItem');
    const set = vi.spyOn(Storage.prototype, 'setItem');
    const w = mount(ColorPicker, { props: { modelValue: '#3a2bd1', recent: false, 'onUpdate:modelValue': (v: string) => w.setProps({ modelValue: v }) } });
    expect(w.find('.cp__recent').exists()).toBe(false);
    const hex = w.get('.cp__field--hex input');
    await hex.setValue('#b57bff');
    await hex.trigger('keydown', { key: 'Enter' });
    expect(w.emitted('commit')![0]).toEqual(['#b57bff']);
    expect(get.mock.calls.filter((c) => c[0] === RECENT_KEY)).toEqual([]);
    expect(set.mock.calls.filter((c) => c[0] === RECENT_KEY)).toEqual([]);
    expect(localStorage.getItem(RECENT_KEY)).toBe(JSON.stringify(['#ff0000']));
    w.unmount();
  });
  it('the default (Lighting) still shows and records recent colours', async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['#ff0000']));
    const w = mount(ColorPicker, { props: { modelValue: '#000000' } });
    expect(w.find('.cp__recent').exists()).toBe(true);
    const hex = w.get('.cp__field--hex input');
    await hex.setValue('#00ff00');
    await hex.trigger('keydown', { key: 'Enter' });
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual(['#00ff00', '#ff0000']);
    w.unmount();
  });
});

describe('ThemePicker tiles preview the accent (DESIGN J §3.2)', () => {
  it('each scene gets the set of its own theme; Auto: graphite and light scenes each their own; none without a colour', async () => {
    const w = mount(ThemePicker);
    expect(w.findAll('.tp__scene').every((s) => !(s.attributes('style') ?? '').includes('--acc'))).toBe(true);
    setAccent('#3a2bd1');
    await nextTick();
    const all = accentVarsAllThemes('#3a2bd1');
    const scenes = w.findAll('.tp__scene');
    expect(scenes).toHaveLength(13); // Auto's two halves + the 11 themes
    expect(scenes.slice(0, 2).map((s) => s.attributes('data-theme'))).toEqual(['graphite', 'light']);
    for (const s of scenes) {
      const id = s.attributes('data-theme') as keyof typeof all;
      const el = s.element as HTMLElement;
      for (const k of ACC_VAR_KEYS) expect(el.style.getPropertyValue(k), `${id} ${k}`).toBe(all[id][k]);
    }
    const [g, l] = scenes.slice(0, 2).map((s) => (s.element as HTMLElement).style.getPropertyValue('--acc'));
    expect([g, l]).toEqual(['#8394ff', '#3a2bd1']);
    w.unmount();
  });
});

describe('AccentPicker (DESIGN J §3.1, §7)', () => {
  const radios = () => wrapper!.findAll('[role="radio"]');
  const status = () => wrapper!.get('.acc__status');
  async function open() {
    wrapper = mount(AccentPicker, { attachTo: document.body });
    await nextTick();
  }

  it('7 options: "Theme colour" checked, swatches named by colour (not hex), dots drawn as applied on this theme', async () => {
    await open();
    expect(radios()).toHaveLength(7);
    expect(wrapper!.get('[role="radiogroup"]').attributes('aria-labelledby')).toBe('acc-t');
    expect(radios()[0].attributes('aria-checked')).toBe('true');
    expect(radios()[0].attributes('tabindex')).toBe('0');
    expect(radios().slice(1).every((r) => r.attributes('tabindex') === '-1')).toBe(true);
    expect(radios().slice(1, 6).map((r) => r.attributes('aria-label'))).toEqual(SWATCHES.map((s) => t(`acc.c.${s.id}` as never)));
    expect((radios()[3].element as HTMLElement).style.getPropertyValue('--d')).toBe('#b780ff');
    expect(radios()[6].attributes('aria-haspopup')).toBe('dialog');
    expect(status().text()).toBe('');
    setTheme('light');
    await nextTick();
    expect((radios()[3].element as HTMLElement).style.getPropertyValue('--d')).toBe('#8043c3');
  });

  it('a swatch: applied and stored at once, ✓ on it, "Using #b780ff" and the moved line', async () => {
    await open();
    await radios()[3].trigger('click');
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#b57bff');
    expect(root.style.getPropertyValue('--acc')).toBe('#b780ff');
    expect(radios()[3].attributes('aria-checked')).toBe('true');
    expect(radios()[3].find('.acc__chk').exists()).toBe(true);
    expect(status().get('.acc__hex').text()).toBe('#b780ff');
    expect(status().get('.acc__note').text()).toBe(t('acc.adjusted', { picked: '#b57bff', theme: 'Graphite', applied: '#b780ff' }));
    expect(status().find('.acc__warn').exists()).toBe(false);
    expect(status().attributes('aria-live')).toBe('polite');
  });

  it('the ⚠ line follows nearest(): Mint blue → RT press; Rose blue → RT press (via the keycap numbers); Mint violet → none', async () => {
    await open();
    setTheme('mint');
    await radios()[1].trigger('click');
    expect(status().get('.acc__warn').text()).toBe(t('acc.nearPress'));
    await radios()[3].trigger('click');
    expect(status().find('.acc__warn').exists()).toBe(false);
    await radios()[5].trigger('click');
    expect(status().get('.acc__warn').text()).toBe(t('acc.nearDanger'));
    setTheme('rose');
    await radios()[1].trigger('click');
    expect(status().get('.acc__warn').text()).toBe(t('acc.nearPress'));
    setTheme('graphite');
    await nextTick();
    expect(status().find('.acc__warn').exists()).toBe(false);
  });

  it('arrows: the theme option and swatches follow focus; "Custom…" only takes focus', async () => {
    await open();
    (radios()[0].element as HTMLElement).focus();
    await radios()[0].trigger('keydown', { key: 'ArrowRight' });
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#4da3ff');
    expect(document.activeElement).toBe(radios()[1].element);
    await radios()[1].trigger('keydown', { key: 'ArrowLeft' });
    expect(localStorage.getItem(ACCENT_KEY)).toBeNull();
    await radios()[0].trigger('keydown', { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(radios()[6].element);
    expect(localStorage.getItem(ACCENT_KEY)).toBeNull();
    expect(radios()[6].attributes('aria-checked')).toBe('false');
    expect(document.body.querySelector('.pop')).toBeNull();
  });

  it('"Back to the theme colour": removes it and moves focus to "Theme colour"', async () => {
    await open();
    await radios()[2].trigger('click');
    await status().get('button').trigger('click');
    await nextTick();
    expect(localStorage.getItem(ACCENT_KEY)).toBeNull();
    expect(inline()).toEqual([]);
    expect(document.activeElement).toBe(radios()[0].element);
  });

  it('"Custom…": a ColorPicker without recent colours; a commit stores it; Esc keeps the last commit', async () => {
    await open();
    await radios()[6].trigger('click');
    await nextTick();
    const pop = document.body.querySelector<HTMLElement>('.pop')!;
    expect(pop.getAttribute('aria-label')).toBe(t('acc.pickTitle'));
    expect(pop.querySelector('.cp__recent')).toBeNull();
    const hex = pop.querySelector<HTMLInputElement>('.cp__field--hex input')!;
    expect(hex.value).toBe('#c4bbff'); // opens on the colour applied now (the theme's)
    expect(inline()).toEqual([]); // opening changes nothing
    hex.value = '#3a2bd1';
    hex.dispatchEvent(new Event('input'));
    hex.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await nextTick();
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#3a2bd1');
    expect(root.style.getPropertyValue('--acc')).toBe('#8394ff');
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('.pop')).toBeNull();
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#3a2bd1');
    expect(radios()[6].attributes('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(radios()[6].element);
  });

  it('"Custom…": a drag previews on the whole app without storing; closing without a commit goes back', async () => {
    await open();
    await radios()[1].trigger('click'); // blue
    const applied = root.style.getPropertyValue('--acc');
    await radios()[6].trigger('click');
    await nextTick();
    const pop = document.body.querySelector<HTMLElement>('.pop')!;
    const sv = pop.querySelector<HTMLElement>('.cp__sv')!;
    sv.setPointerCapture = () => {};
    sv.getBoundingClientRect = () => ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100, x: 0, y: 0, toJSON() {} });
    const P = (globalThis.PointerEvent ?? MouseEvent) as typeof MouseEvent;
    sv.dispatchEvent(new P('pointerdown', { button: 0, clientX: 30, clientY: 40, bubbles: true })); // a drag, not yet released
    await nextTick();
    await nextTick();
    const previewed = root.style.getPropertyValue('--acc');
    expect(previewed, `applied ${applied}`).not.toBe(applied);
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#4da3ff');
    pop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await nextTick();
    expect(document.body.querySelector('.pop')).toBeNull();
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#4da3ff');
    expect(root.style.getPropertyValue('--acc')).toBe(applied);
    expect(radios()[1].attributes('aria-checked')).toBe('true');
  });

  it('"Custom…": an arrow key in the square is one edit, committed on key release (the ColorPicker gesture rule)', async () => {
    await open();
    await radios()[1].trigger('click');
    await radios()[6].trigger('click');
    await nextTick();
    const sv = document.body.querySelector<HTMLElement>('.pop .cp__sv')!;
    sv.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await nextTick();
    expect(localStorage.getItem(ACCENT_KEY)).toBe('#4da3ff');
    sv.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
    await nextTick();
    const stored = localStorage.getItem(ACCENT_KEY);
    expect(stored).not.toBe('#4da3ff');
    expect(stored).toBe(accentState.value.hex);
  });
});

describe('J test 14: strings', () => {
  const J_KEY = /^(acc|wall)\.|^data\.c\.(accent|wallpaper)$|^appcfg\.errWallpaper$/;
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  it('the 50 keys of DESIGN J §14 are in vi and en with the same {variables}', () => {
    const viKeys = Object.keys(viDict).filter((k) => J_KEY.test(k)).sort();
    const enKeys = Object.keys(en).filter((k) => J_KEY.test(k)).sort();
    expect(viKeys).toEqual(enKeys);
    expect(viKeys).toHaveLength(50);
    for (const k of viKeys) {
      const v = (viDict as Record<string, string>)[k];
      const e = (en as Record<string, string>)[k];
      expect(v && e, k).toBeTruthy();
      expect(vars(v), k).toEqual(vars(e));
    }
    for (const s of SWATCHES) expect(viKeys).toContain(`acc.c.${s.id}`);
    for (const e of ['errType', 'errSize', 'errDecode', 'errPixels', 'errStore']) expect(viKeys).toContain(`wall.${e}`);
  });
});
