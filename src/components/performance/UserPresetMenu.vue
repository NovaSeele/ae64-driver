<script setup lang="ts">
// "Mẫu riêng (N) ▾": the user's saved presets in one popover — apply, delete, and "save current". The page owns what each
// action does (history, toasts, the save dialog); this only draws the menu and keeps focus where a keyboard user expects it.
import { nextTick, ref, watch } from 'vue';
import { IconChevronDown, IconX } from '@tabler/icons-vue';
import Popover from '../ui/Popover.vue';
import { t } from '../../i18n/vi';
import type { UserPreset } from '../../stores/userPresets';

const props = defineProps<{
  presets: UserPreset[];
  /** Applying needs keys in scope. */
  canApply: boolean;
  /** Why "save current" is unavailable, or null. */
  saveBlocked: string | null;
  meta: (p: UserPreset) => string;
  title: (p: UserPreset) => string;
}>();
const emit = defineEmits<{ apply: [p: UserPreset]; remove: [p: UserPreset]; save: [] }>();

const open = ref(false);
const btn = ref<HTMLButtonElement | null>(null);
const body = ref<HTMLElement | null>(null);

const items = () => [...(body.value?.querySelectorAll<HTMLButtonElement>('[data-menu-item]') ?? [])].filter((b) => !b.disabled);

// The popover focuses its first button on open; a disabled first row would swallow that, so pick the first usable item.
watch(open, async (on) => {
  if (!on) return;
  await nextTick();
  await nextTick();
  if (!body.value?.contains(document.activeElement)) items()[0]?.focus();
}, { flush: 'post' });

function onBtnKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') { e.preventDefault(); open.value = true; }
}
function onBodyKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!el.hasAttribute('data-menu-item')) return;
    e.preventDefault();
    const list = items();
    const i = list.indexOf(el as HTMLButtonElement);
    list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
  } else if (e.key === 'Delete') {
    const id = el.getAttribute('data-preset');
    const p = id ? props.presets.find((x) => x.id === id) : undefined;
    if (p) remove(p);
  }
}

/** Deleting takes the focused row away: focus the row that moves into its place, else the previous one, else the save item. */
function remove(p: UserPreset) {
  const at = props.presets.findIndex((x) => x.id === p.id);
  emit('remove', p);
  void nextTick(() => {
    const rows = items().filter((b) => b.hasAttribute('data-preset'));
    (rows[Math.min(at, rows.length - 1)] ?? items()[0] ?? btn.value)?.focus();
  });
}
function apply(p: UserPreset) {
  emit('apply', p);
  open.value = false;
  btn.value?.focus();
}
function save() {
  emit('save');
  open.value = false;
}
</script>

<template>
  <button
    ref="btn"
    type="button"
    class="umenu__btn"
    aria-haspopup="dialog"
    :aria-expanded="open"
    :aria-label="t('perf.userPresetsAria', { n: presets.length })"
    @click="open = !open"
    @keydown="onBtnKey"
  >
    {{ presets.length ? t('perf.userPresetsCount', { n: presets.length }) : t('perf.userPresets') }}
    <IconChevronDown :size="12" stroke-width="2" aria-hidden="true" />
  </button>
  <Popover v-model:open="open" :anchor="btn" :title="t('perf.userPresets')" :width="280">
    <div ref="body" class="umenu" @keydown="onBodyKey">
      <p v-if="!presets.length" class="umenu__empty">{{ t('perf.userPresetsEmpty') }}</p>
      <div v-for="p in presets" :key="p.id" class="umenu__row">
        <button type="button" class="umenu__use" data-menu-item :data-preset="p.id" :disabled="!canApply" :title="title(p)" @click="apply(p)">
          <span class="umenu__name">{{ p.name }}</span>
          <span class="umenu__meta">{{ meta(p) }}</span>
        </button>
        <button type="button" class="umenu__x" :aria-label="t('perf.presetDelete', { name: p.name })" :title="t('perf.presetDelete', { name: p.name })" @click="remove(p)">
          <IconX :size="14" stroke-width="2" aria-hidden="true" />
        </button>
      </div>
      <hr class="umenu__sep">
      <button type="button" class="umenu__save" data-menu-item :disabled="!!saveBlocked" :aria-describedby="saveBlocked ? 'umenu-save-why' : undefined" @click="save">
        {{ t('perf.presetSaveCurrent') }}
      </button>
      <p v-if="saveBlocked" id="umenu-save-why" class="umenu__why">{{ saveBlocked }}</p>
    </div>
  </Popover>
</template>

<style scoped>
/* The same look as the toolbar's plain chips (their rules are scoped to the page). */
.umenu__btn {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding: 0 8px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  color: var(--fg-2);
  font-size: var(--fs-label);
  font-weight: 500;
  white-space: nowrap;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.umenu__btn:hover { color: var(--fg-1); background: var(--bg-4); border-color: var(--acc-line); }
.umenu__btn[aria-expanded='true'] { border-color: var(--acc-line); color: var(--fg-1); }
.umenu { display: flex; flex-direction: column; gap: 2px; }
.umenu__empty { margin: 0; padding: var(--s-2); color: var(--fg-3); font-size: var(--fs-label); }
.umenu__row { display: flex; align-items: stretch; gap: 2px; }
.umenu__use, .umenu__save {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  flex: 1;
  min-width: 0;
  padding: 6px var(--s-2);
  border: 0;
  background: transparent;
  border-radius: var(--r-control);
  color: var(--fg-1);
  font-size: var(--fs-label);
  text-align: left;
}
.umenu__use:hover:not(:disabled), .umenu__save:hover:not(:disabled), .umenu__x:hover { background: var(--bg-3); }
.umenu__use:disabled, .umenu__save:disabled { opacity: 0.45; cursor: not-allowed; }
.umenu__name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.umenu__meta { color: var(--fg-3); font-size: var(--fs-caption); white-space: nowrap; }
.umenu__x { display: grid; place-items: center; flex: none; width: 28px; border: 0; background: transparent; border-radius: var(--r-control); color: var(--fg-3); }
.umenu__x:hover { color: var(--danger); }
.umenu__sep { width: 100%; margin: var(--s-1) 0; border: 0; border-top: 1px solid var(--line-1); }
.umenu__save { flex: none; }
.umenu__why { margin: 0; padding: 0 var(--s-2) var(--s-1); color: var(--fg-3); font-size: var(--fs-caption); white-space: normal; }
</style>
