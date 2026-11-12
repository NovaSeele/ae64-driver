<script setup lang="ts">
// Switch picker dialog. Choosing writes nothing; the only write is the Apply button.
import { computed, nextTick, ref, watch } from 'vue';
import { IconAlertTriangle, IconArrowRight, IconInfoCircle } from '@tabler/icons-vue';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Tabs from '../ui/Tabs.vue';
import { formatMm } from '../ui/NumberField.vue';
import { useToast } from '../ui/toast';
import SwitchSwatch from './SwitchSwatch.vue';
import { groupKeys } from './switchGroups';
import { makerTabOf, makerTabs, OTHER_TAB, switchBrand, switchName } from '../../data/switchDisplay';
import type { SwitchEntry } from '../../protocol/switches';
import { isRtMode } from '../../protocol';
import { useDeviceStore } from '../../stores/device';
import { usePerformanceStore } from '../../stores/performance';
import { t } from '../../i18n/vi';

const open = defineModel<boolean>('open', { required: true });
const props = defineProps<{ ids: number[] }>();
const emit = defineEmits<{ applied: [] }>();

const perf = usePerformanceStore();
const device = useDeviceStore();

const entries = computed(() => perf.catalog ?? []);
const grouped = computed(() => makerTabs(entries.value));
const tabs = computed(() => grouped.value.map((g) => ({ id: g.id, label: g.label ?? t('sw.groupOther'), count: g.entries.length })));
const tabLabel = (id: string) => tabs.value.find((x) => x.id === id)?.label ?? t('sw.groupOther');

const keyGroups = computed(() => groupKeys(props.ids, perf.values, () => 0));
const single = computed(() => keyGroups.value.length === 1);
/** The maker eyebrow, only where the active tab does not already name that maker (all of Other, KTEK in TTC); never Unknown. */
const brandOf = (e: SwitchEntry) => {
  const b = switchBrand(e.id);
  return b && b !== tab.value ? b : null;
};
const inUse = computed(() => new Map(keyGroups.value.map((g) => [g.axisV2Id, g.ids.length] as const)));
const known = (id: number) => entries.value.find((e) => e.id === id);
/** Tab of the most-used known switch among the keys, else the first tab. */
const defaultTab = () => {
  const g = keyGroups.value.find((k) => known(k.axisV2Id));
  return (g && makerTabOf(grouped.value, g.axisV2Id)) || grouped.value[0]?.id || OTHER_TAB;
};

const tab = ref<string>(OTHER_TAB);
const chosen = ref<SwitchEntry | null>(null);
const list = ref<HTMLElement | null>(null);

const shown = computed(() => grouped.value.find((g) => g.id === tab.value)?.entries ?? []);
/** Roving tabindex: the chosen option if in this tab, else the in-use one, else the first. */
const rovingId = computed(() => {
  const s = shown.value;
  if (chosen.value && s.some((e) => e.id === chosen.value!.id)) return chosen.value.id;
  return (s.find((e) => inUse.value.has(e.id)) ?? s[0])?.id;
});

watch(open, async (v) => {
  if (!v) return;
  chosen.value = null;
  tab.value = defaultTab();
  await nextTick();
  await nextTick(); // after Dialog's own first-focus
  list.value?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
});
watch(() => device.connection, () => { open.value = false; });

function onKey(e: KeyboardEvent) {
  const n = shown.value.length;
  const i = shown.value.findIndex((x) => x.id === chosen.value?.id);
  const cols = Math.max(1, (list.value ? getComputedStyle(list.value).gridTemplateColumns : '').split(' ').length);
  const from = i < 0 ? shown.value.findIndex((x) => x.id === rovingId.value) : i;
  let to: number;
  switch (e.key) {
    case 'ArrowRight': to = from + 1; break;
    case 'ArrowLeft': to = from - 1; break;
    case 'ArrowDown': to = from + cols; break;
    case 'ArrowUp': to = from - cols; break;
    case 'Home': to = 0; break;
    case 'End': to = n - 1; break;
    default: return;
  }
  e.preventDefault();
  to = ((to % n) + n) % n;
  chosen.value = shown.value[to];
  list.value?.querySelectorAll<HTMLElement>('.sw-opt')[to]?.focus();
}

const plan = computed(() => (chosen.value ? perf.planSwitch(props.ids, chosen.value) : null));
const clampLines = computed(() => {
  if (!plan.value) return { act: 0, other: 0 };
  const act = new Set(plan.value.clamped.filter((c) => c.field === (isRtMode(perf.values[c.id].mode) ? 'rtFirstTouch' : 'normalPress')).map((c) => c.id));
  const other = new Set(plan.value.clamped.map((c) => c.id).filter((id) => !act.has(id)));
  return { act: act.size, other: other.size };
});
const limit = computed(() => (plan.value ? formatMm(plan.value.limitMm, 3) : ''));
const mm = (rangeMax: number) => formatMm(rangeMax / 1000, 3);

const from = computed(() => {
  const g = keyGroups.value[0];
  const e = g ? known(g.axisV2Id) : undefined;
  return { entry: e, rangeMax: g?.rangeMax ?? 0 };
});

function apply() {
  const entry = chosen.value;
  const n = plan.value?.keys.length ?? 0;
  if (!entry || !n) return;
  perf.applySwitch(props.ids, entry);
  open.value = false;
  useToast().show(t('sw.applied', { n, name: switchName(entry) }), 'success');
  emit('applied');
}
</script>

<template>
  <Dialog v-model:open="open" :title="t('sw.pickTitle')" :width="800">
    <div class="swp">
      <p class="swp__for"><b>{{ t('sw.forKeys', { n: ids.length }) }}</b> · {{ t('sw.forProfile') }} <b>{{ device.activeProfileName }}</b></p>
      <Tabs v-model="tab" :items="tabs" :label="t('sw.groups')" />
      <div ref="list" class="swp__list" role="radiogroup" :aria-label="tabLabel(tab)">
        <button
          v-for="e in shown"
          :key="e.id"
          type="button"
          role="radio"
          class="sw-opt"
          :aria-checked="chosen?.id === e.id"
          :tabindex="e.id === rovingId ? 0 : -1"
          @click="chosen = e"
          @keydown="onKey"
        >
          <SwitchSwatch :color="e.color" :id="e.id" />
          <span class="sw-opt__text">
            <span v-if="brandOf(e)" class="sw-opt__brand">{{ brandOf(e) }}</span>
            <span class="sw-opt__name" :title="switchName(e)">{{ switchName(e) }}</span>
            <span class="sw-opt__meta">
              <span class="sw-opt__mm">{{ mm(e.rangeMax) }}<small>mm</small></span>
              <span v-if="inUse.get(e.id)" class="sw-opt__tag">{{ single ? t('sw.inUse') : t('sw.keys', { n: inUse.get(e.id)! }) }}</span>
            </span>
          </span>
        </button>
      </div>
      <div class="swp__sum" aria-live="polite">
        <p v-if="!chosen" class="swp__idle">{{ t('sw.idle') }}</p>
        <p v-else-if="!plan?.keys.length" class="swp__idle">{{ t('sw.same') }}</p>
        <template v-else>
          <div class="swp__change">
            <template v-if="single">
              <SwitchSwatch :color="from.entry?.color ?? ''" :id="from.entry?.id" size="sm" />
              <span class="nm">{{ from.entry ? switchName(from.entry) : t('sw.unknown') }}</span>
              <span class="mm">{{ mm(from.rangeMax) }} mm</span>
            </template>
            <span v-else class="nm">{{ t('sw.kinds', { n: keyGroups.length }) }}</span>
            <IconArrowRight class="arrow" :size="16" aria-hidden="true" />
            <SwitchSwatch :color="chosen.color" :id="chosen.id" size="sm" />
            <span class="nm">{{ switchName(chosen) }}</span>
            <span class="mm">{{ mm(chosen.rangeMax) }} mm</span>
          </div>
          <p v-if="clampLines.act" class="swp__warn"><IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clampAct', { n: clampLines.act, max: limit }) }}</p>
          <p v-if="clampLines.other" class="swp__warn"><IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clampOther', { n: clampLines.other, max: limit }) }}</p>
          <p class="swp__warn"><IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clearsCal', { n: plan.keys.length }) }}</p>
        </template>
        <p class="swp__info"><IconInfoCircle :size="15" aria-hidden="true" />{{ t('sw.profileOnly', { profile: device.activeProfileName }) }}</p>
      </div>
    </div>
    <template #footer>
      <Button variant="secondary" @click="open = false">{{ t('sw.cancel') }}</Button>
      <Button variant="primary" :disabled="!plan?.keys.length" @click="apply">
        {{ plan?.keys.length ? t('sw.apply', { n: plan.keys.length }) : t('sw.applyBare') }}
      </Button>
    </template>
  </Dialog>
</template>

<style scoped>
.swp { display: flex; flex-direction: column; gap: var(--s-3); min-height: 0; }
.swp__for { margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.swp__for b { color: var(--fg-1); font-weight: 600; }
.swp__list {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--s-2); align-content: start;
  grid-auto-rows: max-content; /* with a fixed height, auto rows would shrink below their content */
  /* one fixed box for every tab, so a short tab never re-centres the dialog; the floor keeps tiles visible on short
     windows, where the dialog body scrolls instead. The summary reserve below takes the rest. */
  flex: none; height: clamp(160px, calc(100vh - 460px), 372px); overflow-y: auto;
  padding: 2px; margin: -2px; /* room for the focus ring */
  scrollbar-gutter: stable;
}
.sw-opt {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  min-height: 52px; padding: 8px 10px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  color: var(--fg-1); text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.sw-opt:hover { background: var(--bg-4); border-color: var(--line-3); }
.sw-opt:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.sw-opt[aria-checked='true'] { background: var(--sel-bg); border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc); }
.sw-opt__text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
/* maker eyebrow: only when the tab does not already name the maker, never "Unknown" */
.sw-opt__brand { display: block; font-size: var(--fs-caption); font-weight: 600; line-height: 14px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-opt:hover .sw-opt__brand, .sw-opt[aria-checked='true'] .sw-opt__brand { color: var(--fg-2); }
.sw-opt__name { font-size: var(--fs-body); font-weight: 500; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; }
.sw-opt__mm { flex: none; white-space: nowrap; font-size: var(--fs-label); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.sw-opt__mm small { font-size: var(--fs-caption); margin-left: 1px; }
.sw-opt[aria-checked='true'] .sw-opt__mm { color: var(--fg-1); }
.sw-opt__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 6px; min-width: 0; } /* the tag wraps on 170-180px tiles instead of overflowing */
.sw-opt__tag {
  padding: 0 4px; border-radius: 4px; white-space: nowrap;
  font-size: var(--fs-caption); font-weight: 600; line-height: 16px;
  color: var(--fg-2); background: var(--bg-2); border: 1px solid var(--line-2);
}
.swp__sum { display: flex; flex-direction: column; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--line-1); }
/* reserve the tallest common summary (change row with 22px photos + two warnings + profile line) so the centred dialog never moves */
.swp__sum { min-height: 112px; }
.swp__change { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; font-size: var(--fs-body); color: var(--fg-1); }
.swp__change .nm { font-weight: 600; }
.swp__change .mm { color: var(--fg-2); font-variant-numeric: tabular-nums; }
.swp__change .arrow { color: var(--fg-3); }
.swp__idle { margin: 0; font-size: var(--fs-body); color: var(--fg-3); }
.swp__warn, .swp__info { display: flex; gap: var(--s-2); align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 1.45; }
.swp__warn { color: var(--fg-1); }
.swp__warn svg { color: var(--warn); flex: none; margin-top: 1px; }
.swp__info { color: var(--fg-2); }
.swp__info svg { color: var(--fg-3); flex: none; margin-top: 1px; }
</style>
