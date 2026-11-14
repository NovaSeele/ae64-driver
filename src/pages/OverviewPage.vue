<script setup lang="ts">
// Tổng quan (DESIGN F): the start page. A read-only summary of the connected keyboard and its active profile — header,
// four tiles, the keyboard as a heatmap of the actuation points (the Travel tab's Actuation view with the depth fill on),
// shortcuts, the device line. It only reads (perf.load(), settings.load(), both cached); a key click opens that key in
// the Travel tab. No leave guard: nothing on this page can be in progress.
import { computed, onBeforeUnmount, onMounted } from 'vue';
import type { Component } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import type { RouteLocationRaw } from 'vue-router';
import {
  IconActivity, IconAdjustmentsHorizontal, IconAlertTriangle, IconArrowRight, IconBolt, IconBulb, IconCircleCheck,
  IconKeyboard, IconListDetails, IconPencil, IconRefresh, IconSettings, IconStack2, IconTarget,
} from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import KeyboardView from '../components/keyboard/KeyboardView.vue';
import SelectionLegend from '../components/keyboard/SelectionLegend.vue';
import { legendSentence } from '../components/keyboard/SelectionBar.vue';
import StatTile from '../components/overview/StatTile.vue';
import Button from '../components/ui/Button.vue';
import Card from '../components/ui/Card.vue';
import { useDeviceStore } from '../stores/device';
import { usePerformanceStore } from '../stores/performance';
import { useSettingsStore } from '../stores/settings';
import { useSelectionStore } from '../stores/selection';
import { POLLING_RATE_HZ } from '../protocol';
import type { PhysicalKey } from '../protocol';
import { actuationStats, rtCount } from '../data/overviewStats';
import {
  actBadge, actBadgeIcon, actBadgeTitle, actFill, actSublabel, actuationLegend, capDecimals, fmtMm, uncalFlagFor,
} from '../data/keycapActuation';
import { t } from '../i18n/vi';
import type { MessageKey } from '../i18n/vi';

const device = useDeviceStore();
const perf = usePerformanceStore();
const settings = useSettingsStore();
const sel = useSelectionStore();
const router = useRouter();

/** Part G (the Profiles page) is in the app: the header button, the Profile tile link and the 8th shortcut. */
const hasProfiles = router.hasRoute('profiles');
const PROFILES: RouteLocationRaw = { name: 'profiles' };
const TRAVEL: RouteLocationRaw = { path: '/performance', query: { tab: 'travel' } };
const CALIBRATION: RouteLocationRaw = { path: '/performance', query: { tab: 'calibration' } };

// ----- data (DESIGN F §3.10): the keyboard first, then the device settings; both cached, so a return reads nothing
let offProfile: (() => void) | undefined;
onMounted(async () => {
  offProfile = device.onProfileChanged(() => void perf.load(true));
  await perf.load();
  if (!settings.loaded && !settings.loading) void settings.load();
});
onBeforeUnmount(() => offProfile?.());

const decimals = computed(() => capDecimals(device.rtPrecision));
/** The profile's records are all read (not loading, not failed). Until then the three tiles show "—". */
const loaded = computed(() => !perf.loading && !perf.loadError && Object.keys(perf.values).length > 0);
const waitText = computed(() => (perf.loadError ? t('ov.notRead') : t('ov.reading')));
const total = computed(() => device.keys.length);

// ----- tiles (§3.3, §3.4)
const stats = computed(() => (loaded.value ? actuationStats(perf.values, decimals.value) : null));
const actValue = computed(() => {
  const s = stats.value;
  if (!s) return null;
  return s.min === s.max
    ? t('ov.actOne', { v: fmtMm(s.min, decimals.value) })
    : t('ov.actRange', { min: fmtMm(s.min, decimals.value), max: fmtMm(s.max, decimals.value) });
});
const actSub = computed(() => {
  const s = stats.value;
  if (!s) return '';
  return s.modeCount === s.count ? t('ov.actAll', { n: s.count }) : t('ov.actMost', { v: fmtMm(s.mode, decimals.value), n: s.modeCount });
});
const rt = computed(() => rtCount(perf.values));
const rtWidth = computed(() => `${total.value ? (100 * rt.value) / total.value : 0}%`);
const UNCAL_NAMES = 3;
const uncalNames = computed(() => {
  const ids = perf.uncalibrated;
  const names = ids.slice(0, UNCAL_NAMES).map((id) => device.legend(device.keys[id])).join(', ');
  return ids.length > UNCAL_NAMES ? `${names} +${ids.length - UNCAL_NAMES}` : names;
});

// ----- keyboard (§3.2): the Travel tab's caps in the Actuation view, depth fill on
function sublabel(k: PhysicalKey): string | undefined {
  const p = perf.values[k.id];
  return p ? actSublabel(p, decimals.value) : undefined;
}
function badge(k: PhysicalKey): string | undefined {
  const p = perf.values[k.id];
  return p ? actBadge(p) : undefined;
}
function badgeIcon(k: PhysicalKey): Component | undefined {
  const p = perf.values[k.id];
  return p ? actBadgeIcon(p) : undefined;
}
function badgeTitle(k: PhysicalKey): string | undefined {
  const p = perf.values[k.id];
  return p ? actBadgeTitle(p, decimals.value) : undefined;
}
function fill(k: PhysicalKey): number | undefined {
  const p = perf.values[k.id];
  return p ? actFill(p) : undefined;
}
const uncalFlag = (k: PhysicalKey) => uncalFlagFor(perf.uncalibrated, k.id);
const shows = computed(() => actuationLegend(device.keys.map((k) => perf.values[k.id]).filter(Boolean), perf.uncalibrated.length, true));
const plain = computed(() => legendSentence(shows.value));
/** "… profile {name}. …" with the name (user data) in its own span. */
const keyboardSub = computed(() => {
  const MARK = '\u0000';
  const [before, after = ''] = t('ov.keyboardSub', { name: MARK }).split(MARK);
  return { before, after };
});

/** Opens the key in the Travel tab, alone in the selection (DESIGN F §3.5). Back returns here. */
function openKey(k: PhysicalKey): void {
  sel.select(k.id, 'replace');
  void router.push(TRAVEL);
}

// ----- shortcuts (§3.8): the same icon and tone as the page's sidebar item / tab
const SHORTCUTS = computed(() => {
  const all: { to: RouteLocationRaw; icon: Component; tone: string; name: MessageKey; desc: MessageKey }[] = [
    { to: '/performance', icon: IconAdjustmentsHorizontal, tone: 'var(--f-performance)', name: 'page.performance', desc: 'ov.dPerformance' },
    { to: '/keymap', icon: IconKeyboard, tone: 'var(--f-keymap)', name: 'page.keymap', desc: 'ov.dKeymap' },
    { to: '/lighting', icon: IconBulb, tone: 'var(--f-lighting)', name: 'page.lighting', desc: 'ov.dLighting' },
    { to: '/macro', icon: IconListDetails, tone: 'var(--f-macro)', name: 'page.macro', desc: 'ov.dMacro' },
    { to: { path: '/performance', query: { tab: 'test' } }, icon: IconActivity, tone: 'var(--f-live)', name: 'ptab.test', desc: 'ov.dTest' },
    { to: CALIBRATION, icon: IconTarget, tone: 'var(--f-calibration)', name: 'swp.tabCalibration', desc: 'ov.dCalibration' },
    { to: PROFILES, icon: IconStack2, tone: 'var(--f-profiles)', name: 'page.profiles', desc: 'ov.dProfiles' },
    { to: '/settings', icon: IconSettings, tone: 'var(--f-settings)', name: 'page.settings', desc: 'ov.dSettings' },
  ];
  return hasProfiles ? all : all.filter((s) => s.to !== PROFILES);
});

// ----- device line (§3.9)
const boardText = computed(() => (device.info?.boardIdHex ? `0x${device.info.boardIdHex.toUpperCase()}` : '—'));
const protocolText = computed(() => {
  const v = device.version;
  return v ? `${v.main}.${v.sub}.${v.hardware}.${v.software}` : '—';
});
/** Only once read: before that the store holds its default (8000 Hz), which may not be the keyboard's. */
const pollingText = computed(() => (settings.loaded ? `${POLLING_RATE_HZ[settings.pollingRate] ?? settings.pollingRate} Hz` : '—'));
</script>

<template>
  <PageLayout :title="t('page.overview')">
    <div class="ov">
      <section class="ovh" aria-labelledby="ov-model">
        <span class="ovh__icon" aria-hidden="true"><IconKeyboard :size="22" stroke-width="1.75" /></span>
        <div class="ovh__id">
          <h2 id="ov-model" class="ovh__name">{{ device.modelName }}</h2>
          <p class="ovh__meta">
            <span class="ovh__dot" aria-hidden="true" />
            <span>{{ device.demo ? t('device.demo') : t('device.connected') }}</span>
            <span class="ovh__sep" aria-hidden="true">·</span>
            <span>{{ t('device.firmware') }} <span class="num">{{ device.info?.firmware ?? '—' }}</span></span>
          </p>
        </div>
        <div class="ovh__actions">
          <Button v-if="hasProfiles" :to="PROFILES" :icon="IconStack2">{{ t('page.profiles') }}</Button>
          <Button variant="primary" to="/performance" :icon="IconAdjustmentsHorizontal">{{ t('ov.tune') }}</Button>
        </div>
      </section>

      <ul class="ovs" :aria-label="t('ov.stats')">
        <li>
          <StatTile :to="hasProfiles ? PROFILES : undefined" :icon="IconStack2" :label="t('ov.statProfile')">
            <template #value>
              <span class="ovs__value">
                <span class="ovs__n num" aria-hidden="true">{{ device.activeProfile + 1 }}</span>
                <span class="ovs__text" :title="device.activeProfileName">{{ device.activeProfileName }}</span>
              </span>
            </template>
            <template #sub>
              <span class="ovs__sub">{{ t('ov.profileOf', { n: device.activeProfile + 1, count: device.profileCount }) }}</span>
            </template>
          </StatTile>
        </li>
        <li>
          <StatTile :icon="IconAdjustmentsHorizontal" :label="t('ov.statActuation')">
            <template #value>
              <span v-if="actValue" class="ovs__value num">{{ actValue }}</span>
              <span v-else class="ovs__value ovs__value--wait">—</span>
            </template>
            <template #sub>
              <span class="ovs__sub">{{ actValue ? actSub : loaded ? t('ov.notRead') : waitText }}</span>
            </template>
          </StatTile>
        </li>
        <li>
          <StatTile :icon="IconBolt" :label="t('ov.statRt')">
            <template #value>
              <span v-if="loaded" class="ovs__value num">
                <span aria-hidden="true">{{ t('ov.rtKeys', { n: rt, total }) }}</span>
                <span class="sr-only">{{ t('ov.rtBar', { n: rt, total }) }}</span>
              </span>
              <span v-else class="ovs__value ovs__value--wait">—</span>
            </template>
            <template #sub>
              <span v-if="loaded" class="ovs__bar" aria-hidden="true"><i :style="{ width: rtWidth }" /></span>
              <span v-else class="ovs__sub">{{ waitText }}</span>
            </template>
          </StatTile>
        </li>
        <li>
          <StatTile :to="CALIBRATION" :icon="IconTarget" :label="t('swp.tabCalibration')">
            <template #value>
              <span v-if="loaded" class="ovs__value">
                <IconAlertTriangle v-if="perf.uncalibrated.length" class="ovs__state ovs__state--warn" :size="20" stroke-width="2" aria-hidden="true" />
                <IconCircleCheck v-else class="ovs__state ovs__state--ok" :size="20" stroke-width="2" aria-hidden="true" />
                <span class="ovs__text">{{ perf.uncalibrated.length ? t('ov.calMissing', { n: perf.uncalibrated.length }) : t('ov.calAll', { n: total }) }}</span>
              </span>
              <span v-else class="ovs__value ovs__value--wait">—</span>
            </template>
            <template #sub>
              <span class="ovs__sub">{{ !loaded ? waitText : perf.uncalibrated.length ? t('ov.calMissingSub', { keys: uncalNames }) : t('ov.calAllSub') }}</span>
            </template>
          </StatTile>
        </li>
      </ul>

      <section class="ovk" aria-labelledby="ov-kb-title" :aria-busy="perf.loading || undefined">
        <div class="ovk__head">
          <div class="ovk__titles">
            <h2 id="ov-kb-title" class="ovk__title">{{ t('ov.keyboard') }}</h2>
            <p class="ovk__sub">{{ keyboardSub.before }}<span class="ovk__name">{{ device.activeProfileName }}</span>{{ keyboardSub.after }}</p>
          </div>
          <Button size="sm" :to="TRAVEL" :icon="IconPencil">{{ t('ov.editKeys') }}</Button>
        </div>
        <Card v-if="perf.loadError" :title="t('perf.loadFailed')" :subtitle="perf.loadError">
          <div><Button :icon="IconRefresh" @click="perf.load(true)">{{ t('perf.reload') }}</Button></div>
        </Card>
        <template v-else>
          <KeyboardView
            :keys="device.keys"
            :legend="device.legend"
            :sublabel="sublabel"
            :badge="badge"
            :badge-title="badgeTitle"
            :badge-icon="badgeIcon"
            :fill="fill"
            :flag="uncalFlag"
            :loading="perf.loading"
            :pick="openKey"
            describedby="ov-kb-hint"
            :style="{ '--metric': 'var(--m-actuation)' }"
          />
          <p v-if="!loaded" class="ovk__loading num">{{ t('perf.loading', { n: perf.loadedCount }) }}</p>
          <p v-else class="ovk__shows" :title="plain">
            <span class="sr-only">{{ plain }}</span>
            <SelectionLegend :items="shows" />
          </p>
        </template>
        <span id="ov-kb-hint" hidden>{{ t('ov.keyHint') }}</span>
      </section>

      <nav class="ovl" aria-labelledby="ov-links-title">
        <h2 id="ov-links-title" class="ovl__title">{{ t('ov.shortcuts') }}</h2>
        <ul class="ovl__grid">
          <li v-for="s in SHORTCUTS" :key="s.name">
            <RouterLink class="ovl__item" :to="s.to">
              <span class="ovl__tile" :style="{ '--f': s.tone }"><component :is="s.icon" :size="18" stroke-width="1.5" aria-hidden="true" /></span>
              <span class="ovl__text">
                <span class="ovl__name">{{ t(s.name) }}</span>
                <span class="ovl__desc">{{ t(s.desc) }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </nav>

      <section class="ovd" aria-labelledby="ov-dev">
        <h2 id="ov-dev" class="ovd__title">{{ t('ov.device') }}</h2>
        <dl class="ovd__list">
          <div><dt>{{ t('device.board') }}</dt><dd class="num">{{ boardText }}</dd></div>
          <div><dt>{{ t('ov.protocol') }}</dt><dd class="num">{{ protocolText }}</dd></div>
          <div><dt>{{ t('settings.pollingRate') }}</dt><dd class="num" data-ov="polling">{{ pollingText }}</dd></div>
        </dl>
        <RouterLink class="ovd__more" to="/diagnostics">{{ t('page.diagnostics') }}<IconArrowRight :size="15" stroke-width="1.75" aria-hidden="true" /></RouterLink>
      </section>
    </div>
  </PageLayout>
</template>

<style scoped>
/* One centred column as wide as the Performance keyboard frame (940 px; 1100 px from a 1600 px window): every block shares
   both edges, nothing sits wider than the keyboard (DESIGN F §2). */
.ov { display: flex; flex-direction: column; gap: var(--s-5); width: 100%; max-width: 940px; margin: 0 auto; container-type: inline-size; }
@media (min-width: 1600px) { .ov { max-width: 1100px; } }

/* header card: identity of the connected keyboard + the main ways in */
.ovh {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-3) var(--s-4);
  padding: var(--s-4) var(--s-5); background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--r-card);
}
.ovh__icon { flex: none; display: grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--acc); color: var(--on-acc); }
.ovh__id { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ovh__name { margin: 0; font-size: var(--fs-section); font-weight: 650; line-height: 1.2; color: var(--fg-1); }
.ovh__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--s-2); margin: 0; font-size: var(--fs-label); color: var(--fg-2); }
.ovh__dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px var(--ok-soft); margin-right: 2px; }
.ovh__sep { color: var(--fg-3); }
.ovh__actions { flex: none; display: flex; flex-wrap: wrap; gap: var(--s-2); margin-left: auto; }

/* four tiles about the active profile (StatTile draws the box and the label row) */
.ovs { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--s-3); margin: 0; padding: 0; list-style: none; }
.ovs > li { display: flex; min-width: 0; }
.ovs__value {
  display: flex; align-items: center; gap: var(--s-2); min-width: 0; margin-top: 2px;
  font-size: var(--fs-section); font-weight: 650; line-height: 28px; color: var(--fg-1); white-space: nowrap;
}
.ovs__text { min-width: 0; overflow: hidden; text-overflow: ellipsis; } /* the profile name (user data) can be long */
.ovs__value--wait { color: var(--fg-3); font-weight: 500; }
/* the sidebar profile chip, a size up */
.ovs__n { flex: none; display: grid; place-items: center; width: 22px; height: 22px; border-radius: 6px; font-size: var(--fs-label); font-weight: 650; line-height: 1; background: var(--acc); color: var(--on-acc); }
.ovs__state { flex: none; }
.ovs__state--ok { color: var(--ok); }
.ovs__state--warn { color: var(--warn); }
/* always room for 2 lines: the tiles keep one height while loading, so the keyboard below never moves when the numbers
   arrive (review F) */
.ovs__sub { min-height: 36px; font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }
.ovs__bar { display: block; height: 6px; margin: 7px 0 5px; border-radius: 3px; background: var(--bg-4); overflow: hidden; }
.ovs__bar > i { display: block; height: 100%; border-radius: 3px; background: var(--m-press); } /* = the RT tag on the keycaps */
@container (max-width: 759.98px) { .ovs { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* your keyboard: read-only heatmap; a click opens the key in the Travel tab */
.ovk { display: flex; flex-direction: column; gap: var(--s-3); }
.ovk__head { display: flex; align-items: flex-end; flex-wrap: wrap; gap: var(--s-2) var(--s-4); }
.ovk__titles { flex: 1 1 320px; min-width: 0; }
.ovk__title { margin: 0; font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); }
.ovk__sub { margin: 2px 0 0; font-size: var(--fs-label); color: var(--fg-3); overflow-wrap: anywhere; }
.ovk__name { color: var(--fg-2); font-weight: 500; }
.ovk__loading { margin: 0; line-height: 20px; color: var(--fg-3); }
/* the "Keycap: …" line of the selection bar (same SelectionLegend); here it may wrap, between items only */
.ovk__shows { margin: 0; font-size: var(--fs-label); line-height: 20px; color: var(--fg-2); }
.ovk__shows :deep(.sb__k),
.ovk__shows :deep(.sb__eq),
.ovk__shows :deep(.sb__t) { white-space: nowrap; }
.ovk__shows :deep(.sb__dot)::after { content: '\200B'; } /* the only break opportunity: after a separator */

/* shortcuts: 4 columns (2 under 760 px of column), rows of one height */
.ovl { display: flex; flex-direction: column; gap: var(--s-3); }
.ovl__title { margin: 0; font-size: var(--fs-card); font-weight: 600; color: var(--fg-1); }
.ovl__grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: 1fr; gap: var(--s-3); margin: 0; padding: 0; list-style: none; }
.ovl__grid > li { display: flex; min-width: 0; }
.ovl__item {
  flex: 1; display: flex; align-items: flex-start; gap: var(--s-3); min-width: 0; padding: var(--s-3) var(--s-4) var(--s-3) var(--s-3);
  background: var(--bg-2); border: 1px solid var(--line-1); border-radius: var(--r-card); color: inherit; text-decoration: none;
  transition: border-color var(--t-fast) var(--ease);
}
.ovl__item:hover { border-color: var(--line-3); }
/* the sidebar icon tile, 32 px */
.ovl__tile { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; background: color-mix(in srgb, var(--f) 16%, transparent); color: var(--f); }
.ovl__text { min-width: 0; display: flex; flex-direction: column; gap: 2px; padding-top: 1px; }
.ovl__name { font-size: var(--fs-body); font-weight: 600; color: var(--fg-1); }
.ovl__desc { font-size: var(--fs-label); line-height: 18px; color: var(--fg-3); }
@container (max-width: 759.98px) { .ovl__grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* device line: the facts the header does not carry, and the way to Diagnostics */
.ovd { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--s-2) var(--s-5); padding-top: var(--s-4); border-top: 1px solid var(--line-1); font-size: var(--fs-label); }
.ovd__title { margin: 0; font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); }
.ovd__list { display: flex; flex-wrap: wrap; gap: 4px var(--s-5); margin: 0; }
.ovd__list > div { display: inline-flex; gap: 6px; }
.ovd__list dt { color: var(--fg-3); }
.ovd__list dd { margin: 0; color: var(--fg-1); }
.ovd__more { display: inline-flex; align-items: center; gap: 4px; margin-left: auto; font-weight: 500; border-radius: 4px; }
.ovd__more:hover { text-decoration: underline; text-underline-offset: 3px; }
</style>
