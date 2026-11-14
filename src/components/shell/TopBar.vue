<script setup lang="ts">
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { IconAlertTriangle, IconArrowBackUp, IconArrowForwardUp, IconCircleCheck, IconLoader2, IconRefresh } from '@tabler/icons-vue';
import IconButton from '../ui/IconButton.vue';
import Tooltip from '../ui/Tooltip.vue';
import { useCalibrationStore } from '../../stores/calibration';
import { useDeviceStore } from '../../stores/device';
import { useFirmwareStore } from '../../stores/firmware';
import { useHistoryStore } from '../../stores/history';
import { useSyncStore } from '../../stores/sync';
import { NAV } from '../../router';
import { t } from '../../i18n/vi';

const route = useRoute();
const history = useHistoryStore();
const sync = useSyncStore();
const device = useDeviceStore();
const calibration = useCalibrationStore();
const calibrating = computed(() => calibration.phase !== 'idle' || device.calibrationLocked());
const firmware = useFirmwareStore();
/** A firmware session or rescue mode (DESIGN FW §3.4): the pill says so (warn colours), undo / redo are off. */
const fwPill = computed(() => (firmware.active ? t(firmware.rescue ? 'fw.pillRescue' : 'fw.pill') : null));
// Why undo/redo is unavailable right now (shown as the tooltip), or null when only the stack is empty.
const histBlock = computed(() => {
  if (fwPill.value) return fwPill.value;
  if (calibrating.value) return t('history.disabledCalibrating');
  if (history.suspended) return t('history.disabledDraft');
  return null;
});
const undoLabel = computed(() => histBlock.value
  ?? (history.undoLabel ? `${t('history.undo')}: ${history.undoLabel} (Ctrl+Z)` : `${t('history.undo')} (Ctrl+Z)`));
const redoLabel = computed(() => histBlock.value
  ?? (history.redoLabel ? `${t('history.redo')}: ${history.redoLabel} (Ctrl+Y)` : `${t('history.redo')} (Ctrl+Y)`));
const title = computed(() => (route.meta.title ? t(route.meta.title) : ''));
const nav = computed(() => NAV.flatMap((g) => g.items).find((it) => it.path === route.path));
const busy = computed(() => sync.state === 'pending' || sync.state === 'writing');
// "Saved": the pill takes focus and has one bubble, the last save's problem if any, else the promise (DESIGN H §3.2).
const saved = computed(() => sync.state === 'saved');
const savedTip = computed(() => (sync.lastProblem ? t('sync.lastProblem', { msg: sync.lastProblem }) : t('sync.savedHelp')));
</script>

<template>
  <header class="top">
    <div class="top__head">
      <span v-if="nav" class="tile" :style="{ '--f': nav.tone }"><component :is="nav.icon" :size="18" stroke-width="1.5" aria-hidden="true" /></span>
      <h2 class="top__title">{{ title }}</h2>
    </div>
    <div class="top__right">
      <!-- Always wrapped (disabled when not saved): the live region is never re-created, so "Saved" is still announced. -->
      <Tooltip :text="savedTip" placement="bottom" :disabled="!saved || !!fwPill">
        <div
          class="pill"
          :class="fwPill ? 'pill--fw' : `pill--${sync.state}`"
          role="status"
          aria-live="polite"
          :tabindex="saved && !fwPill ? 0 : undefined"
          :aria-describedby="saved && !fwPill ? 'sync-saved-help' : undefined"
        >
          <template v-if="fwPill">
            <IconAlertTriangle :size="15" stroke-width="1.5" aria-hidden="true" />
            <span>{{ fwPill }}</span>
          </template>
          <IconLoader2 v-else-if="busy" class="pill__spin" :size="15" stroke-width="1.5" aria-hidden="true" />
          <IconAlertTriangle v-else-if="sync.state === 'error'" :size="15" stroke-width="1.5" aria-hidden="true" />
          <IconCircleCheck v-else :size="15" stroke-width="1.5" aria-hidden="true" />
          <Tooltip v-if="!fwPill && sync.state === 'error'" :text="sync.lastError ?? ''" placement="bottom">
            <span>{{ t('sync.error') }}</span>
          </Tooltip>
          <span v-else-if="!fwPill">{{ busy ? t('sync.writing') : t('sync.saved') }}</span>
          <span v-if="saved && !fwPill" id="sync-saved-help" hidden>{{ savedTip }}</span>
          <button v-if="!fwPill && sync.state === 'error'" type="button" class="pill__retry" :aria-label="t('sync.retry')" :title="t('sync.retry')" @click="sync.retry()">
            <IconRefresh :size="14" stroke-width="1.5" />
          </button>
        </div>
      </Tooltip>
      <div class="top__hist">
        <IconButton
          :icon="IconArrowBackUp"
          :label="undoLabel"
          :disabled="!history.canUndo || calibrating || firmware.active"
          @click="history.undo()"
        />
        <IconButton
          :icon="IconArrowForwardUp"
          :label="redoLabel"
          :disabled="!history.canRedo || calibrating || firmware.active"
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
  background: var(--glass);
  backdrop-filter: blur(8px);
  flex: none;
}
.top__head { display: flex; align-items: center; gap: 10px; min-width: 0; }
.tile {
  display: grid;
  place-items: center;
  flex: none;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--acc) 16%, transparent);
  color: var(--acc);
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
.pill--fw { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 45%, transparent); background: color-mix(in srgb, var(--warn) 12%, transparent); }
.pill--error { color: var(--danger); background: var(--danger-soft); border-color: var(--danger-line); padding-right: 4px; }
.pill__spin { animation: spin 0.9s linear infinite; color: var(--acc); }
@keyframes spin { to { transform: rotate(360deg); } }
.pill__retry {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 11px;
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.pill__retry:hover { background: color-mix(in srgb, var(--danger) 22%, transparent); }
</style>
