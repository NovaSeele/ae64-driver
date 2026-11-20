<script setup lang="ts">
// DESIGN TT §2 item 5, §7: the last results in this browser, the best of a kind with two or more rows marked, and
// "Xoá lịch sử" behind the app's Dialog.
import { computed, ref } from 'vue';
import { IconTrash, IconTrophy } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import Dialog from '../ui/Dialog.vue';
import { t } from '../../i18n/vi';
import { kindText, num, pct, whenText } from '../../typing/format';
import { bestKey } from '../../typing/store';
import type { TypingResult } from '../../typing/store';

const props = defineProps<{ results: TypingResult[] }>();
const emit = defineEmits<{ clear: [] }>();
const confirmOpen = ref(false);

/** Row indexes marked "Cao nhất": per kind with two or more rows, the highest WPM (the newest of equal ones). */
const bestRows = computed(() => {
  const by = new Map<string, number[]>();
  props.results.forEach((r, i) => {
    const k = bestKey(r);
    by.set(k, [...(by.get(k) ?? []), i]);
  });
  const out = new Set<number>();
  for (const rows of by.values()) {
    if (rows.length > 1) out.add(rows.reduce((a, i) => (props.results[i].wpm > props.results[a].wpm ? i : a)));
  }
  return out;
});

function clear(): void {
  emit('clear');
  confirmOpen.value = false;
}
</script>

<template>
  <Card :title="t('tt.hist')" :subtitle="t('tt.histSub')">
    <template v-if="results.length" #actions>
      <Button variant="ghost" size="sm" :icon="IconTrash" @click="confirmOpen = true">{{ t('tt.clear') }}</Button>
    </template>
    <table v-if="results.length" class="tt-hist">
      <thead>
        <tr>
          <th scope="col">{{ t('tt.when') }}</th>
          <th scope="col">{{ t('tt.test') }}</th>
          <th scope="col" class="n">WPM</th>
          <th scope="col" class="n">{{ t('tt.acc') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(r, i) in results" :key="`${r.at}-${i}`">
          <td>{{ whenText(r.at) }}</td>
          <td>{{ kindText(r) }}</td>
          <td class="n">
            {{ num(r.wpm) }}<span v-if="bestRows.has(i)" class="star"><IconTrophy :size="13" stroke-width="1.5" aria-hidden="true" />{{ t('tt.topBest') }}</span>
          </td>
          <td class="n">{{ pct(r.acc) }}</td>
        </tr>
      </tbody>
    </table>
    <p v-else class="tt-none">{{ t('tt.histNone') }}</p>
  </Card>
  <Dialog v-model:open="confirmOpen" :title="t('tt.clearTitle')" describe>
    <p>{{ t('tt.clearBody', { n: results.length }) }}</p>
    <template #footer>
      <Button variant="ghost" @click="confirmOpen = false">{{ t('tt.cancel') }}</Button>
      <Button variant="danger" :icon="IconTrash" @click="clear">{{ t('tt.clearOk') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.tt-hist { width: 100%; border-collapse: collapse; font-size: var(--fs-label); }
.tt-hist th { text-align: left; font-weight: 500; color: var(--fg-3); padding: 6px 8px; border-bottom: 1px solid var(--line-2); }
.tt-hist td { padding: 7px 8px; border-bottom: 1px solid var(--line-1); color: var(--fg-1); font-variant-numeric: tabular-nums; }
.tt-hist td.n, .tt-hist th.n { text-align: right; }
.tt-hist .star { display: inline-flex; align-items: center; gap: 4px; margin-left: 6px; color: var(--ok); font-size: var(--fs-caption); }
.tt-none { margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
</style>
