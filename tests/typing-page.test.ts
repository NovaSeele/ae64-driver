// DESIGN TT §14 tests 3, 4, 6, 7: the typing test page in jsdom, events dispatched by hand. The texts are fixed (makeText
// mocked) so the numbers are hand-computable; time mode runs on fake timers with a hand-moved performance.now().
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { NAV, routes } from '../src/router';
import TypingPage from '../src/pages/TypingPage.vue';
import { locale } from '../src/i18n/locale';
import { t, vi as viDict } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';
import { typingVi } from '../src/i18n/typing';
import { typingEn } from '../src/i18n/en/typing';
import { PREFS_KEY, RESULTS_KEY } from '../src/typing/store';

const TEXT = vi.hoisted(() => ({ words: [] as string[], made: 0 }));
vi.mock('../src/typing/texts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/typing/texts')>()),
  makeText: () => { TEXT.made++; return [...TEXT.words]; },
  moreWords: () => ['thêm', 'nữa'],
}));

const EN25 = ('the cat sat on a mat and we saw it run far from my red box but you got one big new dog to see').split(' ');
const VI10 = ['Nam', 'hạnh', 'phúc', 'việt', 'đẹp', 'lắm', 'xe', 'buýt', 'nghỉ', 'quốc'];

let w: VueWrapper | null = null;
let clock = 0;
let exchange: ReturnType<typeof vi.fn>;
let withTransport: ReturnType<typeof vi.spyOn>;

function setPrefs(p: Partial<{ lang: 'en' | 'vi'; content: 'words' | 'sentences'; kind: 'time' | 'words'; time: number; count: number; readNext: boolean }>) {
  localStorage.setItem(PREFS_KEY, JSON.stringify({ lang: 'en', content: 'words', kind: 'time', time: 15, count: 10, readNext: false, ...p }));
}
async function mountPage() {
  const pinia = createPinia();
  setActivePinia(pinia);
  const device = useDeviceStore();
  const mock = new MockTransport({ latencyMs: 0 });
  device.transport = mock;
  exchange = vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> }, 'exchange') as unknown as ReturnType<typeof vi.fn>;
  withTransport = vi.spyOn(device, 'withTransport');
  w = mount(TypingPage, { global: { plugins: [pinia] }, attachTo: document.body });
  await nextTick();
  return w;
}
const box = () => document.querySelector<HTMLTextAreaElement>('#tt-box')!;
const say = () => document.querySelector<HTMLElement>('.tt-say')!;
const status = () => document.querySelector<HTMLElement>('.tt-hint')!;
const cls = (i: number) => document.querySelectorAll('.tt-text__in .tt-w')[i].className.replace('tt-w ', '');
const heading = () => document.querySelector<HTMLElement>('#tt-res-title');
const resultText = () => document.querySelector('.tt-res')?.textContent ?? '';
const big = () => [...document.querySelectorAll('.tt-big b')].map((b) => b.textContent);
const wrongChips = () => document.querySelectorAll('.tt-wrong li').length;

async function type(v: string, inputType = 'insertText') {
  box().value = v;
  box().dispatchEvent(new InputEvent('input', { inputType, bubbles: true }));
  await nextTick();
}
async function compose(on: boolean) {
  box().dispatchEvent(new CompositionEvent(on ? 'compositionstart' : 'compositionend', { bubbles: true }));
  await nextTick();
}
async function advance(ms: number) {
  clock += ms;
  vi.advanceTimersByTime(ms);
  await nextTick();
  await nextTick();
}
function key(type: string, init: KeyboardEventInit & { keyCode?: number }) {
  const e = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(e, 'keyCode', { value: init.keyCode });
  return e;
}
const stored = () => JSON.parse(localStorage.getItem(RESULTS_KEY) ?? '[]') as Record<string, unknown>[];
const btn = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label)!;

beforeEach(() => {
  localStorage.clear();
  locale.value = 'vi';
  TEXT.words = [...EN25];
  TEXT.made = 0;
  clock = 1000;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  w?.unmount();
  w = null;
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = '';
});

describe('typing page: input (DESIGN TT §14 test 3)', () => {
  it('composition: raw keys in an open composition are never off track; compositionend with "hạnh " → ok (mutant 3)', async () => {
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'words', count: 10 });
    await mountPage();
    await type('Nam ');
    await compose(true);
    await type('Nam hanhj', 'insertCompositionText');
    expect(cls(1)).toBe('tt-w--cur');
    box().value = 'Nam hạnh ';
    await compose(false);
    expect(cls(0)).toBe('tt-w--ok');
    expect(cls(1)).toBe('tt-w--ok');
    expect(cls(2)).toBe('tt-w--cur');
    await type('Nam hạnh phx'); // no composition: off track
    expect(cls(2)).toBe('tt-w--off');
  });

  it('Unikey (Backspace + text): v, vi, vie, vi, viê, vi, việ, việt → ok, 100 % (mutant 8)', async () => {
    TEXT.words = ['việt', ...VI10.slice(0, 9)];
    setPrefs({ lang: 'vi', kind: 'words', count: 10 });
    await mountPage();
    const steps: [string, string][] = [['v', 'insertText'], ['vi', 'insertText'], ['vie', 'insertText'], ['vi', 'deleteContentBackward'],
      ['viê', 'insertText'], ['vi', 'deleteContentBackward'], ['việ', 'insertText'], ['việt', 'insertText']];
    for (const [v, it] of steps) await type(v, it);
    expect(cls(0)).toBe('tt-w--cur');
    clock += 6000;
    await type(TEXT.words.join(' '));
    expect(cls(0)).toBe('tt-w--ok');
    expect(big()[1]).toMatch(/^100\s?%$/);
    expect(wrongChips()).toBe(0);
  });

  it('an NFD value scores as the NFC one (mutant 2)', async () => {
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'words', count: 10 });
    await mountPage();
    await type('N');
    clock += 12000;
    await type(VI10.join(' '));
    const dl = () => document.querySelector('.tt-dl')!.textContent;
    const nfc = [dl(), ...big()];
    btn(t('tt.again')).click();
    await nextTick();
    clock = 1000;
    await type('N');
    clock += 12000;
    await type(VI10.join(' ').normalize('NFD'));
    expect([dl(), ...big()]).toEqual(nfc);
    expect(big()).toEqual(['44WPM', '100%']); // 9 words + their spaces (31 + 9) + the last word (4) = 44 ch ÷ 5 ÷ 0.2 min
  });

  it('Enter is blocked unless an IME composes; paste, drop and line breaks are refused (mutants 9, 10)', async () => {
    await mountPage();
    const enter = key('keydown', { key: 'Enter', code: 'Enter' });
    box().dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    const shiftEnter = key('keydown', { key: 'Enter', code: 'Enter', shiftKey: true });
    box().dispatchEvent(shiftEnter);
    expect(shiftEnter.defaultPrevented).toBe(true);
    const numpad = key('keydown', { key: 'Enter', code: 'NumpadEnter' });
    box().dispatchEvent(numpad);
    expect(numpad.defaultPrevented).toBe(true);
    const ime = key('keydown', { key: 'Enter', code: 'Enter', isComposing: true });
    box().dispatchEvent(ime);
    expect(ime.defaultPrevented).toBe(false);
    const k229 = key('keydown', { key: 'Process', code: 'Enter', keyCode: 229 });
    box().dispatchEvent(k229);
    expect(k229.defaultPrevented).toBe(false);
    const letter = key('keydown', { key: 'a', code: 'KeyA' });
    box().dispatchEvent(letter);
    expect(letter.defaultPrevented).toBe(false);
    for (const inputType of ['insertFromPaste', 'insertFromDrop', 'insertLineBreak', 'insertParagraph', 'insertFromYank']) {
      const e = new InputEvent('beforeinput', { inputType, bubbles: true, cancelable: true });
      box().dispatchEvent(e);
      expect(e.defaultPrevented, inputType).toBe(true);
    }
    const text = new InputEvent('beforeinput', { inputType: 'insertText', data: 'a', bubbles: true, cancelable: true });
    box().dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    for (const type of ['paste', 'drop']) {
      const e = new Event(type, { bubbles: true, cancelable: true });
      box().dispatchEvent(e);
      expect(e.defaultPrevented, type).toBe(true);
    }
  });

  it('the clock starts at the first non-blank input, not on focus or a leading space (mutant 12)', async () => {
    setPrefs({ kind: 'words', count: 10 });
    await mountPage();
    box().focus();
    box().dispatchEvent(new FocusEvent('focus'));
    await advance(3000);
    await type(' ');
    await advance(3000);
    expect(document.querySelector('.tt-count')!.textContent).toBe(t('tt.ready'));
    expect(document.querySelector('.tt-clock')!.textContent).toBe('0:00');
    await type(' t');
    expect(document.querySelector('.tt-count')!.textContent).toBe(t('tt.progress', { d: 0, n: 10 }));
    await advance(6000);
    expect(document.querySelector('.tt-clock')!.textContent).toBe('0:06');
    clock += 6000;
    await type(` ${EN25.slice(0, 10).join(' ')}`);
    expect(resultText()).toContain('0:12'); // counted from " t", not from the focus or the leading space
  });

  it('time mode ends at exactly N s and scores the value at the deadline', async () => {
    setPrefs({ kind: 'time', time: 15 });
    await mountPage();
    await type('t');
    await advance(5000);
    await type('the cat sat ');
    await advance(9999);
    expect(heading()).toBeNull();
    expect(box().readOnly).toBe(false);
    await advance(1);
    expect(heading()).not.toBeNull();
    // (4 + 4 + 4) ch ÷ 5 ÷ 0.25 min = 9.6 → 10 WPM
    expect(big()[0]).toBe('10WPM');
    expect(stored()[0]).toMatchObject({ wpm: 10, kind: 'time', n: 15, seconds: 15 });
  });

  it('an input after the deadline (a late timer) is not counted (mutant 16)', async () => {
    setPrefs({ kind: 'time', time: 15 });
    await mountPage();
    await type('t');
    await type('the cat sat ');
    clock += 15001; // the timer has not fired yet (throttled)
    await type('the cat sat on a mat and ');
    await nextTick();
    expect(heading()).not.toBeNull();
    expect(big()[0]).toBe('10WPM');
    expect(box().value).toBe('the cat sat ');
    expect(stored()).toHaveLength(1);
  });

  it('back on screen, the deadline is checked first (visibilitychange)', async () => {
    setPrefs({ kind: 'time', time: 15 });
    await mountPage();
    await type('the ');
    clock += 16000;
    document.dispatchEvent(new Event('visibilitychange'));
    await nextTick();
    await nextTick();
    expect(heading()).not.toBeNull();
    expect(big()[0]).toBe('3WPM'); // 4 ÷ 5 ÷ 0.25 = 3.2
  });

  it('a time-out while composing (v1.1, case I): the off-track composition is left out; read before the box turns read-only (mutant 24)', async () => {
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'time', time: 15 });
    await mountPage();
    await type('Nam ');
    await compose(true);
    await type('Nam hanhj', 'insertCompositionText');
    // a browser may end the composition when the box turns read-only: the page must have read the flag already
    const el = box();
    const proto = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'readOnly')!;
    Object.defineProperty(el, 'readOnly', {
      configurable: true,
      get() { return proto.get!.call(el); },
      set(v: boolean) { proto.set!.call(el, v); el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); },
    });
    await advance(15000);
    expect(heading()).not.toBeNull();
    // "Nam" only: 4 ÷ 5 ÷ 0.25 = 3.2 → 3 WPM, 3/3 letters = 100 %, nothing mistyped
    expect(big()).toEqual(['3WPM', '100%']);
    expect(wrongChips()).toBe(0);
    expect(stored()[0]).toMatchObject({ wpm: 3, raw: 3, acc: 1 });
  });

  it('a time-out in an on-track composition ("Nam hạnh") counts it: 8 ch → 6 WPM', async () => {
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'time', time: 15 });
    await mountPage();
    await type('Nam ');
    await compose(true);
    await type('Nam hạnh', 'insertCompositionText');
    await advance(15000);
    expect(big()).toEqual(['6WPM', '100%']); // 8 ÷ 5 ÷ 0.25 = 6.4
  });

  it('the same "Nam hanhj" with no composition is the user\'s text: 1 extra letter, 87 %', async () => {
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'time', time: 15 });
    await mountPage();
    await type('Nam hanhj');
    await advance(15000);
    expect(big()).toEqual(['3WPM', '87%']);
    expect(stored()[0]).toMatchObject({ raw: 7 }); // (4 + 5) ÷ 5 ÷ 0.25 = 7.2
  });

  it('words mode: an exact last word ends the test only when no composition is open; compositionend ends it (mutant 4)', async () => {
    setPrefs({ kind: 'words', count: 10 });
    await mountPage();
    await type('t');
    await compose(true);
    await type(EN25.slice(0, 10).join(' '), 'insertCompositionText');
    expect(heading()).toBeNull();
    clock += 6000;
    await compose(false);
    expect(heading()).not.toBeNull();
    expect(resultText()).toContain('0:06');
  });

  it('the end: read-only, focus on the result heading; Space or Enter there changes nothing (mutant 15)', async () => {
    setPrefs({ kind: 'words', count: 10 });
    await mountPage();
    const first = box();
    await type('t');
    clock += 6000;
    await type(EN25.slice(0, 10).join(' '));
    await nextTick();
    expect(box()).toBe(first);
    expect(box().readOnly).toBe(true);
    expect(box().getAttribute('aria-readonly')).toBe('true');
    expect(document.activeElement).toBe(heading());
    expect(heading()!.getAttribute('tabindex')).toBe('-1');
    expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    const before = resultText();
    for (const k of [' ', 'Enter']) {
      heading()!.dispatchEvent(key('keydown', { key: k }));
      heading()!.dispatchEvent(key('keyup', { key: k }));
    }
    await nextTick();
    expect(box()).toBe(first);
    expect(resultText()).toBe(before);
    expect(stored()).toHaveLength(1);
  });

  it('words mode: one input adds the N-th word, a space and more (TT-D2, case J): a result, focus on its heading, no error', async () => {
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'words', count: 10 });
    const errors = vi.spyOn(console, 'error');
    await mountPage();
    await type('N');
    clock += 6000;
    await type(`${VI10.join(' ')} x`, 'insertReplacementText');
    await nextTick();
    expect(errors).not.toHaveBeenCalled();
    expect(heading()).not.toBeNull();
    expect(document.activeElement).toBe(heading());
    // cut after the 10th word: 35 letters + 10 spaces = 45 ch ÷ 5 ÷ 0.1 min = 90 WPM, 100 %, nothing mistyped
    expect(big()).toEqual(['90WPM', '100%']);
    expect(wrongChips()).toBe(0);
    expect(stored()[0]).toMatchObject({ wpm: 90, raw: 90, acc: 1, wordsPerMin: 100 });
  });

  it('restart: a new box element, focus in it, empty (mutant 11)', async () => {
    setPrefs({ kind: 'words', count: 10 });
    await mountPage();
    const first = box();
    await type('the cat');
    btn(t('tt.again')).click(); // during a run
    await nextTick();
    await nextTick();
    const second = box();
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
    expect(second.value).toBe('');
    expect(document.activeElement).toBe(second);
    expect(TEXT.made).toBe(1); // the same text
    clock += 6000;
    await type(EN25.slice(0, 10).join(' '));
    expect(heading()).not.toBeNull();
    btn(t('tt.new')).click(); // the result card's
    await nextTick();
    await nextTick();
    expect(box()).not.toBe(second);
    expect(box().value).toBe('');
    expect(box().readOnly).toBe(false);
    expect(document.activeElement).toBe(box());
    expect(heading()).toBeNull();
    expect(TEXT.made).toBe(2);
  });

  it('an option change during a run makes a new text and saves nothing (mutant 18)', async () => {
    setPrefs({ kind: 'time', time: 15 });
    await mountPage();
    await type('the cat sat ');
    TEXT.words = ['một', 'hai', 'ba'];
    document.querySelector<HTMLButtonElement>('[aria-labelledby="tt-o-content"] [data-v="sentences"]')!.click();
    await nextTick();
    expect(document.querySelector('.tt-text__in')!.textContent!.trim()).toBe('một hai ba');
    expect(document.querySelector('.tt-count')!.textContent).toBe(t('tt.ready'));
    expect(box().value).toBe('');
    await advance(20000);
    expect(heading()).toBeNull();
    expect(stored()).toEqual([]);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ content: 'sentences' });
  });

  it('leaving the page drops the run: no timer left, nothing saved', async () => {
    setPrefs({ kind: 'time', time: 15 });
    await mountPage();
    await type('the cat ');
    w!.unmount();
    w = null;
    expect(vi.getTimerCount()).toBe(0);
    await advance(20000);
    expect(stored()).toEqual([]);
  });
});

describe('typing page: announcements (DESIGN TT §14 test 4)', () => {
  /** Types 20 words letter by letter; returns how many times the live paragraph changed to a non-empty text. */
  async function run20(): Promise<{ changes: number; texts: string[] }> {
    const texts: string[] = [];
    let changes = 0;
    const obs = new MutationObserver(() => {
      if (say().textContent) { changes++; texts.push(say().textContent!); }
    });
    obs.observe(say(), { childList: true, characterData: true, subtree: true });
    let v = '';
    for (const word of EN25.slice(0, 20)) {
      for (const c of `${word} `) {
        v += c;
        await type(v);
        await advance(16);
      }
    }
    await nextTick();
    obs.disconnect();
    return { changes, texts };
  }

  it('read-next off (the default): the live paragraph never changes while typing (mutants 13, 14)', async () => {
    setPrefs({ kind: 'time', time: 120 });
    localStorage.removeItem(PREFS_KEY);
    await mountPage();
    expect(document.querySelector('[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
    expect((await run20()).changes).toBe(0);
    expect(say().textContent).toBe('');
  });

  it('read-next on: once per committed word, the next word', async () => {
    setPrefs({ kind: 'time', time: 120, readNext: true });
    await mountPage();
    const { changes, texts } = await run20();
    expect(changes).toBe(20);
    expect(texts).toEqual(EN25.slice(1, 21));
  });

  it('turning read-next on says the word to type once', async () => {
    await mountPage();
    document.querySelector<HTMLButtonElement>('[role="switch"]')!.click();
    await advance(16);
    expect(say().textContent).toBe(EN25[0]);
    expect(JSON.parse(localStorage.getItem(PREFS_KEY)!)).toMatchObject({ readNext: true });
  });

  it('at the end: exactly once, with the tt.say text', async () => {
    setPrefs({ kind: 'words', count: 10 });
    await mountPage();
    let changes = 0;
    const obs = new MutationObserver(() => { if (say().textContent) changes++; });
    obs.observe(say(), { childList: true, characterData: true, subtree: true });
    await type('t');
    clock += 6000;
    await type(`${EN25.slice(0, 9).join(' ')} dog `); // one mistyped word, committed: the 10th word ends the test
    await advance(1000);
    heading()!.dispatchEvent(key('keydown', { key: 'Enter' }));
    await advance(1000);
    obs.disconnect();
    expect(changes).toBe(1);
    // the 9 right words: 23 letters + 9 spaces = 32 ch ÷ 5 ÷ 0.1 min = 64 WPM; "dog" for "it": 2 incorrect, 1 extra →
    // 23 of 26 letters = 88 %
    expect(say().textContent).toBe(t('tt.say', { wpm: '64', acc: '88%', n: 1 }));
  });

  it('the hint line changes only when the hint does', async () => {
    setPrefs({ kind: 'time', time: 120 });
    await mountPage();
    expect(status().getAttribute('role')).toBe('status');
    expect(status().textContent).toBe('');
    let changes = 0;
    const obs = new MutationObserver(() => { changes++; });
    obs.observe(status(), { childList: true, characterData: true, subtree: true });
    await type('thé ');
    expect(status().textContent).toBe(t('tt.hint.imeOn'));
    const after = changes;
    expect(after).toBeGreaterThan(0);
    for (const v of ['thé c', 'thé ca', 'thé cat', 'thé cat ', 'thé cat s']) await type(v);
    await nextTick();
    expect(changes).toBe(after);
    await type('the cat ');
    expect(status().textContent).toBe('');
    obs.disconnect();
  });
});

describe('typing page: safety (DESIGN TT §14 test 6)', () => {
  it('a full test talks to no keyboard and makes no request (mutant 23)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const xhrOpen = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const beacon = vi.fn();
    Object.defineProperty(navigator, 'sendBeacon', { value: beacon, configurable: true });
    const ws = vi.fn();
    vi.stubGlobal('WebSocket', ws);
    try {
      setPrefs({ kind: 'time', time: 15 });
      await mountPage();
      let v = '';
      for (const word of EN25.slice(0, 8)) { v += `${word} `; await type(v); await advance(500); }
      await advance(15000);
      expect(heading()).not.toBeNull();
      btn(t('tt.new')).click();
      await advance(1000);
      expect(exchange).not.toHaveBeenCalled();
      expect(withTransport).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(xhrOpen).not.toHaveBeenCalled();
      expect(beacon).not.toHaveBeenCalled();
      expect(ws).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      delete (navigator as unknown as Record<string, unknown>).sendBeacon;
    }
  });

  it('static: src/typing/, the page and its components import nothing that talks to the keyboard, and make no request', () => {
    const files = [
      ...readdirSync(resolve('src/typing'), { withFileTypes: true }).filter((f) => f.isFile()).map((f) => join('src/typing', f.name)),
      ...readdirSync(resolve('src/components/typing'), { withFileTypes: true }).filter((f) => f.isFile()).map((f) => join('src/components/typing', f.name)),
      'src/pages/TypingPage.vue',
    ];
    expect(files.length).toBeGreaterThanOrEqual(7);
    for (const f of files) {
      const src = readFileSync(resolve(f), 'utf8');
      const imports = [...src.matchAll(/(?:import|from)\s*\(?\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
      for (const i of imports) {
        expect(i, `${f} imports ${i}`).not.toMatch(/(^|\/)protocol(\/|$)|stores\/(device|live|performance|sync|history|calibration|switch|lighting|macro|gamepad|advanced|keymap)|@tauri-apps/);
      }
      expect(src, f).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|sendBeacon|WebSocket|__TAURI|invoke\(/);
    }
  });
});

describe('typing page: strings, route and sidebar (DESIGN TT §14 test 7, §1)', () => {
  it('every tt.* key exists in both languages, and page.typing', () => {
    const viKeys = Object.keys(typingVi);
    expect(Object.keys(typingEn).sort()).toEqual([...viKeys].sort());
    for (const k of [...viKeys, 'page.typing']) {
      expect((viDict as Record<string, string>)[k], k).toBeTruthy();
      expect((enDict as Record<string, string>)[k], k).toBeTruthy();
    }
    expect(viDict['page.typing']).toBe('Tốc độ gõ');
    expect(enDict['page.typing']).toBe('Typing test');
  });

  it('English uses the app\'s plural form for 1 mistyped word and 1 result', () => {
    locale.value = 'en';
    expect(t('tt.say', { wpm: '40', acc: '90%', n: 1 })).toBe('Done. 40 WPM, 90% accuracy, 1 mistyped word.');
    expect(t('tt.say', { wpm: '40', acc: '90%', n: 2 })).toBe('Done. 40 WPM, 90% accuracy, 2 mistyped words.');
    expect(t('tt.clearBody', { n: 1 })).toBe("Removes 1 result and the best scores saved on this device. This can't be undone.");
    locale.value = 'vi';
    expect(t('tt.say', { wpm: '40', acc: '90%', n: 1 })).toBe('Xong. 40 WPM, độ chính xác 90%, 1 từ sai.');
  });

  it('/typing is a lazy route; the sidebar item comes right after Profile', () => {
    const rec = routes.find((r) => r.path === '/typing')!;
    expect(typeof rec.component).toBe('function');
    expect(rec.meta?.title).toBe('page.typing');
    const kb = NAV.find((g) => g.group === 'nav.groupKeyboard')!.items;
    const i = kb.findIndex((x) => x.path === '/profiles');
    expect(kb[i + 1]).toMatchObject({ path: '/typing', title: 'page.typing', tone: 'var(--f-live)' });
  });

  it('the page reads in English too, with the text language kept apart', async () => {
    locale.value = 'en';
    TEXT.words = [...VI10];
    setPrefs({ lang: 'vi', kind: 'time', time: 30 });
    await mountPage();
    expect(document.querySelector('.tt__title')!.textContent).toBe('Test your typing speed');
    expect(document.querySelector('.tt-mode')!.textContent).toBe('Tiếng Việt · Words · 30 s');
    expect(box().getAttribute('lang')).toBe('vi');
    expect(document.querySelector('.tt-text__in')!.getAttribute('lang')).toBe('vi');
    locale.value = 'vi';
  });
});
