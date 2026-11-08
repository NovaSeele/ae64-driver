<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { IconAlertTriangle, IconArrowBackUp, IconArrowForwardUp, IconCircleCheck, IconLoader2, IconRefresh } from '@tabler/icons-vue';
import IconButton from '../ui/IconButton.vue';
import Tooltip from '../ui/Tooltip.vue';
import { useHistoryStore } from '../../stores/history';
import { useSyncStore } from '../../stores/sync';
import { t } from '../../i18n/vi';

const route = useRoute();
const history = useHistoryStore();
const sync = useSyncStore();
const title = computed(() => (route.meta.title ? t(route.meta.title) : ''));
const busy = computed(() => sync.state === 'pending' || sync.state === 'writing');
</script>

<template>
  <header class="top">
    <h2 class="top__title">{{ title }}</h2>
    <div class="top__right">
      <div class="pill" :class="`pill--${sync.state}`" role="status" aria-live="polite">
        <IconLoader2 v-if="busy" class="pill__spin" :size="15" stroke-width="1.5" aria-hidden="true" />
        <IconAlertTriangle v-else-if="sync.state === 'error'" :size="15" stroke-width="1.5" aria-hidden="true" />
        <IconCircleCheck v-else :size="15" stroke-width="1.5" aria-hidden="true" />
        <Tooltip v-if="sync.state === 'error'" :text="sync.lastError ?? ''" placement="bottom">
          <span>{{ t('sync.error') }}</span>
        </Tooltip>
        <span v-else>{{ busy ? t('sync.writing') : t('sync.saved') }}</span>
        <button v-if="sync.state === 'error'" type="button" class="pill__retry" :aria-label="t('sync.retry')" :title="t('sync.retry')" @click="sync.retry()">
          <IconRefresh :size="14" stroke-width="1.5" />
        </button>
      </div>
      <div class="top__hist">
        <IconButton
          :icon="IconArrowBackUp"
          :label="history.undoLabel ? `${t('history.undo')}: ${history.undoLabel} (Ctrl+Z)` : `${t('history.undo')} (Ctrl+Z)`"
          :disabled="!history.canUndo"
          @click="history.undo()"
        />
        <IconButton
          :icon="IconArrowForwardUp"
          :label="history.redoLabel ? `${t('history.redo')}: ${history.redoLabel} (Ctrl+Y)` : `${t('history.redo')} (Ctrl+Y)`"
          :disabled="!history.canRedo"
          @click="history.redo()"
        />
      </div>
    </div>
  </header>
</template>

<style scoped>
.top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--s-4);
  height: var(--topbar-h);
  padding: 0 var(--s-6) 0 var(--s-7);
  border-bottom: 1px solid var(--line-1);
  background: rgba(12, 13, 15, 0.8);
  backdrop-filter: blur(8px);
  flex: none;
}
.top__title { font-size: var(--fs-section); }
.top__right { display: flex; align-items: center; gap: var(--s-4); }
.top__hist { display: flex; gap: 2px; padding-left: var(--s-3); border-left: 1px solid var(--line-1); }
.pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 12px;
  border-radius: 14px;
  font-size: var(--fs-label);
  font-weight: 500;
  border: 1px solid var(--line-1);
  background: var(--bg-2);
  color: var(--fg-2);
  transition: color var(--t-med) var(--ease), background var(--t-med) var(--ease), border-color var(--t-med) var(--ease);
}
.pill--saved { color: var(--ok); }
.pill--pending, .pill--writing { color: var(--fg-1); }
.pill--error { color: var(--danger); background: var(--danger-soft); border-color: rgba(248, 113, 113, 0.3); padding-right: 4px; }
.pill__spin { animation: spin 0.9s linear infinite; color: var(--acc); }
@keyframes spin { to { transform: rotate(360deg); } }
.pill__retry {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 11px;
  background: rgba(248, 113, 113, 0.18);
  color: var(--danger);
}
.pill__retry:hover { background: rgba(248, 113, 113, 0.3); }
</style>
