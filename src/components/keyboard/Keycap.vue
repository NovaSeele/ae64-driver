<script lang="ts">
/** One line of a multi-line sublabel, optionally in its own colour. */
export type SubLine = { text: string; tone?: string };
</script>

<script setup lang="ts">
// One CSS keycap. Geometry is set by KeyboardView; this renders legend, value line, fill, LED colour and state.
import { computed, type Component } from 'vue';
import type { LedGlow } from '../../ledGlow';

const props = defineProps<{
  legend: string;
  /** A string, or several lines each with an optional colour. */
  sublabel?: string | SubLine[];
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
  /** LED bar height in px (default 2). A thicker bar also raises the value line so the bar never covers it. */
  ledHeight?: number;
  /** How the LED is drawn: a bar at the foot ('bar', default, uses `color`) or the whole key lit ('glow', uses `glow`). */
  ledStyle?: 'bar' | 'glow';
  /** Glow style only: the lit LED; undefined = off, the key looks normal. */
  glow?: LedGlow;
  state?: 'pressed';
  selected?: boolean;
  /** Briefly outlined in the danger colour (a write for this key was dropped). */
  flashing?: boolean;
  loading?: boolean;
  /** Dashed warn inset outline (e.g. a key that is not calibrated); drawn together with the selection outline. */
  flagged?: boolean;
}>();

const glowing = computed(() => props.ledStyle === 'glow' && !!props.glow);
const bar = computed(() => (props.ledStyle === 'glow' ? undefined : props.color));
const capStyle = computed(() => {
  const st: Record<string, string> = {};
  if (props.tone) st['--metric'] = props.tone;
  if (glowing.value) {
    st['--led'] = props.glow!.led;
    st['--led-level'] = String(props.glow!.level);
  }
  return Object.keys(st).length ? st : undefined;
});
</script>

<template>
  <span
    class="cap"
    :class="{ 'cap--sel': selected, 'cap--pressed': state === 'pressed', 'cap--flash': flashing, 'cap--flag': flagged, 'cap--glow': glowing }"
    :style="capStyle"
  >
    <span class="cap__face" :style="ledStyle !== 'glow' && ledHeight ? { paddingBottom: `${ledHeight + 5}px` } : undefined">
      <span v-if="fill !== undefined" class="cap__fill" :style="{ transform: `scaleY(${Math.min(1, Math.max(0, fill))})` }" />
      <span v-if="bar" class="cap__led" :style="{ background: bar, boxShadow: `0 0 10px ${bar}`, height: ledHeight ? `${ledHeight}px` : undefined }" />
      <span v-if="$slots.default" class="cap__extra" :style="bar && ledHeight ? { bottom: `${ledHeight + 6}px` } : undefined"><slot /></span>
      <span class="cap__legend">{{ legend }}</span>
      <span v-if="loading" class="cap__sub cap__sub--skeleton skeleton" />
      <span v-else-if="sublabel !== undefined || badge || badgeIcon" class="cap__foot">
        <span v-if="badgeIcon" class="cap__badge cap__badge--icon" :title="badgeTitle" :aria-label="badgeTitle">
          <component :is="badgeIcon" :size="11" :stroke-width="1.8" aria-hidden="true" />
        </span>
        <span v-else-if="badge" class="cap__badge num" :title="badgeTitle" :aria-label="badgeTitle">{{ badge }}</span>
        <span v-if="typeof sublabel === 'string'" class="cap__sub num">{{ sublabel }}</span>
        <span v-else-if="sublabel" class="cap__sub cap__sub--lines num">
          <span v-for="(line, i) in sublabel" :key="i" class="cap__line" :style="line.tone ? { '--sub-tone': line.tone } : undefined">{{ line.text }}</span>
        </span>
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
  container-type: size; /* compact layout below 52px face height, see the container query at the end */
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
.cap--flag .cap__face { outline: 1.5px dashed var(--warn); outline-offset: -4px; }
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
  transition: background 100ms linear, box-shadow 100ms linear;
}
@media (prefers-reduced-motion: reduce) {
  .cap__led { transition: none; }
}
.cap__legend {
  position: relative;
  font-size: clamp(12px, calc(var(--u, 58px) * 0.21), 15px);
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
  font-size: clamp(11px, calc(var(--u, 58px) * 0.185), 13px);
  font-weight: 500;
  color: var(--metric, var(--fg-2));
  line-height: 1.1;
  text-align: right;
  white-space: pre; /* a line break stacks two values (dead zones) */
}
.cap__sub--lines { display: flex; flex-direction: column; align-items: flex-end; font-size: clamp(11px, calc(var(--u, 58px) * 0.185), 13px); }
.cap__line { color: var(--sub-tone, var(--metric, var(--fg-2))); }
.cap--sel .cap__sub, .cap--sel .cap__badge, .cap--sel .cap__line { color: var(--fg-1); }
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
  font-size: var(--fs-caption);
  font-weight: 500;
  line-height: 1;
  color: var(--m-press);
  white-space: nowrap;
}
.cap__badge--icon {
  display: inline-flex;
  color: var(--metric, var(--fg-2));
  opacity: 1;
}
.cap__extra { position: absolute; right: 5px; bottom: 5px; line-height: 0; pointer-events: none; }

/* Glow style (Lighting, DESIGN A §3.1): the LED tints the whole key, strongest at the foot where the LED sits, with a
   coloured edge, a brighter inner bottom edge and a 12px halo. --led is the colour at full brightness and --led-level its
   brightness, so a dim LED tints less instead of greying the key. --led-tint-top/bottom are per theme (themes.css), kept
   under the legend-contrast ceiling for a white LED. */
.cap.cap--glow {
  --lv: var(--led-level, 1);
  --led-top: calc(var(--led-tint-top) * var(--lv));
  --led-bottom: calc(var(--led-tint-bottom) * var(--lv));
  --led-edge: color-mix(in srgb, var(--led) calc(65% * var(--lv)), transparent);
  /* 30 %, not more: the ● badge at the foot sits in this inner glow and needs >= 3:1 with a white LED (measured on
     r98: 55 % gave 2.67-2.76 on the dark themes, 30 % gives 3.46-3.54) */
  --led-inner: inset 0 -10px 18px -6px color-mix(in srgb, var(--led) calc(30% * var(--lv)), transparent);
  --led-halo: 0 0 12px -2px color-mix(in srgb, var(--led) calc(50% * var(--lv)), transparent);
}
.cap.cap--glow .cap__face {
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--led) var(--led-top), var(--cap-top)),
    color-mix(in srgb, var(--led) var(--led-bottom), var(--cap-bottom)));
  border-color: var(--led-edge);
  box-shadow: var(--led-inner), var(--led-halo);
  /* No transition: live preview repaints at 10 Hz, so a 100 ms fade on 64 keys never settles and becomes a running
     animation (27 frames over 33 ms in 6 s at 4x CPU). Colours step with the data, like the firmware. */
  transition: none;
}
.cap.cap--glow:hover .cap__face {
  background: linear-gradient(180deg,
    color-mix(in srgb, var(--led) var(--led-top), var(--cap-hover-top)),
    color-mix(in srgb, var(--led) var(--led-bottom), var(--cap-hover-bottom)));
  border-color: color-mix(in srgb, var(--led) calc(80% * var(--lv)), var(--line-2));
}
/* Selected: 1px --bg-1 gap and a 2px --acc ring outside the glow; the tint stays. */
.cap.cap--sel.cap--glow .cap__face {
  border-color: var(--led-edge);
  box-shadow: 0 0 0 1px var(--bg-1), 0 0 0 3px var(--acc), var(--led-inner), var(--led-halo);
}
/* A dropped write still flashes in the danger colour over the glow. */
.cap.cap--flash.cap--glow .cap__face { border-color: var(--danger); box-shadow: 0 0 0 2px var(--danger); }
.cap.cap--glow .cap__badge { color: var(--fg-1); }
.cap__extra :deep(.swatch) { width: 20px; height: 20px; }
.cap__sub--skeleton { width: 60%; height: 9px; }

/* Compact keycap: faces under 52px tall (narrow windows) keep a 3-row foot inside the face. */
@container (max-height: 51.99px) {
  .cap__face { padding: 4px 6px 4px; }
  .cap__legend { font-size: 11px; line-height: 1.05; }
  .cap__badge { font-size: var(--fs-caption); }
  .cap__foot { gap: 1px; }
  .cap__sub, .cap__sub--lines { font-size: 11px; }
  .cap__extra { right: 4px; bottom: 4px; }
  .cap__extra :deep(.swatch) { width: 18px; height: 18px; }
}
</style>
