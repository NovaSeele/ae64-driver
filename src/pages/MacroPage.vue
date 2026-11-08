<script setup lang="ts">
// Macro — 16 slots (left) and the selected slot's editor (right): recorder, action table, playback mode and
// repeat count. Save writes meta + pages, commits group 6 and verifies the full sequence (stores/macro.ts).
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import {
  IconAlertTriangle, IconEraser, IconKeyboard, IconPlayerRecordFilled, IconPlayerStopFilled, IconPlus, IconRefresh, IconRepeat,
} from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import NumberField from '../components/ui/NumberField.vue';
import Dialog from '../components/ui/Dialog.vue';
import ActionTable from '../components/macro/ActionTable.vue';
import { hidUsageOf } from '../components/macro/recorder';
import { useDeviceStore } from '../stores/device';
import {
  MACRO_CLICK_REPEAT_MAX, MACRO_DELAY_MAX, MACRO_DELAY_MIN, MACRO_MODES, balanceWarnings, isHoldMode, useMacroStore, validateDraft,
} from '../stores/macro';
import type { MacroDraft, MacroMode } from '../stores/macro';
import { MACRO_ACTIONS_PER_PAGE, keycodeLabel } from '../protocol';
import type { MacroAction } from '../protocol';
import { useToast } from '../components/ui/toast';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';

const device = useDeviceStore();
const macro = useMacroStore();
const toast = useToast();
const router = useRouter();

const current = ref(0);
/** Unsaved drafts per slot (switching slots keeps them). */
const drafts = reactive(new Map<number, MacroDraft>());
const saving = ref(false);
const confirmClear = ref(false);

onMounted(() => void macro.load());

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
const assignedKeys = computed(() => device.keys.filter((k) => device.layer0[k.id] === 0xf500 + current.value).map((k) => k.name));
const full = computed(() => (draft.value?.actions.length ?? 0) >= macro.limit);

// ----- recorder (keydown/keyup captured on the page, delays measured between events)
const recording = ref(false);
const pressed = new Map<string, number>();
let lastAt = 0;

function delaySince(now: number): number {
  return lastAt ? Math.round(Math.min(MACRO_DELAY_MAX, Math.max(MACRO_DELAY_MIN, now - lastAt))) : MACRO_DELAY_MIN;
}
function onRecordKey(e: KeyboardEvent) {
  if (!recording.value || !draft.value) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.repeat) return;
  const keycode = hidUsageOf(e.code);
  if (!keycode) return;
  const down = e.type === 'keydown';
  if (down === pressed.has(e.code)) return;
  if (draft.value.actions.length >= macro.limit) {
    stopRecording();
    toast.show(t('macro.limitReached', { n: macro.limit }), 'warn');
    return;
  }
  const now = performance.now();
  setDraft({ actions: [...draft.value.actions, { keycode, down, delay: delaySince(now) }] });
  if (down) pressed.set(e.code, keycode); else pressed.delete(e.code);
  lastAt = now;
}
function startRecording() {
  if (recording.value) return;
  pressed.clear();
  lastAt = 0;
  recording.value = true;
  (document.activeElement as HTMLElement | null)?.blur();
  window.addEventListener('keydown', onRecordKey, true);
  window.addEventListener('keyup', onRecordKey, true);
}
/** Stop and append releases for keys still held, as the reference recorder does. */
function stopRecording() {
  if (!recording.value) return;
  window.removeEventListener('keydown', onRecordKey, true);
  window.removeEventListener('keyup', onRecordKey, true);
  recording.value = false;
  const d = draft.value;
  if (d && pressed.size) {
    const now = performance.now();
    const extra: MacroAction[] = [];
    for (const keycode of pressed.values()) {
      if (d.actions.length + extra.length >= macro.limit) break;
      extra.push({ keycode, down: false, delay: delaySince(now) });
      lastAt = now;
    }
    setDraft({ actions: [...d.actions, ...extra] });
  }
  pressed.clear();
}
onBeforeUnmount(stopRecording);
watch(current, stopRecording);

function addAction() {
  const d = draft.value;
  if (!d || full.value) return;
  const last = d.actions.at(-1);
  setDraft({ actions: [...d.actions, last ? { keycode: last.keycode, down: !last.down, delay: 30 } : { keycode: 4, down: true, delay: MACRO_DELAY_MIN }] });
}

// ----- device writes
async function save() {
  const d = draft.value;
  if (!d || problem.value) return;
  stopRecording();
  saving.value = true;
  try {
    await macro.save(current.value, d);
    drafts.delete(current.value);
    toast.show(t('macro.saved', { n: current.value }), 'success');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    saving.value = false;
  }
}
async function clearData() {
  confirmClear.value = false;
  stopRecording();
  saving.value = true;
  try {
    await macro.clearData(current.value);
    drafts.delete(current.value);
    toast.show(t('macro.cleared', { n: current.value }), 'success');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    saving.value = false;
  }
}
function discard() {
  stopRecording();
  drafts.delete(current.value);
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
        <div class="slots" role="tablist" :aria-label="t('macro.slots')">
          <button
            v-for="s in macro.slots"
            :key="s.id"
            type="button"
            role="tab"
            class="slot"
            :aria-selected="s.id === current"
            :class="{ 'slot--used': s.actions.length > 0 }"
            :disabled="recording"
            @click="current = s.id"
          >
            <span class="slot__id num">M{{ s.id }}</span>
            <span class="slot__count">{{ s.actions.length ? t('macro.actions', { n: s.actions.length }) : t('macro.empty') }}</span>
            <span v-if="dirtyIds.has(s.id)" class="slot__dirty" :title="t('macro.dirty')" />
          </button>
        </div>
      </Card>

      <div class="main">
        <!-- header -->
        <div class="head">
          <div>
            <h2 class="head__title">{{ t('macro.slotName', { n: current }) }}
              <span v-if="dirty" class="badge">{{ t('macro.dirty') }}</span>
            </h2>
            <p class="head__hint">
              <IconKeyboard :size="14" stroke-width="1.6" aria-hidden="true" />
              <span v-if="assignedKeys.length">{{ t('macro.assignedTo', { keys: assignedKeys.join(', ') }) }} · </span>
              {{ t('macro.assignHint', { n: current }) }}
              <button type="button" class="link" @click="router.push('/keymap')">{{ t('macro.openKeymap') }}</button>
            </p>
          </div>
          <div class="head__acts">
            <Button variant="ghost" :icon="IconEraser" :disabled="saving || recording" @click="confirmClear = true">{{ t('macro.clearData') }}</Button>
            <Button variant="secondary" :disabled="!dirty || saving" @click="discard">{{ t('macro.discard') }}</Button>
            <Button variant="primary" :loading="saving" :disabled="!!problem || saving || recording" @click="save">{{ t('macro.save') }}</Button>
          </div>
        </div>

        <!-- sequence -->
        <Card :title="t('macro.editor')" :subtitle="recording ? undefined : t('macro.recordHint')">
          <template #actions>
            <Button v-if="!recording" variant="secondary" size="sm" :icon="IconPlayerRecordFilled" class="rec" :disabled="full" @click="startRecording">{{ t('macro.record') }}</Button>
            <Button v-else variant="danger" size="sm" :icon="IconPlayerStopFilled" @click="stopRecording">{{ t('macro.stop') }}</Button>
            <Button variant="ghost" size="sm" :icon="IconPlus" :disabled="recording || full" @click="addAction">{{ t('macro.add') }}</Button>
            <Button variant="ghost" size="sm" :disabled="recording || !draft.actions.length" @click="setDraft({ actions: [] })">{{ t('macro.clearList') }}</Button>
          </template>

          <div v-if="recording" class="recbar" role="status">
            <span class="recbar__dot" />{{ t('macro.recording') }}
            <span class="recbar__n num">{{ draft.actions.length }}</span>
          </div>

          <ActionTable
            v-if="draft.actions.length"
            :actions="draft.actions"
            :disabled="recording"
            :can-insert="!full"
            :warnings="warnRows"
            @update="setDraft({ actions: $event })"
          />
          <p v-else class="none">{{ t('macro.noActions') }}</p>

          <footer class="seqfoot">
            <span class="num muted">{{ t('macro.total', { n: draft.actions.length, max: macro.limit, pages, ms: totalMs }) }}</span>
            <span v-if="warn.early.length" class="warn"><IconAlertTriangle :size="14" />{{ t('macro.warnRelease', { i: warn.early[0] + 1 }) }}</span>
            <span v-else-if="warn.stuck.length" class="warn"><IconAlertTriangle :size="14" />{{ t('macro.warnStuck', { keys: warn.stuck.map((c) => keycodeLabel(c).label).join(', ') }) }}</span>
            <span v-if="problem && draft.actions.length" class="err">{{ problem }}</span>
          </footer>
        </Card>

        <!-- playback -->
        <Card :title="t('macro.playback')">
          <div class="modes">
            <div v-for="grp in [{ id: 'click', list: clickModes }, { id: 'hold', list: holdModes }]" :key="grp.id" class="modes__grp">
              <span class="micro muted">{{ grp.id === 'click' ? t('macro.click') : t('macro.hold') }}</span>
              <div class="modes__list" role="radiogroup" :aria-label="t('macro.playback')">
                <button v-for="m in grp.list" :key="m" type="button" role="radio" class="mode" :aria-checked="draft.mode === m" @click="setMode(m)">
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
              @update:model-value="setDraft({ repeatCount: Math.round($event) })"
            />
          </div>
        </Card>
      </div>
    </div>

    <Dialog v-model:open="confirmClear" :title="t('macro.clearData')">
      <p>{{ t('macro.clearConfirm', { n: current }) }}</p>
      <template #footer>
        <Button variant="secondary" @click="confirmClear = false">{{ t('advanced.cancel') }}</Button>
        <Button variant="danger" :icon="IconEraser" @click="clearData">{{ t('macro.clearData') }}</Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: 260px 1fr; gap: var(--s-4); align-items: start; }
@media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
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

.slots { display: flex; flex-direction: column; gap: 4px; }
.slot {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  height: 38px;
  padding: 0 12px;
  border-radius: var(--r-control);
  border: 1px solid transparent;
  background: transparent;
  text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.slot:hover:not(:disabled) { background: var(--bg-3); }
.slot[aria-selected='true'] { background: var(--acc-soft); border-color: var(--acc-line); }
.slot__id { width: 34px; font-weight: 700; color: var(--fg-3); }
.slot--used .slot__id { color: var(--fg-1); }
.slot[aria-selected='true'] .slot__id { color: var(--acc); }
.slot__count { flex: 1; font-size: var(--fs-label); color: var(--fg-3); }
.slot--used .slot__count { color: var(--fg-2); }
.slot__dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--warn); }

.main { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
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
.recbar__n { margin-left: auto; font-weight: 600; color: var(--danger); }
@keyframes pulse { 50% { opacity: 0.3; } }
.none { padding: var(--s-6) 0; text-align: center; color: var(--fg-3); }
.seqfoot { display: flex; align-items: center; gap: var(--s-4); flex-wrap: wrap; margin-top: var(--s-3); padding-top: var(--s-3); border-top: 1px solid var(--line-1); font-size: var(--fs-label); }
.warn { display: inline-flex; align-items: center; gap: 4px; color: var(--warn); }
.err { color: var(--danger); }

.modes { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-4); }
@media (max-width: 1200px) { .modes { grid-template-columns: 1fr; } }
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
.mode__radio { width: 14px; height: 14px; flex: none; border-radius: 50%; border: 1.5px solid var(--fg-3); transition: all var(--t-fast) var(--ease); }
.mode[aria-checked='true'] .mode__radio { border: 4px solid var(--acc); }
.repeat { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); margin-top: var(--s-4); padding-top: var(--s-4); border-top: 1px solid var(--line-1); min-height: 36px; }
.repeat__label { display: inline-flex; align-items: center; gap: var(--s-2); color: var(--fg-2); }
.repeat :deep(.nf) { width: 140px; }
</style>
