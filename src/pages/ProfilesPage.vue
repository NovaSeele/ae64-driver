<script setup lang="ts">
// Profile (DESIGN G): the keyboard's four onboard profiles as cards (switch, rename in place, two summary figures) and a
// compare of two profiles opened this session. The keyboard only lets the app read the active profile, so another profile's
// figures are the snapshot taken when the app left it (performance store, §3.7). Viewing, picking A/B, filtering and
// scrolling send nothing; the only writes are "Use this profile" (switchProfile) and "Save" (renameProfile), as in the sidebar.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { IconLock } from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import ProfileCard from '../components/profiles/ProfileCard.vue';
import ProfileCompare from '../components/profiles/ProfileCompare.vue';
import type { CompareProfile } from '../components/profiles/ProfileCompare.vue';
import { useToast } from '../components/ui/toast';
import { useCalibrationStore } from '../stores/calibration';
import { useDeviceStore } from '../stores/device';
import { usePerformanceStore } from '../stores/performance';
import { locale } from '../i18n/locale';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const perf = usePerformanceStore();
const calibration = useCalibrationStore();
const toast = useToast();

// ----- data (§3.2): the active profile is read once (cached); a switch from anywhere reads the new one
let offProfile: (() => void) | undefined;
onMounted(() => {
  offProfile = device.onProfileChanged(() => void perf.load(true));
  void perf.load();
});
onBeforeUnmount(() => offProfile?.());

/** The active profile's records are read and are its own. */
const activeLoaded = computed(() =>
  !perf.loading && !perf.loadError && perf.loadedProfile === device.activeProfile && Object.keys(perf.values).length > 0);
/** The active profile's read: running (or about to), failed, or done (null). */
const read = computed<'loading' | 'error' | null>(() => (activeLoaded.value ? null : perf.loadError && !perf.loading ? 'error' : 'loading'));

/** Live values for the active profile once read; otherwise the snapshot taken when the app left the profile, if any. */
function valuesOf(i: number) {
  if (i === device.activeProfile && activeLoaded.value) return perf.values;
  return perf.profileSnapshots.get(i)?.values ?? null;
}
const atOf = (i: number) => (i === device.activeProfile ? null : perf.profileSnapshots.get(i)?.at ?? null);
const timeFmt = computed(() => new Intl.DateTimeFormat(locale.value, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }));
function whenOf(i: number): string {
  if (i === device.activeProfile) return t('pf.liveData');
  const at = atOf(i);
  return at === null ? '' : t('pf.dataAt', { time: timeFmt.value.format(at) });
}
const names = computed(() => device.profileNames.map((n, i) => n || `${t('device.profile')} ${i + 1}`));
const profiles = computed<CompareProfile[]>(() => names.value.map((name, i) => ({ index: i, name, values: valuesOf(i), when: whenOf(i) })));

// ----- switching and renaming (§3.3–§3.5)
/** Same rule as the sidebar's ProfileSelect: no other write while the keyboard calibrates. */
const calibrating = computed(() => calibration.phase !== 'idle' || device.calibrationLocked());
const switching = ref<number | null>(null);
/** No switch (≈ 70 commands) queued behind a 64-key read, nothing during calibration or another switch. */
const busy = computed(() => calibrating.value || switching.value !== null || perf.loading);
const editing = ref<number | null>(null);

async function use(i: number) {
  if (busy.value || i === device.activeProfile) return;
  switching.value = i;
  try {
    await device.switchProfile(i);
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    switching.value = null;
  }
  // The card's button became the "Active" line: keep keyboard users on that card (its h3), not at the top of the page.
  if (device.activeProfile === i) {
    await nextTick();
    document.getElementById(`pf-name-${i}`)?.focus();
  }
}
</script>

<template>
  <PageLayout :title="t('page.profiles')">
    <div class="pf">
      <section class="pfs" aria-labelledby="pf-title">
        <div class="pf__head">
          <h2 id="pf-title" class="pf__title">{{ t('pf.cardsTitle') }}</h2>
          <p class="pf__sub">{{ t('pf.cardsSub') }}</p>
        </div>
        <p v-if="calibrating" class="pfs__lock" role="status">
          <IconLock :size="15" stroke-width="1.75" aria-hidden="true" />
          <span>{{ t('pf.locked') }}</span>
        </p>
        <ul class="pfs__grid">
          <li v-for="p in profiles" :key="p.index">
            <ProfileCard
              :index="p.index"
              :name="p.name"
              :active="p.index === device.activeProfile"
              :values="p.values"
              :at="atOf(p.index)"
              :read="p.index === device.activeProfile ? read : null"
              :loaded-count="perf.loadedCount"
              :busy="busy"
              :switching="switching === p.index"
              :calibrating="calibrating"
              :can-rename="device.boardAllowed"
              :editing="editing === p.index"
              @use="use(p.index)"
              @edit="editing = p.index"
              @close="editing = null"
            />
          </li>
        </ul>
      </section>

      <section class="cmp" aria-labelledby="cmp-title">
        <div class="pf__head">
          <h2 id="cmp-title" class="pf__title">{{ t('cmp.title') }}</h2>
          <p class="pf__sub">{{ t('cmp.sub') }}</p>
        </div>
        <ProfileCompare :profiles="profiles" :active="device.activeProfile" :read="read" :loaded-count="perf.loadedCount" @reload="perf.load(true)" />
        <p class="cmp__note">{{ t('cmp.rtNote') }} {{ t('cmp.notCompared') }}</p>
      </section>
    </div>
  </PageLayout>
</template>

<style scoped>
/* One centred column, the same edges as the Overview and the keyboard frame of the Performance page: 940 px, 1100 px from 1600 px. */
.pf { display: flex; flex-direction: column; gap: var(--s-6); width: 100%; max-width: 940px; margin: 0 auto; container-type: inline-size; }
@media (min-width: 1600px) { .pf { max-width: 1100px; } }

/* Section head shared by both sections (= the Overview's keyboard head: title 16/600 + caption). */
.pf__head { display: flex; flex-direction: column; gap: 2px; }
.pf__title { margin: 0; font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); }
.pf__sub { margin: 0; max-width: 72ch; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }

/* G1. The four profiles on the keyboard. */
.pfs { display: flex; flex-direction: column; gap: var(--s-3); }
.pfs__lock { display: flex; align-items: flex-start; gap: 6px; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control); background: var(--warn-soft); color: var(--warn); font-size: var(--fs-label); line-height: 18px; }
.pfs__lock svg { flex: none; margin-top: 1px; }
.pfs__grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-3); margin: 0; padding: 0; list-style: none; }
.pfs__grid > li { display: flex; min-width: 0; }
@container (max-width: 759.98px) { .pfs__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* G2. Compare: drawn like Card, not the Card component (its title is an h3; this one is an h2 beside G1's). */
.cmp { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; padding: var(--s-5); background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--r-card); }
.cmp__note { margin: 0; font-size: var(--fs-caption); color: var(--fg-3); }
</style>
