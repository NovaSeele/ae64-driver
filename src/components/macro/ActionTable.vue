<script setup lang="ts">
// Macro action rows: drag handle (reorder), index, key (restricted picker), Nhấn/Nhả, delay (1–32767 ms),
// insert-below and delete. Emits a whole new list on every change.
import { computed, nextTick, ref } from 'vue';
import { IconArrowDown, IconArrowUp, IconChevronDown, IconChevronUp, IconGripVertical, IconRowInsertBottom, IconTrash } from '@tabler/icons-vue';
import NumberField from '../ui/NumberField.vue';
import IconButton from '../ui/IconButton.vue';
import Dialog from '../ui/Dialog.vue';
import OutputSlot from '../advanced/OutputSlot.vue';
import OutputPicker from '../advanced/OutputPicker.vue';
import { keyboardGroups } from '../../stores/advanced';
import { MACRO_DELAY_MAX, MACRO_DELAY_MIN } from '../../stores/macro';
import type { MacroAction } from '../../protocol';
import { t } from '../../i18n/vi';

const props = defineProps<{ actions: MacroAction[]; disabled?: boolean; canInsert: boolean; warnings: Set<number> }>();
const emit = defineEmits<{ update: [MacroAction[]] }>();

const groups = keyboardGroups();
const pickRow = ref<number | null>(null);
const pickOpen = computed({ get: () => pickRow.value !== null, set: (v) => { if (!v) pickRow.value = null; } });
const dragFrom = ref<number | null>(null);
const dropAt = ref<number | null>(null);
const root = ref<HTMLElement | null>(null);

function patch(i: number, p: Partial<MacroAction>) {
  emit('update', props.actions.map((a, j) => (j === i ? { ...a, ...p } : a)));
}
function insertBelow(i: number) {
  const src = props.actions[i];
  const next = [...props.actions];
  next.splice(i + 1, 0, { keycode: src.keycode, down: !src.down, delay: 30 });
  emit('update', next);
}
function remove(i: number) {
  emit('update', props.actions.filter((_, j) => j !== i));
}
function move(from: number, to: number) {
  if (from === to || to < 0 || to > props.actions.length) return;
  const next = [...props.actions];
  const [a] = next.splice(from, 1);
  next.splice(to > from ? to - 1 : to, 0, a);
  emit('update', next);
}
/** Keyboard reorder: swap with the neighbour and keep focus on the same item's move button. */
function step(i: number, dir: -1 | 1) {
  const to = i + dir;
  if (to < 0 || to >= props.actions.length) return;
  move(i, dir < 0 ? to : to + 1);
  void nextTick(() => {
    const row = root.value?.querySelectorAll('.row')[to];
    const want = row?.querySelector<HTMLButtonElement>(`[data-move="${dir}"]`);
    (want && !want.disabled ? want : row?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)'))?.focus();
  });
}
function pick(code: number) {
  patch(pickRow.value!, { keycode: code });
  pickRow.value = null;
}

function onDragStart(e: DragEvent, i: number) {
  dragFrom.value = i;
  e.dataTransfer?.setData('text/plain', String(i));
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
}
function onDragOver(e: DragEvent, i: number) {
  if (dragFrom.value === null) return;
  e.preventDefault();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  dropAt.value = e.clientY < r.top + r.height / 2 ? i : i + 1;
}
function onDrop(e: DragEvent) {
  e.preventDefault();
  if (dragFrom.value !== null && dropAt.value !== null) move(dragFrom.value, dropAt.value);
  endDrag();
}
function endDrag() {
  dragFrom.value = null;
  dropAt.value = null;
}
</script>

<template>
  <div ref="root" class="at" role="table" :aria-label="t('macro.table')">
    <div class="at__in">
    <div class="at__head" role="row">
      <span role="columnheader" aria-hidden="true" />
      <span class="micro" role="columnheader">#</span>
      <span class="micro" role="columnheader">{{ t('macro.colKey') }}</span>
      <span class="micro" role="columnheader">{{ t('macro.colDir') }}</span>
      <span class="micro" role="columnheader">{{ t('macro.colDelay') }}</span>
      <span role="columnheader" class="sr-only">{{ t('macro.insert') }} / {{ t('macro.remove') }}</span>
    </div>
    <TransitionGroup name="row" tag="div" class="at__body" role="rowgroup">
      <div
        v-for="(a, i) in actions"
        :key="i"
        role="row"
        class="row"
        :class="{
          'row--drag': dragFrom === i,
          'row--dropBefore': dropAt === i && dragFrom !== null,
          'row--dropAfter': dropAt === i + 1 && i === actions.length - 1 && dragFrom !== null,
          'row--warn': warnings.has(i),
          'row--down': a.down,
        }"
        @dragover="onDragOver($event, i)"
        @drop="onDrop"
      >
        <span
          class="row__grip"
          role="cell"
          :draggable="!disabled"
          :title="t('macro.drag')"
          :aria-label="t('macro.drag')"
          @dragstart="onDragStart($event, i)"
          @dragend="endDrag"
        >
          <IconGripVertical :size="16" stroke-width="1.6" />
        </span>
        <span class="row__idx num" role="cell">{{ String(i + 1).padStart(2, '0') }}</span>
        <div class="cell" role="cell"><OutputSlot :code="a.keycode" :accent="a.down ? 'var(--acc)' : 'var(--fg-4)'" :disabled="disabled" @click="pickRow = i" /></div>
        <div class="cell" role="cell"><div class="dir" role="radiogroup" :aria-label="t('macro.colDir')">
          <button type="button" role="radio" class="dir__opt" :aria-checked="a.down" :disabled="disabled" @click="patch(i, { down: true })">
            <IconArrowDown :size="13" stroke-width="2" />{{ t('macro.down') }}
          </button>
          <button type="button" role="radio" class="dir__opt" :aria-checked="!a.down" :disabled="disabled" @click="patch(i, { down: false })">
            <IconArrowUp :size="13" stroke-width="2" />{{ t('macro.up') }}
          </button>
        </div></div>
        <div class="cell" role="cell"><NumberField
          :model-value="a.delay"
          :min="MACRO_DELAY_MIN"
          :max="MACRO_DELAY_MAX"
          :step="10"
          :decimals="0"
          unit="ms"
          :label="`${t('macro.colDelay')} ${i + 1}`"
          :disabled="disabled"
          @update:model-value="patch(i, { delay: Math.round($event) })"
        /></div>
        <span class="row__acts" role="cell">
          <IconButton :icon="IconChevronUp" :label="t('macro.moveUp')" size="sm" data-move="-1" :disabled="disabled || i === 0" @click="step(i, -1)" />
          <IconButton :icon="IconChevronDown" :label="t('macro.moveDown')" size="sm" data-move="1" :disabled="disabled || i === actions.length - 1" @click="step(i, 1)" />
          <IconButton :icon="IconRowInsertBottom" :label="t('macro.insert')" size="sm" :disabled="disabled || !canInsert" @click="insertBelow(i)" />
          <IconButton :icon="IconTrash" :label="t('macro.remove')" size="sm" :disabled="disabled" @click="remove(i)" />
        </span>
      </div>
    </TransitionGroup>
    </div>

    <Dialog v-model:open="pickOpen" :title="pickRow !== null ? t('macro.pickKey', { n: pickRow + 1 }) : ''" :width="620">
      <OutputPicker v-if="pickRow !== null" :groups="groups" :current="actions[pickRow]?.keycode" :note="t('macro.pickerOnly')" @pick="pick" />
    </Dialog>
  </div>
</template>

<style scoped>
.at { overflow-x: auto; }
.at__in { display: flex; flex-direction: column; min-width: 720px; }
.at__head, .row { display: grid; grid-template-columns: 24px 32px 140px 150px 150px 1fr; gap: var(--s-3); align-items: center; }
.at__head { padding: 0 var(--s-3) var(--s-2); color: var(--fg-3); border-bottom: 1px solid var(--line-1); }
.at__body { display: flex; flex-direction: column; max-height: 460px; overflow-y: auto; padding: 4px 0; }
.row {
  position: relative;
  padding: 5px var(--s-3);
  border-radius: var(--r-control);
  transition: background var(--t-fast) var(--ease), opacity var(--t-fast) var(--ease);
}
.row:hover { background: var(--bg-1); }
.row--drag { opacity: 0.35; }
.row--dropBefore::before, .row--dropAfter::after {
  content: '';
  position: absolute;
  left: var(--s-3);
  right: var(--s-3);
  height: 2px;
  border-radius: 1px;
  background: var(--acc);
}
.row--dropBefore::before { top: -1px; }
.row--dropAfter::after { bottom: -1px; }
.row--warn .row__idx { color: var(--warn); }
.row__grip { display: grid; place-items: center; color: var(--fg-4); cursor: grab; }
.row__grip:hover { color: var(--fg-2); }
.row__idx { color: var(--fg-3); font-size: var(--fs-label); }
.row :deep(.os) { width: 140px; height: 36px; }
.row :deep(.nf) { width: 150px; }
.row__acts { display: flex; gap: 2px; justify-content: flex-end; }
.cell { display: flex; min-width: 0; }
.cell > .dir { flex: 1; }

.dir { display: inline-flex; padding: 2px; border-radius: var(--r-control); background: var(--bg-1); border: 1px solid var(--line-2); }
.dir__opt {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-3);
  font-size: var(--fs-label);
  font-weight: 500;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.dir__opt:hover:not(:disabled) { color: var(--fg-1); }
.dir__opt[aria-checked='true'] { background: var(--bg-4); color: var(--fg-1); }
.row--down .dir__opt[aria-checked='true'] { background: var(--acc-soft); color: var(--acc); }

.row-enter-from { opacity: 0; transform: translateY(-4px); }
.row-enter-active { transition: all var(--t-med) var(--ease); }
</style>
