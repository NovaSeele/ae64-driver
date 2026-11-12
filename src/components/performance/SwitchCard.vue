<script setup lang="ts">
// Switch card of the Switch page: the switch fitted in the selected keys. Picking happens in SwitchPicker.
import { computed, ref } from 'vue';
import { IconAlertTriangle, IconInfoCircle, IconReplace } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import { formatMm } from '../ui/NumberField.vue';
import SwitchSwatch from './SwitchSwatch.vue';
import SwitchPicker from './SwitchPicker.vue';
import { groupKeys } from './switchGroups';
import { groupName, switchBrand, switchName } from '../../data/switchDisplay';
import type { SwitchEntry } from '../../protocol/switches';
import { useDeviceStore } from '../../stores/device';
import { usePerformanceStore } from '../../stores/performance';
import { t } from '../../i18n/vi';

const props = defineProps<{ ids: number[] }>();
const perf = usePerformanceStore();
const device = useDeviceStore();

const open = ref(false);

const groups = computed(() => {
  const order = (id: number) => { const i = perf.catalog?.findIndex((e) => e.id === id) ?? -1; return i < 0 ? Infinity : i; };
  return groupKeys(props.ids, perf.values, order).map((g) => ({
    entry: perf.switchOf(g.ids[0]), axisV2Id: g.axisV2Id, rangeMax: g.rangeMax, n: g.ids.length,
  }));
});
type Group = (typeof groups.value)[number];

const unsupportedText = computed(() => t('sw.unsupported', { board: (device.info?.boardIdHex ?? '').toUpperCase() }));
const normalisedN = computed(() => new Set(perf.switchNotices.map((x) => x.id)).size);

const mm = (rangeMax: number) => formatMm(rangeMax / 1000, 3);
const groupLabel = (g: SwitchEntry['group']) => (g === 'Other' ? t('sw.groupOther') : groupName(g));
const nameOf = (g: Group) => (g.entry ? switchName(g.entry) : t('sw.unknown'));
const metaOf = (g: Group) => {
  const what = g.entry ? (switchBrand(g.entry.id) ?? groupLabel(g.entry.group)) : perf.catalog ? t('sw.unknownMeta', { id: g.axisV2Id }) : t('sw.idMeta', { id: g.axisV2Id });
  return `${what} · ${t('sw.keys', { n: g.n })}`;
};
const rowName = (g: Group) => (g.entry ? switchName(g.entry) : t('sw.unknownRow', { id: g.axisV2Id }));
</script>

<template>
  <Card :title="t('swp.selTitle')" :subtitle="t('sw.hint')">
    <div class="swc">
      <p v-if="!ids.length" class="swc__note">{{ t('swp.selEmpty') }}</p>
      <div v-else-if="groups.length === 1" class="swc__current">
        <SwitchSwatch :color="groups[0].entry?.color ?? ''" :id="groups[0].entry?.id" size="lg" />
        <div class="swc__text">
          <span class="swc__name swc__name--wrap" :title="nameOf(groups[0])">{{ nameOf(groups[0]) }}</span>
          <span class="swc__meta">{{ metaOf(groups[0]) }}</span>
        </div>
        <span class="swc__mm">{{ mm(groups[0].rangeMax) }}<small>mm</small></span>
      </div>
      <template v-else-if="groups.length > 1">
        <ul class="swc__rows">
          <li v-for="g in groups.slice(0, 3)" :key="`${g.axisV2Id}:${g.rangeMax}`" class="swc__row">
            <SwitchSwatch :color="g.entry?.color ?? ''" :id="g.entry?.id" size="sm" />
            <span class="swc__name" :title="rowName(g)">{{ rowName(g) }}</span>
            <span class="swc__mm">{{ mm(g.rangeMax) }}<small>mm</small></span>
            <span class="swc__count">{{ t('sw.keys', { n: g.n }) }}</span>
          </li>
        </ul>
        <span v-if="groups.length > 3" class="swc__more">{{ t('sw.more', { n: groups.length - 3 }) }}</span>
      </template>
      <p v-if="!perf.catalog" class="swc__note"><IconInfoCircle :size="14" aria-hidden="true" />{{ unsupportedText }}</p>
      <p v-if="perf.switchNotices.length" class="swc__note swc__note--warn" role="status">
        <IconAlertTriangle :size="14" aria-hidden="true" />{{ t('sw.normalised', { n: normalisedN }) }}
      </p>
    </div>
    <div class="swc__foot">
      <Button variant="secondary" size="sm" :icon="IconReplace" :disabled="!perf.catalog || !ids.length" :title="perf.catalog ? undefined : unsupportedText" @click="open = true">{{ t('sw.change') }}</Button>
    </div>
    <SwitchPicker v-model:open="open" :ids="ids" />
  </Card>
</template>

<style scoped>
.swc { display: flex; flex-direction: column; gap: var(--s-3); }
.swc__foot { margin-top: auto; display: flex; justify-content: flex-start; }
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
