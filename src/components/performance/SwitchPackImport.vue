<script setup lang="ts">
// Switch pack import preview inside SwitchPicker's dialog body (DESIGN CSW §6.7).
// Names from the file render strictly as text (Vue interpolation, never v-html). 0 HID.
import { computed } from 'vue';
import { IconAlertTriangle, IconCircleCheck, IconInfoCircle } from '@tabler/icons-vue';
import { formatMm } from '../ui/NumberField.vue';
import SwitchSwatch from './SwitchSwatch.vue';
import { READY_BOUNDS } from '../../data/readySwitches';
import type { ReadyBounds } from '../../data/readySwitches';
import type { CleanEntry, PackRow, ParsedPack } from '../../data/switchPack';
import { t } from '../../i18n/vi';

const props = withDefaults(defineProps<{
  fileName: string;
  parsed: ParsedPack;
  bounds?: ReadyBounds;
}>(), { bounds: () => READY_BOUNDS });

const mm = (um: number) => formatMm(um / 1000, 3);

const addEntries = computed<CleanEntry[]>(() => {
  if (!props.parsed.ok) return [];
  return props.parsed.rows.filter((r): r is PackRow & { entry: CleanEntry } => r.status === 'add' && r.entry !== null).map((r) => r.entry);
});

const skipCount = computed(() => (props.parsed.ok ? props.parsed.rows.length - addEntries.value.length : 0));

const fileErrorText = computed(() => {
  if (props.parsed.ok) return '';
  if (props.parsed.why === 'tooBig') return t('csw.pkTooBig');
  let why: string;
  switch (props.parsed.why) {
    case 'json': why = t('csw.pkFile.json'); break;
    case 'format': why = t('csw.pkFile.format'); break;
    case 'schema': why = t('csw.pkFile.schema', { v: String(props.parsed.version ?? '') }); break;
    case 'field': why = t('csw.pkFile.field', { f: props.parsed.field ?? '' }); break;
    case 'switches': why = t('csw.pkFile.switches'); break;
    case 'tooMany': why = t('csw.pkFile.tooMany'); break;
  }
  return t('csw.pkBadFile', { file: props.fileName, why });
});

function rowMeta(r: PackRow): string {
  if (r.status !== 'add' || !r.entry) return '';
  const e = r.entry;
  const parts: string[] = [];
  if (e.maker) parts.push(e.maker);
  parts.push(r.clamped ? t('csw.pkClamped', { mm: mm(e.travelUm), used: mm(e.rangeUm) }) : `${mm(e.rangeUm)} mm`);
  parts.push(
    e.curve.kind === 'manual'
      ? t('csw.likeManual', { coef: e.coefficient })
      : `${t('csw.likeTravel')}, ${t('csw.likeManual', { coef: e.coefficient })}`,
  );
  return parts.join(' · ');
}

function skipReason(r: PackRow): string {
  switch (r.why) {
    case 'field': return t('csw.pkWhy.field', { f: r.field ?? '' });
    case 'type': return t('csw.pkWhy.type', { f: r.field ?? '' });
    case 'name': return t('csw.pkWhy.name');
    case 'text': return t('csw.pkWhy.text');
    case 'travel': return t('csw.pkWhy.travel');
    case 'coef': return t('csw.pkWhy.coef', { min: props.bounds.cMin, max: props.bounds.cMax });
    case 'color': return t('csw.pkWhy.color');
    case 'nameTaken': return t('csw.pkWhy.nameTaken');
    case 'dupInFile': return t('csw.pkWhy.dupInFile');
    case 'full': return t('csw.pkWhy.full');
    default: return '';
  }
}

defineExpose({ addEntries });
</script>

<template>
  <div class="csw-imp">
    <p v-if="!parsed.ok" class="csw-imp__warn" role="status">
      <IconAlertTriangle :size="15" aria-hidden="true" />{{ fileErrorText }}
    </p>
    <template v-else>
      <p class="csw-imp__sum" role="status">
        <IconInfoCircle :size="15" aria-hidden="true" />
        {{ addEntries.length
          ? t('csw.pkSummary', { file: fileName, a: addEntries.length, b: skipCount })
          : t('csw.pkNone', { file: fileName }) }}
      </p>
      <ul v-if="parsed.rows.length" class="csw-imp__list">
        <li v-for="(r, idx) in parsed.rows" :key="idx" :class="['csw-imp__row', r.status === 'skip' && 'is-skip']">
          <SwitchSwatch :color="r.status === 'add' && r.entry ? r.entry.color : ''" custom size="sm" />
          <span class="csw-imp__text">
            <span class="csw-imp__name">{{ r.name || t('csw.pkNoName') }}</span>
            <span v-if="rowMeta(r)" class="csw-imp__meta">{{ rowMeta(r) }}</span>
          </span>
          <span v-if="r.status === 'add'" class="csw-imp__st csw-imp__st--add">
            <IconCircleCheck :size="15" aria-hidden="true" />{{ t('csw.pkAdd') }}
          </span>
          <span v-else class="csw-imp__st csw-imp__st--skip">
            <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('csw.pkSkip', { why: skipReason(r) }) }}
          </span>
        </li>
      </ul>
    </template>
  </div>
</template>

<style scoped>
.csw-imp { display: flex; flex-direction: column; gap: var(--s-3); overflow-y: auto; min-height: 0; }
.csw-imp__sum, .csw-imp__warn {
  display: flex; gap: var(--s-2); align-items: flex-start; margin: 0;
  font-size: var(--fs-label); line-height: 1.45;
}
.csw-imp__sum { color: var(--fg-2); }
.csw-imp__sum svg { color: var(--fg-3); flex: none; margin-top: 1px; }
.csw-imp__warn { color: var(--fg-1); }
.csw-imp__warn svg { color: var(--warn); flex: none; margin-top: 1px; }
.csw-imp__list {
  margin: 0; padding: 0; list-style: none;
  border: 1px solid var(--line-1); border-radius: var(--r-control);
  overflow-y: auto; min-height: 0;
}
.csw-imp__row { display: flex; align-items: center; gap: var(--s-3); padding: 8px var(--s-3); min-width: 0; }
.csw-imp__row + .csw-imp__row { border-top: 1px solid var(--line-1); }
.csw-imp__text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.csw-imp__name { font-weight: 600; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.csw-imp__meta {
  font-size: var(--fs-label); color: var(--fg-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums;
}
.csw-imp__row.is-skip .csw-imp__name { color: var(--fg-2); }
.csw-imp__st {
  flex: none; display: inline-flex; align-items: center; gap: 6px;
  max-width: 55%; font-size: var(--fs-label); color: var(--fg-2); text-align: right;
}
.csw-imp__st > svg { flex: none; }
.csw-imp__st--add { color: var(--fg-1); }
.csw-imp__st--add > svg { color: var(--ok); }
.csw-imp__st--skip > svg { color: var(--warn); }
</style>
