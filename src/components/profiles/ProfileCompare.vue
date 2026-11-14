<script setup lang="ts">
// Compare two profiles opened this session (DESIGN G §3.5): pick A and B (never the same), see only what differs, key by key.
// Everything here works on memory: no command goes to the keyboard (picking, filtering, scrolling).
import { computed, ref, watch } from 'vue';
import { IconCircleCheck, IconInfoCircle, IconSearch } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Segmented from '../ui/Segmented.vue';
import type { Performance } from '../../protocol';
import { useDeviceStore } from '../../stores/device';
import { usePerformanceStore } from '../../stores/performance';
import { findSwitch } from '../../protocol/switches';
import { switchName } from '../../data/switchDisplay';
import { capDecimals, fmtMm } from '../../data/keycapActuation';
import { diffProfiles, topChanges } from '../../data/profileDiff';
import type { DiffField, DiffValue } from '../../data/profileDiff';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';

export interface CompareProfile {
  index: number;
  name: string;
  /** null = not opened this session */
  values: Record<number, Performance> | null;
  /** "Live values" or "Data as of HH:MM" */
  when: string;
}

const props = defineProps<{
  profiles: CompareProfile[];
  active: number;
  /** The active profile's read: in progress or failed (the table waits). */
  read: 'loading' | 'error' | null;
  loadedCount: number;
}>();
const emit = defineEmits<{ reload: [] }>();

const device = useDeviceStore();
const perf = usePerformanceStore();
const decimals = computed(() => capDecimals(device.rtPrecision));

const label = (i: number) => `${i + 1} · ${props.profiles[i]?.name ?? ''}`;
const opened = computed(() => props.profiles.map((p) => !!p.values));
const openedList = computed(() => props.profiles.filter((p) => p.values).map((p) => p.index));
const missing = computed(() => props.profiles.filter((p) => !p.values).map((p) => p.index));

// ----- A and B (§3.5): A = the active profile, B = the latest other one; never A = B
const a = ref<number | null>(null);
const b = ref<number | null>(null);
/** The opened profile left most recently, other than `not` (a snapshot's time; the active one counts as now). */
function latestOther(not: number | null): number | null {
  let best: number | null = null;
  let bestAt = -Infinity;
  for (const i of openedList.value) {
    if (i === not) continue;
    const at = i === props.active ? Infinity : (perf.profileSnapshots.get(i)?.at ?? -Infinity);
    if (at > bestAt) { best = i; bestAt = at; }
  }
  return best;
}
/** A side may show an opened profile, or the active one while it is being read (A follows it through a switch). */
const usable = (i: number | null) => i !== null && (!!opened.value[i] || (i === props.active && props.read !== null));
function settle() {
  if (!usable(a.value)) a.value = usable(props.active) ? props.active : (openedList.value[0] ?? null);
  if (!usable(b.value) || b.value === a.value) b.value = latestOther(a.value);
}
watch(() => [props.active, opened.value, props.read] as const, ([now], prev) => {
  // A follows the active profile when it showed the old one; B keeps its profile (swapped if it was the new active one).
  const old = prev?.[0];
  if (old !== undefined && now !== old && a.value === old) {
    if (b.value === now) b.value = old;
    a.value = now;
  }
  settle();
}, { immediate: true });

const aModel = computed<number | null>({
  get: () => a.value,
  set: (v) => { if (v !== null && v === b.value) b.value = a.value; a.value = v; },
});
const bModel = computed<number | null>({
  get: () => b.value,
  set: (v) => { if (v !== null && v === a.value) a.value = b.value; b.value = v; },
});
const options = computed(() => props.profiles.map((p) => ({
  value: p.index,
  label: label(p.index),
  disabled: !p.values,
  title: p.values ? undefined : t('cmp.notOpenedTip'),
})));
const canPick = computed(() => openedList.value.length >= 2);

/** "Not opened this session: {list}." with every name in bold. */
const missingParts = computed(() => t('cmp.missing', { list: '\u0000' }).split('\u0000'));
const needTwoSub = computed(() => t('cmp.needTwoSub', { name: openedList.value.map(label).join(', ') || '—' }));

// ----- the differences
const ids = computed(() => device.keys.map((k) => k.id));
const valsA = computed(() => (a.value === null ? null : props.profiles[a.value]?.values ?? null));
const valsB = computed(() => (b.value === null ? null : props.profiles[b.value]?.values ?? null));
const rows = computed(() => (valsA.value && valsB.value ? diffProfiles(valsA.value, valsB.value, ids.value) : []));
const keyCount = computed(() => new Set(rows.value.map((r) => r.id)).size);
const top = computed(() => topChanges(rows.value));

const FIELD_LABEL: Record<DiffField, MessageKey> = {
  mode: 'perf.mode', actuation: 'perf.actuation', rtPress: 'perf.rtPress', rtRelease: 'perf.rtRelease',
  continuous: 'perf.continuous', deadTop: 'perf.deadTop', deadBottom: 'perf.deadBottom', switch: 'cmp.fSwitch',
};
function show(field: DiffField, v: DiffValue): string {
  switch (field) {
    case 'mode': return v === 'rt' ? t('perf.modeRt') : t('perf.modeStandard');
    case 'continuous': return v ? t('cmp.on') : t('cmp.off');
    case 'switch': {
      const e = findSwitch(perf.catalog, v as number);
      return e ? switchName(e) : t('cmp.switchId', { id: v as number });
    }
    default: return t('ov.actOne', { v: fmtMm(v as number, decimals.value) });
  }
}

/** "{n} differences on {keys} keys" with both numbers in bold (the en form is plural, so the numbers are found in it). */
const countParts = computed(() => {
  const n = String(rows.value.length);
  const k = String(keyCount.value);
  const s = t('cmp.count', { n: rows.value.length, keys: keyCount.value });
  const i = s.indexOf(n);
  const j = s.indexOf(k, i + n.length);
  if (i < 0 || j < 0) return [{ text: s, bold: false }];
  return [
    { text: s.slice(0, i), bold: false }, { text: n, bold: true }, { text: s.slice(i + n.length, j), bold: false },
    { text: k, bold: true }, { text: s.slice(j + k.length), bold: false },
  ].filter((p) => p.text);
});

// ----- filter by key name (§3.5): the count and "Most common" stay about the two profiles
const query = ref('');
const q = computed(() => query.value.trim().toLowerCase());
const keyName = (id: number) => device.legend(device.keys[id]);
const shown = computed(() => (q.value ? rows.value.filter((r) => keyName(r.id).toLowerCase().includes(q.value)) : rows.value));
const groups = computed(() => {
  const out: { id: number; rows: typeof rows.value }[] = [];
  for (const r of shown.value) {
    const last = out[out.length - 1];
    if (last && last.id === r.id) last.rows.push(r);
    else out.push({ id: r.id, rows: [r] });
  }
  return out;
});
const whenOf = (i: number | null) => (i === null ? '' : props.profiles[i]?.when ?? '');
const nameOf = (i: number | null) => (i === null ? '' : props.profiles[i]?.name ?? '');
</script>

<template>
  <div class="cmpx">
    <template v-if="canPick">
      <div class="cmp__pick">
        <span class="cmp__pickLabel" aria-hidden="true">{{ t('cmp.a') }}</span>
        <Segmented v-model="aModel" size="sm" :options="options" :label="t('cmp.a')" :aria-describedby="missing.length ? 'cmp-missing' : undefined" />
        <span class="cmp__pickLabel" aria-hidden="true">{{ t('cmp.b') }}</span>
        <Segmented v-model="bModel" size="sm" :options="options" :label="t('cmp.b')" :aria-describedby="missing.length ? 'cmp-missing' : undefined" />
      </div>
      <p v-if="missing.length" id="cmp-missing" class="cmp__missing">
        <IconInfoCircle :size="15" stroke-width="1.75" aria-hidden="true" />
        <span>{{ missingParts[0] }}<template v-for="(i, n) in missing" :key="i"><template v-if="n">, </template><b>{{ label(i) }}</b></template>{{ missingParts[1] }} {{ t('cmp.missingHow') }}</span>
      </p>
    </template>

    <p v-if="read === 'loading'" class="cmp__empty num" role="status">{{ t('perf.loading', { n: loadedCount }) }}</p>
    <div v-else-if="read === 'error'" class="cmp__empty">
      <b>{{ t('perf.loadFailed') }}</b>
      <Button variant="secondary" size="sm" class="cmp__reload" @click="emit('reload')">{{ t('perf.reload') }}</Button>
    </div>
    <p v-else-if="!canPick" class="cmp__empty"><b>{{ t('cmp.needTwo') }}</b>{{ needTwoSub }}</p>
    <p v-else-if="!rows.length" class="cmp__same" role="status">
      <IconCircleCheck :size="16" stroke-width="2" aria-hidden="true" />
      <span>{{ t('cmp.same') }}</span>
    </p>
    <template v-else>
      <div class="cmp__bar">
        <p class="cmp__count" role="status"><template v-for="(p, n) in countParts" :key="n"><b v-if="p.bold" class="num">{{ p.text }}</b><template v-else>{{ p.text }}</template></template></p>
        <label class="cmp__filter">
          <IconSearch :size="16" stroke-width="1.75" aria-hidden="true" />
          <span class="sr-only">{{ t('cmp.filter') }}</span>
          <input v-model="query" type="search" :placeholder="t('cmp.filter')" autocomplete="off" spellcheck="false">
        </label>
      </div>
      <p v-if="top.length" class="cmp__top">
        <!-- the spaces are where a narrow line may wrap (each change itself never breaks) -->
        <span class="cmp__topK">{{ t('cmp.top') }}</span>{{ ' ' }}<template v-for="(g, n) in top" :key="n">
          <template v-if="n">{{ ' ' }}<span class="cmp__dot" aria-hidden="true">·</span>{{ ' ' }}</template>
          <span>{{ t('cmp.topItem', { field: t(FIELD_LABEL[g.field]), a: show(g.field, g.a), b: show(g.field, g.b), n: g.keys }) }}</span>
        </template>
      </p>
      <p v-if="q" class="cmp__shown" aria-live="polite">{{ t('cmp.shown', { n: shown.length, total: rows.length }) }}</p>
      <div v-if="shown.length" class="cmp__scroll" tabindex="0" role="region" aria-labelledby="cmp-cap">
        <table class="cmp__table">
          <caption id="cmp-cap">{{ t('cmp.caption', { a: label(a ?? 0), b: label(b ?? 0) }) }}</caption>
          <colgroup><col class="cmp__colKey"><col><col class="cmp__colA"><col class="cmp__colB"></colgroup>
          <thead>
            <tr>
              <th scope="col">{{ t('cmp.colKey') }}</th>
              <th scope="col">{{ t('cmp.colField') }}</th>
              <th scope="col">A · <span class="cmp__pname">{{ nameOf(a) }}</span><span class="cmp__when">{{ whenOf(a) }}</span></th>
              <th scope="col">B · <span class="cmp__pname">{{ nameOf(b) }}</span><span class="cmp__when">{{ whenOf(b) }}</span></th>
            </tr>
          </thead>
          <tbody v-for="g in groups" :key="g.id">
            <tr v-for="(r, n) in g.rows" :key="r.field">
              <th v-if="n === 0" scope="rowgroup" :rowspan="g.rows.length">{{ keyName(g.id) }}</th>
              <td>{{ t(FIELD_LABEL[r.field]) }}</td>
              <td class="cmp__v">{{ show(r.field, r.a) }}</td>
              <td class="cmp__v">{{ show(r.field, r.b) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="cmp__empty" role="status">{{ t('cmp.noMatch', { q: query.trim() }) }}</p>
    </template>
  </div>
</template>

<style scoped>
.cmpx { display: contents; }
.cmp__pick { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--s-2) var(--s-3); }
.cmp__pick > .seg { justify-self: start; }
.cmp__pickLabel { font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); }
/* a profile not opened this session: listed (all four visible) but not choosable. Segmented's default for a disabled
   option is a strike-through (= "this model cannot"); here it is only "not read yet": grey text in a dashed outline. */
.cmp__pick :deep(.seg__opt[aria-disabled='true']) { text-decoration: none; color: var(--fg-3); outline: 1px dashed var(--line-2); outline-offset: -1px; }
.cmp__missing { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }
.cmp__missing svg { flex: none; margin-top: 1px; }
.cmp__missing b { font-weight: 600; color: var(--fg-2); }

.cmp__bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-4); }
.cmp__count { margin: 0; font-size: var(--fs-label); color: var(--fg-2); }
.cmp__count b { font-weight: 650; color: var(--fg-1); }
.cmp__filter { position: relative; margin-left: auto; width: 220px; max-width: 100%; }
.cmp__filter svg { position: absolute; left: 9px; top: 8px; color: var(--fg-3); pointer-events: none; }
.cmp__filter input {
  width: 100%; height: 32px; padding: 0 10px 0 30px; border: 1px solid var(--line-2); border-radius: var(--r-control);
  background: var(--bg-1); color: var(--fg-1); font: inherit; font-size: var(--fs-body);
}
.cmp__filter input::placeholder { color: var(--fg-3); }
.cmp__filter input:focus { border-color: var(--acc-line); box-shadow: var(--focus-ring); outline: none; }
.cmp__top { margin: 0; font-size: var(--fs-label); line-height: 20px; color: var(--fg-2); }
.cmp__top > span { white-space: nowrap; }
.cmp__topK { color: var(--fg-3); font-weight: 500; margin-right: 2px; }
.cmp__dot { color: var(--fg-4); margin: 0 2px; }
.cmp__shown { margin: 0; font-size: var(--fs-caption); color: var(--fg-3); }

/* the table scrolls inside its frame (≈ 12 rows); the head stays put */
.cmp__scroll { max-height: 420px; overflow: auto; border: 1px solid var(--line-1); border-radius: var(--r-control); background: var(--bg-1); }
.cmp__scroll:focus { outline: none; }
.cmp__scroll:focus-visible { box-shadow: var(--focus-ring); }
.cmp__table { width: 100%; border-collapse: separate; border-spacing: 0; font-size: var(--fs-label); }
.cmp__table caption { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.cmp__table thead th {
  position: sticky; top: 0; z-index: 1; padding: 8px 12px; text-align: left; vertical-align: bottom; font-weight: 600; color: var(--fg-2);
  background: var(--bg-3); border-bottom: 1px solid var(--line-2);
}
.cmp__colKey { width: 18%; }
.cmp__colA, .cmp__colB { width: 24%; }
.cmp__table thead .cmp__when { display: block; font-size: var(--fs-caption); font-weight: 400; color: var(--fg-3); }
.cmp__table thead .cmp__pname { color: var(--fg-1); }
/* one line between keys, none between the rows of one key */
.cmp__table tbody + tbody > tr:first-child > * { border-top: 1px solid var(--line-1); }
.cmp__table tbody th { padding: 7px 12px; text-align: left; vertical-align: top; font-weight: 600; color: var(--fg-1); }
.cmp__table tbody td { padding: 7px 12px; color: var(--fg-2); }
.cmp__table tbody td.cmp__v { color: var(--fg-1); font-variant-numeric: tabular-nums; }

.cmp__empty { margin: 0; padding: var(--s-5) var(--s-4); text-align: center; font-size: var(--fs-label); color: var(--fg-3); border: 1px dashed var(--line-2); border-radius: var(--r-control); }
.cmp__empty b { display: block; margin-bottom: 2px; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
.cmp__reload { margin-top: var(--s-2); }
.cmp__same { display: flex; align-items: center; gap: 6px; margin: 0; padding: var(--s-3) var(--s-4); border-radius: var(--r-control); background: var(--ok-soft); color: var(--ok); font-size: var(--fs-label); font-weight: 500; }
</style>
