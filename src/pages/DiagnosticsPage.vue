<script setup lang="ts">
// Diagnostics page: device identity, protocol version, feature bitmap, transport latency stats, packet log, backup/restore JSON.
// Note: per safety guidelines, NO raw write console is provided.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  IconCopy, IconCheck, IconDownload, IconUpload, IconPlayerPause, IconPlayerPlay,
} from '@tabler/icons-vue';
import PageLayout from '../components/shell/PageLayout.vue';
import Card from '../components/ui/Card.vue';
import Button from '../components/ui/Button.vue';
import Dialog from '../components/ui/Dialog.vue';
import Segmented from '../components/ui/Segmented.vue';
import CopyInfo from '../components/settings/CopyInfo.vue';
import { useToast } from '../components/ui/toast';
import { useDeviceStore } from '../stores/device';
import { formatBuildTime, useDiagnosticsStore } from '../stores/diagnostics';
import type { ImportDiff } from '../stores/diagnostics';
import type { PacketLogEntry } from '../protocol';
import { t } from '../i18n/vi';

const device = useDeviceStore();
const diag = useDiagnosticsStore();

// Settings' "Back up the keyboard configuration on the Diagnostics page" link (DESIGN H §3.3): ?focus=backup brings the
// Backup card to the top of the scroller, focuses its title, then drops the query (hash history: no #anchor).
const route = useRoute();
const router = useRouter();
onMounted(async () => {
  if (route.query.focus !== 'backup') return;
  await nextTick();
  const title = document.getElementById('diag-backup-title');
  if (title) {
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    title.closest('.card')?.scrollIntoView?.({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    title.focus({ preventScroll: true });
  }
  const { focus: _focus, ...query } = route.query;
  void router.replace({ query });
});
const toast = useToast();
// The store records packets for the whole connection; watching makes `packetSeq` tick while this page is open.
onBeforeUnmount(device.watchPackets());
const LOG_ROWS = 200;

const logFilter = ref<'all' | 'in' | 'out'>('all');
const logSearch = ref('');
const copied = ref(false);
const paused = ref(false);
const frozen = shallowRef<PacketLogEntry[]>([]);

function togglePause() {
  if (!paused.value) frozen.value = device.packetEntries().map((e) => ({ ...e })); // collapsed rows keep counting in the store: copy
  paused.value = !paused.value;
}

const importDialogOpen = ref(false);
const activeDiff = ref<ImportDiff | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);

const filterOptions = computed(() => [
  { value: 'all', label: t('diagnostics.filterAll') },
  { value: 'in', label: t('diagnostics.filterIn') },
  { value: 'out', label: t('diagnostics.filterOut') },
]);

// Latency & stats
// statsTick re-runs this every 250 ms: the transport's stats object itself is not reactive.
const stats = computed(() => {
  void device.statsTick;
  return { lastLatencyMs: 0, avgLatencyMs: 0, requests: 0, timeouts: 0, ...device.transport?.stats };
});
const readOnly = computed(() => !device.boardAllowed);

// Feature chips
const features = computed(() => {
  const f = device.features;
  if (!f) return [];
  const list: { group: string; label: string; enabled: boolean }[] = [];
  // Axis
  list.push({ group: t('diagnostics.featAxis'), label: t('diagnostics.featMechanical'), enabled: f.axis.mechanical });
  list.push({ group: t('diagnostics.featAxis'), label: t('diagnostics.featMagnetic'), enabled: f.axis.magnetic });
  list.push({ group: t('diagnostics.featAxis'), label: t('diagnostics.featOptical'), enabled: f.axis.optical });
  list.push({ group: t('diagnostics.featAxis'), label: t('diagnostics.featInductive'), enabled: f.axis.inductive });
  list.push({ group: t('diagnostics.featAxis'), label: t('diagnostics.featMagnetic3D'), enabled: f.axis.magnetic3D });
  // Connection
  list.push({ group: t('diagnostics.featConn'), label: t('diagnostics.featUsb'), enabled: f.connection.usb });
  list.push({ group: t('diagnostics.featConn'), label: t('diagnostics.featWireless24'), enabled: f.connection.wireless24 });
  list.push({ group: t('diagnostics.featConn'), label: t('diagnostics.featBluetooth'), enabled: f.connection.bluetooth });
  list.push({ group: t('diagnostics.featConn'), label: t('diagnostics.featUsb3'), enabled: f.connection.usb3 });
  // Basic
  list.push({ group: t('diagnostics.featBasic'), label: t('diagnostics.featRgb'), enabled: f.basic.rgb });
  list.push({ group: t('diagnostics.featBasic'), label: t('diagnostics.featKnob'), enabled: f.basic.knob });
  return list;
});

// Packet log filtering
function toHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

const filteredPackets = computed<PacketLogEntry[]>(() => {
  const q = logSearch.value.trim().toLowerCase();
  const dir = logFilter.value;
  void device.packetSeq; // the ring buffer is not reactive: re-run when the store reports new packets (≤ 4 Hz)
  const source = paused.value ? frozen.value : device.packetEntries();
  const rows: PacketLogEntry[] = [];
  // Newest first, at most LOG_ROWS rows.
  for (let i = source.length - 1; i >= 0 && rows.length < LOG_ROWS; i--) {
    const e = source[i];
    if (dir !== 'all' && e.dir !== dir) continue;
    if (q && !toHex(e.bytes).includes(q) && !(e.note ?? '').toLowerCase().includes(q)) continue;
    rows.push(e);
  }
  return rows;
});

/** Hex of one packet, or the count for a row that stands for a run of live-travel polls. */
function rowText(e: PacketLogEntry): string {
  return e.repeat === undefined ? toHex(e.bytes) : t('diagnostics.travelPackets', { n: e.repeat });
}

async function copyLog() {
  const text = filteredPackets.value.map((e) => {
    const time = new Date(e.t).toISOString().slice(11, 23);
    const dir = e.dir.toUpperCase().padEnd(3);
    const hex = rowText(e);
    const note = e.note ? ` (${e.note})` : '';
    return `[${time}] ${dir}  ${hex}${note}`;
  }).join('\n');

  try {
    await navigator.clipboard.writeText(text);
    copied.value = true;
    toast.show(t('diagnostics.copied'), 'success');
    setTimeout(() => { copied.value = false; }, 2000);
  } catch {
    toast.show(t('diagnostics.copyFailed'), 'error');
  }
}

// Backup & Restore
async function exportBackup() {
  try {
    const payload = await diag.generateBackup();
    const jsonStr = JSON.stringify(payload, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const a = document.createElement('a');
    a.href = url;
    a.download = `ae64-backup-${payload.profileName.toLowerCase().replace(/\s+/g, '-')}-${dateStr}.json`;
    a.click();
    URL.revokeObjectURL(url);
    toast.show(t('diagnostics.exportSuccess'), 'success');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  }
}

function triggerImport() {
  fileInput.value?.click();
}

async function onFileSelected(e: Event) {
  const files = (e.target as HTMLInputElement).files;
  if (!files || !files[0]) return;
  const file = files[0];
  try {
    const text = await file.text();
    const diff = await diag.parseAndDiffBackup(text);
    if (diff.keymapDiffCount + diff.perfDiffCount + diff.settingsDiffCount === 0) {
      toast.show(t('diagnostics.importNoChanges'), 'info');
      return;
    }
    activeDiff.value = diff;
    importDialogOpen.value = true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const [code, a, b] = msg.split(':');
    if (code === 'invalid_json') toast.show(t('diagnostics.importInvalidJson'), 'error');
    else if (code === 'invalid_schema') toast.show(t('diagnostics.importInvalidSchema'), 'error');
    else if (code === 'invalid_board') toast.show(t('diagnostics.importInvalidBoard', { board: a || '?' }), 'error');
    else if (code === 'invalid_board_mismatch') toast.show(t('diagnostics.importWrongBoard', { board: a || '?', current: b || '?' }), 'error');
    else toast.show(msg, 'error');
  } finally {
    if (fileInput.value) fileInput.value.value = '';
  }
}

// The shown diff was computed against the previous profile.
watch(() => device.activeProfile, () => {
  if (diag.isRestoring) return;
  importDialogOpen.value = false;
  activeDiff.value = null;
});

// No closing (Esc / backdrop / X) while the restore is writing.
function onImportOpen(v: boolean) {
  if (!v && diag.isRestoring) return;
  importDialogOpen.value = v;
}

async function doRestore() {
  if (!activeDiff.value || readOnly.value) return;
  try {
    const { skipped } = await diag.applyRestore(activeDiff.value);
    importDialogOpen.value = false;
    toast.show(t('diagnostics.importSuccess'), 'success');
    if (skipped > 0) toast.show(t('diagnostics.importSkipped', { n: skipped }), 'warn');
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  }
}
</script>

<template>
  <PageLayout :title="t('page.diagnostics')">
    <div class="diag-container">
      <!-- 1. Device Info & Protocol Version -->
      <Card :title="t('diagnostics.deviceTitle')" :subtitle="t('diagnostics.deviceDesc')">
        <template #actions><CopyInfo /></template>
        <dl class="diag-meta-grid">
          <div class="diag-meta-item">
            <dt class="micro">{{ t('settings.firmwareVersion') }}</dt>
            <dd class="num">{{ device.info?.firmware ?? '—' }}</dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('settings.boardId') }}</dt>
            <dd class="num">{{ device.info?.boardIdHex ? `0x${device.info.boardIdHex.toUpperCase()}` : '—' }}</dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('diagnostics.pcb') }}</dt>
            <dd class="num">{{ device.info?.pcb ?? '—' }}</dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('diagnostics.serial') }}</dt>
            <dd class="num">{{ device.info?.serial ?? '—' }}</dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('diagnostics.buildTime') }}</dt>
            <dd class="num">{{ formatBuildTime(device.info?.timestamp) }}</dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('settings.protocolVersion') }}</dt>
            <dd class="num">
              {{ device.version ? `${device.version.main}.${device.version.sub}.${device.version.hardware}.${device.version.software}` : '—' }}
            </dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('diagnostics.runMode') }}</dt>
            <dd class="num">{{ device.info?.runMode ?? '—' }}</dd>
          </div>
          <div class="diag-meta-item">
            <dt class="micro">{{ t('diagnostics.type') }}</dt>
            <dd class="num">{{ device.info ? `${device.info.type} / ${device.info.subType}` : '—' }}</dd>
          </div>
        </dl>
      </Card>

      <!-- 2. Feature Bitmap -->
      <Card :title="t('diagnostics.featuresTitle')" :subtitle="t('diagnostics.featuresDesc')">
        <div class="diag-features">
          <span
            v-for="feat in features"
            :key="feat.label"
            class="diag-feat-badge"
            :class="{ 'diag-feat-badge--active': feat.enabled }"
          >
            <span class="diag-feat-badge__dot" aria-hidden="true" />
            <span class="diag-feat-badge__label">{{ feat.label }}</span>
            <span class="diag-feat-badge__state" aria-hidden="true">{{ feat.enabled ? '✓' : '✕' }}</span>
            <span class="sr-only">{{ feat.enabled ? t('diagnostics.featOn') : t('diagnostics.featOff') }}</span>
          </span>
        </div>
      </Card>

      <!-- 3. Transport Latency Stats -->
      <Card :title="t('diagnostics.latencyTitle')" :subtitle="t('diagnostics.latencyDesc')">
        <div class="diag-stats-grid">
          <div class="diag-stat-card">
            <span class="micro">{{ t('diagnostics.lastLatency') }}</span>
            <span class="diag-stat-card__val num">{{ stats.lastLatencyMs.toFixed(1) }} ms</span>
          </div>
          <div class="diag-stat-card">
            <span class="micro">{{ t('diagnostics.avgLatency') }}</span>
            <span class="diag-stat-card__val num">{{ stats.avgLatencyMs.toFixed(1) }} ms</span>
          </div>
          <div class="diag-stat-card">
            <span class="micro">{{ t('diagnostics.totalRequests') }}</span>
            <span class="diag-stat-card__val num">{{ stats.requests }}</span>
          </div>
          <div class="diag-stat-card">
            <span class="micro">{{ t('diagnostics.timeouts') }}</span>
            <span class="diag-stat-card__val num" :class="{ 'diag-stat-card__val--warn': stats.timeouts > 0 }">
              {{ stats.timeouts }}
            </span>
          </div>
        </div>
      </Card>

      <!-- 4. Packet Log -->
      <Card :title="t('diagnostics.packetLogTitle')" :subtitle="t('diagnostics.packetLogDesc', { n: LOG_ROWS })">
        <template #actions>
          <Button size="sm" variant="ghost" @click="togglePause">
            <IconPlayerPlay v-if="paused" :size="15" />
            <IconPlayerPause v-else :size="15" />
            {{ paused ? t('diagnostics.logResume') : t('diagnostics.logPause') }}
          </Button>
          <Button size="sm" variant="ghost" @click="copyLog">
            <IconCheck v-if="copied" :size="15" />
            <IconCopy v-else :size="15" />
            {{ t('diagnostics.copyLog') }}
          </Button>
        </template>

        <div class="diag-log-toolbar">
          <Segmented
            v-model="logFilter"
            :options="filterOptions"
            :label="t('diagnostics.packetLogTitle')"
            size="sm"
          />
          <input
            v-model="logSearch"
            type="search"
            class="diag-log-search"
            :placeholder="t('diagnostics.searchPlaceholder')"
          >
        </div>

        <div class="diag-log-box">
          <div v-if="filteredPackets.length" class="diag-log-entries">
            <div
              v-for="(p, i) in filteredPackets"
              :key="i"
              class="diag-log-line"
              :class="`diag-log-line--${p.dir}`"
            >
              <span class="diag-log-line__time num">{{ new Date(p.t).toISOString().slice(11, 23) }}</span>
              <span class="diag-log-line__dir" :class="`diag-log-line__dir--${p.dir}`">
                {{ p.dir.toUpperCase() }}
              </span>
              <span class="diag-log-line__hex num">{{ rowText(p) }}</span>
              <span v-if="p.note" class="diag-log-line__note">{{ p.note }}</span>
            </div>
          </div>
          <p v-else class="diag-log-empty">{{ t('diagnostics.logEmpty') }}</p>
        </div>
      </Card>

      <!-- 5. Backup & Restore (JSON) -->
      <Card :subtitle="t('diagnostics.backupDesc')">
        <template #title><span id="diag-backup-title" tabindex="-1">{{ t('diagnostics.backupTitle') }}</span></template>
        <div class="diag-backup-actions">
          <Button
            variant="primary"
            :loading="diag.isExporting"
            :disabled="diag.isRestoring"
            @click="exportBackup"
          >
            <IconDownload :size="16" />
            {{ diag.isExporting ? t('diagnostics.exporting') : t('diagnostics.exportButton') }}
          </Button>
          <Button
            variant="secondary"
            :disabled="diag.isRestoring || diag.isExporting || readOnly"
            @click="triggerImport"
          >
            <IconUpload :size="16" />
            {{ t('diagnostics.importButton') }}
          </Button>
          <p v-if="readOnly" class="diag-warn">{{ t('diagnostics.importReadOnly') }}</p>
          <input
            ref="fileInput"
            type="file"
            accept=".json"
            style="display: none"
            @change="onFileSelected"
          >
        </div>
      </Card>
    </div>

    <!-- Import Diff Confirmation Dialog -->
    <Dialog
      :open="importDialogOpen"
      @update:open="onImportOpen"
      :title="t('diagnostics.importTitle')"
      :width="480"
    >
      <div v-if="activeDiff" class="diag-diff-body">
        <div class="diag-diff-meta">
          <span class="micro">{{ t('settings.boardId') }}: 0x{{ activeDiff.payload.boardIdHex.toUpperCase() }}</span>
          <span class="micro num">{{ new Date(activeDiff.payload.timestamp).toLocaleString() }}</span>
        </div>
        <p class="diag-diff-overwrite">
          {{ activeDiff.payload.profileName
            ? t('diagnostics.importOverwriteFrom', { from: activeDiff.payload.profileName, current: device.activeProfileName })
            : t('diagnostics.importOverwrite', { current: device.activeProfileName }) }}
        </p>
        <div class="diag-diff-list">
          <div class="diag-diff-item">
            {{ t('diagnostics.importDiffKeymap', { n: activeDiff.keymapDiffCount }) }}
          </div>
          <div class="diag-diff-item">
            {{ t('diagnostics.importDiffPerf', { n: activeDiff.perfDiffCount }) }}
          </div>
          <div class="diag-diff-item">
            {{ t('diagnostics.importDiffSettings', { n: activeDiff.settingsDiffCount }) }}
          </div>
        </div>
        <div class="diag-diff-notice">
          {{ t('diagnostics.importUnsupportedNotice') }}
        </div>
        <div class="diag-diff-actions">
          <Button variant="ghost" :disabled="diag.isRestoring" @click="importDialogOpen = false">
            {{ t('diagnostics.importCancel') }}
          </Button>
          <Button
            variant="danger"
            :loading="diag.isRestoring"
            :disabled="readOnly"
            @click="doRestore"
          >
            {{ diag.isRestoring ? t('diagnostics.importRestoring') : t('diagnostics.importConfirm') }}
          </Button>
        </div>
      </div>
    </Dialog>
  </PageLayout>
</template>

<style scoped>
.diag-container {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
}
.diag-meta-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: var(--s-4);
  margin: 0;
}
.diag-meta-item {
  min-width: 0;
}
.diag-meta-item dt {
  color: var(--fg-3);
  margin-bottom: 4px;
}
.diag-meta-item dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--fg-1);
  font-size: var(--fs-body);
  font-weight: 500;
}
.diag-features {
  display: flex;
  flex-wrap: wrap;
  gap: var(--s-2);
}
.diag-feat-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: var(--r-control);
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  color: var(--fg-3);
  font-size: var(--fs-label);
}
.diag-feat-badge--active {
  background: var(--bg-3);
  border-color: var(--line-2);
  color: var(--fg-1);
}
.diag-feat-badge__state {
  font-weight: 600;
  color: var(--fg-4);
}
.diag-feat-badge--active .diag-feat-badge__state {
  color: var(--acc);
}
.diag-warn {
  color: var(--warn);
  font-size: var(--fs-label);
  flex-basis: 100%;
}
.diag-diff-overwrite {
  color: var(--warn);
  font-size: var(--fs-body);
  margin: 0;
}
.diag-feat-badge__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-4);
}
.diag-feat-badge--active .diag-feat-badge__dot {
  background: var(--acc);
  box-shadow: 0 0 6px var(--acc);
}
.diag-stats-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--s-3);
}
.diag-stat-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: var(--s-3);
  border-radius: var(--r-control);
  background: var(--bg-1);
  border: 1px solid var(--line-1);
}
.diag-stat-card__val {
  font-size: 20px;
  font-weight: 600;
  color: var(--fg-1);
}
.diag-stat-card__val--warn {
  color: var(--warn);
}
.diag-log-toolbar {
  display: flex;
  align-items: center;
  gap: var(--s-3);
}
.diag-log-search {
  flex: 1;
  max-width: 280px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-1);
  color: var(--fg-1);
  font-size: var(--fs-label);
}
.diag-log-search:focus {
  border-color: var(--acc-line);
  box-shadow: var(--focus-ring);
  outline: none;
}
.diag-log-box {
  background: var(--bg-1);
  border: 1px solid var(--line-1);
  border-radius: var(--r-control);
  padding: var(--s-3);
  max-height: 340px;
  overflow-y: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: var(--fs-caption);
}
.diag-log-entries {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.diag-log-line {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 2px 10px;
  line-height: 1.4;
}
.diag-log-line__time {
  color: var(--fg-4);
  flex: none;
}
.diag-log-line__dir {
  font-weight: 600;
  font-size: var(--fs-caption);
  padding: 0 4px;
  border-radius: 3px;
  flex: none;
}
.diag-log-line__dir--in {
  color: var(--d-in);
  background: color-mix(in srgb, var(--d-in) var(--soft-pct), transparent);
}
.diag-log-line__dir--out {
  color: var(--d-out);
  background: color-mix(in srgb, var(--d-out) var(--soft-pct), transparent);
}
.diag-log-line__hex {
  color: var(--fg-2);
  letter-spacing: 0.05em;
  min-width: 0;
  overflow-wrap: anywhere;
}
.diag-log-line__note {
  color: var(--fg-3);
  font-style: italic;
}
.diag-log-empty {
  color: var(--fg-3);
  text-align: center;
  padding: var(--s-4);
  font-size: var(--fs-label);
}
.diag-backup-actions {
  display: flex;
  gap: var(--s-3);
  flex-wrap: wrap;
}
.diag-diff-body {
  display: flex;
  flex-direction: column;
  gap: var(--s-4);
}
.diag-diff-meta {
  display: flex;
  justify-content: space-between;
  padding-bottom: var(--s-2);
  border-bottom: 1px solid var(--line-1);
  color: var(--fg-3);
}
.diag-diff-list {
  display: flex;
  flex-direction: column;
  gap: var(--s-2);
  font-size: var(--fs-body);
  color: var(--fg-1);
}
.diag-diff-notice {
  font-size: var(--fs-label);
  color: var(--fg-3);
  line-height: 1.4;
}
.diag-diff-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--s-2);
  margin-top: var(--s-2);
}
</style>
