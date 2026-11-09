// @vitest-environment node
import * as fs from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

const SRC = fs.readFileSync('public/theme-boot.js', 'utf8');
const VALUES: (string | null)[] = [null, 'auto', 'seele', 'seele-light', 'indigo', 'indigo-light', 'gold', 'graphite', 'light', 'ember', 'aurora', 'mint', 'nord', 'dracula', 'rose', 'garbage'];

function boot(stored: string | null, light: boolean, storageThrows = false, written: string[] = []) {
  const attrs: Record<string, string> = {};
  const metas: Record<string, { v: string; setAttribute(n: string, v: string): void }> = {};
  for (const n of ['color-scheme', 'theme-color']) metas[n] = { v: '', setAttribute(_n, v) { this.v = v; } };
  const document = {
    documentElement: { setAttribute: (n: string, v: string) => (attrs[n] = v) },
    querySelector: (sel: string) => metas[/"(.+)"/.exec(sel)![1]] ?? null,
  };
  const localStorage = {
    getItem: () => {
      if (storageThrows) throw new Error('denied');
      return stored;
    },
    setItem: (_k: string, v: string) => {
      if (storageThrows) throw new Error('denied');
      written.push(v);
    },
  };
  const window = { matchMedia: () => ({ matches: light }) };
  new Function('document', 'localStorage', 'window', SRC)(document, localStorage, window);
  return { theme: attrs['data-theme'], scheme: metas['color-scheme'].v, color: metas['theme-color'].v };
}

async function resolve(stored: string | null, light: boolean, storageThrows = false, written: string[] = []) {
  const g = globalThis as Record<string, unknown>;
  const store: Record<string, string> = stored === null ? {} : { 'ae64.theme': stored };
  g.localStorage = {
    getItem: (k: string) => {
      if (storageThrows) throw new Error('denied');
      return store[k] ?? null;
    },
    setItem: (_k: string, v: string) => {
      if (storageThrows) throw new Error('denied');
      written.push(v);
    },
  };
  g.window = { matchMedia: () => ({ matches: light, addEventListener() {} }), addEventListener() {} };
  vi.resetModules();
  const m = await import('../src/theme');
  return m.resolvedTheme.value;
}

describe('theme-boot.js', () => {
  for (const light of [false, true]) {
    it(`matches theme.ts for every stored value (OS ${light ? 'light' : 'dark'})`, async () => {
      for (const v of VALUES) expect(boot(v, light).theme, String(v)).toBe(await resolve(v, light));
    });
  }

  it('matches theme.ts when storage throws', async () => {
    for (const light of [false, true]) expect(boot(null, light, true).theme).toBe(await resolve(null, light, true));
  });

  it('maps legacy stored ids to the new ones and writes them back, like theme.ts', async () => {
    for (const [old, now] of [['seele', 'indigo'], ['seele-light', 'indigo-light']]) {
      const a: string[] = [];
      const b: string[] = [];
      expect(boot(old, false, false, a).theme).toBe(now);
      expect(await resolve(old, false, false, b)).toBe(now);
      expect(a).toEqual([now]);
      expect(b).toEqual([now]);
    }
    const w: string[] = [];
    boot('indigo', false, false, w);
    expect(w).toEqual([]);
    expect(() => boot('seele', false, true)).not.toThrow();
  });

  it('sets scheme and theme-color from the table', () => {
    expect(boot(null, false)).toEqual({ theme: 'graphite', scheme: 'dark', color: '#111213' });
    expect(boot(null, true)).toEqual({ theme: 'light', scheme: 'light', color: '#f8f9fb' });
    expect(boot('indigo', true)).toEqual({ theme: 'indigo', scheme: 'dark', color: '#101120' });
    expect(boot('indigo-light', false)).toEqual({ theme: 'indigo-light', scheme: 'light', color: '#f8f8fd' });
    expect(boot('gold', true)).toEqual({ theme: 'gold', scheme: 'dark', color: '#111213' });
  });
});
