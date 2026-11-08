<script setup lang="ts">
// Multi-Point Trigger editor: stages 1–2 required, stage 3 optional; depths strictly increasing in 0.1 mm
// steps up to the key's axisRangeMax (reference mpt.js). Every slider spans the full travel; values are
// clamped between their neighbours.
import { computed, ref } from 'vue';
import Slider from '../ui/Slider.vue';
import NumberField from '../ui/NumberField.vue';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import OutputSlot from './OutputSlot.vue';
import OutputPicker from './OutputPicker.vue';
import { MPT_STEP, mptBounds, mptGroups } from '../../stores/advanced';
import type { MptAssignment } from '../../stores/advanced';
import { t } from '../../i18n/vi';

const props = defineProps<{ modelValue: MptAssignment; max: number }>();
const emit = defineEmits<{ 'update:modelValue': [MptAssignment] }>();

const STAGE_COLORS = ['var(--acc)', 'var(--info)', 'var(--warn)'];
const groups = mptGroups();
const pickerStage = ref<number | null>(null);
const pickerOpen = computed({ get: () => pickerStage.value !== null, set: (v) => { if (!v) pickerStage.value = null; } });

function update(patch: Partial<MptAssignment>) {
  emit('update:modelValue', { ...props.modelValue, ...patch });
}
function setDepth(i: number, v: number) {
  const b = mptBounds(i, props.modelValue.depths, props.max);
  const depths = [...props.modelValue.depths] as MptAssignment['depths'];
  depths[i] = Math.round(Math.min(b.max, Math.max(b.min, v)) * 10) / 10;
  if (depths[i] !== props.modelValue.depths[i]) update({ depths });
}
function pick(code: number) {
  const keycodes = [...props.modelValue.keycodes] as MptAssignment['keycodes'];
  keycodes[pickerStage.value!] = code;
  update({ keycodes });
  pickerStage.value = null;
}
function clearStage3() {
  update({ keycodes: [props.modelValue.keycodes[0], props.modelValue.keycodes[1], 0] });
  pickerStage.value = null;
}
const used = computed(() => props.modelValue.keycodes.filter((c, i) => c && i !== pickerStage.value));
const pct = (v: number) => `${(v / props.max) * 100}%`;
</script>

<template>
  <div class="mpt">
    <div class="mpt__track" aria-hidden="true">
      <div class="mpt__rail" />
      <div
        v-for="(d, i) in modelValue.depths"
        :key="i"
        class="mpt__pin"
        :class="{ 'mpt__pin--off': !modelValue.keycodes[i] }"
        :style="{ left: pct(d), '--pin': STAGE_COLORS[i] }"
      >
        <span class="mpt__pinlabel num">{{ d.toFixed(1) }}</span>
      </div>
      <span class="mpt__end num">0</span>
      <span class="mpt__end mpt__end--max num">{{ max.toFixed(1) }} mm</span>
    </div>

    <div v-for="(d, i) in modelValue.depths" :key="i" class="stage" :class="{ 'stage--off': !modelValue.keycodes[i] }" :style="{ '--pin': STAGE_COLORS[i] }">
      <div class="stage__idx">
        <span class="stage__num num">0{{ i + 1 }}</span>
        <span class="stage__req micro">{{ i < 2 ? t('advanced.mptRequired') : t('advanced.mptOptional') }}</span>
      </div>
      <OutputSlot :code="modelValue.keycodes[i]" :accent="STAGE_COLORS[i]" :caption="t('advanced.mptStage', { n: i + 1 })" @click="pickerStage = i" />
      <div class="stage__depth">
        <div class="stage__row">
          <span class="stage__label">{{ t('advanced.mptDepth') }}</span>
          <NumberField
            :model-value="d"
            :min="mptBounds(i, modelValue.depths, max).min"
            :max="mptBounds(i, modelValue.depths, max).max"
            :step="MPT_STEP"
            :decimals="1"
            :label="t('advanced.mptStage', { n: i + 1 })"
            @update:model-value="setDepth(i, $event)"
          />
        </div>
        <Slider :model-value="d" :min="0.1" :max="max" :step="MPT_STEP" :fine-step="MPT_STEP" :label="t('advanced.mptStage', { n: i + 1 })" @update:model-value="setDepth(i, $event)" />
      </div>
    </div>
    <p class="hint num">{{ t('advanced.mptRange', { max: max.toFixed(1) }) }}</p>

    <Dialog v-model:open="pickerOpen" :title="t('advanced.pickerTitle')" :width="620">
      <OutputPicker
        v-if="pickerStage !== null"
        :groups="groups"
        :current="modelValue.keycodes[pickerStage]"
        :disabled-codes="used"
        :note="t('advanced.pickerOnly', { type: 'MPT' })"
        :clear-label="pickerStage === 2 ? t('advanced.mptClear') : undefined"
        @pick="pick"
        @clear="clearStage3"
      />
    </Dialog>
    <Button v-if="modelValue.keycodes[2]" class="mpt__clear" variant="ghost" size="sm" @click="clearStage3">{{ t('advanced.mptClear') }}</Button>
  </div>
</template>

<style scoped>
.mpt { display: flex; flex-direction: column; gap: var(--s-3); }
.mpt__track { position: relative; height: 54px; margin: 0 var(--s-4) var(--s-2); }
.mpt__rail {
  position: absolute;
  left: 0;
  right: 0;
  top: 30px;
  height: 6px;
  border-radius: 3px;
  background: linear-gradient(90deg, var(--bg-3), var(--bg-4));
  border: 1px solid var(--line-1);
}
.mpt__pin {
  position: absolute;
  top: 24px;
  width: 4px;
  height: 18px;
  margin-left: -2px;
  border-radius: 2px;
  background: var(--pin);
  box-shadow: 0 0 10px color-mix(in srgb, var(--pin) 40%, transparent);
  transition: left var(--t-med) var(--ease);
}
.mpt__pin--off { background: var(--fg-4); box-shadow: none; }
.mpt__pinlabel { position: absolute; bottom: 22px; left: 50%; transform: translateX(-50%); font-size: var(--fs-caption); font-weight: 600; color: var(--fg-1); white-space: nowrap; }
.mpt__pin--off .mpt__pinlabel { color: var(--fg-4); }
.mpt__end { position: absolute; top: 40px; left: 0; font-size: 10px; color: var(--fg-3); }
.mpt__end--max { left: auto; right: 0; }

.stage {
  display: grid;
  grid-template-columns: 72px 132px 1fr;
  gap: var(--s-4);
  align-items: center;
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-card);
  border: 1px solid var(--line-1);
  background: var(--bg-1);
  border-left: 3px solid var(--pin);
  transition: opacity var(--t-fast) var(--ease);
}
.stage--off { border-left-color: var(--line-3); }
.stage--off .stage__depth { opacity: 0.5; }
.stage__idx { display: flex; flex-direction: column; gap: 2px; }
.stage__num { font-size: var(--fs-hero); font-weight: 600; color: var(--fg-1); line-height: 1; }
.stage__req { color: var(--fg-3); }
.stage :deep(.os) { width: 132px; }
.stage__depth { display: flex; flex-direction: column; gap: var(--s-2); min-width: 0; }
.stage__row { display: flex; align-items: center; justify-content: space-between; gap: var(--s-3); }
.stage__label { color: var(--fg-2); }
.stage__row :deep(.nf) { width: 120px; }
.hint { color: var(--fg-3); font-size: var(--fs-label); }
.mpt__clear { align-self: flex-start; }
</style>
