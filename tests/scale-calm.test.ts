import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import SettingsPage from '../src/pages/SettingsPage.vue';
import { zoomModifier } from '../src/components/ui/zoomHint';
import { useDeviceStore } from '../src/stores/device';
import { setTheme } from '../src/theme';
import { t } from '../src/i18n/vi';
import type { PhysicalKey } from '../src/protocol';
import fs from 'node:fs';
import path from 'node:path';

const read = (f: string) => fs.readFileSync(path.resolve(f), 'utf8');
const tokensCss = read('src/styles/tokens.css');
const themesCss = read('src/styles/themes.css');
const keycapSrc = read('src/components/keyboard/Keycap.vue');

const block = (src: string, head: string) => {
  const i = src.indexOf(head);
  return src.slice(i, src.indexOf('\n}', i));
};

describe('SCALE-CALM-1: type scale', () => {
  it('uses the larger type tokens and sidebar width', () => {
    const t = tokensCss;
    for (const [k, v] of [['caption', 12], ['label', 13], ['body', 14], ['card', 16], ['section', 20], ['hero', 28]]) {
      expect(t).toContain(`--fs-${k}: ${v}px;`);
    }
    expect(t).toContain('--sidebar-w: 248px;');
  });
});

describe('SCALE-CALM-1: key size', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 2000 } }]); }
      disconnect() {}
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('caps the unit at 72 and exposes it as --u on the plate', async () => {
    const key: PhysicalKey = { id: 0, uiRow: 0, row: 1, col: 0, x: 0, y: 0, w: 1, name: 'K0' };
    const w = mount(KeyboardView, { props: { keys: [key, { ...key, id: 1, x: 1 }] } });
    await w.vm.$nextTick();
    const plate = w.find('.kb__plate').element as HTMLElement;
    expect(plate.style.getPropertyValue('--u')).toBe('72px');
    expect(plate.style.width).toBe('144px');
    w.unmount();
  });

  it('keycap legends follow --u', () => {
    const k = keycapSrc;
    expect(k).toContain('clamp(12px, calc(var(--u, 58px) * 0.21), 15px)');
    expect(k).toContain('clamp(11px, calc(var(--u, 58px) * 0.185), 13px)');
  });
});

describe('SCALE-CALM-1: calmer colours', () => {
  const themes = themesCss;
  it('Graphite has the new hues', () => {
    const g = block(themes, '[data-theme=\'graphite\']');
    for (const v of ['--m-press: #6ed4b3', '--m-release: #ecd478', '--ok: #78d693', '--hue-green: #78d693', '--warn: #eda86d', '--hue-orange: #eda86d',
      '--danger: #ea8a88', '--hue-red: #ea8a88', '--info: #75a6e2', '--hue-blue: #73a9e7', '--hue-yellow: #f4d687', '--hue-pink: #e184b2',
      '--hue-purple: #ad95e7', '--hue-indigo: #a2a1e8', '--hue-cyan: #73d0d7', '--acc: #c4bbff', '--sel: #8b80ff']) expect(g).toContain(`${v};`);
  });
  it('Light has the new hues', () => {
    const l = block(themes, '[data-theme=\'light\']');
    for (const v of ['--m-press: #29776f', '--m-release: #886523', '--ok: #286e3c', '--hue-green: #286e3c', '--warn: #934f22', '--hue-orange: #a74524',
      '--danger: #b7352f', '--hue-red: #b7352f', '--info: #2a5ac0', '--hue-blue: #2a5ac0', '--hue-yellow: #855c22', '--hue-pink: #a62e5b',
      '--hue-purple: #6a40c5', '--hue-indigo: #504fd3', '--hue-cyan: #236473', '--acc: #6353da', '--sel: #8b80ff']) expect(l).toContain(`${v};`);
  });
  it('Gold keeps its explicit colour', () => {
    expect(block(themes, '[data-theme=\'gold\']')).toContain('#ff9678');
  });
  it('every feature tile is the neutral --fg-3', () => {
    const names = ['keymap', 'performance', 'advanced', 'lighting', 'macro', 'live', 'calibration', 'switch', 'settings', 'diagnostics'];
    for (const n of names) expect(themes).toContain(`--f-${n}: var(--fg-3);`);
  });
});

describe('SCALE-CALM-1: zoom hint', () => {
  it('shows ⌘ on macOS and Ctrl elsewhere', () => {
    expect(zoomModifier('MacIntel')).toBe('⌘');
    expect(zoomModifier('macOS')).toBe('⌘');
    expect(zoomModifier('Win32')).toBe('Ctrl');
    expect(zoomModifier('Linux x86_64')).toBe('Ctrl');
    expect(zoomModifier('')).toBe('Ctrl');
  });

  it('Settings shows the hint', () => {
    setActivePinia(createPinia());
    const w = mount(SettingsPage, { global: { stubs: { PageLayout: { template: '<div><slot /></div>' } } } });
    expect(w.text()).toContain(t('settings.zoomHint', { mod: 'Ctrl' }));
    w.unmount();
  });
});

describe('SCALE-CALM-1: display only', () => {
  it('switching theme on a demo connection makes no transport exchange', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo();
    const spy = vi.spyOn(device.transport as unknown as { exchange: () => unknown }, 'exchange');
    for (const id of ['light', 'graphite', 'gold', 'auto'] as const) setTheme(id);
    expect(spy).not.toHaveBeenCalled();
  });
});
