// DESIGN TT §14 test 5: the typing test's memory in this browser (src/typing/store.ts, DESIGN §7).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { locale } from '../src/i18n/locale';
import {
  BEST_KEY, PREFS_KEY, RESULTS_KEY, addResult, clearHistory, loadBest, loadPrefs, loadResults, savePrefs,
} from '../src/typing/store';
import type { TypingResult } from '../src/typing/store';

const result = (at: number, wpm = 40, n = 30): Omit<TypingResult, 'v'> => ({
  at, lang: 'vi', content: 'words', kind: 'time', n, wpm, raw: wpm + 2, acc: 0.95, wordsPerMin: 12, seconds: n,
});

describe('typing store (DESIGN TT §7)', () => {
  const was = locale.value;
  beforeEach(() => localStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    locale.value = was;
    localStorage.clear();
  });

  it('prefs: absent → the UI locale at that moment and the defaults; once chosen, the text language stays (mutant 19)', () => {
    locale.value = 'en';
    expect(loadPrefs()).toEqual({ lang: 'en', content: 'words', kind: 'time', time: 30, count: 25, readNext: false });
    locale.value = 'vi';
    expect(loadPrefs().lang).toBe('vi');
    savePrefs({ ...loadPrefs(), lang: 'en', content: 'sentences', kind: 'words', count: 50, readNext: true });
    locale.value = 'vi';
    expect(loadPrefs()).toEqual({ lang: 'en', content: 'sentences', kind: 'words', time: 30, count: 50, readNext: true });
    locale.value = 'en';
    savePrefs({ ...loadPrefs(), lang: 'vi' });
    expect(loadPrefs().lang).toBe('vi');
  });

  it('read-next is off by default (mutant 14)', () => {
    expect(loadPrefs().readNext).toBe(false);
  });

  it('21 results keep the newest 20 (mutant 17)', () => {
    for (let i = 0; i < 21; i++) addResult(result(1000 + i));
    const r = loadResults();
    expect(r).toHaveLength(20);
    expect(r[0].at).toBe(1020);
    expect(r[19].at).toBe(1001);
    expect((JSON.parse(localStorage.getItem(RESULTS_KEY)!) as unknown[]).length).toBe(20);
  });

  it('the best per kind survives the 20-cap and is replaced only by a higher WPM', () => {
    expect(addResult(result(1, 70))).toEqual({ prevBest: null, isBest: true });
    for (let i = 0; i < 25; i++) expect(addResult(result(10 + i, 50)).isBest).toBe(false);
    expect(loadResults().some((r) => r.wpm === 70)).toBe(false);
    expect(loadBest()['vi-words-time-30']).toEqual({ wpm: 70, at: 1 });
    expect(addResult(result(100, 70))).toEqual({ prevBest: 70, isBest: false });
    expect(addResult(result(101, 71))).toEqual({ prevBest: 70, isBest: true });
    expect(addResult(result(102, 20, 60))).toEqual({ prevBest: null, isBest: true }); // another kind
    expect(Object.keys(loadBest()).sort()).toEqual(['vi-words-time-30', 'vi-words-time-60']);
  });

  it('the stored result has no text field', () => {
    addResult({ ...result(5), ...({ value: 'typed', target: 'the text' } as object) } as Omit<TypingResult, 'v'>);
    const stored = (JSON.parse(localStorage.getItem(RESULTS_KEY)!) as Record<string, unknown>[])[0];
    expect(Object.keys(stored).sort()).toEqual(['acc', 'at', 'content', 'kind', 'lang', 'n', 'raw', 'seconds', 'v', 'wordsPerMin', 'wpm']);
    expect(localStorage.getItem(RESULTS_KEY)).not.toContain('typed');
  });

  it('bad JSON and other shapes are ignored', () => {
    locale.value = 'vi';
    localStorage.setItem(PREFS_KEY, '{nope');
    localStorage.setItem(RESULTS_KEY, '{"a":1}');
    localStorage.setItem(BEST_KEY, '[1,2]');
    expect(loadPrefs().lang).toBe('vi');
    expect(loadResults()).toEqual([]);
    expect(loadBest()).toEqual({});
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lang: 'fr', content: 'words', kind: 'time', time: 30, count: 25, readNext: false }));
    expect(loadPrefs().lang).toBe('vi');
    localStorage.setItem(PREFS_KEY, JSON.stringify({ lang: 'en', content: 'words', kind: 'time', time: 31, count: 25, readNext: false }));
    expect(loadPrefs().time).toBe(30);
    localStorage.setItem(RESULTS_KEY, JSON.stringify([{ ...result(1), v: 1 }, { at: 'x' }, null, { ...result(2), v: 2 }]));
    expect(loadResults().map((r) => r.at)).toEqual([1]);
    localStorage.setItem(BEST_KEY, JSON.stringify({ a: { wpm: 3, at: 4 }, b: { wpm: 'x', at: 1 }, c: 5 }));
    expect(loadBest()).toEqual({ a: { wpm: 3, at: 4 } });
  });

  it('a throwing localStorage is ignored: defaults, nothing remembered, no error', () => {
    locale.value = 'en';
    const boom = () => { throw new Error('blocked'); };
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(boom);
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(boom);
    expect(loadPrefs().lang).toBe('en');
    expect(() => savePrefs(loadPrefs())).not.toThrow();
    expect(addResult(result(1))).toEqual({ prevBest: null, isBest: true });
    expect(loadResults()).toEqual([]);
    expect(loadBest()).toEqual({});
    expect(() => clearHistory()).not.toThrow();
  });

  it('clearing removes the results and the bests, not the prefs', () => {
    savePrefs({ ...loadPrefs(), lang: 'en' });
    addResult(result(1));
    clearHistory();
    expect(loadResults()).toEqual([]);
    expect(loadBest()).toEqual({});
    expect(localStorage.getItem(PREFS_KEY)).not.toBeNull();
  });

  it('read bounds (v1.4, N1; mutant 29): a result under 1 s or over 400 raw and a best over 400 WPM are ignored, one by one', () => {
    const e = (at: number, o: Partial<TypingResult> = {}) => ({ ...result(at), v: 1, ...o });
    localStorage.setItem(RESULTS_KEY, JSON.stringify([e(1, { seconds: 0.5 }), e(2, { raw: 401 }), e(3), e(4, { raw: 400, seconds: 1 })]));
    expect(loadResults().map((r) => r.at)).toEqual([3, 4]);
    localStorage.setItem(BEST_KEY, JSON.stringify({ a: { wpm: 18901, at: 1 }, b: { wpm: 401, at: 2 }, c: { wpm: 400, at: 3 }, d: { wpm: 50, at: 4 } }));
    expect(loadBest()).toEqual({ c: { wpm: 400, at: 3 }, d: { wpm: 50, at: 4 } });
    // a stored absurd best does not block a real one
    localStorage.setItem(BEST_KEY, JSON.stringify({ 'vi-words-time-30': { wpm: 18901, at: 1 } }));
    expect(addResult(result(9, 40))).toEqual({ prevBest: null, isBest: true });
  });
});
