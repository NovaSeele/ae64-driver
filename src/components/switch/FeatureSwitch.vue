<script setup lang="ts">
// Large option cards that switch between independent features of one page (icon tile, name, one line, radio dot).
// A disabled option is locked: dashed, readable, a lock instead of the dot. ←/→ move and activate, skipping disabled.
// `compact` (the Performance page's tab row, DESIGN E §3.3): one equal cell per option, no line in the card; the line
// goes to `title` and to a hidden aria-describedby text with the option's scope. `manual`: ←/→/Home/End only move the
// focus, Enter / Space (the button's click) opens (APG manual activation: every open is a history entry and may read keys).
import type { Component } from 'vue';
import { IconLock } from '@tabler/icons-vue';

const model = defineModel<string>({ required: true });
const props = defineProps<{
  items: { id: string; title: string; sub: string; icon: Component; tone: string; disabled?: boolean; hint?: string; scope?: string }[];
  label: string;
  compact?: boolean;
  manual?: boolean;
  /** compact: the options' ids are `${idPrefix}-${id}`, their descriptions `${idPrefix}-${id}-d`. */
  idPrefix?: string;
  /** The id of the tabpanel the options control. */
  controls?: string;
}>();

const optId = (id: string) => (props.idPrefix ? `${props.idPrefix}-${id}` : undefined);
const descId = (id: string) => (props.compact && props.idPrefix ? `${props.idPrefix}-${id}-d` : undefined);

function onKey(e: KeyboardEvent) {
  const enabled = props.items.filter((x) => !x.disabled);
  let next: (typeof enabled)[number] | undefined;
  // manual: move from the focused option (it may not be the open one); otherwise from the open one
  const from = props.manual ? (document.activeElement as HTMLElement | null)?.dataset?.id ?? model.value : model.value;
  if (e.key === 'Home') next = enabled[0];
  else if (e.key === 'End') next = enabled[enabled.length - 1];
  else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    const d = e.key === 'ArrowRight' ? 1 : -1;
    const n = props.items.length;
    let j = props.items.findIndex((x) => x.id === from);
    for (let step = 1; step <= n; step++) {
      j = (j + d + n) % n;
      if (!props.items[j].disabled) { next = props.items[j]; break; }
    }
  } else return;
  e.preventDefault();
  if (!next) return;
  if (!props.manual) model.value = next.id;
  (e.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-id="${next.id}"]`)?.focus();
}
</script>

<template>
  <div class="feat" :class="{ 'feat--compact': compact }" role="tablist" :aria-label="label" @keydown="onKey">
    <button
      v-for="(it, idx) in items"
      :id="optId(it.id)"
      :key="it.id"
      type="button"
      role="tab"
      class="feat__opt"
      :data-id="it.id"
      :aria-selected="it.id === model"
      :aria-controls="controls"
      :aria-describedby="descId(it.id)"
      :disabled="it.disabled"
      :title="compact ? (it.disabled && it.hint ? it.hint : it.sub) : it.hint"
      :tabindex="it.id === model || (idx === 0 && !items.some((x) => x.id === model)) ? 0 : -1"
      @click="model = it.id"
    >
      <span class="feat__tile" :style="{ '--f': it.disabled ? 'var(--fg-3)' : it.tone }"><component :is="it.icon" :size="compact ? 18 : 20" stroke-width="1.75" aria-hidden="true" /></span>
      <span class="feat__text">
        <span class="feat__title">{{ it.title }}</span>
        <span v-if="!compact" class="feat__sub">{{ it.sub }}</span>
      </span>
      <span v-if="it.disabled" class="feat__lock"><IconLock :size="16" stroke-width="2" aria-hidden="true" /></span>
      <span v-else class="feat__dot" aria-hidden="true" />
    </button>
    <!-- outside the buttons, so the description is not part of the option's name -->
    <div v-if="compact && idPrefix" hidden>
      <span v-for="it in items" :id="descId(it.id)" :key="it.id">{{ it.sub }}.{{ it.scope ? ` ${it.scope}.` : '' }}</span>
    </div>
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
.feat__opt:disabled .feat__title,
.feat__opt:disabled .feat__sub { color: var(--fg-2); }
.feat__lock { flex: none; display: grid; place-items: center; width: 18px; height: 18px; margin-left: var(--s-2); color: var(--fg-2); }

/* E4 (DESIGN E §3.3): the tab row. Five equal cells; five cues on the open tab: --sel-bg fill, --acc border + inset ring,
   filled radio dot, heavier title, and a solid --acc icon tile (--on-acc icon >= 5.56:1; the tinted tile was 2.73:1 in
   dracula). The cell count follows the host's container (.ph): 3 per row under 960 px, 2 under 576 px. */
.feat.feat--compact { display: grid; grid-auto-flow: row; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: var(--s-2); width: 100%; }
.feat--compact .feat__opt { min-width: 0; gap: 10px; padding: 8px 10px 8px 8px; min-height: 46px; }
.feat--compact .feat__tile { width: 28px; height: 28px; border-radius: 7px; }
.feat--compact .feat__opt[aria-selected='true'] .feat__tile { background: var(--acc); color: var(--on-acc); }
.feat--compact .feat__title { font-size: var(--fs-body); font-weight: 500; color: var(--fg-2); white-space: nowrap; }
.feat--compact .feat__opt[aria-selected='true'] .feat__title { font-weight: 650; color: var(--fg-1); }
.feat--compact .feat__opt:hover:not(:disabled) .feat__title { color: var(--fg-1); }
.feat--compact .feat__dot,
.feat--compact .feat__lock { margin-left: auto; }
.feat--compact .feat__opt:disabled .feat__title { color: var(--fg-2); }
@container (max-width: 959.98px) { .feat.feat--compact { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@container (max-width: 575.98px) { .feat.feat--compact { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
</style>
