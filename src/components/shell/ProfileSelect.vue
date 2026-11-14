<script setup lang="ts">
// Onboard profiles as a dropdown: the trigger shows the active one, the popover lists all; click switches (re-reads the profile),
// pencil/double-click renames inline.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { IconChevronDown, IconPencil } from '@tabler/icons-vue';
import { useCalibrationStore } from '../../stores/calibration';
import { useDeviceStore } from '../../stores/device';
import { PROFILE_NAME_MAX_BYTES, truncateUtf8 } from '../../stores/settings';
import { useToast } from '../ui/toast';
import { t } from '../../i18n/vi';

const props = defineProps<{ compact?: boolean }>();

const listId = `ps-list-${Math.random().toString(36).slice(2, 9)}`;

const device = useDeviceStore();
const calibration = useCalibrationStore();
const toast = useToast();
const route = useRoute();
const calibrating = computed(() => calibration.phase !== 'idle' || device.calibrationLocked());
const active = computed(() => device.activeProfile);
const activeName = computed(() => device.profileNames[device.activeProfile] ?? '');
const editing = ref<number | null>(null);
const draft = ref('');
const busy = ref<number | null>(null);
const input = ref<HTMLInputElement[]>([]);
const trigger = ref<HTMLButtonElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const open = ref(false);
const focusIdx = ref(0);
const popStyle = ref<Record<string, string>>({});

function asideOf(): HTMLElement | null {
  return trigger.value?.closest('aside') ?? null;
}

function updatePos() {
  const el = trigger.value;
  if (!el) return;
  const r = el.getBoundingClientRect();
  if (props.compact) {
    const side = asideOf()?.getBoundingClientRect().right ?? r.right;
    popStyle.value = { left: `${side + 6}px`, top: `${r.top - 4}px`, width: '208px' };
  } else {
    popStyle.value = { left: `${r.left}px`, top: `${r.bottom + 4}px`, width: `${r.width}px` };
  }
}

function focusRow(i: number) {
  const rows = pop.value?.querySelectorAll<HTMLElement>('[role="option"]');
  if (!rows?.length) return;
  focusIdx.value = Math.max(0, Math.min(rows.length - 1, i));
  rows[focusIdx.value].focus();
}

async function openPop(focus: boolean) {
  focusIdx.value = device.activeProfile;
  open.value = true;
  updatePos();
  if (focus) {
    await nextTick();
    focusRow(focusIdx.value);
  }
}

function close(refocus = false) {
  if (!open.value) return;
  clearTimeout(closeTimer);
  // Closing mid-rename keeps the typed name: the input unmounts with the popover and may never fire blur.
  if (editing.value !== null) void finishRename(true);
  open.value = false;
  if (refocus) trigger.value?.focus();
}

function toggle() {
  if (open.value) close();
  else void openPop(false);
}

function onTriggerKey(e: KeyboardEvent) {
  if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    void openPop(true);
  } else if (e.key === 'Escape' && open.value) {
    e.preventDefault();
    close(true);
  } else if (e.key === 'Tab') {
    close();
  }
}

function onItemKey(e: KeyboardEvent, i: number) {
  if (e.target !== e.currentTarget) return; // keys typed in the rename input or on the pencil stay there
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); focusRow(i + 1); break;
    case 'ArrowUp': e.preventDefault(); focusRow(i - 1); break;
    case 'Home': e.preventDefault(); focusRow(0); break;
    case 'End': e.preventDefault(); focusRow(device.profileNames.length - 1); break;
    case 'Enter': e.preventDefault(); pick(i, true); break;
    case 'F2': e.preventDefault(); void startRename(i); break;
    case 'Escape': e.preventDefault(); close(true); break;
    case 'Tab': close(); break;
  }
}

function onPointerDown(e: PointerEvent) {
  const n = e.target as Node | null;
  if (n && (trigger.value?.contains(n) || pop.value?.contains(n))) return;
  close();
}

function onFocusOut(e: FocusEvent) {
  const to = e.relatedTarget as Node | null;
  if (!to || trigger.value?.contains(to) || pop.value?.contains(to)) return;
  close();
}

function onScroll() {
  close();
}

let scrollEl: HTMLElement | null = null;
let closeTimer = 0;

function removeListeners() {
  clearTimeout(closeTimer);
  document.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('resize', updatePos);
  scrollEl?.removeEventListener('scroll', onScroll);
  scrollEl = null;
}

watch(open, (on) => {
  if (on) {
    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('resize', updatePos);
    scrollEl = asideOf();
    scrollEl?.addEventListener('scroll', onScroll);
  } else {
    removeListeners();
  }
});
watch(() => route.fullPath, () => close());
onBeforeUnmount(() => {
  removeListeners();
  endSwallow?.(); // the document-wide listeners of a pick go with the component
});

function pick(i: number, now = false) {
  if (i === device.activeProfile && now) {
    close(true); // nothing to switch
    return;
  }
  if (i === device.activeProfile) {
    // Nothing to switch: wait a moment so a double-click can still open the rename on this row.
    clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => { if (editing.value === null) close(true); }, 250);
    return;
  }
  close(true);
  if (!now) swallowClicks();
  void choose(i);
}

const SWALLOWED = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'] as const;

/** After a mouse pick closes the popover, the rest of a double-click would land on whatever was under it
 *  (a keycap, a nav link). Presses that start within SWALLOW_MS are ignored, together with their release and
 *  click even when those come later; everything stops after SWALLOW_CAP_MS. */
const SWALLOW_MS = 500; // Windows' default double-click time
const SWALLOW_CAP_MS = 1000;
let endSwallow: (() => void) | null = null;
function swallowClicks() {
  endSwallow?.();
  const until = performance.now() + SWALLOW_MS;
  let held = false; // a swallowed press whose release/click has not come yet
  const stop = (e: Event) => {
    const isDown = e.type === 'pointerdown' || e.type === 'mousedown';
    const inWindow = performance.now() < until;
    if (isDown && !inWindow) { held = false; return; } // a new press after the window is real input
    // dblclick stays swallowed until the cap: only profile rows use it, and the popover is closed
    if (!inWindow && !held && e.type !== 'dblclick') return;
    e.preventDefault();
    e.stopPropagation();
    if (isDown) held = true;
    else if (e.type === 'click') held = false;
  };
  for (const type of SWALLOWED) document.addEventListener(type, stop, true);
  const timer = window.setTimeout(() => end(), SWALLOW_CAP_MS);
  const end = () => {
    window.clearTimeout(timer);
    for (const type of SWALLOWED) document.removeEventListener(type, stop, true);
    if (endSwallow === end) endSwallow = null;
  };
  endSwallow = end;
}

function onRowDblclick(i: number) {
  clearTimeout(closeTimer);
  void startRename(i);
}

async function choose(i: number) {
  if (calibrating.value || editing.value !== null || busy.value !== null) return;
  busy.value = i;
  try {
    await device.switchProfile(i);
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  } finally {
    busy.value = null;
  }
}

async function startRename(i: number) {
  // Pencil, double-click and F2 all land here: no rename (a write) while calibrating (DESIGN G §3.9).
  if (calibrating.value) return;
  if (!device.boardAllowed) return;
  editing.value = i;
  draft.value = device.profileNames[i] ?? '';
  await nextTick();
  input.value[0]?.select();
}

/** Enter/Esc in the rename input: the input unmounts, so put focus back on its row while the popover is open. */
async function endRename(i: number, save: boolean) {
  const done = finishRename(save);
  await nextTick();
  if (open.value) focusRow(i);
  await done;
}

/** The name is cut at 32 bytes (UTF-8), never inside a character. While an IME composes, the input is left alone (writing
 *  el.value, or a cut `draft` bound to it, would break the composition) and cut at compositionend; a save meanwhile
 *  sends the cut value. */
function onDraftInput(e: Event) {
  const el = e.target as HTMLInputElement;
  if ((e as InputEvent).isComposing) {
    draft.value = el.value;
    return;
  }
  const v = truncateUtf8(el.value, PROFILE_NAME_MAX_BYTES);
  draft.value = v;
  if (v !== el.value) el.value = v;
}

/** Enter / Esc that only pick or cancel an IME candidate do not save or close the rename. */
function onRenameKey(e: KeyboardEvent, i: number, save: boolean) {
  if (e.isComposing || e.keyCode === 229) return;
  void endRename(i, save);
}

async function finishRename(save: boolean) {
  const i = editing.value;
  editing.value = null;
  if (!save || i === null) return;
  try {
    await device.renameProfile(i, truncateUtf8(draft.value, PROFILE_NAME_MAX_BYTES));
  } catch (err) {
    toast.show(err instanceof Error ? err.message : String(err), 'error');
  }
}
</script>

<template>
  <div class="ps" :class="{ 'ps--compact': compact }" @focusout="onFocusOut">
    <div class="micro ps__label">{{ t('device.profile') }}</div>
    <button
      ref="trigger"
      type="button"
      class="ps__trigger"
      aria-haspopup="listbox"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-label="`${t('device.profile')} ${active + 1} · ${activeName}`"
      :title="compact ? `${t('device.profile')} ${active + 1} · ${activeName}` : undefined"
      :aria-busy="busy !== null || undefined"
      @click="toggle"
      @keydown="onTriggerKey"
    >
      <span class="ps__chip num">{{ active + 1 }}</span>
      <span class="ps__tname">{{ activeName }}</span>
      <IconChevronDown class="ps__chev" :size="14" stroke-width="1.8" aria-hidden="true" />
    </button>
    <div v-if="open" ref="pop" class="ps__pop" :style="popStyle">
      <ul :id="listId" class="ps__list" role="listbox" :aria-label="t('device.profile')">
        <li
          v-for="(name, i) in device.profileNames"
          :key="i"
          class="ps__item"
          :class="{ 'ps__item--on': i === device.activeProfile, 'ps__item--busy': busy === i, 'ps__item--off': calibrating && i !== device.activeProfile }"
          role="option"
          :aria-selected="i === device.activeProfile"
          :aria-disabled="calibrating && i !== device.activeProfile ? true : undefined"
          :title="calibrating && i !== device.activeProfile ? t('device.calibrating') : undefined"
          :tabindex="i === focusIdx ? 0 : -1"
          @click="pick(i)"
          @dblclick="onRowDblclick(i)"
          @focus="focusIdx = i"
          @keydown="onItemKey($event, i)"
        >
          <span class="ps__idx num">{{ i + 1 }}</span>
          <input
            v-if="editing === i"
            ref="input"
            :value="draft"
            class="ps__input"
            :aria-label="t('device.rename')"
            @click.stop
            @input="onDraftInput"
            @compositionend="onDraftInput"
            @keydown.enter.stop="onRenameKey($event, i, true)"
            @keydown.esc.stop="onRenameKey($event, i, false)"
            @blur="finishRename(true)"
          >
          <span v-else class="ps__name">{{ name }}</span>
          <button
            v-if="editing !== i && device.boardAllowed"
            type="button"
            class="ps__edit"
            :aria-label="`${t('device.rename')} ${name}`"
            :title="calibrating ? t('device.calibrating') : t('device.rename')"
            :disabled="calibrating"
            @click.stop="startRename(i)"
          >
            <IconPencil :size="13" stroke-width="1.5" />
          </button>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.ps { position: relative; display: flex; flex-direction: column; gap: var(--s-2); }
.ps__label { padding: 0 4px; }
.ps--compact .ps__label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
.ps__trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  height: 36px;
  padding: 0 8px 0 9px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-2);
  color: var(--fg-1);
  font: inherit;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), border-color var(--t-fast) var(--ease);
}
.ps__trigger:hover { background: var(--bg-3); border-color: var(--line-3); }
.ps__trigger[aria-expanded='true'] { border-color: var(--acc-line); }
.ps__trigger[aria-busy='true'] { opacity: 0.6; }
.ps__chip {
  display: grid;
  place-items: center;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: var(--fs-caption);
  font-weight: 600;
  background: var(--acc);
  color: var(--on-acc);
}
.ps__tname { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps__chev { flex: none; color: var(--fg-3); transition: transform var(--t-fast) var(--ease); }
.ps__trigger[aria-expanded='true'] .ps__chev { transform: rotate(180deg); }
.ps__pop { position: fixed; z-index: 40; padding: 4px; border-radius: 10px; background: var(--bg-2); box-shadow: var(--shadow-pop); }
.ps__pop .ps__item:hover { background: var(--bg-3); }
.ps--compact .ps__trigger { justify-content: center; width: 40px; height: 32px; padding: 0; border-color: transparent; background: transparent; }
.ps--compact .ps__trigger:hover { background: var(--bg-2); }
.ps--compact .ps__trigger[aria-expanded='true'] { background: var(--bg-2); border-color: var(--acc-line); }
.ps--compact .ps__tname, .ps--compact .ps__chev { display: none; }
.ps__list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.ps__item {
  display: flex;
  align-items: center;
  gap: 10px;
  height: 32px;
  padding: 0 6px 0 8px;
  border-radius: var(--r-control);
  color: var(--fg-2);
  cursor: pointer;
  transition: background var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.ps__item:hover { background: var(--bg-3); color: var(--fg-1); }
.ps__item--on { background: var(--sel-bg); color: var(--fg-1); box-shadow: inset 2px 0 0 var(--acc); }
.ps__item--busy { opacity: 0.6; }
.ps__item--off { opacity: 0.45; cursor: not-allowed; }
.ps__item--off:hover { background: transparent; color: var(--fg-2); }
.ps__idx {
  display: grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  font-size: var(--fs-caption);
  font-weight: 600;
  background: var(--bg-4);
  color: var(--fg-2);
}
.ps__item--on .ps__idx { background: var(--acc); color: var(--on-acc); }
.ps__name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ps__input {
  flex: 1;
  min-width: 0;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--acc-line);
  border-radius: 4px;
  background: var(--bg-1);
}
.ps__edit {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--fg-3);
  opacity: 0;
  transition: opacity var(--t-fast) var(--ease), color var(--t-fast) var(--ease);
}
.ps__item:hover .ps__edit, .ps__edit:focus-visible { opacity: 1; }
.ps__edit:hover { color: var(--fg-1); }
/* locked while calibrating: still hidden until the row is hovered, then dimmed */
.ps__edit:disabled { cursor: not-allowed; }
.ps__item:hover .ps__edit:disabled { opacity: 0.45; }
</style>
