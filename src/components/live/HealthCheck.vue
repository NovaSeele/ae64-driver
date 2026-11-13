<script setup lang="ts">
// Key check card (DESIGN C §3.5): counters, the keys that need attention as chips, notes, and the live region for the
// page's announcements. Display only: the page computes the view (keyCheck.ts) and owns the actions.
import { computed, ref, useId } from 'vue';
import { IconAlertTriangle, IconArrowBarToDown, IconArrowBarToUp, IconCircleCheck, IconInfoCircle, IconRestore } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import InfoTip from '../ui/InfoTip.vue';
import { useRovingFocus } from '../../composables/useRovingFocus';
import type { CheckIssue } from './keyCheck';
import { DEFAULT_RANGE_MM } from '../../stores/performance';
import { t } from '../../i18n/vi';
import { locale } from '../../i18n/locale';

const props = defineProps<{
  pressed: number;
  full: number;
  short: number;
  stuck: number;
  total: number;
  issues: CheckIssue[];
  estimated: boolean;
  /** The pinned key's name while only its row is read (pinned, "All keys" off); null otherwise. */
  partialKey: string | null;
  pinnedId: number | null;
  /** Text for the polite live region (the page batches announcements). */
  announcement?: string;
}>();
const emit = defineEmits<{ pin: [id: number]; restart: []; allKeys: [] }>();

const titleEl = ref<HTMLElement | null>(null);
const chipsEl = ref<HTMLElement | null>(null);
const attnId = useId();
const roving = useRovingFocus({ container: chipsEl, ids: () => props.issues.map((i) => i.id), orientation: 'both' });

const mm = (v: number) => v.toFixed(2);
type Chip = CheckIssue & { before: string; after: string; label: string };
/** The chip of an issue object: the page keeps an unchanged issue's object, so its chip is reused and not re-rendered. */
let chipOf = new WeakMap<CheckIssue, Chip>();
let chipLocale = locale.value;
const chips = computed(() => {
  if (chipLocale !== locale.value) { chipLocale = locale.value; chipOf = new WeakMap(); }
  return props.issues.map((i) => {
    let c = chipOf.get(i);
    if (!c) { c = makeChip(i); chipOf.set(i, c); }
    return c;
  });
});
function makeChip(i: CheckIssue): Chip {
  const text = i.kind === 'stuck'
    ? t('live.chipStuck', { key: '\u0000', mm: mm(i.mm) })
    : t('live.chipShort', { key: '\u0000', mm: mm(i.mm), range: mm(i.range) });
  const [before, after] = text.split('\u0000');
  const label = i.kind === 'stuck'
    ? t('live.chipStuckLabel', { key: i.name, mm: mm(i.mm) })
    : t('live.chipShortLabel', { key: i.name, mm: mm(i.mm), range: mm(i.range) });
  return { ...i, before, after, label };
}

function restart(): void {
  emit('restart');
  titleEl.value?.focus();
}

/** Focus the card title (the page's ?check=1 entry), without scrolling: the page scrolls itself. */
function focusTitle(): void {
  titleEl.value?.focus({ preventScroll: true });
}
defineExpose({ focusTitle, titleEl });
</script>

<template>
  <Card class="hc" :subtitle="t('live.checkSub')">
    <template #title><span ref="titleEl" class="hc__title" tabindex="-1">{{ t('live.check') }}</span><InfoTip :text="t('live.checkInfo')" /></template>
    <template #actions>
      <Button variant="ghost" size="sm" :icon="IconRestore" :disabled="pressed === 0" :title="t('live.restartCheckHint')" @click="restart">{{ t('live.restartCheck') }}</Button>
    </template>
    <dl class="hc__stats">
      <div><dt>{{ t('live.cPressed') }}</dt><dd :class="{ 'is-zero': !pressed }">{{ pressed }}<small>/{{ total }}</small></dd></div>
      <div><dt>{{ t('live.cFull') }}</dt><dd :class="full ? 'is-ok' : 'is-zero'">{{ full }}</dd></div>
      <div><dt>{{ t('live.cShort') }}</dt><dd :class="short ? 'is-warn' : 'is-zero'">{{ short }}</dd></div>
      <div><dt>{{ t('live.cStuck') }}</dt><dd :class="stuck ? 'is-danger' : 'is-zero'">{{ stuck }}</dd></div>
    </dl>
    <div v-if="chips.length" class="hc__attn">
      <span :id="attnId" class="micro">{{ t('live.attention') }}</span>
      <ul ref="chipsEl" class="hc__chips" :aria-labelledby="attnId">
        <li v-for="c in chips" :key="c.id" v-memo="[c, c.id === pinnedId, roving.tabindex(c.id)]">
          <button
            type="button"
            class="hc__chip"
            :class="`hc__chip--${c.kind}`"
            :data-rid="c.id"
            :tabindex="roving.tabindex(c.id)"
            :aria-label="c.label"
            :aria-current="c.id === pinnedId ? 'true' : undefined"
            @focus="roving.onFocus(c.id)"
            @keydown="roving.onKeydown($event, c.id)"
            @click="emit('pin', c.id)"
          >
            <IconArrowBarToUp v-if="c.kind === 'stuck'" :size="14" stroke-width="1.8" aria-hidden="true" />
            <IconArrowBarToDown v-else :size="14" stroke-width="1.8" aria-hidden="true" />
            <span>{{ c.before }}<b>{{ c.name }}</b>{{ c.after }}</span>
          </button>
        </li>
      </ul>
    </div>
    <p v-else-if="pressed" class="hc__ok" role="status">
      <IconCircleCheck :size="16" stroke-width="1.8" aria-hidden="true" />
      <span>{{ pressed === total ? t('live.checkAllOk', { n: total }) : t('live.checkOk') }}</span>
    </p>
    <p v-else class="hc__empty">{{ t('live.checkEmpty') }}</p>
    <p v-if="partialKey" class="hc__note hc__note--warn">
      <IconAlertTriangle :size="16" stroke-width="1.8" aria-hidden="true" />
      <span>{{ t('live.checkPartial', { key: partialKey }) }}</span>
      <Button variant="ghost" size="sm" @click="emit('allKeys')">{{ t('live.allKeys') }}</Button>
    </p>
    <p v-if="estimated" class="hc__note">
      <IconInfoCircle :size="14" stroke-width="1.8" aria-hidden="true" />
      <span>{{ t('live.checkEstimated', { mm: DEFAULT_RANGE_MM.toFixed(2) }) }}</span>
    </p>
    <span class="hc__live" aria-live="polite">{{ announcement }}</span>
  </Card>
</template>

<style scoped>
.hc :deep(.card__title) { display: inline-flex; align-items: center; gap: 4px; }
.hc__title { outline: none; border-radius: 4px; }
.hc__title:focus-visible { box-shadow: var(--focus-ring); }

.hc__stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 1px;
  margin: 0;
  border-radius: var(--r-card);
  overflow: hidden;
  background: var(--line-1);
  border: 1px solid var(--line-1);
}
/* number on top, caption under it (the DOM keeps dt before dd): captions may wrap without moving the numbers out of line */
.hc__stats > div { background: var(--bg-2); padding: var(--s-3) var(--s-4); display: flex; flex-direction: column-reverse; justify-content: flex-end; gap: 4px; min-width: 0; }
.hc__stats dt { font-size: var(--fs-caption); color: var(--fg-3); }
.hc__stats dd { margin: 0; font-size: var(--fs-hero); font-weight: 600; letter-spacing: -0.01em; line-height: 1.1; font-variant-numeric: tabular-nums; }
.hc__stats dd small { margin-left: 2px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-3); letter-spacing: 0; }
.hc__stats .is-ok { color: var(--ok); }
.hc__stats .is-warn { color: var(--warn); }
.hc__stats .is-danger { color: var(--danger); }
.hc__stats .is-zero { color: var(--fg-3); }

.hc__attn { display: flex; flex-direction: column; gap: var(--s-2); }
.hc__chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 0; padding: 2px; list-style: none; max-height: 96px; overflow-y: auto; }
.hc__chip {
  display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 9px 0 7px;
  font: inherit; font-size: var(--fs-label); color: var(--fg-2); white-space: nowrap; cursor: pointer;
  background: var(--bg-3); border: 1px solid var(--line-2); border-radius: var(--r-control);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.hc__chip b { color: var(--fg-1); font-weight: 600; }
.hc__chip svg { flex: none; }
.hc__chip--short svg { color: var(--warn); }
.hc__chip--stuck svg { color: var(--danger); }
.hc__chip--stuck { border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
.hc__chip:hover { background: var(--bg-4); }
.hc__chip[aria-current='true'] { border-color: var(--acc); }

.hc__ok, .hc__note--warn {
  display: flex; align-items: center; gap: var(--s-2); margin: 0;
  padding: var(--s-2) var(--s-3); border-radius: var(--r-control); font-size: var(--fs-label);
}
/* text stays --fg-1: --ok on --ok-soft is only 3.3:1 in the light themes; the icon carries the colour */
.hc__ok { background: var(--ok-soft); color: var(--fg-1); font-weight: 500; }
.hc__ok svg { color: var(--ok); flex: none; }
.hc__empty { margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.hc__note { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.hc__note svg { flex: none; margin-top: 2px; }
.hc__note--warn { background: var(--warn-soft); color: var(--fg-1); align-items: center; }
.hc__note--warn svg { color: var(--warn); margin-top: 0; }
.hc__note--warn > :deep(.btn) { margin-left: auto; flex: none; }
.hc__live { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .hc__chip { transition: none; } }
</style>
