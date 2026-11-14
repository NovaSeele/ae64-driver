<script setup lang="ts">
// The drawn keycap legend ("Keycap: RT = … · ▭ = …"): each glyph or sample is drawn the way the keycap draws it. Hidden
// from screen readers; SelectionBar gives them the plain sentence once. Also rendered (unseen) in the bar's measuring
// ghost, so the widest legend a page can switch to is measured with the same markup.
import { IconLock } from '@tabler/icons-vue';
import type { LegendItem } from './SelectionBar.vue';
import { t } from '../../i18n/vi';

defineProps<{ items: LegendItem[] }>();

const isGlyph = (i: LegendItem): i is { glyph: string; tone?: string; text: string } => 'glyph' in i;
const isSample = (i: LegendItem): i is { sample: 'flag' | 'bar' | 'lock' | 'fill'; label: string; colors?: string[]; tone?: string; text: string } => 'sample' in i;
const tone = (i: LegendItem) => (i.tone ? { '--tone': i.tone } : undefined);
const barGradient = (colors: string[] = []) => (colors.length > 1
  ? `linear-gradient(90deg, ${colors.map((c, i) => `${c} ${(i / colors.length) * 100}% ${((i + 1) / colors.length) * 100}%`).join(', ')})`
  : colors[0] ?? 'var(--fg-3)');
</script>

<template>
  <span aria-hidden="true"><span class="sb__k">{{ t('sel.shows') }}:</span><template v-for="(item, i) in items" :key="i"><span v-if="i" class="sb__dot">·</span><template v-if="isGlyph(item)"><b class="sb__g" :style="tone(item)">{{ item.glyph }}</b><span class="sb__eq"> = </span><span class="sb__t">{{ item.text }}</span></template><template v-else-if="isSample(item)"><span v-if="item.sample === 'flag'" class="sb__flag" /><span v-else-if="item.sample === 'bar'" class="sb__bar" :style="{ background: barGradient(item.colors) }" /><span v-else-if="item.sample === 'fill'" class="sb__fill" :style="tone(item)" /><span v-else class="sb__icon" :style="tone(item)"><IconLock :size="12" stroke-width="1.8" /></span><span class="sb__eq"> = </span><span class="sb__t">{{ item.text }}</span></template><span v-else class="sb__t" :style="tone(item)">{{ item.text }}</span></template></span>
</template>

<style scoped>
.sb__k { color: var(--fg-3); font-weight: 500; margin-right: 6px; }
.sb__dot { color: var(--fg-4); margin: 0 6px; }
.sb__t { color: var(--tone, var(--fg-2)); }
/* a glyph is drawn the way the keycap draws it: same character, same tone */
.sb__g { font-weight: 600; color: var(--tone, var(--fg-1)); font-variant-numeric: tabular-nums; }
.sb__eq { color: var(--fg-3); }
/* the keycap's "not calibrated" outline (Keycap .cap--flag: 1.5px dashed --warn) */
.sb__flag { display: inline-block; width: 14px; height: 12px; vertical-align: -1px; border-radius: 3px; outline: 1.5px dashed var(--warn); outline-offset: -1.5px; }
/* the switch-group LED bar (KeyboardView led-height 3) */
.sb__bar { display: inline-block; width: 16px; height: 3px; vertical-align: 3px; border-radius: 2px; }
/* the depth fill (Keycap .cap__fill: from the top down, in the metric tone) on a small key face */
.sb__fill {
  position: relative; display: inline-block; width: 14px; height: 12px; vertical-align: -1px; overflow: hidden; border-radius: 3px;
  border: 1px solid var(--line-2); background: linear-gradient(180deg, var(--cap-top), var(--cap-bottom));
}
.sb__fill::after {
  content: ''; position: absolute; left: 0; right: 0; top: 0; height: 55%;
  background: color-mix(in srgb, var(--tone, var(--acc)) 22%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--tone, var(--acc)) 60%, transparent);
}
/* the "unsupported mode" lock badge (Keycap .cap__badge--icon, the view's metric tone) */
.sb__icon { display: inline-flex; vertical-align: -1px; color: var(--tone, var(--fg-2)); }
</style>
