<script setup lang="ts">
// Actuation editor: a vertical travel slider with a mm ruler, the actuation marker and dead-zone bands.
// 0 mm is at the top, deeper is lower.
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
/** Same mapping as the vertical Slider: `min` at the top, `max` at the bottom. */
const pctNum = (v: number) => Math.min(100, Math.max(0, props.max === props.min ? 0 : ((v - props.min) / (props.max - props.min)) * 100));
const pct = (v: number) => `${pctNum(v)}%`;
const deadBottomPct = computed(() => `${100 - pctNum(props.max - (props.deadBottom ?? 0))}%`);
const ticks = computed(() => {
  const out: { v: number; major: boolean }[] = [];
  for (let v = 0; v <= props.max + 1e-6; v += 0.25) if (v >= props.min - 1e-6) out.push({ v: Number(v.toFixed(2)), major: Math.abs(v % 1) < 1e-6 || Math.abs((v % 1) - 0.5) < 1e-6 });
  return out;
});
</script>

<template>
  <div class="te" :class="{ 'te--disabled': disabled }">
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
          :fine-step="0.001"
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
.te { display: flex; align-items: stretch; height: 118px; }
.te--disabled { opacity: 0.5; }
.te__scale { display: flex; gap: 6px; padding: 6px 0; }
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
  font-size: var(--fs-caption);
  color: var(--fg-3);
}
.te__track { position: relative; width: 28px; }
.te__track :deep(.sl) { position: absolute; left: 4px; top: 0; height: 100%; }
.te__dead {
  position: absolute;
  left: 0;
  right: 0;
  background: repeating-linear-gradient(135deg, color-mix(in srgb, var(--m-deadzone) 34%, transparent) 0 3px, transparent 3px 6px);
  border-radius: 3px;
}
.te__mark {
  position: absolute;
  left: -4px;
  right: -8px;
  height: 1px;
  background: var(--m-actuation);
  transition: top var(--t-fast) var(--ease);
}
</style>
