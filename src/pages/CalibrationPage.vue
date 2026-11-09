<script setup lang="ts">
// Calibrate (DESIGN §6.7): explain the steps, confirm, enter calibration mode (02 06 00), show live
// per-key status / travel / ADC while the user bottoms out every key, then finish (02 06 01 + commit 1)
// or cancel. Leaving the page mid-session always takes the keyboard out of calibration mode.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave } from 'vue-router';
import { IconAlertTriangle, IconCheck, IconPlayerPlay, IconRefresh, IconX } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import { attachDemoPress } from '../components/live/demoPress';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import { useToast } from '../components/ui/toast';
import { useDeviceStore } from '../stores/device';
import { DEFAULT_RANGE_MM, usePerformanceStore } from '../stores/performance';
import { useCalibrationStore } from '../stores/calibration';
import type { MockTransport, PhysicalKey } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const perf = usePerformanceStore();
const cal = useCalibrationStore();
const toast = useToast();

const confirmOpen = ref(false);
const running = computed(() => cal.phase === 'running');
const busy = computed(() => cal.phase === 'starting' || cal.phase === 'finishing');
let unmounted = false;

/**
 * Status is shown by the key's LED bar, the same thickness for all three states (user's choice). Not calibrated =
 * full --danger; calibrated = info blue; newly calibrated = green pushed toward the text colour (lighter on dark
 * themes, darker on light ones) and its key is fully filled. Each key's accessible name also carries the status
 * text, so the state is not colour-only.
 */
const STATUS_COLOR = ['var(--danger)', 'var(--info)', 'color-mix(in srgb, var(--ok) 60%, var(--fg-1))'];
/** Status bar thickness on every key and in the legend. */
const LED_PX = 5;
const STATUS_TEXT = ['calibration.legendNone', 'calibration.legendDone', 'calibration.legendNew'] as const;
// Until a real frame is read every status would be 0 ("uncalibrated"): show neutral keys instead.
const statusColor = (k: PhysicalKey) => (cal.loaded ? STATUS_COLOR[cal.frame.status[k.id]] ?? STATUS_COLOR[0] : 'var(--fg-4)');
const statusText = (k: PhysicalKey) => (cal.loaded ? t(STATUS_TEXT[cal.frame.status[k.id]] ?? STATUS_TEXT[0]) : undefined);
function fill(k: PhysicalKey) {
  if (!cal.loaded) return 0;
  if (cal.frame.status[k.id] === 2) return 1;
  const max = perf.values[k.id]?.axisRangeMax || DEFAULT_RANGE_MM * 1000;
  return Math.min(1, cal.frame.route[k.id] / max);
}
const adc = (k: PhysicalKey) => (cal.loaded ? String(cal.frame.adc[k.id]) : undefined);

const progress = computed(() => (running.value ? cal.newCount : cal.calibratedCount));
const legend = computed(() => [
  { color: STATUS_COLOR[0], label: t('calibration.legendNone'), n: cal.uncalibratedCount },
  { color: STATUS_COLOR[1], label: t('calibration.legendDone'), n: cal.calibratedCount - cal.newCount },
  { color: STATUS_COLOR[2], label: t('calibration.legendNew'), n: cal.newCount },
]);
const allDone = computed(() => cal.loaded && !running.value && cal.calibratedCount === 64);
/** Failure text for a session that ended badly: says whether the keyboard may still be calibrating. */
const sessionError = computed(() =>
  cal.error ? `${t('calibration.failed', { error: cal.error })} ${cal.stopFailed ? t('calibration.stopFailed') : t('calibration.stoppedNotSaved')}` : null,
);
const loadError = computed(() => (cal.error && !cal.loaded ? t('calibration.loadFailed', { error: cal.error }) : null));

async function begin() {
  confirmOpen.value = false;
  await cal.start();
  if (unmounted) await cal.cancel();
  else if (cal.error) toast.show(sessionError.value ?? '', 'error');
}
async function finish() {
  if (cal.newCount === 0 && !window.confirm(t('calibration.confirmEmpty'))) return;
  const ok = await cal.finish();
  if (ok) toast.show(t('calibration.saved'), 'success');
  else toast.show(sessionError.value ?? '', 'error');
}
async function cancel() {
  const ok = await cal.cancel();
  if (ok) toast.show(t('calibration.cancelled'), 'info');
  else toast.show(`${t('calibration.cancelFailed', { error: cal.error ?? '' })} ${cal.stopFailed ? t('calibration.stopFailed') : ''}`.trim(), 'error');
}

// Leaving mid-session stops calibration without saving (onBeforeUnmount): ask first.
onBeforeRouteLeave(() => (running.value ? window.confirm(t('calibration.confirmLeave')) : true));

// demo: PC keyboard presses bottom out the matching key
let detachDemo: (() => void) | null = null;
watch(() => device.demo && device.transport?.kind === 'mock', (on) => {
  detachDemo?.();
  detachDemo = on ? attachDemoPress(device.transport as MockTransport) : null;
}, { immediate: true });

function warnLeave(e: BeforeUnloadEvent) {
  if (cal.phase !== 'idle') e.preventDefault();
}

let offProfile: (() => void) | null = null;
onMounted(() => {
  void perf.load();
  void cal.refresh();
  offProfile = device.onProfileChanged(() => void cal.refresh());
  window.addEventListener('beforeunload', warnLeave);
});
onBeforeUnmount(() => {
  unmounted = true;
  // Never leave the keyboard in calibration mode (no commit: leaving is not "Hoàn tất").
  if (running.value) void cal.cancel();
  offProfile?.();
  detachDemo?.();
  window.removeEventListener('beforeunload', warnLeave);
});
</script>

<template>
  <PageLayout :title="t('page.calibration')">
    <section class="kbrow">
      <div class="board" :class="{ 'board--live': running }">
        <KeyboardView :keys="device.keys" :legend="device.legend" :sublabel="adc" :fill="fill" :color="statusColor" :led-height="LED_PX" :status="statusText" />
      </div>
      <aside class="aside">
        <span class="micro">{{ t('calibration.status') }}</span>
        <ul class="legend">
          <li v-for="l in legend" :key="l.label">
            <i :style="{ background: l.color, boxShadow: `0 0 8px ${l.color}`, height: `${LED_PX}px` }" />
            <span>{{ l.label }}</span>
            <span class="num">{{ cal.loaded ? l.n : '—' }}</span>
          </li>
        </ul>
        <p class="hint">{{ t('calibration.adcHint') }}</p>
      </aside>
    </section>

    <div class="grid">
      <Card :title="t('page.calibration')" :subtitle="t('calibration.intro')">
        <span class="micro">{{ t('calibration.steps') }}</span>
        <ol class="steps">
          <li :class="{ done: running }"><span class="steps__n num">1</span>{{ t('calibration.step1') }}</li>
          <li :class="{ now: running }"><span class="steps__n num">2</span>{{ t('calibration.step2') }}</li>
          <li><span class="steps__n num">3</span>{{ t('calibration.step3') }}</li>
        </ol>
        <p v-if="sessionError && cal.phase === 'idle'" class="alert" role="alert"><IconAlertTriangle :size="14" />{{ sessionError }}</p>
        <p v-if="!device.boardAllowed" class="warn">{{ t('calibration.readOnly') }}</p>
        <p v-if="device.demo" class="hint">{{ t('calibration.demoHint') }}</p>
        <div class="actions">
          <template v-if="running || cal.phase === 'finishing'">
            <Button variant="primary" :icon="IconCheck" :loading="cal.phase === 'finishing'" @click="finish">{{ t('calibration.finish') }}</Button>
            <Button variant="ghost" :icon="IconX" :disabled="busy" @click="cancel">{{ t('calibration.cancel') }}</Button>
          </template>
          <Button
            v-else
            variant="primary"
            :icon="IconPlayerPlay"
            :loading="cal.phase === 'starting'"
            :disabled="!device.boardAllowed"
            @click="confirmOpen = true"
          >
            {{ t('calibration.start') }}
          </Button>
        </div>
      </Card>

      <Card class="progress">
        <div v-if="loadError" class="alert" role="alert">
          <IconAlertTriangle :size="14" />
          <span>{{ loadError }}</span>
          <Button size="sm" variant="ghost" :icon="IconRefresh" @click="cal.refresh()">{{ t('calibration.retry') }}</Button>
        </div>
        <p v-else-if="!cal.loaded" class="hint" role="status">{{ t('calibration.loading') }}</p>
        <p v-if="running" class="running" role="status"><span class="pulse" />{{ t('calibration.running') }}</p>
        <div class="big num">{{ cal.loaded ? progress : '—' }}<span class="of">/64</span></div>
        <p v-if="cal.loaded" class="sub">{{ running ? t('calibration.progressSession', { n: progress }) : t('calibration.progress', { n: progress }) }}</p>
        <div class="bar" :class="{ 'bar--new': running }"><span :style="{ transform: `scaleX(${cal.loaded ? progress / 64 : 0})` }" /></div>
        <p v-if="allDone" class="done" role="status"><IconCheck :size="14" />{{ t('calibration.allDone') }}</p>
        <p v-else-if="cal.loaded && !running && cal.uncalibratedCount > 0" class="warn">{{ t('calibration.uncalibrated', { n: cal.uncalibratedCount }) }}</p>
      </Card>
    </div>

    <Dialog v-model:open="confirmOpen" :title="t('calibration.confirmTitle')">
      <p class="dlg-body">{{ t('calibration.confirmBody') }}</p>
      <template #footer>
        <Button variant="ghost" @click="confirmOpen = false">{{ t('calibration.cancel') }}</Button>
        <Button variant="primary" :icon="IconPlayerPlay" @click="begin">{{ t('calibration.start') }}</Button>
      </template>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.kbrow { display: flex; gap: var(--s-5); align-items: flex-start; margin-bottom: var(--s-4); }
.board { flex: 1; min-width: 0; max-width: 940px; margin: 0 auto; border-radius: var(--r-panel); transition: box-shadow var(--t-slow) var(--ease); }
.board--live { box-shadow: 0 0 0 1px var(--acc-line); }
.aside { flex: none; width: 188px; display: flex; flex-direction: column; gap: var(--s-2); }
.legend { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.legend li { display: flex; align-items: center; gap: var(--s-2); font-size: var(--fs-label); color: var(--fg-2); }
.legend li i { width: 12px; border-radius: 2px; flex: none; }
.legend li .num { margin-left: auto; color: var(--fg-1); font-weight: 600; }
.hint { color: var(--fg-3); font-size: var(--fs-label); }
.warn { color: var(--warn); font-size: var(--fs-label); }
.alert {
  display: flex;
  gap: 6px;
  align-items: flex-start;
  margin: var(--s-2) 0 0;
  padding: var(--s-2) var(--s-3);
  border-radius: var(--r-control);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--fs-label);
}
.alert svg { flex: none; margin-top: 1px; }
.done { display: flex; align-items: center; gap: 6px; color: var(--ok); font-size: var(--fs-label); }

@media (max-width: 1360px) {
  .kbrow { flex-direction: column-reverse; align-items: stretch; }
  .board { width: 100%; }
  .aside { width: auto; flex-direction: row; flex-wrap: wrap; align-items: center; gap: var(--s-4); }
  .legend { flex-direction: row; gap: var(--s-4); }
}

.grid { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(260px, 1fr); gap: var(--s-4); align-items: start; }
@media (max-width: 1100px) { .grid { grid-template-columns: 1fr; } }

.steps { list-style: none; margin: var(--s-2) 0 var(--s-4); padding: 0; display: flex; flex-direction: column; gap: var(--s-3); }
.steps li { display: flex; gap: var(--s-3); align-items: flex-start; color: var(--fg-2); transition: color var(--t-fast) var(--ease); }
.steps__n {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  font-size: var(--fs-caption);
  font-weight: 600;
  border: 1px solid var(--line-2);
  color: var(--fg-3);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.steps li.done { color: var(--fg-3); }
.steps li.done .steps__n { background: var(--bg-4); }
.steps li.now { color: var(--fg-1); }
.steps li.now .steps__n { background: var(--acc); border-color: var(--acc); color: var(--on-acc); }
.actions { display: flex; gap: var(--s-2); margin-top: var(--s-4); }

.progress { display: flex; flex-direction: column; gap: var(--s-2); }
.running { display: flex; align-items: center; gap: var(--s-2); color: var(--acc); font-size: var(--fs-label); font-weight: 500; }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--acc); animation: pulse 1.4s var(--ease) infinite; }
@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .pulse { animation: none; } }
.big { font-size: 56px; font-weight: 600; letter-spacing: -0.03em; line-height: 1; }
.big .of { font-size: var(--fs-hero); color: var(--fg-3); font-weight: 500; letter-spacing: 0; }
.sub { color: var(--fg-2); }
.bar { height: 6px; border-radius: 3px; background: var(--bg-4); overflow: hidden; margin-top: var(--s-2); }
.bar span { display: block; height: 100%; background: var(--info); transform-origin: left; transition: transform var(--t-slow) var(--ease); }
.bar--new span { background: var(--ok); }
.dlg-body { color: var(--fg-2); line-height: 1.55; }
</style>
