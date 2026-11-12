<script setup lang="ts">
// One output tile (56×44): short name over the key it is assigned to, "—" when none, "Bấm…" while armed.
defineProps<{
  index: number;
  cap: string;
  keyLabel: string | null;
  area?: string;
  current: boolean;
  armed: boolean;
  tabStop: boolean;
  aria: string;
  title: string;
  armedText: string;
}>();
</script>

<template>
  <button
    type="button"
    class="gpo__tile"
    :class="[area ? `a-${area}` : '', { 'gpo__tile--empty': keyLabel === null, 'gpo__tile--cur': current, 'gpo__tile--armed': armed }]"
    :data-gp-tile="index"
    :tabindex="tabStop ? 0 : -1"
    :aria-pressed="armed"
    :aria-label="aria"
    :title="title"
  >
    <span class="gpo__cap" aria-hidden="true">{{ cap }}</span>
    <span class="gpo__key" aria-hidden="true">{{ armed ? armedText : keyLabel ?? '—' }}</span>
  </button>
</template>
