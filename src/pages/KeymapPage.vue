<script setup lang="ts">
// Keymap page: layer tabs Main/Fn1/Fn2/Fn3, RAKKA-style layout, KeyPicker, Fn release guard rule.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconAlertTriangle, IconInfoCircle, IconRefresh, IconRotateDot } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import type { LegendItem } from '../components/keyboard/SelectionBar.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import KeyPicker from '../components/ui/KeyPicker.vue';
import Segmented from '../components/ui/Segmented.vue';
import Button from '../components/ui/Button.vue';
import Card from '../components/ui/Card.vue';
import Dialog from '../components/ui/Dialog.vue';
import { useToast } from '../components/ui/toast';
import { useDeviceStore } from '../stores/device';
import { useSelectionStore } from '../stores/selection';
import { BULK_CONFIRM_KEYS, LAYER_NAMES, isFnSwitch, needsAssignConfirm, useKeymapStore } from '../stores/keymap';
import type { DefaultDiff, FactoryKey, LayerIndex } from '../stores/keymap';
import { FIRMWARE_ROWS, LAYER_COUNT, keycodeLabel } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const sel = useSelectionStore();
const keymap = useKeymapStore();
const toast = useToast();

// Restore-default: the layer and diff are captured at click time and used for dialog and write alike.
const confirmRestoreOpen = ref(false);
const restoreLayer = ref<LayerIndex>(0);
const restoreDiff = ref<DefaultDiff | null>(null);

// Assignment that needs confirmation (more than 8 keys, or overwrites factory keys).
const confirmAssignOpen = ref(false);
const pending = ref<{ ids: number[]; code: number; changed: number; factory: FactoryKey[] } | null>(null);

let offProfile: (() => void) | null = null;
onMounted(() => {
  void keymap.load();
  offProfile = device.onProfileChanged(() => void keymap.load(true));
});
onBeforeUnmount(() => offProfile?.());

const readOnly = computed(() => !device.boardAllowed);
const ready = computed(() => !keymap.loading && !keymap.loadError && keymap.loadedProfile === device.activeProfile);

const LAYER_LABEL = ['keymap.layerMain', 'keymap.layerFn1', 'keymap.layerFn2', 'keymap.layerFn3'] as const;
/** Selection bar "Keycap: …" (DESIGN B §3.4): the function on the layer shown; ▽ and — only while some key has them. */
function legendFor(layer: LayerIndex): LegendItem[] | undefined {
  if (!ready.value) return undefined;
  const codes = keymap.values[layer] ?? [];
  const items: LegendItem[] = [{ text: t('keymap.shows', { layer: t(LAYER_LABEL[layer]) }) }];
  if (device.keys.some((k) => codes[k.id] === 0x0001)) items.push({ glyph: '▽', text: t('keymap.showsTrans') });
  if (device.keys.some((k) => codes[k.id] === 0x0000)) items.push({ glyph: '—', text: t('keymap.showsNone') });
  return items;
}
const shows = computed(() => legendFor(keymap.activeLayer));
/** The other layers' legends: switching the layer keeps the bar's row count. */
const showsAlt = computed(() => ([0, 1, 2, 3] as LayerIndex[]).filter((l) => l !== keymap.activeLayer).map(legendFor).filter((l): l is LegendItem[] => !!l));
const totalRows = LAYER_COUNT * FIRMWARE_ROWS.length;

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

function codeText(code: number): string {
  return code === 0 ? '—' : code === 1 ? '▽' : keycodeLabel(code).label;
}

const editingLabel = computed(() => {
  const keys = sel.ids.length === 1 ? (device.keys[sel.ids[0]]?.name ?? '') : t('keymap.keysCount', { n: sel.ids.length });
  return t('keymap.editing', { layer: LAYER_NAMES[keymap.activeLayer], keys });
});
const currentText = computed(() =>
  t('keymap.currentValue', {
    value: selectedCurrentCode.value === null ? t('keymap.mixed') : codeText(selectedCurrentCode.value),
  }),
);

const isFnSelected = computed(() => {
  if (!sel.ids.length) return false;
  const currentL = keymap.activeLayer;
  return sel.ids.some((id) => isFnSwitch(keymap.values[currentL]?.[id] ?? 0));
});

function factoryName(k: FactoryKey): string {
  return t('keymap.factoryItem', {
    layer: LAYER_NAMES[k.layer],
    key: device.keys[k.id]?.name ?? String(k.id),
    code: keycodeLabel(k.code).label,
  });
}
const factoryList = computed(() => keymap.factoryKeys.map(factoryName));
/** A selected key holds a factory keycode on the layer shown: assigning to it would lose that function. */
const factorySelected = computed(() => {
  if (!sel.ids.length) return false;
  const ids = new Set(sel.ids);
  return keymap.factoryKeys.some((k) => k.layer === keymap.activeLayer && ids.has(k.id));
});

function assign(ids: number[], code: number) {
  const { fnGuarded } = keymap.applyKeycode(ids, code);
  if (fnGuarded) {
    toast.show(t('keymap.fnGuardedApplied'), 'info');
  }
}

function onPickKeycode(code: number) {
  if (!ready.value || readOnly.value || !sel.ids.length) return;
  const ids = [...sel.ids];
  const plan = keymap.planKeycode(ids, code);
  const changed = Object.keys(plan.after).length;
  if (!changed) return;
  if (needsAssignConfirm(changed, plan.factoryLost)) {
    pending.value = { ids, code, changed, factory: plan.factoryLost };
    confirmAssignOpen.value = true;
    return;
  }
  assign(ids, code);
}

function doAssign() {
  const p = pending.value;
  confirmAssignOpen.value = false;
  pending.value = null;
  if (p) assign(p.ids, p.code);
}

async function checkRestoreDefault() {
  if (!ready.value || readOnly.value) return;
  const layer = keymap.activeLayer;
  try {
    const diff = await keymap.computeDefaultDiff(layer);
    if (diff.diffCount === 0) {
      toast.show(diff.skipped ? t('keymap.restoreDefaultSkipped', { n: diff.skipped }) : t('keymap.restoreDefaultNone'), 'info');
      return;
    }
    restoreLayer.value = layer;
    restoreDiff.value = diff;
    confirmRestoreOpen.value = true;
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  }
}

function doRestoreDefault() {
  const diff = restoreDiff.value;
  confirmRestoreOpen.value = false;
  restoreDiff.value = null;
  if (!diff) return;
  const written = keymap.applyDefault(restoreLayer.value, diff.defaultCodes);
  if (!written) {
    toast.show(t('keymap.restoreDefaultNothingWritten'), 'warn');
  } else if (diff.skipped) {
    toast.show(t('keymap.restoreDefaultSuccessSkipped', { n: written, skipped: diff.skipped }), 'success');
  } else {
    toast.show(t('keymap.restoreDefaultSuccess', { n: written }), 'success');
  }
}
</script>

<template>
  <PageLayout :title="t('page.keymap')" keyboard :shows="shows" :shows-alt="showsAlt">
    <template #keyboard-aside>
      <div class="kaside">
        <Segmented
          v-model="keymap.activeLayer"
          class="kaside__layers"
          :options="layerOptions"
          :label="t('page.keymap')"
          size="sm"
        />
        <Button
          size="sm"
          variant="ghost"
          class="kaside__restore"
          :disabled="!ready || readOnly"
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
        :legend="(k) => (keymap.loadError ? '' : keymap.legendFor(k))"
        :sublabel="(k) => keymap.sublabelFor(k)"
        selectable
        :loading="keymap.loading"
      />
    </template>

    <div class="km-content">
      <p v-if="readOnly" class="km-warn">{{ t('keymap.readOnly') }}</p>

      <Card v-if="keymap.loadError" :title="t('keymap.loadFailed')" :subtitle="keymap.loadError">
        <div><Button :icon="IconRefresh" :loading="keymap.loading" @click="keymap.load(true)">{{ t('keymap.reload') }}</Button></div>
      </Card>

      <Card v-else-if="keymap.loading" class="km-picker-card" aria-busy="true">
        <p class="km-empty-text num">{{ t('keymap.loading', { n: keymap.loadedCount, total: totalRows }) }}</p>
        <div class="skeleton" style="width: 40%; height: 14px; margin-top: 12px" />
        <div class="skeleton" style="width: 100%; height: 120px; margin-top: 12px" />
      </Card>

      <template v-else>
        <div v-if="isFnSelected" class="km-alert">
          <IconInfoCircle :size="16" stroke-width="1.8" class="km-alert__icon" />
          <span class="km-alert__text">{{ t('keymap.fnRuleNote') }}</span>
        </div>

        <div v-if="factoryList.length && (isFnSelected || factorySelected)" class="km-factory" role="note">
          <IconAlertTriangle :size="16" stroke-width="1.8" class="km-factory__icon" />
          <div>
            <strong>{{ t('keymap.factoryListTitle') }}</strong>
            <ul class="km-factory__list">
              <li v-for="name in factoryList" :key="name" class="num">{{ name }}</li>
            </ul>
            <span class="km-factory__hint">{{ t('keymap.factoryListHint') }}</span>
          </div>
        </div>

        <Card v-if="sel.count > 0" class="km-picker-card">
          <fieldset class="km-fieldset" :disabled="readOnly">
            <div class="km-head">
              <strong class="km-head__title">{{ editingLabel }}</strong>
              <span class="km-head__cur num">{{ currentText }}</span>
            </div>
            <div class="km-quick">
              <Button size="sm" :disabled="readOnly" :title="t('keymap.transparentHintShort')" @click="onPickKeycode(0x0001)">
                ▽ {{ t('keymap.quickTransparent') }}
              </Button>
              <Button size="sm" :disabled="readOnly" :title="t('keymap.emptyHintShort')" @click="onPickKeycode(0x0000)">
                — {{ t('keymap.quickEmpty') }}
              </Button>
              <span class="km-quick__hint">{{ t('keymap.transparentHintShort') }} {{ t('keymap.emptyHintShort') }}</span>
            </div>
            <KeyPicker :current="selectedCurrentCode" @pick="onPickKeycode" />
          </fieldset>
        </Card>
        <Card v-else class="km-empty-card">
          <p class="km-empty-text">{{ t('keymap.selectKeyPrompt') }}</p>
        </Card>
      </template>
    </div>

    <Dialog
      v-model:open="confirmRestoreOpen"
      :title="t('keymap.restoreDefaultTitle')"
      :width="440"
    >
      <div v-if="restoreDiff" class="km-dlg-body">
        <p>{{ t('keymap.restoreDefaultBody', { n: restoreDiff.diffCount, layer: LAYER_NAMES[restoreLayer] }) }}</p>
        <p v-if="restoreDiff.skipped">{{ t('keymap.restoreDefaultSkipped', { n: restoreDiff.skipped }) }}</p>
        <p v-if="restoreDiff.factoryLost.length" class="km-warn">
          {{ t('keymap.assignFactory', {
            n: restoreDiff.factoryLost.length,
            keys: restoreDiff.factoryLost.map((id) => device.keys[id]?.name ?? id).join(', '),
          }) }}
        </p>
        <div class="km-dlg-actions">
          <Button variant="ghost" @click="confirmRestoreOpen = false">
            {{ t('keymap.restoreDefaultCancel') }}
          </Button>
          <Button variant="danger" @click="doRestoreDefault">
            {{ t('keymap.restoreDefaultConfirm', { n: restoreDiff.diffCount }) }}
          </Button>
        </div>
      </div>
    </Dialog>

    <Dialog v-model:open="confirmAssignOpen" :title="t('keymap.assignTitle')" :width="440">
      <div v-if="pending" class="km-dlg-body">
        <p v-if="pending.changed > BULK_CONFIRM_KEYS">
          {{ t('keymap.assignBulk', { code: codeText(pending.code), n: pending.changed }) }}
        </p>
        <p v-if="pending.factory.length" class="km-warn">
          {{ t('keymap.assignFactory', { n: pending.factory.length, keys: pending.factory.map(factoryName).join(', ') }) }}
        </p>
        <div class="km-dlg-actions">
          <Button variant="ghost" @click="confirmAssignOpen = false">
            {{ t('keymap.restoreDefaultCancel') }}
          </Button>
          <Button variant="danger" @click="doAssign">
            {{ t('keymap.assignConfirm') }}
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
.kaside__layers {
  width: 100%;
}
.kaside .kaside__restore {
  max-width: 100%;
  height: auto;
  min-height: 28px;
  padding-block: 4px;
  white-space: normal;
  text-align: left;
}
.kaside__layers :deep(.seg__opt) {
  flex: 1;
  padding: 0 6px;
}
.km-warn {
  color: var(--warn);
  font-size: var(--fs-label);
}
.km-factory {
  display: flex;
  gap: var(--s-3);
  padding: 10px 14px;
  background: var(--warn-soft);
  border: 1px solid var(--warn);
  border-radius: var(--r-control);
  color: var(--fg-1);
  font-size: var(--fs-label);
  line-height: 1.4;
}
.km-factory__icon {
  color: var(--warn);
  flex: none;
  margin-top: 2px;
}
.km-factory__list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-1) var(--s-3);
  margin: 4px 0;
  padding: 0;
  list-style: none;
}
.km-factory__hint {
  color: var(--fg-3);
}
.km-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  min-width: 0;
}
.km-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--s-3);
  margin-bottom: var(--s-2);
}
.km-head__title {
  color: var(--fg-1);
}
.km-head__cur {
  color: var(--fg-3);
  font-size: var(--fs-label);
}
.km-quick {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--s-2);
  margin-bottom: var(--s-3);
}
.km-quick__hint {
  color: var(--fg-3);
  font-size: var(--fs-label);
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
