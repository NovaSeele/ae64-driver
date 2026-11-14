<script setup lang="ts">
// Macro — 16 slots (left) and the selected slot's editor (right): recorder, action table, playback mode and
// repeat count. Save writes meta + pages, commits group 6 and verifies the full sequence (stores/macro.ts).
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { onBeforeRouteLeave, useRouter } from 'vue-router';
import {
  IconAlertTriangle, IconEraser, IconKeyboard, IconPlayerRecordFilled, IconPlayerStopFilled, IconPlus, IconRefresh, IconRepeat,
} from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import NumberField from '../components/ui/NumberField.vue';
import Dialog from '../components/ui/Dialog.vue';
import ActionTable from '../components/macro/ActionTable.vue';
import { MacroRecorder } from '../components/macro/recorder';
import { useDeviceStore } from '../stores/device';
import { LAYER_NAMES, useKeymapStore } from '../stores/keymap';
import { useHistoryStore } from '../stores/history';
import {
  MACRO_CLICK_REPEAT_MAX, MACRO_DELAY_MIN, MACRO_MODES, balanceWarnings, isHoldMode, useMacroStore, validateDraft,
} from '../stores/macro';
import type { MacroDraft, MacroMode } from '../stores/macro';
import { MACRO_ACTIONS_PER_PAGE, keycodeLabel } from '../protocol';
import type { MacroAction } from '../protocol';
import { useToast } from '../components/ui/toast';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';

const device = useDeviceStore();
const macro = useMacroStore();
const keymap = useKeymapStore();
const history = useHistoryStore();
const toast = useToast();
const router = useRouter();

const current = ref(0);
/** Unsaved drafts per slot (switching slots keeps them). */
const drafts = reactive(new Map<number, MacroDraft>());
const saving = ref(false);
const confirmClear = ref(false);
const confirmClearList = ref(false);
const readOnly = computed(() => !device.boardAllowed);

onMounted(() => {
  void macro.load();
  void keymap.load(); // "Đang gán" looks at every layer
});

const slot = computed(() => macro.slots.find((s) => s.id === current.value) ?? null);
function fromSlot(): MacroDraft {
  const s = slot.value!;
  return { mode: s.mode, repeatCount: isHoldMode(s.mode) ? 1 : s.repeatCount, actions: s.actions.map((a) => ({ ...a })) };
}
const draft = computed<MacroDraft | null>(() => (slot.value ? drafts.get(current.value) ?? fromSlot() : null));
function setDraft(patch: Partial<MacroDraft>) {
  if (!draft.value) return;
  drafts.set(current.value, { ...draft.value, ...patch });
}
function sameDraft(a: MacroDraft, b: MacroDraft): boolean {
  return a.mode === b.mode && (isHoldMode(a.mode) || a.repeatCount === b.repeatCount) && a.actions.length === b.actions.length
    && a.actions.every((x, i) => x.down === b.actions[i].down && x.delay === b.actions[i].delay && x.keycode === b.actions[i].keycode);
}
const dirtyIds = computed(() => new Set([...drafts].filter(([id, d]) => {
  const s = macro.slots.find((x) => x.id === id);
  return s && !sameDraft(d, { mode: s.mode, repeatCount: isHoldMode(s.mode) ? 1 : s.repeatCount, actions: s.actions });
}).map(([id]) => id)));
const dirty = computed(() => dirtyIds.value.has(current.value));
const anyDirty = computed(() => dirtyIds.value.size > 0);

// Drafts live only on this page. Ctrl+Z would write an older saved change to the keyboard instead: off while dirty.
let releaseHistory: (() => void) | null = null;
watch(anyDirty, (d) => {
  if (d && !releaseHistory) releaseHistory = history.suspend();
  else if (!d) { releaseHistory?.(); releaseHistory = null; }
});
const warnLeave = (e: BeforeUnloadEvent) => {
  if (!anyDirty.value) return;
  e.preventDefault();
  e.returnValue = '';
};
// Leaving with unsaved drafts asks first, in a Dialog (DESIGN L §3.3). The guard refuses the navigation and keeps its
// target; "Bỏ thay đổi" pushes it again and lets it pass. The drafts go with the page (unmount), never before the push.
/** Where a leave with unsaved drafts wanted to go; null = no question open. A second ask replaces it: the latest wins. */
const leaveTo = ref<string | null>(null);
const leaveOpen = computed({ get: () => leaveTo.value !== null, set: (v) => { if (!v) leaveTo.value = null; } });
/** "Bỏ thay đổi" was pressed: that one navigation passes. */
let leaving = false;
/** "Macro 0, Macro 2": every unsaved slot, lowest id first (dirtyIds is in edit order). */
const leaveNames = computed(() => [...dirtyIds.value].sort((a, b) => a - b).map((n) => t('macro.slotName', { n })).join(', '));
onBeforeRouteLeave((to) => {
  if (leaving) return true;
  // A write is in flight (Save, Clear, discarding a waiting slot): a failure before any packet puts the slot back to the
  // keyboard's copy, and only this page still holds the draft to save again. Also for a clean slot (§3.3 b).
  if (saving.value) { toast.show(t('macro.leaveSaving'), 'warn'); return false; }
  // The recorder swallows every key, Esc and Tab included: stop it (adding releases for held keys) before asking (§3.3 a).
  stopRecording();
  if (!anyDirty.value) return true;
  if (confirmClear.value || confirmClearList.value) return false; // another dialog is open: answer it first
  leaveTo.value = to.fullPath;
  return false;
});
async function leaveNow() {
  const to = leaveTo.value;
  if (to === null) return;
  leaving = true;
  leaveTo.value = null;
  try { await router.push(to); } finally { leaving = false; }
}
onMounted(() => window.addEventListener('beforeunload', warnLeave));

// ----- slot list (tabs)
const slotRefs = ref<HTMLButtonElement[]>([]);
const slotsLocked = computed(() => recording.value || saving.value);
function onSlotKey(e: KeyboardEvent, i: number) {
  if (slotsLocked.value) return;
  const n = macro.slots.length;
  const to = { ArrowDown: i + 1, ArrowRight: i + 1, ArrowUp: i - 1, ArrowLeft: i - 1, Home: 0, End: n - 1 }[e.key];
  if (to === undefined) return;
  e.preventDefault();
  const next = (to + n) % n;
  current.value = macro.slots[next].id;
  void nextTick(() => slotRefs.value[next]?.focus());
}

// ----- playback
const MODE_TEXT: Record<MacroMode, MessageKey> = {
  0: 'macro.mode0', 1: 'macro.mode1', 2: 'macro.mode2', 3: 'macro.mode3', 4: 'macro.mode4', 5: 'macro.mode5',
};
const clickModes = MACRO_MODES.filter((m) => !isHoldMode(m));
const holdModes = MACRO_MODES.filter((m) => isHoldMode(m));
function setMode(m: MacroMode) {
  setDraft({ mode: m });
}

// ----- derived info
const warn = computed(() => (draft.value ? balanceWarnings(draft.value.actions) : { early: [], stuck: [] }));
const warnRows = computed(() => new Set(warn.value.early));
const totalMs = computed(() => draft.value?.actions.reduce((s, a) => s + a.delay, 0) ?? 0);
const pages = computed(() => Math.ceil((draft.value?.actions.length ?? 0) / MACRO_ACTIONS_PER_PAGE));
const problem = computed(() => (draft.value ? validateDraft(draft.value, macro.limit) : null));
/** Keys holding this macro on any layer ("Main:Q", "Fn1:W"). */
const assignedKeys = computed(() => {
  const code = 0xf500 + current.value;
  const out: string[] = [];
  LAYER_NAMES.forEach((layer, l) => {
    for (const k of device.keys) {
      if ((l === 0 ? device.layer0[k.id] : keymap.values[l]?.[k.id]) === code) out.push(`${layer}:${k.name}`);
    }
  });
  return out;
});
const full = computed(() => (draft.value?.actions.length ?? 0) >= macro.limit);

// ----- recorder (keydown/keyup captured on the page, logic in components/macro/recorder.ts)
const recording = ref(false);
let rec: MacroRecorder | null = null;

function onRecordKey(e: KeyboardEvent) {
  if (!recording.value || !draft.value || !rec) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const r = rec.handle({ code: e.code, type: e.type as 'keydown' | 'keyup', repeat: e.repeat }, draft.value.actions.length, performance.now());
  if (r.action) setDraft({ actions: [...draft.value.actions, r.action] });
  if (r.stop) {
    stopRecording();
    if (r.stop === 'limit') toast.show(t('macro.limitReached', { n: macro.limit }), 'warn');
  }
}
/** The keyup of a held key never arrives after Alt+Tab / Win: stop and release everything. */
function onBlur() {
  if (!recording.value) return;
  stopRecording();
  toast.show(t('macro.recStoppedBlur'), 'warn');
}
function onVisibility() {
  if (document.visibilityState === 'hidden') onBlur();
}
function startRecording() {
  if (recording.value || readOnly.value) return;
  rec = new MacroRecorder(macro.limit);
  recording.value = true;
  (document.activeElement as HTMLElement | null)?.blur();
  window.addEventListener('keydown', onRecordKey, true);
  window.addEventListener('keyup', onRecordKey, true);
  window.addEventListener('blur', onBlur);
  document.addEventListener('visibilitychange', onVisibility);
}
/** Stop and append releases for keys still held, as the reference recorder does (room is always reserved). */
function stopRecording() {
  if (!recording.value) return;
  window.removeEventListener('keydown', onRecordKey, true);
  window.removeEventListener('keyup', onRecordKey, true);
  window.removeEventListener('blur', onBlur);
  document.removeEventListener('visibilitychange', onVisibility);
  recording.value = false;
  const d = draft.value;
  const extra = rec?.finish(performance.now()) ?? [];
  if (d && extra.length) setDraft({ actions: [...d.actions, ...extra] });
  rec = null;
}
onBeforeUnmount(() => {
  stopRecording();
  releaseHistory?.();
  releaseHistory = null;
  window.removeEventListener('beforeunload', warnLeave);
});
watch(current, () => { stopRecording(); removed.value = null; });

// ----- list edits: deleting rows can be undone once (the draft has no other undo)
const removed = ref<{ id: number; actions: MacroAction[] } | null>(null);
function onActions(next: MacroAction[]) {
  const d = draft.value;
  if (!d) return;
  removed.value = next.length < d.actions.length ? { id: current.value, actions: d.actions } : null;
  setDraft({ actions: next });
}
function undoRemove() {
  if (removed.value?.id === current.value) setDraft({ actions: removed.value.actions });
  removed.value = null;
}
function clearList() {
  confirmClearList.value = false;
  onActions([]);
}

function addAction() {
  const d = draft.value;
  if (!d || full.value || readOnly.value) return;
  const last = d.actions.at(-1);
  setDraft({ actions: [...d.actions, last ? { keycode: last.keycode, down: !last.down, delay: 30 } : { keycode: 4, down: true, delay: MACRO_DELAY_MIN }] });
}

// ----- device writes
async function save() {
  const d = draft.value;
  if (!d || problem.value || readOnly.value) return;
  stopRecording();
  const id = current.value; // slots are locked while saving, but never trust current after an await
  saving.value = true;
  try {
    await macro.save(id, d);
    drafts.delete(id);
    removed.value = null;
    toast.show(t('macro.saved', { n: id }), 'success');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    saving.value = false;
  }
}
async function clearData() {
  confirmClear.value = false;
  if (readOnly.value) return;
  stopRecording();
  const id = current.value;
  saving.value = true;
  try {
    await macro.clearData(id);
    drafts.delete(id);
    removed.value = null;
    toast.show(t('macro.cleared', { n: id }), 'success');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    saving.value = false;
  }
}
async function discard() {
  stopRecording();
  const id = current.value;
  drafts.delete(id);
  removed.value = null;
  if (!macro.waiting.has(id)) return;
  saving.value = true;
  try {
    await macro.discardWaiting(id);
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <PageLayout :title="t('page.macro')">
    <Card v-if="macro.loadError" :title="t('macro.loadFailed')" :subtitle="macro.loadError">
      <div><Button :icon="IconRefresh" @click="macro.load(true)">{{ t('macro.reload') }}</Button></div>
    </Card>

    <div v-else-if="macro.loading" class="cols" aria-busy="true">
      <div class="skel-card">
        <p class="muted num">{{ t('macro.loading', { n: macro.loadedCount, total: macro.slotCount }) }}</p>
        <div v-for="i in 6" :key="i" class="skeleton" style="height: 44px" />
      </div>
      <div class="skel-card">
        <div class="skeleton" style="width: 40%; height: 14px" />
        <div class="skeleton" style="height: 240px" />
      </div>
    </div>

    <div v-else-if="draft && slot" class="cols">
      <!-- slot list -->
      <Card :title="t('macro.slots')" :subtitle="t('macro.capacity', { n: macro.limit })">
        <div class="slots" role="tablist" aria-orientation="vertical" :aria-label="t('macro.slots')">
          <button
            v-for="(s, i) in macro.slots"
            :id="`macro-tab-${s.id}`"
            :key="s.id"
            ref="slotRefs"
            type="button"
            role="tab"
            class="slot"
            aria-controls="macro-panel"
            :aria-selected="s.id === current"
            :tabindex="s.id === current ? 0 : -1"
            :class="{ 'slot--used': s.actions.length > 0 }"
            :disabled="slotsLocked"
            @click="current = s.id"
            @keydown="onSlotKey($event, i)"
          >
            <span class="slot__id num">M{{ s.id }}</span>
            <span class="slot__count">{{ s.actions.length ? t('macro.actions', { n: s.actions.length }) : t('macro.empty') }}</span>
            <template v-if="dirtyIds.has(s.id)">
              <span class="slot__dirty" aria-hidden="true" :title="t('macro.dirty')" />
              <span class="sr-only">({{ t('macro.tabDirty') }})</span>
            </template>
            <span v-else-if="macro.waiting.has(s.id)" class="slot__dirty" :title="t('macro.waiting')" />
          </button>
        </div>
        <p class="note">{{ t('macro.capacityNote', { total: macro.space.capacity, slots: macro.slotCount, n: macro.limit }) }}</p>
      </Card>

      <div id="macro-panel" class="main" role="tabpanel" :aria-labelledby="`macro-tab-${current}`">
        <p v-if="readOnly" class="warn-note" role="note">{{ t('macro.readOnly') }}</p>
        <!-- header -->
        <div class="head">
          <div>
            <h2 class="head__title">{{ t('macro.slotName', { n: current }) }}
              <span v-if="dirty" class="badge">{{ t('macro.dirty') }}</span>
              <span v-else-if="macro.waiting.has(current)" class="badge">{{ t('macro.waiting') }}</span>
            </h2>
            <p v-if="macro.waiting.has(current)" class="head__hint" role="status">{{ t('macro.waitingHint', { n: current }) }}</p>
            <p class="head__hint">
              <IconKeyboard :size="14" stroke-width="1.6" aria-hidden="true" />
              <span v-if="assignedKeys.length">{{ t('macro.assignedTo', { keys: assignedKeys.join(', ') }) }} · </span>
              {{ t('macro.assignHint', { n: current }) }}
              <button type="button" class="link" @click="router.push('/keymap')">{{ t('macro.openKeymap') }}</button>
            </p>
          </div>
          <div class="head__acts">
            <Button variant="ghost" :icon="IconEraser" :disabled="saving || recording || readOnly || !slot.actions.length" @click="confirmClear = true">{{ t('macro.clearData') }}</Button>
            <Button variant="secondary" :disabled="(!dirty && !macro.waiting.has(current)) || saving" @click="discard">{{ t('macro.discard') }}</Button>
            <Button variant="primary" :loading="saving" :disabled="!dirty || !!problem || saving || recording || readOnly" @click="save">{{ t('macro.save') }}</Button>
          </div>
        </div>

        <!-- sequence -->
        <Card class="seqcard" :title="t('macro.editor')" :subtitle="recording ? undefined : t('macro.recordHint')">
          <template #actions>
            <Button v-if="!recording" variant="secondary" size="sm" :icon="IconPlayerRecordFilled" class="rec" :disabled="full || readOnly || saving" @click="startRecording">{{ t('macro.record') }}</Button>
            <Button v-else variant="danger" size="sm" :icon="IconPlayerStopFilled" @click="stopRecording">{{ t('macro.stop') }}</Button>
            <Button variant="ghost" size="sm" :icon="IconPlus" :disabled="recording || full || readOnly" @click="addAction">{{ t('macro.add') }}</Button>
            <Button variant="ghost" size="sm" :disabled="recording || readOnly || !draft.actions.length" @click="confirmClearList = true">{{ t('macro.clearList') }}</Button>
          </template>

          <div v-if="recording" class="recbar" role="status">
            <span class="recbar__dot" />
            <span>{{ t('macro.recording') }} {{ t('macro.recordStop') }}</span>
            <span class="recbar__n num">{{ draft.actions.length }}</span>
          </div>

          <ActionTable
            v-if="draft.actions.length"
            :actions="draft.actions"
            :disabled="recording || readOnly"
            :can-insert="!full"
            :warnings="warnRows"
            @update="onActions"
          />
          <p v-else class="none">{{ t('macro.noActions') }}</p>

          <footer class="seqfoot">
            <span class="num muted">{{ t('macro.total', { n: draft.actions.length, max: macro.limit, pages, ms: totalMs }) }}</span>
            <span v-if="warn.early.length" class="warn"><IconAlertTriangle :size="14" />{{ t('macro.warnRelease', { i: warn.early[0] + 1 }) }}</span>
            <span v-else-if="warn.stuck.length" class="warn"><IconAlertTriangle :size="14" />{{ t('macro.warnStuck', { keys: warn.stuck.map((c) => keycodeLabel(c).label).join(', ') }) }}</span>
            <span v-if="problem && draft.actions.length" class="err">{{ problem }}</span>
            <button v-if="removed?.id === current && !recording && !readOnly" type="button" class="link" @click="undoRemove">{{ t('macro.undoRemove') }}</button>
          </footer>
        </Card>

        <!-- playback -->
        <Card :title="t('macro.playback')">
          <div class="modes">
            <div v-for="grp in [{ id: 'click', list: clickModes }, { id: 'hold', list: holdModes }]" :key="grp.id" class="modes__grp">
              <span class="micro muted">{{ grp.id === 'click' ? t('macro.click') : t('macro.hold') }}</span>
              <div class="modes__list" role="radiogroup" :aria-label="grp.id === 'click' ? t('macro.groupClick') : t('macro.groupHold')">
                <button v-for="m in grp.list" :key="m" type="button" role="radio" class="mode" :aria-checked="draft.mode === m" :disabled="readOnly" @click="setMode(m)">
                  <span class="mode__radio" />
                  {{ t(MODE_TEXT[m]) }}
                </button>
              </div>
            </div>
          </div>
          <div class="repeat">
            <span class="repeat__label"><IconRepeat :size="16" stroke-width="1.6" />{{ t('macro.repeat') }}</span>
            <span v-if="isHoldMode(draft.mode)" class="muted">{{ t('macro.repeatHold') }}</span>
            <NumberField
              v-else
              :model-value="Math.min(MACRO_CLICK_REPEAT_MAX, Math.max(1, draft.repeatCount))"
              :min="1"
              :max="MACRO_CLICK_REPEAT_MAX"
              :step="1"
              :decimals="0"
              unit="×"
              :label="t('macro.repeat')"
              :disabled="readOnly"
              @update:model-value="setDraft({ repeatCount: Math.round($event) })"
            />
          </div>
        </Card>
      </div>
    </div>

    <Dialog v-model:open="confirmClearList" :title="t('macro.clearList')">
      <p>{{ t('macro.clearListConfirm', { n: draft?.actions.length ?? 0 }) }}</p>
      <template #footer>
        <Button variant="secondary" @click="confirmClearList = false">{{ t('advanced.cancel') }}</Button>
        <Button variant="danger" @click="clearList">{{ t('macro.clearList') }}</Button>
      </template>
    </Dialog>

    <Dialog v-model:open="confirmClear" :title="t('macro.clearData')">
      <p>{{ t('macro.clearConfirm', { n: current }) }}</p>
      <template #footer>
        <Button variant="secondary" @click="confirmClear = false">{{ t('advanced.cancel') }}</Button>
        <Button variant="danger" :icon="IconEraser" @click="clearData">{{ t('macro.clearData') }}</Button>
      </template>
    </Dialog>

    <Dialog v-model:open="leaveOpen" describe :title="t('macro.leaveTitle')">
      <p>{{ t('macro.leaveBody', { names: leaveNames }) }}</p>
      <template #footer>
        <Button variant="secondary" @click="leaveOpen = false">{{ t('macro.leaveKeep') }}</Button>
        <Button variant="danger" @click="leaveNow">{{ t('macro.discard') }}</Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: 260px 1fr; gap: var(--s-4); }
@media (max-width: 1000px) {
  .cols { grid-template-columns: 1fr; }
  /* One column: no growers, the table keeps its natural height (capped at 460 px, long macros scroll inside). */
  .main > .seqcard { flex: none; }
  .main :deep(.at) { flex: none; min-height: 0; }
}
.skel-card {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  padding: var(--s-5);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
}
.muted { color: var(--fg-3); }

.slots { flex: 1 1 auto; display: flex; flex-direction: column; gap: 4px; }
.slot {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex: 1 1 auto;
  min-height: 38px;
  max-height: 56px;
  padding: 0 12px;
  border-radius: var(--r-control);
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.slot:hover:not(:disabled) { background: var(--bg-3); }
.slot[aria-selected='true'] { background: var(--acc-soft); border-color: var(--acc-line); }
.slot__id { width: 34px; font-weight: 600; color: var(--fg-3); }
.slot--used .slot__id { color: var(--fg-1); }
.slot[aria-selected='true'] .slot__id { color: var(--acc); }
.slot__count { flex: 1; font-size: var(--fs-label); color: var(--fg-3); }
.slot--used .slot__count { color: var(--fg-2); }
.note { margin: var(--s-3) 0 0; margin-top: auto; font-size: var(--fs-label); color: var(--fg-3); }
.warn-note { margin: 0; padding: 10px 12px; border-radius: var(--r-control); background: var(--warn-soft); color: var(--warn); font-size: var(--fs-label); }
.slot__dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }

.main { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
/* The Action sequence card is the right column's grower: its table (or the empty note) takes the spare height. */
.main > .seqcard { flex: 1 1 auto; }
.head { display: flex; align-items: flex-end; justify-content: space-between; gap: var(--s-4); flex-wrap: wrap; }
.head__title { margin: 0; font-size: var(--fs-hero); font-weight: 600; display: flex; align-items: center; gap: var(--s-3); }
.badge { font-size: var(--fs-caption); font-weight: 600; padding: 2px 8px; border-radius: 999px; background: var(--warn-soft); color: var(--warn); }
.head__hint { display: flex; align-items: center; gap: 6px; margin: 4px 0 0; color: var(--fg-3); font-size: var(--fs-label); flex-wrap: wrap; }
.link { border: 0; background: none; padding: 0; color: var(--acc); font-size: var(--fs-label); cursor: pointer; }
.link:hover { text-decoration: underline; }
.head__acts { display: flex; gap: var(--s-2); }

.rec :deep(svg) { color: var(--danger); }
.recbar {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
  padding: 10px 12px;
  border-radius: var(--r-control);
  background: var(--danger-soft);
  color: var(--fg-1);
}
.recbar__dot { width: 9px; height: 9px; border-radius: 50%; background: var(--danger); animation: pulse 1.1s ease-in-out infinite; }
.recbar__key { padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line-3); background: var(--bg-3); font-family: inherit; font-size: var(--fs-label); }
.recbar__n { margin-left: auto; font-weight: 600; color: var(--danger); }
@keyframes pulse { 50% { opacity: 0.3; } }
.none { flex: 1 1 auto; display: grid; place-items: center; margin: 0; padding: var(--s-6) 0; text-align: center; color: var(--fg-3); }
.seqfoot { display: flex; align-items: center; gap: var(--s-4); flex-wrap: wrap; margin-top: auto; padding-top: var(--s-3); border-top: 1px solid var(--line-1); font-size: var(--fs-label); }
.warn { display: inline-flex; align-items: center; gap: 4px; color: var(--warn); }
.err { color: var(--danger); }

.modes { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-4); }
@media (max-width: 1200px) { .modes { grid-template-columns: 1fr; } }
/* Tied to the .modes breakpoint above (change both together): in two columns with the playback groups stacked,
   Kiểu phát is ~120 px taller, so a 460 px table would push the right column past what the 16 slots can stretch
   to (56 px cap) and open a blank band above the note. Cap the table at ~7 rows there; 460 elsewhere. */
@media (min-width: 1001px) and (max-width: 1200px) { .main :deep(.at__body) { max-height: 320px; } }
.modes__grp { display: flex; flex-direction: column; gap: var(--s-2); }
.modes__list { display: flex; flex-direction: column; gap: 4px; }
.mode {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 9px 12px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  text-align: left;
  color: var(--fg-2);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.mode:hover { border-color: var(--line-3); color: var(--fg-1); }
.mode[aria-checked='true'] { background: var(--acc-soft); border-color: var(--acc-line); color: var(--fg-1); }
.mode__radio { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 1.5px solid var(--fg-3); transition: border-color var(--t-fast) var(--ease), border-width var(--t-fast) var(--ease), background-color var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease); }
.mode[aria-checked='true'] .mode__radio { border: 4px solid var(--acc); }
.repeat { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); margin-top: var(--s-4); padding-top: var(--s-4); border-top: 1px solid var(--line-1); min-height: 36px; }
.repeat__label { display: inline-flex; align-items: center; gap: var(--s-2); color: var(--fg-2); }
.repeat :deep(.nf) { width: 140px; }
</style>
