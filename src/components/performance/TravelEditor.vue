<script setup lang="ts">
// Actuation editor: switch illustration (cap sinks to the actuation depth) + vertical travel slider
// with a mm ruler and dead-zone bands. 0 mm is at the top, deeper is lower.
import { computed } from 'vue';
import Slider from '../ui/Slider.vue';

const props = defineProps<{
  /** null = mixed (shows `range`). */
  value: number | null;
  range: [number, number];
  min: number;
  max: number;
  step: number;
  deadTop: number | null;
  deadBottom: number | null;
  label: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{ update: [number]; commit: [number] }>();

const shown = computed(() => props.value ?? props.range[0]);
const ratio = computed(() => Math.min(1, Math.max(0, shown.value / props.max)));
/** Same mapping as the vertical Slider: `min` at the top, `max` at the bottom. */
const pctNum = (v: number) => Math.min(100, Math.max(0, props.max === props.min ? 0 : ((v - props.min) / (props.max - props.min)) * 100));
const pct = (v: number) => `${pctNum(v)}%`;
const deadBottomPct = computed(() => `${100 - pctNum(props.max - (props.deadBottom ?? 0))}%`);
const ticks = computed(() => {
  const out: { v: number; major: boolean }[] = [];
  for (let v = 0; v <= props.max + 1e-6; v += 0.25) if (v >= props.min - 1e-6) out.push({ v: Number(v.toFixed(2)), major: Math.abs(v % 1) < 1e-6 || Math.abs((v % 1) - 0.5) < 1e-6 });
  return out;
});

const CAP_TRAVEL = 46; // px the illustrated cap moves at full travel
</script>

<template>
  <div class="te" :class="{ 'te--disabled': disabled }">
    <svg class="te__switch" viewBox="0 0 132 236" aria-hidden="true">
      <defs>
        <linearGradient id="te-cap" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#323840" />
          <stop offset="1" stop-color="#252a31" />
        </linearGradient>
        <linearGradient id="te-house" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#22262c" />
          <stop offset="1" stop-color="#1a1d22" />
        </linearGradient>
      </defs>
      <!-- plate -->
      <rect x="4" y="150" width="124" height="6" rx="2" fill="#2a2f36" />
      <!-- housing -->
      <path d="M26 118 h80 l6 32 v52 a6 6 0 0 1 -6 6 h-80 a6 6 0 0 1 -6 -6 v-52 z" fill="url(#te-house)" stroke="rgba(255,255,255,.1)" />
      <!-- magnet + sensor hint -->
      <rect x="56" y="196" width="20" height="5" rx="2" fill="var(--acc)" opacity=".55" />
      <rect x="50" y="214" width="32" height="6" rx="2" fill="#3a4049" />
      <g class="te__moving" :style="{ transform: `translateY(${ratio * CAP_TRAVEL}px)` }">
        <!-- stem -->
        <rect x="58" y="68" width="16" height="74" rx="3" fill="#3a4049" />
        <!-- spring hint -->
        <path d="M60 142 l12 -6 l-12 -6 l12 -6 l-12 -6 l12 -6" fill="none" stroke="rgba(255,255,255,.18)" stroke-width="1.5" />
        <!-- keycap -->
        <path d="M14 34 a8 8 0 0 1 8 -8 h88 a8 8 0 0 1 8 8 l-4 36 a6 6 0 0 1 -6 5 h-84 a6 6 0 0 1 -6 -5 z" fill="url(#te-cap)" stroke="rgba(255,255,255,.12)" />
        <path d="M24 30 h84" stroke="rgba(255,255,255,.08)" stroke-width="2" stroke-linecap="round" />
      </g>
      <!-- resting reference -->
      <path d="M2 75 h10" stroke="var(--fg-4)" stroke-dasharray="2 2" />
    </svg>

    <div class="te__scale">
      <div class="te__ruler">
        <span
          v-for="tk in ticks"
          :key="tk.v"
          class="te__tick"
          :class="{ 'te__tick--major': tk.major }"
          :style="{ top: pct(tk.v) }"
        ><span v-if="tk.major" class="te__ticklabel num">{{ tk.v.toFixed(1) }}</span></span>
      </div>
      <div class="te__track">
        <div v-if="deadTop" class="te__dead" :style="{ top: '0', height: pct(deadTop) }" />
        <div v-if="deadBottom" class="te__dead" :style="{ bottom: '0', height: deadBottomPct }" />
        <div class="te__mark" :style="{ top: pct(shown) }" />
        <Slider
          :model-value="shown"
          :min="min"
          :max="max"
          :step="step"
          :fine-step="0.01"
          orientation="vertical"
          :label="label"
          :disabled="disabled"
          :range="value === null ? range : null"
          :format="(v) => `${v.toFixed(2)} mm`"
          @update:model-value="emit('update', $event)"
          @commit="emit('commit', $event)"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.te { display: flex; align-items: stretch; gap: var(--s-4); height: 236px; }
.te--disabled { opacity: 0.5; }
.te__switch { width: 132px; height: 236px; flex: none; }
.te__moving { transition: transform var(--t-med) var(--ease); }
.te__scale { display: flex; gap: 6px; padding: 10px 0; }
.te__ruler { position: relative; width: 34px; }
.te__tick {
  position: absolute;
  right: 0;
  width: 5px;
  height: 1px;
  background: var(--fg-4);
}
.te__tick--major { width: 9px; background: var(--fg-3); }
.te__ticklabel {
  position: absolute;
  right: 13px;
  top: -7px;
  font-size: 10px;
  color: var(--fg-3);
}
.te__track { position: relative; width: 28px; }
.te__track :deep(.sl) { position: absolute; left: 4px; top: 0; height: 100%; }
.te__dead {
  position: absolute;
  left: 0;
  right: 0;
  background: repeating-linear-gradient(135deg, rgba(251, 191, 36, 0.18) 0 3px, transparent 3px 6px);
  border-radius: 3px;
}
.te__mark {
  position: absolute;
  left: -4px;
  right: -8px;
  height: 1px;
  background: var(--acc-line);
  transition: top var(--t-fast) var(--ease);
}
</style>
