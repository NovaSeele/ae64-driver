<script setup lang="ts">
// One CSS keycap. Geometry is set by KeyboardView; this renders legend, value line, fill, LED colour and state.
import type { Component } from 'vue';

defineProps<{
  legend: string;
  sublabel?: string;
  /** Small accent value on the bottom-left (e.g. Rapid Trigger press/release sensitivity). */
  badge?: string;
  /** Accessible name / tooltip of the badge when its text alone is not meaningful (e.g. a lock icon). */
  badgeTitle?: string;
  /** Tabler icon shown instead of the badge text (e.g. a lock for a read-only key). */
  badgeIcon?: Component;
  /** 0..1 vertical fill (e.g. travel or actuation depth). */
  fill?: number;
  /** CSS colour for this key's values (sets --metric; overrides the inherited one). */
  tone?: string;
  /** LED colour (CSS colour). */
  color?: string;
  state?: 'pressed';
  selected?: boolean;
  /** Briefly outlined in the danger colour (a write for this key was dropped). */
  flashing?: boolean;
  loading?: boolean;
}>();
</script>

<template>
  <span
    class="cap"
    :class="{ 'cap--sel': selected, 'cap--pressed': state === 'pressed', 'cap--flash': flashing }"
    :style="tone ? { '--metric': tone } : undefined"
  >
    <span class="cap__face">
      <span v-if="fill !== undefined" class="cap__fill" :style="{ transform: `scaleY(${Math.min(1, Math.max(0, fill))})` }" />
      <span v-if="color" class="cap__led" :style="{ background: color, boxShadow: `0 0 10px ${color}` }" />
      <span class="cap__legend">{{ legend }}</span>
      <span v-if="loading" class="cap__sub cap__sub--skeleton skeleton" />
      <span v-else-if="sublabel !== undefined || badge || badgeIcon" class="cap__foot">
        <span v-if="badgeIcon" class="cap__badge cap__badge--icon" :title="badgeTitle" :aria-label="badgeTitle">
          <component :is="badgeIcon" :size="11" :stroke-width="1.8" aria-hidden="true" />
        </span>
        <span v-else-if="badge" class="cap__badge num" :title="badgeTitle" :aria-label="badgeTitle">{{ badge }}</span>
        <span v-if="sublabel !== undefined" class="cap__sub num">{{ sublabel }}</span>
      </span>
    </span>
  </span>
</template>

<style scoped>
.cap {
  position: absolute;
  inset: 2px;
  display: block;
  border-radius: var(--r-key);
  background: var(--cap-skirt);
  transition: transform var(--t-fast) var(--ease);
}
.cap__face {
  position: absolute;
  inset: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 6px 7px 5px;
  text-align: left;
  border-radius: var(--r-key);
  border: 1px solid var(--line-1);
  background: linear-gradient(180deg, var(--cap-top), var(--cap-bottom));
  box-shadow: inset 0 1px 0 var(--cap-hi), inset 0 -2px 0 var(--cap-shade);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.cap:hover .cap__face { background: linear-gradient(180deg, var(--cap-hover-top), var(--cap-hover-bottom)); border-color: var(--line-2); }
.cap--pressed { transform: translateY(1px); }
.cap--pressed .cap__face {
  background: linear-gradient(180deg, var(--cap-off-top), var(--cap-off-bottom));
  border-color: var(--acc-line);
  box-shadow: inset 0 1px 2px var(--cap-shade);
}
.cap--sel .cap__face {
  background: var(--sel-fill);
  border-color: transparent;
  box-shadow: 0 0 0 1.5px var(--acc), inset 0 1px 0 var(--cap-hi);
}
.cap--flash .cap__face { border-color: var(--danger); box-shadow: 0 0 0 2px var(--danger); animation: cap-flash 0.5s ease-in-out 2; }
@keyframes cap-flash { 50% { box-shadow: 0 0 0 4px var(--danger); } }
@media (prefers-reduced-motion: reduce) { .cap--flash .cap__face { animation: none; } }
.cap__fill {
  position: absolute;
  inset: 0;
  transform-origin: top;
  background: linear-gradient(180deg, color-mix(in srgb, var(--metric, var(--acc)) 4%, transparent), color-mix(in srgb, var(--metric, var(--acc)) 16%, transparent));
  border-bottom: 1px solid color-mix(in srgb, var(--metric, var(--acc)) 45%, transparent);
  pointer-events: none;
  transition: transform var(--t-med) var(--ease);
}
.cap__led {
  position: absolute;
  left: 7px;
  right: 7px;
  bottom: 3px;
  height: 2px;
  border-radius: 2px;
  opacity: 0.9;
  pointer-events: none;
}
.cap__legend {
  position: relative;
  font-size: 12px;
  font-weight: 500;
  color: var(--fg-1);
  line-height: 1.1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cap__sub {
  position: relative;
  align-self: flex-end;
  font-size: 11px;
  font-weight: 500;
  color: var(--metric, var(--fg-2));
  line-height: 1.1;
  text-align: right;
  white-space: pre; /* a line break stacks two values (dead zones) */
}
.cap--sel .cap__sub, .cap--sel .cap__badge { color: var(--fg-1); }
.cap__foot {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  min-width: 0;
}
.cap__badge {
  align-self: flex-start;
  font-size: 10.5px;
  font-weight: 500;
  line-height: 1;
  color: var(--m-press);
  opacity: 0.85;
  white-space: nowrap;
}
.cap__badge--icon {
  display: inline-flex;
  color: var(--metric, var(--fg-2));
  opacity: 1;
}
.cap__sub--skeleton { width: 60%; height: 9px; }
</style>
