<script setup lang="ts">
// Switch card of the Switch page: the switch fitted in the selected keys (DESIGN CSW §4.3, §9.5).
// Picking happens in SwitchPicker. Exposes openPicker() for the Switch tab's check strip (§11.2).
import { computed, nextTick, ref, watch } from 'vue';
import { IconAlertTriangle, IconInfoCircle, IconLock, IconPencilPlus, IconReplace } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import { formatMm } from '../ui/NumberField.vue';
import SwitchSwatch from './SwitchSwatch.vue';
import SwitchPicker from './SwitchPicker.vue';
import { groupKeys, identityOrder, swatchForKeySwitch } from './switchGroups';
import type { KeyGroup } from './switchGroups';
import { groupName, switchBrand, switchName } from '../../data/switchDisplay';
import type { SwitchEntry } from '../../protocol/switches';
import { useDeviceStore } from '../../stores/device';
import { customSwitchName, usePerformanceStore } from '../../stores/performance';
import { revealAboveToast } from '../ui/toast';
import { t } from '../../i18n/vi';

const props = defineProps<{ ids: number[] }>();
const perf = usePerformanceStore();
const device = useDeviceStore();

const open = ref(false);
const pickerInitial = ref<{ uid: string } | null>(null);
const pickerDefaultCustom = ref(false);
/** A board outside the write allow-list (WHOLE P3): the map shows, the switch cannot be changed. */
const ro = computed(() => !device.boardAllowed);
const disabled = computed(() => ro.value || !perf.catalog || !props.ids.length);
const foot = ref<HTMLElement | null>(null);
const lastOpener = ref<HTMLButtonElement | null>(null);

watch(open, (v) => {
  if (!v) {
    pickerInitial.value = null;
    pickerDefaultCustom.value = false;
  }
});

function openDefault(e: MouseEvent) {
  lastOpener.value = (e.currentTarget as HTMLButtonElement | null) ?? null;
  pickerInitial.value = null;
  pickerDefaultCustom.value = false;
  open.value = true;
}

function openCustomTab(e: MouseEvent) {
  lastOpener.value = (e.currentTarget as HTMLButtonElement | null) ?? null;
  pickerInitial.value = null;
  pickerDefaultCustom.value = true;
  open.value = true;
}

/** Programmatic open used by SwitchTab's check strip (§11.2). Writes nothing until Apply. */
function openPicker(initial: { uid: string } | null = null): void {
  if (ro.value || !perf.catalog) return;
  lastOpener.value = null;
  pickerInitial.value = initial;
  pickerDefaultCustom.value = Boolean(initial);
  open.value = true;
}

defineExpose({ openPicker });

/** After Apply: keep focus on the trigger (the Dialog restores it on close) and scroll it clear of the toast. */
async function onApplied() {
  await nextTick();
  const fallback = foot.value?.querySelector<HTMLButtonElement>('button') ?? null;
  const btn = (lastOpener.value && document.contains(lastOpener.value) ? lastOpener.value : null) ?? fallback;
  if (!btn) return;
  if (document.activeElement !== btn) btn.focus({ preventScroll: true });
  await revealAboveToast(btn);
}

const groups = computed(() =>
  groupKeys(props.ids, (id) => perf.keySwitch(id), (ks) => identityOrder(ks, perf.catalog)),
);

const unsupportedText = computed(() => t('sw.unsupported', { board: (device.info?.boardIdHex ?? '').toUpperCase() }));
const normalisedN = computed(() => new Set(perf.switchNotices.map((x) => x.id)).size);

const mm = (rangeMax: number) => formatMm(rangeMax / 1000, 3);
const groupLabel = (g: SwitchEntry['group']) => (g === 'Other' ? t('sw.groupOther') : groupName(g));

function swatchOf(g: KeyGroup) {
  return swatchForKeySwitch(g.identity, perf.customSwitches);
}

function nameOf(g: KeyGroup): string {
  switch (g.identity.kind) {
    case 'catalog': return switchName(g.identity.entry);
    case 'custom': return customSwitchName(g.identity.custom);
    case 'unnamed': return t('csw.unnamed');
    case 'lost': return t('csw.lost');
    case 'unknown': return t('sw.unknown');
  }
}

function metaOf(g: KeyGroup): string {
  const n = g.ids.length;
  switch (g.identity.kind) {
    case 'catalog': {
      const e = g.identity.entry;
      const what = switchBrand(e.id) ?? groupLabel(e.group);
      return `${what} · ${t('sw.keys', { n })}`;
    }
    case 'custom':
      return t('csw.cardMeta', { maker: g.identity.custom.maker || t('csw.kind'), n });
    case 'unnamed':
      return `${t('csw.metaUnnamed', { mm: mm(g.identity.triple.axisRangeMax), coef: g.identity.triple.axisCoefficient })} · ${t('sw.keys', { n })}`;
    case 'lost':
      return t('csw.lostMeta');
    case 'unknown': {
      const id = g.identity.triple.axisV2Id;
      const what = perf.catalog ? t('sw.unknownMeta', { id }) : t('sw.idMeta', { id });
      return `${what} · ${t('sw.keys', { n })}`;
    }
  }
}

function rowName(g: KeyGroup): string {
  switch (g.identity.kind) {
    case 'catalog': return switchName(g.identity.entry);
    case 'custom': return customSwitchName(g.identity.custom);
    case 'unnamed': return t('csw.unnamed');
    case 'lost': return t('csw.lost');
    case 'unknown': return t('sw.unknownRow', { id: g.identity.triple.axisV2Id });
  }
}
</script>

<template>
  <Card :title="t('swp.selTitle')" :subtitle="t('sw.hint')">
    <div class="swc">
      <p v-if="!ids.length" class="swc__note">{{ t('swp.selEmpty') }}</p>
      <div v-else-if="groups.length === 1" class="swc__current">
        <SwitchSwatch v-bind="swatchOf(groups[0])" size="lg" />
        <div class="swc__text">
          <span class="swc__name swc__name--wrap" :title="nameOf(groups[0])">{{ nameOf(groups[0]) }}</span>
          <span class="swc__meta">{{ metaOf(groups[0]) }}</span>
        </div>
        <span class="swc__mm">
          <template v-if="groups[0].identity.kind === 'lost'">—</template>
          <template v-else>{{ mm(groups[0].rangeMax) }}<small>mm</small></template>
        </span>
      </div>
      <template v-else-if="groups.length > 1">
        <ul class="swc__rows">
          <li v-for="g in groups.slice(0, 3)" :key="g.key" class="swc__row">
            <SwitchSwatch v-bind="swatchOf(g)" size="sm" />
            <span class="swc__name" :title="rowName(g)">{{ rowName(g) }}</span>
            <span class="swc__mm">
              <template v-if="g.identity.kind === 'lost'">—</template>
              <template v-else>{{ mm(g.rangeMax) }}<small>mm</small></template>
            </span>
            <span class="swc__count">{{ t('sw.keys', { n: g.ids.length }) }}</span>
          </li>
        </ul>
        <span v-if="groups.length > 3" class="swc__more">{{ t('sw.more', { n: groups.length - 3 }) }}</span>
      </template>
      <p v-if="ro" class="swc__note swc__note--warn" role="note" data-test="switch-read-only">
        <IconLock :size="14" aria-hidden="true" />{{ t('swp.readOnly') }}
      </p>
      <p v-if="!perf.catalog" class="swc__note"><IconInfoCircle :size="14" aria-hidden="true" />{{ unsupportedText }}</p>
      <p v-if="perf.switchNotices.length" class="swc__note swc__note--warn" role="status">
        <IconAlertTriangle :size="14" aria-hidden="true" />{{ t('sw.normalised', { n: normalisedN }) }}
      </p>
    </div>
    <div ref="foot" class="swc__foot">
      <Button variant="secondary" size="sm" :icon="IconReplace" :disabled="disabled" :title="perf.catalog ? undefined : unsupportedText" @click="openDefault">{{ t('sw.change') }}</Button>
      <Button variant="secondary" size="sm" :icon="IconPencilPlus" :disabled="disabled" :title="perf.catalog ? undefined : unsupportedText" @click="openCustomTab">{{ t('csw.open') }}</Button>
    </div>
    <SwitchPicker v-model:open="open" :ids="ids" :initial="pickerInitial" :default-custom="pickerDefaultCustom" @applied="onApplied" />
  </Card>
</template>

<style scoped>
.swc { display: flex; flex-direction: column; gap: var(--s-3); }
.swc__foot { margin-top: var(--s-4); display: flex; flex-wrap: wrap; gap: var(--s-2); justify-content: flex-start; }
.swc__current { display: flex; align-items: center; gap: var(--s-3); }
.swc__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.swc__name { font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* The single-switch name may take two lines (English names run up to 31 characters). */
.swc__name--wrap { white-space: normal; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; line-height: 1.25; }
.swc__meta { font-size: var(--fs-label); color: var(--fg-3); }
.swc__mm { font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); white-space: nowrap; }
.swc__mm small { font-size: var(--fs-label); font-weight: 500; color: var(--fg-3); margin-left: 2px; }
.swc__rows { display: flex; flex-direction: column; gap: 2px; margin: 0; padding: 0; list-style: none; }
.swc__row { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: var(--s-2) var(--s-3); padding: 6px 0; border-top: 1px solid var(--line-1); }
.swc__row:first-child { border-top: 0; padding-top: 0; }
.swc__row .swc__name { font-size: var(--fs-body); font-weight: 500; }
.swc__row .swc__mm { font-size: var(--fs-body); font-weight: 500; }
.swc__count { font-size: var(--fs-label); color: var(--fg-3); min-width: 52px; text-align: right; }
.swc__more { font-size: var(--fs-label); color: var(--fg-3); }
.swc__note { display: flex; gap: var(--s-2); align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 1.45; color: var(--fg-3); }
.swc__note svg { flex: none; margin-top: 1px; }
.swc__note--warn { color: var(--fg-1); }
.swc__note--warn svg { color: var(--warn); }
</style>
