<script setup lang="ts">
// One keyboard frame for the five tabs of the Performance page (DESIGN E §3.5): the tab's KeyboardView centred at 940 px
// (1100 px from a 1600 px window), the selection bar under it, then the rows the tab adds. Always the first element of a
// tab, so the keyboard's top edge is the toolbar's bottom + the page gap in every tab. No side column: rows a tab adds
// go under the keyboard at every width.
import SelectionBar from './SelectionBar.vue';
import type { LegendItem } from './SelectionBar.vue';

withDefaults(defineProps<{
  /** Show the selection bar (Calibration and Key test have none). */
  selectionBar?: boolean;
  /** SelectionBar props, passed through. */
  shows?: LegendItem[];
  showsAlt?: LegendItem[][];
  hint?: string;
  tip?: string;
  /** Extra class(es) on the board frame (Calibration: `board`, `board--live`). */
  boardClass?: string | string[] | Record<string, boolean>;
}>(), { selectionBar: true });
</script>

<template>
  <section class="tk">
    <div class="tk__board" :class="boardClass"><slot /></div>
    <SelectionBar v-if="selectionBar" :shows="shows" :shows-alt="showsAlt" :hint="hint" :tip="tip">
      <template v-if="$slots.lead" #lead><slot name="lead" /></template>
      <template v-if="$slots.leadWidest" #leadWidest><slot name="leadWidest" /></template>
      <template v-if="$slots.detail" #detail><slot name="detail" /></template>
    </SelectionBar>
    <slot name="below" />
  </section>
</template>

<style scoped>
.tk { display: flex; flex-direction: column; align-items: stretch; gap: var(--s-3); }
.tk__board { flex: none; width: 100%; max-width: 940px; margin-left: auto; margin-right: auto; }
@media (min-width: 1600px) { .tk__board { max-width: 1100px; } }
</style>
