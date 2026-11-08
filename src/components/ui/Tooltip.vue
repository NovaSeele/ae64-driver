<script setup lang="ts">
import { onBeforeUnmount, ref, useId } from 'vue';

withDefaults(defineProps<{ text: string; placement?: 'top' | 'bottom' }>(), { placement: 'top' });
const open = ref(false);
const id = useId();
let timer: ReturnType<typeof setTimeout> | undefined;

function show() {
  clearTimeout(timer);
  timer = setTimeout(() => (open.value = true), 350);
}
function hide() {
  clearTimeout(timer);
  open.value = false;
}
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <span
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
      <span v-if="open" :id="id" role="tooltip" class="tip__bubble" :class="`tip__bubble--${placement}`">{{ text }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.tip { position: relative; display: inline-flex; }
.tip__bubble {
  position: absolute;
  left: 50%;
  z-index: 50;
  transform: translateX(-50%);
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
.tip-enter-from, .tip-leave-to { opacity: 0; transform: translate(-50%, 3px); }
</style>
