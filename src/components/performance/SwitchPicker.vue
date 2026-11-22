<script setup lang="ts">
// Switch picker dialog: maker tabs + Custom tab (ready-made, user switches, generic switch, not-usable),
// create/edit/copy/generic form view, switch pack panel & import view, swap question, rename-only (DESIGN CSW §4–§7).
// Choosing, searching, form, packs, rename-only and "Quay lại" write 0 HID. Only Apply writes.
import { computed, nextTick, ref, useId, watch } from 'vue';
import {
  IconAlertTriangle, IconArrowRight, IconChevronRight, IconCopy, IconFileImport,
  IconInfoCircle, IconPencil, IconPencilPlus, IconPlus, IconRefresh, IconSearch, IconTrash,
} from '@tabler/icons-vue';
import Dialog from '../ui/Dialog.vue';
import Button from '../ui/Button.vue';
import Tabs from '../ui/Tabs.vue';
import type { TabItem } from '../ui/Tabs.vue';
import { formatMm } from '../ui/NumberField.vue';
import { useToast } from '../ui/toast';
import SwitchSwatch from './SwitchSwatch.vue';
import CustomSwitchForm from './CustomSwitchForm.vue';
import SwitchPackPanel from './SwitchPackPanel.vue';
import SwitchPackImport from './SwitchPackImport.vue';
import { groupKeys, identityOrder, swatchForKeySwitch } from './switchGroups';
import type { KeyGroup } from './switchGroups';
import {
  CUSTOM_SWITCH_MAX, GENERIC_START, GENERIC_UID,
  foldText, newCustomUid, readyToCustomLike, userToCustomLike,
} from '../../data/customSwitch';
import type { CustomLike, CustomSwitch } from '../../data/customSwitch';
import { INCOMPATIBLE_SWITCHES, READY_BOUNDS, READY_SWITCHES, findReadySwitch } from '../../data/readySwitches';
import type { ReadyNote, ReadySwitch } from '../../data/readySwitches';
import type { ParsedPack } from '../../data/switchPack';
import { makerTabOf, makerTabs, OTHER_TAB, switchBrand, switchName } from '../../data/switchDisplay';
import { coefBounds, findSwitch, rangeBounds } from '../../protocol/switches';
import type { SwitchEntry } from '../../protocol/switches';
import { isRtMode } from '../../protocol';
import { useDeviceStore } from '../../stores/device';
import { usePerformanceStore } from '../../stores/performance';
import type { ApplySwitchResult, SwitchChoice } from '../../stores/performance';
import { t } from '../../i18n/vi';

const CUSTOM_TAB = 'custom';
const NOTE_WARN = new Set<ReadyNote>(['multiMagnet', 'polarityUnknown']);

const open = defineModel<boolean>('open', { required: true });
const props = withDefaults(defineProps<{
  ids: number[];
  /** When set on open, the picker opens on the custom tab with that entry chosen; nothing is written until Apply (§11.2). */
  initial?: { uid: string } | null;
  /** When true (and initial is not set), open on the custom tab with nothing chosen (§4.3). */
  defaultCustom?: boolean;
}>(), { initial: null, defaultCustom: false });
const emit = defineEmits<{ applied: [] }>();

const perf = usePerformanceStore();
const device = useDeviceStore();
const uid = useId();
const whyId = `${uid}-why`;
const packBtnId = `${uid}-pack-btn`;
const packPanelId = `${uid}-pack-panel`;
const askTitleId = `${uid}-ask-q`;
const askBodyId = `${uid}-ask-b`;

const entries = computed(() => perf.catalog ?? []);
const grouped = computed(() => makerTabs(entries.value));
const rb = computed(() => rangeBounds(perf.catalog) ?? { min: READY_BOUNDS.rMin, max: READY_BOUNDS.rMax });
const cb = computed(() => coefBounds(perf.catalog) ?? { min: READY_BOUNDS.cMin, max: READY_BOUNDS.cMax });
const clampInt = (v: number, b: { min: number; max: number }) => Math.min(b.max, Math.max(b.min, Math.round(v)));
const mm = (um: number) => formatMm(um / 1000, 3);

const tabs = computed<TabItem[]>(() => [
  ...grouped.value.map((g) => ({ id: g.id, label: g.label ?? t('sw.groupOther'), count: g.entries.length })),
  {
    id: CUSTOM_TAB,
    label: t('csw.tab'),
    count: READY_SWITCHES.length + perf.customSwitches.length + 1,
    icon: IconPencilPlus,
    apart: true,
  },
]);
const tabLabel = (id: string) => tabs.value.find((x) => x.id === id)?.label ?? t('sw.groupOther');

// ---- Selected keys grouped by identity (§9.3)
const keyGroups = computed(() =>
  groupKeys(props.ids, (id) => perf.keySwitch(id), (ks) => identityOrder(ks, perf.catalog)),
);
const single = computed(() => keyGroups.value.length === 1);
const inUse = computed(() => new Map(keyGroups.value.map((g) => [g.key, g.ids.length] as const)));

const tab = ref<string>(OTHER_TAB);
const chosen = ref<SwitchChoice | null>(null);
const asking = ref(false);

/** The maker eyebrow on catalog tiles, only where the active tab does not already name that maker; never Unknown. */
const brandOf = (e: SwitchEntry) => {
  const b = switchBrand(e.id);
  return b && b !== tab.value ? b : null;
};

function defaultTab(): string {
  const firstKnown = keyGroups.value.find((g) => g.identity.kind === 'custom' || g.identity.kind === 'catalog');
  if (firstKnown?.identity.kind === 'custom') return CUSTOM_TAB;
  if (firstKnown?.identity.kind === 'catalog') {
    return makerTabOf(grouped.value, firstKnown.identity.entry.id) || grouped.value[0]?.id || OTHER_TAB;
  }
  return grouped.value[0]?.id || OTHER_TAB;
}

function customLikeByUid(targetUid: string): CustomLike | null {
  if (targetUid === GENERIC_UID) return perf.genericEntry;
  const ready = findReadySwitch(targetUid);
  if (ready) return readyToCustomLike(ready);
  const user = perf.customSwitches.find((u) => u.uid === targetUid);
  if (user) return userToCustomLike(user);
  return null;
}

// ---- Dialog views: 'pick' | 'form' | 'import'
type ViewMode = 'pick' | 'form' | 'import';
const view = ref<ViewMode>('pick');
const bodyHeightPx = ref<number | null>(null);
const formState = ref<{
  mode: 'new' | 'edit' | 'copy' | 'generic';
  entry?: CustomSwitch | null;
  copyFrom?: ReadySwitch | null;
} | null>(null);
const importState = ref<{ fileName: string; result: ParsedPack } | null>(null);
const formDeleting = ref(false);

const dialogTitle = computed(() => {
  if (view.value === 'import') return t('csw.pkTitle');
  if (view.value === 'form' && formState.value) {
    if (formState.value.mode === 'generic') return t('csw.formGeneric');
    if (formState.value.mode === 'edit') return t('csw.formEdit');
    return t('csw.formNew');
  }
  return t('sw.pickTitle');
});

// ---- Element refs
const swpRef = ref<HTMLElement | null>(null);
const listRef = ref<HTMLElement | null>(null);
const customScrollRef = ref<HTMLElement | null>(null);
const customRadiosRef = ref<HTMLElement | null>(null);
const mineHeadingRef = ref<HTMLElement | null>(null);
const createBtnRef = ref<InstanceType<typeof Button> | null>(null);
const packBtnRef = ref<InstanceType<typeof Button> | null>(null);
const entryActBtnRef = ref<InstanceType<typeof Button> | null>(null);
const applyBtnRef = ref<InstanceType<typeof Button> | null>(null);
const askYesBtnRef = ref<InstanceType<typeof Button> | null>(null);
const formRef = ref<InstanceType<typeof CustomSwitchForm> | null>(null);
const importRef = ref<InstanceType<typeof SwitchPackImport> | null>(null);
const delBtnRef = ref<InstanceType<typeof Button> | null>(null);
const delCancelBtnRef = ref<InstanceType<typeof Button> | null>(null);
const importAddBtnRef = ref<InstanceType<typeof Button> | null>(null);
const importBackBtnRef = ref<InstanceType<typeof Button> | null>(null);

let returnFocusKind: 'create' | 'pack' | 'entry' | null = null;

// ---- Custom tab state (§4.4, §5)
const query = ref('');
const whyOpen = ref(false);
const packOpen = ref(false);
const atMax = computed(() => perf.customSwitches.length >= CUSTOM_SWITCH_MAX);

const foldedQuery = computed(() => foldText(query.value));
const matchesQuery = (maker: string, name: string, aka?: string) =>
  !foldedQuery.value || foldText(`${maker} ${name} ${aka ?? ''}`).includes(foldedQuery.value);

const readyFiltered = computed(() => READY_SWITCHES.filter((r) => matchesQuery(r.maker, r.name, r.aka)));
const mineFiltered = computed(() => perf.customSwitches.filter((u) => matchesQuery(u.maker, u.name)));
const badFiltered = computed(() => INCOMPATIBLE_SWITCHES.filter((b) => matchesQuery(b.maker, b.name)));
const noSearchMatch = computed(() =>
  Boolean(foldedQuery.value) && !readyFiltered.value.length && !mineFiltered.value.length && !badFiltered.value.length,
);

function toggleWhy() {
  whyOpen.value = !whyOpen.value;
  if (whyOpen.value) {
    packOpen.value = false;
    void nextTick(() => { if (customScrollRef.value) customScrollRef.value.scrollTop = 0; });
  }
}

function togglePack() {
  asking.value = false;
  packOpen.value = !packOpen.value;
  if (packOpen.value) {
    whyOpen.value = false;
    void nextTick(() => { if (customScrollRef.value) customScrollRef.value.scrollTop = 0; });
  }
}

function onSearchEsc(e: KeyboardEvent) {
  if (query.value !== '') {
    e.stopPropagation();
    query.value = '';
  }
}

// ---- Maker tab & custom tab roving tabindex (§4.5)
const shownCatalog = computed(() => grouped.value.find((g) => g.id === tab.value)?.entries ?? []);
const rovingCatalogId = computed(() => {
  const s = shownCatalog.value;
  const c = chosen.value;
  if (c?.kind === 'catalog' && s.some((e) => e.id === c.entry.id)) return c.entry.id;
  return (s.find((e) => inUse.value.has(`catalog:${e.id}`)) ?? s[0])?.id;
});

type UsableCustomItem = { uid: string; like: CustomLike };
const usableCustomItems = computed<UsableCustomItem[]>(() => [
  ...readyFiltered.value.map((r) => ({ uid: r.uid, like: readyToCustomLike(r) })),
  ...mineFiltered.value.map((u) => ({ uid: u.uid, like: userToCustomLike(u) })),
  { uid: GENERIC_UID, like: perf.genericEntry },
]);

const rovingCustomUid = computed(() => {
  const items = usableCustomItems.value;
  const c = chosen.value;
  if (c?.kind === 'custom' && items.some((x) => x.uid === c.custom.uid)) {
    return c.custom.uid;
  }
  return (items.find((x) => inUse.value.has(`custom:${x.uid}`)) ?? items[0])?.uid;
});

function selectCatalog(e: SwitchEntry) {
  asking.value = false;
  chosen.value = { kind: 'catalog', entry: e };
}

function selectCustom(like: CustomLike) {
  asking.value = false;
  chosen.value = { kind: 'custom', custom: like };
}

watch(tab, () => { asking.value = false; });

watch(open, async (v) => {
  if (!v) return;
  view.value = 'pick';
  asking.value = false;
  formState.value = null;
  importState.value = null;
  formDeleting.value = false;
  bodyHeightPx.value = null;
  query.value = '';
  whyOpen.value = false;
  packOpen.value = false;

  if (props.initial?.uid) {
    tab.value = CUSTOM_TAB;
    const found = customLikeByUid(props.initial.uid);
    chosen.value = found ? { kind: 'custom', custom: found } : null;
  } else if (props.defaultCustom) {
    tab.value = CUSTOM_TAB;
    chosen.value = null;
  } else {
    chosen.value = null;
    tab.value = defaultTab();
  }

  await nextTick();
  await nextTick(); // after Dialog's own first-focus
  const root = tab.value === CUSTOM_TAB ? customRadiosRef.value : listRef.value;
  root?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
});

watch(() => device.connection, () => { open.value = false; });

// ---- Keyboard navigation inside maker and custom radiogroups
function onCatalogKey(e: KeyboardEvent) {
  const n = shownCatalog.value.length;
  if (!n) return;
  const c = chosen.value;
  const i = c?.kind === 'catalog' ? shownCatalog.value.findIndex((x) => x.id === c.entry.id) : -1;
  const cols = Math.max(1, (listRef.value ? getComputedStyle(listRef.value).gridTemplateColumns : '').split(' ').length);
  const from = i < 0 ? shownCatalog.value.findIndex((x) => x.id === rovingCatalogId.value) : i;
  let to: number;
  switch (e.key) {
    case 'ArrowRight': to = from + 1; break;
    case 'ArrowLeft': to = from - 1; break;
    case 'ArrowDown': to = from + cols; break;
    case 'ArrowUp': to = from - cols; break;
    case 'Home': to = 0; break;
    case 'End': to = n - 1; break;
    default: return;
  }
  e.preventDefault();
  to = ((to % n) + n) % n;
  selectCatalog(shownCatalog.value[to]);
  listRef.value?.querySelectorAll<HTMLElement>('.sw-opt')[to]?.focus();
}

function onCustomKey(e: KeyboardEvent) {
  const items = usableCustomItems.value;
  const n = items.length;
  if (!n) return;
  const targetUid = (e.currentTarget as HTMLElement | null)?.dataset.uid;
  const i = targetUid ? items.findIndex((x) => x.uid === targetUid) : -1;
  const from = i >= 0 ? i : Math.max(0, items.findIndex((x) => x.uid === rovingCustomUid.value));
  const grid = (e.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.csw-grid');
  const cols = Math.max(1, (grid ? getComputedStyle(grid).gridTemplateColumns : '').split(' ').length);
  let to: number;
  switch (e.key) {
    case 'ArrowRight': to = from + 1; break;
    case 'ArrowLeft': to = from - 1; break;
    case 'ArrowDown': to = from + cols; break;
    case 'ArrowUp': to = from - cols; break;
    case 'Home': to = 0; break;
    case 'End': to = n - 1; break;
    default: return;
  }
  e.preventDefault();
  to = ((to % n) + n) % n;
  const next = items[to];
  selectCustom(next.like);
  customRadiosRef.value?.querySelector<HTMLElement>(`[data-uid="${next.uid}"]`)?.focus();
}

// ---- Tile formatting helpers (§5.3, §5.7)
function catalogNameOrFallback(id: number, fallback: string): string {
  const e = findSwitch(perf.catalog, id);
  return e ? switchName(e) : fallback;
}

function readySecondLine(r: ReadySwitch): string {
  const base = t('csw.like', { name: catalogNameOrFallback(r.curveFrom.id, r.curveFrom.name) });
  return r.confidence === 'low' ? `${base} · ${t('csw.lowTag')}` : base;
}

function userSecondLine(u: CustomSwitch): string {
  if (u.curve.kind === 'like') return t('csw.like', { name: catalogNameOrFallback(u.curve.id, u.curve.name) });
  if (u.curve.kind === 'travel') return t('csw.likeTravel');
  return t('csw.likeManual', { coef: u.coefficient });
}

function readyAria(r: ReadySwitch): string {
  return [r.name, r.maker, `${mm(r.travelUm)} mm`, readySecondLine(r), t('csw.readyName')].filter(Boolean).join(', ');
}

function userAria(u: CustomSwitch): string {
  return [u.name, u.maker, `${mm(u.travelUm)} mm`, userSecondLine(u), t('csw.mineName')].filter(Boolean).join(', ');
}

const genericSecondLine = computed(() => t('csw.likeManual', { coef: perf.genericEntry.coefficient }));
const genericAria = computed(() => [
  t('csw.generic'),
  t('csw.genericEyebrow'),
  `${mm(perf.genericEntry.rangeUm)} mm`,
  genericSecondLine.value,
  t('csw.genericName'),
].join(', '));

// ---- Chosen entry metadata & plan (§7.2–7.6)
const chosenReady = computed(() =>
  chosen.value?.kind === 'custom' ? (findReadySwitch(chosen.value.custom.uid) ?? null) : null,
);
const chosenUser = computed(() => {
  const c = chosen.value;
  return c?.kind === 'custom' ? (perf.customSwitches.find((u) => u.uid === c.custom.uid) ?? null) : null;
});
const chosenIsGeneric = computed(() =>
  chosen.value?.kind === 'custom' && chosen.value.custom.uid === GENERIC_UID,
);
const chosenColor = computed(() => chosenUser.value?.color ?? '');
const chosenDisplayName = computed(() => {
  if (!chosen.value) return '';
  if (chosen.value.kind === 'catalog') return switchName(chosen.value.entry);
  return chosenIsGeneric.value ? t('csw.generic') : chosen.value.custom.name;
});
const chosenEffectivePair = computed(() => {
  if (!chosen.value || chosen.value.kind !== 'custom') return null;
  return {
    rangeUm: clampInt(chosen.value.custom.rangeUm, rb.value),
    coefficient: clampInt(chosen.value.custom.coefficient, cb.value),
  };
});

const plan = computed(() => (chosen.value ? perf.planSwitch(chosen.value, props.ids) : null));
const hasAction = computed(() => Boolean(plan.value && (plan.value.write > 0 || plan.value.rename > 0)));
const isRenameOnly = computed(() => Boolean(plan.value && plan.value.write === 0 && plan.value.rename > 0));

/** sw.clampOther counts every key with a clamped field other than its actuation field (even if also in sw.clampAct). */
const clampLines = computed(() => {
  if (!plan.value) return { act: 0, other: 0 };
  const act = new Set<number>();
  const other = new Set<number>();
  for (const c of plan.value.clamped) {
    const v = perf.values[c.id];
    const rt = v ? isRtMode(v.mode) : false;
    if (c.field === (rt ? 'rtFirstTouch' : 'normalPress')) act.add(c.id);
    // In Standard mode the firmware ties normalRelease to normalPress: only count it as actuation when tied.
    else if (!rt && c.field === 'normalRelease' && v && Math.abs(v.normalRelease - v.normalPress) < 0.0005) act.add(c.id);
    else other.add(c.id);
  }
  return { act: act.size, other: other.size };
});
const limit = computed(() => (plan.value ? formatMm(plan.value.limitMm, 3) : ''));

const fromGroup = computed<KeyGroup | null>(() => keyGroups.value[0] ?? null);
const fromSwatch = computed(() => swatchForKeySwitch(fromGroup.value?.identity, perf.customSwitches));
const fromName = computed(() => {
  const g = fromGroup.value;
  if (!g) return t('sw.unknown');
  switch (g.identity.kind) {
    case 'catalog': return switchName(g.identity.entry);
    case 'custom': return g.identity.custom.uid === GENERIC_UID ? t('csw.generic') : g.identity.custom.name;
    case 'unnamed': return t('csw.unnamed');
    case 'lost': return t('csw.lost');
    case 'unknown': return t('sw.unknown');
  }
});

const customSummaryLines = computed<string[]>(() => {
  const pair = chosenEffectivePair.value;
  if (!chosen.value || chosen.value.kind !== 'custom' || !pair) return [];
  const v = { um: pair.rangeUm, coef: pair.coefficient };
  if (chosenIsGeneric.value) {
    return [t('csw.sumGeneric', { ...v, mm: mm(pair.rangeUm) }), t('csw.genericNote')];
  }
  const twin = entries.value.find((e) => e.rangeMax === pair.rangeUm && e.coefficient === pair.coefficient);
  if (twin) return [t('csw.sumSame', { ...v, name: switchName(twin) })];
  if (chosenReady.value) {
    return [t('csw.sumLike', { ...v, name: catalogNameOrFallback(chosenReady.value.curveFrom.id, chosenReady.value.curveFrom.name) })];
  }
  if (chosenUser.value) {
    if (chosenUser.value.curve.kind === 'like') {
      return [t('csw.sumLike', { ...v, name: catalogNameOrFallback(chosenUser.value.curve.id, chosenUser.value.curve.name) })];
    }
    return [t(chosenUser.value.curve.kind === 'travel' ? 'csw.sumTravel' : 'csw.sumManual', v)];
  }
  return [t('csw.sumManual', v)];
});

function readyNoteText(r: ReadySwitch, n: ReadyNote): string {
  switch (n) {
    case 'multiMagnet': return t('csw.nMulti');
    case 'polarityUnknown': return t('csw.nPolarity');
    case 'lowConfidence': return t('csw.nLow');
    case 'samePart': return t('csw.nSamePart', { name: catalogNameOrFallback(r.curveFrom.id, r.curveFrom.name) });
    case 'rangeClamped': return t('csw.nClamped', { mm: mm(r.travelUm), max: mm(rb.value.max) });
    case 'travelConflict': {
      const list = [r.travelUm, ...(r.travelAlt ?? [])].map((u) => String(+(u / 1000).toFixed(3))).join(' / ');
      return t('csw.nConflict', { list, mm: mm(r.travelUm) });
    }
  }
}

const fallbackName = computed(() => {
  const id = plan.value?.fallbackId;
  if (id == null) return '';
  const e = findSwitch(perf.catalog, id);
  return e ? switchName(e) : String(id);
});

const applyLabel = computed(() => {
  if (!plan.value || !hasAction.value) return t('sw.applyBare');
  if (isRenameOnly.value) return t('csw.renameApply', { n: plan.value.rename });
  return t('sw.apply', { n: plan.value.write });
});

// ---- Apply & swap question (§7.5, §7.6, §7.8)
function finishApplyResult(res: ApplySwitchResult, alreadyUncal: boolean) {
  if (res.status === 'renamed') {
    open.value = false;
    useToast().show(t('csw.renamed', { n: res.renamed, name: res.name }), 'success');
    emit('applied');
    return;
  }
  if (res.status === 'applied') {
    open.value = false;
    const msg = res.marked
      ? t('sw.appliedMarked', { n: res.written, name: res.name })
      : res.idNew > 0 || alreadyUncal
        ? t('sw.appliedUncal', { n: res.written, name: res.name })
        : t('sw.applied', { n: res.written, name: res.name });
    useToast().show(msg, 'success');
    emit('applied');
  }
}

async function onApplyClick() {
  const choice = chosen.value;
  const p = plan.value;
  if (!choice || !p || !hasAction.value || !device.boardAllowed) return;
  const alreadyUncal = p.keys.some((id) => perf.uncalibrated.includes(id));
  const res = perf.applySwitch(choice, props.ids);
  if (res.status === 'question') {
    asking.value = true;
    await nextTick();
    (askYesBtnRef.value?.$el as HTMLElement | undefined)?.focus();
    return;
  }
  finishApplyResult(res, alreadyUncal);
}

function answerAsk(answer: 'replaced' | 'notReplaced') {
  const choice = chosen.value;
  const p = plan.value;
  if (!choice || !p || !device.boardAllowed) return;
  const alreadyUncal = p.keys.some((id) => perf.uncalibrated.includes(id));
  const res = perf.applySwitch(choice, props.ids, answer);
  asking.value = false;
  finishApplyResult(res, alreadyUncal);
}

async function cancelAsk() {
  asking.value = false;
  await nextTick();
  (applyBtnRef.value?.$el as HTMLElement | undefined)?.focus();
}

// ---- Sub-views: Form & Switch Pack Import (§5.7, §6)
function captureBodyHeight() {
  const h = swpRef.value?.getBoundingClientRect().height ?? 0;
  bodyHeightPx.value = h > 0 ? Math.round(h) : null;
}

function assignedCount(targetUid: string | undefined): number {
  if (!targetUid) return 0;
  return Object.values(perf.assignments).filter((u) => u === targetUid).length;
}

const formInUseCount = computed(() => {
  if (!formState.value) return 0;
  if (formState.value.mode === 'generic') return assignedCount(GENERIC_UID);
  if (formState.value.mode === 'edit') return assignedCount(formState.value.entry?.uid);
  return 0;
});

function openNewForm() {
  if (atMax.value) return;
  asking.value = false;
  captureBodyHeight();
  returnFocusKind = 'create';
  formDeleting.value = false;
  formState.value = { mode: 'new' };
  view.value = 'form';
}

function openEditForm(u: CustomSwitch) {
  asking.value = false;
  captureBodyHeight();
  returnFocusKind = 'entry';
  formDeleting.value = false;
  formState.value = { mode: 'edit', entry: u };
  view.value = 'form';
}

function openCopyForm(r: ReadySwitch) {
  asking.value = false;
  captureBodyHeight();
  returnFocusKind = 'entry';
  formDeleting.value = false;
  formState.value = { mode: 'copy', copyFrom: r };
  view.value = 'form';
}

function openGenericForm() {
  asking.value = false;
  captureBodyHeight();
  returnFocusKind = 'entry';
  formDeleting.value = false;
  formState.value = { mode: 'generic' };
  view.value = 'form';
}

async function closeForm() {
  view.value = 'pick';
  formState.value = null;
  formDeleting.value = false;
  await nextTick();
  if (returnFocusKind === 'create') (createBtnRef.value?.$el as HTMLElement | undefined)?.focus();
  else if (returnFocusKind === 'entry') {
    const act = entryActBtnRef.value?.$el as HTMLElement | undefined;
    if (act) act.focus();
    else customRadiosRef.value?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }
}

async function onSaveCustom(saved: CustomSwitch) {
  if (!perf.saveCustomSwitch(saved)) return;
  useToast().show(t('csw.saved', { name: saved.name }), 'success');
  view.value = 'pick';
  formState.value = null;
  formDeleting.value = false;
  tab.value = CUSTOM_TAB;
  chosen.value = { kind: 'custom', custom: userToCustomLike(saved) };
  await nextTick();
  const tile = customRadiosRef.value?.querySelector<HTMLElement>(`[data-uid="${saved.uid}"]`);
  tile?.focus();
}

async function onSaveGeneric(rangeUm: number) {
  perf.setGenericRange(rangeUm);
  useToast().show(t('csw.genericSaved', { mm: mm(perf.genericEntry.rangeUm) }), 'success');
  view.value = 'pick';
  formState.value = null;
  formDeleting.value = false;
  tab.value = CUSTOM_TAB;
  chosen.value = { kind: 'custom', custom: perf.genericEntry };
  await nextTick();
  customRadiosRef.value?.querySelector<HTMLElement>(`[data-uid="${GENERIC_UID}"]`)?.focus();
}

async function onDeleteCustom(targetUid: string) {
  const name = formState.value?.entry?.name ?? '';
  perf.deleteCustomSwitch(targetUid);
  useToast().show(t('csw.deleted', { name }), 'success');
  view.value = 'pick';
  formState.value = null;
  formDeleting.value = false;
  chosen.value = null;
  await nextTick();
  customRadiosRef.value?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
}

async function onDeleteStateChange(isDel: boolean) {
  formDeleting.value = isDel;
  await nextTick();
  if (isDel) (delCancelBtnRef.value?.$el as HTMLElement | undefined)?.focus();
  else (delBtnRef.value?.$el as HTMLElement | undefined)?.focus();
}

// ---- Switch pack import (§6.7)
async function onPackImported(payload: { fileName: string; result: ParsedPack }) {
  asking.value = false;
  captureBodyHeight();
  returnFocusKind = 'pack';
  packOpen.value = false;
  importState.value = payload;
  view.value = 'import';
  await nextTick();
  if (payload.result.ok) (importAddBtnRef.value?.$el as HTMLElement | undefined)?.focus();
  else (importBackBtnRef.value?.$el as HTMLElement | undefined)?.focus();
}

const importAddCount = computed(() => importRef.value?.addEntries.length ?? 0);

async function closeImport() {
  view.value = 'pick';
  importState.value = null;
  await nextTick();
  (packBtnRef.value?.$el as HTMLElement | undefined)?.focus();
}

async function confirmImport() {
  const list = importRef.value?.addEntries ?? [];
  if (!list.length) return;
  const toAdd: CustomSwitch[] = list.map((e) => ({
    uid: newCustomUid(),
    name: e.name,
    maker: e.maker,
    travelUm: e.travelUm,
    rangeUm: e.rangeUm,
    coefficient: e.coefficient,
    curve: e.curve,
    color: e.color,
    note: e.note,
  }));
  const added = perf.addCustomSwitches(toAdd);
  useToast().show(t('csw.pkAdded', { n: added }), 'success');
  view.value = 'pick';
  importState.value = null;
  packOpen.value = false;
  tab.value = CUSTOM_TAB;
  chosen.value = null;
  query.value = '';
  await nextTick();
  if (customScrollRef.value && mineHeadingRef.value) {
    customScrollRef.value.scrollTop = Math.max(0, mineHeadingRef.value.offsetTop - customScrollRef.value.offsetTop - 4);
  }
  customRadiosRef.value?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
}

// ---- Esc interception inside sub-views and swap question (stops Dialog from closing, §6.6, §6.7, §7.5)
function onInnerEscape(e: KeyboardEvent) {
  if (e.defaultPrevented) return;
  if (view.value === 'form') {
    e.stopPropagation();
    if (formDeleting.value) formRef.value?.cancelDelete();
    else void closeForm();
    return;
  }
  if (view.value === 'import') {
    e.stopPropagation();
    void closeImport();
    return;
  }
  if (asking.value) {
    e.stopPropagation();
    void cancelAsk();
  }
}

const subViewStyle = computed(() => (bodyHeightPx.value ? { height: `${bodyHeightPx.value}px` } : undefined));
</script>

<template>
  <Dialog v-model:open="open" :title="dialogTitle" :width="800">
    <!-- Form view (§5.7, §6) -->
    <div v-if="view === 'form' && formState" class="swp swp--sub" :style="subViewStyle" @keydown.escape="onInnerEscape">
      <CustomSwitchForm
        ref="formRef"
        :mode="formState.mode"
        :entry="formState.entry"
        :copy-from="formState.copyFrom"
        :catalog="entries"
        :existing="perf.customSwitches"
        :in-use-count="formInUseCount"
        :generic-range-um="perf.genericEntry.rangeUm"
        @save-custom="onSaveCustom"
        @save-generic="onSaveGeneric"
        @delete="onDeleteCustom"
        @delete-state-change="onDeleteStateChange"
      />
    </div>

    <!-- Switch pack import view (§6.7) -->
    <div v-else-if="view === 'import' && importState" class="swp swp--sub" :style="subViewStyle" @keydown.escape="onInnerEscape">
      <SwitchPackImport ref="importRef" :file-name="importState.fileName" :parsed="importState.result" />
    </div>

    <!-- Main picker view -->
    <div v-else ref="swpRef" class="swp" @keydown.escape="onInnerEscape">
      <p class="swp__for"><b>{{ t('sw.forKeys', { n: ids.length }) }}</b> · {{ t('sw.forBoard') }}</p>
      <Tabs v-model="tab" :items="tabs" :label="t('sw.groups')" />

      <!-- Maker tabs list -->
      <div v-if="tab !== CUSTOM_TAB" ref="listRef" class="swp__list" role="radiogroup" :aria-label="tabLabel(tab)">
        <button
          v-for="e in shownCatalog"
          :key="e.id"
          type="button"
          role="radio"
          class="sw-opt"
          :aria-checked="chosen?.kind === 'catalog' && chosen.entry.id === e.id"
          :tabindex="e.id === rovingCatalogId ? 0 : -1"
          @click="selectCatalog(e)"
          @keydown="onCatalogKey"
        >
          <SwitchSwatch :color="e.color" :id="e.id" />
          <span class="sw-opt__text">
            <span v-if="brandOf(e)" class="sw-opt__brand">{{ brandOf(e) }}</span>
            <span class="sw-opt__name" :title="switchName(e)">{{ switchName(e) }}</span>
            <span class="sw-opt__meta">
              <span class="sw-opt__mm">{{ mm(e.rangeMax) }}<small>mm</small></span>
              <span v-if="inUse.get(`catalog:${e.id}`)" class="sw-opt__tag">
                {{ single ? t('sw.inUse') : t('sw.keys', { n: inUse.get(`catalog:${e.id}`)! }) }}
              </span>
            </span>
          </span>
        </button>
      </div>

      <!-- Custom tab (§4.4, §5) -->
      <div v-else class="csw-box">
        <div class="csw-head">
          <label class="csw-search">
            <IconSearch :size="15" aria-hidden="true" />
            <input
              v-model="query"
              type="search"
              class="csw-search__in"
              :placeholder="t('csw.search')"
              :aria-label="t('csw.search')"
              autocomplete="off"
              spellcheck="false"
              @keydown.escape="onSearchEsc"
            >
          </label>
          <button
            type="button"
            class="csw-why"
            :aria-expanded="whyOpen"
            :aria-controls="whyId"
            @click="toggleWhy"
          >{{ t('csw.why') }}<IconChevronRight :size="14" aria-hidden="true" /></button>
          <div class="csw-head__btns">
            <Button
              ref="createBtnRef"
              variant="secondary"
              size="sm"
              :icon="IconPlus"
              :disabled="atMax"
              :title="atMax ? t('csw.full') : undefined"
              @click="openNewForm"
            >{{ t('csw.create') }}</Button>
            <Button
              :id="packBtnId"
              ref="packBtnRef"
              variant="secondary"
              size="sm"
              :icon="IconFileImport"
              :aria-expanded="packOpen"
              :aria-controls="packPanelId"
              @click="togglePack"
            >{{ t('csw.pack') }}</Button>
          </div>
        </div>

        <div ref="customScrollRef" class="csw-scroll">
          <!-- Disclosures & cap note live at the top of the scroll area, outside the radiogroup (§4.4, §5.5, §6.7) -->
          <p v-if="atMax" class="swp__info csw-full-note">
            <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.full') }}
          </p>
          <div v-if="whyOpen" :id="whyId" class="csw-whybody">
            <p>{{ t('csw.explain') }}</p>
            <p>{{ t('csw.whyWrite') }}</p>
            <p>{{ t('csw.whyEst') }}</p>
            <p>{{ t('csw.whyCheck') }}</p>
          </div>
          <SwitchPackPanel
            v-if="packOpen"
            :id="packPanelId"
            :labelled-by="packBtnId"
            :custom-switches="perf.customSwitches"
            @imported="onPackImported"
          />

          <div ref="customRadiosRef" class="csw-radios" role="radiogroup" :aria-label="t('csw.tab')">
            <p v-if="noSearchMatch" class="csw-nomatch">
              <IconSearch :size="15" aria-hidden="true" />{{ t('csw.noMatch', { q: query.trim() }) }}
            </p>

            <!-- Ready-made section -->
            <template v-if="readyFiltered.length">
              <h3 class="csw-sec">{{ t('csw.ready') }}</h3>
              <div class="csw-grid">
                <button
                  v-for="r in readyFiltered"
                  :key="r.uid"
                  type="button"
                  role="radio"
                  class="sw-opt"
                  :data-uid="r.uid"
                  :aria-checked="chosen?.kind === 'custom' && chosen.custom.uid === r.uid"
                  :aria-label="readyAria(r)"
                  :tabindex="r.uid === rovingCustomUid ? 0 : -1"
                  @click="selectCustom(readyToCustomLike(r))"
                  @keydown="onCustomKey"
                >
                  <SwitchSwatch color="" custom />
                  <span class="sw-opt__text">
                    <span class="sw-opt__brand">{{ r.maker }}</span>
                    <span class="sw-opt__name" :title="r.name">{{ r.name }}</span>
                    <span class="sw-opt__meta">
                      <span class="sw-opt__mm">{{ mm(r.travelUm) }}<small>mm</small></span>
                      <span v-if="inUse.get(`custom:${r.uid}`)" class="sw-opt__tag">
                        {{ single ? t('sw.inUse') : t('sw.keys', { n: inUse.get(`custom:${r.uid}`)! }) }}
                      </span>
                    </span>
                    <span class="csw-borrow" :title="readySecondLine(r)">{{ readySecondLine(r) }}</span>
                  </span>
                </button>
              </div>
            </template>

            <!-- User entries section -->
            <template v-if="!foldedQuery || mineFiltered.length">
              <h3 ref="mineHeadingRef" class="csw-sec">{{ t('csw.mine') }}</h3>
              <div v-if="mineFiltered.length" class="csw-grid">
                <button
                  v-for="u in mineFiltered"
                  :key="u.uid"
                  type="button"
                  role="radio"
                  class="sw-opt"
                  :data-uid="u.uid"
                  :aria-checked="chosen?.kind === 'custom' && chosen.custom.uid === u.uid"
                  :aria-label="userAria(u)"
                  :tabindex="u.uid === rovingCustomUid ? 0 : -1"
                  @click="selectCustom(userToCustomLike(u))"
                  @keydown="onCustomKey"
                >
                  <SwitchSwatch :color="u.color" custom />
                  <span class="sw-opt__text">
                    <span v-if="u.maker" class="sw-opt__brand">{{ u.maker }}</span>
                    <span class="sw-opt__name" :title="u.name">{{ u.name }}</span>
                    <span class="sw-opt__meta">
                      <span class="sw-opt__mm">{{ mm(u.travelUm) }}<small>mm</small></span>
                      <span v-if="inUse.get(`custom:${u.uid}`)" class="sw-opt__tag">
                        {{ single ? t('sw.inUse') : t('sw.keys', { n: inUse.get(`custom:${u.uid}`)! }) }}
                      </span>
                    </span>
                    <span class="csw-borrow" :title="userSecondLine(u)">{{ userSecondLine(u) }}</span>
                  </span>
                </button>
              </div>
              <p v-else class="csw-empty">{{ t('csw.mineEmpty') }}</p>
            </template>

            <!-- Generic switch section (always shown, §5.7) -->
            <h3 class="csw-sec">{{ t('csw.genericSec') }}</h3>
            <p class="csw-intro">{{ t('csw.genericIntro') }}</p>
            <div class="csw-grid">
              <button
                type="button"
                role="radio"
                class="sw-opt"
                :data-uid="GENERIC_UID"
                :aria-checked="chosen?.kind === 'custom' && chosen.custom.uid === GENERIC_UID"
                :aria-label="genericAria"
                :tabindex="rovingCustomUid === GENERIC_UID ? 0 : -1"
                @click="selectCustom(perf.genericEntry)"
                @keydown="onCustomKey"
              >
                <SwitchSwatch color="" custom />
                <span class="sw-opt__text">
                  <span class="sw-opt__brand">{{ t('csw.genericEyebrow') }}</span>
                  <span class="sw-opt__name" :title="t('csw.generic')">{{ t('csw.generic') }}</span>
                  <span class="sw-opt__meta">
                    <span class="sw-opt__mm">{{ mm(perf.genericEntry.rangeUm) }}<small>mm</small></span>
                    <span v-if="inUse.get(`custom:${GENERIC_UID}`)" class="sw-opt__tag">
                      {{ single ? t('sw.inUse') : t('sw.keys', { n: inUse.get(`custom:${GENERIC_UID}`)! }) }}
                    </span>
                  </span>
                  <span class="csw-borrow" :title="genericSecondLine">{{ genericSecondLine }}</span>
                </span>
              </button>
            </div>

            <!-- Not-usable section (§5.1, §5.3) -->
            <template v-if="badFiltered.length">
              <h3 class="csw-sec">{{ t('csw.bad') }}</h3>
              <p class="csw-intro">{{ t('csw.badIntro') }}</p>
              <div class="csw-grid">
                <button
                  v-for="b in badFiltered"
                  :key="b.uid"
                  type="button"
                  role="radio"
                  class="sw-opt"
                  aria-checked="false"
                  aria-disabled="true"
                  tabindex="-1"
                  :aria-label="[b.name, b.maker, t('csw.badMeta'), t('csw.badName')].filter(Boolean).join(', ')"
                >
                  <SwitchSwatch color="" custom />
                  <span class="sw-opt__text">
                    <span class="sw-opt__brand">{{ b.maker }}</span>
                    <span class="sw-opt__name" :title="b.name">{{ b.name }}</span>
                    <span class="csw-borrow" :title="t('csw.badMeta')">{{ t('csw.badMeta') }}</span>
                  </span>
                </button>
              </div>
            </template>
          </div>
        </div>
      </div>

      <!-- Summary (§7.4, §7.5, §7.6, §7.7) -->
      <div class="swp__sum" :class="{ 'swp__sum--custom': tab === CUSTOM_TAB }" aria-live="polite">
        <p v-if="!chosen" class="swp__idle">{{ tab === CUSTOM_TAB ? t('csw.idle') : t('sw.idle') }}</p>

        <template v-else-if="!hasAction">
          <div v-if="chosen.kind === 'custom'" class="csw-changeline">
            <p class="swp__idle">{{ t('sw.same') }}</p>
            <div class="csw-acts">
              <Button v-if="chosenReady" ref="entryActBtnRef" variant="ghost" size="sm" :icon="IconCopy" @click="openCopyForm(chosenReady)">{{ t('csw.copy') }}</Button>
              <Button v-else-if="chosenUser" ref="entryActBtnRef" variant="ghost" size="sm" :icon="IconPencil" @click="openEditForm(chosenUser)">{{ t('csw.edit') }}</Button>
              <Button v-else-if="chosenIsGeneric" ref="entryActBtnRef" variant="ghost" size="sm" :icon="IconPencil" @click="openGenericForm">{{ t('csw.genericEdit') }}</Button>
            </div>
          </div>
          <p v-else class="swp__idle">{{ t('sw.same') }}</p>
        </template>

        <template v-else-if="plan">
          <!-- Change row (+ entry actions for custom choices when not asking) -->
          <div :class="chosen.kind === 'custom' ? 'csw-changeline' : undefined">
            <div class="swp__change">
              <template v-if="single && fromGroup">
                <SwitchSwatch v-bind="fromSwatch" size="sm" />
                <span class="nm">{{ fromName }}</span>
                <span v-if="fromGroup.identity.kind !== 'lost'" class="mm">{{ mm(fromGroup.rangeMax) }} mm</span>
              </template>
              <span v-else class="nm">{{ t('sw.kinds', { n: keyGroups.length }) }}</span>
              <IconArrowRight class="arrow" :size="16" aria-hidden="true" />
              <template v-if="chosen.kind === 'catalog'">
                <SwitchSwatch :color="chosen.entry.color" :id="chosen.entry.id" size="sm" />
                <span class="nm">{{ chosenDisplayName }}</span>
                <span class="mm">{{ mm(chosen.entry.rangeMax) }} mm</span>
              </template>
              <template v-else-if="chosenEffectivePair">
                <SwitchSwatch :color="chosenColor" custom size="sm" />
                <span class="nm">{{ chosenDisplayName }}</span>
                <span class="mm">{{ mm(chosenEffectivePair.rangeUm) }} mm</span>
              </template>
            </div>
            <div v-if="chosen.kind === 'custom' && !asking" class="csw-acts">
              <Button v-if="chosenReady" ref="entryActBtnRef" variant="ghost" size="sm" :icon="IconCopy" @click="openCopyForm(chosenReady)">{{ t('csw.copy') }}</Button>
              <Button v-else-if="chosenUser" ref="entryActBtnRef" variant="ghost" size="sm" :icon="IconPencil" @click="openEditForm(chosenUser)">{{ t('csw.edit') }}</Button>
              <Button v-else-if="chosenIsGeneric" ref="entryActBtnRef" variant="ghost" size="sm" :icon="IconPencil" @click="openGenericForm">{{ t('csw.genericEdit') }}</Button>
            </div>
          </div>

          <!-- Swap question in the summary's place (§7.5) -->
          <div v-if="asking" class="csw-ask" role="group" :aria-labelledby="askTitleId" :aria-describedby="askBodyId">
            <IconAlertTriangle :size="16" aria-hidden="true" />
            <div class="csw-ask__text">
              <b :id="askTitleId">{{ t('sw.askTitle', { n: plan.write }) }}</b>
              <span :id="askBodyId">{{ t('sw.askBody') }}</span>
            </div>
          </div>

          <!-- Rename-only (§7.6) -->
          <p v-else-if="isRenameOnly" class="swp__info">
            <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.renameOnly') }}
          </p>

          <!-- Custom choice summary lines 2–6 (§7.4) -->
          <template v-else-if="chosen.kind === 'custom'">
            <p v-for="(line, i) in customSummaryLines" :key="i" class="swp__info">
              <IconInfoCircle :size="15" aria-hidden="true" />{{ line }}
            </p>
            <template v-if="chosenReady">
              <p
                v-for="n in chosenReady.notes"
                :key="n"
                :class="NOTE_WARN.has(n) ? 'swp__warn' : 'swp__info'"
              >
                <IconAlertTriangle v-if="NOTE_WARN.has(n)" :size="15" aria-hidden="true" />
                <IconInfoCircle v-else :size="15" aria-hidden="true" />
                {{ readyNoteText(chosenReady, n) }}
              </p>
            </template>
            <p v-if="chosenUser?.note" class="swp__info csw-noteline" :title="chosenUser.note">
              <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.noteLine', { note: chosenUser.note }) }}
            </p>
            <p v-if="plan.rename > 0" class="swp__info">
              <IconInfoCircle :size="15" aria-hidden="true" />{{ t('csw.renameAlso', { n: plan.rename }) }}
            </p>
            <p v-if="clampLines.act" class="swp__warn">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clampAct', { n: clampLines.act, max: limit }) }}
            </p>
            <p v-if="clampLines.other" class="swp__warn">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clampOther', { n: clampLines.other, max: limit }) }}
            </p>
            <p v-if="plan.idNew > 0" class="swp__warn">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('csw.idNew', { n: plan.idNew, name: fallbackName }) }}
            </p>
            <p v-if="plan.deeper" class="swp__info">
              <IconInfoCircle :size="15" aria-hidden="true" />{{ t('sw.otherProfiles', { max: limit }) }}
            </p>
          </template>

          <!-- Listed choice summary (§7.4, §8) -->
          <template v-else>
            <p v-if="clampLines.act" class="swp__warn">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clampAct', { n: clampLines.act, max: limit }) }}
            </p>
            <p v-if="clampLines.other" class="swp__warn">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clampOther', { n: clampLines.other, max: limit }) }}
            </p>
            <p v-if="plan.idNew > 0" class="swp__warn">
              <IconAlertTriangle :size="15" aria-hidden="true" />{{ t('sw.clearsCal', { n: plan.idNew }) }}
            </p>
            <p v-if="plan.deeper" class="swp__info">
              <IconInfoCircle :size="15" aria-hidden="true" />{{ t('sw.otherProfiles', { max: limit }) }}
            </p>
          </template>
        </template>
      </div>
    </div>

    <template #footer>
      <div class="swp__foot-wrap" @keydown.escape="onInnerEscape">
        <!-- Form view footer -->
        <template v-if="view === 'form' && formState">
          <template v-if="formDeleting">
            <Button ref="delCancelBtnRef" variant="secondary" @click="formRef?.cancelDelete()">{{ t('csw.cancel') }}</Button>
            <Button variant="danger" @click="formRef?.confirmDelete()">{{ t('csw.delete') }}</Button>
          </template>
          <template v-else>
            <Button
              v-if="formState.mode === 'edit'"
              ref="delBtnRef"
              variant="ghost"
              :icon="IconTrash"
              class="csw-foot-left csw-danger-ghost"
              @click="formRef?.requestDelete()"
            >{{ t('csw.delete') }}</Button>
            <Button
              v-else-if="formState.mode === 'generic' && formRef?.genericCanReset"
              variant="ghost"
              :icon="IconRefresh"
              class="csw-foot-left"
              @click="formRef?.resetGeneric()"
            >{{ t('csw.genericReset', { mm: mm(GENERIC_START) }) }}</Button>
            <Button variant="secondary" @click="closeForm">{{ t('csw.cancel') }}</Button>
            <Button variant="primary" @click="formRef?.submit()">{{ t('csw.save') }}</Button>
          </template>
        </template>

        <!-- Pack import view footer -->
        <template v-else-if="view === 'import' && importState">
          <template v-if="!importState.result.ok">
            <Button ref="importBackBtnRef" variant="secondary" @click="closeImport">{{ t('csw.pkBack') }}</Button>
          </template>
          <template v-else>
            <Button variant="secondary" @click="closeImport">{{ t('csw.cancel') }}</Button>
            <Button ref="importAddBtnRef" variant="primary" :disabled="!importAddCount" @click="confirmImport">
              {{ t('csw.pkAddN', { n: importAddCount }) }}
            </Button>
          </template>
        </template>

        <!-- Swap question footer (§7.5) -->
        <template v-else-if="asking">
          <Button variant="ghost" @click="cancelAsk">{{ t('sw.askBack') }}</Button>
          <Button variant="secondary" @click="answerAsk('notReplaced')">{{ t('sw.askNo') }}</Button>
          <Button ref="askYesBtnRef" variant="primary" @click="answerAsk('replaced')">{{ t('sw.askYes') }}</Button>
        </template>

        <!-- Default picker footer -->
        <template v-else>
          <Button variant="secondary" @click="open = false">{{ t('sw.cancel') }}</Button>
          <Button ref="applyBtnRef" variant="primary" :disabled="!hasAction" @click="onApplyClick">{{ applyLabel }}</Button>
        </template>
      </div>
    </template>
  </Dialog>
</template>

<style scoped>
.swp { display: flex; flex-direction: column; gap: var(--s-3); min-height: 0; }
.swp--sub > * { flex: 1 1 0; min-height: 0; }
.swp__foot-wrap { display: contents; }
.swp__for { margin: 0; font-size: var(--fs-label); color: var(--fg-3); }
.swp__for b { color: var(--fg-1); font-weight: 600; }
.swp__list {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--s-2); align-content: start;
  grid-auto-rows: max-content; /* with a fixed height, auto rows would shrink below their content */
  flex: none; height: clamp(160px, calc(100vh - 460px), 372px); overflow-y: auto;
  padding: 2px; margin: -2px; /* room for the focus ring */
  scrollbar-gutter: stable;
}

/* Custom tab box & scroll area: exact §7.7 heights so box + summary stay constant across tabs */
.csw-box {
  display: flex; flex-direction: column; flex: none;
  height: calc(clamp(160px, 100vh - 460px, 372px) + 112px - 221px);
  min-height: min-content;
}
.csw-head {
  display: flex; align-items: center; flex-wrap: wrap; gap: var(--s-2) var(--s-4);
  padding: 2px 2px var(--s-3); border-bottom: 1px solid var(--line-1);
}
.csw-head__btns { display: flex; flex-wrap: wrap; gap: var(--s-2); margin-left: auto; }
.csw-search {
  box-sizing: border-box; display: flex; align-items: center; gap: 6px; width: 260px; max-width: 100%; height: 34px; padding: 0 10px;
  border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--bg-1); color: var(--fg-3);
}
.csw-search:focus-within { border-color: var(--acc); box-shadow: var(--focus-ring); }
.csw-search > svg { flex: none; }
.csw-search__in {
  flex: 1; min-width: 0; height: 100%; border: 0; padding: 0;
  background: transparent; color: var(--fg-1); font: inherit; font-size: var(--fs-body); outline: none;
}
.csw-search__in::placeholder { color: var(--fg-3); }
.csw-search__in::-webkit-search-cancel-button { filter: grayscale(1); }
.csw-why {
  display: inline-flex; align-items: center; gap: 2px; border: 0; padding: 0; background: none;
  font: inherit; font-size: var(--fs-label); font-weight: 600; color: var(--fg-1);
  cursor: pointer; text-decoration: underline; text-underline-offset: 3px;
}
.csw-why svg { transition: transform var(--t-fast) var(--ease); }
.csw-why[aria-expanded='true'] svg { transform: rotate(90deg); }
.csw-whybody {
  display: flex; flex-direction: column; gap: 6px; margin: 0 0 var(--s-4); padding: 10px 12px;
  border: 1px solid var(--line-1); border-radius: var(--r-control); background: var(--bg-2);
  font-size: var(--fs-label); line-height: 1.45; color: var(--fg-2);
}
.csw-whybody p { margin: 0; }
.csw-full-note { margin-bottom: var(--s-3); }
.csw-scroll {
  flex: 1 1 0; min-height: 150px; overflow-y: auto; scrollbar-gutter: stable;
  padding: var(--s-3) 2px 2px; margin: 0 -2px;
}
.csw-sec {
  margin: 0 0 var(--s-2); font-size: var(--fs-caption); font-weight: 600;
  letter-spacing: 0.04em; text-transform: uppercase; color: var(--fg-3);
}
.csw-grid + .csw-sec, .csw-empty + .csw-sec { margin-top: var(--s-4); }
.csw-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: var(--s-2); }
.csw-empty, .csw-intro { margin: 0 0 var(--s-2); font-size: var(--fs-label); line-height: 1.45; color: var(--fg-2); }
.csw-empty { color: var(--fg-3); }
.csw-nomatch { display: flex; align-items: flex-start; gap: 6px; margin: 0 0 var(--s-4); font-size: var(--fs-label); line-height: 1.45; color: var(--fg-2); }
.csw-nomatch > svg { flex: none; color: var(--fg-3); margin-top: 2px; }

.sw-opt {
  position: relative;
  display: flex; align-items: center; gap: 10px;
  min-height: 52px; padding: 8px 10px;
  border-radius: var(--r-control);
  border: 1px solid var(--line-1);
  background: var(--bg-3);
  color: var(--fg-1); text-align: left;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.sw-opt:hover { background: var(--bg-4); border-color: var(--line-3); }
.sw-opt:focus-visible { outline: 2px solid var(--acc); outline-offset: 1px; }
.sw-opt[aria-checked='true'] { background: var(--sel-bg); border-color: var(--acc); box-shadow: inset 0 0 0 1px var(--acc); }
.sw-opt[aria-checked='true']:focus-visible { box-shadow: var(--focus-ring), inset 0 0 0 1px var(--acc); }
.sw-opt[aria-disabled='true'] { cursor: not-allowed; background: transparent; border-style: dashed; border-color: var(--line-3); }
.sw-opt__text { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
.sw-opt__brand { display: block; font-size: var(--fs-caption); font-weight: 600; line-height: 14px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-opt:hover .sw-opt__brand, .sw-opt[aria-checked='true'] .sw-opt__brand { color: var(--fg-2); }
.sw-opt__name { font-size: var(--fs-body); font-weight: 500; line-height: 1.3; overflow: hidden; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow-wrap: anywhere; }
.sw-opt__mm { flex: none; white-space: nowrap; font-size: var(--fs-label); color: var(--fg-2); font-variant-numeric: tabular-nums; }
.sw-opt__mm small { font-size: var(--fs-caption); margin-left: 1px; }
.sw-opt[aria-checked='true'] .sw-opt__mm { color: var(--fg-1); }
.sw-opt__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 3px 6px; min-width: 0; }
.sw-opt__tag {
  padding: 0 4px; border-radius: 4px; white-space: nowrap;
  font-size: var(--fs-caption); font-weight: 600; line-height: 16px;
  color: var(--fg-2); background: var(--bg-2); border: 1px solid var(--line-2);
}
.sw-opt .csw-borrow { display: block; font-size: var(--fs-caption); line-height: 15px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sw-opt:hover .csw-borrow, .sw-opt[aria-checked='true'] .csw-borrow { color: var(--fg-2); }
.sw-opt[aria-disabled='true'] .csw-borrow { white-space: normal; color: var(--fg-2); }

/* Summary & reserve heights (§7.4, §7.5, §7.7) */
.swp__sum { display: flex; flex-direction: column; gap: var(--s-2); padding-top: var(--s-3); border-top: 1px solid var(--line-1); min-height: 112px; }
.swp__sum--custom { min-height: 221px; }
.swp__change { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; font-size: var(--fs-body); color: var(--fg-1); }
.swp__change .nm { font-weight: 600; }
.swp__change .mm { color: var(--fg-2); font-variant-numeric: tabular-nums; }
.swp__change .arrow { color: var(--fg-3); }
.csw-changeline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px var(--s-3); }
.csw-changeline > .swp__change, .csw-changeline > .swp__idle { flex: 1 1 auto; min-width: 0; }
.csw-acts { display: flex; gap: var(--s-2); margin-left: auto; }
.swp__idle { margin: 0; font-size: var(--fs-body); color: var(--fg-3); }
.swp__warn, .swp__info { display: flex; gap: var(--s-2); align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 1.45; }
.swp__warn { color: var(--fg-1); }
.swp__warn svg { color: var(--warn); flex: none; margin-top: 1px; }
.swp__info { color: var(--fg-2); }
.swp__info svg { color: var(--fg-3); flex: none; margin-top: 1px; }
.swp__info.csw-noteline { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.csw-noteline > svg { vertical-align: -3px; margin-right: 8px; }

.csw-ask {
  display: flex; align-items: flex-start; gap: var(--s-3); padding: var(--s-3);
  border-radius: var(--r-control);
  border: 1px solid color-mix(in srgb, var(--warn) 40%, transparent);
  background: color-mix(in srgb, var(--warn) var(--soft-pct), var(--bg-2));
}
.csw-ask > svg { flex: none; color: var(--warn); margin-top: 2px; }
.csw-ask__text { display: flex; flex-direction: column; gap: 2px; min-width: 0; font-size: var(--fs-label); line-height: 1.45; color: var(--fg-1); }
.csw-ask__text b { font-size: var(--fs-body); font-weight: 600; }

.csw-foot-left { margin-right: auto; }
.csw-danger-ghost { color: var(--danger); }
</style>
