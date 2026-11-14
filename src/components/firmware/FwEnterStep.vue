<script setup lang="ts">
// Step 2 (DESIGN FW §3.1, §3.3): what will happen, the typed confirmation ("AE64 Pro"), the risk box for a third-party or
// unknown file, then "Bắt đầu cập nhật". While waiting for the bootloader: a spinner, and the "Allow…" button when the browser
// has no permission for it yet (a real click: requestDevice cannot run by itself).
import { computed } from 'vue';
import { IconAlertCircle, IconPlayerPlay, IconRefresh, IconUsb } from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import { typedOk, useFirmwareStore } from '../../stores/firmware';
import { t } from '../../i18n/vi';
import { fwText } from './fwText';

const fw = useFirmwareStore();
const MODEL = 'AE64 Pro';
const [before, after] = t('fw.s2.type', { model: '\u0000' }).split('\u0000');

const waiting = computed(() => fw.phase === 'preflight' || fw.phase === 'entering' || fw.phase === 'needPermission');
/** The form shows before a session, and again after one that stopped before `08 01` (nothing was written). */
const form = computed(() => !fw.active && !fw.rescue && fw.fileOk && ['idle', 'preflightFail', 'enterFail'].includes(fw.phase));
const ok = computed(() => typedOk(fw.typed));
const busyText = computed(() => (fw.busy ? t('fw.err.busy', { reason: t(fw.busy) }) : ''));
const err = computed(() => (fw.phase === 'preflightFail' || fw.phase === 'enterFail' || fw.phase === 'manyBoot' ? fwText(fw.error) : ''));
</script>

<template>
  <template v-if="fw.rescue" />
  <p v-else-if="!fw.fileOk && !fw.active" class="fws__p">{{ t('fw.s2.need1') }}</p>
  <template v-else-if="form">
    <p class="fws__p">{{ t('fw.s2.body') }}</p>
    <p v-if="err" class="fw-err" role="alert"><IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ err }}</span></p>
    <div class="fw-confirm">
      <div class="fw-field">
        <label for="fw-type">{{ before }}<code>{{ MODEL }}</code>{{ after }}</label>
        <input
          id="fw-type"
          v-model="fw.typed"
          class="fw-input"
          :class="{ 'fw-input--ok': ok }"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="fw.typed !== '' && !ok ? true : undefined"
        />
      </div>
      <Button variant="danger" :icon="IconPlayerPlay" :disabled="!fw.canStart" @click="fw.start()">{{ t('fw.s2.start') }}</Button>
    </div>
    <label v-if="fw.needsRisk" class="fw-risk">
      <input v-model="fw.riskOk" type="checkbox" aria-describedby="fw-risk-line" />
      <span>{{ t('fw.risk') }}</span>
    </label>
    <p v-if="busyText" class="fw-busy" role="status">{{ busyText }}</p>
  </template>
  <template v-else-if="waiting">
    <p class="fw-wait" role="status"><span class="fw-spin" aria-hidden="true" />{{ t('fw.s2.wait') }}</p>
    <template v-if="fw.phase === 'needPermission'">
      <p class="fws__p">{{ t('fw.s2.perm') }}</p>
      <div><Button variant="primary" :icon="IconUsb" @click="fw.allow()">{{ t('fw.s2.permBtn') }}</Button></div>
      <p v-if="fw.wrongDevice" class="fw-err" role="alert">
        <IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.s2.wrongDevice') }}</span>
      </p>
    </template>
  </template>
  <template v-else-if="fw.phase === 'manyBoot'">
    <p class="fw-err" role="alert"><IconAlertCircle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ err }}</span></p>
    <div><Button variant="primary" :icon="IconRefresh" @click="fw.findAgain()">{{ t('fw.findAgain') }}</Button></div>
  </template>
</template>

<style scoped>
.fws__p { margin: 0; font-size: var(--fs-label); line-height: 20px; color: var(--fg-2); }
.fw-confirm { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--s-3); }
.fw-field { display: flex; flex-direction: column; gap: 6px; min-width: 220px; flex: 1 1 260px; }
.fw-field label { font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); }
.fw-field label code { font-family: var(--font-mono, ui-monospace, monospace); color: var(--fg-1); }
.fw-input {
  height: 36px; padding: 0 12px; border: 1px solid var(--line-3); border-radius: var(--r-control); background: var(--bg-1);
  color: var(--fg-1); font: inherit; font-size: var(--fs-body);
}
.fw-input:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.fw-input--ok { border-color: var(--ok); }
.fw-risk { display: flex; align-items: center; gap: var(--s-2); font-size: var(--fs-label); color: var(--fg-1); cursor: pointer; }
.fw-risk input { width: 16px; height: 16px; margin: 0; accent-color: var(--acc); }
.fw-busy { margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--warn); }
.fw-wait { display: flex; gap: 10px; align-items: center; margin: 0; font-size: var(--fs-label); color: var(--fg-1); }
.fw-spin { flex: none; width: 16px; height: 16px; border: 2px solid var(--line-3); border-top-color: var(--acc); border-radius: 50%; animation: fw-spin 0.9s linear infinite; }
@keyframes fw-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .fw-spin { animation: none; border-right-color: var(--acc); } }
.fw-err {
  display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control);
  background: var(--danger-soft); color: var(--danger); font-size: var(--fs-label); line-height: 18px;
}
.fw-err svg { flex: none; margin-top: 1px; }
.fw-err span { min-width: 0; overflow-wrap: anywhere; }
</style>
