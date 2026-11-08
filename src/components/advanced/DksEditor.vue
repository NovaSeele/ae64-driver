<script setup lang="ts">
// Dynamic Keystroke editor: 4 output rows × 7 lifecycle cells (P1–S–P2–S–R2–S–R1), click-drag painting,
// connected held regions, Min/Max travel thresholds (0.1–3.3 mm). Masks are normalised per reference dks.js.
import { computed, onBeforeUnmount, ref } from 'vue';
import Slider from '../ui/Slider.vue';
import NumberField from '../ui/NumberField.vue';
import Dialog from '../ui/Dialog.vue';
import OutputSlot from './OutputSlot.vue';
import OutputPicker from './OutputPicker.vue';
import { DKS_CELLS, DKS_FULL_HOLD, DKS_TRAVEL, dksCellActive, dksGroups, normalizeDksDbs, setDksCell } from '../../stores/advanced';
import type { DksAssignment } from '../../stores/advanced';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';

const props = defineProps<{ modelValue: DksAssignment; firmware?: string }>();
const emit = defineEmits<{ 'update:modelValue': [DksAssignment] }>();

// Neutral / accent hues only: warn and danger colours would make painted cells look like errors.
const ROW_COLORS = ['var(--acc)', 'var(--info)', 'var(--fg-1)', 'var(--fg-3)'];
const CELL_TEXT: { label: string; title: MessageKey; span: boolean }[] = [
  { label: 'P1', title: 'advanced.dksCellP1', span: false },
  { label: 'S', title: 'advanced.dksCellS1', span: true },
  { label: 'P2', title: 'advanced.dksCellP2', span: false },
  { label: 'S', title: 'advanced.dksCellS2', span: true },
  { label: 'R2', title: 'advanced.dksCellR2', span: false },
  { label: 'S', title: 'advanced.dksCellS3', span: true },
  { label: 'R1', title: 'advanced.dksCellR1', span: false },
];

const groups = computed(() => dksGroups(props.firmware));
const pickerRow = ref<number | null>(null);
const pickerOpen = computed({ get: () => pickerRow.value !== null, set: (v) => { if (!v) pickerRow.value = null; } });
let paint: { row: number; on: boolean } | null = null;

function update(patch: Partial<DksAssignment>) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}
function setCell(row: number, cell: number, on: boolean) {
  const travels = [...props.modelValue.travels] as DksAssignment['travels'];
  const next = setDksCell(travels[row], cell, on);
  if (next === travels[row]) return;
  travels[row] = next;
  update({ travels });
}
function onCellDown(e: PointerEvent, row: number, cell: number) {
  if (!props.modelValue.keycodes[row] || e.button !== 0) return;
  e.preventDefault();
  paint = { row, on: !dksCellActive(props.modelValue.travels[row], cell) };
  setCell(row, cell, paint.on);
}
function onCellEnter(e: PointerEvent, row: number, cell: number) {
  if (paint && paint.row === row && e.buttons === 1) setCell(row, cell, paint.on);
}
function endPaint() { paint = null; }
const END_EVENTS = ['pointerup', 'pointercancel', 'blur'] as const;
for (const ev of END_EVENTS) window.addEventListener(ev, endPaint);
onBeforeUnmount(() => { for (const ev of END_EVENTS) window.removeEventListener(ev, endPaint); });

function onCellKey(e: KeyboardEvent, row: number, cell: number) {
  if (e.key !== ' ' && e.key !== 'Enter') return;
  e.preventDefault();
  setCell(row, cell, !dksCellActive(props.modelValue.travels[row], cell));
}

function pick(code: number) {
  const row = pickerRow.value!;
  const keycodes = [...props.modelValue.keycodes] as DksAssignment['keycodes'];
  const travels = [...props.modelValue.travels] as DksAssignment['travels'];
  keycodes[row] = code;
  if (!travels[row]) travels[row] = DKS_FULL_HOLD; // a fresh output starts held through the whole press
  update({ keycodes, travels });
  pickerRow.value = null;
}
function clearRow(row = pickerRow.value!) {
  const keycodes = [...props.modelValue.keycodes] as DksAssignment['keycodes'];
  const travels = [...props.modelValue.travels] as DksAssignment['travels'];
  keycodes[row] = 0;
  travels[row] = 0;
  update({ keycodes, travels });
  pickerRow.value = null;
}

function setDb(i: 0 | 1, v: number) {
  const dbs: [number, number] = [...props.modelValue.dbs];
  dbs[i] = v;
  // Keep the other threshold 0.1 mm away instead of refusing the drag.
  if (i === 0 && dbs[0] >= dbs[1]) dbs[1] = Math.min(DKS_TRAVEL.max, dbs[0] + DKS_TRAVEL.step);
  if (i === 1 && dbs[1] <= dbs[0]) dbs[0] = Math.max(DKS_TRAVEL.min, dbs[1] - DKS_TRAVEL.step);
  update({ dbs: normalizeDksDbs(dbs) });
}

const cellOn = (row: number, cell: number) => cell >= 0 && cell < DKS_CELLS.length && dksCellActive(props.modelValue.travels[row], cell);
const fmt = (v: number) => v.toFixed(1);
</script>

<template>
  <div class="dks">
    <section class="dks__thresholds">
      <div class="th">
        <div class="th__row">
          <span class="th__label"><b class="th__tag">P1 · R1</b>{{ t('advanced.dksMin') }}</span>
          <NumberField :model-value="modelValue.dbs[0]" :min="DKS_TRAVEL.min" :max="DKS_TRAVEL.max - DKS_TRAVEL.step" :step="0.1" :decimals="1" :label="t('advanced.dksMin')" @update:model-value="setDb(0, $event)" />
        </div>
        <Slider :model-value="modelValue.dbs[0]" :min="DKS_TRAVEL.min" :max="DKS_TRAVEL.max" :step="0.1" :fine-step="0.1" :label="t('advanced.dksMin')" @update:model-value="setDb(0, $event)" />
      </div>
      <div class="th">
        <div class="th__row">
          <span class="th__label"><b class="th__tag">P2 · R2</b>{{ t('advanced.dksMax') }}</span>
          <NumberField :model-value="modelValue.dbs[1]" :min="DKS_TRAVEL.min + DKS_TRAVEL.step" :max="DKS_TRAVEL.max" :step="0.1" :decimals="1" :label="t('advanced.dksMax')" @update:model-value="setDb(1, $event)" />
        </div>
        <Slider :model-value="modelValue.dbs[1]" :min="DKS_TRAVEL.min" :max="DKS_TRAVEL.max" :step="0.1" :fine-step="0.1" :label="t('advanced.dksMax')" @update:model-value="setDb(1, $event)" />
      </div>
    </section>

    <section class="tl" :aria-label="t('advanced.dksTimeline')" @lostpointercapture="endPaint">
      <div class="tl__phases">
        <span />
        <span class="tl__phase tl__phase--down">{{ t('advanced.dksPress') }}</span>
        <span class="tl__phase tl__phase--turn">{{ t('advanced.dksBottom') }}</span>
        <span class="tl__phase tl__phase--up">{{ t('advanced.dksRelease') }}</span>
      </div>
      <div class="tl__head">
        <span />
        <span v-for="(c, i) in CELL_TEXT" :key="i" class="tl__col" :class="{ 'tl__col--span': c.span }">
          <b>{{ c.label }}</b>
          <small v-if="i === 0 || i === 6" class="num">{{ fmt(modelValue.dbs[0]) }} mm</small>
          <small v-else-if="i === 2 || i === 4" class="num">{{ fmt(modelValue.dbs[1]) }} mm</small>
        </span>
      </div>
      <template v-for="row in 4" :key="row">
      <div class="tl__row" :style="{ '--row-acc': ROW_COLORS[row - 1] }">
        <OutputSlot
          :code="modelValue.keycodes[row - 1]"
          :caption="t('advanced.dksAction', { n: row })"
          :accent="ROW_COLORS[row - 1]"
          @click="pickerRow = row - 1"
        />
        <div class="tl__cells" :class="{ 'tl__cells--off': !modelValue.keycodes[row - 1] }">
          <button
            v-for="(c, i) in CELL_TEXT"
            :key="i"
            type="button"
            class="cell"
            :class="{
              'cell--span': c.span,
              'cell--on': cellOn(row - 1, i),
              'cell--joinL': cellOn(row - 1, i) && cellOn(row - 1, i - 1),
              'cell--joinR': cellOn(row - 1, i) && cellOn(row - 1, i + 1),
            }"
            :aria-pressed="cellOn(row - 1, i)"
            :aria-label="`${t('advanced.dksAction', { n: row })}: ${c.label} ${t(c.title)}`"
            :title="t(c.title)"
            :disabled="!modelValue.keycodes[row - 1]"
            @pointerdown="onCellDown($event, row - 1, i)"
            @pointerenter="onCellEnter($event, row - 1, i)"
            @keydown="onCellKey($event, row - 1, i)"
          >
            <span class="cell__mark" />
          </button>
        </div>
      </div>
      <p v-if="modelValue.keycodes[row - 1] && !modelValue.travels[row - 1]" class="tl__warn">{{ t('advanced.dksUnpainted') }}</p>
      </template>
      <p class="tl__hint">
        <span class="legend"><i class="legend__event" />{{ t('advanced.dksEvent') }}</span>
        <span class="legend"><i class="legend__span" />{{ t('advanced.dksSpan') }}</span>
        <span>{{ t('advanced.dksTimelineHint') }}</span>
      </p>
    </section>

    <Dialog v-model:open="pickerOpen" :title="t('advanced.pickerTitle')" :width="620">
      <OutputPicker
        v-if="pickerRow !== null"
        :groups="groups"
        :current="modelValue.keycodes[pickerRow]"
        :note="t('advanced.pickerOnly', { type: 'DKS' })"
        :clear-label="t('advanced.clearOutput')"
        @pick="pick"
        @clear="clearRow()"
      />
    </Dialog>
  </div>
</template>

<style scoped>
.dks { display: flex; flex-direction: column; gap: var(--s-5); }
.dks__thresholds { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-5); }
.th { display: flex; flex-direction: column; gap: var(--s-2); }
.th__row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.th__label { display: flex; align-items: center; gap: var(--s-2); color: var(--fg-2); }
.th__tag { font-size: var(--fs-caption); font-weight: 600; color: var(--fg-3); padding: 2px 6px; border-radius: 4px; background: var(--bg-3); }
.th__row :deep(.nf) { width: 120px; }

.tl {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: var(--s-4);
  border-radius: var(--r-card);
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  user-select: none;
}
.tl__head, .tl__row { display: grid; grid-template-columns: 124px repeat(7, minmax(44px, 1fr)); align-items: center; }
.tl__phases { display: grid; grid-template-columns: 124px 3fr 1fr 3fr; align-items: end; }
.tl__phase {
  margin: 0 6px;
  text-align: center;
  font-size: var(--fs-caption);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--fg-3);
  padding-bottom: 4px;
  border-bottom: 1px solid var(--line-2);
}
.tl__phase--turn { color: var(--fg-2); }
.tl__col { display: flex; flex-direction: column; align-items: center; gap: 1px; min-height: 30px; }
.tl__col b { font-size: var(--fs-label); color: var(--fg-1); }
.tl__col--span b { color: var(--fg-3); font-weight: 500; }
.tl__col small { font-size: 10px; color: var(--fg-3); }
.tl__row { min-height: 48px; }
.tl__row :deep(.os) { min-width: 0; width: 112px; }
.tl__cells { display: contents; }

.cell {
  position: relative;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  background: transparent;
  cursor: pointer;
  touch-action: none;
}
.cell::before {
  /* the faint track the whole row sits on */
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 50%;
  height: 2px;
  transform: translateY(-50%);
  background: var(--line-2);
}
.cell:disabled { cursor: not-allowed; }
.tl__cells--off .cell::before { background: var(--line-1); }
.cell__mark {
  position: relative;
  width: 22px;
  height: 22px;
  border-radius: 6px;
  border: 1.5px solid var(--line-3);
  background: var(--bg-2);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), width var(--t-fast) var(--ease), border-radius var(--t-fast) var(--ease);
}
.cell--span .cell__mark { width: 70%; height: 10px; border-radius: 5px; }
.cell:hover:not(:disabled) .cell__mark { border-color: var(--row-acc); }
.tl__cells--off .cell__mark { opacity: 0.35; }
.cell--on .cell__mark { background: var(--row-acc); border-color: var(--row-acc); box-shadow: 0 0 12px color-mix(in srgb, var(--row-acc) 35%, transparent); }
.cell--on.cell--span .cell__mark { height: 12px; }
/* Connected held region: active neighbours merge into one continuous bar. */
.cell--joinL .cell__mark, .cell--joinR .cell__mark { width: 100%; height: 12px; border-radius: 0; }
.cell--joinL:not(.cell--joinR) .cell__mark { border-radius: 0 6px 6px 0; width: calc(50% + 11px); margin-right: auto; margin-left: 0; }
.cell--joinR:not(.cell--joinL) .cell__mark { border-radius: 6px 0 0 6px; width: calc(50% + 11px); margin-left: auto; margin-right: 0; }
.cell--joinL:not(.cell--joinR) { justify-content: flex-start; }
.cell--joinR:not(.cell--joinL) { justify-content: flex-end; }
.cell--on:not(.cell--span) .cell__mark::after {
  /* event cells keep a visible dot even inside a held bar */
  content: '';
  position: absolute;
  top: 50%;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-0);
  transform: translate(-50%, -50%);
  left: 50%;
}
.cell--joinL:not(.cell--joinR):not(.cell--span) .cell__mark::after { left: calc(100% - 11px); }
.cell--joinR:not(.cell--joinL):not(.cell--span) .cell__mark::after { left: 11px; }

.tl__warn { margin: 0 0 0 124px; color: var(--warn); font-size: var(--fs-label); }
.tl__hint { display: flex; flex-wrap: wrap; gap: var(--s-4); margin-top: var(--s-2); color: var(--fg-3); font-size: var(--fs-label); }
.legend { display: inline-flex; align-items: center; gap: 6px; }
.legend__event { width: 12px; height: 12px; border-radius: 3px; border: 1.5px solid var(--fg-3); }
.legend__span { width: 18px; height: 6px; border-radius: 3px; border: 1.5px solid var(--fg-3); }

@media (max-width: 1100px) {
  .dks__thresholds { grid-template-columns: 1fr; }
}
</style>
