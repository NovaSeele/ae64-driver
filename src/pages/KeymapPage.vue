<script setup lang="ts">
// Keymap page: layer tabs Main/Fn1/Fn2/Fn3, RAKKA-style layout, KeyPicker, Fn release guard rule.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconInfoCircle, IconRotateDot } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import KeyPicker from '../components/ui/KeyPicker.vue';
import Segmented from '../components/ui/Segmented.vue';
import Button from '../components/ui/Button.vue';
import Card from '../components/ui/Card.vue';
import Dialog from '../components/ui/Dialog.vue';
import { useToast } from '../components/ui/toast';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { LAYER_NAMES, isFnSwitch, useKeymapStore } from '../stores/keymap';
import type { LayerIndex } from '../stores/keymap';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const keymap = useKeymapStore();
const toast = useToast();

const confirmRestoreOpen = ref(false);
const restoreDiffCount = ref(0);
const pendingDefaultCodes = ref<Record<number, number>>({});

let offProfile: (() => void) | null = null;
onMounted(() => {
  void keymap.load();
  offProfile = device.onProfileChanged(() => void keymap.load(true));
});
onBeforeUnmount(() => offProfile?.());

const layerOptions = computed(() =>
  LAYER_NAMES.map((name, i) => ({
    value: i as LayerIndex,
    label: name,
    title: t('keymap.layerTab', { name }),
  })),
);

/** Single keycode when all selected keys have the same code; null if mixed or empty. */
const selectedCurrentCode = computed<number | null>(() => {
  if (!sel.ids.length) return null;
  const currentL = keymap.activeLayer;
  const codes = sel.ids.map((id) => keymap.values[currentL]?.[id]);
  const first = codes[0];
  if (first === undefined) return null;
  return codes.every((c) => c === first) ? first : null;
});

const isFnSelected = computed(() => {
  if (!sel.ids.length) return false;
  const currentL = keymap.activeLayer;
  return sel.ids.some((id) => isFnSwitch(keymap.values[currentL]?.[id] ?? 0));
});

function onPickKeycode(code: number) {
  if (!sel.ids.length) return;
  const { fnGuarded } = keymap.applyKeycode(sel.ids, code);
  if (fnGuarded) {
    toast.show(t('keymap.fnGuardedApplied'), 'info');
  }
}

async function checkRestoreDefault() {
  const { diffCount, defaultCodes } = await keymap.computeDefaultDiff();
  if (diffCount === 0) {
    toast.show(t('keymap.restoreDefaultNone'), 'info');
    return;
  }
  restoreDiffCount.value = diffCount;
  pendingDefaultCodes.value = defaultCodes;
  confirmRestoreOpen.value = true;
}

function doRestoreDefault() {
  keymap.applyDefault(keymap.activeLayer, pendingDefaultCodes.value);
  confirmRestoreOpen.value = false;
  toast.show(t('keymap.restoreDefaultSuccess', { n: restoreDiffCount.value }), 'success');
}
</script>

<template>
  <PageLayout :title="t('page.keymap')" keyboard>
    <template #keyboard-aside>
      <div class="kaside">
        <Segmented
          v-model="keymap.activeLayer"
          :options="layerOptions"
          :label="t('page.keymap')"
          size="sm"
        />
        <Button
          size="sm"
          variant="ghost"
          :disabled="keymap.loading"
          @click="checkRestoreDefault"
        >
          <IconRotateDot :size="15" />
          {{ t('keymap.restoreDefault') }}
        </Button>
      </div>
    </template>

    <template #keyboard>
      <KeyboardView
        :keys="device.keys"
        :legend="(k) => keymap.legendFor(k)"
        :sublabel="(k) => keymap.sublabelFor(k)"
        selectable
        :loading="keymap.loading"
      />
    </template>

    <div class="km-content">

      <div v-if="isFnSelected || keymap.fnNoticeTriggered" class="km-alert">
        <IconInfoCircle :size="16" stroke-width="1.8" class="km-alert__icon" />
        <span class="km-alert__text">{{ t('keymap.fnRuleNote') }}</span>
      </div>

      <Card v-if="sel.count > 0" class="km-picker-card">
        <KeyPicker :current="selectedCurrentCode" @pick="onPickKeycode" />
      </Card>
      <Card v-else class="km-empty-card">
        <p class="km-empty-text">{{ t('keymap.selectKeyPrompt') }}</p>
      </Card>
    </div>

    <Dialog
      v-model:open="confirmRestoreOpen"
      :title="t('keymap.restoreDefaultTitle')"
      :width="440"
    >
      <div class="km-dlg-body">
        <p>{{ t('keymap.restoreDefaultBody', { n: restoreDiffCount, layer: LAYER_NAMES[keymap.activeLayer] }) }}</p>
        <div class="km-dlg-actions">
          <Button variant="ghost" @click="confirmRestoreOpen = false">
            {{ t('keymap.restoreDefaultCancel') }}
          </Button>
          <Button variant="danger" @click="doRestoreDefault">
            {{ t('keymap.restoreDefaultConfirm', { n: restoreDiffCount }) }}
          </Button>
        </div>
      </div>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.kaside {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.km-content {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}
.km-alert {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: 10px 14px;
  background: var(--acc-soft);
  border: 1px solid var(--acc-line);
  border-radius: var(--r-control);
  color: var(--fg-1);
  font-size: var(--fs-label);
  line-height: 1.4;
}
.km-alert__icon {
  color: var(--acc);
  flex: none;
}
.km-alert__text {
  flex: 1;
}
.km-picker-card {
  padding: var(--s-4);
}
.km-empty-card {
  padding: var(--s-6);
  text-align: center;
  border-style: dashed;
}
.km-empty-text {
  color: var(--fg-3);
  font-size: var(--fs-body);
}
.km-dlg-body {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  color: var(--fg-2);
  line-height: 1.5;
}
.km-dlg-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-2);
}
</style>
