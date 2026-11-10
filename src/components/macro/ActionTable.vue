<script setup lang="ts">
// Macro action rows: drag handle (reorder), index, key (restricted picker), Nhấn/Nhả, delay (1–32767 ms),
// insert-below and delete. Emits a whole new list on every change. In a narrow card (container query) move up/down,
// insert and delete collapse into one "⋯" menu per row.
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';
import { IconArrowDown, IconArrowUp, IconChevronDown, IconChevronUp, IconDots, IconGripVertical, IconRowInsertBottom, IconTrash } from '@tabler/icons-vue';
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
    const shown = (b: HTMLButtonElement | null | undefined) => (b && !b.disabled && b.offsetParent !== null ? b : null);
    const want = shown(row?.querySelector<HTMLButtonElement>(`[data-move="${dir}"]`))
      ?? shown(row?.querySelector<HTMLButtonElement>('[data-move]:not(:disabled)'))
      ?? shown(row?.querySelector<HTMLButtonElement>('.row__more button'));
    want?.focus();
  });
}

// ----- "⋯" menu (narrow card): fixed popover under the row's button, Esc / outside click / scroll closes it
const menuRow = ref<number | null>(null);
const menuPos = ref({ top: 0, right: 0 });
const menuEl = ref<HTMLElement | null>(null);
let menuTrigger: HTMLElement | null = null;
function closeMenu(refocus = false) {
  if (menuRow.value === null) return;
  menuRow.value = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('resize', onResize);
  root.value?.removeEventListener('scroll', onResize, true);
  if (refocus) menuTrigger?.focus();
}
function onOutside(e: Event) {
  const el = e.target as Node;
  if (menuEl.value?.contains(el) || menuTrigger?.contains(el)) return;
  closeMenu();
}
function onResize() { closeMenu(); }
function toggleMenu(e: MouseEvent, i: number) {
  if (menuRow.value === i) { closeMenu(true); return; }
  closeMenu();
  menuTrigger = e.currentTarget as HTMLElement;
  const r = menuTrigger.getBoundingClientRect();
  menuPos.value = { top: r.bottom + 4, right: window.innerWidth - r.right };
  menuRow.value = i;
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', onResize);
  root.value?.addEventListener('scroll', onResize, true);
  void nextTick(() => menuEl.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus());
}
function onMenuKey(e: KeyboardEvent) {
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  e.preventDefault();
  const items = [...(menuEl.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
}
/** Run a row action from the menu: close first (the row may disappear or move). */
function menuDo(fn: (i: number) => void) {
  const i = menuRow.value;
  if (i === null) return;
  const trigger = menuTrigger;
  closeMenu();
  fn(i);
  if (fn === step) return; // step() moves focus itself
  void nextTick(() => (trigger?.isConnected ? trigger.focus() : undefined));
}
onBeforeUnmount(() => closeMenu());
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
        <span class="row__end" role="cell">
        <span class="row__acts">
          <IconButton :icon="IconChevronUp" :label="t('macro.moveUp')" size="sm" data-move="-1" :disabled="disabled || i === 0" @click="step(i, -1)" />
          <IconButton :icon="IconChevronDown" :label="t('macro.moveDown')" size="sm" data-move="1" :disabled="disabled || i === actions.length - 1" @click="step(i, 1)" />
          <IconButton :icon="IconRowInsertBottom" :label="t('macro.insert')" size="sm" :disabled="disabled || !canInsert" @click="insertBelow(i)" />
          <IconButton :icon="IconTrash" :label="t('macro.remove')" size="sm" :disabled="disabled" @click="remove(i)" />
        </span>
        <span class="row__more">
          <IconButton
            :icon="IconDots"
            :label="t('macro.more', { n: String(i + 1).padStart(2, '0') })"
            size="sm"
            aria-haspopup="menu"
            :aria-expanded="menuRow === i"
            :disabled="disabled"
            @click="toggleMenu($event, i)"
          />
        </span>
        </span>
      </div>
    </TransitionGroup>
    </div>

    <div v-if="menuRow !== null" ref="menuEl" class="menu" role="menu" :aria-label="t('macro.more', { n: String(menuRow + 1).padStart(2, '0') })" :style="{ top: `${menuPos.top}px`, right: `${menuPos.right}px` }" @keydown="onMenuKey">
      <button type="button" role="menuitem" class="menu__it" :disabled="menuRow === 0" @click="menuDo((i) => step(i, -1))"><IconChevronUp :size="16" stroke-width="1.5" />{{ t('macro.moveUp') }}</button>
      <button type="button" role="menuitem" class="menu__it" :disabled="menuRow === actions.length - 1" @click="menuDo((i) => step(i, 1))"><IconChevronDown :size="16" stroke-width="1.5" />{{ t('macro.moveDown') }}</button>
      <button type="button" role="menuitem" class="menu__it" :disabled="!canInsert" @click="menuDo(insertBelow)"><IconRowInsertBottom :size="16" stroke-width="1.5" />{{ t('macro.insert') }}</button>
      <button type="button" role="menuitem" class="menu__it" @click="menuDo(remove)"><IconTrash :size="16" stroke-width="1.5" />{{ t('macro.remove') }}</button>
    </div>

    <Dialog v-model:open="pickOpen" :title="pickRow !== null ? t('macro.pickKey', { n: pickRow + 1 }) : ''" :width="620">
      <OutputPicker v-if="pickRow !== null" :groups="groups" :current="actions[pickRow]?.keycode" :note="t('macro.pickerOnly')" @pick="pick" />
    </Dialog>
  </div>
</template>

<style scoped>
.at { container-type: inline-size; }
/* One grid for the whole table: header and rows are subgrids, so the direction and action columns are sized
   by their widest content in any row (VI and EN labels differ) and every row stays aligned. The edge tracks are
   max-content because a subgrid's padding (the row's side padding) is taken out of its first and last track. */
.at__in { display: grid; grid-template-columns: max-content 32px minmax(96px, 1fr) max-content minmax(112px, 130px) max-content; column-gap: var(--s-3); }
.at__head, .at__body, .row { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; }
.at__head { padding: 0 var(--s-3) var(--s-2); color: var(--fg-3); border-bottom: 1px solid var(--line-1); }
.at__body { align-content: start; max-height: 460px; overflow-y: auto; padding: 4px 0; }
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
.row :deep(.os) { width: 100%; min-width: 0; height: 36px; }
.row :deep(.nf) { width: 100%; }
.row__acts { display: flex; gap: 2px; justify-content: flex-end; }
.row__end { display: flex; justify-content: flex-end; min-width: 0; }
.row__more { display: none; }
.menu {
  position: fixed;
  z-index: 50;
  display: flex;
  flex-direction: column;
  min-width: 160px;
  padding: 4px;
  background: var(--bg-3);
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  box-shadow: var(--shadow-pop);
}
.menu__it {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  height: 32px;
  padding: 0 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-1);
  font-size: var(--fs-label);
  text-align: left;
}
.menu__it:hover:not(:disabled), .menu__it:focus-visible { background: var(--bg-4); }
.menu__it:disabled { opacity: 0.35; cursor: not-allowed; }

@container (max-width: 759px) {
  .at__in { grid-template-columns: max-content 28px minmax(96px, 1fr) max-content minmax(104px, 128px) max-content; column-gap: var(--s-2); }
  .row__acts { display: none; }
  .row__more { display: flex; }
  .dir__opt { padding: 0 4px; }
}
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
.dir__opt[aria-checked='true'] { background: color-mix(in srgb, var(--m-release) var(--soft-pct), transparent); color: var(--fg-1); }
.row--down .dir__opt[aria-checked='true'] { background: color-mix(in srgb, var(--m-press) var(--soft-pct), transparent); }

.row-enter-from { opacity: 0; transform: translateY(-4px); }
.row-enter-active { transition: opacity var(--t-med) var(--ease), transform var(--t-med) var(--ease); }
</style>
