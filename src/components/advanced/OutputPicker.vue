<script setup lang="ts">
// Restricted keycode picker: only the usages a feature allows (reference palettes), grouped with search.
// Used where the shared KeyPicker would offer codes the firmware rejects (DKS, MPT, SOCD/RS, macro actions).
import { computed, onMounted, ref, watch } from 'vue';
import { IconSearch } from '@tabler/icons-vue';
import Tabs from '../ui/Tabs.vue';
import Button from '../ui/Button.vue';
import { keycodeLabel } from '../../protocol';
import type { OutputGroup } from '../../stores/advanced';
import { t } from '../../i18n/vi';

const props = defineProps<{
  groups: OutputGroup[];
  current?: number | null;
  /** Codes shown but not pickable (e.g. already used by another MPT stage). */
  disabledCodes?: number[];
  /** Why `disabledCodes` are not pickable; shown as the tooltip / description of those keys. */
  disabledReason?: string;
  note?: string;
  clearLabel?: string;
}>();
const emit = defineEmits<{ pick: [code: number]; clear: [] }>();

const group = ref(props.groups.find((g) => g.codes.includes(props.current ?? -1))?.id ?? props.groups[0]?.id ?? '');
const query = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
onMounted(() => searchInput.value?.focus());
const searching = computed(() => query.value.trim() !== '');
function selectGroup(id: string) {
  query.value = '';
  group.value = id;
}
function onEsc(ev: KeyboardEvent) {
  if (!query.value) return; // nothing to clear: let the dialog close
  ev.stopPropagation();
  query.value = '';
}
const isDisabled = (code: number) => !!props.disabledCodes?.includes(code) && props.current !== code;
watch(() => props.groups, (gs) => { if (!gs.some((g) => g.id === group.value)) group.value = gs[0]?.id ?? ''; });

const tabs = computed(() => props.groups.map((g) => ({ id: g.id, label: `${g.label} · ${g.codes.length}` })));
const entries = computed(() => {
  const q = query.value.trim().toLowerCase();
  const codes = q ? [...new Set(props.groups.flatMap((g) => g.codes))] : props.groups.find((g) => g.id === group.value)?.codes ?? [];
  return codes
    .map((code) => ({ code, ...keycodeLabel(code) }))
    .filter((e) => !q || e.label.toLowerCase().includes(q) || (e.long ?? '').toLowerCase().includes(q) || e.code.toString(16) === q.replace(/^0x/, ''));
});
const hex = (c: number) => `0x${c.toString(16).padStart(4, '0').toUpperCase()}`;
</script>

<template>
  <div class="op">
    <label class="op__search">
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
    <Tabs :model-value="searching ? '' : group" :items="tabs" :label="t('advanced.pickerTitle')" class="op__tabs" @update:model-value="selectGroup" />
    <div v-if="entries.length" class="op__grid">
      <button
        v-for="e in entries"
        :key="e.code"
        type="button"
        class="op__key"
        :class="{ 'op__key--current': current === e.code }"
        :disabled="isDisabled(e.code)"
        :aria-description="isDisabled(e.code) ? disabledReason : undefined"
        :title="`${e.long ?? e.label} · ${hex(e.code)}${isDisabled(e.code) && disabledReason ? ` — ${disabledReason}` : ''}`"
        @click="emit('pick', e.code)"
      >
        <span class="op__label">{{ e.label }}</span>
        <span class="op__long">{{ e.long !== e.label ? e.long : hex(e.code) }}</span>
      </button>
    </div>
    <p v-else class="op__empty">{{ t('picker.noResults') }}</p>
    <div class="op__foot">
      <span v-if="note" class="op__note">{{ note }}</span>
      <Button v-if="clearLabel && current" variant="ghost" size="sm" @click="emit('clear')">{{ clearLabel }}</Button>
    </div>
  </div>
</template>

<style scoped>
.op { display: flex; flex-direction: column; gap: var(--s-3); min-width: 0; }
.op__tabs { min-width: 0; }
.op__search {
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
.op__search:focus-within { border-color: var(--acc-line); box-shadow: var(--focus-ring); }
.op__search input { flex: 1; min-width: 0; border: 0; background: transparent; font-size: var(--fs-body); }
.op__search input:focus-visible { box-shadow: none; }
.op__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(84px, 1fr));
  gap: 6px;
  max-height: 300px;
  overflow-y: auto;
  padding: 2px;
}
.op__key {
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
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), inset 0 -2px 0 rgba(0, 0, 0, 0.3);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.op__key:hover:not(:disabled) { background: var(--bg-4); border-color: var(--line-3); }
.op__key:active:not(:disabled) { transform: translateY(1px); }
.op__key:disabled { opacity: 0.3; cursor: not-allowed; }
.op__key--current { border-color: var(--acc); background: var(--acc-soft); }
.op__label { font-size: var(--fs-label); font-weight: 500; color: var(--fg-1); }
.op__long { font-size: 10px; color: var(--fg-3); line-height: 1.2; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
.op__empty { color: var(--fg-3); padding: var(--s-4) 0; }
.op__foot { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); min-height: 28px; }
.op__note { color: var(--fg-3); font-size: var(--fs-label); }
</style>
