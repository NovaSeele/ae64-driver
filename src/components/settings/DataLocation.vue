<script setup lang="ts">
// "Where your data lives" (DESIGN H §3.3, §3.4): what is stored on the keyboard and what stays in this browser, with the
// export / import / reset of the browser part. None of it sends a command to the keyboard; import and reset reload the
// page only once every write to the keyboard is done (useAppSettings().applyAndReload).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  IconAlertCircle, IconAlertTriangle, IconArrowRight, IconCircleCheck, IconDeviceLaptop, IconDownload, IconKeyboard,
  IconRestore, IconShieldCheck, IconUpload,
} from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import { useToast } from '../ui/toast';
import {
  APP_SETTING_GROUPS, MAX_IMPORT_BYTES, PRESETS_KEY, buildExport, groupsOf, parseImport, presetCount, storedSettings,
  useAppSettings, type AppSettingGroup,
} from '../../data/appSettings';
import { useUserPresetsStore } from '../../stores/userPresets';
import { themeChoice } from '../../theme';
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';

const ON_KEYBOARD = [
  'data.k.travel', 'data.k.switch', 'data.k.calibration', 'data.k.advanced', 'data.k.keymap', 'data.k.macro',
  'data.k.lighting', 'data.k.profiles', 'data.k.system', 'data.k.sleep', 'data.k.gamepad',
] as const;
const groupLabel = (g: AppSettingGroup) => t(`data.c.${g}` as const);

const { busyReason, applyAndReload } = useAppSettings();
const userPresets = useUserPresetsStore();
const toast = useToast();

// ---- Export: off while nothing is stored. localStorage is not reactive, so the count is taken again on the events
// that can change it (this page writes the theme; the sidebar writes the language and its own fold).
const exportable = ref(0);
const recount = () => { exportable.value = Object.keys(storedSettings()).length; };
const onStorage = () => recount();
onMounted(() => { recount(); window.addEventListener('storage', onStorage); });
onBeforeUnmount(() => window.removeEventListener('storage', onStorage));
watch([themeChoice, locale], recount, { flush: 'post' });

const err = ref<string | null>(null);

function download(json: string, file: string): void {
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url));
}

function exportFile(): void {
  err.value = null;
  const { json, file, n } = buildExport();
  if (!n) { recount(); return; }
  download(json, file);
  toast.show(t('appcfg.exported', { n, file }), 'success');
}

// ---- Import
const fileInput = ref<HTMLInputElement | null>(null);
const importOpen = ref(false);
const importData = ref<{ data: Record<string, string>; savedAt: string; version: string } | null>(null);
const applying = ref(false);
const confirmImport = ref<InstanceType<typeof Button> | null>(null);

function pickFile(): void {
  err.value = null;
  fileInput.value?.click();
}

async function onFile(): Promise<void> {
  const input = fileInput.value;
  const f = input?.files?.[0];
  if (input) input.value = ''; // the same file chosen again still runs
  if (!f) return;
  let text = '';
  if (f.size <= MAX_IMPORT_BYTES) {
    try { text = await f.text(); } catch { text = ''; }
  }
  const r = parseImport(text, f.size);
  if (!r.ok) {
    err.value = t(`appcfg.${r.error}` as const, { keys: r.keys ?? '' });
    return;
  }
  importData.value = r;
  importOpen.value = true;
}

const pad2 = (n: number) => String(n).padStart(2, '0');
const importTime = computed(() => {
  const d = new Date(importData.value?.savedAt ?? '');
  if (Number.isNaN(d.getTime())) return '—';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
});
const importGroups = computed(() => groupsOf(Object.keys(importData.value?.data ?? {})));
const importPresets = computed(() => {
  const data = importData.value?.data;
  if (!data || !Object.prototype.hasOwnProperty.call(data, PRESETS_KEY) || !userPresets.presets.length) return null;
  return { n: userPresets.presets.length, m: presetCount(data[PRESETS_KEY]) };
});
// The user just chose the file: focus goes to "Import and reload" (Dialog would take the first button, Cancel).
watch(importOpen, async (v) => {
  if (!v) return;
  await nextTick();
  setTimeout(() => (confirmImport.value?.$el as HTMLElement | undefined)?.focus());
});

// ---- Reset (Dialog focuses Cancel, the first button)
const resetOpen = ref(false);
function askReset(): void {
  err.value = null;
  resetOpen.value = true;
}

async function run(kind: 'import' | 'reset'): Promise<void> {
  if (applying.value) return;
  applying.value = true;
  try {
    await applyAndReload(kind, kind === 'import' ? importData.value?.data : undefined);
  } catch (e) {
    importOpen.value = false;
    resetOpen.value = false;
    err.value = e instanceof Error ? e.message : String(e);
  } finally {
    applying.value = false;
  }
}
</script>

<template>
  <Card class="dl-card" :subtitle="t('data.sub')" aria-labelledby="dl-title" @pointerenter="recount" @focusin="recount">
    <template #title><span id="dl-title">{{ t('data.title') }}</span></template>
    <div class="dl">
      <section class="dl__col" aria-labelledby="dl-k">
        <div class="dl__head">
          <span class="dl__icon" style="--f: var(--f-keymap)"><IconKeyboard :size="18" stroke-width="1.5" aria-hidden="true" /></span>
          <div>
            <h4 id="dl-k" class="dl__title">{{ t('data.onKeyboard') }}</h4>
            <p class="dl__sub">{{ t('data.onKeyboardSub') }}</p>
          </div>
        </div>
        <ul class="dl__list">
          <li v-for="k in ON_KEYBOARD" :key="k">{{ t(k) }}</li>
        </ul>
        <div class="dl__foot">
          <p class="dl__promise"><IconShieldCheck :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('sync.savedHelp') }}</span></p>
          <RouterLink class="dl__link" :to="{ path: '/diagnostics', query: { focus: 'backup' } }">
            {{ t('data.keyboardBackup') }}<IconArrowRight :size="15" stroke-width="1.75" aria-hidden="true" />
          </RouterLink>
        </div>
      </section>
      <section class="dl__col" aria-labelledby="dl-c">
        <div class="dl__head">
          <span class="dl__icon" style="--f: var(--f-settings)"><IconDeviceLaptop :size="18" stroke-width="1.5" aria-hidden="true" /></span>
          <div>
            <h4 id="dl-c" class="dl__title">{{ t('data.onComputer') }}</h4>
            <p class="dl__sub">{{ t('data.onComputerSub') }}</p>
          </div>
        </div>
        <ul class="dl__list">
          <li v-for="g in APP_SETTING_GROUPS" :key="g">{{ groupLabel(g) }}</li>
        </ul>
        <div class="dl__foot">
          <div class="dl__actions">
            <Button
              size="sm"
              variant="secondary"
              :icon="IconDownload"
              :disabled="!exportable"
              :title="exportable ? undefined : t('appcfg.nothing')"
              @click="exportFile"
            >{{ t('appcfg.export') }}</Button>
            <Button size="sm" variant="secondary" :icon="IconUpload" :disabled="!!busyReason" @click="pickFile">{{ t('appcfg.import') }}</Button>
            <Button size="sm" variant="ghost" :icon="IconRestore" :disabled="!!busyReason" @click="askReset">{{ t('appcfg.reset') }}</Button>
            <input ref="fileInput" type="file" accept="application/json,.json" hidden @change="onFile" />
          </div>
          <p v-if="busyReason" class="dl__lock" role="status">{{ busyReason }}</p>
          <p class="dl__note">{{ t('appcfg.note') }}</p>
          <p v-if="err" class="dl__err" role="alert"><IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ err }}</span></p>
        </div>
      </section>
    </div>
  </Card>

  <Dialog v-model:open="importOpen" :title="t('appcfg.importTitle')" :width="480">
    <div class="ac__body">
      <p>{{ t('appcfg.importBody', { time: importTime, version: importData?.version || '—' }) }}</p>
      <ul class="ac__list">
        <li v-for="g in importGroups" :key="g">{{ groupLabel(g) }}</li>
      </ul>
      <p v-if="importPresets" class="ac__warn">
        <IconAlertTriangle :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('appcfg.importPresets', importPresets) }}</span>
      </p>
      <p class="ac__safe"><IconCircleCheck :size="16" stroke-width="2" aria-hidden="true" /><span>{{ t('appcfg.keyboardSafe') }}</span></p>
    </div>
    <template #footer>
      <Button variant="ghost" @click="importOpen = false">{{ t('appcfg.cancel') }}</Button>
      <Button ref="confirmImport" variant="primary" :icon="IconUpload" :loading="applying" @click="run('import')">{{ t('appcfg.importConfirm') }}</Button>
    </template>
  </Dialog>

  <Dialog v-model:open="resetOpen" :title="t('appcfg.resetTitle')" :width="480">
    <div class="ac__body">
      <p>{{ t('appcfg.resetBody') }}</p>
      <p v-if="userPresets.presets.length" class="ac__warn">
        <IconAlertTriangle :size="16" stroke-width="1.75" aria-hidden="true" /><span>{{ t('appcfg.resetPresets', { n: userPresets.presets.length }) }}</span>
      </p>
      <p class="ac__safe"><IconCircleCheck :size="16" stroke-width="2" aria-hidden="true" /><span>{{ t('appcfg.keyboardSafe') }}</span></p>
    </div>
    <template #footer>
      <Button variant="ghost" @click="resetOpen = false">{{ t('appcfg.cancel') }}</Button>
      <Button variant="danger" :icon="IconRestore" :loading="applying" @click="run('reset')">{{ t('appcfg.resetConfirm') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.dl-card { grid-column: 1 / -1; container-type: inline-size; }
.dl { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--s-4); }
/* stacked below 880 px of card: two ~369 px columns would wrap half the items */
@container (max-width: 879.98px) { .dl { grid-template-columns: minmax(0, 1fr); } }
.dl__col {
  display: flex;
  flex-direction: column;
  gap: var(--s-3);
  min-width: 0;
  padding: var(--s-4);
  border: 1px solid var(--line-1);
  border-radius: var(--r-card);
  background: var(--bg-1);
}
.dl__head { display: flex; align-items: flex-start; gap: var(--s-3); }
.dl__icon {
  flex: none;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--f) 16%, transparent);
  color: var(--f);
}
.dl__title { margin: 0; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
.dl__sub { margin: 2px 0 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }
.dl__list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px var(--s-4);
  margin: 0;
  padding: 0;
  list-style: none;
  font-size: var(--fs-label);
  line-height: 20px;
  color: var(--fg-2);
}
@container (max-width: 459.98px) { .dl__list { grid-template-columns: minmax(0, 1fr); } }
.dl__list li { position: relative; padding-left: 14px; }
.dl__list li::before {
  content: '';
  position: absolute;
  left: 2px;
  top: 8px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--fg-4);
}
.dl__foot {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding-top: var(--s-3);
  border-top: 1px solid var(--line-1);
}
.dl__promise { display: flex; align-items: flex-start; gap: 6px; margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-2); }
.dl__promise svg { flex: none; margin-top: 1px; color: var(--ok); }
.dl__link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  align-self: flex-start;
  font-size: var(--fs-label);
  font-weight: 500;
  border-radius: 4px;
}
.dl__link:hover { text-decoration: underline; text-underline-offset: 3px; }
.dl__actions { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.dl__note { margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-3); }
.dl__err {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: 0;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-control);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-label);
  line-height: 18px;
}
.dl__err svg { flex: none; margin-top: 1px; }
.dl__lock { margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--warn); }

.ac__body { display: flex; flex-direction: column; gap: var(--s-3); font-size: var(--fs-body); line-height: 20px; color: var(--fg-2); }
.ac__body p { margin: 0; }
.ac__list {
  margin: 0;
  padding: 10px 12px;
  list-style: none;
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  background: var(--bg-1);
  font-size: var(--fs-label);
  line-height: 20px;
  color: var(--fg-1);
  columns: 2;
  column-gap: var(--s-4);
}
.ac__safe { display: flex; align-items: center; gap: 6px; color: var(--ok); font-size: var(--fs-label); font-weight: 500; }
.ac__warn {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-control);
  background: var(--warn-soft);
  color: var(--warn);
  font-size: var(--fs-label);
  line-height: 18px;
}
.ac__warn svg, .ac__safe svg { flex: none; }
</style>
