<script setup lang="ts">
import { computed, ref } from 'vue';
import { IconLayoutSidebarLeftCollapse, IconLayoutSidebarLeftExpand, IconRefresh } from '@tabler/icons-vue';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Segmented from '../ui/Segmented.vue';
import { t } from '../../i18n/vi';
import { locale, setLocale, type Locale } from '../../i18n/locale';
import { useUpdateStore } from '../../update';

const compact = defineModel<boolean>('compact', { default: false });
const update = useUpdateStore();
const help = ref(false);

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
  <div class="side-foot" :class="{ 'side-foot--compact': compact }">
    <div class="side-foot__lang" :title="t('lang.switch')">
      <Segmented v-model="currentLocale" :options="LANG_OPTIONS" :label="t('lang.switch')" size="sm" />
    </div>

    <div class="side-foot__gap" />

    <button type="button" class="side-foot__btn" :aria-label="updateLabel" :title="updateLabel" @click="help = true">
      <IconRefresh class="side-foot__refresh" :class="{ 'side-foot__refresh--spin': updateBusy }" :size="19" stroke-width="1.5" />
      <span v-if="updatePending" class="side-foot__dot" aria-hidden="true" />
    </button>

    <button
      type="button"
      class="side-foot__btn"
      :aria-label="compact ? t('nav.expand') : t('nav.collapse')"
      :title="compact ? t('nav.expand') : t('nav.collapse')"
      @click="compact = !compact"
    >
      <component :is="compact ? IconLayoutSidebarLeftExpand : IconLayoutSidebarLeftCollapse" :size="19" stroke-width="1.5" />
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
      </div>
    </Dialog>
  </div>
</template>

<style scoped>
.side-foot {
  margin-top: auto;
  position: sticky;
  bottom: calc(-1 * var(--s-3));
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  margin-bottom: calc(-1 * var(--s-3));
  padding: var(--s-2) 0 var(--s-3);
  background: var(--bg-1);
  border-top: 1px solid var(--line-1);
}
.side-foot__gap { flex: 1; }
.side-foot__btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--fg-3);
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.side-foot__btn:hover { color: var(--fg-1); background: var(--bg-2); }
.side-foot__dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--acc);
  box-shadow: 0 0 0 2px var(--bg-1);
}
.side-foot__refresh--spin { animation: side-foot-spin 1s linear infinite; }
@keyframes side-foot-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) {
  .side-foot__refresh--spin { animation: none; }
}

/* compact: stacked, VI|EN shrunk to fit the 40px column */
.side-foot--compact { flex-direction: column; gap: 4px; }
.side-foot--compact .side-foot__gap { display: none; }
.side-foot--compact :deep(.seg) { padding: 2px; gap: 1px; }
.side-foot--compact :deep(.seg__opt) { height: 20px; padding: 0 4px; font-size: 10px; font-weight: 600; }

/* About dialog */
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
  color: var(--ok);
}
.help__status-row--avail {
  color: var(--ok); /* new version info reads green like "up to date"; the Update button keeps the theme colour */
}
.help__status-row--info {
  color: var(--info);
}
.help__status-row--err {
  color: var(--danger);
}
</style>
