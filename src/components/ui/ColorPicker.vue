<script setup lang="ts">
// HSV square + hue strip + HEX/RGB inputs + recent colours (kept in localStorage).
// v-model is a "#rrggbb" string; `commit` fires when a gesture ends (and records a recent colour).
// Arrow keys commit once, on key release, so holding a key is one edit and one recent colour.
import { computed, ref, watch } from 'vue';
import { t } from '../../i18n/vi';
import { RECENT_KEY, RECENT_MAX, loadRecent } from './recentColors';

const model = defineModel<string>({ required: true });
const props = defineProps<{ disabled?: boolean }>();
const emit = defineEmits<{ commit: [string] }>();

interface Hsv { h: number; s: number; v: number }

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((x) => Math.round(x).toString(16).padStart(2, '0')).join('')}`;
}
function rgbToHsv(r: number, g: number, b: number): Hsv {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
  let h = 0;
  if (d) h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s: max ? d / max : 0, v: max };
}
function hsvToRgb({ h, s, v }: Hsv): [number, number, number] {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return 255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1)));
  };
  return [f(5), f(3), f(1)];
}

const hsv = ref<Hsv>(rgbToHsv(...hexToRgb(model.value)));
const rgb = computed(() => hexToRgb(model.value));
const hexText = ref(model.value);
const recent = ref<string[]>(loadRecent());

watch(model, (v) => {
  hexText.value = v;
  if (rgbToHex(...hsvToRgb(hsv.value)) !== v) hsv.value = rgbToHsv(...hexToRgb(v));
});

function remember(hex: string) {
  recent.value = [hex, ...recent.value.filter((c) => c !== hex)].slice(0, RECENT_MAX);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent.value)); } catch { /* storage unavailable */ }
}
// Takes the value explicitly: right after `model.value = x` the prop may still hold the old colour.
function finish(hex = model.value) {
  remember(hex);
  emit('commit', hex);
}

function setHsv(next: Hsv): string {
  hsv.value = next;
  const hex = rgbToHex(...hsvToRgb(next));
  model.value = hex;
  return hex;
}

function drag(e: PointerEvent, apply: (x: number, y: number) => string) {
  if (props.disabled || e.button !== 0) return;
  const el = e.currentTarget as HTMLElement;
  el.setPointerCapture(e.pointerId);
  let last = model.value;
  const at = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect();
    last = apply(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)));
  };
  at(e);
  const move = (ev: PointerEvent) => at(ev);
  // pointercancel has no usable position: end on the last colour reached, like pointerup.
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', up);
    finish(last);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
}

const onSquare = (e: PointerEvent) => drag(e, (x, y) => setHsv({ ...hsv.value, s: x, v: 1 - y }));
const onHue = (e: PointerEvent) => drag(e, (x) => setHsv({ ...hsv.value, h: x * 359.9 }));

/** Colour reached by arrow keys and not yet committed (see onKeyEnd). */
let pendingKey: string | null = null;
function onKeyEnd() {
  if (pendingKey === null) return;
  const hex = pendingKey;
  pendingKey = null;
  finish(hex);
}

function onSquareKey(e: KeyboardEvent) {
  if (props.disabled) return;
  const d = e.shiftKey ? 0.1 : 0.02;
  const { s, v } = hsv.value;
  const map: Record<string, Partial<Hsv>> = { ArrowLeft: { s: s - d }, ArrowRight: { s: s + d }, ArrowUp: { v: v + d }, ArrowDown: { v: v - d } };
  const p = map[e.key];
  if (!p) return;
  e.preventDefault();
  pendingKey = setHsv({ ...hsv.value, s: Math.min(1, Math.max(0, p.s ?? s)), v: Math.min(1, Math.max(0, p.v ?? v)) });
}
function onHueKey(e: KeyboardEvent) {
  if (props.disabled) return;
  const d = (e.shiftKey ? 15 : 3) * (e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : 0);
  if (!d) return;
  e.preventDefault();
  pendingKey = setHsv({ ...hsv.value, h: (hsv.value.h + d + 360) % 360 });
}

function onHex() {
  const m = /^#?([0-9a-f]{6})$/i.exec(hexText.value.trim());
  if (!m) { hexText.value = model.value; return; }
  const hex = `#${m[1].toLowerCase()}`;
  hexText.value = hex;
  if (hex === model.value) return; // blur without an edit is not a commit
  model.value = hex;
  finish(hex);
}
function onRgb(i: 0 | 1 | 2, e: Event) {
  const input = e.target as HTMLInputElement;
  const raw = input.value.trim();
  if (raw === '' || !Number.isFinite(Number(raw))) { input.value = String(rgb.value[i]); return; }
  const n = Math.min(255, Math.max(0, Math.round(Number(raw))));
  const c = [...rgb.value] as [number, number, number];
  c[i] = n;
  const hex = rgbToHex(...c);
  model.value = hex;
  finish(hex);
}
function pick(hex: string) {
  model.value = hex;
  finish(hex);
}

const hueColor = computed(() => rgbToHex(...hsvToRgb({ h: hsv.value.h, s: 1, v: 1 })));
</script>

<template>
  <div class="cp" :class="{ 'cp--disabled': disabled }">
    <div
      class="cp__sv"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      :aria-label="t('ui.saturation')"
      :aria-disabled="disabled || undefined"
      :aria-valuetext="model"
      :style="{ backgroundColor: hueColor }"
      @pointerdown="onSquare"
      @keydown="onSquareKey"
      @keyup="onKeyEnd"
      @blur="onKeyEnd"
    >
      <span class="cp__dot" :style="{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%`, background: model }" />
    </div>
    <div
      class="cp__hue"
      role="slider"
      :tabindex="disabled ? -1 : 0"
      :aria-disabled="disabled || undefined"
      :aria-label="t('ui.hue')"
      aria-valuemin="0"
      aria-valuemax="360"
      :aria-valuenow="Math.round(hsv.h)"
      @pointerdown="onHue"
      @keydown="onHueKey"
      @keyup="onKeyEnd"
      @blur="onKeyEnd"
    >
      <span class="cp__hue-thumb" :style="{ left: `${(hsv.h / 360) * 100}%` }" />
    </div>
    <div class="cp__inputs">
      <span class="cp__swatch" :style="{ background: model }" />
      <label class="cp__field cp__field--hex">
        <span class="micro">{{ t('ui.hex') }}</span>
        <input v-model="hexText" class="num" :disabled="disabled" spellcheck="false" maxlength="7" @keydown.enter="onHex" @blur="onHex">
      </label>
      <label v-for="(ch, i) in (['R', 'G', 'B'] as const)" :key="ch" class="cp__field">
        <span class="micro">{{ ch }}</span>
        <input class="num" inputmode="numeric" :disabled="disabled" :value="rgb[i]" @change="onRgb(i as 0 | 1 | 2, $event)">
      </label>
    </div>
    <div v-if="recent.length" class="cp__recent">
      <span class="micro">{{ t('ui.recentColors') }}</span>
      <div class="cp__chips">
        <button v-for="c in recent" :key="c" type="button" class="cp__chip" :disabled="disabled" :style="{ background: c }" :aria-label="c" :title="c" @click="pick(c)" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cp { display: flex; flex-direction: column; gap: var(--s-3); width: 100%; max-width: 280px; }
.cp--disabled .cp__sv, .cp--disabled .cp__hue { cursor: not-allowed; }
.cp__sv {
  position: relative;
  height: 160px;
  border-radius: var(--r-control);
  background-image: linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, transparent);
  cursor: crosshair;
  touch-action: none;
}
.cp__dot {
  position: absolute;
  width: 14px;
  height: 14px;
  margin: -7px 0 0 -7px;
  border-radius: 50%;
  border: 2px solid #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4), 0 2px 6px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
.cp__hue {
  position: relative;
  height: 12px;
  border-radius: 6px;
  background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
  cursor: pointer;
  touch-action: none;
}
.cp__hue-thumb {
  position: absolute;
  top: -2px;
  width: 8px;
  height: 16px;
  margin-left: -4px;
  border-radius: 3px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
  pointer-events: none;
}
.cp__inputs { display: flex; align-items: flex-end; gap: var(--s-2); }
.cp__swatch { flex: none; width: 30px; height: 30px; border-radius: var(--r-control); border: 1px solid var(--line-2); }
.cp__field { display: flex; flex-direction: column; gap: 3px; width: 44px; }
.cp__field--hex { width: 82px; }
.cp__field input {
  height: 30px;
  width: 100%;
  border: 1px solid var(--line-2);
  border-radius: var(--r-control);
  background: var(--bg-1);
  padding: 0 6px;
  font-size: var(--fs-label);
}
.cp__field input:focus-visible { border-color: var(--acc-line); }
.cp__recent { display: flex; flex-direction: column; gap: 6px; }
.cp__chips { display: flex; flex-wrap: wrap; gap: 6px; }
.cp__chip {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  border: 1px solid var(--line-2);
  padding: 0;
  transition: transform var(--t-fast) var(--ease);
}
.cp__chip:hover { transform: scale(1.12); }
</style>
