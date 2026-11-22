<script setup lang="ts">
// Switch-values restore card under the Firmware page's done banner or page head (OFU v1.10 addendum §4.2, §4.3).
// Shows what changed after an update, lists keys whose distances will be fitted, separates guard refusals into `cant`
// (triple rule → Switch tab) and `blocked` (other rule → Travel tab), and writes only when the user presses Restore.
import { computed, nextTick, ref, useId, watch } from 'vue';
import { useRouter } from 'vue-router';
import { IconAlertCircle, IconCheck, IconInfoCircle, IconRefresh } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import { AXIS_BACKUP_OLD_MS } from '../../data/axisBackup';
import { switchName } from '../../data/switchDisplay';
import { findSwitch } from '../../protocol/switches';
import { useDeviceStore } from '../../stores/device';
import { useFirmwareStore } from '../../stores/firmware';
import { customSwitchName, usePerformanceStore } from '../../stores/performance';
import { useSelectionStore } from '../../stores/selection';
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';

const device = useDeviceStore();
const fw = useFirmwareStore();
const perf = usePerformanceStore();
const sel = useSelectionStore();
const router = useRouter();

const titleId = useId();
const rowsId = useId();
const resultLine = ref<HTMLElement | null>(null);

watch(() => fw.axResult, async (r) => {
  if (!r) return;
  await nextTick();
  resultLine.value?.focus({ preventScroll: true });
});

const backup = computed(() => fw.axBackup);
const cmp = computed(() => fw.axCompare);
const res = computed(() => fw.axResult);

const offeredCount = computed(() => {
  const c = cmp.value;
  return c ? c.restore.length + c.cant.length + c.blocked.length : 0;
});

const intlLocale = computed(() => (locale.value === 'vi' ? 'vi-VN' : 'en-US'));

const takenTime = computed(() => {
  const b = backup.value;
  if (!b) return '';
  const d = new Date(b.takenAt);
  const now = new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay
    ? new Intl.DateTimeFormat(intlLocale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d)
    : new Intl.DateTimeFormat(intlLocale.value, { dateStyle: 'medium' }).format(d);
});

const takenDate = computed(() => {
  const b = backup.value;
  return b ? new Intl.DateTimeFormat(intlLocale.value, { dateStyle: 'medium' }).format(new Date(b.takenAt)) : '';
});

const isOld = computed(() => {
  const b = backup.value;
  return Boolean(b && Date.now() - b.takenAt > AXIS_BACKUP_OLD_MS);
});

interface RestoreRow {
  key: string;
  name: string;
  custom: boolean;
  color: string;
  count: number;
}

const rows = computed<RestoreRow[]>(() => {
  const b = backup.value;
  const c = cmp.value;
  if (!b || !c || !c.restore.length) return [];

  const grouped = new Map<string, RestoreRow>();

  for (const keyId of c.restore) {
    const saved = b.keys[keyId];
    if (!saved) continue;
    const ident = perf.switchIdentity({ axisV2Id: saved[0], axisRangeMax: saved[1], axisCoefficient: saved[2] }, keyId);
    let name: string;
    let custom = false;
    let color = '';
    if (ident.kind === 'custom') {
      custom = true;
      name = customSwitchName(ident.custom);
    } else {
      const entry = findSwitch(perf.catalog, saved[0]);
      if (entry) {
        name = switchName(entry);
        color = /^#[0-9a-f]{3,8}$/i.test(entry.color) ? entry.color : 'var(--hue-blue)';
      } else {
        const hex = saved[0].toString(16).toUpperCase().padStart(4, '0');
        name = t('fw.ax.oldId', { hex });
        color = 'var(--hue-blue)';
      }
    }
    const rowKey = `${custom ? 'c' : 'l'}:${name}`;
    const existing = grouped.get(rowKey);
    if (existing) existing.count++;
    else grouped.set(rowKey, { key: rowKey, name, custom, color, count: 1 });
  }

  return [...grouped.values()].sort((a, bRow) => bRow.count - a.count);
});

const KEYS_SHOWN = 8;
function keyList(keyIds: readonly number[]): string {
  const set = new Set(keyIds);
  const legends = device.keys.filter((k) => set.has(k.id)).map((k) => device.legend(k));
  const rest = legends.length - KEYS_SHOWN;
  return legends.slice(0, KEYS_SHOWN).join(', ') + (rest > 0 ? ` +${rest}` : '');
}

function openSwitch(ids: readonly number[]): void {
  sel.selectMany([...ids]);
  void router.push({ path: '/performance', query: { tab: 'switch' } });
}

function openTravel(ids: readonly number[]): void {
  sel.selectMany([...ids]);
  void router.push({ path: '/performance', query: { tab: 'travel' } });
}
</script>

<template>
  <Card
    v-if="res"
    class="ax-card ax-card--ok"
    :aria-label="t('fw.ax.title')"
    data-test="ax-card"
  >
    <p
      v-if="res.restored.length"
      ref="resultLine"
      class="ax__ok"
      role="status"
      tabindex="-1"
      data-test="ax-done"
    >
      <IconCheck :size="18" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.done', { n: res.restored.length }) }}</span>
    </p>
    <div
      v-if="res.failed.length"
      :ref="res.restored.length === 0 ? (el) => { resultLine = el as HTMLElement | null } : undefined"
      class="ax__warn"
      :role="res.restored.length === 0 ? 'status' : undefined"
      :tabindex="res.restored.length === 0 ? -1 : undefined"
      data-test="ax-fail"
    >
      <IconAlertCircle :size="16" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.fail', { n: res.failed.length, keys: keyList(res.failed) }) }}</span>
      <Button variant="secondary" size="sm" @click="openSwitch(res.failed)">{{ t('fw.ax.pick') }}</Button>
    </div>
    <div
      v-if="res.cant.length"
      :ref="res.restored.length === 0 && res.failed.length === 0 ? (el) => { resultLine = el as HTMLElement | null } : undefined"
      class="ax__warn"
      :tabindex="res.restored.length === 0 && res.failed.length === 0 ? -1 : undefined"
      data-test="ax-cant"
    >
      <IconAlertCircle :size="16" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.cant', { n: res.cant.length, keys: keyList(res.cant) }) }}</span>
      <Button variant="secondary" size="sm" @click="openSwitch(res.cant)">{{ t('fw.ax.pick') }}</Button>
    </div>
    <div
      v-if="res.blocked.length"
      :ref="res.restored.length === 0 && res.failed.length === 0 && res.cant.length === 0 ? (el) => { resultLine = el as HTMLElement | null } : undefined"
      class="ax__warn"
      :tabindex="res.restored.length === 0 && res.failed.length === 0 && res.cant.length === 0 ? -1 : undefined"
      data-test="ax-blocked"
    >
      <IconAlertCircle :size="16" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.blocked', { n: res.blocked.length, keys: keyList(res.blocked) }) }}</span>
      <Button variant="secondary" size="sm" @click="openTravel(res.blocked)">{{ t('fw.ax.openTravel') }}</Button>
    </div>
  </Card>

  <Card
    v-else-if="backup && cmp && offeredCount > 0"
    class="ax-card"
    :aria-labelledby="titleId"
    data-test="ax-card"
  >
    <h3 :id="titleId" class="ax__h">
      <IconRefresh :size="18" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.title') }}</span>
    </h3>
    <p class="ax__p">{{ t('fw.ax.body', { n: offeredCount, time: takenTime }) }}</p>
    <p v-if="isOld" class="ax__old" data-test="ax-old">
      <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.old', { date: takenDate }) }}</span>
    </p>
    <template v-if="rows.length">
      <p :id="rowsId" class="ax__k">{{ t('fw.ax.rows') }}</p>
      <ul class="ax__rows" :aria-labelledby="rowsId" data-test="ax-rows">
        <li v-for="r in rows" :key="r.key" class="ax__row">
          <span
            class="ax__sw"
            :class="{ 'ax__sw--custom': r.custom }"
            :style="r.color ? { background: r.color } : undefined"
            aria-hidden="true"
          />
          <b>{{ r.name }}</b>
          <span v-if="r.custom" class="ax__kind">{{ t('fw.ax.custom') }}</span>
          <span class="ax__n">{{ t('fw.ax.row', { n: r.count }) }}</span>
        </li>
      </ul>
    </template>
    <p v-if="cmp.fitted.length" class="ax__info" data-test="ax-fitted">
      <IconInfoCircle :size="15" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.fit', { n: cmp.fitted.length, keys: keyList(cmp.fitted) }) }}</span>
    </p>
    <div v-if="cmp.cant.length" class="ax__warn" data-test="ax-cant">
      <IconAlertCircle :size="16" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.cant', { n: cmp.cant.length, keys: keyList(cmp.cant) }) }}</span>
      <Button variant="secondary" size="sm" :disabled="fw.axRestoring" @click="openSwitch(cmp.cant)">{{ t('fw.ax.pick') }}</Button>
    </div>
    <div v-if="cmp.blocked.length" class="ax__warn" data-test="ax-blocked">
      <IconAlertCircle :size="16" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.blocked', { n: cmp.blocked.length, keys: keyList(cmp.blocked) }) }}</span>
      <Button variant="secondary" size="sm" :disabled="fw.axRestoring" @click="openTravel(cmp.blocked)">{{ t('fw.ax.openTravel') }}</Button>
    </div>
    <p v-if="cmp.lostBefore.length" class="ax__lost" data-test="ax-lost-before">
      {{ t('fw.ax.lostBefore', { n: cmp.lostBefore.length, keys: keyList(cmp.lostBefore) }) }}
    </p>
    <p class="ax__info">
      <IconInfoCircle :size="15" stroke-width="1.75" aria-hidden="true" />
      <span>{{ t('fw.ax.order') }}</span>
    </p>
    <div class="ax__act">
      <Button
        v-if="cmp.restore.length"
        variant="primary"
        size="md"
        :icon="IconRefresh"
        :loading="fw.axRestoring"
        data-test="ax-go"
        @click="fw.restoreSwitchValues()"
      >{{ fw.axRestoring ? t('fw.ax.busy') : t('fw.ax.go', { n: cmp.restore.length }) }}</Button>
      <Button
        variant="ghost"
        size="md"
        :disabled="fw.axRestoring"
        data-test="ax-later"
        @click="fw.dismissAxisRestore()"
      >{{ t('fw.ax.later') }}</Button>
    </div>
  </Card>
</template>

<style scoped>
.card.ax-card {
  gap: var(--s-3);
  border-color: color-mix(in srgb, var(--warn) 40%, var(--line-1));
}
.card.ax-card--ok { border-color: var(--line-1); }
.ax__h { display: flex; align-items: center; gap: var(--s-2); margin: 0; font-size: var(--fs-title, 16px); font-weight: 600; color: var(--fg-1); }
.ax__h > svg { color: var(--warn); flex: none; }
.ax__p, .ax__info, .ax__lost, .ax__old, .ax__warn, .ax__ok { margin: 0; font-size: var(--fs-label); line-height: 1.5; color: var(--fg-2); }
.ax__old { display: flex; align-items: flex-start; gap: var(--s-2); color: var(--warn); }
.ax__old > svg { color: var(--warn); flex: none; margin-top: 2px; }
.ax__k { margin: 0; font-size: var(--fs-caption); font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-3); }
.ax__rows { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; border: 1px solid var(--line-1); border-radius: var(--r-control); }
.ax__row { display: flex; align-items: center; gap: var(--s-2); padding: 8px 12px; font-size: var(--fs-body); color: var(--fg-1); }
.ax__row + .ax__row { border-top: 1px solid var(--line-1); }
.ax__row b { font-weight: 600; }
.ax__sw { width: 12px; height: 12px; border-radius: 3px; background: var(--hue-blue); flex: none; box-sizing: border-box; }
.ax__sw--custom { background: transparent; border: 1.5px dashed var(--fg-2); }
.ax__kind { font-size: var(--fs-label); color: var(--fg-3); }
.ax__n { margin-left: auto; font-size: var(--fs-label); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.ax__info, .ax__warn, .ax__ok { display: flex; align-items: flex-start; gap: var(--s-2); }
.ax__info > svg { color: var(--info); flex: none; margin-top: 2px; }
.ax__warn { color: var(--fg-1); align-items: center; }
.ax__warn > svg { color: var(--warn); flex: none; }
.ax__warn > span { flex: 1 1 240px; min-width: 0; }
.ax__warn > :deep(.btn) { margin-left: auto; flex: none; }
.ax__ok { color: var(--fg-1); font-size: var(--fs-body); }
.ax__ok:focus { outline: none; }
.ax__ok:focus-visible { box-shadow: var(--focus-ring); border-radius: 4px; }
.ax__ok > svg { color: var(--ok); flex: none; margin-top: 2px; }
.ax__act { display: flex; flex-wrap: wrap; gap: var(--s-2); }

@media (max-width: 860px) {
  .ax__warn { flex-wrap: wrap; }
  .ax__warn > :deep(.btn) { margin-left: 24px; }
}
</style>
