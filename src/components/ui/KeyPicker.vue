<script setup lang="ts">
// Keycode picker: group tabs (KEYCODE_GROUPS) + search across all groups + modifier-combo builder.
// With modifiers selected, picking a standard key emits (mask << 8) | key, as the factory driver does.
import { computed, onMounted, ref, watch } from 'vue';
import { IconSearch } from '@tabler/icons-vue';
import Tabs from './Tabs.vue';
import { COMBO_MODIFIERS, KEYCODE_GROUPS, comboKeycode, decodeCombo, isComboTrigger, keycodeLabel } from '../../protocol';
import type { KeycodeEntry } from '../../protocol';
import { t } from '../../i18n/vi';

const props = defineProps<{ current?: number | null }>();
const emit = defineEmits<{ pick: [code: number] }>();

const groupOf = (code: number) => KEYCODE_GROUPS.find((g) => g.codes.some((e) => e.code === code))?.id;
// An existing combo preselects its modifiers and shows its trigger key.
const comboOf = (code: number | null | undefined) => (code == null ? null : decodeCombo(code));
const initial = comboOf(props.current);

const group = ref(groupOf(initial ? initial.trigger : props.current ?? -1) ?? KEYCODE_GROUPS[0].id);
const query = ref('');
const mask = ref(initial?.mask ?? 0);
const searchInput = ref<HTMLInputElement | null>(null);
let lastPicked: number | null = null;

onMounted(() => searchInput.value?.focus());
// A different key was selected (not the echo of our own pick): load its combo again.
watch(() => props.current, (code) => {
  if (code === lastPicked) return;
  const c = comboOf(code);
  mask.value = c?.mask ?? 0;
  group.value = groupOf(c ? c.trigger : code ?? -1) ?? group.value;
});

const searching = computed(() => query.value.trim() !== '');
const tabs = KEYCODE_GROUPS.map((g) => ({ id: g.id, label: g.label }));
function selectGroup(id: string) {
  query.value = '';
  group.value = id;
}
function onEsc(ev: KeyboardEvent) {
  if (!query.value) return; // nothing to clear: let the dialog close
  ev.stopPropagation();
  query.value = '';
}
const entries = computed<KeycodeEntry[]>(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return KEYCODE_GROUPS.find((g) => g.id === group.value)?.codes ?? [];
  return KEYCODE_GROUPS.flatMap((g) => g.codes).filter((e) =>
    e.label.toLowerCase().includes(q) || (e.long ?? '').toLowerCase().includes(q) || e.code.toString(16) === q.replace(/^0x/, ''));
});
const comboPreview = computed(() => {
  const mods = COMBO_MODIFIERS.filter((m) => mask.value & m.bit).map((m) => m.short);
  return mods.length ? `${mods.join(' + ')} + …` : '';
});

function toggleMod(bit: number) {
  mask.value ^= bit;
}
function disabled(e: KeycodeEntry) {
  return mask.value !== 0 && !isComboTrigger(e.code);
}
function pick(e: KeycodeEntry) {
  if (disabled(e)) return;
  const code = mask.value ? comboKeycode(mask.value, e.code) : e.code;
  lastPicked = code;
  mask.value = 0; // modifiers apply to one pick only
  emit('pick', code);
}
const isCurrent = (e: KeycodeEntry) => props.current === e.code || comboOf(props.current)?.trigger === e.code;
</script>

<template>
  <div class="kp">
    <label class="kp__search">
      <IconSearch :size="15" stroke-width="1.5" aria-hidden="true" />
      <input
        ref="searchInput"
        v-model="query"
        type="search"
        :placeholder="t('picker.search')"
        :aria-label="t('picker.search')"
        @keydown.esc="onEsc"
      >
    </label>
    <Tabs :model-value="searching ? '' : group" :items="tabs" :label="t('picker.groups')" class="kp__tabs" @update:model-value="selectGroup" />

    <div class="kp__combo">
      <span class="micro">{{ t('picker.combo') }}</span>
      <div class="kp__mods">
        <button
          v-for="m in COMBO_MODIFIERS"
          :key="m.bit"
          type="button"
          class="kp__mod"
          :aria-pressed="(mask & m.bit) !== 0"
          :title="m.label"
          @click="toggleMod(m.bit)"
        >
          {{ m.short }}
        </button>
        <button v-if="mask" type="button" class="kp__mod kp__mod--clear" @click="mask = 0">{{ t('picker.comboClear') }}</button>
      </div>
      <span class="kp__hint">{{ mask ? comboPreview : t('picker.comboHint') }}</span>
    </div>

    <div v-if="entries.length" class="kp__grid">
      <button
        v-for="e in entries"
        :key="e.code"
        type="button"
        class="kp__key"
        :class="{ 'kp__key--current': isCurrent(e) }"
        :disabled="disabled(e)"
        :aria-description="disabled(e) ? t('error.comboTriggerStandard') : undefined"
        :title="`${e.long ?? e.label} · 0x${e.code.toString(16).padStart(4, '0').toUpperCase()}${disabled(e) ? ` — ${t('error.comboTriggerStandard')}` : ''}`"
        @click="pick(e)"
      >
        <span class="kp__label">{{ e.label }}</span>
        <span v-if="e.long" class="kp__long">{{ e.long }}</span>
      </button>
    </div>
    <p v-else class="kp__empty">{{ t('picker.noResults') }}</p>
    <p v-if="current != null" class="kp__current">
      <span class="micro">{{ t('picker.current') }}</span> {{ keycodeLabel(current).long }}
    </p>
  </div>
</template>

<style scoped>
.kp { display: flex; flex-direction: column; gap: var(--s-3); min-width: 0; }
.kp__tabs { min-width: 0; }
.kp__search {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px;
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-1);
  color: var(--fg-3);
}
.kp__search:focus-within { border-color: var(--acc-line); box-shadow: var(--focus-ring); }
.kp__search input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: var(--fs-body); }
.kp__search input:focus-visible { box-shadow: none; }
.kp__combo { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
.kp__mods { display: flex; gap: 4px; flex-wrap: wrap; }
.kp__mod {
  height: 26px;
  padding: 0 9px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-2);
  background: var(--bg-3);
  color: var(--fg-2);
  font-size: var(--fs-label);
  font-weight: 500;
  transition: all var(--t-fast) var(--ease);
}
.kp__mod:hover { color: var(--fg-1); border-color: var(--line-3); }
.kp__mod[aria-pressed='true'] { background: var(--acc-soft); border-color: var(--acc-line); color: var(--acc); }
.kp__mod--clear { background: transparent; border-color: transparent; color: var(--fg-3); }
.kp__hint { color: var(--fg-3); font-size: var(--fs-label); }
.kp__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 6px;
  max-height: 260px;
  overflow-y: auto;
  padding: 2px;
}
.kp__key {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 1px;
  min-height: 44px;
  padding: 6px 9px;
  border-radius: var(--r-key);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  text-align: left;
  box-shadow: inset 0 1px 0 var(--cap-hi), inset 0 -2px 0 var(--cap-shade);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.kp__key:hover:not(:disabled) { background: var(--bg-4); border-color: var(--line-3); }
.kp__key:active:not(:disabled) { transform: translateY(1px); }
.kp__key:disabled { opacity: 0.3; cursor: not-allowed; }
.kp__key--current { border-color: var(--acc); background: var(--acc-soft); }
.kp__label { font-size: var(--fs-label); font-weight: 500; color: var(--fg-1); }
.kp__long { font-size: 10px; color: var(--fg-3); line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.kp__empty { color: var(--fg-3); padding: var(--s-4) 0; }
.kp__current { color: var(--fg-2); font-size: var(--fs-label); display: flex; gap: var(--s-2); align-items: baseline; }
</style>
