<script setup lang="ts">
// Switch (the Switch tab of the Performance page, DESIGN E §3.6): which switch sits under every key and the entry point
// to change it (SwitchCard -> SwitchPicker). Kept alive while the user visits the other tabs: the profile hook follows
// activation, and activation reloads only if the profile changed while the tab was hidden.
import { computed, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import KeyboardView from '../keyboard/KeyboardView.vue';
import TabKeyboard from '../keyboard/TabKeyboard.vue';
import Card from '../ui/Card.vue';
import { IconAlertTriangle } from '@tabler/icons-vue';
import { formatMm } from '../ui/NumberField.vue';
import SwitchCard from '../performance/SwitchCard.vue';
import SwitchSwatch from '../performance/SwitchSwatch.vue';
import { groupKeys } from '../performance/switchGroups';
import type { KeyGroup } from '../performance/switchGroups';
import { groupName, switchBrand, switchName } from '../../data/switchDisplay';
import { useDeviceStore } from '../../stores/device';
import { useSelectionStore } from '../../stores/selection';
import { isKnownMode, usePerformanceStore } from '../../stores/performance';
import type { PhysicalKey } from '../../protocol';
import type { LegendItem } from '../keyboard/SelectionBar.vue';
import { t } from '../../i18n/vi';

defineOptions({ name: 'SwitchTab' });
const device = useDeviceStore();
const perf = usePerformanceStore();
const sel = useSelectionStore();
const router = useRouter();

/** "Hiệu chuẩn lại": the Calibration tab of this page (DESIGN E §3.1). */
const recalibrate = () => void router.push({ query: { tab: 'calibration' } });

let offProfile: (() => void) | undefined;
const active = ref(false);
function activate() {
  if (active.value) return; // the first onActivated follows onMounted
  active.value = true;
  void perf.load(); // a no-op unless the profile changed while the tab was hidden
  offProfile = device.onProfileChanged(() => void perf.load(true));
}
function deactivate() {
  if (!active.value) return;
  active.value = false;
  offProfile?.();
  offProfile = undefined;
}
onMounted(activate);
onActivated(activate);
onDeactivated(deactivate);
onBeforeUnmount(deactivate);

// Fixed hues (not --acc) so no theme's accent can collide with a switch colour.
const GROUP_TONES = ['var(--hue-blue)', 'var(--hue-orange)', 'var(--hue-green)', 'var(--hue-purple)', 'var(--hue-pink)', 'var(--hue-cyan)'];
const toneOf = (i: number) => GROUP_TONES[i] ?? 'var(--fg-3)';

const loaded = computed(() => device.keys.map((k) => k.id).filter((id) => perf.values[id]));
const ids = computed(() => sel.ids.filter((id) => perf.values[id] && isKnownMode(perf.values[id].mode)));

const groups = computed(() => {
  const order = (id: number) => { const i = perf.catalog?.findIndex((e) => e.id === id) ?? -1; return i < 0 ? Infinity : i; };
  return groupKeys(loaded.value, perf.values, order);
});
const multi = computed(() => groups.value.length > 1);
const groupOfKey = computed(() => {
  const m = new Map<number, number>();
  groups.value.forEach((g, i) => g.ids.forEach((id) => m.set(id, i)));
  return m;
});

const entry = (g: KeyGroup) => perf.switchOf(g.ids[0]);
const mm = (rangeMax: number) => formatMm(rangeMax / 1000, 3);
const rowName = (g: KeyGroup) => { const e = entry(g); return e ? switchName(e) : t('sw.unknownRow', { id: g.axisV2Id }); };
const metaOf = (g: KeyGroup) => {
  const e = entry(g);
  const what = e ? (switchBrand(e.id) ?? (e.group === 'Other' ? t('sw.groupOther') : groupName(e.group))) : perf.catalog ? t('sw.unknownMeta', { id: g.axisV2Id }) : t('sw.idMeta', { id: g.axisV2Id });
  return `${what} · ${mm(g.rangeMax)} mm`;
};
const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));

function ledOf(k: PhysicalKey): string | undefined {
  const i = groupOfKey.value.get(k.id);
  return multi.value && i !== undefined ? toneOf(i) : undefined;
}
function nameOfKey(k: PhysicalKey): string | undefined {
  if (!perf.values[k.id]) return undefined;
  const e = perf.switchOf(k.id);
  return e ? switchName(e) : t('sw.unknown');
}
// The keycap legend (DESIGN B §3.4): the switch photo, the group bars when there are two or more groups, the dashed flag.
const shows = computed<LegendItem[] | undefined>(() => {
  if (perf.loading || perf.loadError || !loaded.value.length) return undefined;
  const items: LegendItem[] = [{ text: t('swp.shows') }];
  if (multi.value) items.push({ sample: 'bar', colors: groups.value.map((_, i) => toneOf(i)), label: t('swp.showsGroupsGlyph'), text: t('swp.showsGroups') });
  if (perf.uncalibrated.length) items.push({ sample: 'flag', label: t('sel.flaggedGlyph'), text: t('sel.flagged') });
  return items;
});
const uncalFlag = (k: PhysicalKey) => (perf.uncalibrated.includes(k.id) ? { label: t('kb.uncalibrated') } : undefined);
// Legends of the uncalibrated keys in board order: the first 8, then " +m" for the rest.
const UNCAL_SHOWN = 8;
const uncalKeys = computed(() => {
  const legends = device.keys.filter((k) => perf.uncalibrated.includes(k.id)).map((k) => device.legend(k));
  const rest = legends.length - UNCAL_SHOWN;
  return legends.slice(0, UNCAL_SHOWN).join(', ') + (rest > 0 ? ` +${rest}` : '');
});
</script>

<template>
  <div class="swtab">
    <TabKeyboard :shows="shows">
      <KeyboardView :keys="device.keys" :legend="device.legend" :color="ledOf" :led-height="3" :status="nameOfKey" :flag="uncalFlag" :loading="perf.loading" selectable>
        <template #cap="{ key }"><SwitchSwatch :color="perf.switchOf(key.id)?.color ?? ''" :id="perf.switchOf(key.id)?.id" size="sm" /></template>
      </KeyboardView>
    </TabKeyboard>
    <div class="swp-wrap">
      <div class="swp">
        <Card :title="t('swp.mapTitle')" :subtitle="t('swp.mapSub', { n: device.activeProfile + 1, name: device.profileNames[device.activeProfile] })">
          <div v-if="perf.uncalibrated.length" class="swp__recal" role="status">
            <IconAlertTriangle :size="16" aria-hidden="true" />
            <span class="swp__recal-text">
              {{ t('sw.uncalStatus', { n: perf.uncalibrated.length, keys: uncalKeys }) }}
              <button type="button" class="swp__recal-go" @click="recalibrate">{{ t('sw.recalGo') }}</button>
            </span>
          </div>
          <ul class="swp__list">
            <li v-for="(g, i) in groups" :key="`${g.axisV2Id}:${g.rangeMax}`">
              <button type="button" class="swp__row" :aria-pressed="sameSet(sel.ids, g.ids)" @click="sel.selectMany(g.ids)">
                <span v-if="multi" class="swp__bar" :style="{ '--g': toneOf(i) }" aria-hidden="true" />
                <SwitchSwatch :color="entry(g)?.color ?? ''" :id="entry(g)?.id" />
                <span class="swp__text">
                  <span class="swp__name">{{ rowName(g) }}</span>
                  <span class="swp__meta">{{ metaOf(g) }}</span>
                </span>
                <span class="swp__count num">{{ t('sw.keys', { n: g.ids.length }) }}</span>
              </button>
            </li>
          </ul>
          <p class="swp__hint">{{ t('swp.mapHint') }}</p>
        </Card>
        <SwitchCard :ids="ids" />
      </div>
    </div>
  </div>
</template>

<style scoped>
/* = PageLayout's gap between its keyboard block and the panels, where this tab used to live */
.swtab { display: flex; flex-direction: column; gap: var(--s-5); min-width: 0; }
.swp-wrap { container-type: inline-size; }
.swp { display: grid; grid-template-columns: minmax(0, 7fr) minmax(0, 5fr); gap: var(--s-4); }
@container (max-width: 819.98px) { /* about 900 px windows: one column, the action card first */
  .swp { grid-template-columns: minmax(0, 1fr); }
  .swp > :last-child { order: -1; }
}
.swp__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.swp__row {
  display: flex; align-items: center; gap: var(--s-3); width: 100%; min-height: 52px; padding: 7px 10px 7px 8px;
  border: 0; border-radius: var(--r-control); background: transparent; color: var(--fg-2); font: inherit; text-align: left;
  cursor: pointer; transition: background var(--t-fast) var(--ease);
}
.swp__row:hover { background: var(--bg-3); color: var(--fg-1); }
.swp__row[aria-pressed='true'] { background: var(--sel-bg); color: var(--fg-1); }
.swp__row[aria-pressed='true'] .swp__meta { color: var(--fg-2); } /* --fg-3 on --sel-bg is 3.49:1 in graphite */
.swp__bar { flex: none; width: 4px; height: 28px; border-radius: 2px; background: var(--g); }
.swp__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
.swp__name { font-weight: 600; color: var(--fg-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.swp__meta { font-size: var(--fs-label); color: var(--fg-3); }
.swp__count { flex: none; font-size: var(--fs-label); color: var(--fg-2); }
.swp__recal {
  display: flex; align-items: flex-start; gap: var(--s-2); margin-bottom: var(--s-3);
  padding: var(--s-3);
  border-radius: var(--r-control);
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) var(--soft-pct), var(--bg-2));
  color: var(--fg-1); font-size: var(--fs-label); line-height: 1.45;
}
.swp__recal > svg { flex: none; color: var(--warn); margin-top: 1px; }
.swp__recal-text { flex: 1; display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.swp__recal-go { border: 0; padding: 0; background: none; color: var(--fg-1); font: inherit; font-weight: 600; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.swp__hint { margin: var(--s-3) 0 0; font-size: var(--fs-label); color: var(--fg-3); }
</style>
