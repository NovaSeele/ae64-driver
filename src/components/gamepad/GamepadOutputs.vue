<script setup lang="ts">
// "Đầu ra tay cầm" card (DESIGN K §3.3, §5.1, §7): 24 output tiles in five groups shaped like a controller. Exactly one
// key selected → a tile assigns it; otherwise a tile arms ("press a key"). Each group is one Tab stop (roving tabindex).
import { nextTick, reactive } from 'vue';
import { IconEraser, IconWand } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import Card from '../ui/Card.vue';
import OutputTile from './OutputTile.vue';
import { useDeviceStore } from '../../stores/device';
import { useGamepadStore } from '../../stores/gamepad';
import { useSelectionStore } from '../../stores/selection';
import { t } from '../../i18n/vi';
import { useGamepadActions } from './actions';
import { GROUPS, groupTitle, keyLegend, longNameOf } from './outputs';
import type { GpGroup, TileSpec } from './outputs';

const props = defineProps<{
  /** Record indices of the outputs of the selected keys. */
  current: readonly number[];
  /** Selected keys as record key indices. */
  selectedKeys: readonly number[];
}>();
const armed = defineModel<number | null>('armed', { required: true });
const emit = defineEmits<{ armedByKeyboard: [] }>();

const gp = useGamepadStore();
const device = useDeviceStore();
const sel = useSelectionStore();
const actions = useGamepadActions();

/** Roving tab stop of each group (the tile index inside the group). */
const stop = reactive<Record<GpGroup, number>>({ lstick: 0, rstick: 0, trigger: 0, button: 0, dpad: 0 });

const keyOf = (index: number): number | null => gp.config?.bindings[index]?.key ?? null;
const legendOf = (index: number): string | null => {
  const k = keyOf(index);
  return k === null ? null : keyLegend(device, k);
};

function ariaOf(spec: TileSpec): string {
  const out = longNameOf(spec.index);
  if (armed.value === spec.index) return t('gp.armed', { out });
  if (props.selectedKeys.length === 1) return t('gp.tileAssign', { out, key: keyLegend(device, props.selectedKeys[0]) });
  return t('gp.tileArm', { out, key: legendOf(spec.index) ?? t('gp.unassigned') });
}

function activate(spec: TileSpec, e: MouseEvent | KeyboardEvent): void {
  if (props.selectedKeys.length === 1) {
    armed.value = null;
    actions.assign(spec.index, props.selectedKeys[0]);
    return;
  }
  armed.value = armed.value === spec.index ? null : spec.index;
  // A keyboard user goes on to the keyboard (click from Enter / Space has detail 0); a mouse user keeps focus.
  if (armed.value !== null && (e instanceof KeyboardEvent || e.detail === 0)) emit('armedByKeyboard');
}

function onKey(e: KeyboardEvent, group: GpGroup, tiles: TileSpec[], i: number): void {
  const last = tiles.length - 1;
  const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % tiles.length
    : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + last) % tiles.length
      : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
  if (next < 0) return;
  e.preventDefault();
  stop[group] = next;
  void nextTick(() => document.querySelector<HTMLElement>(`[data-gp-tile="${tiles[next].index}"]`)?.focus());
}

function tileProps(group: GpGroup, s: TileSpec, i: number) {
  return {
    index: s.index, cap: s.cap, area: s.area, keyLabel: legendOf(s.index), current: props.current.includes(s.index), armed: armed.value === s.index,
    tabStop: stop[group] === i, aria: ariaOf(s), title: longNameOf(s.index), armedText: t('gp.armedTile'),
  };
}
</script>

<template>
  <Card class="gpo" :title="t('gp.outputs')" :subtitle="t('gp.outputsSub')">
    <div class="gpo__groups">
      <div v-for="g in GROUPS" :key="g.group" class="gpo__grp" role="group" :aria-labelledby="`gp-gh-${g.group}`" :style="{ '--g': `var(--g-${g.group})` }">
        <h4 :id="`gp-gh-${g.group}`" class="gpo__gh"><span class="gpo__dot" aria-hidden="true" />{{ groupTitle(g.group) }}</h4>
        <div v-if="g.layout !== 'buttons'" :class="g.layout === 'pair' ? 'gpo__pair' : 'gpo__cross'">
          <OutputTile v-for="(s, i) in g.tiles" :key="s.index" v-bind="tileProps(g.group, s, i)" @click="activate(s, $event)" @keydown="onKey($event, g.group, g.tiles, i)" @focus="stop[g.group] = i" />
        </div>
        <div v-else class="gpo__btns">
          <div class="gpo__cross">
            <OutputTile v-for="(s, i) in g.tiles.slice(0, 4)" :key="s.index" v-bind="tileProps(g.group, s, i)" @click="activate(s, $event)" @keydown="onKey($event, g.group, g.tiles, i)" @focus="stop[g.group] = i" />
          </div>
          <div class="gpo__row">
            <OutputTile v-for="(s, j) in g.tiles.slice(4)" :key="s.index" v-bind="tileProps(g.group, s, j + 4)" @click="activate(s, $event)" @keydown="onKey($event, g.group, g.tiles, j + 4)" @focus="stop[g.group] = j + 4" />
          </div>
        </div>
      </div>
    </div>
    <div class="gpo__foot">
      <Button size="sm" :icon="IconWand" @click="actions.wasd()">{{ t('gp.wasd') }}</Button>
      <Button size="sm" variant="ghost" :icon="IconEraser" :disabled="!sel.count" @click="actions.unassign(selectedKeys)">{{ t('gp.clearSel') }}</Button>
      <Button size="sm" variant="ghost" @click="actions.unassign(null)">{{ t('gp.clearAll') }}</Button>
    </div>
  </Card>
</template>
