<script setup lang="ts">
// Button showing an output keycode (or "Chọn phím"); opens the OutputPicker in the parent.
import { computed } from 'vue';
import { keycodeLabel } from '../../protocol';
import { t } from '../../i18n/vi';

const props = defineProps<{ code: number; caption?: string; accent?: string; disabled?: boolean }>();
defineEmits<{ click: [] }>();
const label = computed(() => (props.code ? keycodeLabel(props.code) : null));
</script>

<template>
  <button
    type="button"
    class="os"
    :class="{ 'os--empty': !code }"
    :style="accent ? { '--os-acc': accent } : undefined"
    :disabled="disabled"
    :title="label?.long"
    @click="$emit('click')"
  >
    <span v-if="caption" class="os__cap micro">{{ caption }}</span>
    <span class="os__key">{{ label ? label.label : t('advanced.chooseKey') }}</span>
  </button>
</template>

<style scoped>
.os {
  --os-acc: var(--acc);
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  justify-content: center;
  gap: 1px;
  min-width: 92px;
  height: 44px;
  padding: 0 12px;
  border-radius: var(--r-key);
  border: 1px solid var(--line-2);
  border-left: 3px solid var(--os-acc);
  background: var(--bg-3);
  text-align: left;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), inset 0 -2px 0 rgba(0, 0, 0, 0.3);
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease), transform var(--t-fast) var(--ease);
}
.os:hover:not(:disabled) { background: var(--bg-4); border-color: var(--line-3); border-left-color: var(--os-acc); }
.os:active:not(:disabled) { transform: translateY(1px); }
.os:disabled { opacity: 0.45; cursor: not-allowed; }
.os__key { font-weight: 600; font-size: var(--fs-body); color: var(--fg-1); white-space: nowrap; }
.os--empty { border-style: dashed; border-left-style: solid; background: transparent; }
.os--empty .os__key { color: var(--fg-3); font-weight: 500; }
</style>
