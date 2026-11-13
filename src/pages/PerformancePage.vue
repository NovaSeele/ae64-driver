<script setup lang="ts">
// Hiệu năng (DESIGN E §3.2): one page, five independent tabs (Hành trình · Phím nâng cao · Switch · Hiệu chuẩn · Kiểm tra
// phím) over one keyboard frame. The tab is ?tab= (normalised by the router's beforeEach) plus one localStorage key;
// opening a tab is a history entry and sends nothing to the keyboard. Travel, Advanced and Switch are kept alive (their
// data is read once per profile); Calibration and Key test start over each time, as their pages did.
import { computed, defineAsyncComponent, provide, ref, watch } from 'vue';
import type { Component } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type { RouteLocationNormalized } from 'vue-router';
import { IconActivity, IconAdjustmentsHorizontal, IconBolt, IconEye, IconKeyboard, IconLock, IconTarget } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import FeatureSwitch from '../components/switch/FeatureSwitch.vue';
import IconSwitch from '../components/ui/IconSwitch.vue';
import TravelTab from '../components/performance/TravelTab.vue';
import { PTAB_TOOLS } from '../components/performance/tabTools';
import { asPerfTab, saveTab, storedTab } from '../router';
import type { PerfTab } from '../router';
import { useDeviceStore } from '../stores/device';
import { useCalibrationStore } from '../stores/calibration';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';

const device = useDeviceStore();
const cal = useCalibrationStore();
const route = useRoute();
const router = useRouter();

// The default tab ships with the page (the first page is in the main bundle, as before); the others are their own chunks.
const TAB_COMPONENT: Record<PerfTab, Component> = {
  travel: TravelTab,
  advanced: defineAsyncComponent(() => import('../components/advanced/AdvancedTab.vue')),
  switch: defineAsyncComponent(() => import('../components/switch/SwitchTab.vue')),
  calibration: defineAsyncComponent(() => import('../components/calibration/CalibrationView.vue')),
  test: defineAsyncComponent(() => import('../components/live/TestTab.vue')),
};
const KEPT = ['TravelTab', 'AdvancedTab', 'SwitchTab'];

/** The open tab. The router's beforeEach always puts a valid ?tab= on /performance; the fallbacks are for safety. */
const tab = computed<PerfTab>(() => asPerfTab(route.query.tab) ?? storedTab() ?? 'travel');
// Opened through a link or an old bookmark also counts as the last-used tab.
watch(tab, saveTab, { immediate: true });
const calBusy = computed(() => cal.phase !== 'idle');

type Scope = 'profile' | 'board' | 'read';
const TABS: { id: PerfTab; title: MessageKey; sub: MessageKey; icon: Component; tone: string; scope: Scope }[] = [
  { id: 'travel', title: 'ptab.travel', sub: 'ptab.travelSub', icon: IconAdjustmentsHorizontal, tone: 'var(--f-performance)', scope: 'profile' },
  { id: 'advanced', title: 'page.advanced', sub: 'ptab.advancedSub', icon: IconBolt, tone: 'var(--f-advanced)', scope: 'profile' },
  { id: 'switch', title: 'swp.tabSwitch', sub: 'swp.tabSwitchSub', icon: IconSwitch, tone: 'var(--f-switch)', scope: 'profile' },
  { id: 'calibration', title: 'swp.tabCalibration', sub: 'swp.tabCalibrationSub', icon: IconTarget, tone: 'var(--f-calibration)', scope: 'board' },
  { id: 'test', title: 'ptab.test', sub: 'ptab.testSub', icon: IconActivity, tone: 'var(--f-live)', scope: 'read' },
];
const profileName = computed(() => device.profileNames[device.activeProfile] ?? '');
const scopeText = (s: Scope) => (s === 'profile' ? t('ptab.scopeProfile', { name: profileName.value }) : s === 'board' ? t('ptab.scopeBoard') : t('ptab.scopeRead'));
const tabItems = computed(() => TABS.map((x) => ({
  id: x.id, title: t(x.title), sub: t(x.sub), icon: x.icon, tone: x.tone, scope: scopeText(x.scope),
  disabled: calBusy.value && x.id !== 'calibration', hint: calBusy.value ? t('ptab.locked') : undefined,
})));
const current = computed(() => TABS.find((x) => x.id === tab.value)!);
/** "Đang sửa profile {name}" around the name, which is user data: the one part of the line allowed to end in "…". */
const scopeParts = computed(() => t('ptab.scopeProfile', { name: '\u0000' }).split('\u0000'));

/** Open a tab (click, Enter, Space). The tab's own query (key, check) is dropped; the open tab does nothing. */
function open(id: string) {
  const next = asPerfTab(id);
  if (!next || next === tab.value) return;
  void router.push({ query: { tab: next } });
}

// ----- view tools: the open tab (Travel) teleports them into the toolbar
const toolsEl = ref<HTMLElement | null>(null);
provide(PTAB_TOOLS, toolsEl);

// ----- locks and drafts (DESIGN E §3.7)
/** The open tab's instance; only AdvancedTab exposes anything (`dirty`, `askDiscard`). */
const cur = ref<{ dirty?: boolean; askDiscard?: (then: () => void) => void } | null>(null);
const tabOf = (to: RouteLocationNormalized) => (to.path === '/performance' ? asPerfTab(to.query.tab) ?? tab.value : null);
/** A dirty Advanced draft: ask with the tab's own dialog; "Bỏ thay đổi" drops it, then the navigation is pushed again. */
function draftGuard(to: RouteLocationNormalized): false | undefined {
  if (tab.value !== 'advanced' || tabOf(to) === 'advanced' || !cur.value?.dirty || !cur.value.askDiscard) return undefined;
  cur.value.askDiscard(() => void router.push(to.fullPath));
  return false;
}
onBeforeRouteUpdate((to) => {
  // While a calibration session runs, only the Calibration tab can be open: Back and links to another tab stay put.
  if (calBusy.value && tabOf(to) !== 'calibration') return false;
  return draftGuard(to);
});
// Leaving the page: CalibrationView keeps its own leave guard (calibration.confirmLeave).
onBeforeRouteLeave((to) => draftGuard(to));
</script>

<template>
  <PageLayout :title="t('page.performance')" :doc-title="`${t(current.title)} · ${t('page.performance')}`">
    <template #toolbar>
      <div class="ph">
        <FeatureSwitch compact manual :model-value="tab" :items="tabItems" :label="t('page.performance')" id-prefix="ptab" controls="ptab-panel" @update:model-value="open" />
        <div class="ph__line">
          <p class="ph__info">
            <span class="ph__cell">
              <span class="ph__scope">
                <template v-if="current.scope === 'profile'">
                  <span class="ph__n num" aria-hidden="true">{{ device.activeProfile + 1 }}</span>
                  <span>{{ scopeParts[0] }}<span class="ph__name" :title="profileName">{{ profileName }}</span>{{ scopeParts[1] }}</span>
                </template>
                <template v-else>
                  <component :is="current.scope === 'board' ? IconKeyboard : IconEye" :size="16" stroke-width="1.75" aria-hidden="true" />
                  <span>{{ scopeText(current.scope) }}</span>
                </template>
              </span>
            </span>
            <span v-if="calBusy" class="ph__cell ph__lock"><IconLock :size="15" stroke-width="2" aria-hidden="true" /><span>{{ t('ptab.locked') }}</span></span>
            <span v-else class="ph__cell ph__desc">{{ t(current.sub) }}</span>
          </p>
          <!-- the open tab's view tools (Travel teleports its chips here); empty: hidden -->
          <div ref="toolsEl" class="ph__tools" />
        </div>
      </div>
    </template>
    <div id="ptab-panel" role="tabpanel" :aria-labelledby="`ptab-${tab}`">
      <KeepAlive :include="KEPT">
        <component :is="TAB_COMPONENT[tab]" :key="tab" ref="cur" />
      </KeepAlive>
    </div>
  </PageLayout>
</template>

<style scoped>
/* E4 (DESIGN E §3.2, §3.4): the tab row, then the scope line (scope + description left, the open tab's view tools right).
   Same height in every tab, so the keyboard below never moves. */
.ph { container-type: inline-size; display: flex; flex-direction: column; gap: var(--s-3); width: 100%; }
.ph__line { display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2) var(--s-4); min-height: 32px; }
/* Scope first, description second. The description shows only when it fits whole on the same row: otherwise it wraps to a
   second flex row that the 32 px box clips (no JS, no "…"). It is also the open tab's aria-describedby text. */
.ph__info {
  flex: 1 1 240px; min-width: 240px; height: 32px; overflow: hidden; margin: 0;
  display: flex; flex-wrap: wrap; align-items: center; column-gap: var(--s-3);
  font-size: var(--fs-label); white-space: nowrap;
}
.ph__cell { display: inline-flex; align-items: center; height: 32px; min-width: 0; }
.ph__scope {
  display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 10px 0 5px;
  border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--bg-2);
  color: var(--fg-1); font-weight: 500;
}
.ph__scope svg { flex: none; color: var(--fg-2); }
/* = the sidebar profile chip (.ps__chip): the same number on the same accent, so "which profile" reads at a glance */
.ph__n {
  display: grid; place-items: center; flex: none; width: 18px; height: 18px; border-radius: 5px;
  font-size: var(--fs-caption); font-weight: 600; background: var(--acc); color: var(--on-acc);
}
.ph__name { display: inline-block; max-width: 22ch; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; } /* user data: may end in "…" + title */
.ph__desc { color: var(--fg-3); }
.ph__lock { gap: 6px; color: var(--fg-1); font-weight: 500; }
.ph__lock svg { flex: none; color: var(--warn); }
.ph__tools { flex: none; display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2) var(--s-3); margin-left: auto; }
.ph__tools:empty { display: none; }
</style>

<style>
/* The page scroller keeps its scrollbar's room on this page: a short tab (Switch at 1920×1080) would otherwise lose the
   scrollbar and move the keyboard frame by half its width (E3: ≤ 1 px across the five tabs). Other pages are unchanged. */
.main__scroll:has(#ptab-panel) { scrollbar-gutter: stable; }
</style>
