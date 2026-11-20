// The typing test's texts (DESIGN TT §6 "Making a text"). The four lists ship in the page's lazy chunk (?raw).
import enWordsRaw from '../data/typing/en-words.txt?raw';
import viWordsRaw from '../data/typing/vi-words.txt?raw';
import enSentencesRaw from '../data/typing/en-sentences.txt?raw';
import viSentencesRaw from '../data/typing/vi-sentences.txt?raw';
import type { TextLang } from './score';

export type Content = 'words' | 'sentences';
export type EndKind = 'time' | 'words';

/** One entry per line. A CR is dropped too, so a list checked out with CRLF still gives clean words. */
export const lines = (raw: string): string[] => raw.split(/\r?\n/).filter(Boolean);
const LISTS: Record<TextLang, Record<Content, string[]>> = {
  en: { words: lines(enWordsRaw), sentences: lines(enSentencesRaw) },
  vi: { words: lines(viWordsRaw), sentences: lines(viSentencesRaw) },
};

/** Time mode: the first text has this many words, and MORE_WORDS more come whenever fewer than MORE_WHEN_LEFT are left. */
export const TIME_WORDS = 80;
export const MORE_WORDS = 60;
export const MORE_WHEN_LEFT = 30;

/** At least `n` words: random entries (never the same one twice in a row; a Vietnamese entry gives its syllables), or the
 *  sentences shuffled and joined. */
function gen(lang: TextLang, content: Content, n: number): string[] {
  const list = LISTS[lang][content];
  const out: string[] = [];
  if (content === 'words') {
    let last = '';
    while (out.length < n) {
      const e = list[Math.floor(Math.random() * list.length)];
      if (e === last) continue;
      last = e;
      out.push(...e.split(' '));
    }
  } else {
    let bag: string[] = [];
    while (out.length < n) {
      if (!bag.length) bag = shuffle(list);
      out.push(...bag.pop()!.split(' '));
    }
  }
  return out;
}

function shuffle(list: string[]): string[] {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** A new text: words mode exactly `n` words (the last sentence may be cut), time mode TIME_WORDS words. */
export function makeText(lang: TextLang, content: Content, kind: EndKind, n: number): string[] {
  return kind === 'words' ? gen(lang, content, n).slice(0, n) : gen(lang, content, TIME_WORDS);
}

/** Time mode: the words appended when fewer than MORE_WHEN_LEFT are left. */
export function moreWords(lang: TextLang, content: Content): string[] {
  return gen(lang, content, MORE_WORDS);
}
