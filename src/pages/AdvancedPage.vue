<script setup lang="ts">
// Advanced keys — two columns under the keyboard: available types (left) and configured assignments (right).
// Choosing a type opens its editor; keys are picked on the keyboard (1 key for DKS/MPT, A then B for pairs).
// Writes go through useAdvancedStore().save/remove (history + sync, verify, Hall-tuning restore).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import type { Component } from 'vue';
import {
  IconAlertTriangle, IconArrowBarToUp, IconArrowLeft, IconArrowsLeftRight, IconBolt, IconChevronRight, IconHandClick,
  IconLock, IconPencil, IconRefresh, IconStairs, IconTimeline, IconToggleRight, IconTrash,
} from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import IconButton from '../components/ui/IconButton.vue';
import Dialog from '../components/ui/Dialog.vue';
import DksEditor from '../components/advanced/DksEditor.vue';
import MptEditor from '../components/advanced/MptEditor.vue';
import PairEditor from '../components/advanced/PairEditor.vue';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { useHistoryStore } from '../stores/history';
import {
  AdvancedConflictError, DKS_DEFAULT_DBS, MPT_BASIC_CODES, MPT_EXTENDED_CODES, dksHostEligible, mptHostEligible, mptLimit,
  normalizeMptDepths, pickPairKey, sameSlot, useAdvancedStore, validateAssignment,
} from '../stores/advanced';
import type { Assignment, DksAssignment, MptAssignment, RsAssignment, SocdAssignment, WritableAssignment, WritableType } from '../stores/advanced';
import { keycodeLabel } from '../protocol';
import type { AdvancedRecord, PhysicalKey } from '../protocol';
import { useToast } from '../components/ui/toast';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const history = useHistoryStore();
const adv = useAdvancedStore();
const toast = useToast();

const TYPES: { type: WritableType; icon: Component; desc: MessageKey; keys: MessageKey }[] = [
  { type: 'DKS', icon: IconTimeline, desc: 'advanced.descDKS', keys: 'advanced.oneKey' },
  { type: 'MPT', icon: IconStairs, desc: 'advanced.descMPT', keys: 'advanced.oneKey' },
  { type: 'SOCD', icon: IconArrowsLeftRight, desc: 'advanced.descSOCD', keys: 'advanced.twoKeys' },
  { type: 'RS', icon: IconBolt, desc: 'advanced.descRS', keys: 'advanced.twoKeys' },
];
// Read-only kinds (listed when the keyboard already has them) need an icon too.
const ICONS: Record<string, Component> = {
  ...Object.fromEntries(TYPES.map((x) => [x.type, x.icon])),
  MT: IconHandClick, TGL: IconToggleRight, END: IconArrowBarToUp,
};

const draft = ref<WritableAssignment | null>(null);
const editing = ref<Assignment | null>(null);
const pairSlot = ref<0 | 1>(0);
const mptMax = ref(3.3);
const saving = ref(false);
const confirmDel = ref<Assignment | null>(null);
const confirmOpen = computed({ get: () => confirmDel.value !== null, set: (v) => { if (!v) confirmDel.value = null; } });
const removing = ref(false);
/** The draft as it was when the editor opened; the editor is "dirty" once it differs. */
const baseline = ref('');
/** Save was pressed while the draft was invalid: only then is the problem shown. */
const attempted = ref(false);
const discardAsk = ref<(() => void) | null>(null);
const discardOpen = computed({ get: () => discardAsk.value !== null, set: (v) => { if (!v) discardAsk.value = null; } });

// A new draft ignores which keys were picked (picking is not work worth confirming); an edit includes them.
function snapshot(d: WritableAssignment | null, withKeys: boolean): string {
  if (!d) return '';
  const { keys, ...rest } = d;
  return JSON.stringify(withKeys ? { keys, ...rest } : rest);
}
const dirty = computed(() => !!draft.value && snapshot(draft.value, !!editing.value) !== baseline.value);
const rebase = () => { baseline.value = snapshot(draft.value, !!editing.value); };
/** Run `action` now, or after the user agrees to drop the unsaved draft. */
function guard(action: () => void) {
  if (dirty.value) discardAsk.value = action;
  else action();
}
function confirmDiscard() {
  const action = discardAsk.value;
  discardAsk.value = null;
  action?.();
}

// Ctrl+Z would write an older saved change to the keyboard instead of undoing the draft: off while dirty.
let releaseHistory: (() => void) | null = null;
watch(dirty, (d) => {
  if (d && !releaseHistory) releaseHistory = history.suspend();
  else if (!d) { releaseHistory?.(); releaseHistory = null; }
});
const warnLeave = (e: BeforeUnloadEvent) => {
  if (!dirty.value) return;
  e.preventDefault();
  e.returnValue = '';
};
onBeforeRouteLeave(() => !dirty.value || window.confirm(t('advanced.leaveConfirm')));
function onEsc(e: KeyboardEvent) {
  if (e.key === 'Escape' && draft.value && !e.defaultPrevented) guard(close); // dialogs stop Esc themselves
}

let offProfile: (() => void) | null = null;
onMounted(() => {
  void adv.load();
  offProfile = device.onProfileChanged(() => {
    if (dirty.value) toast.show(t('advanced.discarded'), 'warn');
    close();
    void adv.load(true);
  });
  window.addEventListener('beforeunload', warnLeave);
  window.addEventListener('keydown', onEsc);
});
onBeforeUnmount(() => {
  offProfile?.();
  releaseHistory?.();
  releaseHistory = null;
  window.removeEventListener('beforeunload', warnLeave);
  window.removeEventListener('keydown', onEsc);
});

// ----- labels
const keyName = (id: number) => (device.keys[id] ? device.legend(device.keys[id]) : '?');
const code = (c: number) => (c ? keycodeLabel(c).label : '—');
const shortOf = (a: Assignment) => (a.type === 'READONLY' ? a.record.type : t(`advanced.short${a.type}`));
const titleOf = (a: Assignment) => (a.type === 'READONLY' ? a.record.type : t(`advanced.type${a.type}`));
const SOCD_NAMES: MessageKey[] = ['advanced.socdLast', 'advanced.socdA', 'advanced.socdB', 'advanced.socdNeutral'];

function readOnlyDetail(r: AdvancedRecord): string {
  switch (r.type) {
    case 'MT': return t('advanced.mtDetail', { tap: code(r.keycodes[0]), hold: code(r.keycodes[1]), time: r.time });
    case 'TGL': return t('advanced.tglDetail', { key: code(r.keycode), time: r.time });
    case 'END': return t('advanced.endDetail', { press: code(r.keycodes[0]), release: code(r.keycodes[1]), delay: r.delay });
    case 'SOCD': case 'RS': return t('advanced.orphanDetail');
    default: return t('advanced.unknownDetail', { mode: r.mode });
  }
}
function detailOf(a: Assignment): string {
  switch (a.type) {
    case 'DKS': return `${a.keycodes.filter((c) => c).map(code).join(' · ')} — ${a.dbs[0].toFixed(1)}–${a.dbs[1].toFixed(1)} mm`;
    case 'MPT': return a.keycodes.map((c, i) => (c ? `${code(c)} @${a.depths[i].toFixed(1)}` : '')).filter(Boolean).join(' · ');
    case 'SOCD': return `${t(SOCD_NAMES[a.mode])} · ${t('advanced.pairDetail', { a: code(a.keycodes[0]), b: code(a.keycodes[1]), delay: a.delay })}`;
    case 'RS': return t('advanced.pairDetail', { a: code(a.keycodes[0]), b: code(a.keycodes[1]), delay: a.delay });
    case 'READONLY': return readOnlyDetail(a.record);
  }
}
const keysOf = (a: Assignment) => a.keys.map(keyName).join(a.type === 'SOCD' || a.type === 'RS' ? ' ↔ ' : ', ');

// ----- keyboard
function sublabel(k: PhysicalKey): string | undefined {
  const d = draft.value;
  if (d) {
    const i = d.keys.indexOf(k.id);
    if (i >= 0) return d.keys.length === 2 ? `${t(`advanced.short${d.type}`)}·${i ? 'B' : 'A'}` : t(`advanced.short${d.type}`);
  }
  const a = adv.byKey.get(k.id);
  if (!a || (editing.value && sameSlot(a, editing.value))) return undefined;
  if (a.type === 'SOCD' || a.type === 'RS') return `${shortOf(a)}·${a.keys[0] === k.id ? 'A' : 'B'}`;
  return shortOf(a);
}
/** The colour of the kind a key's sublabel names (same precedence as the sublabel). */
const kindVar = (kind: string) => (['DKS', 'MPT', 'SOCD', 'RS', 'MT', 'TGL', 'END'].includes(kind) ? `var(--k-${kind.toLowerCase()})` : undefined);
function tone(k: PhysicalKey): string | undefined {
  const d = draft.value;
  if (d && d.keys.includes(k.id)) return kindVar(d.type);
  const a = adv.byKey.get(k.id);
  if (!a || (editing.value && sameSlot(a, editing.value))) return undefined;
  return kindVar(a.type === 'READONLY' ? a.record.type : a.type);
}
const kindStyle = (kind: string) => ({ '--k': kindVar(kind) });
const highlighted = computed(() => new Set(sel.ids.map((id) => adv.byKey.get(id)).filter(Boolean)));

// ----- editor
let internal = false;
function selectKeys(ids: number[]) {
  internal = true;
  sel.selectMany(ids.filter((id) => id >= 0));
  internal = false;
}

function blank(type: WritableType): WritableAssignment {
  switch (type) {
    case 'DKS': return { type, keys: [-1], keycodes: [0, 0, 0, 0], travels: [0, 0, 0, 0], dbs: [...DKS_DEFAULT_DBS] };
    case 'MPT': return { type, keys: [-1], keycodes: [0, 0, 0], depths: [0.5, 1, 1.5] };
    case 'SOCD': return { type, keys: [-1, -1], keycodes: [0, 0], delay: 0, mode: 0 };
    case 'RS': return { type, keys: [-1, -1], keycodes: [0, 0], delay: 0 };
  }
}

const itemSelector = (type: string, keys: readonly number[]) => `[data-item="${type}:${[...keys].sort((x, y) => x - y).join(',')}"] .item__main`;
function focusSoon(selector: string) {
  void nextTick(() => (document.querySelector<HTMLElement>(selector) ?? document.querySelector<HTMLElement>('.type, .item__main:not(:disabled)'))?.focus());
}

function start(type: WritableType) {
  const picked = sel.ids;
  const opened = !!draft.value;
  editing.value = null;
  draft.value = blank(type);
  pairSlot.value = 0;
  attempted.value = false;
  rebase(); // an empty draft is clean while the selected key(s) are pre-picked
  const taken = (id: number) => adv.byKey.get(id)?.type === type; // adding never jumps into an existing binding
  if (type === 'DKS' || type === 'MPT') {
    const first = sel.focused !== null && sel.selected.has(sel.focused) ? sel.focused : picked[0];
    if (picked.length === 1 && first !== undefined) { if (!taken(first)) chooseKey(first); }
    else if (picked.length > 1) toast.show(t('advanced.multiPicked'), 'warn');
  } else if (picked.length === 2) {
    if (!picked.some(taken)) {
      chooseKey(picked[0]);
      chooseKey(picked[1]);
    }
  } else if (picked.length > 2) toast.show(t('advanced.multiPicked'), 'warn');
  rebase();
  selectKeys(draft.value?.keys ?? []);
  if (!opened) focusSoon('.ed__title');
}

async function loadMptMax(id: number) {
  try {
    mptMax.value = mptLimit(await adv.performanceOf(id));
  } catch {
    mptMax.value = 3.3;
  }
  const d = draft.value;
  if (d?.type === 'MPT' && d.keys[0] === id) {
    const clean = !dirty.value;
    draft.value = { ...d, depths: normalizeMptDepths(d.depths, mptMax.value) };
    if (clean) rebase();
  }
}

function edit(a: Assignment) {
  if (a.type === 'READONLY') return;
  const opened = !!draft.value;
  editing.value = a;
  draft.value = structuredClone({ ...a, keys: [...a.keys] }) as WritableAssignment;
  pairSlot.value = 0;
  attempted.value = false;
  rebase();
  if (a.type === 'MPT') void loadMptMax(a.keys[0]);
  selectKeys([...a.keys]);
  if (!opened) focusSoon('.ed__title');
}

function close() {
  const d = draft.value;
  draft.value = null;
  editing.value = null;
  baseline.value = '';
  attempted.value = false;
  selectKeys([]); // the selection must not leak into the next "add"
  if (d) focusSoon(itemSelector(d.type, d.keys)); // falls back to the first type button
}

function chooseKey(id: number) {
  const clean = !dirty.value;
  applyKey(id);
  if (clean && !editing.value) rebase(); // picking a key alone is not unsaved work
}

function applyKey(id: number) {
  const d = draft.value;
  if (!d) return;
  const l0 = device.layer0[id];
  if (d.type === 'DKS' || d.type === 'MPT') {
    if (d.keys[0] === id) return;
    const ok = d.type === 'DKS' ? dksHostEligible(l0) : mptHostEligible(l0);
    if (!ok) {
      toast.show(t('advanced.hostIneligible', { type: t(`advanced.type${d.type}`) }), 'warn');
      return;
    }
    const existing = adv.byKey.get(id);
    if (existing && existing.type === d.type && !editing.value) return guard(() => edit(existing));
    if (d.type === 'MPT') {
      const allowed = [...MPT_BASIC_CODES, ...MPT_EXTENDED_CODES].includes(l0);
      const keycodes: MptAssignment['keycodes'] = d.keycodes[0] || !allowed ? [...d.keycodes] : [l0, d.keycodes[1], d.keycodes[2]];
      draft.value = { ...d, keys: [id], keycodes };
      void loadMptMax(id);
    } else draft.value = { ...d, keys: [id] };
    return;
  }
  const picked = pickPairKey(d, pairSlot.value, id, l0);
  if (!picked) return;
  draft.value = picked.draft;
  pairSlot.value = picked.slot;
  const keys = picked.draft.keys;
  if (keys[0] >= 0 && keys[1] >= 0 && !editing.value) {
    const existing = adv.byKey.get(keys[0]);
    if (existing && existing.type === d.type && existing.keys.includes(keys[1])) guard(() => edit(existing));
  }
}

watch(() => sel.selected, (now) => {
  if (internal || !draft.value) return;
  // One key at a time while editing (WASD / All / Invert / box select would silently re-target the draft).
  if (now.size > 1) { selectKeys(draft.value.keys); return; }
  const id = sel.focused !== null && now.has(sel.focused) ? sel.focused : [...now][0];
  if (id !== undefined) chooseKey(id);
  selectKeys(draft.value?.keys ?? []);
}, { flush: 'sync' });

const keysChosen = computed(() => !!draft.value && draft.value.keys.every((k) => k >= 0));
const conflict = computed(() => (draft.value && keysChosen.value ? adv.conflictFor(draft.value, editing.value) : null));
const problem = computed(() => {
  const d = draft.value;
  if (!d || !keysChosen.value) return null;
  return validateAssignment(d, { firmware: device.info?.firmware, layer0: (id) => device.layer0[id], mptMax: mptMax.value });
});
const shownProblem = computed(() => (attempted.value ? problem.value : null));
const pickHint = computed(() => {
  const d = draft.value;
  if (!d) return '';
  if (d.keys.length === 1) return t('advanced.pickHost', { type: t(`advanced.type${d.type}`) });
  const slot = pairSlot.value;
  const filled = d.keys[slot] >= 0;
  if (slot === 0) return t(filled ? 'advanced.changePairA' : 'advanced.pickPairA');
  return t(filled ? 'advanced.changePairB' : 'advanced.pickPairB');
});
/** Editing an existing assignment onto other key(s): said before Save and in the toast. */
const moved = computed(() => {
  const e = editing.value;
  const d = draft.value;
  if (!e || !d || !keysChosen.value) return null;
  const ids = (k: readonly number[]) => [...k].sort((x, y) => x - y).join(',');
  if (ids(e.keys) === ids(d.keys)) return null;
  return t('advanced.moveHost', { type: t(`advanced.type${d.type}`), from: keysOf(e), to: keysOf(d) });
});
const canSave = computed(() => keysChosen.value && !conflict.value && !saving.value);

async function save() {
  const d = draft.value;
  if (!d || !canSave.value) return;
  if (problem.value) { attempted.value = true; return; }
  const from = editing.value;
  const movedKeys = moved.value !== null;
  saving.value = true;
  try {
    await adv.save(d, from);
    const type = t(`advanced.type${d.type}`);
    toast.show(movedKeys && from ? t('advanced.savedMoved', { type, from: keysOf(from), to: keysOf(d) }) : t('advanced.saved', { type, keys: keysOf(d) }), 'success');
    close();
  } catch (err) {
    if (!(err instanceof AdvancedConflictError)) toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    saving.value = false;
  }
}

async function confirmRemove() {
  const a = confirmDel.value;
  if (!a) return;
  removing.value = true;
  try {
    await adv.remove(a);
    toast.show(t('advanced.removed', { type: titleOf(a), keys: keysOf(a) }), 'success');
    if (editing.value && sameSlot(editing.value, a)) close();
    else focusSoon('.item__main:not(:disabled)');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    removing.value = false;
    confirmDel.value = null;
  }
}

const dks = computed({ get: () => draft.value as DksAssignment, set: (v) => { draft.value = v; } });
const mpt = computed({ get: () => draft.value as MptAssignment, set: (v) => { draft.value = v; } });
const pair = computed({ get: () => draft.value as SocdAssignment | RsAssignment, set: (v) => { draft.value = v; } });
</script>

<template>
  <PageLayout :title="t('page.advanced')" keyboard>
    <template #keyboard>
      <KeyboardView :keys="device.keys" :legend="device.legend" :sublabel="sublabel" :tone="tone" :loading="adv.loading" selectable />
    </template>

    <Card v-if="adv.loadError" :title="t('advanced.loadFailed')" :subtitle="adv.loadError">
      <div><Button :icon="IconRefresh" @click="adv.load(true)">{{ t('advanced.reload') }}</Button></div>
    </Card>

    <div v-else-if="adv.loading" class="cols" aria-busy="true">
      <div class="skel-card">
        <p class="loading num">{{ t('advanced.loading', { n: adv.loadedCount, total: device.keys.length }) }}</p>
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 52px" />
      </div>
      <div class="skel-card">
        <div class="skeleton" style="width: 40%; height: 14px" />
        <div class="skeleton" style="height: 160px" />
      </div>
    </div>

    <!-- editor -->
    <Card v-else-if="draft" class="editor">
      <header class="ed__head">
        <IconButton :icon="IconArrowLeft" :label="t('advanced.back')" size="sm" @click="guard(close)" />
        <span class="ed__icon" :style="kindStyle(draft.type)"><component :is="ICONS[draft.type]" :size="20" stroke-width="1.6" /></span>
        <div class="ed__titles">
          <h2 class="ed__title" tabindex="-1">{{ editing ? t('advanced.editTitle', { type: t(`advanced.type${draft.type}`) }) : t('advanced.newTitle', { type: t(`advanced.type${draft.type}`) }) }}</h2>
          <p class="ed__sub">{{ t(`advanced.desc${draft.type}`) }}</p>
        </div>
        <div v-if="draft.keys.length === 1" class="ed__host">
          <span class="micro">{{ t('advanced.host') }}</span>
          <b :class="{ muted: draft.keys[0] < 0 }">{{ draft.keys[0] >= 0 ? keyName(draft.keys[0]) : t('advanced.notChosen') }}</b>
        </div>
      </header>

      <p class="ed__hint" :class="{ 'ed__hint--todo': !keysChosen }" aria-live="polite">
        <IconHandClick :size="16" stroke-width="1.6" aria-hidden="true" />{{ pickHint }}
      </p>

      <p v-if="moved" class="ed__move" role="status"><IconArrowsLeftRight :size="16" stroke-width="1.6" aria-hidden="true" />{{ moved }}</p>

      <div v-if="conflict" class="banner" role="alert">
        <IconAlertTriangle :size="18" stroke-width="1.6" aria-hidden="true" />
        <span>{{ t('advanced.conflictBanner', { key: keyName(draft.keys.find((k) => conflict!.keys.includes(k))!), type: titleOf(conflict), keys: keysOf(conflict) }) }}</span>
        <Button variant="danger" size="sm" :icon="IconTrash" @click="confirmDel = conflict">{{ t('advanced.deleteConflict', { type: titleOf(conflict) }) }}</Button>
      </div>

      <div class="ed__body" :class="{ 'ed__body--off': !keysChosen && draft.keys.length === 1 }">
        <DksEditor v-if="draft.type === 'DKS'" v-model="dks" :firmware="device.info?.firmware" />
        <MptEditor v-else-if="draft.type === 'MPT'" v-model="mpt" :max="mptMax" />
        <PairEditor v-else v-model="pair" v-model:slot="pairSlot" :key-name="keyName" />
      </div>

      <footer class="ed__foot">
        <p class="ed__note" aria-live="polite">
          <span v-if="shownProblem" class="ed__problem">{{ shownProblem }}</span>
          <span v-else>{{ t('advanced.hallNote') }}</span>
        </p>
        <Button v-if="editing" variant="ghost" :icon="IconTrash" @click="confirmDel = editing">{{ t('advanced.delete') }}</Button>
        <Button variant="secondary" @click="guard(close)">{{ t('advanced.cancel') }}</Button>
        <Button variant="primary" :loading="saving" :disabled="!canSave" @click="save">{{ saving ? t('advanced.saving') : t('advanced.save') }}</Button>
      </footer>
    </Card>

    <!-- overview -->
    <div v-else class="cols">
      <Card :title="t('advanced.types')" :subtitle="t('advanced.typesHint')">
        <div class="types">
          <button v-for="x in TYPES" :key="x.type" type="button" class="type" :data-type="x.type" :style="kindStyle(x.type)" @click="start(x.type)">
            <span class="type__icon"><component :is="x.icon" :size="20" stroke-width="1.6" /></span>
            <span class="type__text">
              <span class="type__name">{{ t(`advanced.type${x.type}`) }}
                <span class="type__keys">{{ t(x.keys) }}</span>
              </span>
              <span class="type__desc">{{ t(x.desc) }}</span>
            </span>
            <span class="type__go"><IconChevronRight :size="16" /></span>
          </button>
        </div>
        <p class="types__note"><IconLock :size="12" stroke-width="2" aria-hidden="true" />{{ t('advanced.unsupportedNote') }}</p>
      </Card>

      <Card :title="t('advanced.configured')" :subtitle="adv.assignments.length ? t('advanced.configuredCount', { n: adv.assignments.length }) : undefined">
        <div v-if="!adv.assignments.length" class="empty">
          <IconTimeline :size="28" stroke-width="1.4" aria-hidden="true" />
          <p>{{ t('advanced.none') }}</p>
          <p class="muted">{{ t('advanced.noneHint') }}</p>
        </div>
        <ul v-else class="list">
          <li v-for="a in adv.assignments" :key="`${a.type}:${a.keys.join(',')}`" class="item" :data-item="`${a.type === 'READONLY' ? a.record.type : a.type}:${[...a.keys].sort((x, y) => x - y).join(',')}`" :class="{ 'item--hl': highlighted.has(a) }" :style="kindStyle(a.type === 'READONLY' ? a.record.type : a.type)">
            <span class="item__icon"><component :is="ICONS[a.type === 'READONLY' ? a.record.type : a.type] ?? IconTimeline" :size="18" stroke-width="1.6" /></span>
            <button type="button" class="item__main" :disabled="a.type === 'READONLY'" @click="edit(a)">
              <span class="item__top">
                <span class="item__type">{{ shortOf(a) }}</span>
                <span class="item__keys">{{ keysOf(a) }}</span>
                <span v-if="a.type === 'READONLY'" class="item__ro"><IconLock :size="11" stroke-width="2" />{{ t('advanced.readOnly') }}</span>
              </span>
              <span class="item__detail">{{ detailOf(a) }}</span>
            </button>
            <IconButton v-if="a.type !== 'READONLY'" :icon="IconPencil" :label="t('advanced.edit')" size="sm" @click="edit(a)" />
            <IconButton :icon="IconTrash" :label="t('advanced.delete')" size="sm" @click="confirmDel = a" />
          </li>
        </ul>
      </Card>
    </div>

    <Dialog v-model:open="confirmOpen" :title="confirmDel ? t('advanced.confirmDelete', { type: titleOf(confirmDel), keys: keysOf(confirmDel) }) : ''">
      <p v-if="confirmDel">{{ t('advanced.deleteLoses', { detail: detailOf(confirmDel) }) }}</p>
      <p v-if="confirmDel?.type === 'READONLY'" class="warn">{{ t('advanced.confirmDeleteRo') }}</p>
      <template #footer>
        <Button variant="secondary" @click="confirmDel = null">{{ t('advanced.cancel') }}</Button>
        <Button variant="danger" :icon="IconTrash" :loading="removing" @click="confirmRemove">{{ t('advanced.delete') }}</Button>
      </template>
    </Dialog>

    <Dialog v-model:open="discardOpen" :title="t('advanced.discardTitle')">
      <p>{{ t('advanced.discardBody') }}</p>
      <template #footer>
        <Button variant="secondary" @click="discardAsk = null">{{ t('advanced.discardKeep') }}</Button>
        <Button variant="danger" @click="confirmDiscard">{{ t('advanced.discardDo') }}</Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.cols { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: var(--s-4); align-items: start; }
@media (max-width: 1000px) { .cols { grid-template-columns: 1fr; } }
.loading { color: var(--fg-3); }
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
.warn { color: var(--warn); }

/* types */
.types { display: flex; flex-direction: column; gap: 6px; }
.type {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 10px 12px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.type:hover { background: var(--bg-4); border-color: var(--acc-line); }
.type:active { transform: translateY(1px); }
.type__icon {
  width: 36px;
  height: 36px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 8px;
  background: color-mix(in srgb, var(--k, var(--acc)) 16%, transparent);
  color: var(--k, var(--acc));
}
.type__text { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.type__name { font-weight: 600; display: flex; align-items: center; gap: var(--s-2); }
.type__keys { font-size: var(--fs-caption); font-weight: 500; color: var(--fg-3); padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line-2); }
.type__desc { font-size: var(--fs-label); color: var(--fg-3); line-height: 1.35; }
.type__go { color: var(--fg-3); }
.type:hover .type__go { color: var(--acc); }
.types__note { display: flex; align-items: flex-start; gap: 6px; margin: var(--s-3) 0 0; font-size: var(--fs-label); color: var(--fg-3); }
.types__note svg { flex: none; margin-top: 3px; }
.item__ro {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--fs-caption);
  color: var(--fg-3);
  white-space: nowrap;
}

/* configured list */
.empty { display: flex; flex-direction: column; align-items: center; gap: var(--s-2); padding: var(--s-7) 0; color: var(--fg-3); text-align: center; }
.empty p { margin: 0; color: var(--fg-2); }
.empty .muted { color: var(--fg-3); }
.list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.item {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  padding: 6px 8px 6px 12px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-1);
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.item:hover { border-color: var(--line-3); }
.item--hl { border-color: color-mix(in srgb, var(--k, var(--acc)) 45%, transparent); background: color-mix(in srgb, var(--k, var(--acc)) var(--soft-pct), transparent); }
.item__icon { color: var(--k, var(--acc)); display: grid; place-items: center; }
.item__main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; padding: 4px 6px; border: 0; background: transparent; text-align: left; }
.item__main:disabled { cursor: default; }
.item__top { display: flex; align-items: center; gap: var(--s-2); }
.item__type { font-size: var(--fs-caption); font-weight: 600; color: var(--k, var(--acc)); }
.item--hl .item__type { color: var(--fg-1); }
.item__keys { font-weight: 600; color: var(--fg-1); }
.item__detail { font-size: var(--fs-label); color: var(--fg-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* editor */
.editor { animation: rise var(--t-slow) var(--ease); }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.ed__head { display: flex; align-items: center; gap: var(--s-3); }
.ed__icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 9px; background: color-mix(in srgb, var(--k, var(--acc)) 16%, transparent); color: var(--k, var(--acc)); flex: none; }
.ed__titles { flex: 1; min-width: 0; }
.ed__title { margin: 0; font-size: var(--fs-section); font-weight: 600; }
.ed__sub { margin: 2px 0 0; color: var(--fg-3); font-size: var(--fs-label); }
.ed__host { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; }
.ed__host .micro { color: var(--fg-3); }
.ed__host b { font-size: var(--fs-section); }
.ed__host b.muted { font-size: var(--fs-body); font-weight: 500; }
.ed__hint {
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin: var(--s-4) 0;
  color: var(--fg-3);
  font-size: var(--fs-label);
}
.ed__hint--todo { color: var(--acc); }
.ed__move { display: flex; align-items: center; gap: var(--s-2); margin: 0 0 var(--s-4); padding: 8px 12px; border-radius: var(--r-control); background: var(--info-soft); color: var(--fg-1); font-weight: 500; }
.ed__move svg { color: var(--info); flex: none; }
.ed__body { transition: opacity var(--t-fast) var(--ease); }
.ed__body--off { opacity: 0.45; pointer-events: none; }
.banner {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  margin-bottom: var(--s-4);
  padding: 10px 12px;
  border-radius: var(--r-control);
  background: var(--warn-soft);
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  color: var(--warn);
}
.banner span { flex: 1; color: var(--fg-1); }
.banner b { color: var(--warn); margin-left: 4px; }
/* Sticky: Save stays on screen however tall the editor is (1280×720 shows the keyboard and Save together). */
.ed__foot {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: var(--s-2);
  margin: var(--s-5) calc(-1 * var(--s-5)) calc(-1 * var(--s-5));
  padding: var(--s-3) var(--s-5);
  background: var(--bg-2);
  border-top: 1px solid var(--line-1);
  border-radius: 0 0 var(--r-card) var(--r-card);
}
.ed__note { flex: 1; margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.ed__problem { color: var(--warn); }
</style>
