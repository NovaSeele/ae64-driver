<script setup lang="ts">
// Step 3 (DESIGN FW §3.1, §3.3): the four phases, the progress bar, "do not unplug"; a failure says where the keyboard is and
// what to do. Nothing is retried by itself: "Ghi lại từ đầu" runs only on a click. Rescue mode: the "Ghi firmware" button.
import { computed, ref, watch } from 'vue';
import { IconAlertCircle, IconAlertTriangle, IconCircleCheck, IconCircleDashed, IconCircleX, IconDeviceFloppy, IconRefresh } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import { FW_CHUNK } from '../../protocol/firmware';
import { useFirmwareStore } from '../../stores/firmware';
import type { FwRow } from '../../stores/firmware';
import { t } from '../../i18n/vi';
import { fwText, kib, percent } from './fwText';

const fw = useFirmwareStore();

const size = computed(() => fw.file?.size ?? 0);
const pct = computed(() => percent(fw.sent, fw.total));
const doneBytes = computed(() => Math.min(fw.sent * FW_CHUNK, size.value));
const rows = computed(() => {
  const r = fw.rows;
  const writeV = r.write === 'todo' ? '' : `${pct.value}% · ${t('fw.s3.bytes', { done: kib(doneBytes.value), total: kib(size.value) })}`;
  const findV = (fw.phase === 'done' || fw.phase === 'doneUnknown') && fw.doneVersion ? `v${fw.doneVersion}` : '';
  return [
    { key: 'write', state: r.write, label: t('fw.s3.write'), v: writeV },
    { key: 'verify', state: r.verify, label: t('fw.s3.verify'), v: '' },
    { key: 'reboot', state: r.reboot, label: t('fw.s3.reboot'), v: '' },
    { key: 'find', state: r.find, label: t('fw.s3.find'), v: findV },
  ];
});
const icon = (s: FwRow) => (s === 'done' ? IconCircleCheck : s === 'fail' ? IconCircleX : IconCircleDashed);

const running = computed(() => ['writing', 'verifying', 'rebooting', 'finding'].includes(fw.phase));
const started = computed(() => fw.rows.write !== 'todo');
const err = computed(() => fwText(fw.error));
const showErr = computed(() => !!err.value && !['preflightFail', 'enterFail', 'manyBoot'].includes(fw.phase));
const canRetry = computed(() => fw.phase === 'packetFail' || fw.phase === 'verifyFail');

// Screen readers hear the write at 25 / 50 / 75 / 100 %, not every packet (DESIGN FW §6).
const said = ref('');
watch(pct, (p, old) => {
  if (fw.phase !== 'writing' && p !== 100) return;
  for (const q of [25, 50, 75, 100]) if (p >= q && (old ?? 0) < q) said.value = `${t('fw.s3.write')} ${q}%`;
});
watch(() => fw.phase, (p) => { if (p === 'writing' && fw.sent === 0) said.value = ''; });
</script>

<template>
  <template v-if="fw.rescue && fw.phase === 'rescue'">
    <p v-if="fw.rescueBoard === null" class="fws__p">{{ t('fw.rescue.noBoard') }}</p>
    <template v-else>
      <p v-if="showErr" class="fw-err" role="alert"><IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ err }}</span></p>
      <label v-if="fw.fileOk && fw.needsRisk && !fw.rescueRefused" class="fw-risk">
        <input v-model="fw.riskOk" type="checkbox" aria-describedby="fw-risk-line" />
        <span>{{ t('fw.risk') }}</span>
      </label>
      <div>
        <Button variant="danger" :icon="IconDeviceFloppy" :disabled="!fw.canRescueWrite" @click="fw.rescueWrite()">{{ t('fw.rescue.write') }}</Button>
      </div>
      <p class="fw-dont"><IconAlertTriangle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.s3.dont') }}</span></p>
    </template>
  </template>
  <template v-else-if="started">
    <ul class="fw-ph">
      <li v-for="r in rows" :key="r.key" :class="r.state">
        <span v-if="r.state === 'now'" class="fw-spin" aria-hidden="true" />
        <component :is="icon(r.state)" v-else :size="16" stroke-width="1.75" aria-hidden="true" />
        <span>{{ r.label }}</span>
        <span class="fw-ph__v">{{ r.v }}</span>
      </li>
    </ul>
    <div
      v-if="fw.rows.write === 'now' || fw.rows.write === 'fail'"
      class="fw-bar"
      role="progressbar"
      :aria-label="t('fw.s3.write')"
      aria-valuemin="0"
      :aria-valuemax="fw.total"
      :aria-valuenow="fw.sent"
      :aria-valuetext="`${pct}%`"
    ><i :style="{ width: `${pct}%` }" /></div>
    <p class="sr-only" aria-live="polite">{{ said }}</p>
    <p v-if="running" class="fw-dont"><IconAlertTriangle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.s3.dont') }}</span></p>
    <p v-if="showErr" class="fw-err" role="alert"><IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ err }}</span></p>
    <div v-if="canRetry" class="fw-retry">
      <Button variant="primary" :icon="IconRefresh" @click="fw.retry()">{{ t('fw.err.retry') }}</Button>
      <p class="fws__p">{{ t('fw.err.retryHelp') }}</p>
    </div>
    <div v-else-if="fw.phase === 'manyApp' || fw.phase === 'notFound'">
      <Button variant="primary" :icon="IconRefresh" @click="fw.findAgain()">{{ t('fw.findAgain') }}</Button>
    </div>
  </template>
</template>

<style scoped>
.fws__p { margin: 0; font-size: var(--fs-label); line-height: 20px; color: var(--fg-2); }
.fw-ph { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
.fw-ph li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 10px; align-items: center; font-size: var(--fs-label); color: var(--fg-3); }
.fw-ph li.now { color: var(--fg-1); font-weight: 600; }
.fw-ph li.done { color: var(--fg-2); }
.fw-ph li.done svg { color: var(--ok); }
.fw-ph li.fail { color: var(--danger); font-weight: 600; }
.fw-ph__v { font-variant-numeric: tabular-nums; color: var(--fg-2); font-weight: 500; }
.fw-bar { position: relative; height: 8px; border-radius: 4px; background: var(--bg-3); overflow: hidden; }
.fw-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--acc); transition: width var(--t-fast) linear; }
.fw-dont {
  display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control);
  background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--fg-1); font-size: var(--fs-label); line-height: 18px;
}
.fw-dont svg { flex: none; margin-top: 1px; color: var(--warn); }
.fw-err {
  display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control);
  background: var(--danger-soft); color: var(--danger); font-size: var(--fs-label); line-height: 18px;
}
.fw-err svg { flex: none; margin-top: 1px; }
.fw-err span { min-width: 0; overflow-wrap: anywhere; }
.fw-retry { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-3); }
.fw-retry .fws__p { flex: 1 1 240px; }
.fw-risk { display: flex; align-items: center; gap: var(--s-2); font-size: var(--fs-label); color: var(--fg-1); cursor: pointer; }
.fw-risk input { width: 16px; height: 16px; margin: 0; accent-color: var(--acc); }
.fw-spin { flex: none; width: 16px; height: 16px; border: 2px solid var(--line-3); border-top-color: var(--acc); border-radius: 50%; animation: fw-spin 0.9s linear infinite; }
@keyframes fw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fw-spin { animation: none; border-right-color: var(--acc); } .fw-bar i { transition: none; } }
</style>
