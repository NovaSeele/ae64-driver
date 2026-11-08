<script setup lang="ts">
// One CSS keycap. Geometry is set by KeyboardView; this renders legend, value line, fill, LED colour and state.
defineProps<{
  legend: string;
  sublabel?: string;
  /** Small accent value on the bottom-left (e.g. Rapid Trigger press/release sensitivity). */
  badge?: string;
  /** 0..1 vertical fill (e.g. travel or actuation depth). */
  fill?: number;
  /** LED colour (CSS colour). */
  color?: string;
  state?: 'pressed';
  selected?: boolean;
  loading?: boolean;
}>();
</script>

<template>
  <span
    class="cap"
    :class="{ 'cap--sel': selected, 'cap--pressed': state === 'pressed' }"
  >
    <span class="cap__face">
      <span v-if="fill !== undefined" class="cap__fill" :style="{ transform: `scaleY(${Math.min(1, Math.max(0, fill))})` }" />
      <span v-if="color" class="cap__led" :style="{ background: color, boxShadow: `0 0 10px ${color}` }" />
      <span class="cap__legend">{{ legend }}</span>
      <span v-if="loading" class="cap__sub cap__sub--skeleton skeleton" />
      <span v-else-if="sublabel !== undefined || badge" class="cap__foot">
        <span v-if="badge" class="cap__badge num">{{ badge }}</span>
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
  background: #1a1d22;
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
  background: linear-gradient(180deg, #252a31 0%, var(--bg-3) 100%);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), inset 0 -2px 0 rgba(0, 0, 0, 0.35);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.cap:hover .cap__face { background: linear-gradient(180deg, #2b3038 0%, #242930 100%); border-color: var(--line-2); }
.cap--pressed { transform: translateY(1px); }
.cap--pressed .cap__face {
  background: linear-gradient(180deg, #1d2126 0%, #1a1d22 100%);
  border-color: var(--acc-line);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
}
.cap--sel .cap__face {
  background: linear-gradient(180deg, rgba(63, 224, 197, 0.16) 0%, rgba(63, 224, 197, 0.1) 100%), var(--bg-3);
  border-color: transparent;
  box-shadow: 0 0 0 1.5px var(--acc), inset 0 1px 0 rgba(255, 255, 255, 0.06);
}
.cap__fill {
  position: absolute;
  inset: 0;
  transform-origin: top;
  background: linear-gradient(180deg, rgba(63, 224, 197, 0.04), rgba(63, 224, 197, 0.16));
  border-bottom: 1px solid var(--acc-line);
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
  color: var(--fg-2);
  line-height: 1.1;
  text-align: right;
  white-space: pre; /* a line break stacks two values (dead zones) */
}
.cap--sel .cap__sub { color: var(--acc); }
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
  color: var(--acc);
  opacity: 0.85;
  white-space: nowrap;
}
.cap__sub--skeleton { width: 60%; height: 9px; }
</style>
