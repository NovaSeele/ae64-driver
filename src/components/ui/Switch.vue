<script setup lang="ts">
const model = defineModel<boolean>({ required: true });
defineProps<{ label?: string; disabled?: boolean }>();
</script>

<template>
  <span class="sw" :class="{ 'sw--disabled': disabled }">
    <button
      type="button"
      role="switch"
      class="sw__track"
      :aria-checked="model"
      :aria-label="label"
      :disabled="disabled"
      @click="model = !model"
    >
      <span class="sw__thumb" />
    </button>
    <span v-if="label" class="sw__label" aria-hidden="true" @click="!disabled && (model = !model)">{{ label }}</span>
  </span>
</template>

<style scoped>
.sw { display: inline-flex; align-items: center; gap: var(--s-2); user-select: none; }
.sw--disabled { opacity: 0.45; }
.sw__track {
  position: relative;
  flex: none;
  width: 34px;
  height: 20px;
  padding: 0;
  border-radius: 10px;
  border: 1px solid var(--line-2);
  background: var(--bg-4);
  transition: background var(--t-med) var(--ease), border-color var(--t-med) var(--ease);
}
.sw__track:disabled { cursor: not-allowed; }
.sw__track[aria-checked='true'] { background: var(--acc); border-color: var(--acc); }
.sw__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--fg-1);
  box-shadow: 0 1px 2px var(--cap-shade);
  transition: transform var(--t-med) var(--ease), background var(--t-med) var(--ease);
}
.sw__track[aria-checked='true'] .sw__thumb { transform: translateX(14px); background: var(--on-acc); }
.sw__label { color: var(--fg-2); font-size: var(--fs-label); cursor: pointer; }
.sw--disabled .sw__label { cursor: not-allowed; }
</style>
