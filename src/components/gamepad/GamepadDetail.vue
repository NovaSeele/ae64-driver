<script setup lang="ts">
// "Chi tiết đầu ra" card (DESIGN K §3.4, §5.2): the curve of the selected key's analog output, drawn in CSS px (the SVG
// viewBox is the measured width, so axis text stays 11 px and strokes keep their width at every size), two draggable
// handles (role slider), the curve type and Start / Full fields. Buttons and the D-pad only get a note.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IconArrowRight, IconEraser } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import NumberField from '../ui/NumberField.vue';
import Segmented from '../ui/Segmented.vue';
import { GP_CONTROLS, isAnalogIndex, level } from '../../protocol/gamepad';
import type { GpCurve } from '../../protocol/gamepad';
import { useDeviceStore } from '../../stores/device';
import { GP_MIN_GAP_UM, useGamepadStore } from '../../stores/gamepad';
import { useSelectionStore } from '../../stores/selection';
import { t } from '../../i18n/vi';
import { useGamepadActions } from './actions';
import { SHORT, keyLegend, longNameOf, mm, physKey, toneOfIndex } from './outputs';

const props = defineProps<{
  current: readonly number[];
  selectedKeys: readonly number[];
  /** Live depth (µm) of a record key, or null when travel is not being read. */
  depthUm: (key: number) => number | null;
}>();

const gp = useGamepadStore();
const device = useDeviceStore();
const sel = useSelectionStore();
const router = useRouter();
const actions = useGamepadActions();

const analog = computed(() => props.current.filter(isAnalogIndex));
const digital = computed(() => props.current.filter((i) => !isAnalogIndex(i)));
const focus = computed<number | null>(() => analog.value[0] ?? digital.value[0] ?? null);
const binding = computed(() => (focus.value === null ? null : gp.config?.bindings[focus.value] ?? null));
const tone = computed(() => (focus.value === null ? undefined : toneOfIndex(focus.value)));
/** Switch travel (µm) of the focused output's key; the record's own declared travel until the keyboard's is known. */
const travel = computed(() => {
  const b = binding.value;
  if (!b) return 0;
  return (b.key !== null ? gp.travelUm(b.key) : undefined) ?? b.declaredUm;
});
const keyName = computed(() => (binding.value?.key != null ? keyLegend(device, binding.value.key) : ''));

const subtitle = computed(() => {
  if (focus.value === null) return undefined;
  if (analog.value.length > 1) {
    const keys = analog.value.map((i) => keyLegend(device, gp.config!.bindings[i].key!));
    return t('gp.curveMulti', { keys: keys.join(' '), list: analog.value.map((i) => SHORT[GP_CONTROLS[i].id]).join(' '), n: analog.value.length });
  }
  return t('gp.curveSub', { key: keyName.value, travel: mm(travel.value) });
});

// ------------------------------------------------------------------ chart geometry (CSS px)

const H = 196;
const X0 = 40;
const Y0 = 12;
const Y1 = 160;
const chartBox = ref<HTMLElement | null>(null);
const width = ref(400);
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver === 'undefined') return;
  ro = new ResizeObserver((entries) => {
    const w = Math.round(entries[0]?.contentRect.width ?? 0);
    if (w > 0) width.value = w;
  });
  watch(chartBox, (el, old) => {
    if (old) ro?.unobserve(old);
    if (el) ro?.observe(el);
  }, { immediate: true });
});
onBeforeUnmount(() => ro?.disconnect());

const x1 = computed(() => width.value - 10);
const xmaxUm = computed(() => Math.max(travel.value, binding.value?.endUm ?? 0, 1));
const X = (um: number) => X0 + (um / xmaxUm.value) * (x1.value - X0);
const Y = (v: number) => Y1 - v * (Y1 - Y0);
const SMOOTH: readonly [number, number][] = [[0, 0], [1 / 3, 0.2592], [2 / 3, 0.7408], [1, 1]];

const chart = computed(() => {
  const b = binding.value;
  if (!b || focus.value === null || !isAnalogIndex(focus.value)) return null;
  const pts = b.curve === 'linear' ? [[0, 0], [1, 1]] : SMOOTH;
  const line = pts.map(([u, v], i) => `${i ? 'L' : 'M'}${X(b.startUm + u * (b.endUm - b.startUm)).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
  const ticks: number[] = [];
  for (let m = 0; m <= xmaxUm.value + 1e-6; m += 500) ticks.push(m);
  const depth = b.key !== null ? props.depthUm(b.key) : null;
  const val = depth === null ? null : level({ curve: b.curve, start: b.startUm, end: b.endUm }, depth) / 10000;
  return { b, line, ticks, depth, val, over: b.endUm > travel.value };
});

const curveName = (c: GpCurve) => t(c === 'linear' ? 'gp.linear' : 'gp.smooth');
const chartLabel = computed(() => (chart.value && focus.value !== null
  ? t('gp.chartLabel', { out: longNameOf(focus.value), start: mm(chart.value.b.startUm), end: mm(chart.value.b.endUm), curve: curveName(chart.value.b.curve).toLowerCase() })
  : ''));

// ------------------------------------------------------------------ edits

let dragSeq = 0;
function setPoint(which: 'start' | 'end', um: number, coalesce?: string): void {
  gp.setCurve(analog.value, which === 'start' ? { startUm: um } : { endUm: um }, coalesce);
}

/** Pointer drag on a handle: capture, one undo step per drag. */
function onDown(which: 'start' | 'end', e: PointerEvent): void {
  if (e.button !== 0) return;
  const el = e.currentTarget as SVGGElement;
  el.setPointerCapture(e.pointerId);
  el.focus();
  const svg = el.ownerSVGElement!;
  const key = `curve:${focus.value}:${which}:${++dragSeq}`;
  const move = (ev: PointerEvent) => {
    const r = svg.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * width.value;
    const um = ((x - X0) / (x1.value - X0)) * xmaxUm.value;
    setPoint(which, Math.round(Math.max(0, um) / 10) * 10, key);
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  e.preventDefault();
}

/** Arrows ±0.01 mm, Shift ±0.1 mm, PageUp/Down ±0.5 mm, Home/End to the limits (§7). */
function onHandleKey(which: 'start' | 'end', e: KeyboardEvent): void {
  const b = binding.value;
  if (!b) return;
  const cur = which === 'start' ? b.startUm : b.endUm;
  const step = e.shiftKey ? 100 : 10;
  const lo = which === 'start' ? 0 : b.startUm + GP_MIN_GAP_UM;
  const hi = which === 'start' ? b.endUm - GP_MIN_GAP_UM : travel.value;
  const next = e.key === 'ArrowRight' || e.key === 'ArrowUp' ? cur + step
    : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? cur - step
      : e.key === 'PageUp' ? cur + 500 : e.key === 'PageDown' ? cur - 500
        : e.key === 'Home' ? lo : e.key === 'End' ? hi : null;
  if (next === null) return;
  e.preventDefault();
  setPoint(which, Math.min(hi, Math.max(lo, next)), `curve:${focus.value}:${which}:key`);
}

const curve = computed<GpCurve | null>({
  get: () => binding.value?.curve ?? null,
  set: (v) => { if (v) gp.setCurve(analog.value, { curve: v }); },
});
const curveOptions = computed(() => [
  { value: 'linear' as const, label: t('gp.linear'), title: t('gp.linearDesc') },
  { value: 'smooth' as const, label: t('gp.smooth'), title: t('gp.smoothDesc') },
]);
const startMm = computed({
  get: () => (binding.value ? binding.value.startUm / 1000 : 0),
  set: (v: number) => setPoint('start', Math.round(v * 1000)),
});
const endMm = computed({
  get: () => (binding.value ? binding.value.endUm / 1000 : 0),
  set: (v: number) => setPoint('end', Math.round(v * 1000)),
});

function openTravel(): void {
  const k = binding.value?.key;
  const pk = k == null ? undefined : physKey(device.keys, k);
  if (pk) sel.select(pk.id);
  void router.push('/performance');
}

const unassignedKey = computed(() => props.selectedKeys.map((k) => keyLegend(device, k)).join(' '));
</script>

<template>
  <Card class="gpc" :subtitle="subtitle">
    <template #title>
      <span v-if="focus !== null" class="gp-tone" :style="{ '--g': tone }">
        <span class="gpo__dot" aria-hidden="true" />{{ analog.length > 1 ? t('gp.nOutputs', { n: analog.length }) : longNameOf(focus) }}
      </span>
      <template v-else>{{ t('gp.detail') }}</template>
    </template>
    <template v-if="focus !== null" #actions>
      <Button size="sm" variant="ghost" :icon="IconEraser" :disabled="gp.locked" @click="actions.unassign(selectedKeys)">{{ t('gp.unassign') }}</Button>
    </template>

    <template v-if="chart && focus !== null">
      <div ref="chartBox" class="gpc__chart">
        <span class="gps__label" aria-hidden="true">{{ t('gp.curve') }}</span>
        <svg class="gpc__svg" :viewBox="`0 0 ${width} ${H}`" :style="{ '--g': tone }">
          <g role="img" :aria-label="chartLabel">
            <rect :x="X(chart.b.startUm)" :y="Y0" :width="Math.max(0, X(chart.b.endUm) - X(chart.b.startUm))" :height="Y1 - Y0" class="gpc__band" />
            <template v-for="v in [0, 0.5, 1]" :key="v">
              <line :x1="X0" :x2="x1" :y1="Y(v)" :y2="Y(v)" class="gpc__grid" />
              <text :x="X0 - 6" :y="Y(v) + 4" class="gpc__ylab" text-anchor="end">{{ v * 100 }}%</text>
            </template>
            <template v-for="m in chart.ticks" :key="m">
              <line :x1="X(m)" :x2="X(m)" :y1="Y1" :y2="Y1 + 4" class="gpc__tick" />
              <text :x="X(m)" :y="Y1 + 16" class="gpc__xlab" text-anchor="middle">{{ (m / 1000).toFixed(1) }}</text>
            </template>
            <text :x="x1" :y="H - 2" class="gpc__xlab gpc__xname" text-anchor="end">{{ t('gp.axisX') }}</text>
            <path :d="`M${X(0)},${Y(0)} L${X(chart.b.startUm)},${Y(0)}`" class="gpc__flat" />
            <path :d="`${chart.line} L${X(chart.b.endUm)},${Y(0)} L${X(chart.b.startUm)},${Y(0)} Z`" class="gpc__area" />
            <path :d="chart.line" class="gpc__line" />
            <path :d="`M${X(chart.b.endUm)},${Y(1)} L${X(xmaxUm)},${Y(1)}`" class="gpc__flat gpc__flat--top" />
            <template v-if="chart.over">
              <rect :x="X(travel)" :y="Y0" :width="X(chart.b.endUm) - X(travel)" :height="Y1 - Y0" class="gpc__over" />
              <line :x1="X(travel)" :x2="X(travel)" :y1="Y0" :y2="Y1" class="gpc__limit" />
              <text :x="X(travel) - 4" :y="Y0 + 12" class="gpc__limtxt" text-anchor="end">{{ t('gp.switchEnd', { travel: mm(travel) }) }}</text>
            </template>
            <template v-if="chart.depth !== null && chart.val !== null">
              <line :x1="X(chart.depth)" :x2="X(chart.depth)" :y1="Y1" :y2="Y(chart.val)" class="gpc__now" />
              <line :x1="X0" :x2="X(chart.depth)" :y1="Y(chart.val)" :y2="Y(chart.val)" class="gpc__now" />
              <circle :cx="X(chart.depth)" :cy="Y(chart.val)" r="4.5" class="gpc__dot" />
            </template>
          </g>
          <g
            class="gpc__h" role="slider" tabindex="0" :aria-label="t('gp.handleStart')"
            :aria-valuemin="0" :aria-valuemax="mm(chart.b.endUm - GP_MIN_GAP_UM)" :aria-valuenow="mm(chart.b.startUm)" :aria-valuetext="`${mm(chart.b.startUm)} mm`"
            @pointerdown="onDown('start', $event)" @keydown="onHandleKey('start', $event)"
          >
            <circle :cx="X(chart.b.startUm)" :cy="Y(0)" r="13" class="gpc__hit" />
            <circle :cx="X(chart.b.startUm)" :cy="Y(0)" r="6.5" class="gpc__knob" />
          </g>
          <g
            class="gpc__h" role="slider" tabindex="0" :aria-label="t('gp.handleFull')"
            :aria-valuemin="mm(chart.b.startUm + GP_MIN_GAP_UM)" :aria-valuemax="mm(travel)" :aria-valuenow="mm(chart.b.endUm)" :aria-valuetext="`${mm(chart.b.endUm)} mm`"
            @pointerdown="onDown('end', $event)" @keydown="onHandleKey('end', $event)"
          >
            <circle :cx="X(chart.b.endUm)" :cy="Y(1)" r="13" class="gpc__hit" />
            <circle :cx="X(chart.b.endUm)" :cy="Y(1)" r="6.5" class="gpc__knob" />
          </g>
        </svg>
        <p v-if="chart.depth !== null && chart.val !== null" class="gpc__nowtxt num">{{ t('gp.now', { depth: mm(chart.depth), pct: Math.round(chart.val * 100) }) }}</p>
      </div>
      <div class="gpc__ctl" :inert="gp.locked || undefined">
        <div class="gpc__f gpc__f--kind">
          <span class="gps__label" aria-hidden="true">{{ t('gp.curveType') }}</span>
          <div class="gpc__kindrow">
            <Segmented v-model="curve" :options="curveOptions" :label="t('gp.curveType')" size="sm" />
            <p class="gps__desc">{{ t(curve === 'smooth' ? 'gp.smoothDesc' : 'gp.linearDesc') }}</p>
          </div>
        </div>
        <div class="gpc__f">
          <span class="gps__label" :title="t('gp.startDesc')" aria-hidden="true">{{ t('gp.start') }}</span>
          <NumberField v-model="startMm" :min="0" :max="Math.max(0, (chart.b.endUm - GP_MIN_GAP_UM) / 1000)" :label="t('gp.start')" />
        </div>
        <div class="gpc__f">
          <span class="gps__label" :title="t('gp.fullDesc')" aria-hidden="true">{{ t('gp.full') }}</span>
          <NumberField v-model="endMm" :min="(chart.b.startUm + GP_MIN_GAP_UM) / 1000" :max="Math.max(chart.b.endUm, travel) / 1000" :label="t('gp.full')" />
        </div>
      </div>
      <p class="gps__desc">{{ t('gp.startDesc') }} {{ t('gp.fullDesc') }}</p>
    </template>

    <div v-else-if="focus !== null" class="gpc__note">
      <p>{{ t('gp.digital', { out: longNameOf(focus) }) }}</p>
      <Button size="sm" :icon="IconArrowRight" @click="openTravel">{{ t('gp.openTravel') }}</Button>
    </div>
    <div v-else-if="selectedKeys.length" class="gpc__note gpc__note--empty">
      <p>{{ t('gp.keyUnassigned', { key: unassignedKey }) }}</p>
    </div>
    <div v-else class="gpc__note gpc__note--empty">
      <p>{{ t('gp.curveEmpty') }}</p>
    </div>
  </Card>
</template>
