<script setup lang="ts">
// Last 3 s of the focused key's travel on a canvas, redrawn every animation frame straight from the live
// store's ring buffer (no Vue reactivity per sample). Depth grows downwards, like the switch gauge.
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { ActuationSettings, LiveData } from '../../stores/live';
import { releasePoint } from '../../stores/live';
import { isRtMode } from '../../protocol';

const props = defineProps<{
  data: LiveData;
  settings: ActuationSettings | null;
  range: number;
  paused: boolean;
  label: string;
}>();

const WINDOW_MS = 3000;
const PAD = { l: 34, r: 10, t: 10, b: 10 };

const canvas = ref<HTMLCanvasElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let ro: ResizeObserver | null = null;
let w = 0;
let h = 0;
let frozenAt = 0;
const col: Record<string, string> = {};

function readColours() {
  const cs = getComputedStyle(document.documentElement);
  for (const name of ['acc', 'acc-line', 'acc-soft', 'fg-1', 'fg-2', 'fg-3', 'fg-4', 'line-1', 'line-2', 'warn', 'bg-2']) {
    col[name] = cs.getPropertyValue(`--${name}`).trim() || '#888';
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

function draw(now: number) {
  raf = requestAnimationFrame(draw);
  const c = ctx;
  if (!c || !w || !h) return;
  if (props.paused) {
    if (!frozenAt) frozenAt = now;
    now = frozenAt;
  } else frozenAt = 0;
  const range = props.range;
  const x0 = PAD.l;
  const x1 = w - PAD.r;
  const y0 = PAD.t;
  const y1 = h - PAD.b;
  const from = now - WINDOW_MS;
  const X = (t: number) => x0 + ((t - from) / WINDOW_MS) * (x1 - x0);
  const Y = (mm: number) => y0 + (Math.min(Math.max(mm, 0), range) / range) * (y1 - y0);

  c.clearRect(0, 0, w, h);
  c.font = '10px Inter Variable, Inter, system-ui, sans-serif';
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
    c.fillStyle = col.warn;
    c.globalAlpha = 0.08;
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
    if (isRtMode(st.mode)) line(st.rtFirstTouch, col.acc, [5, 4]);
    else {
      line(st.normalPress, col.acc, [5, 4]);
      const rel = releasePoint(st);
      if (Math.abs(rel - st.normalPress) > 0.0005) line(rel, col['fg-3'], [3, 4]);
    }
  }

  // travel trace + soft area
  const d = props.data;
  c.beginPath();
  let first = true;
  let firstX = x0;
  let lastX = x0;
  d.ring.forEach(from - 50, (t, mm) => {
    const x = Math.max(x0, X(t));
    const y = Y(mm);
    if (first) { c.moveTo(x, y); first = false; firstX = x; } else c.lineTo(x, y);
    lastX = x;
  });
  if (!first) {
    c.strokeStyle = col['fg-1'];
    c.lineWidth = 1.75;
    c.lineJoin = 'round';
    c.stroke();
    c.lineTo(lastX, y0);
    c.lineTo(firstX, y0);
    c.closePath();
    c.globalAlpha = 0.5;
    c.fillStyle = col['acc-soft'];
    c.fill();
    c.globalAlpha = 1;
  }

  // events
  for (const e of d.events) {
    if (e.t < from) continue;
    const x = X(e.t);
    const y = Y(e.depth);
    c.beginPath();
    c.arc(x, y, e.kind === 'press' ? 4 : 3.5, 0, Math.PI * 2);
    if (e.kind === 'press') {
      c.fillStyle = col.acc;
      c.fill();
    } else {
      c.fillStyle = col['bg-2'];
      c.fill();
      c.strokeStyle = col['fg-2'];
      c.lineWidth = 1.5;
      c.stroke();
    }
  }
}

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
  <canvas ref="canvas" class="graph" role="img" :aria-label="label" />
</template>

<style scoped>
.graph { display: block; width: 100%; height: 220px; }
</style>
