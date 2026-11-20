<script setup lang="ts">
// DESIGN TT: the typing test (English and Vietnamese). The score is taken from the text in the box, never from key events,
// so every Vietnamese input method works (composition events, Unikey's Backspace + text, NFD). The page talks to no
// keyboard, makes no request, and keeps its results in this browser only (src/typing/store.ts).
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { IconInfoCircle, IconRefresh, IconRepeat } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Segmented from '../components/ui/Segmented.vue';
import Switch from '../components/ui/Switch.vue';
import Button from '../components/ui/Button.vue';
import TypingResult from '../components/typing/TypingResult.vue';
import type { ShownResult } from '../components/typing/TypingResult.vue';
import TypingHistory from '../components/typing/TypingHistory.vue';
import { t } from '../i18n/vi';
import { finished, hint, onTrack, same, score, split } from '../typing/score';
import type { Hint, TextLang } from '../typing/score';
import { MORE_WHEN_LEFT, makeText, moreWords } from '../typing/texts';
import type { Content, EndKind } from '../typing/texts';
import { COUNTS, TIMES, addResult, clearHistory, loadPrefs, loadResults, savePrefs } from '../typing/store';
import type { Prefs } from '../typing/store';
import { kindText, mmss, num, pct } from '../typing/format';

const prefs = reactive<Prefs>(loadPrefs());
const target = ref<string[]>(newText());
/** A new <textarea> per run (:key): clearing its value would leave the browser's undo history (Ctrl+Z) of the last run. */
const runId = ref(0);
const phase = ref<'idle' | 'running' | 'done'>('idle');
/** An IME composition is open in the box (compositionstart → compositionend). */
const composing = ref(false);
/** The box's value at the last scored input. */
const last = ref('');
/** performance.now() at the start, and repainted every 200 ms while running (the clock only). */
const t0 = ref(0);
const nowMs = ref(0);
/** Words mode: the time counted at the end. */
const endMs = ref(0);
const hintKey = ref<Hint | null>(null);
/** The one hidden polite paragraph: the result once, and the next word when "Đọc từ tiếp theo" is on (DESIGN TT §8). */
const say = ref('');
const result = ref<ShownResult | null>(null);
const results = ref(loadResults());
const shift = ref(0);

const box = ref<HTMLTextAreaElement | null>(null);
const textIn = ref<HTMLElement | null>(null);
const resultCard = ref<InstanceType<typeof TypingResult> | null>(null);

let timer: ReturnType<typeof setTimeout> | undefined;
let tick: ReturnType<typeof setInterval> | undefined;
let raf = 0;
/** Committed words at the last input (read-next speaks when it grows). */
let doneN = 0;

const lenN = computed(() => (prefs.kind === 'time' ? prefs.time : prefs.count));
const kind = computed(() => ({ lang: prefs.lang, content: prefs.content, kind: prefs.kind, n: lenN.value }));

function newText(): string[] {
  return makeText(prefs.lang, prefs.content, prefs.kind, prefs.count);
}

// ----- options: any change makes a new text and an idle test; a run in progress is dropped, not saved
const langOpts = computed(() => [{ value: 'en' as TextLang, label: t('tt.lang.en') }, { value: 'vi' as TextLang, label: t('tt.lang.vi') }]);
const contentOpts = computed(() => [
  { value: 'words' as Content, label: t('tt.content.words') },
  { value: 'sentences' as Content, label: t('tt.content.sentences') },
]);
const kindOpts = computed(() => [{ value: 'time' as EndKind, label: t('tt.kind.time') }, { value: 'words' as EndKind, label: t('tt.kind.words') }]);
const lenOpts = computed(() => (prefs.kind === 'time'
  ? TIMES.map((n) => ({ value: n as number, label: t('tt.sec', { n }) }))
  : COUNTS.map((n) => ({ value: n as number, label: String(n), ariaLabel: t('tt.nWords', { n }) }))));

function change(p: Partial<Prefs>): void {
  Object.assign(prefs, p);
  savePrefs(prefs);
  target.value = newText();
  restart(false);
}
function setLen(n: number | null): void {
  if (n !== null) change(prefs.kind === 'time' ? { time: n } : { count: n });
}
function setReadNext(on: boolean): void {
  prefs.readNext = on;
  savePrefs(prefs);
  if (on) sayNext();
}

// ----- runs
function clearTimers(): void {
  clearTimeout(timer);
  clearInterval(tick);
  cancelAnimationFrame(raf);
  timer = tick = undefined;
}

function restart(focus: boolean): void {
  clearTimers();
  phase.value = 'idle';
  composing.value = false;
  last.value = '';
  hintKey.value = null;
  result.value = null;
  say.value = '';
  shift.value = 0;
  doneN = 0;
  runId.value++;
  if (focus) void nextTick(() => box.value?.focus());
}
function newRun(): void {
  target.value = newText();
  restart(true);
}

function start(): void {
  phase.value = 'running';
  t0.value = nowMs.value = performance.now();
  if (prefs.kind === 'time') timer = setTimeout(() => finish('time', last.value), prefs.time * 1000);
  tick = setInterval(() => { nowMs.value = performance.now(); }, 200);
}
const timeUp = (): boolean => prefs.kind === 'time' && phase.value === 'running' && performance.now() - t0.value >= prefs.time * 1000;

/** `input` and `compositionend`: read the box's value and score it. */
function onInput(): void {
  const el = box.value;
  if (phase.value === 'done' || !el) return;
  const v = el.value;
  if (phase.value === 'idle') {
    if (v.trim() === '') return; // focus or a leading space does not start the clock
    start();
  }
  if (timeUp()) { finish('time', last.value); return; } // a late timer: this input is after the deadline, not counted
  last.value = v;
  const { done } = split(v);
  if (prefs.kind === 'time' && done.length > target.value.length - MORE_WHEN_LEFT) {
    target.value = [...target.value, ...moreWords(prefs.lang, prefs.content)];
  }
  const h = hint({ target: target.value, value: v, lang: prefs.lang });
  if (h !== hintKey.value) hintKey.value = h;
  if (prefs.kind === 'words' && finished({ target: target.value, value: v, n: prefs.count, composing: composing.value })) {
    finish('words', v);
    return;
  }
  const grew = done.length > doneN;
  doneN = done.length;
  if (grew && prefs.readNext) sayNext();
}

function onCompositionEnd(): void {
  composing.value = false;
  onInput();
}

function onKeydown(e: KeyboardEvent): void {
  // Enter (any modifier) never reaches the text; while an IME composes, Enter is the IME's (it commits).
  if ((e.key === 'Enter' || e.code === 'NumpadEnter') && !e.isComposing && e.keyCode !== 229) e.preventDefault();
}
const BLOCKED_INPUT = new Set(['insertFromPaste', 'insertFromDrop', 'insertLineBreak', 'insertParagraph', 'insertFromYank']);
function onBeforeInput(e: InputEvent): void {
  if (BLOCKED_INPUT.has(e.inputType)) e.preventDefault();
}

/** Read-next: the word to type now, cleared then set in the next frame so the same word twice is read twice. */
function sayNext(): void {
  const w = target.value[doneN];
  if (!w || phase.value === 'done') return;
  say.value = '';
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(() => { if (phase.value !== 'done') say.value = w; });
}

function finish(end: 'time' | 'words', value: string): void {
  if (phase.value !== 'running') return;
  // Read first: making the box read-only, or a blur, can end the composition (v1.1, DESIGN TT §3.5).
  const wasComposing = end === 'time' && composing.value;
  clearTimers();
  const ms = end === 'time' ? prefs.time * 1000 : performance.now() - t0.value;
  phase.value = 'done';
  endMs.value = ms;
  const el = box.value;
  if (el) {
    if (el.value !== value) el.value = value; // the run is over: a late input is taken back out
    el.readOnly = true;
    el.setAttribute('aria-readonly', 'true');
  }
  composing.value = false;
  last.value = value;
  const r = score({ target: target.value, value, ms, end, lang: prefs.lang, composing: wasComposing });
  const wpm = Math.round(r.wpm);
  const saved = addResult({
    at: Date.now(), ...kind.value, wpm, raw: Math.round(r.raw), acc: r.accuracy, wordsPerMin: Math.round(r.wordsPerMin), seconds: r.seconds,
  });
  results.value = loadResults();
  result.value = {
    wpm, raw: r.raw, wordsPerMin: r.wordsPerMin, accuracy: r.accuracy, letters: r.letters, seconds: r.seconds, wrong: r.wrong,
    isBest: saved.isBest, prevBest: saved.prevBest, kind: kindText(kind.value), lang: prefs.lang,
  };
  say.value = t('tt.say', { wpm: num(wpm), acc: pct(r.accuracy), n: r.wrong.length });
  void nextTick(() => resultCard.value?.reveal());
}

function onClear(): void {
  clearHistory();
  results.value = [];
}

/** A hidden tab throttles timers: back on screen, the deadline is checked first. */
function onVisibility(): void {
  if (document.visibilityState === 'visible' && timeUp()) finish('time', last.value);
}
onMounted(() => document.addEventListener('visibilitychange', onVisibility));
onBeforeUnmount(() => {
  clearTimers(); // leaving the page drops the run: nothing is saved
  document.removeEventListener('visibilitychange', onVisibility);
});

// ----- the text: words coloured whole (DESIGN TT §4.1)
const wordCls = computed(() => {
  if (phase.value === 'idle') return target.value.map(() => 'up');
  const { done, current } = split(last.value);
  return target.value.map((w, i) => {
    if (i < done.length) return same(done[i], w) ? 'ok' : 'bad';
    if (i === done.length) return composing.value || onTrack(current, w, prefs.lang) ? 'cur' : 'off';
    return 'up';
  });
});
/** From the second line on, the word being typed stays on the second line (the paragraph moves up by whole lines). */
watch([last, target], () => {
  const spans = textIn.value?.children;
  if (!spans?.length) return;
  const cur = spans[Math.min(split(last.value).done.length, spans.length - 1)] as HTMLElement;
  const lh = 36;
  const line = Math.round(cur.offsetTop / lh);
  shift.value = line >= 1 ? (line - 1) * lh : 0;
}, { flush: 'post' });

const HINT_TEXT = { imeOn: 'tt.hint.imeOn', imeOff: 'tt.hint.imeOff', charset: 'tt.hint.charset' } as const;
const hintText = computed(() => (hintKey.value ? t(HINT_TEXT[hintKey.value]) : ''));

// ----- the status row
const elapsed = computed(() => (phase.value === 'idle' ? 0 : phase.value === 'done' ? endMs.value : Math.max(0, nowMs.value - t0.value)));
const doneWords = computed(() => Math.min(prefs.count, split(last.value).done.length));
const clock = computed(() => {
  if (prefs.kind === 'words') return mmss(elapsed.value / 1000);
  if (phase.value === 'idle') return mmss(prefs.time);
  if (phase.value === 'done') return mmss(0);
  return mmss(Math.max(0, prefs.time - Math.floor(elapsed.value / 1000)));
});
const clockSmall = computed(() => (prefs.kind === 'time' && phase.value !== 'idle' ? t(phase.value === 'done' ? 'tt.timeUp' : 'tt.left') : ''));
const countText = computed(() => {
  if (phase.value === 'idle') return t('tt.ready');
  return prefs.kind === 'words' ? t('tt.progress', { d: doneWords.value, n: prefs.count }) : '';
});
const progress = computed(() => {
  if (phase.value === 'done') return 100;
  return prefs.kind === 'time' ? Math.min(100, (elapsed.value / (prefs.time * 1000)) * 100) : (doneWords.value / prefs.count) * 100;
});
</script>

<template>
  <PageLayout :title="t('page.typing')">
    <div class="tt">
      <div class="tt__head">
        <h2 id="tt-title" class="tt__title">{{ t('tt.title') }}</h2>
        <p class="tt__sub">{{ t('tt.sub') }}</p>
      </div>

      <div class="tt-opts" role="group" :aria-label="t('tt.opts')">
        <div class="tt-opt">
          <span id="tt-o-lang" class="tt-opt__label">{{ t('tt.opt.lang') }}</span>
          <Segmented :model-value="prefs.lang" :options="langOpts" :label="t('tt.opt.lang')" labelledby="tt-o-lang" size="sm" @update:model-value="(v) => v && change({ lang: v })" />
        </div>
        <div class="tt-opt">
          <span id="tt-o-content" class="tt-opt__label">{{ t('tt.opt.content') }}</span>
          <Segmented :model-value="prefs.content" :options="contentOpts" :label="t('tt.opt.content')" labelledby="tt-o-content" size="sm" @update:model-value="(v) => v && change({ content: v })" />
        </div>
        <div class="tt-opt">
          <span id="tt-o-kind" class="tt-opt__label">{{ t('tt.opt.kind') }}</span>
          <Segmented :model-value="prefs.kind" :options="kindOpts" :label="t('tt.opt.kind')" labelledby="tt-o-kind" size="sm" @update:model-value="(v) => v && change({ kind: v })" />
        </div>
        <div class="tt-opt">
          <span id="tt-o-len" class="tt-opt__label">{{ t('tt.opt.len') }}</span>
          <Segmented :model-value="lenN" :options="lenOpts" :label="t('tt.opt.len')" labelledby="tt-o-len" size="sm" @update:model-value="setLen" />
        </div>
        <div class="tt-opt tt-opt--sw">
          <Switch :model-value="prefs.readNext" :label="t('tt.readNext')" describedby="tt-readnext-help" @update:model-value="setReadNext" />
          <span id="tt-readnext-help" class="sr-only">{{ t('tt.readNextHelp') }}</span>
        </div>
      </div>

      <Card class="tt-card" aria-labelledby="tt-title">
        <div class="tt-bar" aria-hidden="true"><i :style="{ width: `${progress}%` }" /></div>
        <div class="tt-status">
          <span class="tt-clock" role="timer">{{ clock }}<small v-if="clockSmall">{{ clockSmall }}</small></span>
          <span class="tt-count">{{ countText }}</span>
          <span class="tt-mode">{{ kindText(kind) }}</span>
        </div>
        <div class="tt-text" @mousedown.prevent="box?.focus()">
          <p ref="textIn" class="tt-text__in" :lang="prefs.lang" :style="shift ? { transform: `translateY(${-shift}px)` } : undefined">
            <template v-for="(w, i) in target" :key="i"><span class="tt-w" :class="`tt-w--${wordCls[i]}`">{{ w }}</span>{{ ' ' }}</template>
          </p>
        </div>
        <div>
          <label class="tt-boxlabel" for="tt-box">{{ t('tt.box') }}</label>
          <textarea
            id="tt-box"
            :key="runId"
            ref="box"
            class="tt-box"
            rows="3"
            :lang="prefs.lang"
            spellcheck="false"
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            aria-describedby="tt-boxhelp"
            @compositionstart="composing = true"
            @compositionend="onCompositionEnd"
            @input="onInput"
            @keydown="onKeydown"
            @beforeinput="onBeforeInput"
            @paste.prevent
            @drop.prevent
          />
          <p id="tt-boxhelp" class="tt-boxhelp">{{ t('tt.boxHelp') }}</p>
        </div>
        <p class="tt-hint" role="status"><template v-if="hintKey"><IconInfoCircle :size="15" stroke-width="1.5" aria-hidden="true" /><span>{{ hintText }}</span></template></p>
        <div v-if="phase !== 'done'" class="tt-acts">
          <Button variant="secondary" :icon="IconRefresh" @click="newRun">{{ t('tt.new') }}</Button>
          <Button variant="ghost" :icon="IconRepeat" @click="restart(true)">{{ t('tt.again') }}</Button>
        </div>
      </Card>

      <TypingResult v-if="result" ref="resultCard" :result="result" @new="newRun" @again="restart(true)" />
      <TypingHistory :results="results" @clear="onClear" />
      <p class="sr-only tt-say" aria-live="polite">{{ say }}</p>
    </div>
  </PageLayout>
</template>

<style scoped>
.tt { display: flex; flex-direction: column; gap: var(--s-5); width: 100%; max-width: 940px; margin: 0 auto; }
@media (min-width: 1600px) { .tt { max-width: 1100px; } }
.tt__head { display: flex; flex-direction: column; gap: 2px; }
.tt__title { margin: 0; font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); }
.tt__sub { margin: 0; max-width: 78ch; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }

/* options: one wrapping row of labelled groups */
.tt-opts { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-3) var(--s-5); }
.tt-opt { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tt-opt__label { font-size: var(--fs-caption); font-weight: 500; color: var(--fg-3); }
.tt-opt--sw { padding-bottom: 6px; }

/* the test card */
.tt-card { position: relative; overflow: hidden; }
.tt-bar { position: absolute; inset: 0 0 auto 0; height: 3px; background: var(--line-1); }
.tt-bar > i { display: block; height: 100%; background: var(--acc); }
.tt-status { display: flex; align-items: baseline; gap: var(--s-3); min-height: 30px; }
.tt-clock { font-size: 24px; font-weight: 600; color: var(--fg-1); font-variant-numeric: tabular-nums; }
.tt-clock small { margin-left: 6px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-3); }
.tt-count { font-size: var(--fs-body); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.tt-mode { margin-left: auto; font-size: var(--fs-label); color: var(--fg-3); }

/* the text to type: three lines, the current word kept on the second line from the second line on */
.tt-text { --lh: 36px; position: relative; height: calc(var(--lh) * 3); overflow: hidden; cursor: text; }
.tt-text__in { margin: 0; font-size: 22px; line-height: var(--lh); letter-spacing: 0.005em; color: var(--fg-2); transition: transform var(--t-med) var(--ease); overflow-wrap: anywhere; }
.tt-w { padding: 2px 1px; border-radius: 4px; }
.tt-w--ok { color: var(--ok); }
.tt-w--bad { color: var(--danger); text-decoration: underline wavy var(--danger); text-decoration-thickness: 1.5px; text-underline-offset: 5px; }
.tt-w--cur { color: var(--fg-1); background: var(--acc-soft); box-shadow: inset 0 -2px 0 var(--acc); }
.tt-w--off { color: var(--danger); background: var(--danger-soft); box-shadow: inset 0 -2px 0 var(--danger); }

.tt-boxlabel { display: block; margin-bottom: 6px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-2); }
.tt-box {
  display: block; width: 100%; box-sizing: border-box; height: 84px; resize: none; padding: var(--s-2) var(--s-3);
  background: var(--bg-1); color: var(--fg-1); border: 1px solid var(--line-2); border-radius: var(--r-control);
  font: inherit; font-size: 18px; line-height: 26px;
}
.tt-box:focus-visible, .tt-box:focus { outline: none; box-shadow: var(--focus-ring); border-color: transparent; }
.tt-box[readonly] { color: var(--fg-3); background: var(--bg-3); }
.tt-boxhelp { margin: 6px 0 0; font-size: var(--fs-caption); color: var(--fg-3); }
.tt-hint { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control); background: var(--warn-soft); color: var(--warn); font-size: var(--fs-label); line-height: 18px; }
.tt-hint:empty { display: none; }
.tt-hint svg { flex: none; margin-top: 1px; }
.tt-acts { display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center; }

@media (prefers-reduced-motion: reduce) { .tt-text__in { transition: none; } }
</style>
