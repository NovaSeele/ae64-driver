<script setup lang="ts">
// "Cài đặt cần" card (DESIGN K §3.5, §5.3): both sticks side by side. Dead zone (Slider + %), gate (round / square; the
// square one has no dead zone), and what happens when opposite directions are held.
import { computed } from 'vue';
import Card from '../ui/Card.vue';
import NumberField from '../ui/NumberField.vue';
import Segmented from '../ui/Segmented.vue';
import Slider from '../ui/Slider.vue';
import { GP_DEADZONE_MAX } from '../../protocol/gamepad';
import type { GpOpposition } from '../../protocol/gamepad';
import { useGamepadStore } from '../../stores/gamepad';
import { t } from '../../i18n/vi';

/** Current stick positions (−1…1, + is right / up), drawn as the dot in the gate. */
const props = defineProps<{ positions: readonly [[number, number], [number, number]] }>();

const gp = useGamepadStore();
const MAX_PCT = GP_DEADZONE_MAX / 100;

const sticks = computed(() => ([0, 1] as const).map((i) => {
  const s = gp.config?.sticks[i] ?? { circular: true, opposition: 'difference' as GpOpposition, deadzone: 0 };
  const name = t(i ? 'gp.gRight' : 'gp.gLeft');
  return { i, s, name, group: i ? 'rstick' : 'lstick', pct: s.deadzone / 100 };
}));

let dragSeq = 0;
let dragKey = '';
/** A typed value: its own undo step; the next slide starts a new one. */
function setDeadzone(i: 0 | 1, pct: number): void {
  dragKey = '';
  gp.setStick(i, { deadzone: Math.round(pct * 100) });
}
/** A slide (pointer or keys): one undo step per gesture, closed by the Slider's commit. */
function onSlide(i: 0 | 1, pct: number): void {
  if (!dragKey.startsWith(`deadzone:${i}:`)) dragKey = `deadzone:${i}:${++dragSeq}`;
  gp.setStick(i, { deadzone: Math.round(pct * 100) }, dragKey);
}
function endSlide(): void {
  dragKey = '';
}

const shapeOptions = computed(() => [{ value: 'round' as const, label: t('gp.round') }, { value: 'square' as const, label: t('gp.square') }]);
const oppOptions = computed(() => [
  { value: 'difference' as const, label: t('gp.oppDifference'), title: t('gp.oppDifferenceDesc') },
  { value: 'neutral' as const, label: t('gp.oppNeutral'), title: t('gp.oppNeutralDesc') },
  { value: 'deeper' as const, label: t('gp.oppDeeper'), title: t('gp.oppDeeperDesc') },
]);
const oppDesc = (o: GpOpposition) => t(o === 'neutral' ? 'gp.oppNeutralDesc' : o === 'deeper' ? 'gp.oppDeeperDesc' : 'gp.oppDifferenceDesc');

const R = 40;
const C = 50;
</script>

<template>
  <Card class="gpk" :title="t('gp.stick')" :subtitle="t('gp.stickSub')">
    <div class="gpk__halves">
      <div v-for="st in sticks" :key="st.i" class="gpk__half" role="group" :aria-labelledby="`gp-gk-${st.group}`" :style="{ '--g': `var(--g-${st.group})` }">
        <h4 :id="`gp-gk-${st.group}`" class="gpo__gh"><span class="gpo__dot" aria-hidden="true" />{{ st.name }}</h4>
        <div class="gpk__body">
          <svg class="gpk__gate" viewBox="0 0 100 100" role="img" :aria-label="t('gp.gatePreview', { stick: st.name.toLowerCase(), shape: t(st.s.circular ? 'gp.round' : 'gp.square').toLowerCase(), dz: st.pct.toFixed(2) })">
            <circle v-if="st.s.circular" :cx="C" :cy="C" :r="R" class="gpk__edge" />
            <rect v-else :x="C - R" :y="C - R" :width="2 * R" :height="2 * R" rx="3" class="gpk__edge" />
            <line :x1="C - R" :x2="C + R" :y1="C" :y2="C" class="gpk__axis" />
            <line :y1="C - R" :y2="C + R" :x1="C" :x2="C" class="gpk__axis" />
            <circle v-if="st.s.deadzone" :cx="C" :cy="C" :r="(st.s.deadzone / 10000) * R" class="gpk__dz" />
            <circle :cx="C + props.positions[st.i][0] * R" :cy="C - props.positions[st.i][1] * R" r="5" class="gpk__dot" />
          </svg>
          <div class="gpk__ctl">
            <div class="gpc__f">
              <span class="gps__label" aria-hidden="true">{{ t('gp.deadzone') }}</span>
              <div class="gpk__dzrow">
                <Slider
                  :model-value="st.pct" :min="0" :max="MAX_PCT" :step="0.5" :fine-step="0.01" :disabled="!st.s.circular"
                  :label="`${t('gp.deadzone')} · ${st.name}`" :format="(v: number) => `${v.toFixed(2)}%`"
                  @update:model-value="onSlide(st.i, $event)" @commit="endSlide"
                />
                <NumberField
                  :model-value="st.pct" :min="0" :max="MAX_PCT" :step="0.5" unit="%" :disabled="!st.s.circular"
                  :label="`${t('gp.deadzone')} · ${st.name}`" @update:model-value="setDeadzone(st.i, $event)"
                />
              </div>
              <p class="gps__desc">{{ t(st.s.circular ? 'gp.deadzoneDesc' : 'gp.squareNote') }}</p>
            </div>
            <div class="gpk__pair">
              <div class="gpc__f">
                <span class="gps__label" aria-hidden="true">{{ t('gp.shape') }}</span>
                <Segmented
                  :model-value="st.s.circular ? 'round' : 'square'" :options="shapeOptions" :label="`${t('gp.shape')} · ${st.name}`" size="sm"
                  @update:model-value="gp.setStick(st.i, { circular: $event === 'round' })"
                />
              </div>
              <div class="gpc__f">
                <span class="gps__label" aria-hidden="true">{{ t('gp.opposite') }}</span>
                <Segmented
                  :model-value="st.s.opposition" :options="oppOptions" :label="`${t('gp.opposite')} · ${st.name}`" size="sm"
                  @update:model-value="$event && gp.setStick(st.i, { opposition: $event })"
                />
              </div>
            </div>
            <p class="gps__desc">{{ oppDesc(st.s.opposition) }}</p>
          </div>
        </div>
      </div>
    </div>
  </Card>
</template>
