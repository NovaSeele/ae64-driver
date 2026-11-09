<script setup lang="ts">
// Onboard profiles as a compact list; click switches (re-reads the profile), pencil/double-click renames inline.
import { computed, nextTick, ref } from 'vue';
import { IconPencil } from '@tabler/icons-vue';
import { useCalibrationStore } from '../../stores/calibration';
import { useDeviceStore } from '../../stores/device';
import { useToast } from '../ui/toast';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
const calibration = useCalibrationStore();
const toast = useToast();
const calibrating = computed(() => calibration.phase !== 'idle' || device.calibrationLocked());
const editing = ref<number | null>(null);
const draft = ref('');
const busy = ref<number | null>(null);
const input = ref<HTMLInputElement[]>([]);

async function choose(i: number) {
  if (calibrating.value || editing.value !== null || busy.value !== null) return;
  busy.value = i;
  try {
    await device.switchProfile(i);
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    busy.value = null;
  }
}

async function startRename(i: number) {
  if (!device.boardAllowed) return;
  editing.value = i;
  draft.value = device.profileNames[i] ?? '';
  await nextTick();
  input.value[0]?.select();
}

async function finishRename(save: boolean) {
  const i = editing.value;
  editing.value = null;
  if (!save || i === null) return;
  try {
    await device.renameProfile(i, draft.value);
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  }
}
</script>

<template>
  <div class="ps">
    <div class="micro ps__label">{{ t('device.profile') }}</div>
    <ul class="ps__list" role="listbox" :aria-label="t('device.profile')">
      <li
        v-for="(name, i) in device.profileNames"
        :key="i"
        class="ps__item"
        :class="{ 'ps__item--on': i === device.activeProfile, 'ps__item--busy': busy === i, 'ps__item--off': calibrating && i !== device.activeProfile }"
        role="option"
        :aria-selected="i === device.activeProfile"
        :aria-disabled="calibrating && i !== device.activeProfile ? true : undefined"
        :title="calibrating && i !== device.activeProfile ? t('device.calibrating') : undefined"
        :tabindex="i === device.activeProfile ? 0 : -1"
        @click="choose(i)"
        @dblclick="startRename(i)"
        @keydown.enter="choose(i)"
        @keydown.f2="startRename(i)"
      >
        <span class="ps__idx num">{{ i + 1 }}</span>
        <input
          v-if="editing === i"
          ref="input"
          v-model="draft"
          class="ps__input"
          maxlength="32"
          :aria-label="t('device.rename')"
          @click.stop
          @keydown.enter.stop="finishRename(true)"
          @keydown.esc.stop="finishRename(false)"
          @blur="finishRename(true)"
        >
        <span v-else class="ps__name">{{ name }}</span>
        <button
          v-if="editing !== i && device.boardAllowed"
          type="button"
          class="ps__edit"
          :aria-label="`${t('device.rename')} ${name}`"
          :title="t('device.rename')"
          @click.stop="startRename(i)"
        >
          <IconPencil :size="13" stroke-width="1.5" />
        </button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.ps { display: flex; flex-direction: column; gap: var(--s-2); }
.ps__label { padding: 0 4px; }
.ps__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ps__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 6px 0 8px;
  border-radius: var(--r-control);
  color: var(--fg-2);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.ps__item:hover { background: var(--bg-3); color: var(--fg-1); }
.ps__item--on { background: var(--sel-bg); color: var(--fg-1); box-shadow: inset 2px 0 0 var(--acc); }
.ps__item--busy { opacity: 0.6; }
.ps__item--off { opacity: 0.45; cursor: not-allowed; }
.ps__item--off:hover { background: transparent; color: var(--fg-2); }
.ps__idx {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: 10.5px;
  font-weight: 600;
  background: var(--bg-4);
  color: var(--fg-2);
}
.ps__item--on .ps__idx { background: var(--acc); color: var(--on-acc); }
.ps__name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps__input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--acc-line);
  border-radius: 4px;
  background: var(--bg-1);
}
.ps__edit {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-3);
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.ps__item:hover .ps__edit, .ps__edit:focus-visible { opacity: 1; }
.ps__edit:hover { color: var(--fg-1); }
</style>
