<script setup lang="ts">
// A switch thumbnail on one plate: the maker's photo when the build ships one, else a drawn switch seen from above (dark
// housing, stem cross in the switch colour; '' = no colour, dashed outline).
import { computed } from 'vue';
import { switchImage } from '../../data/switchDisplay';

const props = withDefaults(defineProps<{ color: string; id?: number; size?: 'sm' | 'md' | 'lg' }>(), { size: 'md' });
const fill = computed(() => (/^#[0-9a-f]{3,8}$/i.test(props.color) ? props.color : ''));
const photo = computed(() => (props.id === undefined ? undefined : switchImage(props.id)));
</script>

<template>
  <img v-if="photo" :src="photo" alt="" :class="['swatch', 'swatch--photo', size !== 'md' && `swatch--${size}`]" decoding="async" draggable="false" />
  <svg v-else :class="['swatch', size !== 'md' && `swatch--${size}`, !fill && 'swatch--none']" viewBox="0 0 24 24" aria-hidden="true">
    <rect class="swatch__housing" x="0.5" y="0.5" width="23" height="23" rx="5" />
    <path class="swatch__stem" d="M10 6h4v4h4v4h-4v4h-4v-4H6v-4h4z" :style="fill ? { fill } : undefined" />
  </svg>
</template>

<style scoped>
.swatch { width: 36px; height: 36px; flex: none; display: block; }
.swatch--lg { width: 44px; height: 44px; }
.swatch--sm { width: 22px; height: 22px; }
.swatch--photo {
  /* the same plate as the drawn swatch (housing fill, 1px ring, radius 5/24), so white and clear switches stay visible */
  box-sizing: border-box; padding: 2px; object-fit: contain; user-select: none;
  background: var(--swatch-housing); box-shadow: inset 0 0 0 1px var(--line-3); border-radius: 7.5px;
}
.swatch--photo.swatch--lg { padding: 3px; border-radius: 9px; }
.swatch--photo.swatch--sm { padding: 1px; border-radius: 4.5px; }
.swatch__housing { fill: var(--swatch-housing); stroke: var(--line-3); stroke-width: 1; }
.swatch__stem { stroke: rgba(255, 255, 255, 0.22); stroke-width: 1; stroke-linejoin: round; }
.swatch--none .swatch__stem { fill: transparent; stroke: rgba(255, 255, 255, 0.6); stroke-dasharray: 2 1.6; }
</style>
