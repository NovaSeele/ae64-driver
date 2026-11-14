<script setup lang="ts">
// "Copy info" (DESIGN H §3.1): the support block on the clipboard, or in a dialog with the text selected when the browser
// refuses. Reads the stores only: 0 HID commands (the settings are not read just for this; unread values are "—").
import { nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { IconCheck, IconCopy } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import { useToast } from '../ui/toast';
import { currentPlatform, zoomModifier } from '../ui/zoomHint';
import { buildSupportInfo, browserLabel } from '../../data/supportInfo';
import { POLLING_RATE_HZ } from '../../protocol';
import { useDeviceStore } from '../../stores/device';
import { useSettingsStore } from '../../stores/settings';
import { themeChoice } from '../../theme';
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
const settings = useSettingsStore();
const copied = ref(false);
const open = ref(false);
const text = ref('');
const area = ref<HTMLTextAreaElement | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

function supportText(): string {
  const v = device.version;
  const read = settings.loaded && !settings.loadError;
  return buildSupportInfo({
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
    keyboard: device.connected
      ? {
          model: device.modelName,
          demo: device.demo,
          boardIdHex: device.info?.boardIdHex,
          firmware: device.info?.firmware,
          protocol: v ? `${v.main}.${v.sub}.${v.hardware}.${v.software}` : null,
          rtPrecision: device.rtPrecision,
          pollingHz: read ? POLLING_RATE_HZ[settings.pollingRate] ?? null : null,
          macro: read ? settings.macroSpace : null,
        }
      : null,
    browser: browserLabel(typeof navigator === 'undefined' ? undefined : (navigator as never)),
    locale: locale.value,
    theme: themeChoice.value,
    now: new Date(),
  });
}

async function copy(): Promise<void> {
  text.value = supportText();
  try {
    if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
    await navigator.clipboard.writeText(text.value);
  } catch {
    open.value = true; // the dialog is the way on: no error toast
    return;
  }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => { copied.value = false; }, 2000);
  useToast().show(t('info.copiedToast'), 'success');
}

// Dialog focuses its first button; the text area is the place to be, with everything selected.
watch(open, async (v) => {
  if (!v) return;
  await nextTick();
  setTimeout(() => { area.value?.focus(); area.value?.select(); });
});
onBeforeUnmount(() => clearTimeout(timer));
</script>

<template>
  <Button size="sm" variant="secondary" :icon="copied ? IconCheck : IconCopy" @click="copy">
    {{ copied ? t('info.copied') : t('info.copy') }}
  </Button>
  <Dialog v-model:open="open" :title="t('info.copyTitle')" :width="520">
    <p class="ci__help">{{ t('info.copyHelp', { mod: zoomModifier(currentPlatform()) }) }}</p>
    <textarea
      ref="area"
      class="ci__text"
      readonly
      spellcheck="false"
      :aria-label="t('info.copyLabel')"
      :value="text"
      @focus="area?.select()"
    />
    <p class="ci__privacy">{{ t('info.privacy') }}</p>
    <template #footer>
      <Button variant="secondary" @click="open = false">{{ t('info.close') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.ci__help { margin: 0 0 var(--s-3); font-size: var(--fs-label); line-height: 18px; color: var(--fg-2); }
.ci__text {
  display: block;
  width: 100%;
  height: 244px; /* the 11 lines, no inner scroll: 11 × 20 + 2 × 10 padding + 2 × 1 border + 2 */
  padding: 10px 12px;
  resize: none;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-1);
  color: var(--fg-1);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: var(--fs-label);
  line-height: 20px;
  white-space: pre;
}
.ci__text:focus { border-color: var(--acc-line); box-shadow: var(--focus-ring); outline: none; }
.ci__text::selection { background: color-mix(in srgb, var(--acc) 35%, transparent); color: var(--fg-1); }
.ci__privacy { margin: var(--s-2) 0 0; font-size: var(--fs-caption); color: var(--fg-3); }
</style>
