// DESIGN TT §14 test 1: the scoring (src/typing/score.ts), every case of §5.2 and every assertion of the design's
// typscore.test.mjs, with the same numbers.
import { describe, expect, it } from 'vitest';
import { bare, base, counted, finished, hint, letters, onTrack, same, score, split, tones } from '../src/typing/score';

const near = (a: number, b: number) => expect(Math.abs(a - b), `${a} ≠ ${b}`).toBeLessThan(1e-9);

describe('typing score: the design reference (typscore.test.mjs)', () => {
  it('same word: tone placement, NFD, case', () => {
    expect(same('hoà', 'hòa')).toBe(true);
    expect(same('thuỷ', 'thủy')).toBe(true);
    expect(same('việt'.normalize('NFD'), 'việt')).toBe(true);
    expect(same('Việt', 'việt')).toBe(false);
    expect(same('viet', 'việt')).toBe(false);
    expect(same('việc', 'việt')).toBe(false);
    expect(base('việt')).toBe('viêt');
    expect(tones('việt')).toBe('̣');
    expect(bare('Đường')).toBe('Duong');
  });

  it('on track while typing (the live colour)', () => {
    expect(onTrack('vie', 'việt', 'vi')).toBe(true); // Telex: the second e is still to come
    expect(onTrack('viê', 'việt', 'vi')).toBe(true);
    expect(onTrack('việ', 'việt', 'vi')).toBe(true);
    expect(onTrack('viế', 'việt', 'vi')).toBe(false); // another tone
    expect(onTrack('vir', 'việt', 'vi')).toBe(false);
    expect(onTrack('d', 'đi', 'vi')).toBe(true); // Telex dd → đ
    expect(onTrack('u', 'ưa', 'vi')).toBe(true); // Telex uw → ư
    expect(onTrack('doe', 'does', 'en')).toBe(true);
    expect(onTrack('Doe', 'does', 'en')).toBe(false);
  });

  it('split', () => {
    expect(split('  một hai  ba')).toEqual({ done: ['một', 'hai'], current: 'ba' });
    expect(split('một ')).toEqual({ done: ['một'], current: '' });
    expect(split('')).toEqual({ done: [], current: '' });
    expect(split('a\nb')).toEqual({ done: ['a'], current: 'b' });
  });

  it('letters of one word', () => {
    expect(letters('viêt', 'việt')).toEqual({ correct: 3, incorrect: 1, missed: 0, extra: 0 }); // tone missing
    expect(letters('vit', 'việt')).toEqual({ correct: 1, incorrect: 2, missed: 1, extra: 0 });
    expect(letters('teh', 'the')).toEqual({ correct: 1, incorrect: 2, missed: 0, extra: 0 });
    expect(letters('thee', 'the')).toEqual({ correct: 3, incorrect: 0, missed: 0, extra: 1 });
    expect(letters('hoà', 'hòa')).toEqual({ correct: 3, incorrect: 0, missed: 0, extra: 0 });
    expect(letters('đẹ', 'đẹp', true)).toEqual({ correct: 2, incorrect: 0, missed: 0, extra: 0 });
  });

  it('en, words mode, all right: 22 WPM', () => {
    const r = score({ target: ['the', 'cat', 'sat'], value: 'the cat sat', ms: 6000, end: 'words', lang: 'en' });
    expect(r.wpmChars).toBe(11); near(r.wpm, 22); near(r.raw, 22); near(r.wordsPerMin, 30); near(r.accuracy, 1);
  });

  it('en, words mode, one wrong word: 14 WPM, 88.9 %', () => {
    const r = score({ target: ['the', 'cat', 'sat'], value: 'the cst sat', ms: 6000, end: 'words', lang: 'en' });
    expect(r.wpmChars).toBe(7); near(r.wpm, 14); near(r.raw, 22); near(r.wordsPerMin, 20);
    near(r.accuracy, 8 / 9);
    expect(r.wrong).toEqual([{ i: 1, target: 'cat', typed: 'cst' }]);
  });

  it('vi, time mode, the time runs out inside a word: 8.8 WPM', () => {
    const r = score({ target: ['Việt', 'Nam', 'đẹp', 'lắm'], value: 'Việt Nam đẹ', ms: 15000, end: 'time', lang: 'vi' });
    expect(r.wpmChars).toBe(11); near(r.wpm, 8.8); near(r.raw, 8.8); near(r.wordsPerMin, 8); near(r.accuracy, 1);
  });

  it('vi, the time runs out mid-composition: "vie" on the way to "việt" is no error', () => {
    const r = score({ target: ['Nam', 'việt'], value: 'Nam vie', ms: 6000, end: 'time', lang: 'vi' });
    expect(r.wpmChars).toBe(7); near(r.wpm, 14); near(r.accuracy, 1);
    expect(r.letters).toEqual({ correct: 6, incorrect: 0, missed: 0, extra: 0 });
    expect(r.wrong).toEqual([]);
    const off = score({ target: ['Nam', 'việt'], value: 'Nam vir', ms: 6000, end: 'time', lang: 'vi' });
    expect(off.wpmChars).toBe(4); expect(off.letters).toEqual({ correct: 5, incorrect: 1, missed: 0, extra: 0 });
  });

  it('vi, the time runs out in an open composition showing raw keys (TT-D1): left out, no error', () => {
    const target = ['Nam', 'hạnh', 'phúc'];
    const c = score({ target, value: 'Nam hanhj', ms: 6000, end: 'time', lang: 'vi', composing: true });
    expect(c.wpmChars).toBe(4); near(c.wpm, 8); near(c.raw, 8); near(c.accuracy, 1);
    expect(c.letters).toEqual({ correct: 3, incorrect: 0, missed: 0, extra: 0 });
    expect(c.wrong).toEqual([]);
    // an on-track composition still counts, as before
    const on = score({ target, value: 'Nam hạnh', ms: 6000, end: 'time', lang: 'vi', composing: true });
    near(on.wpm, 16); near(on.accuracy, 1);
    // the same text with no composition open is the user's: compared letter by letter (1 extra)
    const off = score({ target, value: 'Nam hanhj', ms: 6000, end: 'time', lang: 'vi' });
    expect(off.letters).toEqual({ correct: 7, incorrect: 0, missed: 0, extra: 1 }); near(off.accuracy, 7 / 8); near(off.raw, 18);
  });

  it('a word past the end of the text (TT-D2): no throw; words mode stops at the N-th word', () => {
    const target = ['Nam', 'hạnh', 'phúc'];
    const w = score({ target, value: 'Nam hạnh phúc x', ms: 6000, end: 'words', lang: 'vi' });
    const plain = score({ target, value: 'Nam hạnh phúc ', ms: 6000, end: 'words', lang: 'vi' });
    expect(w).toEqual(plain);
    expect(w.wpmChars).toBe(14); near(w.wpm, 28); near(w.accuracy, 1); expect(w.wrong).toEqual([]);
    expect(score({ target, value: 'Nam hạnh phúc thêm nữa', ms: 6000, end: 'words', lang: 'vi' })).toEqual(plain);
    // time mode (the page refills the text, so this is only the guard): extra letters, no throw
    const t = score({ target: ['a', 'b'], value: 'a b c d', ms: 6000, end: 'time', lang: 'en' });
    expect(t.letters).toEqual({ correct: 2, incorrect: 0, missed: 0, extra: 2 });
    expect(letters('xy', undefined)).toEqual({ correct: 0, incorrect: 0, missed: 0, extra: 2 });
    expect(letters(undefined, 'abc')).toEqual({ correct: 0, incorrect: 0, missed: 3, extra: 0 });
  });

  it('vi, old and new tone placement both count: 32 WPM', () => {
    const r = score({ target: ['hòa', 'bình'], value: 'hoà bình', ms: 3000, end: 'words', lang: 'vi' });
    expect(r.wpmChars).toBe(8); near(r.wpm, 32); near(r.accuracy, 1);
  });

  it('vi, NFD text (Unikey "tổ hợp") scores as NFC', () => {
    const a = score({ target: ['việt', 'nam'], value: 'việt nam', ms: 6000, end: 'words', lang: 'vi' });
    const b = score({ target: ['việt', 'nam'], value: 'việt nam'.normalize('NFD'), ms: 6000, end: 'words', lang: 'vi' });
    expect(b).toEqual(a);
  });

  it('vi, a missing tone is one wrong letter', () => {
    const r = score({ target: ['việt', 'nam'], value: 'viêt nam', ms: 6000, end: 'words', lang: 'vi' });
    expect(r.wpmChars).toBe(3); // only "nam" (no trailing space: the last word finished the test)
    expect(r.letters).toEqual({ correct: 6, incorrect: 1, missed: 0, extra: 0 });
    near(r.accuracy, 6 / 7);
  });

  it('finished', () => {
    expect(finished({ target: ['a', 'b'], value: 'a b', n: 2, composing: false })).toBe(true);
    expect(finished({ target: ['a', 'b'], value: 'a b', n: 2, composing: true })).toBe(false);
    expect(finished({ target: ['a', 'b'], value: 'a x ', n: 2, composing: true })).toBe(true);
    expect(finished({ target: ['a', 'b'], value: 'a x', n: 2, composing: false })).toBe(false);
  });

  it('hints', () => {
    expect(hint({ target: ['does', 'it'], value: 'doé ', lang: 'en' })).toBe('imeOn');
    expect(hint({ target: ['does', 'it'], value: 'does ', lang: 'en' })).toBe(null);
    expect(hint({ target: ['it', 'is'], value: 'it’s ', lang: 'en' })).toBe(null); // a curly quote is no IME
    expect(hint({ target: ['do', 'it'], value: 'đo ', lang: 'en' })).toBe('imeOn');
    expect(hint({ target: ['Việt', 'Nam', 'đẹp', 'lắm'], value: 'Viet Nam dep lam ', lang: 'vi' })).toBe('imeOff');
    expect(hint({ target: ['Việt', 'Nam', 'đẹp', 'lắm'], value: 'Viet Nam đẹp lắm ', lang: 'vi' })).toBe(null);
    expect(hint({ target: ['Việt'], value: 'Viçt ', lang: 'vi' })).toBe('charset');
  });

  it('imeOff needs three marked words, not two (mutant 20)', () => {
    const target = ['Việt', 'Nam', 'đẹp', 'lắm'];
    expect(hint({ target, value: 'Viet Nam dep ', lang: 'vi' })).toBe(null); // "Nam" has no mark: two marked words
    expect(hint({ target, value: 'Viet Nam dep lam', lang: 'vi' })).toBe(null); // "lam" is not committed yet
    expect(hint({ target, value: 'Viet Nam dep lam ', lang: 'vi' })).toBe('imeOff');
  });
});

describe('typing score: DESIGN TT §5.2, the hand-computed table', () => {
  const pct = (x: number) => Math.floor(x * 100 + 1e-9);
  const row = (r: ReturnType<typeof score>) => ({ wpm: Math.round(r.wpm), raw: Math.round(r.raw), wordsPerMin: Math.round(r.wordsPerMin), acc: pct(r.accuracy) });

  it('A. the cat sat, typed right, words mode 6 s: 22 / 22 / 30 / 100 %', () => {
    expect(row(score({ target: ['the', 'cat', 'sat'], value: 'the cat sat', ms: 6000, end: 'words', lang: 'en' })))
      .toEqual({ wpm: 22, raw: 22, wordsPerMin: 30, acc: 100 });
  });
  it('B. "the cst sat", words mode 6 s: 14 / 22 / 20 / 88 %', () => {
    expect(row(score({ target: ['the', 'cat', 'sat'], value: 'the cst sat', ms: 6000, end: 'words', lang: 'en' })))
      .toEqual({ wpm: 14, raw: 22, wordsPerMin: 20, acc: 88 });
  });
  it('C. "Việt Nam đẹ", time 15 s: 9 / 9 / 8 / 100 %', () => {
    expect(row(score({ target: ['Việt', 'Nam', 'đẹp', 'lắm'], value: 'Việt Nam đẹ', ms: 15000, end: 'time', lang: 'vi' })))
      .toEqual({ wpm: 9, raw: 9, wordsPerMin: 8, acc: 100 });
  });
  it('D. "hoà bình" for "hòa bình", words mode 3 s: 32 / 32 / 40 / 100 %', () => {
    expect(row(score({ target: ['hòa', 'bình'], value: 'hoà bình', ms: 3000, end: 'words', lang: 'vi' })))
      .toEqual({ wpm: 32, raw: 32, wordsPerMin: 40, acc: 100 });
  });
  it('E. "viêt nam" for "việt nam", words mode 6 s: 6 / 16 / 10 / 85 %', () => {
    const r = score({ target: ['việt', 'nam'], value: 'viêt nam', ms: 6000, end: 'words', lang: 'vi' });
    expect(row(r)).toEqual({ wpm: 6, raw: 16, wordsPerMin: 10, acc: 85 });
    expect(r.wrong).toEqual([{ i: 0, target: 'việt', typed: 'viêt' }]);
  });
  it('F. "Nam vie" for "Nam việt", composition open at the deadline, time 6 s: 14 / 14 / 10 / 100 %', () => {
    expect(row(score({ target: ['Nam', 'việt'], value: 'Nam vie', ms: 6000, end: 'time', lang: 'vi', composing: true })))
      .toEqual({ wpm: 14, raw: 14, wordsPerMin: 10, acc: 100 });
  });
  it('G. NFD text scores as NFC (E\'s correct text)', () => {
    const a = score({ target: ['việt', 'nam'], value: 'việt nam', ms: 6000, end: 'words', lang: 'vi' });
    const b = score({ target: ['việt', 'nam'], value: 'việt nam'.normalize('NFD'), ms: 6000, end: 'words', lang: 'vi' });
    expect(b).toEqual(a);
    expect(row(b).acc).toBe(100);
  });
  it('H. Unikey: v i e ⌫ ê ⌫ ệ t ends as "việt", the same score as typing it directly', () => {
    const steps = ['v', 'vi', 'vie', 'vi', 'viê', 'vi', 'việ', 'việt'];
    const final = steps[steps.length - 1];
    const a = score({ target: ['việt'], value: final, ms: 3000, end: 'words', lang: 'vi' });
    expect(a).toEqual(score({ target: ['việt'], value: 'việt', ms: 3000, end: 'words', lang: 'vi' }));
    near(a.accuracy, 1);
  });
  it('I. "Nam hanhj" with a composition open, time 6 s: left out, 8 / 8 / 10 / 100 %', () => {
    const r = score({ target: ['Nam', 'hạnh', 'phúc'], value: 'Nam hanhj', ms: 6000, end: 'time', lang: 'vi', composing: true });
    expect(row(r)).toEqual({ wpm: 8, raw: 8, wordsPerMin: 10, acc: 100 });
    expect(r.letters).toEqual({ correct: 3, incorrect: 0, missed: 0, extra: 0 });
    expect(r.rawChars).toBe(4);
    expect(r.wrong).toEqual([]);
  });
  it('I′. "Nam hanhj" with no composition, time 6 s: 8 / 18 / 10 / 87 %, 1 extra', () => {
    const r = score({ target: ['Nam', 'hạnh', 'phúc'], value: 'Nam hanhj', ms: 6000, end: 'time', lang: 'vi' });
    expect(row(r)).toEqual({ wpm: 8, raw: 18, wordsPerMin: 10, acc: 87 });
    expect(r.letters).toEqual({ correct: 7, incorrect: 0, missed: 0, extra: 1 });
  });
  it('J. "Nam hạnh phúc x" from one input, N = 3, words mode 6 s: cut after "phúc ", 28 / 28 / 30 / 100 % (mutant 26)', () => {
    const target = ['Nam', 'hạnh', 'phúc'];
    const r = score({ target, value: 'Nam hạnh phúc x', ms: 6000, end: 'words', lang: 'vi' });
    expect(row(r)).toEqual({ wpm: 28, raw: 28, wordsPerMin: 30, acc: 100 });
    expect(r.letters).toEqual({ correct: 11, incorrect: 0, missed: 0, extra: 0 });
    expect(r.wrong).toEqual([]);
    expect(r).toEqual(score({ target, value: 'Nam hạnh phúc ', ms: 6000, end: 'words', lang: 'vi' }));
  });
  it('words past the end of the text never throw, in either mode (mutant 25)', () => {
    const target = ['Nam', 'hạnh'];
    for (const end of ['words', 'time'] as const) {
      for (const value of ['Nam hạnh phúc', 'Nam hạnh phúc ', 'Nam hạnh phúc thêm nữa ', 'Nam hạnh x y z']) {
        expect(() => score({ target, value, ms: 6000, end, lang: 'vi' }), `${end}: ${value}`).not.toThrow();
        expect(() => score({ target, value, ms: 6000, end, lang: 'vi', composing: true }), `${end}: ${value}`).not.toThrow();
      }
    }
    expect(() => letters('x', undefined)).not.toThrow();
    expect(() => letters('x', undefined, true)).not.toThrow();
  });
  it('letters of one word: the §5.2 list', () => {
    expect(letters('viêt', 'việt')).toEqual({ correct: 3, incorrect: 1, missed: 0, extra: 0 });
    expect(letters('vit', 'việt')).toEqual({ correct: 1, incorrect: 2, missed: 1, extra: 0 });
    expect(letters('teh', 'the')).toEqual({ correct: 1, incorrect: 2, missed: 0, extra: 0 });
    expect(letters('thee', 'the')).toEqual({ correct: 3, incorrect: 0, missed: 0, extra: 1 });
    expect(letters('hoà', 'hòa')).toEqual({ correct: 3, incorrect: 0, missed: 0, extra: 0 });
    expect(letters('đẹ', 'đẹp', true)).toEqual({ correct: 2, incorrect: 0, missed: 0, extra: 0 });
    expect(letters('vir', 'việt', true)).toEqual({ correct: 2, incorrect: 1, missed: 0, extra: 0 });
  });
  it('the on-track partial word at a time-out counts no missed or incorrect letter (mutant 5)', () => {
    const r = score({ target: ['đẹp'], value: 'đẹ', ms: 6000, end: 'time', lang: 'vi' });
    expect(r.letters).toEqual({ correct: 2, incorrect: 0, missed: 0, extra: 0 });
  });
  it('kept only when a person could have typed it (v1.4, N1; mutant 28)', () => {
    expect(counted({ seconds: 15, raw: 400 })).toBe(true);
    expect(counted({ seconds: 1, raw: 120 })).toBe(true);
    expect(counted({ seconds: 15, raw: 400.01 })).toBe(false);
    expect(counted({ seconds: 0.999, raw: 300 })).toBe(false);
    expect(counted({ seconds: 0, raw: 0 })).toBe(false); // one input with the whole text: 0 s, and score() gives 0 WPM
    const words = ['Nam', 'hạnh', 'phúc', 'việt', 'đẹp', 'lắm', 'xe', 'buýt', 'nghỉ', 'quốc'];
    const once = score({ target: words, value: words.join(' '), ms: 0, end: 'words', lang: 'vi' });
    expect(once.wpm).toBe(0);
    expect(counted(once)).toBe(false);
    const robot = score({ target: words, value: words.join(' '), ms: 50, end: 'words', lang: 'vi' });
    expect(robot.raw).toBeGreaterThan(400);
    expect(counted(robot)).toBe(false);
    const human = score({ target: words, value: words.join(' '), ms: 9000, end: 'words', lang: 'vi' });
    expect(counted(human)).toBe(true);
  });
});
