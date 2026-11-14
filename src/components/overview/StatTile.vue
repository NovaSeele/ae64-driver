<script setup lang="ts">
// One tile of the Overview page's summary row (DESIGN F §3.4): label row, value, then a sub line or a bar. The same
// anatomy in all four tiles, so their rows line up. With `to` the tile is a link (chevron at the end of the label row,
// hover border); without it a plain box. The page draws the value and the sub line (.ovs__value / .ovs__sub).
import type { Component } from 'vue';
import { RouterLink } from 'vue-router';
import type { RouteLocationRaw } from 'vue-router';
import { IconChevronRight } from '@tabler/icons-vue';

defineProps<{ to?: RouteLocationRaw; icon: Component; label: string }>();
</script>

<template>
  <component :is="to ? RouterLink : 'div'" class="ovs__tile" v-bind="to ? { to } : {}">
    <span class="ovs__label">
      <component :is="icon" :size="15" stroke-width="1.75" aria-hidden="true" />
      <span>{{ label }}</span>
      <IconChevronRight v-if="to" class="ovs__go" :size="16" stroke-width="2" aria-hidden="true" />
    </span>
    <slot name="value" />
    <slot name="sub" />
  </component>
</template>

<style scoped>
.ovs__tile {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 14px var(--s-4) var(--s-4);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  color: inherit;
  text-decoration: none;
}
a.ovs__tile { transition: border-color var(--t-fast) var(--ease); }
a.ovs__tile:hover { border-color: var(--line-3); }
.ovs__label { display: flex; align-items: center; gap: 6px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-2); }
.ovs__label > svg { flex: none; color: var(--fg-3); }
.ovs__label > .ovs__go { margin-left: auto; }
a.ovs__tile:hover .ovs__go { color: var(--fg-1); }
</style>
