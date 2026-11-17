<script setup lang="ts">
// Step 1, Trực tuyến (DESIGN OFU §3.2, §3.3): the status card, the other builds, the list line, and the download block. Opening
// it reads only the list (the store); a file is downloaded only on a button press. Nothing here sends anything to the keyboard.
import { computed } from 'vue';
import type { Component } from 'vue';
import {
  IconAlertCircle, IconAlertTriangle, IconChevronRight, IconCircleArrowUp, IconCircleCheck, IconCircleX, IconDownload, IconExternalLink,
  IconInfoCircle, IconList, IconRefresh, IconUpload, IconX,
} from '@tabler/icons-vue';
import Button from '../ui/Button.vue';
import FwMakerLink from './FwMakerLink.vue';
import { boardHex } from '../../protocol/firmware';
import { FW_DESKTOP } from '../../protocol/fwDownload';
import { compareVersions } from '../../protocol/fwManifest';
import type { FwBuild } from '../../protocol/fwManifest';
import { useFirmwareStore } from '../../stores/firmware';
import { locale } from '../../i18n/locale';
import { t } from '../../i18n/vi';
import { fwDate, kib } from './fwText';

const emit = defineEmits<{ pick: [] }>();
const fw = useFirmwareStore();
/** The desktop app reads the list built into it: its own list line, no "Kiểm tra lại" (§7.1). */
const DESKTOP = FW_DESKTOP;

type Tone = 'acc' | 'ok' | 'info' | 'warn' | 'danger';
interface Act { kind: 'download' | 'link' | 'pickSaved' | 'retry' | 'pickLocal' | 'reread'; label: string; variant: 'primary' | 'secondary' | 'ghost'; icon: Component; build?: FwBuild }
interface CardView { tone: Tone; icon: Component | null; h: string; ps: string[]; acts: Act[]; live?: boolean }

const st = computed(() => fw.status);
const model = computed(() => fw.model ?? '—');
const cur = computed(() => fw.current ?? '—');

/** The buttons that fetch a build: a download when the list allows it, else the maker's link and "pick the saved file". */
function getActs(b: FwBuild, label: string, variant: Act['variant'], icon: Component = IconDownload): Act[] {
  if (fw.canFetch(b)) return [{ kind: 'download', label, variant, icon, build: b }];
  return [
    { kind: 'link', label: t('fw.on.link'), variant: 'secondary', icon: IconExternalLink, build: b },
    { kind: 'pickSaved', label: t('fw.on.pickSaved'), variant: 'secondary', icon: IconUpload },
  ];
}

const card = computed<CardView>(() => {
  const s = st.value.status;
  const n = st.value.newest;
  const retry: Act[] = [
    { kind: 'retry', label: t('fw.on.retry'), variant: 'secondary', icon: IconRefresh },
    { kind: 'pickLocal', label: t('fw.on.pickLocal'), variant: 'ghost', icon: IconUpload },
  ];
  if (s === 'loading') return { tone: 'info', icon: null, h: t('fw.on.loading'), ps: [], acts: [], live: true };
  if (s === 'offline') return { tone: 'warn', icon: IconAlertTriangle, h: t('fw.on.offline'), ps: [t('fw.on.offlineBody')], acts: retry };
  if (s === 'invalid') return { tone: 'danger', icon: IconAlertCircle, h: t('fw.on.invalid'), ps: [t('fw.on.nothingSent')], acts: retry };
  if (s === 'none' || !n) {
    return {
      tone: 'info', icon: IconInfoCircle, h: t('fw.on.none', { board: fw.deviceBoard === null ? '—' : boardHex(fw.deviceBoard) }), ps: [],
      acts: [{ kind: 'pickLocal', label: t('fw.on.pickLocal'), variant: 'secondary', icon: IconUpload }],
    };
  }
  const link = fw.canFetch(n) ? [] : [t('fw.on.linkBody')];
  const notes = (locale.value === 'vi' ? n.notes.vi : n.notes.en).trim();
  const latest = t('fw.on.latestFor', { model: model.value, v: n.version });
  switch (s) {
    case 'rescue':
      return { tone: 'info', icon: IconInfoCircle, h: latest, ps: [t('fw.on.rescueBody', { date: fwDate(n.date), kib: kib(n.size) }), ...link], acts: getActs(n, t('fw.on.download'), 'primary') };
    case 'noVersion':
      return { tone: 'info', icon: IconInfoCircle, h: latest, ps: [t('fw.on.noVersion'), ...link], acts: getActs(n, t('fw.on.download'), 'secondary') };
    case 'ahead':
      return { tone: 'info', icon: IconInfoCircle, h: t('fw.on.ahead', { cur: cur.value }), ps: [t('fw.on.aheadBody')], acts: [] };
    case 'kindUnknown':
      return {
        tone: 'info', icon: IconInfoCircle, h: latest, ps: [t('fw.on.kindUnknownBody', { cur: cur.value }), ...link],
        acts: [...getActs(n, t('fw.on.download'), 'secondary'), { kind: 'reread', label: t('fw.on.kindRetry'), variant: 'ghost', icon: IconRefresh }],
      };
    case 'third':
      return { tone: 'warn', icon: IconAlertTriangle, h: t('fw.on.third', { cur: cur.value }), ps: [t('fw.on.thirdBody', { v: n.version }), ...link], acts: getActs(n, t('fw.on.thirdBtn'), 'secondary') };
    case 'uptodate':
      return {
        tone: 'ok', icon: IconCircleCheck, h: t('fw.on.uptodate', { name: n.name, v: n.version }), ps: [t('fw.on.uptodateBody', { date: fwDate(n.date) })],
        acts: fw.canFetch(n) ? [{ kind: 'download', label: t('fw.on.rewrite'), variant: 'ghost', icon: IconRefresh, build: n }]
          : [{ kind: 'link', label: t('fw.on.link'), variant: 'secondary', icon: IconExternalLink, build: n }],
      };
    default:
      return {
        tone: 'acc', icon: IconCircleArrowUp, h: t('fw.on.newer', { name: n.name, v: n.version }),
        ps: [`${t('fw.on.meta', { date: fwDate(n.date), kib: kib(n.size) })} · ${t('fw.on.running', { cur: cur.value })}`, ...(notes ? [notes] : []), ...link],
        acts: getActs(n, t('fw.on.download'), 'primary'),
      };
  }
});

/** "Các bản khác": the board's other builds, newest first (all but the one the card offers). */
const others = computed(() => {
  const s = st.value.status;
  if (!['newer', 'uptodate', 'ahead', 'third', 'noVersion', 'kindUnknown'].includes(s)) return [];
  const shown = s === 'ahead' ? null : st.value.newest;
  const plain = s !== 'third' && s !== 'kindUnknown';
  return fw.builds.filter((b) => b !== shown).map((b) => {
    const c = fw.current ? compareVersions(b.appVersion, fw.current) : null;
    const running = c === 0 && plain;
    const chip = c === null ? null : running ? 'running' : c > 0 ? 'newer' : 'older';
    return { b, chip, running };
  });
});
const othersLink = computed(() => others.value.some((o) => !o.running && !fw.canFetch(o.b)));

const listLine = computed(() => {
  const l = fw.list;
  if (!l || fw.listState !== 'ok') return '';
  return t(DESKTOP ? 'fw.on.listLineDesktop' : 'fw.on.listLine', { updated: fwDate(l.updated) });
});

// ---- the download block
const d = computed(() => fw.dl);
const pct = computed(() => (d.value && d.value.build.size > 0 ? Math.min(100, (d.value.done / d.value.build.size) * 100) : 0));
const dlErr = computed(() => {
  const x = d.value;
  if (!x) return '';
  if (x.state === 'cut') return t('fw.dl.cut', { done: kib(x.done), total: kib(x.build.size) });
  if (x.state === 'tooBig') return t('fw.dl.tooBig');
  if (x.state === 'noNet') return t('fw.dl.noNet');
  return '';
});

function act(a: Act): void {
  if (a.kind === 'download' && a.build) void fw.download(a.build);
  else if (a.kind === 'retry') void fw.loadList();
  else if (a.kind === 'reread') void fw.readKind(true);
  else if (a.kind === 'pickLocal' || a.kind === 'pickSaved') emit('pick');
}
</script>

<template>
  <!-- the download block replaces the card while a download runs or after it failed (DESIGN OFU §3.3) -->
  <template v-if="d">
    <div v-if="d.state === 'run'" class="ofu-dl" data-test="ofu-dl">
      <div class="ofu-dl__row">
        <p class="ofu-dl__t">{{ t('fw.dl.progress', { name: d.build.name, v: d.build.version, done: kib(d.done), total: kib(d.build.size) }) }}</p>
        <Button size="sm" variant="ghost" :icon="IconX" @click="fw.stopDownload()">{{ t('fw.dl.stop') }}</Button>
      </div>
      <div
        class="ofu-bar"
        role="progressbar"
        :aria-label="t('fw.dl.label')"
        aria-valuemin="0"
        :aria-valuemax="d.build.size"
        :aria-valuenow="d.done"
        :aria-valuetext="`${Math.round(pct)}%`"
      ><i :style="{ width: `${pct.toFixed(1)}%` }" /></div>
      <p class="ofu-dl__from">{{ t('fw.dl.from') }}</p>
    </div>
    <div v-else-if="d.state === 'fallback'" class="ofu-st ofu-st--info" role="status" data-test="ofu-fallback">
      <div class="ofu-st__main">
        <span class="ofu-st__ic"><IconInfoCircle :size="20" stroke-width="1.75" aria-hidden="true" /></span>
        <div class="ofu-st__tx">
          <p class="ofu-st__h">{{ t('fw.dl.fallback', { name: d.build.name, v: d.build.version }) }}</p>
          <p class="ofu-st__p">{{ t('fw.dl.fallbackBody') }}</p>
        </div>
      </div>
      <div class="ofu-st__act">
        <FwMakerLink :url="d.build.url" :icon="IconExternalLink">{{ t('fw.on.link') }}</FwMakerLink>
        <Button size="sm" :icon="IconUpload" @click="emit('pick')">{{ t('fw.on.pickSaved') }}</Button>
        <Button size="sm" variant="ghost" :icon="IconRefresh" @click="fw.download(d.build)">{{ t('fw.on.retry') }}</Button>
        <Button size="sm" variant="ghost" :icon="IconList" @click="fw.backToList()">{{ t('fw.dl.change') }}</Button>
      </div>
    </div>
    <template v-else>
      <p class="fw-err" role="alert" data-test="ofu-dl-err"><IconCircleX :size="15" stroke-width="1.75" aria-hidden="true" /><span>{{ dlErr }}</span></p>
      <div class="ofu-btns">
        <Button size="sm" :icon="IconRefresh" @click="fw.download(d.build)">{{ t('fw.dl.again') }}</Button>
        <Button size="sm" variant="ghost" :icon="IconList" @click="fw.backToList()">{{ t('fw.dl.change') }}</Button>
      </div>
    </template>
  </template>
  <template v-else>
    <div class="ofu-st" :class="`ofu-st--${card.tone}`" :role="card.live ? 'status' : undefined" data-test="ofu-card" :data-status="st.status">
      <div class="ofu-st__main">
        <span class="ofu-st__ic">
          <span v-if="!card.icon" class="ofu-spin" aria-hidden="true" />
          <component :is="card.icon" v-else :size="20" stroke-width="1.75" aria-hidden="true" />
        </span>
        <div class="ofu-st__tx">
          <p class="ofu-st__h">{{ card.h }}</p>
          <p v-for="(p, i) in card.ps" :key="i" class="ofu-st__p">{{ p }}</p>
        </div>
      </div>
      <div v-if="card.acts.length" class="ofu-st__act">
        <template v-for="a in card.acts" :key="a.kind + a.label">
          <FwMakerLink v-if="a.kind === 'link'" :variant="a.variant" :url="a.build!.url" :icon="a.icon">{{ a.label }}</FwMakerLink>
          <Button v-else size="sm" :variant="a.variant" :icon="a.icon" :disabled="!fw.canChoose" @click="act(a)">{{ a.label }}</Button>
        </template>
      </div>
    </div>
    <details v-if="others.length" class="ofu-oth" data-test="ofu-others">
      <summary><IconChevronRight :size="14" stroke-width="2" aria-hidden="true" />{{ t('fw.on.others', { n: others.length }) }}</summary>
      <div class="ofu-tblw">
        <table class="ofu-tbl">
          <thead>
            <tr>
              <th scope="col">{{ t('fw.on.col.v') }}</th>
              <th scope="col">{{ t('fw.on.col.date') }}</th>
              <th scope="col">{{ t('fw.on.col.size') }}</th>
              <th scope="col"><span class="sr-only">{{ t('fw.on.col.chip') }}</span></th>
              <th scope="col"><span class="sr-only">{{ t('fw.on.col.act') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in others" :key="o.b.sha256">
              <td class="v">{{ o.b.version }}</td>
              <td>{{ fwDate(o.b.date) }}</td>
              <td>{{ kib(o.b.size) }} KiB</td>
              <td><span v-if="o.chip" class="ofu-chip" :class="{ 'ofu-chip--run': o.chip === 'running' }">{{ t(`fw.on.chip.${o.chip}` as 'fw.on.chip.running') }}</span></td>
              <td class="a">
                <template v-if="!o.running">
                  <Button v-if="fw.canFetch(o.b)" size="sm" :icon="IconDownload" :disabled="!fw.canChoose" @click="fw.download(o.b)">{{ t('fw.on.get') }}</Button>
                  <FwMakerLink v-else :url="o.b.url" :icon="IconExternalLink">{{ t('fw.on.getLink') }}</FwMakerLink>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-if="othersLink" class="ofu-oth__foot">
        <p>{{ t('fw.on.othersLinkNote') }}</p>
        <Button size="sm" variant="ghost" :icon="IconUpload" @click="emit('pick')">{{ t('fw.on.pickSaved') }}</Button>
      </div>
    </details>
    <div v-if="listLine" class="ofu-list" data-test="ofu-list">
      <p>{{ listLine }}</p>
      <Button v-if="!DESKTOP" size="sm" variant="ghost" :icon="IconRefresh" @click="fw.loadList()">{{ t('fw.on.recheck') }}</Button>
    </div>
  </template>
</template>

<style scoped>
.ofu-st {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); padding: var(--s-3);
  border: 1px solid var(--line-1); border-radius: var(--r-card); background: var(--bg-1);
}
.ofu-st__main { display: flex; gap: 10px; align-items: flex-start; flex: 1 1 300px; min-width: 0; }
.ofu-st__ic { flex: none; display: grid; place-items: center; width: 20px; height: 20px; margin-top: 1px; color: var(--fg-3); }
.ofu-st__tx { min-width: 0; }
.ofu-st__h { margin: 0; font-size: var(--fs-body); line-height: 20px; font-weight: 600; color: var(--fg-1); overflow-wrap: anywhere; }
.ofu-st__p { margin: 2px 0 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-2); overflow-wrap: anywhere; }
.ofu-st__act { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-left: auto; }
.ofu-st--acc .ofu-st__ic { color: var(--acc); }
.ofu-st--acc { border-color: var(--acc-line, var(--line-3)); }
.ofu-st--ok .ofu-st__ic { color: var(--ok); }
.ofu-st--info .ofu-st__ic { color: var(--info); }
.ofu-st--warn { background: var(--warn-soft); border-color: color-mix(in srgb, var(--warn) 35%, var(--line-1)); }
.ofu-st--warn .ofu-st__ic { color: var(--warn); }
.ofu-st--danger { background: var(--danger-soft); border-color: color-mix(in srgb, var(--danger) 35%, var(--line-1)); }
.ofu-st--danger .ofu-st__ic, .ofu-st--danger .ofu-st__h { color: var(--danger); }
.ofu-spin { width: 16px; height: 16px; border: 2px solid var(--line-3); border-top-color: var(--acc); border-radius: 50%; animation: ofu-spin 0.9s linear infinite; }
@keyframes ofu-spin { to { transform: rotate(360deg); } }

.ofu-oth { border-radius: var(--r-control); }
.ofu-oth > summary {
  display: inline-flex; align-items: center; gap: 6px; cursor: pointer; list-style: none; padding: 2px 4px 2px 0;
  font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); border-radius: 4px;
}
.ofu-oth > summary::-webkit-details-marker { display: none; }
.ofu-oth > summary svg { transition: transform var(--t-fast) var(--ease); color: var(--fg-3); }
.ofu-oth[open] > summary svg { transform: rotate(90deg); }
.ofu-oth > summary:hover { color: var(--fg-1); }
.ofu-oth > summary:focus-visible { outline: none; box-shadow: var(--focus-ring); }
.ofu-tblw { overflow-x: auto; }
.ofu-tbl { width: 100%; margin-top: 6px; border-collapse: collapse; font-size: var(--fs-label); font-variant-numeric: tabular-nums; }
.ofu-tbl th { padding: 4px 8px; text-align: left; font-weight: 600; font-size: var(--fs-caption); color: var(--fg-3); }
.ofu-tbl td { padding: 6px 8px; border-top: 1px solid var(--line-1); color: var(--fg-2); white-space: nowrap; }
.ofu-tbl td.v { color: var(--fg-1); font-weight: 600; }
.ofu-tbl td.a { text-align: right; width: 1%; }
.ofu-chip {
  display: inline-flex; align-items: center; height: 20px; padding: 0 8px; border: 1px solid var(--line-3); border-radius: 999px;
  font-size: var(--fs-caption); font-weight: 600; color: var(--fg-2);
}
.ofu-chip--run { border-color: var(--ok); color: var(--ok); }
.ofu-oth__foot { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); margin-top: 6px; padding: 0 8px; }
.ofu-oth__foot p { flex: 1 1 260px; margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-3); }

.ofu-list { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.ofu-list p { flex: 1 1 280px; margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-3); }

.ofu-dl { display: flex; flex-direction: column; gap: 8px; padding: var(--s-3); border: 1px solid var(--line-1); border-radius: var(--r-card); background: var(--bg-1); }
.ofu-dl__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.ofu-dl__t { flex: 1 1 260px; margin: 0; font-size: var(--fs-label); font-weight: 600; color: var(--fg-1); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.ofu-dl__from { margin: 0; font-size: var(--fs-caption); color: var(--fg-3); }
.ofu-bar { height: 6px; border-radius: 3px; background: var(--line-1); overflow: hidden; }
.ofu-bar > i { display: block; height: 100%; border-radius: 3px; background: var(--acc); transition: width 120ms linear; }
@media (prefers-reduced-motion: reduce) {
  .ofu-spin { animation: none; border-right-color: var(--acc); }
  .ofu-bar > i { transition: none; }
}
.ofu-btns { display: flex; flex-wrap: wrap; gap: var(--s-2); }
.fw-err {
  display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control);
  background: var(--danger-soft); color: var(--danger); font-size: var(--fs-label); line-height: 18px;
}
.fw-err svg { flex: none; margin-top: 1px; }
.fw-err span { min-width: 0; overflow-wrap: anywhere; }
</style>
