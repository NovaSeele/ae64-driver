<script setup lang="ts">
// The wallpaper card (DESIGN J §3.4): choose / change / remove an image, fit, veil (with its floor), blur, panel opacity.
// App preference only: nothing here sends a command to the keyboard or touches sync.
import { computed, nextTick, onMounted, ref } from 'vue';
import { IconAlertCircle, IconBulb, IconInfoCircle, IconPhoto, IconPlayerPause, IconTrash, IconUpload } from '@tabler/icons-vue';
import Card from '../ui/Card.vue';
import Button from '../ui/Button.vue';
import Segmented from '../ui/Segmented.vue';
import Slider from '../ui/Slider.vue';
import { useToast } from '../ui/toast';
import { panelApplied, veilApplied, wallState } from '../../data/wallpaperState';
import { BLUR_MAX, PANEL_MIN, type WallFit } from '../../data/wallpaperPrefs';
import { bootWallpaper, chooseFile, removeWallpaper, setWallPrefs, type WallError } from '../../data/wallpaperRuntime';
import { resolvedTheme } from '../../theme';
import { t, type MessageKey } from '../../i18n/vi';

const ACCEPT = 'image/png,image/jpeg,image/webp,image/avif,image/gif';
const input = ref<HTMLInputElement | null>(null);
const chooseBtn = ref<{ $el: HTMLElement } | null>(null);
const busy = ref(false);
const error = ref<WallError | null>(null);
const over = ref(false);

onMounted(() => { void bootWallpaper(); });

const meta = computed(() => wallState.meta);
const pct = (x: number) => Math.round(x * 100);
const veilPct = computed(() => pct(veilApplied.value));
const veilFloor = computed(() => pct(wallState.floor.veil));
const panelPct = computed(() => pct(panelApplied.value));
const panelFloor = computed(() => Math.max(pct(PANEL_MIN), pct(wallState.floor.panel)));
const themeKey = (id: string) => id.replace(/-([a-z])/g, (_, ch: string) => ch.toUpperCase());
const themeName = computed(() => t(`theme.${themeKey(resolvedTheme.value)}` as MessageKey));

const fitOptions = computed(() => [
  { value: 'cover' as WallFit, label: t('wall.fitCover') },
  { value: 'contain' as WallFit, label: t('wall.fitContain') },
  { value: 'center' as WallFit, label: t('wall.fitCenter') },
  { value: 'tile' as WallFit, label: t('wall.fitTile') },
]);

function bytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

async function take(file: File | undefined | null): Promise<void> {
  if (!file || busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    error.value = await chooseFile(file);
  } catch {
    error.value = 'errDecode';
  } finally {
    busy.value = false;
  }
}
function pick(): void { input.value?.click(); }
function onFile(e: Event): void {
  const el = e.target as HTMLInputElement;
  const f = el.files?.[0];
  el.value = '';
  void take(f);
}
function onDragOver(e: DragEvent): void {
  if (!e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  over.value = true;
}
function onDrop(e: DragEvent): void {
  e.preventDefault();
  over.value = false;
  void take(e.dataTransfer?.files?.[0]);
}

async function remove(): Promise<void> {
  if (busy.value) return;
  busy.value = true;
  error.value = null;
  try {
    await removeWallpaper();
    useToast().show(t('wall.removed'), 'success');
  } catch {
    error.value = 'errStore';
  } finally {
    busy.value = false;
  }
  await nextTick();
  chooseBtn.value?.$el?.focus();
}

const setFit = (v: WallFit | null) => { if (v) setWallPrefs({ fit: v }, true); };
const onVeil = (v: number, store: boolean) => setWallPrefs({ veil: v / 100 }, store);
const onBlur = (v: number, store: boolean) => setWallPrefs({ blur: Math.round(v) }, store);
const onPanel = (v: number, store: boolean) => setWallPrefs({ panel: v / 100 }, store);

/** The preview: the content area in miniature, at about a quarter of its size. */
const MINI = 0.25;
const miniStyle = computed(() => ({ '--wall-veil': String(veilApplied.value), '--wall-blur': `${wallState.prefs.blur * MINI}px` }));
const miniImg = computed(() => {
  const m = meta.value;
  const sized = wallState.prefs.fit === 'center' || wallState.prefs.fit === 'tile';
  return {
    backgroundImage: wallState.url ? `url(${wallState.url})` : undefined,
    backgroundSize: sized && m ? `${m.w * MINI}px ${m.h * MINI}px` : undefined,
  };
});
</script>

<template>
  <Card class="wp-card" :title="t('wall.title')" :subtitle="t('wall.sub')">
    <div
      v-if="!meta"
      class="wp__drop"
      :class="{ 'wp__drop--over': over }"
      @dragover="onDragOver"
      @dragleave="over = false"
      @drop="onDrop"
    >
      <IconPhoto class="wp__ico" :size="28" stroke-width="1.5" aria-hidden="true" />
      <p class="wp__dropText">{{ t('wall.drop') }}</p>
      <Button ref="chooseBtn" size="sm" :icon="IconUpload" :loading="busy" @click="pick">{{ t('wall.choose') }}</Button>
      <p class="wp__types">{{ t('wall.types') }}</p>
    </div>
    <div v-else class="wp" @dragover="onDragOver" @drop="onDrop">
      <div class="wp__thumb" role="img" :aria-label="t('wall.preview')">
        <div v-if="wallState.url" class="wp__wall" :style="miniStyle">
          <div class="wp__wallImg" :class="`wp__wallImg--${wallState.prefs.fit}`" :style="miniImg" />
          <div class="wp__wallVeil" />
        </div>
        <span class="wp__miniSide" />
        <span class="wp__miniTop" />
        <span class="wp__miniCard" style="left: 19%; top: 18%; width: 49%; height: 36%"><i style="top: 18%; width: 40%" /><i style="top: 42%; width: 70%" /></span>
        <span class="wp__miniCard" style="left: 71%; top: 18%; width: 25%; height: 36%"><i style="top: 18%; width: 60%" /></span>
        <span class="wp__miniCard" style="left: 19%; top: 59%; width: 77%; height: 34%"><i style="top: 20%; width: 30%" /><i style="top: 46%; width: 55%" /></span>
      </div>
      <div class="wp__ctl">
        <div class="wp__file">
          <p class="wp__name"><b>{{ meta.name }}</b> · {{ bytes(meta.size) }} · {{ meta.w }} × {{ meta.h }}</p>
          <div class="wp__btns">
            <Button size="sm" :icon="IconUpload" :loading="busy" @click="pick">{{ t('wall.change') }}</Button>
            <Button variant="ghost" size="sm" :icon="IconTrash" :disabled="busy" @click="remove">{{ t('wall.remove') }}</Button>
          </div>
        </div>
        <div class="wp__field">
          <span id="wp-fit" class="wp__label">{{ t('wall.fit') }}</span>
          <Segmented :model-value="wallState.prefs.fit" :options="fitOptions" :label="t('wall.fit')" labelledby="wp-fit" size="sm" @update:model-value="setFit" />
        </div>
        <div class="wp__field">
          <span class="wp__label">{{ t('wall.veil') }}</span>
          <div class="wp__rail">
            <Slider
              :model-value="veilPct"
              :min="0"
              :max="100"
              :step="1"
              :floor="veilFloor"
              :label="t('wall.veil')"
              describedby="wp-floor"
              :format="(v) => `${v}%`"
              @update:model-value="(v) => onVeil(v, false)"
              @commit="(v) => onVeil(v, true)"
            />
            <span v-if="veilFloor > 0" class="wp__tick" :style="{ left: `${veilFloor}%` }" aria-hidden="true" />
          </div>
          <span class="wp__val">{{ veilPct }}%</span>
          <p class="wp__help">{{ t('wall.veilHelp') }}</p>
          <p id="wp-floor" class="wp__floor">
            <IconInfoCircle :size="14" stroke-width="1.8" aria-hidden="true" />
            <span>{{ t('wall.floor', { theme: themeName, veil: veilFloor }) }}</span>
          </p>
        </div>
        <div class="wp__field">
          <span class="wp__label">{{ t('wall.blur') }}</span>
          <Slider
            :model-value="wallState.prefs.blur"
            :min="0"
            :max="BLUR_MAX"
            :step="1"
            :label="t('wall.blur')"
            :format="(v) => `${v} px`"
            @update:model-value="(v) => onBlur(v, false)"
            @commit="(v) => onBlur(v, true)"
          />
          <span class="wp__val">{{ wallState.prefs.blur }} px</span>
        </div>
        <div class="wp__field">
          <span class="wp__label">{{ t('wall.panel') }}</span>
          <Slider
            :model-value="panelPct"
            :min="75"
            :max="100"
            :step="1"
            :floor="panelFloor"
            :label="t('wall.panel')"
            :format="(v) => `${v}%`"
            @update:model-value="(v) => onPanel(v, false)"
            @commit="(v) => onPanel(v, true)"
          />
          <span class="wp__val">{{ panelPct }}%</span>
          <p class="wp__help">{{ t('wall.panelHelp') }}</p>
          <p v-if="panelFloor > 75" class="wp__floor">
            <IconInfoCircle :size="14" stroke-width="1.8" aria-hidden="true" />
            <span>{{ t('wall.floorPanel', { theme: themeName, panel: panelFloor }) }}</span>
          </p>
        </div>
        <p v-if="wallState.hint" class="wp__hint">
          <IconBulb :size="16" stroke-width="1.8" aria-hidden="true" />
          <span>{{ t(wallState.hint.kind === 'bright' ? 'wall.brightHint' : 'wall.darkHint', { theme: wallState.hint.theme, veil: wallState.hint.veil }) }}</span>
        </p>
        <p v-if="wallState.reducedMotion && meta.animated" class="wp__hint">
          <IconPlayerPause :size="16" stroke-width="1.8" aria-hidden="true" />
          <span>{{ t('wall.gifStill') }}</span>
        </p>
      </div>
    </div>
    <p v-if="error" class="wp__err" role="alert">
      <IconAlertCircle :size="16" stroke-width="1.8" aria-hidden="true" />
      <span>{{ t(`wall.${error}` as MessageKey) }}</span>
    </p>
    <input ref="input" type="file" :accept="ACCEPT" hidden @change="onFile">
  </Card>
</template>

<style scoped>
.wp-card { container-type: inline-size; margin-top: var(--s-4); }
.wp__drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--s-2); min-height: 132px; padding: var(--s-4); border: 1px dashed var(--line-3); border-radius: var(--r-card); background: var(--bg-1); text-align: center; }
.wp__drop--over { border-color: var(--acc); }
.wp__ico { color: var(--fg-3); }
.wp__dropText { margin: 0; font-size: var(--fs-body); color: var(--fg-2); }
.wp__types { margin: 0; font-size: var(--fs-caption); color: var(--fg-3); }
.wp { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: var(--s-5); align-items: start; }
@container (max-width: 759.98px) { .wp { grid-template-columns: minmax(0, 1fr); } .wp__thumb { max-width: 420px; } }
/* the preview: the content area in miniature (sidebar strip opaque, top bar glass, three panels at the panel opacity) */
.wp__thumb { position: relative; aspect-ratio: 16 / 9; overflow: hidden; border: 1px solid var(--line-2); border-radius: var(--r-control); background: var(--bg-0); isolation: isolate; }
.wp__wall { position: absolute; inset: 0; overflow: hidden; z-index: 0; }
.wp__wallImg { position: absolute; inset: calc(var(--wall-blur, 0px) * -2); background-position: center; background-repeat: no-repeat; filter: blur(var(--wall-blur, 0px)); }
.wp__wallImg--cover { background-size: cover; }
.wp__wallImg--contain { background-size: contain; }
.wp__wallImg--tile { background-repeat: repeat; background-position: 0 0; }
.wp__wallVeil { position: absolute; inset: 0; background: var(--bg-0); opacity: var(--wall-veil, 0.3); }
.wp__miniSide { position: absolute; left: 0; top: 0; bottom: 0; width: 15%; background: var(--bg-1); border-right: 1px solid var(--line-1); z-index: 2; }
.wp__miniTop { position: absolute; left: 15%; right: 0; top: 0; height: 11%; background: var(--glass); border-bottom: 1px solid var(--line-1); z-index: 2; }
.wp__miniCard { position: absolute; z-index: 2; border: 1px solid var(--line-1); border-radius: 4px; background: var(--panel); }
.wp__miniCard i { position: absolute; left: 8%; height: 5px; border-radius: 3px; background: var(--fg-2); }
.wp__ctl { display: flex; flex-direction: column; gap: var(--s-4); min-width: 0; }
.wp__file { display: flex; flex-wrap: wrap; align-items: center; gap: var(--s-2) var(--s-3); }
.wp__name { min-width: 0; margin: 0; font-size: var(--fs-label); color: var(--fg-2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wp__name b { font-weight: 600; color: var(--fg-1); }
.wp__btns { display: flex; gap: var(--s-2); margin-left: auto; }
.wp__field { display: grid; grid-template-columns: 150px minmax(0, 1fr) 56px; align-items: center; gap: 4px var(--s-3); }
.wp__label { font-size: var(--fs-label); font-weight: 600; color: var(--fg-2); }
.wp__val { justify-self: end; font-size: var(--fs-label); font-weight: 600; color: var(--fg-1); font-variant-numeric: tabular-nums; }
.wp__help { grid-column: 2 / -1; margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-3); }
.wp__field > :deep(.seg) { grid-column: 2 / -1; justify-self: start; }
/* the floor: a tick on the rail where the slider stops, and a line under it */
.wp__rail { position: relative; }
.wp__tick { position: absolute; top: 50%; width: 2px; height: 14px; margin: -7px 0 0 -1px; border-radius: 1px; background: var(--fg-2); pointer-events: none; }
.wp__floor { grid-column: 2 / -1; display: flex; gap: 6px; align-items: flex-start; margin: 0; font-size: var(--fs-caption); line-height: 16px; color: var(--fg-2); }
.wp__floor svg { flex: none; margin-top: 1px; color: var(--info); }
.wp__hint { display: flex; gap: 6px; align-items: flex-start; margin: 0; font-size: var(--fs-label); line-height: 18px; color: var(--fg-2); }
.wp__hint svg { flex: none; margin-top: 1px; color: var(--fg-3); }
.wp__err { display: flex; gap: 6px; align-items: flex-start; margin: 0; padding: var(--s-2) var(--s-3); border-radius: var(--r-control); background: var(--danger-soft); color: var(--danger); font-size: var(--fs-label); line-height: 18px; }
.wp__err svg { flex: none; margin-top: 1px; }
</style>
