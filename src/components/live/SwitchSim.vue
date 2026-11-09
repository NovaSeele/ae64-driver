<script setup lang="ts">
// Side cut-away of a Hall-effect switch (left) and a magnified travel gauge (right). 0 mm is at the top,
// deeper is lower. The page feeds new props once per animation frame; nothing here animates on its own.
import { computed } from 'vue';
import type { ActuationSettings } from '../../stores/live';
import { releasePoint } from '../../stores/live';
import { isRtMode } from '../../protocol';
import { t } from '../../i18n/vi';

const props = defineProps<{
  travel: number;
  peak: number;
  range: number;
  settings: ActuationSettings | null;
  /** RT dynamic lines (mm) from the actuation model. */
  resetAt: number | null;
  reactuateAt: number | null;
  /** Firmware status: the key is actuated. */
  actuated: boolean;
  label: string;
}>();

// gauge geometry (viewBox units)
const GY0 = 34;
const GY1 = 346;
const TRACK_X = 236;
const TRACK_W = 16;
const LABEL_X = 276;
const LABEL_GAP = 14;
// switch geometry
const STEM_TRAVEL = 32; // cap bottom (y 84) meets the housing top (y 118) at full travel
const FLOOR_Y = 292;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const ratio = computed(() => clamp01(props.travel / props.range));
const gy = (mm: number) => GY0 + clamp01(mm / props.range) * (GY1 - GY0);
const d = computed(() => ratio.value * STEM_TRAVEL);

const ticks = computed(() => {
  const out: { y: number; major: boolean; label?: string }[] = [];
  const n = Math.floor(props.range * 10 + 1e-6);
  for (let i = 0; i <= n; i++) {
    const major = i % 5 === 0;
    out.push({ y: gy(i / 10), major, label: major ? (i / 10).toFixed(1) : undefined });
  }
  return out;
});

type Kind = 'act' | 'rel' | 'reset' | 'react' | 'dead';
interface Marker { mm: number; text: string; kind: Kind }

const markers = computed<Marker[]>(() => {
  const s = props.settings;
  if (!s) return [];
  const f = (v: number) => v.toFixed(2);
  const out: Marker[] = [];
  if (isRtMode(s.mode)) {
    out.push({ mm: s.rtFirstTouch, text: `${t('live.mFirst')} ${f(s.rtFirstTouch)}`, kind: 'act' });
    if (props.resetAt !== null) out.push({ mm: props.resetAt, text: `${t('live.mReset')} ${f(props.resetAt)}`, kind: 'reset' });
    if (props.reactuateAt !== null) out.push({ mm: props.reactuateAt, text: `${t('live.mReactuate')} ${f(props.reactuateAt)}`, kind: 'react' });
  } else {
    out.push({ mm: s.normalPress, text: `${t('live.mActuation')} ${f(s.normalPress)}`, kind: 'act' });
    const rel = releasePoint(s);
    if (Math.abs(rel - s.normalPress) > 0.0005) out.push({ mm: rel, text: `${t('live.mRelease')} ${f(rel)}`, kind: 'rel' });
  }
  if (s.pressDeadStroke > 0) out.push({ mm: s.pressDeadStroke, text: `${t('live.mDeadTop')} ${f(s.pressDeadStroke)}`, kind: 'dead' });
  if (s.releaseDeadStroke > 0) {
    out.push({ mm: s.range - s.releaseDeadStroke, text: `${t('live.mDeadBottom')} ${f(s.releaseDeadStroke)}`, kind: 'dead' });
  }
  return out;
});

/** Label positions: sorted by depth and pushed apart so they never overlap. */
const labelled = computed(() => {
  const list = markers.value.map((m) => ({ ...m, y: gy(m.mm), ly: gy(m.mm) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < list.length; i++) list[i].ly = Math.max(list[i].ly, list[i - 1].ly + LABEL_GAP);
  const over = list.length ? list[list.length - 1].ly - (GY1 + 4) : 0;
  if (over > 0) for (const m of list) m.ly -= over;
  return list;
});

const deadTop = computed(() => (props.settings && props.settings.pressDeadStroke > 0 ? gy(props.settings.pressDeadStroke) - GY0 : 0));
const deadBottom = computed(() => (props.settings && props.settings.releaseDeadStroke > 0 ? GY1 - gy(props.range - props.settings.releaseDeadStroke) : 0));

/** Zig-zag spring between the magnet and the housing floor; compresses as the stem goes down. */
const spring = computed(() => {
  const top = 216 + d.value;
  const coils = 8;
  const step = (FLOOR_Y - top) / (coils * 2);
  let p = `M100 ${top}`;
  for (let i = 1; i < coils * 2; i++) p += ` L${i % 2 ? 80 : 120} ${top + i * step}`;
  return `${p} L100 ${FLOOR_Y}`;
});
const field = computed(() => 0.12 + ratio.value * 0.7);
</script>

<template>
  <svg class="sim" :class="{ 'sim--on': actuated }" viewBox="0 0 440 380" role="img" :aria-label="label">
    <defs>
      <linearGradient id="sim-cap" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--ill-cap-top)" />
        <stop offset="1" stop-color="var(--ill-cap-bottom)" />
      </linearGradient>
      <linearGradient id="sim-house" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--ill-house-top)" />
        <stop offset="1" stop-color="var(--ill-house-bottom)" />
      </linearGradient>
      <linearGradient id="sim-fill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="var(--m-press)" stop-opacity=".06" />
        <stop offset="1" stop-color="var(--m-press)" stop-opacity=".38" />
      </linearGradient>
      <pattern id="sim-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="3" height="6" fill="var(--m-deadzone)" opacity=".22" />
      </pattern>
    </defs>

    <!-- ===== switch cut-away ===== -->
    <!-- bottom housing (cut) -->
    <path d="M30 152 h140 v136 a10 10 0 0 1 -10 10 h-120 a10 10 0 0 1 -10 -10 z" fill="url(#sim-house)" stroke="var(--line-2)" />
    <path d="M44 160 v124 M156 160 v124" stroke="var(--line-1)" />
    <!-- spring -->
    <path :d="spring" fill="none" stroke="var(--fg-3)" stroke-width="2" stroke-linejoin="round" />
    <!-- Hall sensor on the PCB + field hint -->
    <rect x="6" y="304" width="188" height="9" rx="2" fill="var(--bg-4)" />
    <rect x="86" y="296" width="28" height="8" rx="2" class="sim__sensor" />
    <g class="sim__field" :style="{ opacity: field }">
      <path :d="`M88 ${222 + d} C 62 ${250 + d / 2}, 62 280, 92 298`" />
      <path :d="`M112 ${222 + d} C 138 ${250 + d / 2}, 138 280, 108 298`" />
    </g>

    <!-- moving part: keycap + stem + magnet -->
    <g :transform="`translate(0 ${d})`">
      <rect x="91" y="84" width="18" height="118" rx="3" fill="var(--ill-stem)" />
      <rect x="84" y="200" width="32" height="16" rx="3" class="sim__magnet" />
      <path d="M84 208 h32" stroke="var(--ill-shade)" />
      <path
        class="sim__cap"
        d="M22 34 a9 9 0 0 1 9 -9 h138 a9 9 0 0 1 9 9 l-5 44 a7 7 0 0 1 -7 6 h-132 a7 7 0 0 1 -7 -6 z"
        fill="url(#sim-cap)"
      />
      <path d="M34 30 h132" stroke="var(--ill-hi)" stroke-width="2" stroke-linecap="round" />
    </g>
    <!-- top housing over the stem (cut-away: stem shows through the slot) -->
    <path d="M40 118 h120 l10 34 h-140 z" fill="url(#sim-house)" stroke="var(--line-2)" />
    <rect x="89" y="118" width="22" height="34" fill="var(--bg-1)" opacity=".55" />
    <rect x="91" :y="Math.max(118, 84 + d)" width="18" :height="152 - Math.max(118, 84 + d)" rx="1" fill="var(--ill-stem)" />

    <!-- divider -->
    <path d="M204 20 V360" stroke="var(--line-1)" />

    <!-- ===== gauge ===== -->
    <g class="sim__ticks">
      <template v-for="(tk, i) in ticks" :key="i">
        <path :d="`M${TRACK_X - (tk.major ? 9 : 5)} ${tk.y} H${TRACK_X - 2}`" :class="{ major: tk.major }" />
        <text v-if="tk.label" :x="TRACK_X - 13" :y="tk.y + 3.5" text-anchor="end">{{ tk.label }}</text>
      </template>
    </g>
    <rect :x="TRACK_X" :y="GY0" :width="TRACK_W" :height="GY1 - GY0" rx="4" fill="var(--bg-3)" stroke="var(--line-1)" />
    <rect v-if="deadTop > 0" :x="TRACK_X" :y="GY0" :width="TRACK_W" :height="deadTop" fill="url(#sim-hatch)">
      <title>{{ t('live.mDeadTop') }}</title>
    </rect>
    <rect v-if="deadBottom > 0" :x="TRACK_X" :y="GY1 - deadBottom" :width="TRACK_W" :height="deadBottom" fill="url(#sim-hatch)">
      <title>{{ t('live.mDeadBottom') }}</title>
    </rect>
    <!-- live fill -->
    <rect :x="TRACK_X + 1" :y="GY0" :width="TRACK_W - 2" :height="Math.max(0, gy(travel) - GY0)" rx="3" fill="url(#sim-fill)" />
    <!-- peak of this press -->
    <path v-if="peak > 0.05" :d="`M${TRACK_X + TRACK_W + 2} ${gy(peak)} l6 -4 v8 z`" fill="var(--fg-3)" />

    <!-- markers -->
    <g v-for="m in labelled" :key="m.kind + m.text" class="sim__marker" :class="`sim__marker--${m.kind}`">
      <path :d="`M${TRACK_X - 4} ${m.y} H${TRACK_X + TRACK_W + 12} L${LABEL_X - 4} ${m.ly}`" fill="none" />
      <text :x="LABEL_X" :y="m.ly + 4">{{ m.text }}</text>
    </g>

    <!-- stem position -->
    <path :d="`M${TRACK_X - 6} ${gy(travel)} H${TRACK_X + TRACK_W + 6}`" class="sim__head" />
  </svg>
</template>

<style scoped>
.sim { display: block; width: 100%; max-width: 484px; height: auto; overflow: visible; }
.sim__cap { stroke: var(--line-3); transition: stroke var(--t-fast) var(--ease); }
.sim--on .sim__cap { stroke: var(--m-press); }
.sim__magnet { fill: var(--fg-4); transition: fill var(--t-fast) var(--ease); }
.sim--on .sim__magnet { fill: var(--m-press); }
.sim__sensor { fill: var(--fg-4); transition: fill var(--t-fast) var(--ease); }
.sim--on .sim__sensor { fill: var(--m-press); }
.sim__field path { fill: none; stroke: var(--m-press); stroke-width: 1; stroke-dasharray: 3 3; }
.sim__ticks path { stroke: var(--fg-4); }
.sim__ticks path.major { stroke: var(--fg-3); }
.sim__ticks text { font-size: 10px; fill: var(--fg-3); font-variant-numeric: tabular-nums; }
.sim__marker path { stroke-width: 1.5; }
.sim__marker text { font-size: 11px; font-weight: 500; font-variant-numeric: tabular-nums; }
.sim__marker--act path { stroke: var(--m-actuation); }
.sim__marker--act text { fill: var(--m-actuation); }
.sim__marker--rel path { stroke: var(--m-release); stroke-dasharray: 4 3; }
.sim__marker--rel text { fill: var(--m-release); }
.sim__marker--reset path { stroke: var(--info); stroke-dasharray: 4 3; }
.sim__marker--reset text { fill: var(--info); }
.sim__marker--react path { stroke: var(--acc-line); stroke-dasharray: 4 3; }
.sim__marker--react text { fill: var(--acc); opacity: 0.8; }
.sim__marker--dead path { stroke: var(--m-deadzone); stroke-width: 1; opacity: 0.5; }
.sim__marker--dead text { fill: var(--m-deadzone); font-size: 10px; }
.sim__head { stroke: var(--fg-1); stroke-width: 2; stroke-linecap: round; }
.sim--on .sim__head { stroke: var(--acc); }
</style>
