<script setup lang="ts">
import { onBeforeUnmount, ref, useId, watch } from 'vue';

/** `disabled`: no bubble (one already open closes), so a wrapper can stay in place while its content changes state. */
const props = withDefaults(defineProps<{ text: string; placement?: 'top' | 'bottom'; disabled?: boolean }>(), { placement: 'top', disabled: false });
const open = ref(false);
const id = useId();
let timer: ReturnType<typeof setTimeout> | undefined;
watch(() => props.disabled, (off) => { if (off) hide(); });

// ------------------------------------------------------------------ keeping the bubble on screen (TIP §3)
/** The bubble's distance from its trigger (`calc(100% + 8px)` below). */
const GAP = 8;
/** The least distance from the edge of what is visible. */
const EDGE = 8;
/** The bubble's max width in the CSS below. */
const MAX = 260;
/** Never narrower than this, however narrow the box. */
const MIN = 120;

const root = ref<HTMLElement | null>(null);
const bubble = ref<HTMLElement | null>(null);
const side = ref<'top' | 'bottom'>(props.placement);
const dx = ref(0);
const maxWidth = ref<number | null>(null);

interface Box { left: number; top: number; right: number; bottom: number }

/** What the user can see: the viewport, cut by every ancestor that clips, inside its borders and scrollbars. */
function clipBox(from: HTMLElement): Box {
  const de = document.documentElement;
  const box: Box = { left: 0, top: 0, right: de.clientWidth, bottom: de.clientHeight };
  for (let a = from.parentElement; a && a !== de && a !== document.body; a = a.parentElement) {
    const cs = getComputedStyle(a);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const r = a.getBoundingClientRect();
    const left = r.left + a.clientLeft;
    const top = r.top + a.clientTop;
    box.left = Math.max(box.left, left);
    box.top = Math.max(box.top, top);
    box.right = Math.min(box.right, left + a.clientWidth);
    box.bottom = Math.min(box.bottom, top + a.clientHeight);
  }
  return box;
}

/**
 * Places the open bubble: a narrower max width first when the box is narrow, then the measure, then the sideways shift
 * and the side. Runs after the DOM update in which the bubble rendered (still at opacity 0), and again when its text
 * changes while open. Nothing from an earlier open is used.
 */
function fit() {
  const el = bubble.value;
  const trigger = root.value; // the bubble is centred on it (left: 50%)
  if (!el || !trigger) return;
  const box = clipBox(trigger);
  const room = box.right - box.left - 2 * EDGE;
  const narrow = room < MAX ? Math.max(MIN, Math.floor(room)) : null;
  el.style.maxWidth = narrow === null ? '' : `${narrow}px`; // on the element before measuring: the width it will have
  maxWidth.value = narrow;
  const t = trigger.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  // sideways: centred on the trigger, else moved the least distance that keeps both sides EDGE inside the box
  const left0 = t.left + t.width / 2 - b.width / 2;
  const left = Math.min(Math.max(left0, box.left + EDGE), box.right - EDGE - b.width);
  dx.value = Math.round(left - left0);
  // up or down: the asked side if it fits, else the other side if that fits, else the asked side
  const above = t.top - GAP - EDGE - box.top;
  const below = box.bottom - EDGE - (t.bottom + GAP);
  const fits = (s: 'top' | 'bottom') => (s === 'top' ? above : below) >= b.height;
  const other = props.placement === 'top' ? 'bottom' : 'top';
  side.value = fits(props.placement) || !fits(other) ? props.placement : other;
  // Measuring made the browser compute the bubble unshifted. A shift that arrives after that animates under the enter
  // transition (the bubble slides sideways while it fades in), so it goes on now with transitions off and is committed
  // before they come back; the re-render then writes the same value.
  el.style.transition = 'none';
  el.style.setProperty('--tip-dx', `${dx.value}px`);
  void getComputedStyle(el).transform;
  el.style.transition = '';
}
watch(open, (o) => { if (o) fit(); }, { flush: 'post' });
watch(() => props.text, () => { if (open.value) fit(); }, { flush: 'post' });

function show() {
  if (props.disabled) return;
  clearTimeout(timer);
  timer = setTimeout(() => {
    // every open starts from the asked side, no shift and the full width
    side.value = props.placement;
    dx.value = 0;
    maxWidth.value = null;
    open.value = true;
  }, 350);
}
function hide() {
  clearTimeout(timer);
  open.value = false;
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <span
    ref="root"
    class="tip"
    :aria-describedby="open ? id : undefined"
    @pointerenter="show"
    @pointerleave="hide"
    @focusin="show"
    @focusout="hide"
    @keydown.esc="hide"
  >
    <slot />
    <Transition name="tip">
      <span
        v-if="open"
        :id="id"
        ref="bubble"
        role="tooltip"
        class="tip__bubble"
        :class="`tip__bubble--${side}`"
        :style="{ '--tip-dx': `${dx}px`, maxWidth: maxWidth === null ? undefined : `${maxWidth}px` }"
      >{{ text }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.tip { position: relative; display: inline-flex; }
.tip__bubble {
  position: absolute;
  left: 50%;
  z-index: 50;
  transform: translateX(calc(-50% + var(--tip-dx, 0px)));
  width: max-content;
  max-width: 260px;
  padding: 6px 9px;
  border-radius: var(--r-control);
  background: var(--bg-4);
  color: var(--fg-1);
  font-size: var(--fs-label);
  font-weight: 400;
  line-height: 1.35;
  box-shadow: var(--shadow-pop);
  pointer-events: none;
}
.tip__bubble--top { bottom: calc(100% + 8px); }
.tip__bubble--bottom { top: calc(100% + 8px); }
.tip-enter-active, .tip-leave-active { transition: opacity var(--t-fast) var(--ease), transform var(--t-fast) var(--ease); }
/* the shift is in every transform, so the bubble fades in and out where it stands, never sliding sideways */
.tip-enter-from, .tip-leave-to { opacity: 0; transform: translate(calc(-50% + var(--tip-dx, 0px)), 3px); }
</style>
