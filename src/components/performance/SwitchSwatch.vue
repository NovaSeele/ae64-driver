<script setup lang="ts">
// A switch seen from above: dark housing, stem cross in the switch colour. '' = no colour (dashed outline).
import { computed } from 'vue';

const props = withDefaults(defineProps<{ color: string; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' });
const fill = computed(() => (/^#[0-9a-f]{3,8}$/i.test(props.color) ? props.color : ''));
</script>

<template>
  <svg :class="['swatch', size !== 'md' && `swatch--${size}`, !fill && 'swatch--none']" viewBox="0 0 24 24" aria-hidden="true">
    <rect class="swatch__housing" x="1.5" y="1.5" width="21" height="21" rx="5" />
    <path class="swatch__stem" d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4z" :style="fill ? { fill } : undefined" />
  </svg>
</template>

<style scoped>
.swatch { width: 24px; height: 24px; flex: none; display: block; }
.swatch--lg { width: 32px; height: 32px; }
.swatch--sm { width: 18px; height: 18px; }
.swatch__housing { fill: var(--swatch-housing); stroke: var(--line-3); stroke-width: 1; }
.swatch__stem { stroke: rgba(255, 255, 255, 0.22); stroke-width: 1; stroke-linejoin: round; }
.swatch--none .swatch__stem { fill: transparent; stroke: rgba(255, 255, 255, 0.6); stroke-dasharray: 2 1.6; }
</style>
