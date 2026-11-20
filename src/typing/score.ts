// The typing test's scoring (DESIGN TT §5), a typed port of the design's typscore.js: the same names and behaviour. Pure
// functions, no DOM. Everything works on the TEXT in the typing box, never on key events: a Vietnamese IME (Unikey's
// Backspace + text, or the composition events of the Windows/macOS Telex/VNI input methods) reaches the same text by
// different keys.

export type TextLang = 'en' | 'vi';
export interface Letters { correct: number; incorrect: number; missed: number; extra: number }
export interface WrongWord { i: number; target: string; typed: string }
export interface Score {
  wpm: number;
  raw: number;
  wordsPerMin: number;
  accuracy: number;
  letters: Letters;
  words: number;
  wpmChars: number;
  rawChars: number;
  wrong: WrongWord[];
  seconds: number;
}

/** The five Vietnamese tone marks as combining characters: grave, acute, tilde, hook above, dot below. */
const TONE_RE = /[̣̀́̃̉]/g;
/** Every combining mark (tones and the vowel marks: circumflex, breve, horn). */
const MARK_RE = /[̀-ͯ]/g;

export const nfc = (s: string): string => s.normalize('NFC');
/** Code points after NFC. Every Vietnamese letter has one precomposed code point, so this is "letters". */
export const len = (s: string): number => [...nfc(s)].length;

/** A word without its tone: NFC letters with the vowel marks kept (â, ă, ê, ô, ơ, ư, đ stay). */
export const base = (w: string): string => nfc(w).normalize('NFD').replace(TONE_RE, '').normalize('NFC');
/** The tone marks of a word, sorted (a correct syllable has at most one). */
export const tones = (w: string): string => (nfc(w).normalize('NFD').match(TONE_RE) ?? []).sort().join('');
/** Letters only: every mark removed and đ → d. Used for the live colour of the word being typed (§4.2). */
export const bare = (w: string): string => nfc(w).normalize('NFD').replace(MARK_RE, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');

/**
 * Same word: same letters (vowel marks included) and the same tone, wherever the tone mark sits. "hoà" = "hòa", "thuỷ" =
 * "thủy": the IME's old or new tone placement is the user's setting, not a typing error. Case counts.
 */
export const same = (typed: string, target: string): boolean => base(typed) === base(target) && tones(typed) === tones(target);

/** A word still being typed is on track: its letters (no marks) start the target's, and its tones are among the target's. */
export function onTrack(typed: string, target: string, lang: TextLang): boolean {
  if (!typed) return true;
  if (lang === 'en') return nfc(target).startsWith(nfc(typed));
  if (!bare(target).startsWith(bare(typed))) return false;
  const tt = tones(typed);
  return tt === '' || tt === tones(target);
}

/** The text in the box → committed words and the word being typed. Whitespace of any kind and length separates words. */
export function split(value: string): { done: string[]; current: string } {
  const v = nfc(value).replace(/^\s+/, '');
  if (v === '') return { done: [], current: '' };
  const parts = v.split(/\s+/);
  const endsWithSpace = /\s$/.test(v);
  return endsWithSpace ? { done: parts.filter(Boolean), current: '' } : { done: parts.slice(0, -1), current: parts[parts.length - 1] };
}

/**
 * Letters of one word (§5.2). A same word: all its letters correct. Otherwise the letters without tones are compared place
 * by place, and a different tone counts as one more incorrect letter (taken from the correct ones). `partial`: the time ran
 * out in this word, so the letters not typed yet are not "missed".
 */
export function letters(typed: string | undefined, target: string | undefined, partial = false): Letters {
  // a word past the end of the text first (v1.2, review TT-D2: len(undefined) threw)
  if (target === undefined) return { correct: 0, incorrect: 0, missed: 0, extra: len(typed ?? '') };
  const n = len(target);
  if (typed === undefined) return { correct: 0, incorrect: 0, missed: n, extra: 0 };
  if (same(typed, target)) return { correct: n, incorrect: 0, missed: 0, extra: 0 };
  const a = [...base(typed)], b = [...base(target)];
  let correct = 0, incorrect = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] === b[i]) correct++;
    else incorrect++;
  }
  const missed = partial ? 0 : Math.max(0, b.length - a.length);
  const extra = Math.max(0, a.length - b.length);
  const tt = tones(typed), tg = tones(target);
  const toneOff = partial ? tt !== '' && tt !== tg : tt !== tg;
  if (toneOff && correct > 0) { correct--; incorrect++; }
  else if (toneOff) incorrect++;
  return { correct, incorrect, missed, extra };
}

/**
 * The score (§5). `target`: the words of the text. `value`: the box. `ms`: the time counted (time mode: the chosen length;
 * words mode: first input → the finishing input). `end`: 'time' (the time ran out: the word being typed counts as typed so
 * far) or 'words' (the last word was finished: by a space, or typed exactly). `composing`: an IME composition was open when
 * the time ran out (v1.1, review TT-D1).
 */
export function score({ target, value, ms, end, lang, composing = false }: {
  target: readonly string[];
  value: string;
  ms: number;
  end: 'time' | 'words';
  lang: TextLang;
  composing?: boolean;
}): Score {
  let { done, current } = split(value);
  // Words mode (v1.2, TT-D2): the test is the text's N words. One input can add a space and more (text replacement, a phone
  // keyboard's suggestion, an IME committing several words): what comes after the N-th word is not counted, as an input
  // after a time test's deadline is not.
  if (end === 'words' && done.length >= target.length) { done = done.slice(0, target.length); current = ''; }
  const min = ms / 60000;
  let wpmChars = 0, rawChars = 0, words = 0;
  const L: Letters = { correct: 0, incorrect: 0, missed: 0, extra: 0 };
  const add = (x: Letters) => { L.correct += x.correct; L.incorrect += x.incorrect; L.missed += x.missed; L.extra += x.extra; };
  const wrong: WrongWord[] = [];
  done.forEach((w, i) => {
    const t = target[i] as string | undefined;
    add(letters(w, t));
    rawChars += len(w) + 1;
    if (t !== undefined && same(w, t)) { words++; wpmChars += len(t) + 1; }
    else wrong.push({ i, target: t ?? '', typed: w });
  });
  if (current) {
    const t = target[done.length] as string | undefined;
    const on = t !== undefined && onTrack(current, t, lang);
    // v1.1 (TT-D1): the time ran out inside an open composition that is off track ("hanhj": an IME showing raw keys before
    // it folds them into "hạnh"). That text is not the user's yet: it is left out (no letters, no WPM, no raw, not mistyped).
    if (!(end === 'time' && composing && !on)) {
      rawChars += len(current);
      if (end === 'words' && t !== undefined && same(current, t)) { words++; wpmChars += len(t); add(letters(current, t)); }
      else if (end === 'time') {
        // The time ran out inside this word, maybe mid-composition ("vie" on the way to "việt"): on track, every letter
        // typed so far is correct and none is missed; off track (and not composing), it is compared letter by letter,
        // still without "missed".
        if (on) { wpmChars += len(current); add({ correct: len(current), incorrect: 0, missed: 0, extra: 0 }); }
        else add(letters(current, t, true));
      } else { add(letters(current, t)); wrong.push({ i: done.length, target: t ?? '', typed: current }); }
    }
  }
  const total = L.correct + L.incorrect + L.missed + L.extra;
  return {
    wpm: min > 0 ? wpmChars / 5 / min : 0,
    raw: min > 0 ? rawChars / 5 / min : 0,
    wordsPerMin: min > 0 ? words / min : 0,
    accuracy: total > 0 ? L.correct / total : 1,
    letters: L, words, wpmChars, rawChars, wrong, seconds: ms / 1000,
  };
}

/** Words mode ends: N words committed, or the last one typed exactly while no composition is open. */
export function finished({ target, value, n, composing }: { target: readonly string[]; value: string; n: number; composing: boolean }): boolean {
  const { done, current } = split(value);
  if (done.length >= n) return true;
  const last = target[n - 1] as string | undefined;
  return !composing && done.length === n - 1 && current !== '' && last !== undefined && same(current, last);
}

// ----- hints (§4.3): shown under the box, never block the test
const VI_LOWER = 'aàáảãạăằắẳẵặâầấẩẫậbcdđeèéẻẽẹêềếểễệghiìíỉĩịklmnoòóỏõọôồốổỗộơờớởỡợpqrstuùúủũụưừứửữựvxyỳýỷỹỵ';
const VI_LETTERS = new Set([...VI_LOWER, ...VI_LOWER.toUpperCase(), ...'fjwzFJWZ']);
const hasMark = (w: string): boolean => nfc(w).normalize('NFD').match(MARK_RE) !== null || /[đĐ]/.test(w);

export type Hint = 'imeOn' | 'imeOff' | 'charset';

/** Which hint applies, from the committed words: 'imeOn' (en), 'imeOff' (vi), 'charset' (vi), or null. */
export function hint({ target, value, lang }: { target: readonly string[]; value: string; lang: TextLang }): Hint | null {
  const { done } = split(value);
  // English text: a committed word with a Vietnamese mark (or đ). Other non-ASCII (a curly quote) is just a wrong word.
  if (lang === 'en') return done.some(hasMark) ? 'imeOn' : null;
  if (done.some((w) => [...nfc(w)].some((c) => /\p{L}/u.test(c) && !VI_LETTERS.has(c)))) return 'charset';
  // the last three committed words whose target has a mark: all typed with the right letters and no mark at all
  const marked = done
    .map((w, i) => ({ w, t: target[i] as string | undefined }))
    .filter((x): x is { w: string; t: string } => x.t !== undefined && hasMark(x.t))
    .slice(-3);
  if (marked.length === 3 && marked.every((x) => !hasMark(x.w) && bare(x.w) === bare(x.t))) return 'imeOff';
  return null;
}
