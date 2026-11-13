<script setup lang="ts">
// Deepest reading per key (DESIGN C §3.6): pressed keys, deepest first, with a bar against the switch travel and a tick
// at the full-travel line. Clicking a row pins its key. The list scrolls inside the card and never makes the row taller
// than the health check beside it (`contain: size`); its minimum height follows the number of rows.
//
// Only the rows in and near the visible part of the list are in the page (C-PERF-1): 64 rows repainted with the keyboard
// every frame cost more than the rest of the page. Spacer rows keep the scroll height; the row holding the Tab stop is
// always there (Tab reaches the table, a focused row is never removed); aria-rowcount/-rowindex give the real positions.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconArrowBarToDown, IconArrowBarToUp, IconCheck } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import { useRovingFocus } from '../../composables/useRovingFocus';
import type { CheckRow } from './keyCheck';
import { t } from '../../i18n/vi';
import { locale } from '../../i18n/locale';

const props = defineProps<{
  rows: CheckRow[];
  pinnedId: number | null;
  estimated: boolean;
  /** The check was started over (Start over) since the page opened. */
  sinceReset: boolean;
}>();
const emit = defineEmits<{ pin: [id: number] }>();

const bodyEl = ref<HTMLElement | null>(null);
const wrapEl = ref<HTMLElement | null>(null);
/** Rendered sizes (border-collapse puts each row's top border inside its 28px; the head is 22px): the spacers must
 *  match them exactly or the scrollbar jumps when rows come and go. Measured in Chrome at 1280–1920. */
const ROW = 28;
const HEAD = 22;
/** Rows kept beyond each edge of the visible part, so a short scroll shows rows already there. */
const OVER = 4;
const scrollY = ref(0);
/** The list's visible height: at most 206 from the min-height rule, more when the health check makes the row taller. */
const viewH = ref(206);
const roving = useRovingFocus({ container: bodyEl, ids: () => props.rows.map((r) => r.id), orientation: 'vertical', reveal: (_id, index) => reveal(index) });

/** Scroll the list so the row at `index` is fully visible under the sticky head (an arrow key moved to it). */
function reveal(index: number): void {
  const el = wrapEl.value;
  if (!el) return;
  const y = HEAD + index * ROW;
  let top = el.scrollTop;
  if (y - HEAD < top) top = y - HEAD;
  else if (y + ROW > top + viewH.value) top = y + ROW - viewH.value;
  if (top !== el.scrollTop) el.scrollTop = top;
  scrollY.value = top;
}
function onScroll(): void {
  if (wrapEl.value) scrollY.value = wrapEl.value.scrollTop;
}
let ro: ResizeObserver | null = null;
onMounted(() => {
  if (typeof ResizeObserver !== 'function' || !wrapEl.value) return;
  ro = new ResizeObserver(() => { if (wrapEl.value && wrapEl.value.clientHeight > 0) viewH.value = wrapEl.value.clientHeight; });
  ro.observe(wrapEl.value);
});
onBeforeUnmount(() => ro?.disconnect());

interface Line { key: string | number; r?: CheckRow; index?: number; pad?: number }
/** The rows in the page, in order, with a spacer row (its height) for each run of rows left out. */
const lines = computed<Line[]>(() => {
  const rows = props.rows;
  const n = rows.length;
  const first = Math.max(0, Math.floor((scrollY.value - HEAD) / ROW) - OVER);
  const last = Math.min(n - 1, Math.ceil((scrollY.value + viewH.value - HEAD) / ROW) + OVER);
  const keep: number[] = [];
  for (let i = first; i <= last; i++) keep.push(i);
  const stop = roving.stop.value;
  const stopAt = stop === null ? -1 : rows.findIndex((r) => r.id === stop);
  if (stopAt >= 0 && (stopAt < first || stopAt > last)) keep.push(stopAt);
  keep.sort((a, b) => a - b);
  const out: Line[] = [];
  let next = 0;
  for (const i of keep) {
    if (i > next) out.push({ key: `pad${next}`, pad: (i - next) * ROW });
    out.push({ key: rows[i].id, r: rows[i], index: i });
    next = i + 1;
  }
  if (next < n) out.push({ key: `pad${next}`, pad: (n - next) * ROW });
  return out;
});

const subtitle = computed(() => `${props.sinceReset ? t('live.peaksSinceReset') : t('live.peaksSince')} · ${t('live.peaksRule')}${props.estimated ? ` ${t('live.peaksEstimated')}` : ''}`);
/** Rows of 29px under a 26px head, up to the graph card's height (DESIGN C §2). */
const minHeight = computed(() => (props.rows.length ? `${Math.min(props.rows.length * 29 + 26, 206)}px` : undefined));
/** The fill is full width and clipped at the reading: changing it repaints the bar but lays nothing out. */
const fillClip = (ratio: number) => `inset(0 ${(100 - Math.min(1, ratio) * 100).toFixed(1)}% 0 0 round 3px)`;
const kindText = (k: CheckRow['kind']) => (k === 'ok' ? t('live.pOk') : k === 'short' ? t('live.pShort') : t('live.pStuck'));
</script>

<template>
  <Card class="pt" :title="t('live.peaks')" :subtitle="subtitle">
    <div ref="wrapEl" class="pt__wrap" :style="{ minHeight }" @scroll.passive="onScroll">
      <table v-if="rows.length" class="pt__table" :aria-rowcount="rows.length + 1">
        <colgroup><col class="pt__c-key"><col><col class="pt__c-mm"><col class="pt__c-pct"></colgroup>
        <thead>
          <tr aria-rowindex="1">
            <th scope="col">{{ t('live.pKey') }}</th>
            <th scope="col">{{ t('live.pDepth') }}</th>
            <th scope="col" class="pt__n">mm</th>
            <th scope="col" class="pt__n" :aria-label="t('live.pPctLabel')">{{ t('live.pPct') }}</th>
          </tr>
        </thead>
        <tbody ref="bodyEl">
          <tr
            v-for="l in lines"
            :key="l.key"
            v-memo="[l.r, l.pad, l.index, l.r?.id === pinnedId, l.r ? roving.tabindex(l.r.id) : 0, locale]"
            :class="l.r ? ['pt__row', { 'pt__row--pin': l.r.id === pinnedId }] : 'pt__pad'"
            :aria-hidden="l.r ? undefined : 'true'"
            :aria-rowindex="l.r ? l.index! + 2 : undefined"
            :aria-current="l.r && l.r.id === pinnedId ? 'true' : undefined"
            @click="l.r && emit('pin', l.r.id)"
          >
            <td v-if="!l.r" colspan="4" :style="{ height: `${l.pad}px` }" />
            <template v-else>
            <th scope="row">
              <button
                type="button"
                class="pt__key"
                :class="`pt__key--${l.r.kind}`"
                :data-rid="l.r.id"
                :tabindex="roving.tabindex(l.r.id)"
                :aria-label="t('live.peakPin', { key: l.r.name })"
                @focus="roving.onFocus(l.r.id)"
                @keydown="roving.onKeydown($event, l.r.id)"
                @click.stop="emit('pin', l.r.id)"
              >
                <IconCheck v-if="l.r.kind === 'ok'" :size="14" stroke-width="1.8" aria-hidden="true" />
                <IconArrowBarToDown v-else-if="l.r.kind === 'short'" :size="14" stroke-width="1.8" aria-hidden="true" />
                <IconArrowBarToUp v-else :size="14" stroke-width="1.8" aria-hidden="true" />
                <span>{{ l.r.name }}</span><span class="pt__sr">, {{ kindText(l.r.kind) }}</span>
              </button>
            </th>
            <td><div class="pt__bar" :class="`pt__bar--${l.r.bar}`" aria-hidden="true"><i :style="{ clipPath: fillClip(l.r.ratio) }" /></div></td>
            <td class="pt__n num">{{ l.r.mm.toFixed(2) }}</td>
            <td class="pt__n pt__pct num">{{ Math.round(l.r.ratio * 100) }}%</td>
            </template>
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
.pt__bar > i { position: absolute; inset: 0; border-radius: 3px; background: var(--ok); }
.pt__bar--short > i { background: var(--warn); }
/* the full-travel line (FULL_TRAVEL = 95%) */
.pt__bar::after { content: ''; position: absolute; left: 95%; top: -3px; bottom: -3px; width: 1px; background: var(--fg-3); }
.pt__pad > td { padding: 0; border: 0; }
.pt__empty { margin: var(--s-6) 0; text-align: center; font-size: var(--fs-label); color: var(--fg-3); }
.pt__sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
</style>
