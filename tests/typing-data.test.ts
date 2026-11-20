// DESIGN TT §14 test 2: the typing test's lists (src/data/typing/*.txt) follow the rules of §6. A port of the design's
// checkdata.mjs, including its Vietnamese syllable check, and the checker's own bad and good examples.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FILES = ['en-sentences.txt', 'en-words.txt', 'vi-sentences.txt', 'vi-words.txt'];
const TONE_RE = /[̣̀́̃̉]/g;

// ---- Vietnamese syllable (tones removed, lowercase): onset + vowel cluster + coda, with the c/k, g/gh, ng/ngh spelling rules.
const ONSETS = ['ngh', 'ng', 'nh', 'ch', 'gh', 'gi', 'kh', 'ph', 'qu', 'th', 'tr', 'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'r', 's', 't', 'v', 'x', ''];
const CLUSTERS = new Set(('a ă â e ê i o ô ơ u ư y ai ao au ay âu ây eo êu ia iê iu oa oă oe oi ôi ơi ua uâ uê ui uô uơ ưa ưi ươ ưu uy yê '
  + 'oai oay oeo iêu yêu uôi ươi ươu uya uyê uyu oo').split(' '));
const CODAS = ['ch', 'ng', 'nh', 'c', 'm', 'n', 'p', 't', ''];
const FRONT = /^[ieêy]/; // before these: k, gh, ngh; elsewhere: c, g, ng
function viSyllable(s: string): string | null {
  const b = s.normalize('NFD').replace(TONE_RE, '').normalize('NFC');
  if (/[fjwz0-9]/.test(b)) return 'f/j/w/z or a digit';
  if (/aa|ee|oo|dd/.test(b)) return 'aa/ee/oo/dd (Telex keys or a loanword)';
  for (const on of ONSETS) {
    if (!b.startsWith(on)) continue;
    const rest = b.slice(on.length);
    for (const co of CODAS) {
      if (!rest.endsWith(co)) continue;
      let nu = rest.slice(0, rest.length - co.length);
      if (on === 'gi' && (nu === '' || !/^[ieê]/.test(nu))) { if (nu === '') nu = 'i'; } // gì, gìn: the i is the vowel
      else if (nu === '') continue;
      if (!CLUSTERS.has(nu) || nu === 'oo') continue;
      if (on === 'qu' && /^u/.test(nu)) continue;
      if ((on === 'c' || on === 'g' || on === 'ng') && FRONT.test(nu)) continue;
      if ((on === 'k' || on === 'gh' || on === 'ngh') && !FRONT.test(nu)) continue;
      if ((co === 'ch' || co === 'nh') && !/^(a|ê|i|oa|uê|uy)$/.test(nu)) continue;
      if (/^(c|ch|p|t)$/.test(co) && !/[̣́]/.test(s.normalize('NFD'))) return 'a stop ending (c, ch, p, t) takes sắc or nặng';
      return null;
    }
  }
  return `not a Vietnamese syllable (${b})`;
}
const tonesIn = (s: string) => (s.normalize('NFD').match(TONE_RE) ?? []).length;

/** The bytes of a file as a string of 0–255 code units (the env's node:fs typing returns strings only). */
const bytesOf = (path: string) => Uint8Array.from(readFileSync(path, 'latin1'), (c) => c.charCodeAt(0));

/** Every problem of one list (DESIGN TT §6 rules); `f` names the file (its language and kind). */
function check(f: string, raw: Uint8Array): string[] {
  const problems: string[] = [];
  const bad = (line: number, msg: string) => problems.push(`${f}:${line}: ${msg}`);
  const lang = f.startsWith('vi') ? 'vi' : 'en', kind = f.includes('sentences') ? 'sentences' : 'words';
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) bad(1, 'BOM');
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw); } catch { bad(0, 'not valid UTF-8'); return problems; }
  if (text.includes('\r')) bad(1, 'CR (save with LF)');
  if (!text.endsWith('\n') || text.endsWith('\n\n')) bad(0, 'must end with exactly one newline');
  if (text.includes('�')) bad(0, 'not valid UTF-8');
  const lines = text.replace(/^﻿/, '').replace(/\n$/, '').split('\n');
  const seen = new Map<string, number>();
  lines.forEach((ln, i) => {
    const n = i + 1;
    if (ln !== ln.normalize('NFC')) bad(n, 'not NFC');
    if (ln !== ln.trim() || /\s{2,}|\t/.test(ln)) bad(n, 'extra space');
    if (!ln) { bad(n, 'empty line'); return; }
    if (/[0-9]/.test(ln)) bad(n, 'a digit (VNI uses digits as keys)');
    const key = ln.toLowerCase();
    if (seen.has(key)) bad(n, `duplicate of line ${seen.get(key)}`); else seen.set(key, n);
    if (lang === 'en' && /[^\x20-\x7e]/.test(ln)) bad(n, 'non-ASCII in English');
    if (kind === 'words') {
      if (ln !== ln.toLowerCase()) bad(n, 'words are lowercase');
      if (/[^\p{L} ]/u.test(ln)) bad(n, 'only letters and single spaces');
      if (lang === 'en' && ln.includes(' ')) bad(n, 'one English word per line');
      if (lang === 'vi' && ln.split(' ').length > 3) bad(n, 'at most 3 syllables');
    } else {
      if (!/^\p{Lu}/u.test(ln)) bad(n, 'a sentence starts with a capital');
      if (!/[.?!]$/.test(ln)) bad(n, 'a sentence ends with . ? or !');
      if (/[^\p{L} ,.?!;:'-]/u.test(ln)) bad(n, 'a character outside letters and , . ? ! ; : \' -');
      const w = ln.split(' ').length;
      if (w < 6 || w > 18) bad(n, `${w} words (6–18)`);
    }
    for (const tok of ln.split(' ')) {
      const word = tok.replace(/[,.?!;:]+$/, '');
      if (!word || /[,.?!;:]/.test(word)) { bad(n, `punctuation inside "${tok}"`); continue; }
      if (lang === 'en') { if (!/^[A-Za-z]+(?:'[a-z]+)?$/.test(word)) bad(n, `"${tok}" is not a plain English word`); continue; }
      if (tonesIn(word) > 1) { bad(n, `"${word}" has more than one tone mark`); continue; }
      const why = viSyllable(word.toLowerCase());
      if (why) bad(n, `"${word}": ${why}`);
    }
  });
  return problems;
}
const utf8 = (s: string) => new TextEncoder().encode(s);

describe('typing data: the four lists (DESIGN TT §6)', () => {
  it.each(FILES)('%s passes every rule (UTF-8, no BOM, LF, NFC, no duplicate, no digit, the language rules)', (f) => {
    expect(check(f, bytesOf(resolve('src/data/typing', f)))).toEqual([]);
  });

  it('the line counts of §6', () => {
    const count = (f: string) => new TextDecoder().decode(bytesOf(resolve('src/data/typing', f))).split('\n').length - 1;
    expect(FILES.map(count)).toEqual([40, 335, 40, 311]);
  });
});

describe('typing data: the checker itself', () => {
  const BAD = ['taxi', 'xoong', 'kà', 'ghà', 'tàt', 'viêt', 'Viá»‡t', 'ngỉ', 'cí', 'video', 'hai1'];
  const GOOD = ['gì', 'quốc', 'nghỉ', 'giữa', 'khuya', 'xe buýt', 'thuở', 'huỳnh', 'vịnh', 'ngoằn ngoèo'];

  it.each(BAD)('rejects "%s"', (w) => {
    expect(check('vi-words.txt', utf8(`${w}\n`))).not.toEqual([]);
  });
  it('rejects an NFD line', () => {
    expect(check('vi-words.txt', utf8(`${'việt'.normalize('NFD')}\n`))).not.toEqual([]);
  });
  it.each(GOOD)('accepts "%s"', (w) => {
    expect(check('vi-words.txt', utf8(`${w}\n`))).toEqual([]);
  });
  it('rejects a BOM, a CR, no final newline, a duplicate, a w and a digit', () => {
    expect(check('vi-words.txt', new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('việt\n')]))).not.toEqual([]);
    expect(check('vi-words.txt', utf8('việt\r\nnam\r\n'))).not.toEqual([]);
    expect(check('vi-words.txt', utf8('việt'))).not.toEqual([]);
    expect(check('vi-words.txt', utf8('việt\nViệt\n'))).not.toEqual([]);
    expect(check('vi-words.txt', utf8('wow\n'))).not.toEqual([]);
    expect(check('en-words.txt', utf8('ab1\n'))).not.toEqual([]);
    expect(check('en-words.txt', new Uint8Array([0x61, 0xff, 0x0a]))).not.toEqual([]); // not UTF-8
  });
});
