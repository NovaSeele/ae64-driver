// DESIGN TT §14 test 5b (T22-T24): the real lists, nothing mocked except Math.random where stated. src/typing/texts.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNTS } from '../src/typing/store';
import { MORE_WORDS, TIME_WORDS, lines, makeText, moreWords } from '../src/typing/texts';
import type { Content } from '../src/typing/texts';
import type { TextLang } from '../src/typing/score';
import enWords from '../src/data/typing/en-words.txt?raw';
import viWords from '../src/data/typing/vi-words.txt?raw';
import enSentences from '../src/data/typing/en-sentences.txt?raw';
import viSentences from '../src/data/typing/vi-sentences.txt?raw';

const RAW: Record<TextLang, Record<Content, string>> = {
  en: { words: enWords, sentences: enSentences },
  vi: { words: viWords, sentences: viSentences },
};
const LANGS: TextLang[] = ['en', 'vi'];
const CONTENTS: Content[] = ['words', 'sentences'];
const vocab = (l: TextLang, c: Content): Set<string> => new Set(lines(RAW[l][c]).flatMap((e) => e.split(' ')));

afterEach(() => vi.restoreAllMocks());

describe('typing texts (DESIGN TT §6, §14 test 5b)', () => {
  it('words mode gives exactly N words for every language × content × N; time mode at least 80 (T22)', () => {
    let cases = 0;
    for (const l of LANGS) for (const c of CONTENTS) {
      for (const n of COUNTS) {
        for (let k = 0; k < 5; k++) expect(makeText(l, c, 'words', n), `${l} ${c} ${n}`).toHaveLength(n);
        cases++;
      }
      expect(makeText(l, c, 'time', 30).length, `${l} ${c} time`).toBeGreaterThanOrEqual(TIME_WORDS);
    }
    expect(cases).toBe(16);
  });

  it('moreWords gives at least 60 (T23)', () => {
    for (const l of LANGS) for (const c of CONTENTS) expect(moreWords(l, c).length, `${l} ${c}`).toBeGreaterThanOrEqual(MORE_WORDS);
    expect(MORE_WORDS).toBe(60);
  });

  it('every word comes from its list', () => {
    for (const l of LANGS) for (const c of CONTENTS) {
      const ok = vocab(l, c);
      for (const w of [...makeText(l, c, 'words', 100), ...makeText(l, c, 'time', 30), ...moreWords(l, c)]) expect(ok.has(w), `${l} ${c}: ${w}`).toBe(true);
    }
  });

  it('with Math.random repeating one index, no word-list entry follows itself (T24)', () => {
    // the same index twice in a row, then another: without the guard the text would hold the same entry twice in a row
    const seq = [0.5, 0.5, 0.1];
    let call = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => seq[call++ % seq.length]);
    for (const l of LANGS) {
      const entries = lines(RAW[l].words);
      const a = entries[Math.floor(0.5 * entries.length)];
      const b = entries[Math.floor(0.1 * entries.length)];
      expect(a).not.toBe(b);
      // the guard turns a, a, b, a, a, b ... into a, b, a, b ... (a Vietnamese entry gives several syllables)
      const expected = Array.from({ length: 100 }, (_, i) => (i % 2 ? b : a)).flatMap((e) => e.split(' ')).slice(0, 100);
      expect(makeText(l, 'words', 'words', 100), l).toEqual(expected);
      call = 0;
    }
  });
});
