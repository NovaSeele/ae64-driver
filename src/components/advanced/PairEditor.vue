<script setup lang="ts">
// SOCD / Rappy Snappy pair editor: Key A / Key B slots (picked on the keyboard), their outputs,
// SOCD resolution mode (4 reciprocal modes) and the 0–50 ms delay.
import { computed, ref } from 'vue';
import { IconSwitchHorizontal } from '@tabler/icons-vue';
import NumberField from '../ui/NumberField.vue';
import Dialog from '../ui/Dialog.vue';
import OutputSlot from './OutputSlot.vue';
import OutputPicker from './OutputPicker.vue';
import { PAIR_DELAY, keyboardGroups } from '../../stores/advanced';
import type { RsAssignment, SocdAssignment, SocdMode } from '../../stores/advanced';
import { t } from '../../i18n/vi';
import type { MessageKey } from '../../i18n/vi';

type Pair = SocdAssignment | RsAssignment;
const props = defineProps<{ modelValue: Pair; slot: 0 | 1; keyName: (id: number) => string }>();
const emit = defineEmits<{ 'update:modelValue': [Pair]; 'update:slot': [0 | 1] }>();

const SOCD_MODES: { value: SocdMode; label: MessageKey; desc: MessageKey }[] = [
  { value: 0, label: 'advanced.socdLast', desc: 'advanced.socdLastDesc' },
  { value: 1, label: 'advanced.socdA', desc: 'advanced.socdADesc' },
  { value: 2, label: 'advanced.socdB', desc: 'advanced.socdBDesc' },
  { value: 3, label: 'advanced.socdNeutral', desc: 'advanced.socdNeutralDesc' },
];
const groups = keyboardGroups();
const pickerSide = ref<number | null>(null);
const pickerOpen = computed({ get: () => pickerSide.value !== null, set: (v) => { if (!v) pickerSide.value = null; } });

function update(patch: Partial<Pair>) {
  emit('update:modelValue', { ...props.modelValue, ...patch } as Pair);
}
function pick(code: number) {
  const keycodes: [number, number] = [...props.modelValue.keycodes];
  keycodes[pickerSide.value!] = code;
  update({ keycodes });
  pickerSide.value = null;
}
function swap() {
  const [a, b] = props.modelValue.keys;
  const [ka, kb] = props.modelValue.keycodes;
  const patch: Partial<SocdAssignment> = { keys: [b, a], keycodes: [kb, ka] };
  if (props.modelValue.type === 'SOCD' && (props.modelValue.mode === 1 || props.modelValue.mode === 2)) patch.mode = props.modelValue.mode === 1 ? 2 : 1;
  update(patch);
}
const sides = computed(() => [0, 1].map((i) => ({
  i: i as 0 | 1,
  id: props.modelValue.keys[i],
  title: i === 0 ? t('advanced.keyA') : t('advanced.keyB'),
  output: i === 0 ? t('advanced.outputA') : t('advanced.outputB'),
})));
</script>

<template>
  <div class="pair">
    <div class="pair__slots">
      <template v-for="(s, n) in sides" :key="s.i">
        <button v-if="n === 1" type="button" class="pair__swap" :title="t('advanced.swap')" :aria-label="t('advanced.swap')" :disabled="modelValue.keys.some((k) => k < 0)" @click="swap">
          <IconSwitchHorizontal :size="18" stroke-width="1.6" />
        </button>
        <div class="side" :class="{ 'side--active': slot === s.i }" role="button" tabindex="0" :aria-pressed="slot === s.i" @click="emit('update:slot', s.i)" @keydown.enter.space.prevent="emit('update:slot', s.i)">
          <span class="side__badge">{{ s.i === 0 ? 'A' : 'B' }}</span>
          <div class="side__body">
            <span class="micro side__title">{{ s.title }}</span>
            <span class="side__key" :class="{ 'side__key--empty': s.id < 0 }">{{ s.id >= 0 ? keyName(s.id) : t('advanced.notChosen') }}</span>
          </div>
          <OutputSlot :code="modelValue.keycodes[s.i]" :caption="s.output" :accent="s.i === 0 ? 'var(--acc)' : 'var(--info)'" :disabled="s.id < 0" @click.stop="pickerSide = s.i" />
        </div>
      </template>
    </div>

    <div v-if="modelValue.type === 'SOCD'" class="modes" role="radiogroup" :aria-label="t('advanced.socdMode')">
      <span class="micro modes__label">{{ t('advanced.socdMode') }}</span>
      <div class="modes__grid">
        <button
          v-for="m in SOCD_MODES"
          :key="m.value"
          type="button"
          role="radio"
          class="mode"
          :aria-checked="modelValue.mode === m.value"
          @click="update({ mode: m.value })"
        >
          <span class="mode__name">{{ t(m.label) }}</span>
          <span class="mode__desc">{{ t(m.desc) }}</span>
        </button>
      </div>
    </div>
    <ol v-else class="rs">
      <li><span class="num">01</span>{{ t('advanced.rsPrinciple1') }}</li>
      <li><span class="num">02</span>{{ t('advanced.rsPrinciple2') }}</li>
    </ol>

    <div class="delay">
      <div>
        <span class="delay__label">{{ t('advanced.delay') }}</span>
        <p class="hint">{{ t('advanced.delayHint') }}</p>
      </div>
      <NumberField
        :model-value="modelValue.delay"
        :min="PAIR_DELAY.min"
        :max="PAIR_DELAY.max"
        :step="1"
        :decimals="0"
        unit="ms"
        :label="t('advanced.delay')"
        @update:model-value="update({ delay: Math.round($event) })"
      />
    </div>

    <Dialog v-model:open="pickerOpen" :title="t('advanced.pickerTitle')" :width="620">
      <OutputPicker
        v-if="pickerSide !== null"
        :groups="groups"
        :current="modelValue.keycodes[pickerSide]"
        :note="t('advanced.pickerOnly', { type: modelValue.type === 'SOCD' ? 'SOCD' : 'Rappy Snappy' })"
        @pick="pick"
      />
    </Dialog>
  </div>
</template>

<style scoped>
.pair { display: flex; flex-direction: column; gap: var(--s-5); }
.pair__slots { display: grid; grid-template-columns: 1fr auto 1fr; gap: var(--s-3); align-items: center; }
.pair__swap {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border-radius: 50%;
  border: 1px solid var(--line-2);
  background: var(--bg-3);
  color: var(--fg-2);
  transition: all var(--t-fast) var(--ease);
}
.pair__swap:hover:not(:disabled) { color: var(--acc); border-color: var(--acc-line); }
.pair__swap:disabled { opacity: 0.4; }
.side {
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-radius: var(--r-card);
  border: 1px solid var(--line-1);
  background: var(--bg-1);
  cursor: pointer;
  transition: border-color var(--t-fast) var(--ease), background var(--t-fast) var(--ease), box-shadow var(--t-fast) var(--ease);
}
.side:hover { border-color: var(--line-3); }
.side--active { border-color: var(--acc-line); background: var(--acc-soft); box-shadow: var(--focus-ring); }
.side__badge {
  width: 30px;
  height: 30px;
  flex: none;
  display: grid;
  place-items: center;
  border-radius: 8px;
  font-weight: 700;
  background: var(--bg-3);
  color: var(--fg-1);
}
.side--active .side__badge { background: var(--acc); color: var(--on-acc); }
.side__body { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.side__title { color: var(--fg-3); }
.side__key { font-size: var(--fs-section); font-weight: 600; color: var(--fg-1); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.side__key--empty { color: var(--fg-3); font-size: var(--fs-body); font-weight: 500; }

.modes { display: flex; flex-direction: column; gap: var(--s-2); }
.modes__label { color: var(--fg-3); }
.modes__grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: var(--s-2); }
.mode {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.mode:hover { border-color: var(--line-3); }
.mode[aria-checked='true'] { background: var(--acc-soft); border-color: var(--acc-line); }
.mode__name { font-weight: 600; }
.mode[aria-checked='true'] .mode__name { color: var(--acc); }
.mode__desc { font-size: var(--fs-label); color: var(--fg-3); }

.rs { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s-2); list-style: none; padding: 0; margin: 0; }
.rs li { display: flex; gap: var(--s-3); padding: 10px 12px; border-radius: var(--r-control); background: var(--bg-1); border: 1px solid var(--line-1); color: var(--fg-2); }
.rs .num { color: var(--acc); font-weight: 600; }

.delay { display: flex; align-items: center; justify-content: space-between; gap: var(--s-4); }
.delay__label { color: var(--fg-2); }
.delay :deep(.nf) { width: 132px; }
.hint { color: var(--fg-3); font-size: var(--fs-label); margin: 2px 0 0; }

@media (max-width: 1100px) {
  .modes__grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
