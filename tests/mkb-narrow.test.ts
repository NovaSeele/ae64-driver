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

interface MediaRule {
  media: string;
  selector: string;
  body: string;
}

function normalizeDeclBody(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/\s*;\s*/g, '; ')
    .replace(/\s*:\s*/g, ': ')
    .trim()
    .replace(/;+$/, '')
    .trim();
}

/** Extract every style rule inside any `@media` block whose prelude contains `max-width:`. */
function extractMaxWidthMediaRules(css: string): MediaRule[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: MediaRule[] = [];
  let i = 0;
  while (i < clean.length) {
    const at = clean.indexOf('@media', i);
    if (at === -1) break;
    const open = clean.indexOf('{', at);
    if (open === -1) break;
    const prelude = clean.slice(at + 6, open).replace(/\s+/g, ' ').trim();
    let depth = 1;
    let j = open + 1;
    while (j < clean.length && depth > 0) {
      if (clean[j] === '{') depth++;
      else if (clean[j] === '}') depth--;
      j++;
    }
    const inner = clean.slice(open + 1, j - 1);
    if (/max-width\s*:/i.test(prelude)) {
      for (const match of inner.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
        const body = normalizeDeclBody(match[2]);
        for (const rawSel of match[1].split(',')) {
          const selector = rawSel.replace(/\s+/g, ' ').trim();
          if (selector) out.push({ media: prelude, selector, body });
        }
      }
    }
    i = j;
  }
  return out;
}

// Explicit exceptions for `@media (max-width: ...)` rules that pre-existed on base commit eeab422
// (no MKB exception: every MKB narrow rule is scoped under .shell--generic).
// Keyed by `${rel} | ${media} | ${unscopedSelector} | ${body}` so any new or modified max-width rule is caught,
// and every entry must match a rule during the scan.
const MAX_WIDTH_EXCEPTIONS: readonly string[] = [
  // Pre-existing in base eeab422:
  'src/components/advanced/AdvancedTab.vue | (max-width: 1000px) | .cols | grid-template-columns: 1fr',
  'src/components/advanced/AdvancedTab.vue | (max-width: 1000px) | .cfg | flex: none; overflow-y: visible',
  'src/components/advanced/DksEditor.vue | (max-width: 1100px) | .dks__thresholds | grid-template-columns: 1fr',
  'src/components/advanced/PairEditor.vue | (max-width: 1100px) | .modes__grid | grid-template-columns: repeat(2, 1fr)',
  'src/components/firmware/AxisRestoreCard.vue | (max-width: 860px) | .ax__warn | flex-wrap: wrap',
  'src/components/firmware/AxisRestoreCard.vue | (max-width: 860px) | .ax__warn > .btn | margin-left: 24px',
  'src/components/live/TestTab.vue | (max-width: 1100px) | .checkrow | grid-template-columns: 1fr',
  'src/components/live/TestTab.vue | (max-width: 1100px) | .grid | grid-template-columns: 1fr',
  'src/components/live/TestTab.vue | (max-width: 1100px) | .typetest | flex: none',
  'src/components/live/TestTab.vue | (max-width: 1100px) | .typetest__box | flex: none',
  'src/components/shell/PageLayout.vue | (max-width: 1400px) | .page | padding: var(--s-5) var(--s-6) var(--s-7)',
  'src/components/shell/PageLayout.vue | (max-width: 1400px) | .page__kbrow | flex-direction: column-reverse; align-items: stretch',
  'src/components/shell/PageLayout.vue | (max-width: 1400px) | .page__aside | width: auto; flex-direction: row; flex-wrap: wrap; justify-content: flex-end',
  'src/components/shell/PageLayout.vue | (max-width: 1400px) | .page__board | width: 100%',
  'src/pages/FirmwarePage.vue | (max-width: 1100px) | .fw | grid-template-columns: minmax(0, 1fr)',
  'src/pages/FirmwarePage.vue | (max-width: 1100px) | .fw__main | display: contents',
  'src/pages/FirmwarePage.vue | (max-width: 1100px) | .fw-head | order: -2',
  'src/pages/FirmwarePage.vue | (max-width: 1100px) | .fw__side | order: -1; display: grid; grid-template-columns: 1fr 1fr; align-items: start',
  'src/pages/FirmwarePage.vue | (max-width: 860px) | .fw__side | grid-template-columns: minmax(0, 1fr)',
  'src/pages/MacroPage.vue | (max-width: 1000px) | .cols | grid-template-columns: 1fr',
  'src/pages/MacroPage.vue | (max-width: 1000px) | .main > .seqcard | flex: none',
  'src/pages/MacroPage.vue | (max-width: 1000px) | .main .at | flex: none; min-height: 0',
  'src/pages/MacroPage.vue | (max-width: 1200px) | .modes | grid-template-columns: 1fr',
  'src/pages/MacroPage.vue | (min-width: 1001px) and (max-width: 1200px) | .main .at__body | max-height: 320px',
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

  it('RV9: every @media (max-width: ...) rule across all src/**/*.vue files is a .shell--generic descendant', () => {
    const srcRoot = resolve('src');
    const vueFiles = collectVueFiles(srcRoot);
    expect(vueFiles.length).toBeGreaterThan(0);

    const remaining = new Map<string, number>();
    for (const entry of MAX_WIDTH_EXCEPTIONS) {
      const parts = entry.split(' | ');
      const key = `${parts[0]} | ${parts[1]} | ${parts[2]} | ${normalizeDeclBody(parts.slice(3).join(' | '))}`;
      remaining.set(key, (remaining.get(key) ?? 0) + 1);
    }

    const violations: string[] = [];
    for (const file of vueFiles) {
      const rel = `src/${file.slice(srcRoot.length + 1).replace(/\\/g, '/')}`;
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
        for (const rule of extractMaxWidthMediaRules(compiled.code)) {
          if (rule.selector.startsWith('.shell--generic ')) continue;
          const unscoped = rule.selector.replace(/\[data-v-test\]/g, '');
          // Single allowed non-descendant rule: App.vue's `.shell--generic { min-width: 0; }`.
          if (rel === 'src/App.vue' && unscoped === '.shell--generic' && /^min-width:\s*0;?$/.test(rule.body)) {
            continue;
          }
          const key = `${rel} | ${rule.media} | ${unscoped} | ${rule.body}`;
          const left = remaining.get(key) ?? 0;
          if (left > 0) {
            if (left === 1) remaining.delete(key);
            else remaining.set(key, left - 1);
            continue;
          }
          violations.push(`${rel} @media ${rule.media} -> ${rule.selector} { ${rule.body} }`);
        }
      }
    }
    expect(violations).toEqual([]);
    const unmatched = [...remaining.entries()].flatMap(([k, n]) => Array<string>(n).fill(k));
    expect(unmatched, 'Unmatched MAX_WIDTH_EXCEPTIONS (base rule removed or modified)').toEqual([]);
  });
});
