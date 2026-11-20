<script setup lang="ts">
// Step 1 (DESIGN FW §3.1, §3.2; DESIGN OFU §3): Trực tuyến (the list, a download) or File trên máy (drop or choose a .bin). The
// checks run on this computer; nothing goes to the keyboard.
import { computed, ref } from 'vue';
import type { Component } from 'vue';
import {
  IconAlertCircle, IconAlertTriangle, IconArrowUp, IconCircleCheck, IconCircleX, IconFileDigit, IconFileUpload, IconInfoCircle, IconList,
  IconRefresh, IconUpload,
} from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Segmented from '../ui/Segmented.vue';
import FwOnline from './FwOnline.vue';
import { FW_HEADER_BYTES, boardHex, crcHex } from '../../protocol/firmware';
import { useFirmwareStore } from '../../stores/firmware';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';
import { kib, num, shaShort } from './fwText';

const fw = useFirmwareStore();
const input = ref<HTMLInputElement | null>(null);
const dragging = ref(false);

/** Choosing is possible before a session, in rescue mode before its write starts, and after a failed write or check (W-04). */
const canChoose = computed(() => fw.canChoose);

const sources = computed(() => [
  { value: 'online' as const, label: t('fw.src.online') },
  { value: 'local' as const, label: t('fw.src.local') },
]);
function onSource(v: 'online' | 'local' | null): void {
  if (v) fw.setSource(v);
}

function pick(): void {
  if (canChoose.value) input.value?.click();
}
/** "Chọn file trên máy" / "Chọn file đã tải…" from the online view: the local source, then the file chooser. */
function pickLocal(): void {
  if (!canChoose.value) return;
  fw.setSource('local');
  input.value?.click();
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

/** The file of the source shown: a downloaded file under Trực tuyến, a picked one under File trên máy. */
const shown = computed(() => {
  const f = fw.file;
  if (!f) return null;
  return (fw.source === 'online') === (f.via === 'online') ? f : null;
});

interface Line { key: string; ok: boolean; warn?: boolean; text: string }
const lines = computed<Line[]>(() => {
  const f = shown.value;
  if (!f) return [];
  const b = f.build;
  const list: Line[] = f.lines.map((l) => {
    // a red line shows the file's value and the list's (review P3-1): the list's alone would read as the file's
    if (l.key === 'listSize') return { key: l.key, ok: l.ok, text: l.ok ? t('fw.chk.listSize', { n: num(b?.size ?? 0) }) : t('fw.chk.listSizeBad', { n: num(f.size), want: num(b?.size ?? 0) }) };
    if (l.key === 'listSha') return { key: l.key, ok: l.ok, text: l.ok ? t('fw.chk.listSha', { h: shaShort(b?.sha256 ?? '') }) : t('fw.chk.listShaBad', { h: shaShort(f.sha256 ?? ''), want: shaShort(b?.sha256 ?? '') }) };
    return { key: l.key, ok: false, warn: true, text: t('fw.chk.listOther', { name: b?.name ?? '', v: b?.version ?? '' }) };
  });
  if (!f.check) return [...list, { key: 'size', ok: false, text: t('fw.chk.size') }];
  const c = f.check;
  const h = c.header;
  const dev = fw.deviceBoard === null ? '—' : boardHex(fw.deviceBoard);
  return [...list, ...f.check.lines.map((l) => ({
    key: l.key,
    ok: l.ok,
    text: l.key === 'sig' ? t('fw.chk.sig')
      : l.key === 'board' ? t(l.ok ? 'fw.chk.board' : 'fw.chk.boardBad', { file: boardHex(h.board), dev })
      // a red header line says what differs, with both values; it never says "khớp" (DESIGN OFU v1.8 §9, review P3-4)
      // nothing after the header comes first: such a header's offset and length are not worth showing (OFU v1.9 §9, review P3-5)
      : l.key === 'len' ? (l.ok ? t('fw.chk.len', { n: num(h.length) })
        : c.size <= FW_HEADER_BYTES ? t('fw.chk.lenNone')
        : h.offset !== FW_HEADER_BYTES ? t('fw.chk.offBad', { off: num(h.offset) })
        : t('fw.chk.lenBad', { n: num(c.size - FW_HEADER_BYTES), want: num(h.length) }))
      : l.key === 'crc' ? (l.ok ? t('fw.chk.crc', { crc: crcHex(h.crc) })
        : c.size <= FW_HEADER_BYTES ? t('fw.chk.crcNone')
        : t('fw.chk.crcBad', { crc: crcHex(c.crc), want: crcHex(h.crc) }))
      : t('fw.chk.size'),
  }))];
});
const known = computed(() => fw.known);
/** A downloaded file that does not match the list: no bytes kept (DESIGN OFU §3.3). */
const mismatch = computed(() => shown.value?.via === 'online' && shown.value.lines.some((l) => !l.ok));
const shaOk = computed(() => !!shown.value?.lines.some((l) => l.key === 'listSha' && l.ok));

/** The version line (DESIGN OFU §4.1), when the file is a known build and the keyboard's version is known. */
const ver = computed<{ icon: Component; warn: boolean; text: string } | null>(() => {
  const r = fw.relation;
  const k = known.value;
  if (!r || !k) return null;
  const p = { cur: fw.current ?? '—', v: k.version };
  const key: MessageKey = r === 'newer' ? 'fw.ver.newer' : r === 'same' ? 'fw.ver.same' : r === 'older' ? 'fw.ver.older' : r === 'third' ? 'fw.ver.third' : 'fw.ver.kindUnknown';
  return { icon: r === 'newer' ? IconArrowUp : r === 'same' ? IconInfoCircle : IconAlertTriangle, warn: r !== 'newer' && r !== 'same', text: t(key, p) };
});
</script>

<template>
  <input ref="input" type="file" accept=".bin" hidden @change="onInput" />
  <Segmented
    class="fw-src"
    :model-value="fw.source"
    :options="sources"
    :label="t('fw.src')"
    size="sm"
    manual
    :disabled="!canChoose"
    @update:model-value="onSource"
  />
  <template v-if="!shown">
    <FwOnline v-if="fw.source === 'online'" @pick="pickLocal" />
    <div
      v-else
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
  </template>
  <template v-else>
    <div v-if="shown.via === 'online'" class="fw-file" data-test="ofu-file">
      <IconFileDigit :size="22" stroke-width="1.5" aria-hidden="true" />
      <div class="fw-file__name">
        <p><b>{{ shown.name }}</b> · {{ kib(shown.size) }} KiB</p>
        <p class="ofu-src">{{ t(shaOk ? 'fw.dl.source' : 'fw.dl.sourcePlain') }}</p>
      </div>
      <Button v-if="canChoose" class="fw-file__btn" size="sm" variant="ghost" :icon="IconList" @click="fw.backToList()">{{ t('fw.dl.change') }}</Button>
    </div>
    <div v-else class="fw-file" @dragover.prevent="dragging = canChoose" @drop.prevent="onDrop">
      <IconFileDigit :size="22" stroke-width="1.5" aria-hidden="true" />
      <p class="fw-file__name"><b>{{ shown.name }}</b> · {{ kib(shown.size) }} KiB</p>
      <Button v-if="canChoose" class="fw-file__btn" size="sm" variant="ghost" :icon="IconUpload" @click="pick">{{ t('fw.change') }}</Button>
    </div>
    <ul class="fw-chk" :aria-label="t('fw.s1')">
      <li v-for="l in lines" :key="l.key" :class="l.ok ? 'ok' : l.warn ? 'warn' : 'bad'">
        <component :is="l.ok ? IconCircleCheck : l.warn ? IconAlertTriangle : IconCircleX" :size="16" stroke-width="1.75" aria-hidden="true" />
        <span>{{ l.text }}</span>
      </li>
    </ul>
    <template v-if="mismatch">
      <p class="fw-err" role="alert" data-test="ofu-mismatch">
        <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.dl.mismatch') }}</span>
      </p>
      <div v-if="canChoose && shown.build" class="fw-btns">
        <Button size="sm" :icon="IconRefresh" @click="fw.download(shown.build)">{{ t('fw.dl.again') }}</Button>
      </div>
    </template>
    <template v-else-if="fw.fileOk">
      <p v-if="fw.rescueRefused" class="fw-err" role="alert">
        <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.rescue.officialOnly', { example: fw.officialExample }) }}</span>
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
      <p v-if="ver && !fw.rescueRefused" id="fw-ver-line" class="fw-known" :class="{ 'fw-known--warn': ver.warn }" data-test="ofu-ver">
        <component :is="ver.icon" :size="15" stroke-width="1.75" aria-hidden="true" />
        <span>{{ ver.text }}</span>
      </p>
    </template>
    <p v-else class="fw-err" role="alert">
      <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.fileBad') }}</span>
    </p>
  </template>
</template>

<style scoped>
.fw-src { align-self: flex-start; }
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
.fw-file__name p { margin: 0; }
.fw-file__name b { font-weight: 600; color: var(--fg-1); }
.fw-file__name .ofu-src { margin-top: 2px; font-size: var(--fs-caption); color: var(--fg-3); }
.fw-file__btn { margin-left: auto; }
.fw-chk { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: var(--s-3); list-style: none; border-radius: var(--r-control); background: var(--bg-1); }
.fw-chk li { display: flex; gap: 8px; align-items: flex-start; font-size: var(--fs-label); line-height: 18px; color: var(--fg-1); }
.fw-chk li span { min-width: 0; overflow-wrap: anywhere; }
.fw-chk li svg { flex: none; margin-top: 1px; }
.fw-chk .ok svg { color: var(--ok); }
.fw-chk .warn { color: var(--warn); }
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
.fw-btns { display: flex; flex-wrap: wrap; gap: var(--s-2); }
</style>
