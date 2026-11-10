<script setup lang="ts">
// Read-only: what Standard mode does with the key's own numbers (press and release). Writes nothing.
import { computed } from 'vue';
import Card from '../ui/Card.vue';
import { t } from '../../i18n/vi';

const props = defineProps<{
  /** Actuation range over the selection [min, max] (mm). */
  actuation: [number, number];
  /** Release range over the selection [min, max] (mm). */
  release: [number, number];
  /** Full travel (mm): the bottom of the diagram. */
  maxTravel: number;
  /** Number formatter shared with the page. */
  fmt: (v: number) => string;
}>();

const span = (r: [number, number]) => (r[1] - r[0] < 0.0005 ? props.fmt(r[0]) : `${props.fmt(r[0])}–${props.fmt(r[1])}`);
const aText = computed(() => span(props.actuation));
const rText = computed(() => span(props.release));

// Plot space is 0..100 on both axes: 0 mm at y=4, full travel at y=92 (the lines are drawn at the shallowest key).
const Y0 = 4;
const Y1 = 92;
const yOf = (mm: number) => Y0 + Math.min(1, Math.max(0, mm / (props.maxTravel || 1))) * (Y1 - Y0);
const ya = computed(() => yOf(props.actuation[0]));
const yr = computed(() => yOf(props.release[0]));
const xDown = (y: number) => 12 + ((y - Y0) / (Y1 - Y0)) * 22;
const xUp = (y: number) => 84 - ((y - Y0) / (Y1 - Y0)) * 22;
const showRelease = computed(() => Math.abs(props.release[0] - props.actuation[0]) >= 0.0005);
const fillPoints = computed(() => `${xDown(ya.value)},${ya.value} 34,${Y1} 62,${Y1} ${xUp(ya.value)},${ya.value}`);
// Same inset as the SVG (12px / 10px), so the dots sit exactly on the stroke.
const px = (v: number) => `calc(12px + (100% - 24px) * ${v / 100})`;
const py = (v: number) => `calc(10px + (100% - 20px) * ${v / 100})`;
const yRel = computed(() => (showRelease.value ? yr.value : ya.value));
const pressDot = computed(() => ({ left: px(xDown(ya.value)), top: py(ya.value) }));
const releaseDot = computed(() => ({ left: px(xUp(yRel.value)), top: py(yRel.value) }));
</script>

<template>
  <Card class="std" :title="t('perf.stdCycle')" :subtitle="t('perf.stdCycleHint', { a: aText, r: rText })">
    <div class="std__plot">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
        <polygon :points="fillPoints" class="std__fill" />
        <line x1="0" :y1="ya" x2="100" :y2="ya" class="std__line std__line--act" />
        <line v-if="showRelease" x1="0" :y1="yr" x2="100" :y2="yr" class="std__line std__line--rel" />
        <polyline points="0,4 12,4 34,92 62,92 84,4 100,4" class="std__stroke" />
      </svg>
      <span class="std__dot std__dot--press" :style="pressDot" />
      <span class="std__dot std__dot--release" :style="releaseDot" />
    </div>
    <div class="std__legend">
      <span><i class="std__key std__key--press" />{{ t('live.legendPress') }} <b class="num">{{ aText }} mm</b></span>
      <span><i class="std__key std__key--release" />{{ t('live.legendRelease') }} <b class="num">{{ rText }} mm</b></span>
    </div>
    <p class="std__note">{{ t('perf.stdCycleRt') }}</p>
  </Card>
</template>

<style scoped>
/* The plot takes the card's spare height (the card is a grower in its column). */
.std__plot { position: relative; flex: 1 1 auto; min-height: 132px; border-radius: var(--r-control); background: var(--bg-1); border: 1px solid var(--line-1); }
.std__plot svg { position: absolute; inset: 10px 12px; width: calc(100% - 24px); height: calc(100% - 20px); overflow: visible; }
.std__stroke { fill: none; stroke: var(--fg-1); stroke-width: 2; stroke-linejoin: round; vector-effect: non-scaling-stroke; }
.std__line { stroke-width: 1.5; stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
.std__line--act { stroke: var(--m-actuation); }
.std__line--rel { stroke: var(--m-release); }
.std__fill { fill: color-mix(in srgb, var(--m-actuation) 16%, transparent); }
/* Markers are HTML so they stay round under the stretched SVG; positions map onto the SVG's inset box. */
.std__dot { position: absolute; box-sizing: border-box; width: 10px; height: 10px; margin: -5px 0 0 -5px; border-radius: 50%; }
.std__dot--press { background: var(--m-press); }
.std__dot--release { border: 2px solid var(--m-release); background: var(--bg-1); }
.std__legend { display: flex; flex-wrap: wrap; gap: var(--s-4); font-size: var(--fs-label); color: var(--fg-2); }
.std__legend span { display: inline-flex; align-items: center; gap: 6px; }
.std__legend b { font-weight: 600; color: var(--fg-1); }
.std__key { width: 9px; height: 9px; box-sizing: border-box; border-radius: 50%; }
.std__key--press { background: var(--m-press); }
.std__key--release { border: 2px solid var(--m-release); }
.std__note { margin: 0; font-size: var(--fs-label); color: var(--fg-3); line-height: 1.45; }
</style>
