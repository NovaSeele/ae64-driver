<script lang="ts">
/**
 * One entry of the keycap legend ("Keycap: …", DESIGN B §3.2). A glyph or sample is drawn the way the keycap draws it
 * (same character, same tone), followed by " = " and its meaning.
 */
export type LegendItem =
  | { text: string; tone?: string }
  | { glyph: string; tone?: string; text: string }
  | { sample: 'flag' | 'bar' | 'lock'; label: string; colors?: string[]; tone?: string; text: string };
</script>

<script setup lang="ts">
// Selection bar under the keyboard: the count (or the page's lead), the keycap legend (or the page's detail), the
// how-to-select line, and the quick-select buttons. Selecting keys is UI state only: nothing here talks to the keyboard.
// The bar measures itself and picks the first layout that fits (selectionFit.ts); the buttons never wrap.
import { computed, nextTick, onBeforeUnmount, onMounted, onUpdated, ref, useId, useSlots, watch } from 'vue';
import { IconLock } from '@tabler/icons-vue';
import { useSelectionStore } from '../../stores/selection';
import type { GroupMode } from '../../stores/selection';
import type { KeyGroup } from '../../data/keyGroups';
import Button from '../ui/Button.vue';
import InfoTip from '../ui/InfoTip.vue';
import Tooltip from '../ui/Tooltip.vue';
import { FIT_CLASSES, pickFit } from './selectionFit';
import type { Fit } from './selectionFit';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';

const props = defineProps<{
  /** The keycap legend; undefined = none (the page is loading or failed to read). */
  shows?: LegendItem[];
  /** How to select keys; defaults to sel.hint. */
  hint?: string;
  /** The page's own sentence, first in the (i) (Performance: what the scope means). */
  tip?: string;
}>();
const slots = useSlots();
const sel = useSelectionStore();
const uid = useId();

const hintText = computed(() => props.hint ?? t('sel.hint'));
const tipText = computed(() => [props.tip, hintText.value].filter(Boolean).join(' '));

const GROUPS: { key: KeyGroup; fn: 'wasd' | 'letters' | 'digits' | 'modifiers'; label: MessageKey; tip: MessageKey; tipPos: MessageKey }[] = [
  { key: 'wasd', fn: 'wasd', label: 'sel.wasd', tip: 'sel.tipWasd', tipPos: 'sel.tipWasdPos' },
  { key: 'letters', fn: 'letters', label: 'sel.letters', tip: 'sel.tipLetters', tipPos: 'sel.tipLettersPos' },
  { key: 'digits', fn: 'digits', label: 'sel.digits', tip: 'sel.tipDigits', tipPos: 'sel.tipDigitsPos' },
  { key: 'mods', fn: 'modifiers', label: 'sel.mods', tip: 'sel.tipMods', tipPos: 'sel.tipModsPos' },
];
const groupButtons = computed(() => GROUPS.map((g) => {
  const n = sel.groups[g.key].length;
  const tip = n === 0
    ? t('sel.groupEmpty')
    : `${t(sel.groups.source === 'keymap' ? g.tip : g.tipPos, { n })} ${t('sel.addHint')}`;
  return { ...g, n, tip, descId: `${uid}-${g.key}` };
}));

/** Ctrl / ⌘ / Shift add the group to the selection, like Ctrl/Shift-click on a key. */
function pick(g: { fn: 'wasd' | 'letters' | 'digits' | 'modifiers'; n: number }, e: MouseEvent | KeyboardEvent): void {
  if (!g.n) return; // aria-disabled: the button keeps its focus and tooltip, a press does nothing
  const mode: GroupMode = e.ctrlKey || e.metaKey || e.shiftKey ? 'add' : 'replace';
  sel[g.fn](mode);
}

const isGlyph = (i: LegendItem): i is { glyph: string; tone?: string; text: string } => 'glyph' in i;
const isSample = (i: LegendItem): i is { sample: 'flag' | 'bar' | 'lock'; label: string; colors?: string[]; tone?: string; text: string } => 'sample' in i;
/** The legend read once by a screen reader, and its title. */
const plain = computed(() => props.shows
  ? `${t('sel.shows')}: ${props.shows.map((i) => (isGlyph(i) ? `${i.glyph} = ${i.text}` : isSample(i) ? `${i.label} = ${i.text}` : i.text)).join(' · ')}`
  : '');
const barGradient = (colors: string[] = []) => (colors.length > 1
  ? `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${(i / colors.length) * 100}% ${((i + 1) / colors.length) * 100}%`).join(', ')})`
  : colors[0] ?? 'var(--fg-3)');

// ------------------------------------------------------------------ fit (§3.3)
const root = ref<HTMLElement | null>(null);
const fit = ref<Fit>(2);
const ALL_FIT = ['sb--hint', 'sb--compact', 'sb--stack'];

/** Measures the natural widths, picks the layout and sets its classes. The classes are set on the element directly (not
 *  bound in the template), so the measuring can toggle them without a re-render. jsdom has no layout: nothing to do. */
function measure(): void {
  const sb = root.value;
  if (!sb) return;
  sb.classList.remove(...ALL_FIT);
  const bar = sb.clientWidth;
  if (!bar) return;
  const q = (s: string) => sb.querySelector<HTMLElement>(s);
  const mid = q(':scope > .sb__shows') ?? q(':scope > .sb__detail');
  const leadEl = q(':scope > .sb__lead');
  const lead = leadEl?.offsetWidth ?? 0;
  const tip = (q('.sb__tip')?.offsetWidth ?? 0) + 4;
  sb.classList.add('sb--hint');
  const hint = q(':scope > .sb__hint')?.scrollWidth ?? 0;
  sb.classList.remove('sb--hint');
  sb.classList.add('sb--compact');
  const leadCompact = leadEl?.offsetWidth ?? 0;
  sb.classList.remove('sb--compact');
  const next = pickFit({
    bar, lead, leadCompact, tip, hint, gap: 12, actions: q(':scope > .sb__actions')?.offsetWidth ?? 0,
    middle: mid?.scrollWidth ?? 0, detail: !!mid?.classList.contains('sb__detail'),
  });
  sb.classList.add(...FIT_CLASSES[next]);
  sb.dataset.fit = String(next);
  fit.value = next;
}

let ro: ResizeObserver | null = null;
let lastWidth = -1;
let queued = false;
function schedule(): void {
  if (queued) return;
  queued = true;
  void nextTick(() => { queued = false; measure(); });
}
onMounted(() => {
  measure();
  void document.fonts?.ready.then(() => measure());
  if (typeof ResizeObserver !== 'undefined' && root.value) {
    ro = new ResizeObserver((entries) => {
      const w = Math.round(entries[0]?.contentRect.width ?? 0);
      if (w === lastWidth) return; // only a width change can change the layout
      lastWidth = w;
      schedule();
    });
    ro.observe(root.value);
  }
});
onBeforeUnmount(() => ro?.disconnect());
// The legend, the hint, the tip, the count and the slots' content all change natural widths.
watch(() => [plain.value, hintText.value, props.tip, sel.count], schedule);
onUpdated(schedule);
defineExpose({ fit, measure });
</script>

<template>
  <div ref="root" class="sb">
    <div class="sb__lead">
      <slot name="lead">
        <span class="sb__count" :class="{ 'sb__count--on': sel.count > 0 }" aria-live="polite">
          <span class="num">{{ sel.count ? t('sel.count', { n: sel.count }) : t('sel.none') }}</span>
        </span>
      </slot>
      <InfoTip class="sb__tip" :text="tipText" />
    </div>
    <span v-if="slots.detail || shows" class="sb__div" aria-hidden="true" />
    <div v-if="slots.detail" class="sb__detail"><slot name="detail" /></div>
    <p v-else-if="shows" class="sb__shows" :title="plain">
      <span class="sr-only">{{ plain }}</span>
      <span aria-hidden="true"><span class="sb__k">{{ t('sel.shows') }}:</span><template v-for="(item, i) in shows" :key="i"><span v-if="i" class="sb__dot">·</span><template v-if="isGlyph(item)"><b class="sb__g" :style="item.tone ? { '--tone': item.tone } : undefined">{{ item.glyph }}</b><span class="sb__eq"> = </span><span class="sb__t">{{ item.text }}</span></template><template v-else-if="isSample(item)"><span v-if="item.sample === 'flag'" class="sb__flag" /><span v-else-if="item.sample === 'bar'" class="sb__bar" :style="{ background: barGradient(item.colors) }" /><span v-else class="sb__icon" :style="item.tone ? { '--tone': item.tone } : undefined"><IconLock :size="12" stroke-width="1.8" /></span><span class="sb__eq"> = </span><span class="sb__t">{{ item.text }}</span></template><span v-else class="sb__t" :style="item.tone ? { '--tone': item.tone } : undefined">{{ item.text }}</span></template></span>
    </p>
    <span class="sb__hint">{{ hintText }}</span>
    <div class="sb__actions">
      <div class="sb__grp" role="group" :aria-label="t('sel.quickGroup')">
        <Tooltip v-for="g in groupButtons" :key="g.key" :text="g.tip">
          <Button
            size="sm" variant="ghost" :data-group="g.key" :aria-disabled="g.n === 0 || undefined" :aria-describedby="g.descId"
            @click="pick(g, $event)" @keydown.enter.prevent="pick(g, $event)"
          >{{ t(g.label) }}</Button>
        </Tooltip>
        <span v-for="g in groupButtons" :id="g.descId" :key="g.descId" class="sr-only">{{ g.tip }}</span>
      </div>
      <span class="sb__div" aria-hidden="true" />
      <div class="sb__grp" role="group" :aria-label="t('sel.wholeGroup')">
        <Button size="sm" variant="ghost" @click="sel.all()">{{ t('sel.all') }}</Button>
        <Button size="sm" variant="ghost" :disabled="!sel.count" @click="sel.clear()">{{ t('sel.clear') }}</Button>
        <Button size="sm" variant="ghost" @click="sel.invert()">{{ t('sel.invert') }}</Button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sb {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  min-height: 36px;
}
.sb__lead { display: flex; align-items: center; gap: var(--s-1); flex: none; }
.sb__div { flex: none; width: 1px; height: 16px; background: var(--line-2); }
.sb__count {
  flex: none;
  font-weight: 500;
  color: var(--fg-3);
  transition: color var(--t-fast) var(--ease);
}
.sb__count--on { color: var(--fg-1); }

/* the keycap legend (B4) */
.sb__shows {
  flex: 0 1 auto;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-label);
  line-height: 20px;
  color: var(--fg-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis; /* last resort only: a bar narrower than any supported size */
}
.sb__k { color: var(--fg-3); font-weight: 500; margin-right: 6px; }
.sb__dot { color: var(--fg-4); margin: 0 6px; }
.sb__t { color: var(--tone, var(--fg-2)); }
/* a glyph is drawn the way the keycap draws it: same character, same tone */
.sb__g { font-weight: 600; color: var(--tone, var(--fg-1)); font-variant-numeric: tabular-nums; }
.sb__eq { color: var(--fg-3); }
/* the keycap's "not calibrated" outline (Keycap .cap--flag: 1.5px dashed --warn) */
.sb__flag { display: inline-block; width: 14px; height: 12px; vertical-align: -1px; border-radius: 3px; outline: 1.5px dashed var(--warn); outline-offset: -1.5px; }
/* the switch-group LED bar (KeyboardView led-height 3) */
.sb__bar { display: inline-block; width: 16px; height: 3px; vertical-align: 3px; border-radius: 2px; }
/* the "unsupported mode" lock badge (Keycap .cap__badge--icon, the view's metric tone) */
.sb__icon { display: inline-flex; vertical-align: -1px; color: var(--tone, var(--fg-2)); }

/* the page's own detail takes the legend's place; it shortens instead of moving rows */
.sb__detail { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; }

/* the how-to-select line: inline only in fit 1, right-aligned next to the buttons it explains */
.sb__hint {
  display: none;
  flex: 0 1 auto;
  min-width: 0;
  margin-left: auto;
  color: var(--fg-4);
  font-size: var(--fs-label);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sb--hint .sb__hint { display: block; }
.sb--hint .sb__actions { margin-left: 0; }
.sb--hint .sb__tip { display: none; }
.sb--compact :deep(.sb__opt) { display: none; }

/* fit 4: the legend on its own row, left-aligned under the count */
.sb--stack { flex-wrap: wrap; row-gap: 0; }
.sb--stack > .sb__div { display: none; }
.sb--stack > .sb__shows { order: 9; flex: 1 0 100%; padding-bottom: 4px; }

/* the buttons: two labelled groups, never wrap, always right-aligned */
.sb__actions { display: flex; align-items: center; gap: 2px; flex: none; margin-left: auto; }
.sb__grp { display: flex; gap: 2px; }
.sb__actions > .sb__div { margin: 0 var(--s-2); }
.sb__grp .btn[aria-disabled='true'] { opacity: 0.45; cursor: not-allowed; }

/* Performance's own lead keeps its classes */
.sb :deep(.scope) { flex: none; }
</style>
