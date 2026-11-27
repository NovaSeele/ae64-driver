// MKB-V narrow-viewport layout (DESIGN MKB §8.8): all narrow wrapping/stacking rules are scoped under
// `.shell--generic` inside `@media (max-width: 899px)`, leaving AE64 unchanged at every viewport width.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
];

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

  it('src/App.vue keeps .shell min-width: 1044px and sets .shell--generic { min-width: 0 } at max-width: 899px', () => {
    const src = readFileSync(resolve('src/App.vue'), 'utf8');
    expect(src).toContain("'shell--generic': device.support === 'generic'");
    expect(src).toMatch(/\.shell\s*\{[^}]*min-width:\s*1044px/s);
    expect(src).toMatch(/@media\s*\(max-width:\s*899px\)\s*\{[^}]*\.shell--generic\s*\{\s*min-width:\s*0;\s*\}/s);
  });
});
