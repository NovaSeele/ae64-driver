<script setup lang="ts">
// The wallpaper layer (DESIGN J §3.5): first child of main.main, behind every other child of it (.main is isolated and this
// sits at z-index -1). Light on purpose: it only draws wallState; the runtime that fills it loads after the first paint.
import { computed } from 'vue';
import { veilApplied, wallState } from '../../data/wallpaperState';

const style = computed(() => ({ '--wall-veil': String(veilApplied.value), '--wall-blur': `${wallState.prefs.blur}px` }));
</script>

<template>
  <div v-if="wallState.url" class="wall" aria-hidden="true" :style="style">
    <div class="wall__img" :class="`wall__img--${wallState.prefs.fit}`" :style="{ backgroundImage: `url(${wallState.url})` }" />
    <div class="wall__veil" />
  </div>
</template>

<style scoped>
/* contain + its own layer: the blurred image is painted once, scrolling and keycap updates above it only composite */
.wall { position: absolute; inset: 0; z-index: -1; overflow: hidden; pointer-events: none; contain: strict; }
.wall__img {
  position: absolute;
  inset: calc(var(--wall-blur, 0px) * -2);
  background-position: center;
  background-repeat: no-repeat;
  filter: blur(var(--wall-blur, 0px));
  will-change: transform;
}
.wall__img--cover { background-size: cover; }
.wall__img--contain { background-size: contain; }
.wall__img--center { background-size: auto; }
.wall__img--tile { background-size: auto; background-repeat: repeat; background-position: 0 0; }
.wall__veil { position: absolute; inset: 0; background: var(--bg-0); opacity: var(--wall-veil, 0.3); }
</style>
