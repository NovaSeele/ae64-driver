<script setup lang="ts">
// Step 1 (DESIGN FW §3.1, §3.2): drop or choose a .bin; the five checks run on this computer, nothing goes to the keyboard.
import { computed, ref } from 'vue';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconCircleX, IconFileDigit, IconFileUpload, IconInfoCircle, IconUpload } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import { boardHex, crcHex } from '../../protocol/firmware';
import type { FwCheckKey } from '../../protocol/firmware';
import { useFirmwareStore } from '../../stores/firmware';
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';
import { kib } from './fwText';

const fw = useFirmwareStore();
const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

/** Choosing is possible before a session, and in rescue mode before its write starts. */
const canChoose = computed(() => !fw.active || fw.phase === 'rescue');

function pick(): void {
  if (canChoose.value) input.value?.click();
}
async function take(files: FileList | null | undefined): Promise<void> {
  const f = files?.[0];
  if (!f || !canChoose.value) return;
  await fw.chooseFile(f);
}
async function onInput(e: Event): Promise<void> {
  const el = e.target as HTMLInputElement;
  await take(el.files);
  el.value = ''; // the same file can be chosen again
}
function onDrop(e: DragEvent): void {
  dragging.value = false;
  void take(e.dataTransfer?.files);
}

const lines = computed<{ key: FwCheckKey; ok: boolean; text: string }[]>(() => {
  const f = fw.file;
  if (!f) return [];
  if (!f.check) return [{ key: 'size', ok: false, text: t('fw.chk.size') }];
  const h = f.check.header;
  const dev = fw.deviceBoard === null ? '—' : boardHex(fw.deviceBoard);
  const n = h.length.toLocaleString(locale.value === 'vi' ? 'vi-VN' : 'en-US');
  return f.check.lines.map((l) => ({
    ...l,
    text: l.key === 'sig' ? t('fw.chk.sig')
      : l.key === 'board' ? t(l.ok ? 'fw.chk.board' : 'fw.chk.boardBad', { file: boardHex(h.board), dev })
      : l.key === 'len' ? t('fw.chk.len', { n })
      : l.key === 'crc' ? t('fw.chk.crc', { crc: crcHex(h.crc) })
      : t('fw.chk.size'),
  }));
});
const known = computed(() => fw.known);
</script>

<template>
  <input ref="input" type="file" accept=".bin" hidden @change="onInput" />
  <div
    v-if="!fw.file"
    class="fw-drop"
    :class="{ 'fw-drop--over': dragging }"
    @dragover.prevent="dragging = canChoose"
    @dragleave="dragging = false"
    @drop.prevent="onDrop"
  >
    <IconFileUpload class="fw-ico" :size="28" stroke-width="1.5" aria-hidden="true" />
    <p>{{ t('fw.drop') }}</p>
    <Button size="sm" :icon="IconUpload" :disabled="!canChoose" @click="pick">{{ t('fw.choose') }}</Button>
    <p class="fw-types">{{ t('fw.types') }}</p>
  </div>
  <template v-else>
    <div class="fw-file" @dragover.prevent="dragging = canChoose" @drop.prevent="onDrop">
      <IconFileDigit :size="22" stroke-width="1.5" aria-hidden="true" />
      <p class="fw-file__name"><b>{{ fw.file.name }}</b> · {{ kib(fw.file.size) }} KiB</p>
      <Button v-if="canChoose" class="fw-file__btn" size="sm" variant="ghost" :icon="IconUpload" @click="pick">{{ t('fw.change') }}</Button>
    </div>
    <ul class="fw-chk" :aria-label="t('fw.s1')">
      <li v-for="l in lines" :key="l.key" :class="l.ok ? 'ok' : 'bad'">
        <component :is="l.ok ? IconCircleCheck : IconCircleX" :size="16" stroke-width="1.75" aria-hidden="true" />
        <span>{{ l.text }}</span>
      </li>
    </ul>
    <template v-if="fw.fileOk">
      <p v-if="fw.rescueRefused" class="fw-err" role="alert">
        <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.rescue.officialOnly') }}</span>
      </p>
      <p v-else-if="known?.kind === 'official'" class="fw-known">
        <IconInfoCircle :size="15" stroke-width="1.75" aria-hidden="true" />
        <span>{{ t('fw.known', { name: known.name, version: known.version }) }} {{ t('fw.knownOfficial') }}</span>
      </p>
      <p v-else id="fw-risk-line" class="fw-known fw-known--warn">
        <IconAlertTriangle :size="15" stroke-width="1.75" aria-hidden="true" />
        <span v-if="known">{{ t('fw.known', { name: known.name, version: known.version }) }} {{ t('fw.knownThird') }}</span>
        <span v-else>{{ t('fw.unknown') }}</span>
      </p>
    </template>
    <p v-else class="fw-err" role="alert">
      <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.fileBad') }}</span>
    </p>
  </template>
</template>

<style scoped>
.fw-drop {
  display: flex; flex-direction: column; align-items: center; gap: var(--s-2); padding: var(--s-5) var(--s-4);
  border: 1px dashed var(--line-3); border-radius: var(--r-card); background: var(--bg-1); text-align: center;
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease);
}
.fw-drop--over { border-color: var(--acc); background: color-mix(in srgb, var(--acc) 8%, var(--bg-1)); }
.fw-ico { color: var(--fg-3); }
.fw-drop p { margin: 0; font-size: var(--fs-body); color: var(--fg-2); }
.fw-drop .fw-types { font-size: var(--fs-caption); color: var(--fg-3); }
.fw-file { display: flex; align-items: center; gap: var(--s-3); flex-wrap: wrap; }
.fw-file > svg { flex: none; color: var(--fg-3); }
.fw-file__name { flex: 1 1 200px; min-width: 0; margin: 0; font-size: var(--fs-label); color: var(--fg-2); overflow-wrap: anywhere; }
.fw-file__name b { font-weight: 600; color: var(--fg-1); }
.fw-file__btn { margin-left: auto; }
.fw-chk { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: var(--s-3); list-style: none; border-radius: var(--r-control); background: var(--bg-1); }
.fw-chk li { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-label); line-height: 18px; color: var(--fg-1); }
.fw-chk li span { min-width: 0; overflow-wrap: anywhere; }
.fw-chk li svg { flex: none; margin-top: 1px; }
.fw-chk .ok svg { color: var(--ok); }
.fw-chk .bad { color: var(--danger); font-weight: 600; }
.fw-known { display: flex; gap: 8px; align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-1); }
.fw-known svg { flex: none; margin-top: 1px; color: var(--info); }
.fw-known--warn { color: var(--warn); }
.fw-known--warn svg { color: var(--warn); }
.fw-err {
  display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control);
  background: var(--danger-soft); color: var(--danger); font-size: var(--fs-label); line-height: 18px;
}
.fw-err svg { flex: none; margin-top: 1px; }
</style>
