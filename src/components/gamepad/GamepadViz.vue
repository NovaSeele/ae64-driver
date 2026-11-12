<script setup lang="ts">
// One controller picture of the live test (DESIGN K §3.6): LT bar, both sticks, RT bar, numbers and the buttons held.
// Its accessible name is refreshed at most twice a second (no live region: it would be read out constantly).
import { onBeforeUnmount, ref, watch } from 'vue';
import { t } from '../../i18n/vi';

export interface VizState {
  /** −1…1, + is right / up. */
  lx: number; ly: number; rx: number; ry: number;
  /** 0…1. */
  lt: number; rt: number;
  /** Short names held (A, B, …, Back, Start, D↑ …). */
  buttons: readonly string[];
}

const props = defineProps<{ pane: string; state: VizState }>();

const ROWS = [['A', 'B', 'X', 'Y', 'LB', 'RB', 'L3', 'R3'], ['Back', 'Start', 'D↑', 'D↓', 'D←', 'D→']];
const f2 = (v: number) => v.toFixed(2);

const label = ref('');
let timer: ReturnType<typeof setTimeout> | null = null;
let last = 0;
function relabel(): void {
  const s = props.state;
  label.value = t('gp.vizLabel', {
    pane: props.pane, lx: f2(s.lx), ly: f2(s.ly), rx: f2(s.rx), ry: f2(s.ry),
    lt: Math.round(s.lt * 100), rt: Math.round(s.rt * 100), buttons: s.buttons.join(', ') || t('gp.none'),
  });
  last = Date.now();
}
watch(() => [props.state, props.pane], () => {
  const wait = 500 - (Date.now() - last);
  if (wait <= 0) relabel();
  else if (!timer) timer = setTimeout(() => { timer = null; relabel(); }, wait);
}, { immediate: true, deep: true });
onBeforeUnmount(() => { if (timer) clearTimeout(timer); });
</script>

<template>
  <div class="gpt__viz" role="img" :aria-label="label">
    <div class="gpt__axes">
      <div class="gpt__trig">
        <div class="gpt__bar"><span :style="{ height: `${state.lt * 100}%` }" /></div>
        <span class="gpt__lbl">LT</span><span class="gpt__num num">{{ Math.round(state.lt * 100) }}%</span>
      </div>
      <div v-for="s in [{ x: state.lx, y: state.ly, l: 'LS' }, { x: state.rx, y: state.ry, l: 'RS' }]" :key="s.l" class="gpt__stick">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="44" class="gpk__edge" />
          <line x1="6" x2="94" y1="50" y2="50" class="gpk__axis" />
          <line y1="6" y2="94" x1="50" x2="50" class="gpk__axis" />
          <circle :cx="50 + s.x * 44" :cy="50 - s.y * 44" r="7" class="gpt__dot" :class="{ 'gpt__dot--on': s.x || s.y }" />
        </svg>
        <span class="gpt__lbl">{{ s.l }}</span><span class="gpt__num num">{{ f2(s.x) }} · {{ f2(s.y) }}</span>
      </div>
      <div class="gpt__trig">
        <div class="gpt__bar"><span :style="{ height: `${state.rt * 100}%` }" /></div>
        <span class="gpt__lbl">RT</span><span class="gpt__num num">{{ Math.round(state.rt * 100) }}%</span>
      </div>
    </div>
    <div v-for="(row, r) in ROWS" :key="r" class="gpt__btns">
      <span v-for="b in row" :key="b" class="gpt__b" :class="{ 'gpt__b--on': state.buttons.includes(b) }">{{ b }}</span>
    </div>
  </div>
</template>
