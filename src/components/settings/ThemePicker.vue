<script setup lang="ts">
// Appearance picker: radiogroup of theme tiles (Auto first). App preference only, never touches the device.
import { IconCheck } from '@tabler/icons-vue';
import { setTheme, themeChoice, THEMES, type ThemeChoice } from '../../theme';
import { t, type MessageKey } from '../../i18n/vi';

const CHOICES: readonly ThemeChoice[] = ['auto', ...THEMES];
const name = (c: ThemeChoice) => t(`theme.${c}` as MessageKey);
const desc = (c: ThemeChoice) => t(`theme.${c}Desc` as MessageKey);

function onKey(e: KeyboardEvent) {
  const i = CHOICES.indexOf(themeChoice.value);
  let next: number;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % CHOICES.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + CHOICES.length) % CHOICES.length;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = CHOICES.length - 1;
  else return;
  e.preventDefault();
  setTheme(CHOICES[next]);
  const tiles = (e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('[role="radio"]');
  tiles[next]?.focus();
}
</script>

<template>
  <div class="tp" role="radiogroup" :aria-label="t('settings.appearance')" @keydown="onKey">
    <button
      v-for="c in CHOICES"
      :key="c"
      type="button"
      role="radio"
      class="tp__tile"
      :class="{ 'tp__tile--on': themeChoice === c }"
      :aria-checked="themeChoice === c"
      :tabindex="themeChoice === c ? 0 : -1"
      @click="setTheme(c)"
    >
      <span class="tp__prev" aria-hidden="true">
        <template v-if="c === 'auto'">
          <span class="tp__half tp__half--a" data-theme="graphite" />
          <span class="tp__half tp__half--b" data-theme="light" />
        </template>
        <span v-else class="tp__scene" :data-theme="c">
          <span class="tp__strip"><i /><i /><i /></span>
          <span class="tp__card"><b /><b class="tp__cap--sel" /><b /></span>
          <span class="tp__pill" />
        </span>
        <span v-if="themeChoice === c" class="tp__check"><IconCheck :size="12" :stroke-width="2.5" /></span>
      </span>
      <span class="tp__name">{{ name(c) }}</span>
      <span class="tp__desc">{{ desc(c) }}</span>
    </button>
  </div>
</template>

<style scoped>
.tp {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 12px;
}
.tp__tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0;
  border: 0;
  background: transparent;
  text-align: left;
  color: inherit;
  border-radius: var(--r-card);
  outline: 2px solid transparent;
  outline-offset: 3px;
}
.tp__tile--on { outline-color: var(--acc); }
.tp__tile:focus-visible { box-shadow: var(--focus-ring); }
.tp__prev {
  position: relative;
  display: block;
  height: 64px;
  overflow: hidden;
  border-radius: var(--r-control);
  border: 1px solid var(--line-2);
}
.tp__scene,
.tp__half {
  position: absolute;
  inset: 0;
  background: var(--bg-0);
}
.tp__half--a { clip-path: polygon(0 0, 100% 0, 0 100%); }
.tp__half--b { clip-path: polygon(100% 0, 100% 100%, 0 100%); }
.tp__strip {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: var(--bg-1);
}
.tp__strip i { width: 6px; height: 6px; border-radius: 50%; }
.tp__strip i:nth-child(1) { background: var(--f-keymap); }
.tp__strip i:nth-child(2) { background: var(--f-performance); }
.tp__strip i:nth-child(3) { background: var(--f-advanced); }
.tp__card {
  position: absolute;
  left: 22px;
  top: 12px;
  display: flex;
  gap: 4px;
  padding: 6px;
  border-radius: 5px;
  background: var(--bg-2);
}
.tp__card b {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  background: linear-gradient(180deg, var(--cap-top), var(--cap-bottom));
}
.tp__card .tp__cap--sel { background: var(--sel-fill); outline: 1.5px solid var(--acc); }
.tp__pill {
  position: absolute;
  left: 22px;
  bottom: 9px;
  width: 28px;
  height: 6px;
  border-radius: 3px;
  background: var(--acc);
}
.tp__check {
  position: absolute;
  top: 4px;
  right: 4px;
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--acc);
  color: var(--on-acc);
}
.tp__name { font-size: var(--fs-label); font-weight: 600; color: var(--fg-1); margin-top: 4px; }
.tp__desc { font-size: var(--fs-caption); color: var(--fg-3); }
</style>
