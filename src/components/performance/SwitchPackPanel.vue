<script setup lang="ts">
// Switch pack disclosure panel inside SwitchPicker's scroll area (DESIGN CSW §6.7):
// import (size checked before reading, parsed via parsePack), export, and template download. 0 HID.
import { ref } from 'vue';
import { IconFileDownload, IconFileExport, IconFileImport } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import { useToast } from '../ui/toast';
import { cleanText } from '../../data/customSwitch';
import type { CustomSwitch } from '../../data/customSwitch';
import { READY_BOUNDS } from '../../data/readySwitches';
import {
  PACK_TEMPLATE, PACK_TEMPLATE_FILE, exportPack, packExportFileName, packTooBig, parsePack,
} from '../../data/switchPack';
import type { ParsedPack } from '../../data/switchPack';
import { t } from '../../i18n/vi';

const props = defineProps<{
  id: string;
  labelledBy: string;
  customSwitches: readonly CustomSwitch[];
}>();

const emit = defineEmits<{
  imported: [payload: { fileName: string; result: ParsedPack }];
}>();

const fileInput = ref<HTMLInputElement | null>(null);
const FILE_NAME_MAX = 60;

function shortFileName(name: string): string {
  const clean = cleanText(name);
  const chars = [...clean];
  return chars.length > FILE_NAME_MAX ? `${chars.slice(0, FILE_NAME_MAX).join('')}…` : clean;
}

function downloadJson(json: string, file: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url));
}

function pickFile(): void {
  fileInput.value?.click();
}

async function onFile(): Promise<void> {
  const input = fileInput.value;
  const f = input?.files?.[0];
  if (input) input.value = '';
  if (!f) return;
  // Check size before reading the file (§6.7, Test 18, M24).
  if (packTooBig(f.size)) {
    useToast().show(t('csw.pkTooBig'), 'error');
    return;
  }
  let text = '';
  try { text = await f.text(); } catch { text = ''; }
  const result = parsePack(text, { existing: props.customSwitches, bounds: READY_BOUNDS });
  emit('imported', { fileName: shortFileName(f.name), result });
}

function doExport(): void {
  if (!props.customSwitches.length) return;
  downloadJson(exportPack(props.customSwitches), packExportFileName());
  useToast().show(t('csw.pkExported', { n: props.customSwitches.length }), 'success');
}

function doTemplate(): void {
  downloadJson(PACK_TEMPLATE, PACK_TEMPLATE_FILE);
}
</script>

<template>
  <div :id="id" class="csw-packpanel" role="region" :aria-labelledby="labelledBy">
    <p class="csw-packpanel__body">{{ t('csw.packBody') }}</p>
    <div class="csw-packpanel__btns">
      <Button variant="secondary" size="sm" :icon="IconFileImport" @click="pickFile">{{ t('csw.packImport') }}</Button>
      <Button
        variant="secondary"
        size="sm"
        :icon="IconFileExport"
        :disabled="!customSwitches.length"
        :title="customSwitches.length ? undefined : t('csw.packExportNone')"
        @click="doExport"
      >
        {{ t('csw.packExport', { n: customSwitches.length }) }}
      </Button>
      <Button variant="secondary" size="sm" :icon="IconFileDownload" @click="doTemplate">{{ t('csw.packTemplate') }}</Button>
    </div>
    <p class="csw-packpanel__note">{{ t('csw.packAssignNote') }}</p>
    <input ref="fileInput" type="file" accept=".json,application/json" hidden @change="onFile">
  </div>
</template>

<style scoped>
.csw-packpanel {
  display: flex; flex-direction: column; gap: 6px; margin: 0 0 var(--s-4); padding: 10px 12px;
  border: 1px solid var(--line-1); border-radius: var(--r-control); background: var(--bg-2);
  font-size: var(--fs-label); line-height: 1.45; color: var(--fg-2);
}
.csw-packpanel p { margin: 0; }
.csw-packpanel__btns { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.csw-packpanel__note { color: var(--fg-3); }
</style>
