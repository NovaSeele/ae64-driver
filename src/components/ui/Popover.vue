<script setup lang="ts">
// A small non-modal panel anchored to a button: opens below it, flips above when there is no room, Esc closes and returns
// focus to the anchor, a press outside closes, Tab stays inside. Teleported so a scrolling or contained parent cannot clip it.
import { nextTick, onBeforeUnmount, onDeactivated, ref, watch } from 'vue';

const open = defineModel<boolean>('open', { required: true });
// A page or tab kept alive and hidden (KeepAlive) closes what it had open: no overlay of a hidden tab (DESIGN E §3.6).
onDeactivated(() => { open.value = false; });
const props = withDefaults(defineProps<{ anchor: HTMLElement | null; title: string; width?: number }>(), { width: 312 });

const panel = ref<HTMLElement | null>(null);
const pos = ref<{ left: number; top: number }>({ left: 0, top: 0 });
const MARGIN = 8;
const GAP = 6;

function place() {
  const a = props.anchor?.getBoundingClientRect();
  if (!a) return;
  const h = panel.value?.offsetHeight ?? 0;
  const below = a.bottom + GAP;
  const above = a.top - GAP - h;
  const top = below + h > window.innerHeight - MARGIN && above >= MARGIN ? above : below;
  const left = Math.max(MARGIN, Math.min(a.right - props.width, window.innerWidth - props.width - MARGIN));
  pos.value = { left, top };
}

function close(refocus: boolean) {
  open.value = false;
  if (refocus) props.anchor?.focus();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.stopPropagation(); // not the page's Esc (clear selection)
    close(true);
    return;
  }
  if (e.key !== 'Tab' || !panel.value) return;
  const f = [...panel.value.querySelectorAll<HTMLElement>('button, input, [tabindex="0"]')].filter((el) => !el.hasAttribute('disabled'));
  if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
  else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
}

function onPointerDown(e: PointerEvent) {
  const n = e.target as Node | null;
  if (n && (panel.value?.contains(n) || props.anchor?.contains(n))) return; // the anchor's own click toggles
  const hadFocus = !!panel.value?.contains(document.activeElement);
  open.value = false;
  // Focus was inside and the press landed on nothing focusable: hand it back to the button instead of dropping it on <body>.
  if (hadFocus) queueMicrotask(() => { if (!document.activeElement || document.activeElement === document.body) props.anchor?.focus(); });
}

function listen(on: boolean) {
  if (on) {
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true);
    window.removeEventListener('resize', place);
    window.removeEventListener('scroll', place, true);
  }
}

watch(open, async (on) => {
  listen(on);
  if (!on) return;
  await nextTick();
  place();
  panel.value?.querySelector<HTMLElement>('input, button, [tabindex="0"]')?.focus();
}, { flush: 'post' });
onBeforeUnmount(() => listen(false));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      ref="panel"
      class="pop"
      role="dialog"
      :aria-label="title"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px`, width: `${width}px` }"
      @keydown="onKey"
    >
      <h3 class="pop__title">{{ title }}</h3>
      <slot />
    </div>
  </Teleport>
</template>

<style scoped>
.pop {
  position: fixed;
  z-index: 60;
  max-width: calc(100vw - 16px);
  padding: var(--s-3);
  background: var(--bg-2);
  border: 1px solid var(--line-2);
  border-radius: var(--r-card);
  box-shadow: var(--shadow-pop);
}
.pop__title { margin: 0 0 var(--s-2); font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); }
.pop :deep(.cp) { max-width: none; }
</style>
