<script setup lang="ts">
// Firmware page (DESIGN FW §1, §2, §3.1): three step cards (file → update mode → write) and a side column (the keyboard, notes).
// AE64 Pro only; on an AE64 Max the page is view-only (a banner, no steps, no command). Behind the labs switch (router guard),
// except rescue mode. Opening the page, choosing a file and typing the confirmation send nothing to the keyboard.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  IconAlertTriangle, IconCircleCheck, IconCircleX, IconCheck, IconDatabaseExport, IconLifebuoy, IconPlugConnected, IconTarget,
} from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import { CLOSE_BLOCKED_EVENT, forceWindowClose } from '../data/desktopClose';
import CopyInfo from '../components/settings/CopyInfo.vue';
import FwBanner from '../components/firmware/FwBanner.vue';
import FwFileStep from '../components/firmware/FwFileStep.vue';
import FwEnterStep from '../components/firmware/FwEnterStep.vue';
import FwWriteStep from '../components/firmware/FwWriteStep.vue';
import { FW_BOARD_MAX, FW_BOARD_PRO, boardHex } from '../protocol/firmware';
import { useDeviceStore } from '../stores/device';
import { useFirmwareStore } from '../stores/firmware';
import type { FwPhase } from '../stores/firmware';
import { t } from '../i18n/vi';

type StepState = 'todo' | 'now' | 'done' | 'fail';

const device = useDeviceStore();
const fw = useFirmwareStore();

const board = computed(() => fw.deviceBoard);
const isMax = computed(() => !fw.rescue && board.value === FW_BOARD_MAX);
const inBoot = computed(() => fw.rescue || ['writing', 'packetFail', 'verifying', 'verifyFail', 'rebooting', 'lost'].includes(fw.phase));

const ENTER: FwPhase[] = ['preflight', 'entering', 'needPermission'];
const WRITE_NOW: FwPhase[] = ['writing', 'verifying', 'rebooting', 'finding', 'rescue'];
const WRITE_FAIL: FwPhase[] = ['packetFail', 'verifyFail', 'lost', 'notFound', 'manyApp', 'versionMismatch', 'noGamepad'];
const WRITE_DONE: FwPhase[] = ['done', 'doneUnknown'];

const s1 = computed<StepState>(() => {
  if (fw.active && !fw.rescue) return 'done';
  if (!fw.file) return 'now';
  return fw.fileOk && !fw.rescueRefused ? 'done' : 'fail';
});
const s2 = computed<StepState>(() => {
  const p = fw.phase;
  if (fw.rescue || WRITE_NOW.includes(p) || WRITE_FAIL.includes(p) || WRITE_DONE.includes(p)) return 'done';
  if (p === 'preflightFail' || p === 'enterFail' || p === 'manyBoot') return 'fail';
  if (ENTER.includes(p)) return 'now';
  return fw.fileOk ? 'now' : 'todo';
});
const s3 = computed<StepState>(() => {
  const p = fw.phase;
  if (WRITE_DONE.includes(p)) return 'done';
  if (WRITE_FAIL.includes(p)) return 'fail';
  if (WRITE_NOW.includes(p)) return 'now';
  return 'todo';
});
const steps = computed(() => [
  { n: 1, state: s1.value, title: t('fw.s1') },
  { n: 2, state: s2.value, title: t('fw.s2') },
  { n: 3, state: s3.value, title: t('fw.s3') },
]);
const stIcon = (s: StepState) => (s === 'done' ? IconCircleCheck : s === 'fail' ? IconCircleX : null);

// ---- the step that changed gets focus and comes into view (DESIGN FW §2): 1→2, 2→3, a failure, done
const stepEls = ref<Record<number, HTMLElement | null>>({});
const banner = ref<InstanceType<typeof FwBanner> | null>(null);
/** The step to show: the last one that is running or failed; null on the page's first state (nothing is moved then). */
const focusKey = computed(() => {
  if (WRITE_DONE.includes(fw.phase)) return 'done';
  const list = [s1.value, s2.value, s3.value];
  for (let i = 2; i >= 0; i--) if (list[i] === 'now' || list[i] === 'fail') return `${i + 1}:${list[i]}:${fw.phase}`;
  return null;
});
watch(focusKey, async (k, old) => {
  if (!k || k === old) return;
  // Choosing a file in step 1 moves to step 2 only once the file passed; typing in step 2 never moves the focus.
  await nextTick();
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduce ? 'instant' : 'smooth';
  if (k === 'done') {
    banner.value?.focus(behavior);
    return;
  }
  const n = Number(k[0]);
  const card = stepEls.value[n];
  const h = card?.querySelector<HTMLElement>('h3.fws__t');
  card?.scrollIntoView?.({ block: 'nearest', behavior });
  h?.focus({ preventScroll: true });
});

const bannerKind = computed(() => {
  if (isMax.value) return 'max' as const;
  if (fw.rescue) return fw.rescueBoard === null ? 'noBoard' as const : 'rescue' as const;
  if (fw.phase === 'done') return 'done' as const;
  if (fw.phase === 'doneUnknown') return 'doneUnknown' as const;
  return null;
});

// ---- side: the keyboard
const model = computed(() => {
  if (fw.rescue) return board.value === FW_BOARD_PRO ? 'AE64 Pro' : '—';
  return device.modelName ?? '—';
});
const boardText = computed(() => (board.value === null ? '—' : boardHex(board.value)));
const firmware = computed(() => (inBoot.value ? '—' : device.info?.firmware ?? '—'));

// ---- the desktop app: closing the window while a session runs asks first (DESIGN FW §3.4)
const closeAsk = ref(false);
const onCloseBlocked = (): void => { closeAsk.value = fw.active; };
onMounted(() => window.addEventListener(CLOSE_BLOCKED_EVENT, onCloseBlocked));
onBeforeUnmount(() => window.removeEventListener(CLOSE_BLOCKED_EVENT, onCloseBlocked));
watch(() => fw.active, (on) => { if (!on) closeAsk.value = false; });
function closeAnyway(): void {
  closeAsk.value = false;
  forceWindowClose();
}
</script>

<template>
  <PageLayout :title="t('page.firmware')">
    <section class="fw">
      <div class="fw__main">
        <div class="fw-head">
          <div>
            <h2 class="fw-head__t">{{ t('fw.title') }} <span class="fw-lab">{{ t('fw.lab') }}</span></h2>
            <p class="fw-head__s">{{ t('fw.sub') }}</p>
            <!-- PLAN §M: on the site behind the labs switch until one real write has worked -->
            <p class="fw-untested"><IconAlertTriangle :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ t('fw.untested') }}</span></p>
          </div>
        </div>
        <FwBanner v-if="bannerKind" ref="banner" :kind="bannerKind" />
        <ol v-if="!isMax" class="fw-steps">
          <li v-for="s in steps" :key="s.n" :ref="(el) => { stepEls[s.n] = el as HTMLElement | null }">
            <Card class="fws" :class="`fws--${s.state}`" :aria-labelledby="`fws-${s.n}`">
              <div class="fws__head">
                <span class="fws__n" aria-hidden="true">
                  <IconCheck v-if="s.state === 'done'" :size="15" stroke-width="2.5" />
                  <template v-else>{{ s.n }}</template>
                </span>
                <h3 :id="`fws-${s.n}`" class="fws__t" tabindex="-1">
                  <span class="sr-only">{{ t('fw.stepOf', { n: s.n }) }}: </span>{{ s.title }}
                </h3>
                <span class="fws__st">
                  <component :is="stIcon(s.state)" v-if="stIcon(s.state)" :size="15" stroke-width="1.75" aria-hidden="true" />
                  {{ t(`fw.st.${s.state}`) }}
                </span>
              </div>
              <div class="fws__body">
                <FwFileStep v-if="s.n === 1" />
                <FwEnterStep v-else-if="s.n === 2" />
                <FwWriteStep v-else />
              </div>
            </Card>
          </li>
        </ol>
      </div>
      <div class="fw__side">
        <Card class="fw-dev" :title="t('fw.dev.title')">
          <template #actions><CopyInfo /></template>
          <dl class="fw-dl">
            <dt>{{ t('fw.dev.model') }}</dt><dd>{{ model }}</dd>
            <dt>{{ t('fw.dev.board') }}</dt><dd>{{ boardText }}</dd>
            <dt>{{ t('fw.dev.version') }}</dt><dd>{{ firmware }}</dd>
            <dt>{{ t('fw.dev.mode') }}</dt><dd :class="{ boot: inBoot }">{{ t(inBoot ? 'fw.dev.modeBoot' : 'fw.dev.modeApp') }}</dd>
          </dl>
        </Card>
        <Card class="fw-note" :title="t('fw.note.title')">
          <ul class="fw-notes">
            <li>
              <IconDatabaseExport :size="16" stroke-width="1.5" aria-hidden="true" />
              <span>{{ t('fw.note.backup') }}
                <RouterLink v-if="!fw.active" :to="{ path: '/diagnostics', query: { focus: 'backup' } }">{{ t('fw.note.backupLink') }} →</RouterLink>
              </span>
            </li>
            <li><IconTarget :size="16" stroke-width="1.5" aria-hidden="true" /><span>{{ t('fw.note.calib') }}</span></li>
            <li><IconPlugConnected :size="16" stroke-width="1.5" aria-hidden="true" /><span>{{ t('fw.note.cable') }}</span></li>
            <li><IconLifebuoy :size="16" stroke-width="1.5" aria-hidden="true" /><span>{{ t('fw.note.rescue') }}</span></li>
          </ul>
        </Card>
      </div>
    </section>
  </PageLayout>
  <Dialog v-model:open="closeAsk" :title="t(fw.rescue ? 'fw.pillRescue' : 'fw.pill')" :width="440" describe>
    <p>{{ t('fw.s3.dont') }}</p>
    <template #footer>
      <Button variant="primary" @click="closeAsk = false">{{ t('fw.closeStay') }}</Button>
      <Button variant="danger" @click="closeAnyway">{{ t('fw.closeAnyway') }}</Button>
    </template>
  </Dialog>
</template>

<style scoped>
.fw { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: var(--s-4); align-items: start; width: 100%; max-width: 1200px; margin: 0 auto; }
.fw__main, .fw__side { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
/* one column: page head first, then the two side cards side by side (read before step 1), then the steps */
@media (max-width: 1100px) {
  .fw { grid-template-columns: minmax(0, 1fr); }
  .fw__main { display: contents; }
  .fw-head { order: -2; }
  .fw__side { order: -1; display: grid; grid-template-columns: 1fr 1fr; align-items: start; }
}
@media (max-width: 860px) { .fw__side { grid-template-columns: minmax(0, 1fr); } }

.fw-head { display: flex; align-items: center; gap: var(--s-3); }
.fw-head__t { margin: 0; font-size: var(--fs-section); font-weight: 600; color: var(--fg-1); }
.fw-head__s { margin: 2px 0 0; font-size: var(--fs-label); color: var(--fg-2); }
.fw-untested {
  display: flex; gap: 8px; align-items: flex-start; margin: var(--s-2) 0 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control);
  background: color-mix(in srgb, var(--warn) 14%, transparent); color: var(--fg-1); font-size: var(--fs-label); line-height: 18px;
}
.fw-untested svg { flex: none; margin-top: 1px; color: var(--warn); }
.fw-lab {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; margin-left: 4px; vertical-align: 2px;
  border: 1px solid var(--line-3); border-radius: 999px; font-size: var(--fs-caption); font-weight: 600; color: var(--fg-2);
}

.fw-steps { display: flex; flex-direction: column; gap: var(--s-4); margin: 0; padding: 0; list-style: none; }
.fws__head { display: flex; align-items: center; gap: var(--s-3); }
.fws__n {
  flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; border: 1px solid var(--line-3);
  font-size: var(--fs-label); font-weight: 700; color: var(--fg-2); font-variant-numeric: tabular-nums;
}
.fws--now .fws__n { border-color: var(--acc); background: var(--acc); color: var(--on-acc); }
.fws--done .fws__n { border-color: var(--ok); color: var(--ok); }
.fws--fail .fws__n { border-color: var(--danger); color: var(--danger); }
.fws__t { margin: 0; font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
.fws__t:focus { outline: none; }
.fws__t:focus-visible { box-shadow: var(--focus-ring); border-radius: 4px; }
.fws__st { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-label); font-weight: 600; color: var(--fg-3); white-space: nowrap; }
.fws--now .fws__st { color: var(--fg-1); }
.fws--done .fws__st { color: var(--ok); }
.fws--fail .fws__st { color: var(--danger); }
.fws--todo .fws__t { color: var(--fg-2); }
.fws__body { margin-top: var(--s-4); display: flex; flex-direction: column; gap: var(--s-3); }
.fws__body:empty { display: none; }

.fw-dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px var(--s-4); margin: 0; font-size: var(--fs-label); }
.fw-dl dt { color: var(--fg-2); }
.fw-dl dd { margin: 0; color: var(--fg-1); font-weight: 600; font-variant-numeric: tabular-nums; text-align: right; overflow-wrap: anywhere; }
.fw-dl dd.boot { color: var(--warn); }
.fw-notes { display: flex; flex-direction: column; gap: 10px; margin: 0; padding: 0; list-style: none; }
.fw-notes li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 8px; font-size: var(--fs-label); line-height: 18px; color: var(--fg-2); }
.fw-notes li svg { margin-top: 1px; color: var(--fg-3); }
.fw-notes a { color: var(--acc); font-weight: 600; text-decoration: none; }
.fw-notes a:hover { text-decoration: underline; text-underline-offset: 3px; }
</style>
