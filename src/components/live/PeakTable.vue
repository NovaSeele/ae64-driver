<script setup lang="ts">
// Deepest reading per key (DESIGN C §3.6): pressed keys, deepest first, with a bar against the switch travel and a tick
// at the full-travel line. Clicking a row pins its key. The list scrolls inside the card and never makes the row taller
// than the health check beside it (`contain: size`); its minimum height follows the number of rows.
import { computed, ref } from 'vue';
import { IconArrowBarToDown, IconArrowBarToUp, IconCheck } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import { useRovingFocus } from '../../composables/useRovingFocus';
import type { CheckRow } from './keyCheck';
import { t } from '../../i18n/vi';

const props = defineProps<{
  rows: CheckRow[];
  pinnedId: number | null;
  estimated: boolean;
  /** The check was started over (Start over) since the page opened. */
  sinceReset: boolean;
}>();
const emit = defineEmits<{ pin: [id: number] }>();

const bodyEl = ref<HTMLElement | null>(null);
const roving = useRovingFocus({ container: bodyEl, ids: () => props.rows.map((r) => r.id), orientation: 'vertical' });

const subtitle = computed(() => `${props.sinceReset ? t('live.peaksSinceReset') : t('live.peaksSince')} · ${t('live.peaksRule')}${props.estimated ? ` ${t('live.peaksEstimated')}` : ''}`);
/** Rows of 29px under a 26px head, up to the graph card's height (DESIGN C §2). */
const minHeight = computed(() => (props.rows.length ? `${Math.min(props.rows.length * 29 + 26, 206)}px` : undefined));
const kindText = (k: CheckRow['kind']) => (k === 'ok' ? t('live.pOk') : k === 'short' ? t('live.pShort') : t('live.pStuck'));
</script>

<template>
  <Card class="pt" :title="t('live.peaks')" :subtitle="subtitle">
    <div class="pt__wrap" :style="{ minHeight }">
      <table v-if="rows.length" class="pt__table">
        <colgroup><col class="pt__c-key"><col><col class="pt__c-mm"><col class="pt__c-pct"></colgroup>
        <thead>
          <tr>
            <th scope="col">{{ t('live.pKey') }}</th>
            <th scope="col">{{ t('live.pDepth') }}</th>
            <th scope="col" class="pt__n">mm</th>
            <th scope="col" class="pt__n" :aria-label="t('live.pPctLabel')">{{ t('live.pPct') }}</th>
          </tr>
        </thead>
        <tbody ref="bodyEl">
          <tr
            v-for="r in rows"
            :key="r.id"
            class="pt__row"
            :class="{ 'pt__row--pin': r.id === pinnedId }"
            :aria-current="r.id === pinnedId ? 'true' : undefined"
            @click="emit('pin', r.id)"
          >
            <th scope="row">
              <button
                type="button"
                class="pt__key"
                :class="`pt__key--${r.kind}`"
                :data-rid="r.id"
                :tabindex="roving.tabindex(r.id)"
                :aria-label="t('live.peakPin', { key: r.name })"
                @focus="roving.onFocus(r.id)"
                @keydown="roving.onKeydown($event, r.id)"
                @click.stop="emit('pin', r.id)"
              >
                <IconCheck v-if="r.kind === 'ok'" :size="14" stroke-width="1.8" aria-hidden="true" />
                <IconArrowBarToDown v-else-if="r.kind === 'short'" :size="14" stroke-width="1.8" aria-hidden="true" />
                <IconArrowBarToUp v-else :size="14" stroke-width="1.8" aria-hidden="true" />
                <span>{{ r.name }}</span><span class="pt__sr">, {{ kindText(r.kind) }}</span>
              </button>
            </th>
            <td><div class="pt__bar" :class="`pt__bar--${r.bar}`" aria-hidden="true"><i :style="{ width: `${(Math.min(1, r.ratio) * 100).toFixed(1)}%` }" /></div></td>
            <td class="pt__n num">{{ r.mm.toFixed(2) }}</td>
            <td class="pt__n pt__pct num">{{ Math.round(r.ratio * 100) }}%</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="pt__empty">{{ t('live.peaksEmpty') }}</p>
    </div>
  </Card>
</template>

<style scoped>
.pt__wrap {
  flex: 1 1 auto;
  min-height: 120px;
  contain: size; /* the list never makes the check row taller than the health check */
  overflow-y: auto;
  margin: 0 calc(-1 * var(--s-2));
  padding: 0 var(--s-2);
  scrollbar-gutter: stable;
}
.pt__table { width: 100%; border-collapse: collapse; font-size: var(--fs-label); table-layout: fixed; }
.pt__table thead th {
  position: sticky; top: 0; z-index: 1; background: var(--bg-2);
  height: 22px; padding: 0 0 4px; text-align: left; vertical-align: bottom;
  font-size: var(--fs-caption); font-weight: 500; color: var(--fg-3);
}
.pt__table th.pt__n, .pt__table td.pt__n { text-align: right; }
.pt__c-key { width: 76px; }
.pt__c-mm { width: 52px; }
.pt__c-pct { width: 58px; }
.pt__row { cursor: pointer; }
.pt__row > * { height: 28px; padding: 0; border-top: 1px solid var(--line-1); }
.pt__row > th { text-align: left; font-weight: inherit; }
.pt__row > td.pt__n { padding-left: var(--s-2); font-variant-numeric: tabular-nums; color: var(--fg-1); }
.pt__row > td.pt__pct { color: var(--fg-2); }
.pt__row:hover > * { background: var(--bg-3); }
.pt__row--pin > * { background: color-mix(in srgb, var(--acc) 10%, transparent); }
.pt__row--pin > th { box-shadow: inset 2px 0 0 var(--acc); }
.pt__key {
  display: inline-flex; align-items: center; gap: 6px; height: 24px; max-width: 100%; padding: 0 6px;
  font: inherit; font-weight: 600; color: var(--fg-1); background: none; border: 0; border-radius: var(--r-control); cursor: pointer;
}
.pt__key svg { flex: none; }
.pt__key--ok svg { color: var(--ok); }
.pt__key--short svg { color: var(--warn); }
.pt__key--stuck svg { color: var(--danger); }
.pt__bar { position: relative; height: 6px; margin: 0 2px 0 var(--s-2); border-radius: 3px; background: var(--bg-4); }
.pt__bar > i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 3px; background: var(--ok); }
.pt__bar--short > i { background: var(--warn); }
/* the full-travel line (FULL_TRAVEL = 95%) */
.pt__bar::after { content: ''; position: absolute; left: 95%; top: -3px; bottom: -3px; width: 1px; background: var(--fg-3); }
.pt__empty { margin: var(--s-6) 0; text-align: center; font-size: var(--fs-label); color: var(--fg-3); }
.pt__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
