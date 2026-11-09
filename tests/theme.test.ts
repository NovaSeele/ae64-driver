import { beforeEach, describe, expect, it, vi } from 'vitest';

function mockMatchMedia(light: boolean) {
  const listeners: ((e: { matches: boolean }) => void)[] = [];
  const mql = {
    matches: light,
    addEventListener: (_: string, cb: (e: { matches: boolean }) => void) => listeners.push(cb),
  };
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return (matches: boolean) => listeners.forEach((cb) => cb({ matches }));
}

async function load() {
  vi.resetModules();
  return import('../src/theme');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.head.innerHTML = '<meta name="theme-color" content="#111213"><meta name="color-scheme" content="dark">';
  vi.restoreAllMocks();
  mockMatchMedia(false);
});

describe('theme', () => {
  it('parses stored values; anything unknown becomes auto', async () => {
    const { parseThemeChoice, THEMES } = await load();
    expect(parseThemeChoice('auto')).toBe('auto');
    for (const id of THEMES) expect(parseThemeChoice(id)).toBe(id);
    for (const bad of ['', 'Light', 'solarized', null, undefined, 3, {}]) expect(parseThemeChoice(bad)).toBe('auto');
  });

  it('reads the stored choice at load and defaults to auto', async () => {
    localStorage.setItem('ae64.theme', 'nord');
    expect((await load()).themeChoice.value).toBe('nord');
    localStorage.setItem('ae64.theme', 'graphite');
    expect((await load()).themeChoice.value).toBe('graphite');
    localStorage.setItem('ae64.theme', 'bogus');
    const m = await load();
    expect(m.themeChoice.value).toBe('auto');
    expect(document.documentElement.dataset.theme).toBe('graphite');
  });

  it('setTheme stores, applies data-theme and follows storage events', async () => {
    const m = await load();
    m.setTheme('dracula');
    expect(localStorage.getItem('ae64.theme')).toBe('dracula');
    expect(document.documentElement.dataset.theme).toBe('dracula');
    window.dispatchEvent(new StorageEvent('storage', { key: 'ae64.theme', newValue: 'rose' }));
    expect(m.themeChoice.value).toBe('rose');
    expect(document.documentElement.dataset.theme).toBe('rose');
  });

  it('auto resolves from prefers-color-scheme and follows it live', async () => {
    const fire = mockMatchMedia(true);
    const m = await load();
    m.setTheme('auto');
    expect(m.resolvedTheme.value).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    fire(false);
    expect(m.resolvedTheme.value).toBe('graphite');
    expect(document.documentElement.dataset.theme).toBe('graphite');
    m.setTheme('ember');
    fire(true);
    expect(m.resolvedTheme.value).toBe('ember');
  });

  it('survives storage that throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const m = await load();
    expect(m.themeChoice.value).toBe('auto');
    expect(() => m.setTheme('mint')).not.toThrow();
    expect(m.resolvedTheme.value).toBe('mint');
  });
});
