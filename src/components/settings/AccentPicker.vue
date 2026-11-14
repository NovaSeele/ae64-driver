<script setup lang="ts">
// The accent colour row of the Appearance card (DESIGN J §3.1, §7): "Theme colour" · 5 swatches · "Custom…" (ColorPicker in
// a Popover). App preference only: applies on :root in the same frame and is stored in this browser; never a keyboard command.
import { computed, nextTick, ref, watch } from 'vue';
import { IconAlertTriangle, IconCheck, IconInfoCircle, IconPlus, IconRestore } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import ColorPicker from '../ui/ColorPicker.vue';
import Popover from '../ui/Popover.vue';
import { resolvedTheme } from '../../theme';
import { accentState, type AccentState } from '../../accentCache';
import {
  NEAR, SWATCHES, THEME_ROWS, accentFor, nearest, previewAccent, setAccent, themeBase, themeSemantic, type SemanticKey,
} from '../../accent';
import { t, type MessageKey } from '../../i18n/vi';

type Choice = 'theme' | (typeof SWATCHES)[number]['id'] | 'custom';
const CHOICES: readonly Choice[] = ['theme', ...SWATCHES.map((s) => s.id), 'custom'];

const hex = computed(() => accentState.value.hex);
const selected = computed<Choice>(() => {
  if (!hex.value) return 'theme';
  return SWATCHES.find((s) => s.hex === hex.value)?.id ?? 'custom';
});

/** What each choice looks like on the theme open now: the swatches as the app would apply them there. */
const base = computed(() => themeBase(resolvedTheme.value));
const themeDot = computed(() => THEME_ROWS[resolvedTheme.value].acc);
const swatchVars = computed(() => SWATCHES.map((s) => accentFor(s.hex, base.value).vars));

/** The applied result of the current colour on this theme (status line, ⓘ and ⚠). */
const result = computed(() => (hex.value ? accentFor(hex.value, base.value) : null));
const themeKey = (id: string) => id.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
const themeName = computed(() => t(`theme.${themeKey(resolvedTheme.value)}` as MessageKey));
const NEAR_TEXT: Record<SemanticKey, MessageKey> = {
  'm-press': 'acc.nearPress', 'm-release': 'acc.nearRelease', ok: 'acc.nearOk', warn: 'acc.nearWarn', danger: 'acc.nearDanger',
};
const nearText = computed(() => {
  if (!result.value) return null;
  const n = nearest(result.value.vars, themeSemantic(resolvedTheme.value));
  return n.d < NEAR && n.key ? t(NEAR_TEXT[n.key]) : null;
});

const row = ref<HTMLElement | null>(null);
const customBtn = ref<HTMLButtonElement | null>(null);
const optionEls = () => [...(row.value?.querySelectorAll<HTMLButtonElement>('[role="radio"]') ?? [])];

function choose(c: Choice): void {
  if (c === 'custom') { openPicker(); return; }
  if (c === 'theme') setAccent(null);
  else setAccent(SWATCHES.find((s) => s.id === c)!.hex);
}

function onKey(e: KeyboardEvent): void {
  const els = optionEls();
  const i = els.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  let next: number;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % CHOICES.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + CHOICES.length) % CHOICES.length;
  else return;
  e.preventDefault();
  const c = CHOICES[next];
  // "Theme colour" and the swatches follow focus (like the theme grid); arrows only move focus onto "Custom…".
  if (c !== 'custom') choose(c);
  els[next]?.focus();
}
/** The roving tab stop: the checked option (Tab enters the group there). */
const tabStop = (c: Choice) => (c === selected.value ? 0 : -1);

// ---- Custom… ----
const pickerOpen = ref(false);
const draft = ref('#000000');
/** What a close returns to: the state before the picker opened, then the last colour committed while it was open. */
let before: AccentState | null = null;
/** The colour the picker opened on: no preview until the draft leaves it (opening alone changes nothing). */
let openedWith = '';
let previewing = false;

function openPicker(): void {
  before = accentState.value;
  draft.value = hex.value ?? themeDot.value;
  openedWith = draft.value;
  previewing = false;
  pickerOpen.value = true;
}
watch(draft, (v) => {
  if (!pickerOpen.value || (!previewing && v === openedWith)) return;
  previewing = true;
  previewAccent(v);
});
function save(v: string): void {
  setAccent(v);
  before = accentState.value;
}
watch(pickerOpen, (on) => {
  if (on) return;
  // Closed (Esc, a press outside): keep the last commit; with none, back to the colour from before it opened.
  if (before && accentState.value !== before) accentState.value = before;
  before = null;
});

async function resetToTheme(): Promise<void> {
  setAccent(null);
  await nextTick();
  optionEls()[0]?.focus();
}
const sw = (id: string) => SWATCHES.findIndex((s) => s.id === id);
</script>

<template>
  <div class="acc">
    <div class="acc__head">
      <h3 id="acc-t" class="acc__title">{{ t('acc.title') }}</h3>
      <p class="acc__sub">{{ t('acc.sub') }}</p>
    </div>
    <ul ref="row" class="acc__row" role="radiogroup" aria-labelledby="acc-t" @keydown="onKey">
      <li role="none">
        <button
          type="button"
          role="radio"
          class="acc__opt acc__opt--theme"
          :aria-checked="selected === 'theme'"
          :tabindex="tabStop('theme')"
          @click="choose('theme')"
        >
          <span class="acc__dot" :style="{ '--d': themeDot }" aria-hidden="true" />{{ t('acc.theme') }}
        </button>
      </li>
      <li v-for="s in SWATCHES" :key="s.id" role="none">
        <button
          type="button"
          role="radio"
          class="acc__opt acc__sw"
          :aria-checked="selected === s.id"
          :aria-label="t(`acc.c.${s.id}` as MessageKey)"
          :title="t(`acc.c.${s.id}` as MessageKey)"
          :tabindex="tabStop(s.id)"
          :style="{ '--d': swatchVars[sw(s.id)]['--acc'], '--k': swatchVars[sw(s.id)]['--on-acc'] }"
          @click="choose(s.id)"
        >
          <span class="acc__dot" aria-hidden="true" />
          <span v-if="selected === s.id" class="acc__chk" aria-hidden="true"><IconCheck :size="14" :stroke-width="2.5" /></span>
        </button>
      </li>
      <li role="none">
        <button
          ref="customBtn"
          type="button"
          role="radio"
          class="acc__opt acc__opt--custom"
          aria-haspopup="dialog"
          :aria-expanded="pickerOpen"
          :aria-checked="selected === 'custom'"
          :tabindex="tabStop('custom')"
          @click="choose('custom')"
        >
          <span v-if="selected === 'custom' && result" class="acc__dot" :style="{ '--d': result.vars['--acc'] }" aria-hidden="true" />
          <IconPlus v-else :size="16" stroke-width="1.8" aria-hidden="true" />
          {{ t('acc.custom') }}
        </button>
      </li>
    </ul>
    <div class="acc__status" aria-live="polite">
      <template v-if="result">
        <span class="acc__using"><i aria-hidden="true" />{{ t('acc.using') }} <code class="acc__hex">{{ result.vars['--acc'] }}</code></span>
        <Button variant="ghost" size="sm" :icon="IconRestore" @click="resetToTheme">{{ t('acc.reset') }}</Button>
        <p v-if="result.adjusted" class="acc__note">
          <IconInfoCircle :size="16" stroke-width="1.8" aria-hidden="true" />
          <span>{{ t('acc.adjusted', { picked: result.picked, theme: themeName, applied: result.vars['--acc'] }) }}</span>
        </p>
        <p v-if="nearText" class="acc__warn">
          <IconAlertTriangle :size="16" stroke-width="1.8" aria-hidden="true" />
          <span>{{ nearText }}</span>
        </p>
      </template>
    </div>
    <Popover v-model:open="pickerOpen" :anchor="customBtn" :title="t('acc.pickTitle')">
      <ColorPicker v-model="draft" :recent="false" @commit="save" />
    </Popover>
  </div>
</template>

<style scoped>
.acc { display: flex; flex-direction: column; gap: var(--s-3); margin-top: var(--s-4); padding-top: var(--s-4); border-top: 1px solid var(--line-1); }
.acc__head { display: flex; flex-direction: column; gap: 2px; }
.acc__title { margin: 0; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
.acc__sub { margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }
.acc__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2); margin: 0; padding: 0; list-style: none; }
/* flex items, not line boxes: a text pill and an empty swatch would otherwise sit on different baselines (0.6 px apart) */
.acc__row > li { display: flex; }
/* "Theme colour": a pill with the theme's own accent dot. Swatches: 32 px circles. All are role="radio". */
.acc__opt { position: relative; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; border: 1px solid var(--line-2); border-radius: 999px; background: var(--bg-1); color: var(--fg-1); font: inherit; font-size: var(--fs-label); font-weight: 500; cursor: pointer; }
.acc__opt:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.acc__opt--theme { padding: 0 12px 0 8px; }
.acc__dot { width: 16px; height: 16px; border-radius: 50%; background: var(--d); box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.18); }
.acc__sw { width: 32px; padding: 0; border-color: transparent; background: transparent; }
.acc__sw .acc__dot { width: 24px; height: 24px; }
.acc__opt--custom { padding: 0 12px 0 8px; border-style: dashed; color: var(--fg-2); }
.acc__opt--custom svg { color: var(--fg-3); }
/* checked: a ring in the applied accent + a check on the dot, so "selected" never rests on colour alone */
.acc__opt[aria-checked='true'] { border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc); }
.acc__sw[aria-checked='true'] { border-color: var(--fg-1); box-shadow: inset 0 0 0 1px var(--fg-1); }
.acc__opt[aria-checked='true']:focus-visible { box-shadow: inset 0 0 0 1px var(--acc), var(--focus-ring); }
.acc__sw[aria-checked='true']:focus-visible { box-shadow: inset 0 0 0 1px var(--fg-1), var(--focus-ring); }
.acc__chk { position: absolute; inset: 0; display: grid; place-items: center; color: var(--k); pointer-events: none; }
.acc__status { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-2); }
.acc__status:empty { display: none; }
.acc__using { display: inline-flex; align-items: center; gap: 6px; font-weight: 600; color: var(--fg-1); }
.acc__using i { width: 12px; height: 12px; border-radius: 3px; background: var(--acc); }
.acc__hex { font-family: var(--font-mono, ui-monospace, monospace); font-weight: 500; }
.acc__note { flex-basis: 100%; display: flex; gap: 6px; align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }
.acc__warn { flex-basis: 100%; display: flex; gap: 6px; align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--warn); }
.acc__warn svg, .acc__note svg { flex: none; margin-top: 1px; }
</style>
