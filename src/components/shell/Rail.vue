<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { IconActivity, IconAdjustments, IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconRefresh, IconSettings } from '@tabler/icons-vue';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Segmented from '../ui/Segmented.vue';
import { t } from '../../i18n/vi';
import { locale, setLocale, type Locale } from '../../i18n/locale';
import { useUpdateStore } from '../../update';
import { useDeviceStore } from '../../stores/device';

const collapsed = defineModel<boolean>('collapsed', { required: true });
const route = useRoute();
const router = useRouter();
const update = useUpdateStore();
const device = useDeviceStore();
const help = ref(false);

// The rail switches between three modes; each remembers the last page opened inside it.
const MODES = [
  { id: 'configure', label: 'nav.configure', icon: IconAdjustments, home: '/performance', paths: ['/keymap', '/performance', '/advanced', '/lighting', '/macro'] },
  { id: 'live', label: 'nav.live', icon: IconActivity, home: '/live', paths: ['/live'] },
  { id: 'device', label: 'nav.groupDevice', icon: IconSettings, home: '/settings', paths: ['/calibration', '/settings', '/diagnostics'] },
] as const;
const last = reactive<Record<string, string>>(Object.fromEntries(MODES.map((m) => [m.id, m.home])));
const activeMode = computed(() => MODES.find((m) => (m.paths as readonly string[]).includes(route.path))?.id);
const removeHook = router.afterEach((to) => {
  const m = MODES.find((x) => (x.paths as readonly string[]).includes(to.path));
  if (m) last[m.id] = to.fullPath;
});
onBeforeUnmount(removeHook);

const currentLocale = computed({
  get: () => locale.value,
  set: (val: Locale | null) => {
    if (val === 'vi' || val === 'en') setLocale(val);
  },
});

const LANG_OPTIONS = computed<{ value: Locale; label: string; title: string }[]>(() => [
  { value: 'vi', label: 'VI', title: t('lang.vi') },
  { value: 'en', label: 'EN', title: t('lang.en') },
]);

const updatePending = computed(() => update.state === 'available' || update.state === 'deferred');
const updateBusy = computed(() => update.state === 'checking' || update.state === 'downloading');
const updateLabel = computed(() => t('nav.update') + (updatePending.value ? t('nav.updateAvailableSuffix') : ''));

function formatUpdateDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    return d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  } catch {
    return iso;
  }
}
</script>

<template>
  <nav class="rail" :aria-label="t('app.name')">
    <div class="rail__mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="30" height="30">
        <rect x="2.5" y="7.5" width="27" height="17" rx="4.5" fill="var(--bg-3)" stroke="var(--acc)" stroke-width="1.6" />
        <g fill="var(--acc)">
          <rect x="6" y="11" width="3" height="3" rx="0.9" />
          <rect x="10.5" y="11" width="3" height="3" rx="0.9" />
          <rect x="15" y="11" width="3" height="3" rx="0.9" />
          <rect x="19.5" y="11" width="3" height="3" rx="0.9" />
          <rect x="24" y="11" width="2.5" height="3" rx="0.9" opacity="0.55" />
          <rect x="6" y="15.5" width="5" height="3" rx="0.9" opacity="0.55" />
          <rect x="12.5" y="15.5" width="3" height="3" rx="0.9" />
          <rect x="17" y="15.5" width="3" height="3" rx="0.9" />
          <rect x="21.5" y="15.5" width="5" height="3" rx="0.9" />
          <rect x="10" y="20" width="12" height="2.2" rx="1.1" />
        </g>
      </svg>
    </div>
    <button
      v-for="m in MODES"
      :key="m.id"
      type="button"
      class="rail__btn"
      :class="{ 'rail__btn--on': activeMode === m.id }"
      :aria-current="activeMode === m.id ? 'page' : undefined"
      :disabled="!device.connected"
      @click="router.push(last[m.id])"
    >
      <component :is="m.icon" :size="20" stroke-width="1.5" aria-hidden="true" />
      <span>{{ t(m.label) }}</span>
    </button>
    <div class="rail__spacer" />

    <button type="button" class="rail__icon" :aria-label="collapsed ? t('nav.expand') : t('nav.collapse')" :title="collapsed ? t('nav.expand') : t('nav.collapse')" @click="collapsed = !collapsed">
      <component :is="collapsed ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse" :size="19" stroke-width="1.5" />
    </button>

    <div class="rail__lang" :title="t('lang.switch')">
      <Segmented v-model="currentLocale" :options="LANG_OPTIONS" :label="t('lang.switch')" size="sm" />
    </div>

    <button type="button" class="rail__icon" :aria-label="updateLabel" :title="updateLabel" @click="help = true">
      <IconRefresh class="rail__refresh" :class="{ 'rail__refresh--spin': updateBusy }" :size="19" stroke-width="1.5" />
      <span v-if="updatePending" class="rail__dot" aria-hidden="true" />
    </button>

    <Dialog v-model:open="help" :title="t('help.title')" :width="480">
      <div class="help">
        <p>{{ t('help.body') }}</p>

        <div class="help__update">
          <div class="help__version-row">
            <span class="help__version-text">{{ t('update.version', { version: update.currentVersion }) }}</span>
            <Button
              v-if="update.state === 'idle' || update.state === 'upToDate'"
              size="sm"
              @click="update.check()"
            >
              {{ t('update.check') }}
            </Button>
          </div>

          <div v-if="update.state === 'checking'" class="help__status-row">
            <span class="micro">{{ t('update.checking') }}</span>
          </div>

          <div v-else-if="update.state === 'upToDate'" class="help__status-row help__status-row--ok">
            <span>{{ t('update.upToDate') }}</span>
          </div>

          <div v-else-if="update.state === 'available' && update.availableInfo" class="help__status-row help__status-row--avail">
            <span>{{ t('update.available', { version: update.availableInfo.version, date: formatUpdateDate(update.availableInfo.builtAt) }) }}</span>
            <Button variant="primary" size="sm" @click="update.apply()">
              {{ t('update.apply') }}
            </Button>
          </div>
          <div v-if="update.state === 'available' && update.error" class="help__status-row help__status-row--info" role="status">
            <span>{{ update.error }}</span>
          </div>

          <div v-else-if="update.state === 'downloading'" class="help__status-row">
            <span>{{ t('update.downloading') }}</span>
          </div>

          <div v-else-if="update.state === 'deferred'" class="help__status-row help__status-row--info" role="status">
            <span>{{ t('update.deferred', { version: update.deferredVersion }) }}</span>
            <Button size="sm" :disabled="update.busyReason !== null" :title="update.busyReason ?? undefined" @click="update.reloadNow()">
              {{ t('update.reloadNow') }}
            </Button>
          </div>

          <div v-else-if="update.state === 'error'" class="help__status-row help__status-row--err">
            <span>{{ t('update.failed', { error: update.error || '' }) }}</span>
            <Button size="sm" @click="update.check()">
              {{ t('update.retry') }}
            </Button>
          </div>
        </div>

        <h3 class="micro">{{ t('help.shortcuts') }}</h3>
        <dl>
          <dt><kbd>Ctrl</kbd>+<kbd>Z</kbd> · <kbd>Ctrl</kbd>+<kbd>Y</kbd></dt><dd>{{ t('help.shortcutUndo') }}</dd>
          <dt><kbd>Esc</kbd></dt><dd>{{ t('help.shortcutSelect') }}</dd>
        </dl>
        <p class="help__safe">{{ t('help.safety') }}</p>
      </div>
    </Dialog>
  </nav>
</template>

<style scoped>
.rail {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--s-2);
  width: var(--rail-w);
  padding: var(--s-3) 0;
  background: var(--bg-1);
  border-right: 1px solid var(--line-1);
}
.rail__mark { display: grid; place-items: center; height: 40px; margin-bottom: var(--s-3); }
.rail__btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  width: 48px;
  padding: 7px 0 6px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  font-size: 9.5px;
  font-weight: 500;
  line-height: 1.1;
  text-align: center;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.rail__btn:hover:not(:disabled) { color: var(--fg-1); background: var(--bg-2); }
.rail__btn:disabled { opacity: 0.4; cursor: not-allowed; }
.rail__btn--on, .rail__btn--on:hover:not(:disabled) { color: var(--fg-1); background: var(--sel-bg); }
.rail__btn--on :deep(svg) { color: var(--acc); }
.rail__spacer { flex: 1; }
.rail__lang {
  display: flex;
  justify-content: center;
  width: 100%;
}
.rail__lang :deep(.seg) {
  padding: 2px;
  gap: 1px;
}
.rail__lang :deep(.seg__opt) {
  height: 20px;
  padding: 0 4px;
  font-size: 10px;
  font-weight: 600;
}
.rail__icon {
  position: relative;
  display: grid;
  place-items: center;
  width: 36px;
  height: 36px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.rail__icon:hover { color: var(--fg-1); background: var(--bg-3); }
.rail__dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--acc);
  box-shadow: 0 0 0 2px var(--bg-1);
}
.rail__refresh--spin { animation: rail-spin 1s linear infinite; }
@keyframes rail-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .rail__refresh--spin { animation: none; }
}
.help { display: flex; flex-direction: column; gap: var(--s-3); }
.help dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0; }
.help dt { color: var(--fg-1); }
.help dd { margin: 0; }
.help kbd {
  font: inherit;
  font-size: var(--fs-caption);
  padding: 1px 5px;
  border-radius: 4px;
  border: 1px solid var(--line-2);
  background: var(--bg-3);
}
.help__safe { color: var(--fg-3); font-size: var(--fs-label); }
.help__update {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  padding: var(--s-3);
  border-radius: var(--r-card);
  background: var(--bg-2);
  border: 1px solid var(--line-1);
}
.help__version-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
}
.help__version-text {
  font-weight: 600;
  color: var(--fg-1);
  font-size: var(--fs-body);
}
.help__status-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-2);
  font-size: var(--fs-label);
  color: var(--fg-2);
}
.help__status-row--ok {
  color: var(--acc); /* "up to date" is information, not a keyboard write: theme colour, like "available" */
}
.help__status-row--avail {
  color: var(--acc);
}
.help__status-row--info {
  color: var(--info);
}
.help__status-row--err {
  color: var(--danger);
}
</style>
