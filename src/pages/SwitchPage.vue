<script setup lang="ts">
// Switch and calibration: two independent tabs of one page. Switch = which switch sits under every key and the entry
// point to change it (SwitchCard -> SwitchPicker); Calibration = CalibrationView. Switching tabs sends nothing: the tab
// is the ?tab= query plus one localStorage key. While a calibration session runs the Switch tab is locked, because a
// switch change would write performance records while the keyboard is in calibration mode.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import CalibrationView from '../components/calibration/CalibrationView.vue';
import Card from '../components/ui/Card.vue';
import FeatureSwitch from '../components/switch/FeatureSwitch.vue';
import IconSwitch from '../components/ui/IconSwitch.vue';
import { IconTarget } from '@tabler/icons-vue';
import { formatMm } from '../components/ui/NumberField.vue';
import SwitchCard from '../components/performance/SwitchCard.vue';
import SwitchSwatch from '../components/performance/SwitchSwatch.vue';
import { groupKeys } from '../components/performance/switchGroups';
import type { KeyGroup } from '../components/performance/switchGroups';
import { groupName, switchBrand, switchName } from '../data/switchDisplay';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { isKnownMode, usePerformanceStore } from '../stores/performance';
import { useCalibrationStore } from '../stores/calibration';
import type { PhysicalKey } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const perf = usePerformanceStore();
const sel = useSelectionStore();
const cal = useCalibrationStore();
const route = useRoute();
const router = useRouter();

type Tab = 'switch' | 'calibration';
const TAB_KEY = 'ae64.switchTab';
const asTab = (v: unknown): Tab | null => (v === 'switch' || v === 'calibration' ? v : null);
function storedTab(): Tab | null {
  try { return asTab(localStorage.getItem(TAB_KEY)); } catch { return null; }
}
function saveTab(v: Tab) {
  try { localStorage.setItem(TAB_KEY, v); } catch { /* storage unavailable: the tab is just not remembered */ }
}
const tab = ref<Tab>(asTab(route.query.tab) ?? storedTab() ?? 'switch');
saveTab(tab.value); // opened through a link (?tab=, or /calibration) also counts as the last-used tab
const calBusy = computed(() => cal.phase !== 'idle');
const tabs = computed(() => [
  {
    id: 'switch', title: t('swp.tabSwitch'), sub: calBusy.value ? t('swp.calLockedShort') : t('swp.tabSwitchSub'),
    icon: IconSwitch, tone: 'var(--f-switch)', disabled: calBusy.value, hint: calBusy.value ? t('swp.calLocked') : undefined,
  },
  { id: 'calibration', title: t('swp.tabCalibration'), sub: t('swp.tabCalibrationSub'), icon: IconTarget, tone: 'var(--f-calibration)' },
]);
function pickTab(id: string) {
  const next = asTab(id);
  if (!next || next === tab.value || (calBusy.value && next !== 'calibration')) return;
  tab.value = next;
  saveTab(next);
  void router.replace({ query: { tab: next } });
}
// A link or a hand-edited URL changed ?tab=. A route without a valid ?tab= keeps the current tab.
watch(() => route.query.tab, (v) => {
  const next = asTab(v);
  if (next && next !== tab.value && !(calBusy.value && next !== 'calibration')) { tab.value = next; saveTab(next); }
});
onBeforeRouteUpdate((to) => (calBusy.value && (asTab(to.query.tab) ?? tab.value) !== 'calibration' ? false : undefined));

let offProfile: (() => void) | undefined;
onMounted(() => {
  void perf.load();
  offProfile = device.onProfileChanged(() => void perf.load(true));
});
onBeforeUnmount(() => offProfile?.());

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
</script>

<template>
  <PageLayout :title="t('page.switch')" :keyboard="tab === 'switch'">
    <template #toolbar>
      <div class="feat-row">
        <FeatureSwitch :model-value="tab" :items="tabs" :label="t('page.switch')" @update:model-value="pickTab" />
      </div>
    </template>
    <template v-if="tab === 'switch'" #keyboard>
      <KeyboardView :keys="device.keys" :legend="device.legend" :color="ledOf" :led-height="3" :status="nameOfKey" :loading="perf.loading" selectable>
        <template #cap="{ key }"><SwitchSwatch :color="perf.switchOf(key.id)?.color ?? ''" :id="perf.switchOf(key.id)?.id" size="sm" /></template>
      </KeyboardView>
    </template>
    <div v-if="tab === 'switch'" class="swp-wrap">
      <div class="swp">
        <Card :title="t('swp.mapTitle')" :subtitle="t('swp.mapSub', { n: device.activeProfile + 1, name: device.profileNames[device.activeProfile] })">
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
    <CalibrationView v-else />
  </PageLayout>
</template>

<style scoped>
.feat-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2) var(--s-4); width: 100%; }
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
.swp__hint { margin: var(--s-3) 0 0; font-size: var(--fs-label); color: var(--fg-3); }
</style>
