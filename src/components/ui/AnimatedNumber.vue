<script setup lang="ts">
// Number that tweens to its new value (disabled under prefers-reduced-motion).
import { onBeforeUnmount, ref, watch } from 'vue';

const props = withDefaults(defineProps<{ value: number; decimals?: number; duration?: number }>(), { decimals: 2, duration: 220 });
const shown = ref(props.value);
let raf = 0;
const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

watch(() => props.value, (to) => {
  cancelAnimationFrame(raf);
  const from = shown.value;
  if (reduced || !Number.isFinite(from)) { shown.value = to; return; }
  const start = performance.now();
  const step = (now: number) => {
    const k = Math.min(1, (now - start) / props.duration);
    const e = 1 - Math.pow(1 - k, 3);
    shown.value = from + (to - from) * e;
    if (k < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
});
onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <span class="num">{{ shown.toFixed(decimals) }}</span>
</template>
