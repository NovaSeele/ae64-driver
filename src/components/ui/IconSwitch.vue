<script setup lang="ts">
// Keyboard switch seen from above (housing + cross stem), drawn like a Tabler outline icon.
withDefaults(defineProps<{ size?: number | string; strokeWidth?: number | string }>(), { size: 24, strokeWidth: 2 });
</script>
<template>
  <svg xmlns="http://www.w3.org/2000/svg" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="4" />
    <path d="M10.25 7.5h3.5v2.75h2.75v3.5h-2.75v2.75h-3.5v-2.75H7.5v-3.5h2.75z" />
  </svg>
</template>
