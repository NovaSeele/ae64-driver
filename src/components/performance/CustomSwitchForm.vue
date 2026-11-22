<script setup lang="ts">
// Create / edit / copy custom switch form, plus the generic switch declaration view (DESIGN CSW §5.7, §6.1–6.6).
// Purely local storage edits via parent callbacks: 0 HID.
import { computed, nextTick, onMounted, ref, useId, watch } from 'vue';
import { IconAlertTriangle, IconChevronDown, IconInfoCircle } from '@tabler/icons-vue';
import NumberField, { formatMm } from '../ui/NumberField.vue';
import SwitchSwatch from './SwitchSwatch.vue';
import {
  CUSTOM_MAKER_MAX, CUSTOM_NAME_MAX, CUSTOM_NOTE_MAX, GENERIC_CLASSES, GENERIC_START, SWITCH_COLORS,
  cleanText, coefFromTravel, foldText, newCustomUid, suggestCurve,
} from '../../data/customSwitch';
import type { CustomCurve, CustomSwitch } from '../../data/customSwitch';
import { READY_BOUNDS } from '../../data/readySwitches';
import type { ReadySwitch } from '../../data/readySwitches';
import { groupName, makerTabs, switchBrand, switchName } from '../../data/switchDisplay';
import { coefBounds, findSwitch, rangeBounds } from '../../protocol/switches';
import type { SwitchEntry } from '../../protocol/switches';
import { t } from '../../i18n/vi';

const props = defineProps<{
  mode: 'new' | 'edit' | 'copy' | 'generic';
  entry?: CustomSwitch | null;
  copyFrom?: ReadySwitch | null;
  catalog: readonly SwitchEntry[];
  existing: readonly CustomSwitch[];
  inUseCount: number;
  genericRangeUm: number;
}>();

const emit = defineEmits<{
  saveCustom: [entry: CustomSwitch];
  saveGeneric: [rangeUm: number];
  delete: [uid: string];
  deleteStateChange: [deleting: boolean];
}>();

const uid = useId();
const ids = {
  name: `${uid}-name`,
  nameErr: `${uid}-name-err`,
  maker: `${uid}-maker`,
  travelHint: `${uid}-travel-hint`,
  travelErr: `${uid}-travel-err`,
  note: `${uid}-note`,
  like: `${uid}-like`,
  coef: `${uid}-coef`,
  coefErr: `${uid}-coef-err`,
  coefClamp: `${uid}-coef-clamp`,
  coefNote: `${uid}-coef-note`,
  colorLab: `${uid}-color-lab`,
  classLab: `${uid}-class-lab`,
  delTitle: `${uid}-del-title`,
};

const rb = computed(() => rangeBounds(props.catalog) ?? { min: READY_BOUNDS.rMin, max: READY_BOUNDS.rMax });
const cb = computed(() => coefBounds(props.catalog) ?? { min: READY_BOUNDS.cMin, max: READY_BOUNDS.cMax });
const catalogTabs = computed(() => makerTabs(props.catalog));

const clampInt = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, Math.round(v)));
const mm = (um: number) => formatMm(um / 1000, 3);
const groupLabel = (g: SwitchEntry['group']) => (g === 'Other' ? t('sw.groupOther') : groupName(g));

// ---- Custom switch fields (§6.2–6.3)
const name = ref('');
const maker = ref('');
const travelMm = ref<number | null>(null);
const note = ref('');
const curveKind = ref<CustomCurve['kind']>('like');
const likeId = ref<number | null>(null);
const userPickedCurve = ref(false);
const manualCoefText = ref('');
const coefClampMsg = ref<string | null>(null);
const color = ref('');

// ---- Validation errors
const nameErr = ref<string | null>(null);
const travelErr = ref<string | null>(null);
const coefErr = ref<string | null>(null);
const deleting = ref(false);

// ---- Generic switch declaration fields (§5.7)
type GenericChip = (typeof GENERIC_CLASSES)[number] | 'other';
const genericChip = ref<GenericChip>(GENERIC_START);
const genericOtherMm = ref<number | null>(null);

// ---- Element refs
const nameInput = ref<HTMLInputElement | null>(null);
const travelWrap = ref<HTMLElement | null>(null);
const coefInput = ref<HTMLInputElement | null>(null);
const chipsRef = ref<HTMLElement | null>(null);
const genericOtherWrap = ref<HTMLElement | null>(null);
const colorsRef = ref<HTMLElement | null>(null);

function makeCopyName(base: string): string {
  const suffix = ' (2)';
  const maxBase = CUSTOM_NAME_MAX - suffix.length;
  const trimmed = base.length > maxBase ? base.slice(0, maxBase).trimEnd() : base;
  return `${trimmed}${suffix}`;
}

function initForm() {
  nameErr.value = null;
  travelErr.value = null;
  coefErr.value = null;
  coefClampMsg.value = null;
  deleting.value = false;

  if (props.mode === 'generic') {
    const start = clampInt(props.genericRangeUm, rb.value);
    const matched = GENERIC_CLASSES.find((c) => c === start);
    if (matched !== undefined) {
      genericChip.value = matched;
      genericOtherMm.value = null;
    } else {
      genericChip.value = 'other';
      genericOtherMm.value = start / 1000;
    }
    return;
  }

  if (props.mode === 'edit' && props.entry) {
    const e = props.entry;
    name.value = e.name;
    maker.value = e.maker;
    travelMm.value = e.travelUm / 1000;
    note.value = e.note;
    color.value = e.color;
    userPickedCurve.value = true;
    if (e.curve.kind === 'like') {
      if (findSwitch(props.catalog, e.curve.id)) {
        curveKind.value = 'like';
        likeId.value = e.curve.id;
        manualCoefText.value = '';
      } else {
        curveKind.value = 'manual';
        likeId.value = null;
        manualCoefText.value = String(e.coefficient);
      }
    } else if (e.curve.kind === 'travel') {
      curveKind.value = 'travel';
      likeId.value = null;
      manualCoefText.value = '';
    } else {
      curveKind.value = 'manual';
      likeId.value = null;
      manualCoefText.value = String(e.coefficient);
    }
    return;
  }

  if (props.mode === 'copy' && props.copyFrom) {
    const r = props.copyFrom;
    name.value = makeCopyName(r.name);
    maker.value = r.maker;
    travelMm.value = r.travelUm / 1000;
    note.value = '';
    color.value = '';
    userPickedCurve.value = true;
    if (findSwitch(props.catalog, r.curveFrom.id)) {
      curveKind.value = 'like';
      likeId.value = r.curveFrom.id;
      manualCoefText.value = '';
    } else {
      curveKind.value = 'manual';
      likeId.value = null;
      manualCoefText.value = String(r.coefficient);
    }
    return;
  }

  // 'new'
  name.value = '';
  maker.value = '';
  travelMm.value = null;
  note.value = '';
  color.value = '';
  curveKind.value = 'like';
  likeId.value = null;
  userPickedCurve.value = false;
  manualCoefText.value = '';
}

initForm();

onMounted(async () => {
  await nextTick();
  if (props.mode === 'generic') {
    chipsRef.value?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  } else {
    nameInput.value?.focus();
  }
});

// Clear field errors on edits
watch(name, () => { nameErr.value = null; });
watch(travelMm, () => { travelErr.value = null; });
watch(genericOtherMm, () => { travelErr.value = null; });
watch(genericChip, () => { travelErr.value = null; });
watch(curveKind, () => { coefErr.value = null; coefClampMsg.value = null; });

function onManualCoefInput() {
  coefErr.value = null;
  coefClampMsg.value = null;
}

// ---- Derived values for generic mode
const genericTypedUm = computed<number | null>(() => {
  if (genericChip.value !== 'other') return genericChip.value;
  return genericOtherMm.value === null ? null : Math.round(genericOtherMm.value * 1000);
});
const genericClampedUm = computed<number | null>(() =>
  genericTypedUm.value === null ? null : clampInt(genericTypedUm.value, rb.value),
);
const genericCoef = computed<number | null>(() =>
  genericClampedUm.value === null ? null : coefFromTravel(genericClampedUm.value, cb.value),
);
const genericCanReset = computed(() => genericClampedUm.value !== GENERIC_START);

function selectGenericChip(chip: GenericChip) {
  genericChip.value = chip;
  if (chip === 'other') {
    void nextTick(() => genericOtherWrap.value?.querySelector<HTMLInputElement>('input')?.focus());
  }
}

function onChipKey(e: KeyboardEvent) {
  const all: GenericChip[] = [...GENERIC_CLASSES, 'other'];
  const i = all.indexOf(genericChip.value);
  let next: number;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown': next = (i + 1) % all.length; break;
    case 'ArrowLeft':
    case 'ArrowUp': next = (i - 1 + all.length) % all.length; break;
    case 'Home': next = 0; break;
    case 'End': next = all.length - 1; break;
    default: return;
  }
  e.preventDefault();
  genericChip.value = all[next];
  chipsRef.value?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

function resetGeneric() {
  genericChip.value = GENERIC_START;
}

// ---- Derived values for custom mode
const typedTravelUm = computed<number | null>(() => (travelMm.value === null ? null : Math.round(travelMm.value * 1000)));
const clampedRangeUm = computed<number | null>(() =>
  typedTravelUm.value === null ? null : clampInt(typedTravelUm.value, rb.value),
);
const suggested = computed<SwitchEntry | null>(() =>
  clampedRangeUm.value === null ? null : suggestCurve(props.catalog, clampedRangeUm.value, maker.value),
);
const effectiveLikeId = computed<number | null>(() => {
  if (!userPickedCurve.value) return suggested.value?.id ?? likeId.value;
  return likeId.value ?? suggested.value?.id ?? null;
});
const likeEntry = computed<SwitchEntry | null>(() =>
  effectiveLikeId.value !== null ? (findSwitch(props.catalog, effectiveLikeId.value) ?? null) : null,
);
const estCoef = computed<number | null>(() =>
  clampedRangeUm.value === null ? null : coefFromTravel(clampedRangeUm.value, cb.value),
);

function parseManualRaw(raw: string): number | null {
  const s = raw.trim();
  if (!s || !/^[+-]?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function normalizeManualCoef(): number | null {
  const raw = parseManualRaw(manualCoefText.value);
  if (raw === null) return null;
  const rounded = Math.round(raw);
  const clamped = clampInt(rounded, cb.value);
  if (clamped !== raw) {
    manualCoefText.value = String(clamped);
    if (clamped !== rounded) {
      coefClampMsg.value = t('csw.fCoefClamp', { used: clamped, min: cb.value.min, max: cb.value.max });
    }
  }
  return clamped;
}

const resolvedCoef = computed<number | null>(() => {
  if (props.mode === 'generic') return genericCoef.value;
  if (curveKind.value === 'like') return likeEntry.value?.coefficient ?? null;
  if (curveKind.value === 'travel') return estCoef.value;
  const raw = parseManualRaw(manualCoefText.value);
  return raw === null ? null : clampInt(raw, cb.value);
});

function pickCurveKind(kind: CustomCurve['kind']) {
  userPickedCurve.value = true;
  if (kind === 'like' && likeId.value === null && suggested.value) likeId.value = suggested.value.id;
  curveKind.value = kind;
}

function onLikeSelect(e: Event) {
  const v = Number((e.target as HTMLSelectElement).value);
  if (!Number.isFinite(v)) return;
  userPickedCurve.value = true;
  likeId.value = v;
}

function onColorKey(e: KeyboardEvent) {
  const i = Math.max(0, SWITCH_COLORS.findIndex((c) => c.hex === color.value));
  const n = SWITCH_COLORS.length;
  let next: number;
  switch (e.key) {
    case 'ArrowRight':
    case 'ArrowDown': next = (i + 1) % n; break;
    case 'ArrowLeft':
    case 'ArrowUp': next = (i - 1 + n) % n; break;
    case 'Home': next = 0; break;
    case 'End': next = n - 1; break;
    default: return;
  }
  e.preventDefault();
  color.value = SWITCH_COLORS[next].hex;
  colorsRef.value?.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

// ---- Preview & notes (§5.7, §6.5)
const previewRangeUm = computed(() => (props.mode === 'generic' ? genericClampedUm.value : clampedRangeUm.value));
const previewTypedUm = computed(() => (props.mode === 'generic' ? genericTypedUm.value : typedTravelUm.value));

const previewName = computed(() => {
  if (props.mode === 'generic') {
    return previewRangeUm.value !== null ? t('csw.genericLabel', { mm: mm(previewRangeUm.value) }) : t('csw.generic');
  }
  return cleanText(name.value) || t('csw.unnamed');
});

const previewMeta = computed(() => {
  const R = previewRangeUm.value;
  const C = resolvedCoef.value;
  if (R === null || C === null) return '';
  if (props.mode === 'generic') return `${t('csw.genericEyebrow')} · ${t('csw.likeManual', { coef: C })}`;
  const curveTxt = curveKind.value === 'like' && likeEntry.value
    ? t('csw.like', { name: switchName(likeEntry.value) })
    : curveKind.value === 'travel'
      ? t('csw.likeTravel')
      : t('csw.likeManual', { coef: C });
  return `${cleanText(maker.value) || t('csw.kind')} · ${mm(R)} mm · ${curveTxt}`;
});

const travelClampNote = computed(() => {
  const typed = previewTypedUm.value;
  const used = previewRangeUm.value;
  if (typed === null || used === null || typed === used) return null;
  return t('csw.fTravelClamp', {
    min: mm(rb.value.min),
    max: mm(rb.value.max),
    used: mm(used),
    diff: formatMm(Math.abs(typed - used) / 1000, 3),
  });
});

const catalogTwin = computed(() => {
  if (props.mode === 'generic' || clampedRangeUm.value === null || resolvedCoef.value === null) return null;
  return props.catalog.find((e) => e.rangeMax === clampedRangeUm.value && e.coefficient === resolvedCoef.value) ?? null;
});

const nameTwin = computed(() => {
  if (props.mode === 'generic') return null;
  const clean = cleanText(name.value);
  if (!clean) return null;
  const folded = foldText(clean);
  return props.catalog.find((e) => foldText(switchName(e)) === folded) ?? null;
});

const showInUseNote = computed(() => {
  if (props.inUseCount <= 0) return false;
  if (props.mode === 'generic') return genericClampedUm.value !== null && genericClampedUm.value !== props.genericRangeUm;
  if (props.mode === 'edit' && props.entry && clampedRangeUm.value !== null && resolvedCoef.value !== null) {
    return clampedRangeUm.value !== props.entry.rangeUm || resolvedCoef.value !== props.entry.coefficient;
  }
  return false;
});

const coefDescribedBy = computed(() => {
  const list: string[] = [];
  if (coefErr.value) list.push(ids.coefErr);
  if (coefClampMsg.value) list.push(ids.coefClamp);
  if (curveKind.value === 'manual') list.push(ids.coefNote);
  return list.length ? list.join(' ') : undefined;
});

function fieldHasBadText(wrap: HTMLElement | null): boolean {
  return wrap?.querySelector('input')?.getAttribute('aria-invalid') === 'true';
}

// ---- Actions exposed to SwitchPicker's dialog footer
function submit(): boolean {
  if (props.mode === 'generic') {
    if (genericChip.value === 'other' && (genericOtherMm.value === null || fieldHasBadText(genericOtherWrap.value))) {
      travelErr.value = t('csw.travelRequired');
      genericOtherWrap.value?.querySelector<HTMLInputElement>('input')?.focus();
      return false;
    }
    if (genericClampedUm.value === null) return false;
    emit('saveGeneric', genericClampedUm.value);
    return true;
  }

  // Validate name
  const cleanedName = cleanText(name.value);
  if (!cleanedName) {
    nameErr.value = t('csw.nameRequired');
    nameInput.value?.focus();
    return false;
  }
  const editingUid = props.mode === 'edit' ? props.entry?.uid : undefined;
  const folded = foldText(cleanedName);
  if (props.existing.some((e) => e.uid !== editingUid && foldText(e.name) === folded)) {
    nameErr.value = t('csw.nameTaken');
    nameInput.value?.focus();
    return false;
  }

  // Validate travel
  if (travelMm.value === null || !Number.isFinite(travelMm.value) || travelMm.value < 1 || travelMm.value > 6 || fieldHasBadText(travelWrap.value)) {
    travelErr.value = t('csw.travelRequired');
    travelWrap.value?.querySelector<HTMLInputElement>('input')?.focus();
    return false;
  }
  const travelUm = Math.round(travelMm.value * 1000);
  const rangeUm = clampInt(travelUm, rb.value);

  // Validate curve & coefficient
  let curve: CustomCurve;
  let coefficient: number;
  if (curveKind.value === 'like') {
    const picked = likeEntry.value;
    if (!picked) {
      travelErr.value = t('csw.travelRequired');
      travelWrap.value?.querySelector<HTMLInputElement>('input')?.focus();
      return false;
    }
    curve = { kind: 'like', id: picked.id, name: switchName(picked) };
    coefficient = clampInt(picked.coefficient, cb.value);
  } else if (curveKind.value === 'travel') {
    curve = { kind: 'travel' };
    coefficient = coefFromTravel(rangeUm, cb.value);
  } else {
    const c = normalizeManualCoef();
    if (c === null) {
      coefErr.value = t('csw.coefRequired');
      coefInput.value?.focus();
      return false;
    }
    curve = { kind: 'manual' };
    coefficient = c;
  }

  const built: CustomSwitch = {
    uid: props.mode === 'edit' && props.entry ? props.entry.uid : newCustomUid(),
    name: cleanedName.slice(0, CUSTOM_NAME_MAX),
    maker: cleanText(maker.value).slice(0, CUSTOM_MAKER_MAX),
    travelUm,
    rangeUm,
    coefficient,
    curve,
    color: color.value,
    note: cleanText(note.value).slice(0, CUSTOM_NOTE_MAX),
  };
  emit('saveCustom', built);
  return true;
}

function requestDelete() {
  if (props.mode !== 'edit' || !props.entry) return;
  deleting.value = true;
  emit('deleteStateChange', true);
}

function cancelDelete() {
  deleting.value = false;
  emit('deleteStateChange', false);
}

function confirmDelete() {
  if (props.mode !== 'edit' || !props.entry) return;
  emit('delete', props.entry.uid);
}

defineExpose({ submit, requestDelete, cancelDelete, confirmDelete, resetGeneric, deleting, genericCanReset });
</script>

<template>
  <form class="csw-form" novalidate @submit.prevent="submit">
    <!-- Generic switch declaration (§5.7) -->
    <div v-if="mode === 'generic'" class="csw-cols csw-cols--one">
      <div class="csw-col">
        <div class="csw-field">
          <span :id="ids.classLab" class="csw-label">{{ t('csw.fClass') }}<span class="req" aria-hidden="true">*</span></span>
          <div class="csw-classrow">
            <div ref="chipsRef" class="csw-chips" role="radiogroup" :aria-labelledby="ids.classLab" @keydown="onChipKey">
              <button
                v-for="c in GENERIC_CLASSES"
                :key="c"
                type="button"
                role="radio"
                class="csw-chip num"
                :aria-checked="genericChip === c"
                :tabindex="genericChip === c ? 0 : -1"
                :aria-label="`${mm(c)} mm${c === GENERIC_START ? `, ${t('csw.classCommon')}` : ''}`"
                @click="selectGenericChip(c)"
              >
                <span class="csw-chip__v">{{ mm(c) }}</span>
                <span v-if="c === GENERIC_START" class="csw-chip__sub">{{ t('csw.classCommon') }}</span>
              </button>
              <button
                type="button"
                role="radio"
                class="csw-chip"
                :aria-checked="genericChip === 'other'"
                :tabindex="genericChip === 'other' ? 0 : -1"
                :aria-label="t('csw.fClassOther')"
                @click="selectGenericChip('other')"
              >
                <span class="csw-chip__v">{{ t('csw.fClassOther') }}</span>
              </button>
            </div>
            <div ref="genericOtherWrap" class="csw-nf-wrap">
              <NumberField
                v-model="genericOtherMm"
                :min="1"
                :max="6"
                :step="0.01"
                :decimals="3"
                unit="mm"
                placeholder=""
                :label="t('csw.fClassOther')"
                :disabled="genericChip !== 'other'"
              />
            </div>
          </div>
          <p v-if="travelErr" :id="ids.travelErr" class="csw-err" role="alert">
            <IconAlertTriangle :size="14" aria-hidden="true" />{{ travelErr }}
          </p>
        </div>

        <div class="csw-field">
          <span class="csw-label">{{ t('csw.fCurve') }}</span>
          <p class="csw-fixed" aria-live="polite">
            <template v-if="genericCoef !== null && genericClampedUm !== null">
              {{ genericChip === 'other'
                ? t('csw.fGenericCurveTyped', { coef: genericCoef })
                : t('csw.fGenericCurve', { coef: genericCoef, mm: mm(genericClampedUm) }) }}
            </template>
            <template v-else>—</template>
          </p>
          <p class="csw-hint">{{ t('csw.fGenericWhy') }}</p>
        </div>
      </div>
    </div>

    <!-- Create / edit / copy custom switch (§6.1–6.4) -->
    <div v-else class="csw-cols">
      <div class="csw-col">
        <div class="csw-field">
          <label class="csw-label" :for="ids.name">{{ t('csw.fName') }}<span class="req" aria-hidden="true">*</span></label>
          <input
            :id="ids.name"
            ref="nameInput"
            v-model="name"
            type="text"
            class="csw-input"
            :maxlength="CUSTOM_NAME_MAX"
            :placeholder="t('csw.fNamePh')"
            autocomplete="off"
            spellcheck="false"
            :aria-invalid="nameErr ? 'true' : undefined"
            :aria-describedby="nameErr ? ids.nameErr : undefined"
          >
          <p v-if="nameErr" :id="ids.nameErr" class="csw-err" role="alert">
            <IconAlertTriangle :size="14" aria-hidden="true" />{{ nameErr }}
          </p>
        </div>

        <div class="csw-field">
          <label class="csw-label" :for="ids.maker">{{ t('csw.fMaker') }}</label>
          <input
            :id="ids.maker"
            v-model="maker"
            type="text"
            class="csw-input"
            :maxlength="CUSTOM_MAKER_MAX"
            :placeholder="t('csw.fMakerPh')"
            autocomplete="off"
            spellcheck="false"
          >
        </div>

        <div class="csw-field">
          <span class="csw-label">{{ t('csw.fTravel') }}<span class="req" aria-hidden="true">*</span></span>
          <div ref="travelWrap" class="csw-nf-wrap">
            <NumberField
              v-model="travelMm"
              :min="1"
              :max="6"
              :step="0.01"
              :decimals="3"
              unit="mm"
              placeholder=""
              :label="t('csw.fTravel')"
            />
          </div>
          <p :id="ids.travelHint" class="csw-hint">{{ t('csw.fTravelHint') }}</p>
          <p v-if="travelErr" :id="ids.travelErr" class="csw-err" role="alert">
            <IconAlertTriangle :size="14" aria-hidden="true" />{{ travelErr }}
          </p>
        </div>

        <div class="csw-field">
          <label class="csw-label" :for="ids.note">{{ t('csw.fNote') }}</label>
          <input
            :id="ids.note"
            v-model="note"
            type="text"
            class="csw-input"
            :maxlength="CUSTOM_NOTE_MAX"
            :placeholder="t('csw.fNotePh')"
            autocomplete="off"
          >
        </div>
      </div>

      <div class="csw-col">
        <fieldset class="csw-curve">
          <legend class="csw-label">{{ t('csw.fCurve') }}<span class="req" aria-hidden="true">*</span></legend>

          <div class="csw-radio">
            <label class="csw-radio__lab">
              <input type="radio" :name="`${uid}-curve`" value="like" :checked="curveKind === 'like'" @change="pickCurveKind('like')">
              <span>{{ t('csw.fCurveLike') }}</span>
            </label>
            <div class="csw-select-wrap">
              <select
                :id="ids.like"
                class="csw-select"
                :aria-label="t('csw.fCurveLike')"
                :disabled="curveKind !== 'like'"
                :value="effectiveLikeId ?? ''"
                @change="onLikeSelect"
              >
                <option v-if="effectiveLikeId === null" disabled value="">{{ t('csw.fBasePh') }}</option>
                <optgroup v-for="g in catalogTabs" :key="g.id" :label="g.label ?? t('sw.groupOther')">
                  <option v-for="e in g.entries" :key="e.id" :value="e.id">
                    {{ t('csw.fOption', { name: switchName(e), mm: mm(e.rangeMax), coef: e.coefficient }) }}{{ suggested && e.id === suggested.id ? ` (${t('csw.suggested')})` : '' }}
                  </option>
                </optgroup>
              </select>
              <IconChevronDown class="csw-select-chev" :size="16" aria-hidden="true" />
            </div>
          </div>

          <div class="csw-radio">
            <label class="csw-radio__lab">
              <input type="radio" :name="`${uid}-curve`" value="travel" :checked="curveKind === 'travel'" @change="pickCurveKind('travel')">
              <span>{{ t('csw.fCurveTravel') }}</span>
            </label>
            <span class="csw-coefval" aria-live="polite">
              {{ estCoef !== null ? t('csw.fCoefValue', { coef: estCoef }) : '—' }}
            </span>
          </div>

          <div class="csw-radio">
            <label class="csw-radio__lab">
              <input type="radio" :name="`${uid}-curve`" value="manual" :checked="curveKind === 'manual'" @change="pickCurveKind('manual')">
              <span>{{ t('csw.fCurveManual') }}</span>
            </label>
            <input
              :id="ids.coef"
              ref="coefInput"
              v-model="manualCoefText"
              type="text"
              inputmode="numeric"
              class="csw-input csw-coefin"
              :aria-label="t('csw.fCoefLabel')"
              :disabled="curveKind !== 'manual'"
              :aria-invalid="coefErr ? 'true' : undefined"
              :aria-describedby="coefDescribedBy"
              @input="onManualCoefInput"
              @blur="normalizeManualCoef"
            >
            <p v-if="curveKind === 'manual' && coefErr" :id="ids.coefErr" class="csw-err csw-radio__note" role="alert">
              <IconAlertTriangle :size="14" aria-hidden="true" />{{ coefErr }}
            </p>
            <p v-if="curveKind === 'manual' && coefClampMsg" :id="ids.coefClamp" class="csw-warn csw-radio__note">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ coefClampMsg }}
            </p>
            <p v-if="curveKind === 'manual'" :id="ids.coefNote" class="csw-hint csw-radio__note">
              {{ t('csw.fCoefNote', { min: cb.min, max: cb.max }) }}
            </p>
          </div>

          <p class="csw-hint">{{ t('csw.fCurveHint') }}</p>
        </fieldset>

        <div class="csw-field">
          <span :id="ids.colorLab" class="csw-label">{{ t('csw.fColor') }}</span>
          <div ref="colorsRef" class="csw-colors" role="radiogroup" :aria-labelledby="ids.colorLab" @keydown="onColorKey">
            <button
              v-for="c in SWITCH_COLORS"
              :key="c.id"
              type="button"
              role="radio"
              :class="['csw-dot', !c.hex && 'csw-dot--none']"
              :style="c.hex ? { '--c': c.hex } : undefined"
              :aria-checked="color === c.hex"
              :aria-label="t(`csw.color.${c.id}`)"
              :title="t(`csw.color.${c.id}`)"
              :tabindex="color === c.hex ? 0 : -1"
              @click="color = c.hex"
            />
          </div>
        </div>
      </div>
    </div>

    <!-- Preview + notes, or in-place delete confirmation (§6.5, §6.6) -->
    <div class="csw-preview">
      <div v-if="deleting && entry" class="csw-del" role="group" :aria-labelledby="ids.delTitle">
        <IconAlertTriangle :size="16" aria-hidden="true" />
        <div class="csw-del__text">
          <b :id="ids.delTitle">{{ t('csw.delTitle', { name: entry.name }) }}</b>
          <span>{{ inUseCount > 0 ? t('csw.delBody', { n: inUseCount }) : t('csw.delBodyUnused') }}</span>
        </div>
      </div>
      <template v-else>
        <template v-if="previewRangeUm !== null && resolvedCoef !== null">
          <div class="csw-prow">
            <SwitchSwatch :color="mode === 'generic' ? '' : color" custom />
            <div class="csw-prow__text">
              <span class="csw-prow__name">{{ previewName }}</span>
              <span class="csw-prow__meta">{{ previewMeta }}</span>
            </div>
          </div>
          <p class="csw-writes">{{ t('csw.writes', { um: previewRangeUm, coef: resolvedCoef }) }}</p>
          <p v-if="travelClampNote" class="csw-warn">
            <IconAlertTriangle :size="15" aria-hidden="true" />{{ travelClampNote }}
          </p>
          <p v-if="catalogTwin" class="csw-info">
            <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.sameAsCatalog', { name: switchName(catalogTwin) }) }}
          </p>
          <p v-if="nameTwin" class="csw-info">
            <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.nameCatalog', { name: switchName(nameTwin), maker: switchBrand(nameTwin.id) ?? groupLabel(nameTwin.group) }) }}
          </p>
          <p v-if="showInUseNote" class="csw-warn">
            <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('csw.inUseEdit', { n: inUseCount }) }}
          </p>
        </template>
        <p class="csw-info">
          <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.saveNote') }}
        </p>
      </template>
    </div>
  </form>
</template>

<style scoped>
.csw-form {
  display: flex; flex-direction: column; gap: var(--s-4);
  overflow-y: auto; min-height: 0; padding: 2px; margin: -2px;
  container: csw / inline-size;
}
.csw-cols { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-4) var(--s-5); }
.csw-cols--one { grid-template-columns: 1fr; }
@container csw (max-width: 639.98px) { .csw-cols { grid-template-columns: 1fr; } }
.csw-col { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
.csw-field { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.csw-label { font-size: var(--fs-label); font-weight: 600; color: var(--fg-1); }
.csw-label .req { color: var(--fg-3); font-weight: 500; margin-left: 2px; }
.csw-hint { margin: 0; font-size: var(--fs-label); line-height: 1.4; color: var(--fg-3); }
.csw-fixed { margin: 0; font-size: var(--fs-label); line-height: 1.45; color: var(--fg-1); font-variant-numeric: tabular-nums; }
.csw-input, .csw-select {
  box-sizing: border-box; width: 100%; height: 34px; padding: 0 10px;
  border: 1px solid var(--line-2); border-radius: var(--r-control);
  background: var(--bg-1); color: var(--fg-1); font: inherit; font-size: var(--fs-body);
}
.csw-input::placeholder { color: var(--fg-3); }
.csw-input:focus-visible, .csw-select:focus-visible { outline: none; border-color: var(--acc); box-shadow: var(--focus-ring); }
.csw-input:disabled, .csw-select:disabled { opacity: 0.55; cursor: not-allowed; }
.csw-input[aria-invalid='true'] { border-color: var(--danger); }
.csw-nf-wrap { width: 180px; }
.csw-nf-wrap :deep(.nf) { width: 100%; }

.csw-curve { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: var(--s-2); }
.csw-curve > legend { padding: 0; margin-bottom: 6px; }
.csw-radio { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.csw-radio__lab { display: flex; align-items: center; gap: 8px; font-size: var(--fs-body); color: var(--fg-1); cursor: pointer; }
.csw-radio__lab input { flex: none; width: 16px; height: 16px; margin: 0; accent-color: var(--acc); }
.csw-select-wrap { position: relative; margin-left: 24px; width: calc(100% - 24px); }
.csw-select { appearance: none; padding-right: 32px; text-overflow: ellipsis; color-scheme: inherit; }
.csw-select-chev { position: absolute; right: 9px; top: 50%; transform: translateY(-50%); color: var(--fg-3); pointer-events: none; }
.csw-coefval { margin-left: 24px; font-size: var(--fs-label); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.csw-coefin { margin-left: 24px; width: 120px; text-align: right; font-variant-numeric: tabular-nums; }
.csw-radio__note { margin-left: 24px; }

.csw-classrow { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.csw-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.csw-chip {
  box-sizing: border-box; min-width: 72px; min-height: 34px; padding: 3px 10px;
  display: inline-flex; flex-direction: column; align-items: center; justify-content: center;
  border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--bg-1); color: var(--fg-1);
  font: inherit; font-size: var(--fs-label); font-weight: 600; line-height: 1.25; cursor: pointer;
}
.csw-chip__sub { font-size: var(--fs-caption); font-weight: 500; color: var(--fg-2); }
.csw-chip:hover { background: var(--bg-3); }
.csw-chip:focus-visible { outline: none; border-color: var(--acc); box-shadow: var(--focus-ring); }
.csw-chip[aria-checked='true'] {
  border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc);
  background: color-mix(in srgb, var(--acc) 12%, var(--bg-1));
}

.csw-colors { display: flex; flex-wrap: wrap; gap: 8px; }
.csw-dot {
  box-sizing: border-box; width: 26px; height: 26px; border-radius: 50%;
  border: 1px solid var(--line-3); padding: 0; background: var(--c, transparent); position: relative; cursor: pointer;
}
.csw-dot--none { background: transparent; border-style: dashed; }
.csw-dot--none::after {
  content: ''; position: absolute; left: 50%; top: 3px; bottom: 3px;
  width: 1.5px; background: var(--fg-3); transform: rotate(45deg);
}
.csw-dot[aria-checked='true'] { box-shadow: 0 0 0 2px var(--bg-2), 0 0 0 4px var(--acc); }
.csw-dot:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--bg-2), var(--focus-ring); }

.csw-preview { display: flex; flex-direction: column; gap: var(--s-2); padding-top: var(--s-4); border-top: 1px solid var(--line-1); }
.csw-prow { display: flex; align-items: center; gap: var(--s-3); min-width: 0; }
.csw-prow__text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.csw-prow__name { font-weight: 600; color: var(--fg-1); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.csw-prow__meta { font-size: var(--fs-label); color: var(--fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.csw-writes { margin: 0; font-size: var(--fs-label); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.csw-warn, .csw-info { display: flex; gap: var(--s-2); align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 1.45; }
.csw-warn { color: var(--fg-1); }
.csw-warn svg { color: var(--warn); flex: none; margin-top: 1px; }
.csw-info { color: var(--fg-2); }
.csw-info svg { color: var(--fg-3); flex: none; margin-top: 1px; }
.csw-err { margin: 0; font-size: var(--fs-label); color: var(--danger); display: flex; gap: 6px; align-items: flex-start; }
.csw-err svg { flex: none; margin-top: 2px; }

.csw-del {
  display: flex; align-items: flex-start; gap: var(--s-3); padding: var(--s-3);
  border-radius: var(--r-control);
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) var(--soft-pct), var(--bg-2));
}
.csw-del > svg { flex: none; color: var(--warn); margin-top: 2px; }
.csw-del__text { flex: 1; min-width: 0; font-size: var(--fs-label); line-height: 1.45; color: var(--fg-1); }
.csw-del__text b { display: block; font-size: var(--fs-body); font-weight: 600; margin-bottom: 2px; }
</style>
