<script setup lang="ts">
// One onboard profile (DESIGN G §3.3, §3.4): number, name, rename in place, two summary figures, "Use this profile" or the
// "Active" line. The rename takes the place of the head + figures and Cancel / Save take the footer's, so the card keeps
// its height. Writes go through the device store as the sidebar's do (renameProfile; the page runs switchProfile).
import { computed, nextTick, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import { IconPencil } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import IconButton from '../ui/IconButton.vue';
import type { Performance } from '../../protocol';
import { useDeviceStore } from '../../stores/device';
import { PROFILE_NAME_MAX_BYTES, truncateUtf8, utf8Bytes } from '../../stores/settings';
import { actuationStats, actuationText, rtCount } from '../../data/overviewStats';
import { capDecimals } from '../../data/keycapActuation';
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';

const props = defineProps<{
  index: number;
  name: string;
  active: boolean;
  /** The profile's records: live for the active one once read, a snapshot for another one, null when not opened. */
  values: Record<number, Performance> | null;
  /** When the app left this profile (snapshot), null for live values. */
  at: number | null;
  /** The active card's read: in progress or failed. */
  read: 'loading' | 'error' | null;
  loadedCount: number;
  /** Calibrating, switching or reading: no switch and no rename now. */
  busy: boolean;
  /** This card's switch is running. */
  switching: boolean;
  calibrating: boolean;
  canRename: boolean;
  editing: boolean;
}>();
const emit = defineEmits<{ use: []; edit: []; close: [] }>();

const device = useDeviceStore();
const decimals = computed(() => capDecimals(device.rtPrecision));
const total = computed(() => device.keys.length);

const stats = computed(() => (props.values ? actuationStats(props.values, decimals.value) : null));
const actText = computed(() => (stats.value ? actuationText(stats.value, decimals.value) : '—'));
const rtText = computed(() => (props.values ? t('ov.rtKeys', { n: rtCount(props.values), total: total.value }) : ''));
const meta = computed(() => {
  if (props.active) return t('pf.liveData');
  if (props.at === null) return '';
  const time = new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(props.at);
  return t('pf.dataAt', { time });
});
const profileLabel = computed(() => `${t('device.profile')} ${props.index + 1}`);

// ----- rename (§3.4)
const draft = ref('');
const saving = ref(false);
const error = ref('');
const input = ref<HTMLInputElement | null>(null);
const pencil = ref<ComponentPublicInstance | null>(null);
/** What a save sends: the draft cut at 32 bytes (while an IME composes, the input may still hold more). */
const cut = computed(() => truncateUtf8(draft.value, PROFILE_NAME_MAX_BYTES));
const bytes = computed(() => utf8Bytes(cut.value));
// The store trims before writing, so a name that differs only by spaces (the Pro's '配置一 ') is unchanged: no write.
const canSave = computed(() => !props.busy && !saving.value && !!cut.value.trim() && cut.value.trim() !== props.name.trim());

watch(() => props.editing, async (on) => {
  if (!on) return;
  draft.value = props.name;
  error.value = '';
  saving.value = false;
  await nextTick();
  input.value?.focus();
  input.value?.select();
});

function onInput(e: Event) {
  const el = e.target as HTMLInputElement;
  error.value = '';
  // Composing (IME): leave the input alone, writing el.value would break the composition; cut at compositionend.
  if ((e as InputEvent).isComposing) {
    draft.value = el.value;
    return;
  }
  const v = truncateUtf8(el.value, PROFILE_NAME_MAX_BYTES);
  draft.value = v;
  if (v !== el.value) el.value = v;
}

async function focusPencil() {
  await nextTick();
  (pencil.value?.$el as HTMLElement | undefined)?.focus();
}

function cancel() {
  if (saving.value) return;
  emit('close');
  void focusPencil();
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = '';
  try {
    await device.renameProfile(props.index, cut.value);
    saving.value = false;
    emit('close');
    void focusPencil();
  } catch (err) {
    saving.value = false;
    error.value = err instanceof Error ? err.message : String(err);
  }
}

/** Enter saves, Esc cancels; not while an IME uses the key to pick or drop a candidate. Blur does neither (§3.4). */
function onKey(e: KeyboardEvent) {
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    void save();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancel();
  }
}
</script>

<template>
  <article
    class="pfc"
    :class="{ 'pfc--on': active }"
    :aria-current="active ? 'true' : undefined"
    :aria-labelledby="editing ? undefined : `pf-name-${index}`"
    :aria-label="editing ? profileLabel : undefined"
  >
    <div v-if="editing" class="pfc__edit">
      <div class="pfc__row">
        <span class="pfc__n num" aria-hidden="true">{{ index + 1 }}</span>
        <input
          ref="input"
          :value="draft"
          type="text"
          class="pfc__input"
          :aria-label="t('settings.profileInputLabel', { n: index + 1 })"
          :aria-describedby="`pf-help-${index}`"
          :aria-invalid="error ? 'true' : undefined"
          :disabled="saving"
          autocomplete="off"
          spellcheck="false"
          @input="onInput"
          @compositionend="onInput"
          @keydown="onKey"
        >
      </div>
      <p :id="`pf-help-${index}`" class="pfc__count" :class="{ 'pfc__count--full': bytes >= PROFILE_NAME_MAX_BYTES }">
        <span v-if="!error">{{ t('pf.nameHelp') }}</span>
        <span class="pfc__bytes num">{{ t('settings.profileBytes', { used: bytes, max: PROFILE_NAME_MAX_BYTES }) }}</span>
      </p>
      <p v-if="error" class="pfc__err" role="alert">{{ error }}</p>
    </div>
    <template v-else>
      <div class="pfc__top">
        <span class="pfc__n num" aria-hidden="true">{{ index + 1 }}</span>
        <h3 :id="`pf-name-${index}`" class="pfc__name" :title="name" tabindex="-1"><span class="sr-only">{{ profileLabel }}: </span>{{ name }}</h3>
        <IconButton
          v-if="canRename"
          ref="pencil"
          :icon="IconPencil"
          size="sm"
          :label="t('pf.renameName', { name })"
          :title="calibrating ? t('device.calibrating') : t('device.rename')"
          :disabled="busy"
          @click="emit('edit')"
        />
      </div>
      <div class="pfc__body">
        <p v-if="active && read === 'loading'" class="pfc__none num" role="status">{{ t('perf.loading', { n: loadedCount }) }}</p>
        <p v-else-if="active && read === 'error'" class="pfc__none pfc__bad">{{ t('perf.loadFailed') }}</p>
        <template v-else-if="values">
          <dl class="pfc__stats">
            <div><dt>{{ t('ov.statActuation') }}</dt><dd class="num">{{ actText }}</dd></div>
            <div><dt>{{ t('ov.statRt') }}</dt><dd class="num">{{ rtText }}</dd></div>
          </dl>
          <p class="pfc__meta">{{ meta }}</p>
        </template>
        <template v-else>
          <p class="pfc__none">{{ t('pf.notOpened') }}</p>
          <p class="pfc__noneSub">{{ t('pf.notOpenedSub') }}</p>
        </template>
      </div>
    </template>
    <div class="pfc__foot">
      <div v-if="editing" class="pfc__btns">
        <Button variant="ghost" size="sm" :disabled="saving" @click="cancel">{{ t('pf.cancel') }}</Button>
        <Button variant="primary" size="sm" :loading="saving" :disabled="!canSave" @click="save">{{ t('pf.save') }}</Button>
      </div>
      <p v-else-if="active" class="pfc__live">{{ t('pf.active') }}</p>
      <Button
        v-else
        variant="secondary"
        size="sm"
        block
        :loading="switching"
        :disabled="busy"
        :aria-describedby="`pf-name-${index}`"
        @click="emit('use')"
      >
        {{ t('pf.use') }}
      </Button>
    </div>
  </article>
</template>

<style scoped>
.pfc {
  flex: 1; display: flex; flex-direction: column; gap: var(--s-3); min-width: 0; padding: 14px var(--s-4) var(--s-4);
  background: var(--panel); border: 1px solid var(--line-1); border-radius: var(--r-card);
}
/* active: a 2 px accent edge drawn as border + inset ring, so the card does not grow by a pixel */
.pfc--on { border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc); }
.pfc__top { display: flex; align-items: center; gap: var(--s-2); min-width: 0; min-height: 28px; }
/* = the Overview's .ovs__n and the sidebar chip: the same number on the same accent when active, neutral otherwise */
.pfc__n { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; font-size: var(--fs-label); font-weight: 650; line-height: 1; background: var(--bg-4); color: var(--fg-2); }
.pfc--on .pfc__n { background: var(--acc); color: var(--on-acc); }
.pfc__name { flex: 1; min-width: 0; margin: 0; font-size: var(--fs-card); font-weight: 600; line-height: 22px; color: var(--fg-1); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.pfc__name:focus { outline: none; }
.pfc__name:focus-visible { border-radius: 4px; box-shadow: var(--focus-ring); }
.pfc__top .ibtn { margin-right: -6px; }

/* stats: label left, value right; two rows, then the time. Unopened cards hold the same height with a text. */
.pfc__body { display: flex; flex-direction: column; gap: 4px; min-height: 62px; }
.pfc__stats { display: flex; flex-direction: column; gap: 2px; margin: 0; }
.pfc__stats > div { display: flex; align-items: baseline; justify-content: space-between; gap: var(--s-2); line-height: 20px; }
.pfc__stats dt { font-size: var(--fs-label); color: var(--fg-3); white-space: nowrap; }
.pfc__stats dd { margin: 0; font-size: var(--fs-label); font-weight: 600; color: var(--fg-1); white-space: nowrap; }
.pfc__meta { margin: 0; font-size: var(--fs-caption); line-height: 18px; color: var(--fg-3); }
.pfc__none { margin: 0; font-size: var(--fs-label); font-weight: 500; line-height: 20px; color: var(--fg-2); }
.pfc__bad { color: var(--danger); }
.pfc__noneSub { margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-3); }

/* footer: the action on the other three, a status line in the same 28 px on the active one */
.pfc__foot { margin-top: auto; display: flex; }
.pfc__foot > .btn { width: 100%; }
.pfc__live { display: flex; align-items: center; gap: 6px; width: 100%; height: 28px; margin: 0; font-size: var(--fs-label); font-weight: 600; color: var(--acc); }
.pfc__live::before { content: ''; flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--acc); box-shadow: 0 0 0 3px color-mix(in srgb, var(--acc) 22%, transparent); }

/* inline rename: in place of the head and the stats (Cancel / Save in the footer's place): the card keeps its height */
.pfc__edit { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 102px; }
.pfc__row { display: flex; align-items: center; gap: var(--s-2); min-width: 0; }
.pfc__input {
  width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 1px solid var(--line-2); border-radius: var(--r-control);
  background: var(--bg-1); color: var(--fg-1); font: inherit; font-size: var(--fs-body);
}
.pfc__input:focus { border-color: var(--acc-line); box-shadow: var(--focus-ring); outline: none; }
.pfc__input:disabled { opacity: 0.6; }
.pfc__input[aria-invalid='true'] { border-color: var(--danger); }
.pfc__count { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--s-2); margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-3); }
.pfc__bytes { flex: none; margin-left: auto; white-space: nowrap; }
.pfc__count--full .pfc__bytes { color: var(--warn); font-weight: 600; }
.pfc__btns { display: flex; gap: var(--s-2); width: 100%; }
.pfc__btns > .btn { flex: 1; }
/* in the help line's place, full width; a long transport error may add a line: the one case the card grows */
.pfc__err { margin: 0; font-size: var(--fs-caption); line-height: 16px; font-weight: 500; color: var(--danger); }
</style>
