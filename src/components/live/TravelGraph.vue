<script setup lang="ts">
// Last 3 s of the focused key's travel on a canvas, redrawn every animation frame straight from the live
// store's ring buffer (no Vue reactivity per sample). Depth grows downwards, like the switch gauge.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ActuationSettings, LiveData } from '../../stores/live';
import { releasePoint } from '../../stores/live';
import { isRtMode } from '../../protocol';
import { resolvedTheme } from '../../theme';
import { HoldTracker } from './graphHold';
import { GraphHistory } from './graphHistory';

const props = defineProps<{
  data: LiveData;
  settings: ActuationSettings | null;
  range: number;
  paused: boolean;
  label: string;
}>();
const emit = defineEmits<{ hold: [holding: boolean]; pan: [secondsBack: number | null]; review: [reviewing: boolean] }>();

const WINDOW_MS = 3000;
const PAD = { l: 34, r: 10, t: 10, b: 10 };
const DRAG_MIN_PX = 4;
const KEY_STEP_MS = 500;
const KEY_STEP_SHIFT_MS = 2000;

const canvas = ref<HTMLCanvasElement | null>(null);
const probeEl = ref<HTMLSpanElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let ro: ResizeObserver | null = null;
let w = 0;
let h = 0;
let frozenAt = 0; // manual pause clock
const tracker = new HoldTracker();
let seenEpoch = props.data.epoch;
let seenT = -Infinity;
let emittedHold = false;
// The trace is always drawn from this history (live and frozen). It only grows while the view is not frozen
// (auto hold, manual pause or panned), so a frozen view never loses its stroke however long it stays frozen.
const history = new GraphHistory();
let lastClock = 0; // the view clock of the last frame before any pan
let panActive = false;
let panMs = 0;
let panBase = 0; // clock at the moment the pan started
let dragPointer: number | null = null;
let dragStartX = 0;
let dragLastX = 0;
let dragging = false;
let emittedPan: number | null = null;
let focused = false;
let emittedReview = false;
let cursor = '';
const col: Record<string, string> = {};

// Canvas cannot take var() or color-mix(): resolve each colour through a hidden probe element's computed colour.
const COLOURS: Record<string, string> = {
  'line-1': 'var(--line-1)',
  'fg-1': 'var(--fg-1)',
  'fg-2': 'var(--fg-2)',
  'fg-3': 'var(--fg-3)',
  'bg-2': 'var(--bg-2)',
  actuation: 'var(--m-actuation)',
  press: 'var(--m-press)',
  release: 'var(--m-release)',
  'actuation-fill': 'color-mix(in srgb, var(--m-actuation) 14%, transparent)',
  deadzone: 'var(--m-deadzone)',
};

function readColours() {
  const probe = probeEl.value;
  if (!probe) return;
  for (const [name, value] of Object.entries(COLOURS)) {
    probe.style.color = '';
    probe.style.color = value;
    col[name] = getComputedStyle(probe).color || '#888';
  }
}

function resize() {
  const el = canvas.value;
  if (!el) return;
  const dpr = window.devicePixelRatio || 1;
  w = el.clientWidth;
  h = el.clientHeight;
  el.width = Math.round(w * dpr);
  el.height = Math.round(h * dpr);
  ctx = el.getContext('2d');
  ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
}

const plotWidth = () => Math.max(1, w - PAD.l - PAD.r);

function maxPan(base: number): number {
  const o = history.oldestT();
  return Number.isNaN(o) ? 0 : Math.max(0, base - o - WINDOW_MS);
}

/** Pan the view `ms` back from its base clock, clamped to the history. A pan starts only if it moves back. */
function setPan(ms: number) {
  const base = panActive ? panBase : lastClock;
  const v = Math.min(Math.max(ms, 0), maxPan(base));
  if (!panActive) {
    if (v <= 0) return;
    panActive = true;
    panBase = base;
    emitReview();
  }
  panMs = v;
}

function leavePan() {
  panActive = false;
  panMs = 0;
  dragging = false;
  dragPointer = null;
  emitPan();
}

/** Panned or keyboard-focused: the page keeps auto-follow from switching keys under the user. */
function emitReview() {
  const v = panActive || focused;
  if (v === emittedReview) return;
  emittedReview = v;
  emit('review', v);
}

function emitPan() {
  emitReview();
  const v = panActive ? Math.round(panMs / 100) / 10 : null;
  if (v === emittedPan) return;
  emittedPan = v;
  emit('pan', v);
}

function onFocus() {
  focused = true;
  emitReview();
}

function onBlur() {
  focused = false;
  emitReview();
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return;
  dragPointer = e.pointerId ?? 0;
  dragStartX = dragLastX = e.clientX;
  dragging = false;
  try { canvas.value?.setPointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
}

function onPointerMove(e: PointerEvent) {
  if (dragPointer === null || (e.pointerId ?? 0) !== dragPointer) return;
  if (!dragging) {
    if (Math.abs(e.clientX - dragStartX) < DRAG_MIN_PX) return;
    dragging = true;
  }
  const dx = e.clientX - dragLastX;
  dragLastX = e.clientX;
  setPan(panMs + dx * (WINDOW_MS / plotWidth())); // grab: the trace follows the pointer, so dragging right shows earlier samples
}

function onPointerEnd(e: PointerEvent) {
  if (dragPointer === null || (e.pointerId ?? 0) !== dragPointer) return;
  dragPointer = null;
  dragging = false;
  try { canvas.value?.releasePointerCapture?.(e.pointerId); } catch { /* synthetic pointer */ }
  if (panActive && panMs === 0) leavePan();
}

function onKeyDown(e: KeyboardEvent) {
  const step = e.shiftKey ? KEY_STEP_SHIFT_MS : KEY_STEP_MS;
  if (e.key === 'ArrowLeft') setPan(panMs + step);
  else if (e.key === 'ArrowRight') { if (panActive) setPan(panMs - step); }
  else if (e.key === 'Home') setPan(Infinity);
  else if (e.key === 'End' || e.key === 'Escape') leavePan();
  else return;
  e.preventDefault();
}

function toLive() {
  leavePan();
}

defineExpose({ toLive });

function setHold(v: boolean) {
  if (v === emittedHold) return;
  emittedHold = v;
  emit('hold', v);
}

function draw(realNow: number) {
  raf = requestAnimationFrame(draw);
  const c = ctx;
  if (!c || !w || !h) return;
  const d = props.data;

  // clear / focus change (epoch, not version: version bumps on every ingest): forget the stroke, history and pan
  if (d.epoch !== seenEpoch) {
    seenEpoch = d.epoch;
    tracker.reset();
    history.clear();
    seenT = -Infinity;
    panActive = false;
    panMs = 0;
    dragging = false;
    dragPointer = null;
  }
  // feed only the new samples to the tracker
  let newest = seenT;
  d.ring.forEach(seenT, (t, mm) => {
    if (t <= seenT) return;
    tracker.feed(t, mm);
    if (t > newest) newest = t;
  });
  seenT = newest;

  const holdClock = tracker.frozenAt(realNow);
  let now = realNow;
  let frozen = false;
  if (props.paused) {
    if (!frozenAt) frozenAt = holdClock ?? realNow;
    now = frozenAt;
    frozen = true;
  } else {
    frozenAt = 0;
    if (holdClock !== null) { now = holdClock; frozen = true; }
  }
  lastClock = now;
  if (panActive) {
    now = panBase - panMs;
    frozen = true;
  }
  setHold(!panActive && !props.paused && holdClock !== null);
  emitPan();
  // the history grows only while live; on unfreezing it backfills whatever the ring still holds
  if (!frozen) {
    const last = history.newestT();
    d.ring.forEach(Number.isNaN(last) ? -Infinity : last, (t, mm) => history.push(t, mm));
  }
  const nextCursor = dragging ? 'grabbing' : history.size > 1 && history.newestT() - history.oldestT() > WINDOW_MS ? 'grab' : '';
  if (nextCursor !== cursor && canvas.value) { cursor = nextCursor; canvas.value.style.cursor = nextCursor; }
  const range = props.range;
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const y0 = PAD.t;
  const y1 = h - PAD.b;
  const from = now - WINDOW_MS;
  const X = (t: number) => x0 + ((t - from) / WINDOW_MS) * (x1 - x0);
  const Y = (mm: number) => y0 + (Math.min(Math.max(mm, 0), range) / range) * (y1 - y0);

  c.clearRect(0, 0, w, h);
  c.font = '11px Inter Variable, Inter, system-ui, sans-serif';
  c.textBaseline = 'middle';
  c.textAlign = 'right';

  // grid: every 0.5 mm, every 0.5 s
  c.lineWidth = 1;
  for (let mm = 0; mm <= range + 1e-6; mm += 0.5) {
    const y = Math.round(Y(mm)) + 0.5;
    c.strokeStyle = col['line-1'];
    c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    c.fillStyle = col['fg-3'];
    c.fillText(mm.toFixed(1), x0 - 6, y);
  }
  for (let s = Math.ceil(from / 500) * 500; s <= now; s += 500) {
    const x = Math.round(X(s)) + 0.5;
    c.strokeStyle = col['line-1'];
    c.beginPath(); c.moveTo(x, y0); c.lineTo(x, y1); c.stroke();
  }

  // settings: dead zones + trigger lines
  const st = props.settings;
  if (st) {
    c.fillStyle = col.deadzone;
    c.globalAlpha = 0.14;
    if (st.pressDeadStroke > 0) c.fillRect(x0, Y(0), x1 - x0, Y(st.pressDeadStroke) - Y(0));
    if (st.releaseDeadStroke > 0) c.fillRect(x0, Y(range - st.releaseDeadStroke), x1 - x0, Y(range) - Y(range - st.releaseDeadStroke));
    c.globalAlpha = 1;
    const line = (mm: number, colour: string, dash: number[]) => {
      const y = Math.round(Y(mm)) + 0.5;
      c.strokeStyle = colour;
      c.setLineDash(dash);
      c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
      c.setLineDash([]);
    };
    if (isRtMode(st.mode)) line(st.rtFirstTouch, col.actuation, [5, 4]);
    else {
      line(st.normalPress, col.actuation, [5, 4]);
      const rel = releasePoint(st);
      if (Math.abs(rel - st.normalPress) > 0.0005) line(rel, col.release, [3, 4]);
    }
  }

  // travel trace + soft area
  c.beginPath();
  let first = true;
  let firstX = x0;
  let lastX = x0;
  const point = (t: number, mm: number) => {
    const x = Math.max(x0, X(t));
    const y = Y(mm);
    if (first) { c.moveTo(x, y); first = false; firstX = x; } else c.lineTo(x, y);
    lastX = x;
  };
  history.forEach(from - 50, frozen ? now : Infinity, point);
  if (!first) {
    c.strokeStyle = col['fg-1'];
    c.lineWidth = 1.75;
    c.lineJoin = 'round';
    c.stroke();
    c.lineTo(lastX, y0);
    c.lineTo(firstX, y0);
    c.closePath();
    c.fillStyle = col['actuation-fill'];
    c.fill();
  }

  // events
  for (const e of d.events) {
    if (e.t < from || e.t > (frozen ? now : Infinity)) continue;
    const x = X(e.t);
    const y = Y(e.depth);
    c.beginPath();
    c.arc(x, y, e.kind === 'press' ? 4 : 3.5, 0, Math.PI * 2);
    if (e.kind === 'press') {
      c.fillStyle = col.press;
      c.fill();
    } else {
      c.fillStyle = col['bg-2'];
      c.fill();
      c.strokeStyle = col.release;
      c.lineWidth = 1.5;
      c.stroke();
    }
  }
}

watch(resolvedTheme, () => readColours(), { flush: 'post' });

onMounted(() => {
  readColours();
  resize();
  ro = new ResizeObserver(resize);
  ro.observe(canvas.value!);
  raf = requestAnimationFrame(draw);
});
onBeforeUnmount(() => {
  cancelAnimationFrame(raf);
  ro?.disconnect();
});
</script>

<template>
  <canvas
    ref="canvas"
    class="graph"
    role="img"
    tabindex="0"
    aria-keyshortcuts="ArrowLeft ArrowRight Home End Escape"
    :aria-label="label"
    @mousedown.prevent
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerEnd"
    @pointercancel="onPointerEnd"
    @dblclick="leavePan"
    @keydown="onKeyDown"
    @focus="onFocus"
    @blur="onBlur"
  />
  <span ref="probeEl" class="probe" aria-hidden="true" />
</template>

<style scoped>
.graph { display: block; width: 100%; height: 220px; touch-action: pan-y; }
.graph:focus-visible { outline: none; box-shadow: var(--focus-ring); border-radius: var(--r-control); }
.probe { display: none; }
</style>
