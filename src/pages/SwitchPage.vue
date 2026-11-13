<script setup lang="ts">
// Switch and calibration: two independent tabs of one page. Switch = which switch sits under every key and the entry
// point to change it (SwitchCard -> SwitchPicker); Calibration = CalibrationView. Switching tabs sends nothing: the tab
// is the ?tab= query plus one localStorage key. While a calibration session runs the Switch tab is locked, because a
// switch change would write performance records while the keyboard is in calibration mode. E step 4 (temporary): the
// Switch tab is SwitchTab; the five-tab container replaces this page (DESIGN E §3.2).
import { computed, ref, watch } from 'vue';
import { onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import PageLayout from '../components/shell/PageLayout.vue';
import CalibrationView from '../components/calibration/CalibrationView.vue';
import FeatureSwitch from '../components/switch/FeatureSwitch.vue';
import SwitchTab from '../components/switch/SwitchTab.vue';
import IconSwitch from '../components/ui/IconSwitch.vue';
import { IconTarget } from '@tabler/icons-vue';
import { useCalibrationStore } from '../stores/calibration';
import { t } from '../i18n/vi';

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
</script>

<template>
  <PageLayout :title="t('page.switch')">
    <template #toolbar>
      <div class="feat-row">
        <FeatureSwitch :model-value="tab" :items="tabs" :label="t('page.switch')" @update:model-value="pickTab" />
      </div>
    </template>
    <SwitchTab v-if="tab === 'switch'" />
    <CalibrationView v-else />
  </PageLayout>
</template>

<style scoped>
.feat-row { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2) var(--s-4); width: 100%; }
</style>
