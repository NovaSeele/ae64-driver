<script setup lang="ts">
// The four counters of a calibration session (DESIGN D §3.5): pressed n/64 · newly calibrated · too shallow · not
// calibrated. The same cell look as part C's health check counters, so the two pages read alike. null = no session (or
// not read yet): a dash, with "no session yet" for screen readers.
import { t } from '../../i18n/vi';

defineProps<{
  pressed: number | null;
  fresh: number | null;
  shallow: number | null;
  uncal: number | null;
  total: number;
}>();
</script>

<template>
  <dl class="cs" :aria-label="t('calibration.statsLabel')">
    <div>
      <dt>{{ t('calibration.statPressed') }}</dt>
      <dd :class="pressed === null ? 'is-none' : pressed === 0 ? 'is-zero' : undefined">
        <template v-if="pressed === null"><span aria-hidden="true">—</span><span class="sr-only">{{ t('calibration.statNone') }}</span></template>
        <template v-else>{{ pressed }}<small>/{{ total }}</small></template>
      </dd>
    </div>
    <div v-for="c in ([
      { label: t('calibration.legendNew'), n: fresh, cls: 'is-new' },
      { label: t('calibration.statShallow'), n: shallow, cls: 'is-warn' },
      { label: t('calibration.legendNone'), n: uncal, cls: 'is-danger' },
    ] as const)" :key="c.cls">
      <dt>{{ c.label }}</dt>
      <dd :class="c.n === null ? 'is-none' : c.n === 0 ? 'is-zero' : c.cls">
        <template v-if="c.n === null"><span aria-hidden="true">—</span><span class="sr-only">{{ t('calibration.statNone') }}</span></template>
        <template v-else>{{ c.n }}</template>
      </dd>
    </div>
  </dl>
</template>

<style scoped>
.cs {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 1px; margin: 0;
  border-radius: var(--r-card); overflow: hidden; background: var(--line-1); border: 1px solid var(--line-1);
}
.cs > div { background: var(--bg-2); padding: var(--s-2) var(--s-3); display: flex; flex-direction: column-reverse; justify-content: flex-end; gap: 2px; min-width: 0; }
/* At 1280 px the card's left column gives each cell 90 px of text: "Chưa hiệu chuẩn" wrapped there by a fraction of a pixel
   and the card grew 16 px, out of the screen while running. Narrower side padding in a narrow grid keeps one line. */
.cs { container-type: inline-size; }
@container (max-width: 500px) { .cs > div { padding-left: var(--s-2); padding-right: var(--s-2); } }
.cs dt { font-size: var(--fs-caption); color: var(--fg-3); line-height: 1.3; }
.cs dd { margin: 0; font-size: var(--fs-hero); font-weight: 600; letter-spacing: -0.01em; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--fg-1); }
.cs dd small { margin-left: 2px; font-size: var(--fs-label); font-weight: 500; color: var(--fg-3); letter-spacing: 0; }
.cs .is-new { color: var(--ok); } /* = the glow of a just-calibrated key */
.cs .is-warn { color: var(--warn); }
.cs .is-danger { color: var(--danger); }
.cs .is-zero, .cs .is-none { color: var(--fg-3); }
</style>
