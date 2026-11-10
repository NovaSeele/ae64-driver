<script setup lang="ts">
// Switch card of the Switch page: the switch fitted in the selected keys. Picking happens in SwitchPicker.
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertTriangle, IconInfoCircle, IconReplace, IconTarget, IconX } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import { formatMm } from '../ui/NumberField.vue';
import SwitchSwatch from './SwitchSwatch.vue';
import SwitchPicker from './SwitchPicker.vue';
import { groupKeys } from './switchGroups';
import { groupName, switchBrand, switchName } from '../../data/switchDisplay';
import { useDeviceStore } from '../../stores/device';
import { usePerformanceStore } from '../../stores/performance';
import { t } from '../../i18n/vi';

const props = defineProps<{ ids: number[] }>();
const perf = usePerformanceStore();
const device = useDeviceStore();
const router = useRouter();

const open = ref(false);
const recal = ref(false);

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
const groupLabel = (g: 'JIANGWAN' | 'GATERON' | 'TTC' | 'Other') => (g === 'Other' ? t('sw.groupOther') : groupName(g));
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
      <div v-if="recal" class="swc__recal" role="status">
        <IconTarget :size="16" aria-hidden="true" />
        <span class="swc__recal-text">
          {{ t('sw.recal') }}
          <button type="button" class="swc__recal-go" @click="router.replace({ path: '/switch', query: { tab: 'calibration' } })">{{ t('sw.recalGo') }}</button>
        </span>
        <button type="button" class="swc__recal-x" :aria-label="t('sw.recalHide')" @click="recal = false"><IconX :size="14" aria-hidden="true" /></button>
      </div>
    </div>
    <div class="swc__foot">
      <Button variant="secondary" size="sm" :icon="IconReplace" :disabled="!perf.catalog || !ids.length" :title="perf.catalog ? undefined : unsupportedText" @click="open = true">{{ t('sw.change') }}</Button>
    </div>
    <SwitchPicker v-model:open="open" :ids="ids" @applied="recal = true" />
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
.swc__recal {
  display: flex; align-items: flex-start; gap: var(--s-2);
  padding: var(--s-3);
  border-radius: var(--r-control);
  border: 1px solid color-mix(in srgb, var(--info) 40%, transparent);
  background: color-mix(in srgb, var(--info) var(--soft-pct), var(--bg-2));
  color: var(--fg-1); font-size: var(--fs-label); line-height: 1.45;
}
.swc__recal > svg { flex: none; color: var(--info); margin-top: 1px; }
.swc__recal-text { flex: 1; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.swc__recal-go { border: 0; padding: 0; background: none; color: var(--fg-1); font: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.swc__recal-x { border: 0; background: none; padding: 2px; color: var(--fg-3); border-radius: 4px; cursor: pointer; line-height: 0; }
.swc__recal-x:hover { color: var(--fg-1); background: var(--bg-3); }
</style>
