<script setup lang="ts">
// Switch (the Switch tab of the Performance page, DESIGN E §3.6 & DESIGN CSW §7.9, §8, §9.5, §10.2, §11.2):
// which switch sits under every key, the keycap photo/travel toggle, recalibration status, check strip,
// post-Apply verify line, and SwitchCard -> SwitchPicker. Kept alive while visiting other Performance tabs.
import { computed, nextTick, onActivated, onBeforeUnmount, onDeactivated, onMounted, ref, useId, watch } from 'vue';
import { useRouter } from 'vue-router';
import KeyboardView from '../keyboard/KeyboardView.vue';
import TabKeyboard from '../keyboard/TabKeyboard.vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import IconButton from '../ui/IconButton.vue';
import Segmented from '../ui/Segmented.vue';
import { useToast } from '../ui/toast';
import { IconAlertOctagon, IconAlertTriangle, IconCircleCheck, IconInfoCircle, IconRefresh, IconX } from '@tabler/icons-vue';
import { formatMm } from '../ui/NumberField.vue';
import SwitchCard from '../performance/SwitchCard.vue';
import SwitchSwatch from '../performance/SwitchSwatch.vue';
import { groupKeys, identityOrder, switchRangeUm, swatchForKeySwitch } from '../performance/switchGroups';
import type { KeyGroup } from '../performance/switchGroups';
import { GENERIC_UID, switchCaps, writeSwitchCaps } from '../../data/customSwitch';
import type { SwitchCapsView } from '../../data/customSwitch';
import { groupName, switchBrand, switchName } from '../../data/switchDisplay';
import { useDeviceStore } from '../../stores/device';
import { useSelectionStore } from '../../stores/selection';
import { customSwitchName, isKnownMode, usePerformanceStore } from '../../stores/performance';
import type { LostKey, StaleKey } from '../../stores/performance';
import type { PhysicalKey } from '../../protocol';
import type { LegendItem } from '../keyboard/SelectionBar.vue';
import { t } from '../../i18n/vi';

defineOptions({ name: 'SwitchTab' });
const device = useDeviceStore();
const perf = usePerformanceStore();
const sel = useSelectionStore();
const router = useRouter();
const capViewId = useId();
const switchCardRef = ref<InstanceType<typeof SwitchCard> | null>(null);

/** "Hiệu chuẩn ngay": the Calibration tab of this page (DESIGN E §3.1). */
const recalibrate = () => void router.push({ query: { tab: 'calibration' } });
/** "Kiểm tra ngay": the Key test tab with auto-start check (§7.9). */
const goVerify = () => void router.push({ path: '/performance', query: { tab: 'test', check: '1' } });

// ---- Keycap view toggle ('photo' | 'travel', stored in localStorage, 0 HID, §9.5)
const capView = ref<SwitchCapsView>(switchCaps());
const capViewModel = computed<SwitchCapsView | null>({
  get: () => capView.value,
  set: (v) => { if (v) capView.value = v; },
});
watch(capView, (v) => writeSwitchCaps(v));
const capViewOptions = computed(() => [
  { value: 'photo' as const, label: t('swp.capPhoto') },
  { value: 'travel' as const, label: t('swp.capTravel') },
]);

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
const canEdit = computed(() => device.boardAllowed && !!perf.catalog);

const groups = computed(() =>
  groupKeys(loaded.value, (id) => perf.keySwitch(id), (ks) => identityOrder(ks, perf.catalog)),
);
const multi = computed(() => groups.value.length > 1);
const groupOfKey = computed(() => {
  const m = new Map<number, number>();
  groups.value.forEach((g, i) => g.ids.forEach((id) => m.set(id, i)));
  return m;
});

const mm = (rangeMax: number) => formatMm(rangeMax / 1000, 3);
const sameSet = (a: number[], b: number[]) => a.length === b.length && a.every((id) => b.includes(id));

function swatchOf(g: KeyGroup) {
  return swatchForKeySwitch(g.identity, perf.customSwitches);
}

function swatchOfKey(keyId: number) {
  return swatchForKeySwitch(perf.keySwitch(keyId), perf.customSwitches);
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

function metaOf(g: KeyGroup): string {
  switch (g.identity.kind) {
    case 'catalog': {
      const e = g.identity.entry;
      const what = switchBrand(e.id) ?? (e.group === 'Other' ? t('sw.groupOther') : groupName(e.group));
      return `${what} · ${mm(e.rangeMax)} mm`;
    }
    case 'custom':
      return t('csw.metaCustom', { maker: g.identity.custom.maker || t('csw.kind'), mm: mm(g.rangeMax) });
    case 'unnamed':
      return t('csw.metaUnnamed', { mm: mm(g.identity.triple.axisRangeMax), coef: g.identity.triple.axisCoefficient });
    case 'lost':
      return t('csw.lostMeta');
    case 'unknown': {
      const id = g.identity.triple.axisV2Id;
      const what = perf.catalog ? t('sw.unknownMeta', { id }) : t('sw.idMeta', { id });
      return `${what} · ${mm(g.rangeMax)} mm`;
    }
  }
}

function ledOf(k: PhysicalKey): string | undefined {
  const i = groupOfKey.value.get(k.id);
  return multi.value && i !== undefined ? toneOf(i) : undefined;
}

/** Keycap sublabel shown in 'travel' view (§9.5): R with 2 decimals, '—' for lost, nothing while loading/failed. */
function travelSublabel(k: PhysicalKey): string | undefined {
  if (perf.loading || perf.loadError) return undefined;
  const ks = perf.keySwitch(k.id);
  if (!ks) return undefined;
  return ks.kind === 'lost' ? '—' : formatMm(switchRangeUm(ks) / 1000, 2);
}

/** Accessible travel inserted after the legend in BOTH photo and travel views (§9.5). */
function travelAria(k: PhysicalKey): string | undefined {
  if (perf.loading || perf.loadError) return undefined;
  const ks = perf.keySwitch(k.id);
  if (!ks) return undefined;
  return ks.kind === 'lost' ? t('csw.lost') : `${formatMm(switchRangeUm(ks) / 1000, 2)} mm`;
}

function nameOfKey(k: PhysicalKey): string | undefined {
  if (perf.loading || perf.loadError) return undefined;
  const ks = perf.keySwitch(k.id);
  if (!ks) return undefined;
  switch (ks.kind) {
    case 'lost': return undefined; // travelAria already names lost keys as csw.lost
    case 'custom': return ks.custom.uid === GENERIC_UID ? t('csw.generic') : ks.custom.name;
    case 'catalog': return switchName(ks.entry);
    case 'unnamed': return t('csw.unnamed');
    case 'unknown': return t('sw.unknown');
  }
}

function legendFor(view: SwitchCapsView): LegendItem[] {
  const items: LegendItem[] = [{ text: t(view === 'travel' ? 'swp.showsTravel' : 'swp.shows') }];
  if (multi.value) items.push({ sample: 'bar', colors: groups.value.map((_, i) => toneOf(i)), label: t('swp.showsGroupsGlyph'), text: t('swp.showsGroups') });
  if (perf.needsCal.length) items.push({ sample: 'flag', label: t('sel.flaggedGlyph'), text: t('sel.flagged') });
  return items;
}

const shows = computed<LegendItem[] | undefined>(() => {
  if (perf.loading || perf.loadError || !loaded.value.length) return undefined;
  return legendFor(capView.value);
});
const showsAlt = computed<LegendItem[][] | undefined>(() => {
  if (perf.loading || perf.loadError || !loaded.value.length) return undefined;
  return [legendFor(capView.value === 'travel' ? 'photo' : 'travel')];
});

const uncalFlag = (k: PhysicalKey) => (perf.needsCal.includes(k.id) ? { label: t('kb.uncalibrated') } : undefined);

// Legends of a set of key ids in board order: the first 8, then " +m" for the rest.
const KEYS_SHOWN = 8;
function formatKeyList(keyIds: readonly number[]): string {
  const set = new Set(keyIds);
  const legends = device.keys.filter((k) => set.has(k.id)).map((k) => device.legend(k));
  const rest = legends.length - KEYS_SHOWN;
  return legends.slice(0, KEYS_SHOWN).join(', ') + (rest > 0 ? ` +${rest}` : '');
}

const uncalKeys = computed(() => formatKeyList(perf.needsCal));

// ---- Check strip rows (§11.2): stale assigned groups, lost assigned groups, unassigned lost keys
interface CheckRow {
  key: string;
  kind: 'stale' | 'lostNamed' | 'lost';
  ids: number[];
  uid?: string;
  forgetName?: string;
  text: string;
}

const checkRows = computed<CheckRow[]>(() => {
  const rows: CheckRow[] = [];

  // Stale assigned entries, grouped by uid in board order
  const staleByUid = new Map<string, StaleKey[]>();
  for (const s of perf.staleKeys) {
    const arr = staleByUid.get(s.uid);
    if (arr) arr.push(s);
    else staleByUid.set(s.uid, [s]);
  }
  for (const [uid, list] of staleByUid) {
    const first = list[0];
    const keyIds = list.map((x) => x.id);
    const keys = formatKeyList(keyIds);
    const n = keyIds.length;
    const name = customSwitchName(first.custom);
    const forgetName = first.isGeneric ? t('csw.generic') : first.custom.name;
    let text: string;
    if (first.isGeneric) {
      const sameRange = list.every((x) => x.actual.axisRangeMax === first.actual.axisRangeMax);
      text = sameRange
        ? t('sw.staleGeneric', { name, keys, n, um: first.actual.axisRangeMax, wum: first.expected.rangeUm })
        : t('sw.staleRowMixed', { name, keys });
    } else {
      const sameActual = list.every(
        (x) => x.actual.axisRangeMax === first.actual.axisRangeMax && x.actual.axisCoefficient === first.actual.axisCoefficient,
      );
      text = sameActual
        ? t('sw.staleRow', {
            name, keys, n,
            um: first.actual.axisRangeMax, coef: first.actual.axisCoefficient,
            wum: first.expected.rangeUm, wcoef: first.expected.coefficient,
          })
        : t('sw.staleRowMixed', { name, keys });
    }
    rows.push({ key: `stale:${uid}`, kind: 'stale', ids: keyIds, uid, forgetName, text });
  }

  // Lost assigned entries, grouped by uid
  const lostNamed = new Map<string, LostKey[]>();
  const lostUnnamed: LostKey[] = [];
  for (const l of perf.lostKeys) {
    if (l.uid && l.custom) {
      const arr = lostNamed.get(l.uid);
      if (arr) arr.push(l);
      else lostNamed.set(l.uid, [l]);
    } else {
      lostUnnamed.push(l);
    }
  }
  for (const [uid, list] of lostNamed) {
    const first = list[0];
    const keyIds = list.map((x) => x.id);
    const keys = formatKeyList(keyIds);
    const name = customSwitchName(first.custom!);
    const forgetName = uid === GENERIC_UID ? t('csw.generic') : first.custom!.name;
    rows.push({
      key: `lost:${uid}`,
      kind: 'lostNamed',
      ids: keyIds,
      uid,
      forgetName,
      text: t('sw.lostRowNamed', { name, keys, n: keyIds.length }),
    });
  }
  if (lostUnnamed.length) {
    const keyIds = lostUnnamed.map((x) => x.id);
    rows.push({
      key: 'lost:unnamed',
      kind: 'lost',
      ids: keyIds,
      text: t('sw.lostRow', { n: keyIds.length, keys: formatKeyList(keyIds) }),
    });
  }

  return rows;
});

/** "Áp dụng lại": selects the keys and opens SwitchPicker on the custom tab with the entry chosen. 0 HID (§11.2, M15). */
async function reapplyRow(row: CheckRow) {
  if (!row.uid || !canEdit.value) return;
  sel.selectMany(row.ids);
  await nextTick();
  switchCardRef.value?.openPicker({ uid: row.uid });
}

/** "Quên": removes assignments locally, toast sw.forgot. 0 HID (§11.2). */
function forgetRow(row: CheckRow) {
  perf.forgetKeys(row.ids);
  useToast().show(t('sw.forgot', { name: row.forgetName ?? '', n: row.ids.length }), 'info');
}

/** "Chọn switch": selects the lost keys and opens SwitchPicker on its default tab. 0 HID (§11.2). */
async function pickForLost(row: CheckRow) {
  if (!canEdit.value) return;
  sel.selectMany(row.ids);
  await nextTick();
  switchCardRef.value?.openPicker(null);
}

// ---- Post-Apply check line (§7.9)
const verifyKeys = computed(() => (perf.verify ? formatKeyList(perf.verify.keys) : ''));
const verifyNeedsCal = computed(() =>
  Boolean(perf.verify && perf.verify.keys.some((id) => perf.needsCal.includes(id))),
);
const verifyMm = computed(() => (perf.verify ? mm(perf.verify.rangeUm) : ''));
</script>

<template>
  <div class="swtab">
    <TabKeyboard :shows="shows" :shows-alt="showsAlt">
      <KeyboardView
        :keys="device.keys"
        :legend="device.legend"
        :color="ledOf"
        :led-height="3"
        :sublabel="capView === 'travel' ? travelSublabel : undefined"
        :sublabel-aria="travelAria"
        :status="nameOfKey"
        :flag="uncalFlag"
        :loading="perf.loading"
        selectable
      >
        <template v-if="capView === 'photo'" #cap="{ key }">
          <SwitchSwatch v-bind="swatchOfKey(key.id)" size="sm" />
        </template>
      </KeyboardView>
    </TabKeyboard>
    <!-- the read failed (P3): the same card and "Try again" as the Travel tab, not an empty map -->
    <Card v-if="perf.loadError" :title="t('perf.loadFailed')" :subtitle="perf.loadError" data-test="switch-load-error">
      <div><Button :icon="IconRefresh" :loading="perf.loading" @click="perf.load(true)">{{ t('perf.reload') }}</Button></div>
    </Card>
    <div v-else class="swp-wrap">
      <div class="swp">
        <Card :title="t('swp.mapTitle')" :subtitle="t('swp.mapSub')">
          <template #actions>
            <span :id="capViewId" class="swp__capview-k">{{ t('swp.capView') }}</span>
            <Segmented v-model="capViewModel" size="sm" :label="t('swp.capView')" :labelledby="capViewId" :options="capViewOptions" />
          </template>

          <div v-if="perf.needsCal.length" class="swp__recal" role="status">
            <IconAlertTriangle :size="16" aria-hidden="true" />
            <span class="swp__recal-text">
              {{ t('sw.uncalStatus', { n: perf.needsCal.length, keys: uncalKeys }) }}
              <button type="button" class="swp__recal-go" @click="recalibrate">{{ t('sw.recalGo') }}</button>
            </span>
          </div>

          <!-- Check strip (§11.2) -->
          <div v-if="checkRows.length" class="swp__chk" role="region" :aria-label="t('sw.checkTitle')">
            <IconAlertTriangle :size="16" aria-hidden="true" />
            <div class="swp__chk-body">
              <b class="swp__chk-title">{{ t('sw.checkTitle') }}</b>
              <div
                v-for="row in checkRows"
                :key="row.key"
                :class="['swp__chk-row', row.kind === 'lost' && 'swp__chk-row--lost']"
              >
                <p class="swp__chk-text">
                  <IconAlertOctagon v-if="row.kind === 'lost'" :size="15" aria-hidden="true" />{{ row.text }}
                </p>
                <div class="swp__chk-btns">
                  <template v-if="row.kind === 'lost'">
                    <Button variant="secondary" size="sm" :disabled="!canEdit" @click="pickForLost(row)">{{ t('sw.pickFor') }}</Button>
                  </template>
                  <template v-else>
                    <Button variant="secondary" size="sm" :disabled="!canEdit" @click="reapplyRow(row)">{{ t('sw.reapply') }}</Button>
                    <Button variant="ghost" size="sm" :title="t('sw.forgetTitle', { name: row.forgetName ?? '' })" @click="forgetRow(row)">{{ t('sw.forget') }}</Button>
                  </template>
                </div>
              </div>
              <p v-if="perf.lostKeys.length" class="swp__chk-why">{{ t('sw.lostWhy') }}</p>
            </div>
          </div>

          <!-- Post-Apply check line (§7.9) -->
          <div v-if="perf.verify && perf.verify.keys.length" class="swp__verify" :class="{ 'swp__verify--ok': perf.verify.passed }" role="status">
            <IconCircleCheck v-if="perf.verify.passed" :size="16" aria-hidden="true" />
            <IconInfoCircle v-else :size="16" aria-hidden="true" />
            <span class="swp__verify-text">
              <template v-if="perf.verify.passed">{{ t('sw.verifyDone', { name: perf.verify.name, keys: verifyKeys }) }}</template>
              <template v-else>
                {{ t(verifyNeedsCal ? 'sw.verifyAfterCal' : 'sw.verifyLine', { name: perf.verify.name, keys: verifyKeys, mm: verifyMm }) }}
                <button type="button" class="swp__recal-go" @click="goVerify">{{ t('sw.verifyGo') }}</button>
              </template>
            </span>
            <IconButton class="swp__verify-x" :icon="IconX" :label="t('sw.verifyClose')" size="sm" @click="perf.clearVerify()" />
          </div>

          <ul class="swp__list">
            <li v-for="(g, i) in groups" :key="g.key">
              <button type="button" class="swp__row" :aria-pressed="sameSet(sel.ids, g.ids)" @click="sel.selectMany(g.ids)">
                <span v-if="multi" class="swp__bar" :style="{ '--g': toneOf(i) }" aria-hidden="true" />
                <SwitchSwatch v-bind="swatchOf(g)" />
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
        <SwitchCard ref="switchCardRef" :ids="ids" />
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
.swp__capview-k { font-size: var(--fs-label); color: var(--fg-2); white-space: nowrap; }
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

/* Check strip (§11.2) */
.swp__chk {
  display: flex; align-items: flex-start; gap: var(--s-2); margin-bottom: var(--s-3); padding: var(--s-3);
  border-radius: var(--r-control); border: 1px solid var(--line-1); background: var(--bg-3); color: var(--fg-1);
  font-size: var(--fs-label); line-height: 1.45;
}
.swp__chk > svg { flex: none; color: var(--warn); margin-top: 1px; }
.swp__chk-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
.swp__chk-title { font-weight: 600; }
.swp__chk-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px var(--s-3); }
.swp__chk-text { flex: 1 1 260px; min-width: 0; margin: 0; }
.swp__chk-row--lost .swp__chk-text > svg { color: var(--danger); vertical-align: -3px; margin-right: 6px; }
.swp__chk-btns { display: flex; gap: var(--s-2); flex: none; margin-left: auto; }
.swp__chk-why { margin: 0; color: var(--fg-2); }

/* Post-Apply verify line (§7.9) */
.swp__verify {
  display: flex; align-items: flex-start; gap: var(--s-2); margin-bottom: var(--s-3); padding: var(--s-3);
  border-radius: var(--r-control); border: 1px solid var(--line-1); background: var(--bg-3); color: var(--fg-1);
  font-size: var(--fs-label); line-height: 1.45;
}
.swp__verify > svg { flex: none; color: var(--fg-3); margin-top: 1px; }
.swp__verify--ok > svg { color: var(--ok); }
.swp__verify-text { flex: 1; min-width: 0; }
.swp__verify-x { width: 24px; height: 24px; margin: -3px -3px 0 0; }
.swp__hint { margin: var(--s-3) 0 0; font-size: var(--fs-label); color: var(--fg-3); }
</style>
