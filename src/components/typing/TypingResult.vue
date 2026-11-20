<script setup lang="ts">
// DESIGN TT §2 item 4, §5: the result of a finished test. Its heading takes focus at the end (never a button: a fast
// typist's next Space or Enter would press it).
import { ref } from 'vue';
import { IconInfoCircle, IconRefresh, IconRepeat, IconTrophy } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import { t } from '../../i18n/vi';
import { mmss, num, pct } from '../../typing/format';
import type { Letters, TextLang, WrongWord } from '../../typing/score';

export interface ShownResult {
  /** Shown (rounded) WPM. */
  wpm: number;
  raw: number;
  wordsPerMin: number;
  accuracy: number;
  letters: Letters;
  seconds: number;
  wrong: WrongWord[];
  /** False: faster than anyone types, shown but not saved (DESIGN TT §7, v1.4). */
  kept: boolean;
  isBest: boolean;
  prevBest: number | null;
  /** The test kind, e.g. "Tiếng Việt · Từ · 30 giây". */
  kind: string;
  lang: TextLang;
}

defineProps<{ result: ShownResult }>();
defineEmits<{ new: []; again: [] }>();

const head = ref<HTMLElement | null>(null);
/** Focus the heading and bring the card into view (DESIGN TT §2: the figures on screen at 1366×768 too). */
function reveal(): void {
  head.value?.focus({ preventScroll: true });
  head.value?.closest('.card')?.scrollIntoView?.({ block: 'nearest' });
}
defineExpose({ reveal });
</script>

<template>
  <Card class="tt-res" aria-labelledby="tt-res-title">
    <h3 id="tt-res-title" ref="head" class="tt-res__title" tabindex="-1">{{ t('tt.result') }}</h3>
    <div class="tt-res__top">
      <div class="tt-big"><b>{{ result.kept ? num(result.wpm) : '—' }}<small>WPM</small></b><span>{{ t('tt.wpmCap') }}</span></div>
      <div class="tt-big tt-big--2"><b>{{ pct(result.accuracy) }}</b><span>{{ t('tt.acc') }}</span></div>
      <span v-if="!result.kept" class="tt-best tt-best--plain">{{ t('tt.notSaved') }}</span>
      <span v-else-if="result.isBest" class="tt-best"><IconTrophy :size="15" stroke-width="1.5" aria-hidden="true" />{{ t('tt.best') }}</span>
      <span v-else class="tt-best tt-best--plain">{{ t('tt.bestWas', { n: num(result.prevBest ?? 0) }) }}</span>
    </div>
    <p v-if="!result.kept" class="tt-note"><IconInfoCircle :size="15" stroke-width="1.5" aria-hidden="true" /><span>{{ t('tt.notSavedWhy') }}</span></p>
    <dl class="tt-dl">
      <div><dt>{{ t('tt.wpmWords') }}</dt><dd>{{ result.kept ? num(Math.round(result.wordsPerMin)) : '—' }}</dd></div>
      <div><dt>{{ t('tt.raw') }}</dt><dd>{{ result.kept ? `${num(Math.round(result.raw))} WPM` : '—' }}</dd></div>
      <div>
        <dt>{{ t('tt.letters') }}</dt>
        <dd>{{ t('tt.lettersVal', { c: num(result.letters.correct), i: num(result.letters.incorrect), m: num(result.letters.missed), x: num(result.letters.extra) }) }}</dd>
      </div>
      <div><dt>{{ t('tt.dur') }}</dt><dd>{{ mmss(Math.round(result.seconds)) }}</dd></div>
      <div><dt>{{ t('tt.test') }}</dt><dd>{{ result.kind }}</dd></div>
    </dl>
    <div>
      <h4 class="tt-wrong__title">{{ t('tt.wrong', { n: result.wrong.length }) }}</h4>
      <ul v-if="result.wrong.length" class="tt-wrong">
        <li v-for="w in result.wrong" :key="w.i">
          <span :lang="result.lang">{{ w.target }}</span><span class="arr" aria-hidden="true">→</span><span class="sr-only"> {{ t('tt.typedAs') }} </span><span class="typed" :lang="result.lang">{{ w.typed || t('tt.typedNothing') }}</span>
        </li>
      </ul>
      <p v-else class="tt-none">{{ t('tt.none') }}</p>
    </div>
    <p class="tt-how">{{ t('tt.how') }}</p>
    <div class="tt-acts">
      <Button variant="primary" :icon="IconRefresh" @click="$emit('new')">{{ t('tt.new') }}</Button>
      <Button variant="secondary" :icon="IconRepeat" @click="$emit('again')">{{ t('tt.again') }}</Button>
    </div>
  </Card>
</template>

<style scoped>
.tt-res__title { align-self: flex-start; margin: 0 0 0 -4px; padding: 0 4px; font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); outline: none; }
.tt-res__title:focus-visible { box-shadow: var(--focus-ring); border-radius: 4px; }
.tt-res__top { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-3) var(--s-7); }
.tt-big { display: flex; flex-direction: column; gap: 2px; }
.tt-big b { font-size: 44px; line-height: 48px; font-weight: 650; color: var(--fg-1); font-variant-numeric: tabular-nums; }
.tt-big b small { margin-left: 6px; font-size: var(--fs-card); font-weight: 600; color: var(--fg-2); }
.tt-big span { font-size: var(--fs-label); color: var(--fg-3); }
.tt-big--2 b { font-size: 32px; line-height: 40px; }
.tt-best { display: inline-flex; align-items: center; gap: 6px; align-self: center; padding: 4px 10px; border-radius: 999px; background: var(--ok-soft); color: var(--ok); font-size: var(--fs-label); font-weight: 600; }
.tt-best--plain { background: var(--bg-3); color: var(--fg-2); font-weight: 500; }
.tt-note { display: flex; align-items: flex-start; gap: 8px; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control); background: var(--warn-soft); color: var(--warn); font-size: var(--fs-label); line-height: 18px; }
.tt-note svg { flex: none; margin-top: 1px; }
.tt-dl { display: flex; flex-wrap: wrap; gap: var(--s-2) var(--s-5); margin: 0; }
.tt-dl > div { flex: 1 1 auto; min-width: 140px; display: flex; flex-direction: column; gap: 2px; padding-top: var(--s-2); border-top: 1px solid var(--line-1); }
.tt-dl dt { font-size: var(--fs-caption); color: var(--fg-3); }
.tt-dl dd { margin: 0; font-size: var(--fs-body); color: var(--fg-1); font-variant-numeric: tabular-nums; }
.tt-wrong__title { margin: 0 0 6px; font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); }
.tt-wrong { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 0; list-style: none; }
.tt-wrong li { padding: 3px 8px; border-radius: var(--r-control); background: var(--bg-3); font-size: var(--fs-body); color: var(--fg-1); }
.tt-wrong li .typed { color: var(--danger); }
.tt-wrong li .arr { margin: 0 4px; color: var(--fg-3); }
.tt-none { margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.tt-how { margin: 0; font-size: var(--fs-caption); line-height: 17px; color: var(--fg-3); max-width: 90ch; }
.tt-acts { display: flex; flex-wrap: wrap; gap: var(--s-2); align-items: center; }
</style>
