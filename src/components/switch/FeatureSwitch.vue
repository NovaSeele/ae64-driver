<script setup lang="ts">
// Two large option cards that switch between independent features of one page (icon tile, name, one line, radio dot).
// A disabled option is locked: dashed, readable, a lock instead of the dot. ←/→ move and activate, skipping disabled.
import type { Component } from 'vue';
import { IconLock } from '@tabler/icons-vue';

const model = defineModel<string>({ required: true });
const props = defineProps<{
  items: { id: string; title: string; sub: string; icon: Component; tone: string; disabled?: boolean; hint?: string }[];
  label: string;
}>();

function onKey(e: KeyboardEvent) {
  const enabled = props.items.filter((x) => !x.disabled);
  let next: (typeof enabled)[number] | undefined;
  if (e.key === 'Home') next = enabled[0];
  else if (e.key === 'End') next = enabled[enabled.length - 1];
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    const n = props.items.length;
    let j = props.items.findIndex((x) => x.id === model.value);
    for (let step = 1; step <= n; step++) {
      j = (j + d + n) % n;
      if (!props.items[j].disabled) { next = props.items[j]; break; }
    }
  } else return;
  e.preventDefault();
  if (!next) return;
  model.value = next.id;
  (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
}
</script>

<template>
  <div class="feat" role="tablist" :aria-label="label" @keydown="onKey">
    <button
      v-for="(it, idx) in items"
      :key="it.id"
      type="button"
      role="tab"
      class="feat__opt"
      :data-id="it.id"
      :aria-selected="it.id === model"
      :disabled="it.disabled"
      :title="it.hint"
      :tabindex="it.id === model || (idx === 0 && !items.some((x) => x.id === model)) ? 0 : -1"
      @click="model = it.id"
    >
      <span class="feat__tile" :style="{ '--f': it.tone }"><component :is="it.icon" :size="20" stroke-width="1.75" aria-hidden="true" /></span>
      <span class="feat__text">
        <span class="feat__title">{{ it.title }}</span>
        <span class="feat__sub">{{ it.sub }}</span>
      </span>
      <span v-if="it.disabled" class="feat__lock"><IconLock :size="16" stroke-width="2" aria-hidden="true" /></span>
      <span v-else class="feat__dot" aria-hidden="true" />
    </button>
  </div>
</template>

<style scoped>
.feat { display: inline-grid; grid-auto-flow: column; grid-auto-columns: 1fr; gap: var(--s-3); } /* equal widths = the wider option */
.feat__opt {
  display: flex; align-items: center; gap: 12px; min-width: 280px; padding: 10px 14px 10px 10px;
  border: 1px solid var(--line-2); border-radius: var(--r-card); background: var(--bg-2); color: var(--fg-1);
  font: inherit; text-align: left; cursor: pointer;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.feat__opt:hover:not(:disabled):not([aria-selected='true']) { background: var(--bg-3); border-color: var(--line-3); }
.feat__opt[aria-selected='true'] { background: var(--sel-bg); border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc); }
/* Declared after the selected shadow so the focus ring is not overridden. */
.feat__opt:focus-visible,
.feat__opt[aria-selected='true']:focus-visible { box-shadow: var(--focus-ring); }
.feat__tile {
  display: grid; place-items: center; flex: none; width: 36px; height: 36px; border-radius: 9px;
  background: color-mix(in srgb, var(--f) 16%, transparent); color: var(--f);
}
.feat__text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.feat__title { font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); line-height: 1.25; }
.feat__sub { font-size: var(--fs-label); color: var(--fg-3); line-height: 1.3; }
.feat__opt[aria-selected='true'] .feat__sub { color: var(--fg-2); }
.feat__dot {
  flex: none; display: grid; place-items: center; width: 18px; height: 18px; margin-left: var(--s-2);
  border-radius: 50%; border: 1.5px solid var(--line-3);
}
.feat__opt[aria-selected='true'] .feat__dot { border-color: var(--acc); background: var(--acc); }
.feat__opt[aria-selected='true'] .feat__dot::after { content: ''; width: 6px; height: 6px; border-radius: 50%; background: var(--on-acc); }
.feat__opt:disabled { cursor: not-allowed; background: transparent; border-style: dashed; } /* locked: readable, not faded */
.feat__opt:disabled .feat__tile { --f: var(--fg-3); }
.feat__opt:disabled .feat__title,
.feat__opt:disabled .feat__sub { color: var(--fg-2); }
.feat__lock { flex: none; display: grid; place-items: center; width: 18px; height: 18px; margin-left: var(--s-2); color: var(--fg-2); }
</style>
