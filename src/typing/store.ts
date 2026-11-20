// The typing test's memory in this browser (DESIGN TT §7): prefs, the last 20 results and the best per test kind, in
// localStorage only. Every read and write is in try/catch (blocked storage still runs the test; nothing is remembered then),
// and every read is checked for shape (anything else is ignored). The typed text and the target text are never stored.
import { locale } from '../i18n/locale';
import { MAX_RAW, MIN_SECONDS } from './score';
import type { TextLang } from './score';
import type { Content, EndKind } from './texts';

export const PREFS_KEY = 'ae64.typing.prefs';
export const RESULTS_KEY = 'ae64.typing.results';
export const BEST_KEY = 'ae64.typing.best';
export const MAX_RESULTS = 20;
export const TIMES = [15, 30, 60, 120] as const;
export const COUNTS = [10, 25, 50, 100] as const;

export interface Prefs { lang: TextLang; content: Content; kind: EndKind; time: number; count: number; readNext: boolean }
export interface TypingResult {
  v: 1;
  at: number;
  lang: TextLang;
  content: Content;
  kind: EndKind;
  /** The length: seconds (time) or words (word count). */
  n: number;
  wpm: number;
  raw: number;
  acc: number;
  wordsPerMin: number;
  seconds: number;
}
export interface Best { wpm: number; at: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isLang = (v: unknown): v is TextLang => v === 'en' || v === 'vi';
const isContent = (v: unknown): v is Content => v === 'words' || v === 'sentences';
const isKind = (v: unknown): v is EndKind => v === 'time' || v === 'words';

function read(key: string): unknown {
  try {
    const s = localStorage.getItem(key);
    return s === null ? null : JSON.parse(s);
  } catch { return null; }
}
function write(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable: not remembered */ }
}

export const bestKey = (r: { lang: TextLang; content: Content; kind: EndKind; n: number }): string => `${r.lang}-${r.content}-${r.kind}-${r.n}`;

function parse(raw: string): unknown {
  try { return JSON.parse(raw); } catch { return null; }
}

/** Prefs of the right shape, or null. */
function asPrefs(p: unknown): Prefs | null {
  if (isObj(p) && isLang(p.lang) && isContent(p.content) && isKind(p.kind) && (TIMES as readonly unknown[]).includes(p.time)
    && (COUNTS as readonly unknown[]).includes(p.count) && typeof p.readNext === 'boolean') {
    return { lang: p.lang, content: p.content, kind: p.kind, time: p.time as number, count: p.count as number, readNext: p.readNext };
  }
  return null;
}
function isResult(r: unknown): r is TypingResult {
  return isObj(r) && r.v === 1 && isNum(r.at) && isLang(r.lang) && isContent(r.content) && isKind(r.kind) && isNum(r.n)
    && isNum(r.wpm) && isNum(r.raw) && isNum(r.acc) && isNum(r.wordsPerMin) && isNum(r.seconds);
}
const isBestEntry = (v: unknown): v is Best => isObj(v) && isNum(v.wpm) && isNum(v.at);

// The rules of the three keys for the app-settings table (src/data/appSettings.ts): the same shape checks the reads below use.
export const prefsValid = (raw: string): boolean => asPrefs(parse(raw)) !== null;
export const resultsValid = (raw: string): boolean => {
  const a = parse(raw);
  return Array.isArray(a) && a.length <= MAX_RESULTS && a.every(isResult);
};
export const bestValid = (raw: string): boolean => {
  const b = parse(raw);
  return isObj(b) && Object.values(b).every(isBestEntry);
};

/** The stored prefs, or (absent or not prefs) the defaults with the text language of the UI at this moment. */
export function loadPrefs(): Prefs {
  return asPrefs(read(PREFS_KEY)) ?? { lang: locale.value, content: 'words', kind: 'time', time: 30, count: 25, readNext: false };
}
export function savePrefs(p: Prefs): void {
  write(PREFS_KEY, { lang: p.lang, content: p.content, kind: p.kind, time: p.time, count: p.count, readNext: p.readNext });
}

/** Newest first, at most MAX_RESULTS; entries of another shape, or faster than anyone types (v1.4), are dropped. */
export function loadResults(): TypingResult[] {
  const a = read(RESULTS_KEY);
  return Array.isArray(a) ? a.filter((r) => isResult(r) && r.seconds >= MIN_SECONDS && r.raw <= MAX_RAW).slice(0, MAX_RESULTS) : [];
}
export function loadBest(): Record<string, Best> {
  const b = read(BEST_KEY);
  const out: Record<string, Best> = {};
  if (isObj(b)) for (const [k, v] of Object.entries(b)) if (isBestEntry(v) && v.wpm <= MAX_RAW) out[k] = { wpm: v.wpm, at: v.at };
  return out;
}

/**
 * Saves a finished test. `wpm` is the shown (rounded) WPM; the best of its kind is replaced only by a higher one.
 * Returns the best before this result (null: none) and whether this one is the new best.
 */
export function addResult(r: Omit<TypingResult, 'v'>): { prevBest: number | null; isBest: boolean } {
  const entry: TypingResult = {
    v: 1, at: r.at, lang: r.lang, content: r.content, kind: r.kind, n: r.n,
    wpm: r.wpm, raw: r.raw, acc: r.acc, wordsPerMin: r.wordsPerMin, seconds: r.seconds,
  };
  write(RESULTS_KEY, [entry, ...loadResults()].slice(0, MAX_RESULTS));
  const best = loadBest();
  const key = bestKey(r);
  const prev = best[key];
  const isBest = !prev || r.wpm > prev.wpm;
  if (isBest) write(BEST_KEY, { ...best, [key]: { wpm: r.wpm, at: r.at } });
  return { prevBest: prev?.wpm ?? null, isBest };
}

/** "Xoá lịch sử": the results and the bests, not the prefs. */
export function clearHistory(): void {
  try {
    localStorage.removeItem(RESULTS_KEY);
    localStorage.removeItem(BEST_KEY);
  } catch { /* storage unavailable */ }
}
