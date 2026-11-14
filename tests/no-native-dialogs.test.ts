// No native alert / confirm / prompt in the app: every question is an in-page Dialog (DESIGN L §8.1 S1–S2). The three
// `beforeunload` handlers stay: closing or reloading the tab is the browser's own prompt, no page UI can replace it.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { vi as viDict } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';

const SRC = resolve('src');
/** Every .ts / .vue / .js file under `dir`, as a path relative to src/. */
function files(dir = ''): string[] {
  return readdirSync(join(SRC, dir), { withFileTypes: true }).flatMap((e) => {
    const p = dir ? `${dir}/${e.name}` : e.name;
    return e.isDirectory() ? files(p) : /\.(ts|vue|js)$/.test(e.name) ? [p] : [];
  });
}
const NATIVE = [
  /\b(?:window|globalThis|self)\s*\.\s*(?:alert|confirm|prompt)\b/,
  /(?<![\w$.])(?:alert|confirm|prompt)\s*\(/,
];

describe('no native dialogs (DESIGN L)', () => {
  it('S1. no file in src/ calls alert, confirm or prompt', () => {
    const all = files();
    expect(all.length).toBeGreaterThan(100); // the walk really reads src/
    const hits = all.flatMap((f) => readFileSync(join(SRC, f), 'utf8').split(/\r?\n/)
      .map((line, i) => ({ line, at: `${f}:${i + 1}` }))
      .filter(({ line }) => NATIVE.some((re) => re.test(line))).map(({ at, line }) => `${at} ${line.trim()}`));
    expect(hits).toEqual([]);
  });

  it('S1. the scan finds what it looks for, and nothing else', () => {
    const found = (s: string) => NATIVE.some((re) => re.test(s));
    expect(['window.confirm(x)', 'alert("a")', 'globalThis.prompt', 'if (confirm(t))'].every(found)).toBe(true);
    expect(['confirmOpen.value = true', 'role="alertdialog"', 'macro.confirm(', 'toast.alert', 'confirmClear()'].some(found)).toBe(false);
  });

  it('S2. the old confirm strings are gone from both dictionaries', () => {
    for (const dict of [viDict, enDict] as Record<string, string>[]) {
      expect(dict['calibration.confirmLeave']).toBeUndefined();
      expect(dict['macro.leaveConfirm']).toBeUndefined();
    }
  });
});
