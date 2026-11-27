// MKB-V narrow-viewport layout (DESIGN MKB §8.8): all narrow wrapping/stacking rules are scoped under
// `.shell--generic` inside `@media (max-width: 899px)`, leaving AE64 unchanged at every viewport width.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { compileStyle, parse } from '@vue/compiler-sfc';

const FILES = [
  {
    path: 'src/components/keyboard/SelectionBar.vue',
    selectors: ['.sb', '.sb__lead', '.sb__actions', '.sb__grp', '.sb__ghost'],
  },
  {
    path: 'src/pages/LightingPage.vue',
    selectors: ['.wb__group', '.sb', '.sb__actions'],
  },
  {
    path: 'src/pages/PerformancePage.vue',
    selectors: ['.ph__info', '.ph__scope', '.ph__tools'],
  },
  {
    path: 'src/components/performance/TravelTab.vue',
    selectors: ['.wb__bar', '.wb__group', '.chips', '.continuous'],
  },
  {
    path: 'src/components/ui/Card.vue',
    selectors: ['.card__head', '.card__actions'],
  },
  {
    path: 'src/pages/OverviewPage.vue',
    selectors: ['.ovh__actions'],
  },
  {
    path: 'src/components/live/TestTab.vue',
    selectors: ['.kbfoot', '.klock', '.klock__text'],
  },
  {
    path: 'src/pages/SettingsPage.vue',
    selectors: ['.settings-rate'],
  },
  {
    path: 'src/pages/DiagnosticsPage.vue',
    selectors: ['.diag-log-toolbar', '.diag-log-search'],
  },
  {
    path: 'src/pages/TypingPage.vue',
    selectors: ['.tt-status', '.tt-mode'],
  },
];

function collectVueFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectVueFiles(full));
    else if (entry.name.endsWith('.vue')) out.push(full);
  }
  return out;
}

describe('mkb narrow-viewport CSS scoping', () => {
  for (const f of FILES) {
    it(`${f.path} scopes all narrow rules under .shell--generic inside @media (max-width: 899px)`, () => {
      const src = readFileSync(resolve(f.path), 'utf8');
      const { descriptor } = parse(src);
      const scopedBlock = descriptor.styles.find((s) => s.scoped);
      expect(scopedBlock).toBeDefined();

      const compiled = compileStyle({
        source: scopedBlock!.content,
        filename: f.path,
        id: 'data-v-test',
        scoped: true,
      });
      expect(compiled.errors).toEqual([]);

      const mediaIdx = compiled.code.indexOf('@media (max-width: 899px)');
      expect(mediaIdx).toBeGreaterThan(-1);
      const narrowBlock = compiled.code.slice(mediaIdx);

      for (const sel of f.selectors) {
        expect(narrowBlock).toMatch(new RegExp(`\\.shell--generic\\s+${sel.replace('.', '\\.')}\\[data-v-test\\]`));
      }
    });
  }

  it('no .vue file under src (except App.vue) compiles a bare .shell--generic rule', () => {
    const srcRoot = resolve('src');
    const vueFiles = collectVueFiles(srcRoot);
    expect(vueFiles.length).toBeGreaterThan(0);

    for (const file of vueFiles) {
      const rel = `src/${file.slice(srcRoot.length + 1).replace(/\\/g, '/')}`;
      if (rel === 'src/App.vue') continue;
      const src = readFileSync(file, 'utf8');
      const { descriptor } = parse(src);
      for (const style of descriptor.styles) {
        const compiled = compileStyle({
          source: style.content,
          filename: rel,
          id: 'data-v-test',
          scoped: !!style.scoped,
        });
        expect(compiled.errors).toEqual([]);
        const css = compiled.code.replace(/\/\*[\s\S]*?\*\//g, '');
        for (const match of css.matchAll(/([^{}@]+)\{[^{}]*\}/g)) {
          const selectors = match[1].split(',').map((s) => s.trim()).filter(Boolean);
          for (const sel of selectors) {
            expect(sel, `${rel} compiled bare .shell--generic selector: "${sel}"`).not.toMatch(
              /(?:^|\s)\.shell--generic(?:\[data-v-[^\]]+\])?$/,
            );
            // `.shell--generic :deep(.x)` puts the scope id on the shell (App.vue, outside this scope): a dead rule.
            expect(sel, `${rel} compiled dead .shell--generic[data-v] selector: "${sel}"`).not.toMatch(/\.shell--generic\[data-v-/);
          }
        }
      }
    }
  });

  it('src/App.vue keeps .shell min-width: 1044px and sets .shell--generic { min-width: 0 } at max-width: 899px', () => {
    const src = readFileSync(resolve('src/App.vue'), 'utf8');
    expect(src).toContain("'shell--generic': device.support === 'generic'");
    expect(src).toMatch(/\.shell\s*\{[^}]*min-width:\s*1044px/s);
    expect(src).toMatch(/@media\s*\(max-width:\s*899px\)\s*\{[^}]*\.shell--generic\s*\{\s*min-width:\s*0;\s*\}/s);
  });
});
