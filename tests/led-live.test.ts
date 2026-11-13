// LED60: live LED preview at up to one frame per display frame. The read loop (lighting store: pacing, the packets it
// reads, when it stops, errors, writes not starved), readLedMatrix with pages, the rgb glow helper, the fast demo
// replies, and the painter on the Lighting page (only what changed, nothing through Vue's render, nothing left behind).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';

import { ledGlow, ledGlowRgb, LED_OFF_BELOW } from '../src/ledGlow';
import { LED_MATRIX_COLS, MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import { isWriteCommand } from '../src/protocol/safety';
import { setLocale } from '../src/i18n/locale';
import { useDeviceStore } from '../src/stores/device';
import { useLightingStore } from '../src/stores/lighting';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { LIVE_FACE_CLASS, LiveLedPainter, faceStyle, liveDotColor } from '../src/components/keyboard/liveLedPainter';
import type { FaceState } from '../src/components/keyboard/liveLedPainter';
import { useFlashStore } from '../src/stores/flash';
import { stripRing } from '../src/protocol/ledLayout';
import LightingPage from '../src/pages/LightingPage.vue';

vi.setConfig({ testTimeout: 30000 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => r(undefined)));
/** The LED colour a live face is lit with (the first hex in its inline background), '' when not lit. */
const ledOf = (el: HTMLElement) => /#[0-9a-f]{6}/.exec(el.style.getPropertyValue('background'))?.[0] ?? '';
/** faceStyle() as jsdom stores it (it rewrites box-shadow and border-color values on the way in). */
function asStored(st: { background: string; borderColor: string; boxShadow: string }) {
  const d = document.createElement('div');
  d.style.setProperty('background', st.background);
  d.style.setProperty('border-color', st.borderColor);
  d.style.setProperty('box-shadow', st.boxShadow);
  return { background: d.style.getPropertyValue('background'), borderColor: d.style.getPropertyValue('border-color'), boxShadow: d.style.getPropertyValue('box-shadow') };
}

type Pkt = { t: number; bytes: number[] };
async function demo(model: 'max' | 'pro' = 'max') {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(model);
  const mock = device.transport as MockTransport;
  (mock as unknown as { latencyMs: number }).latencyMs = 0;
  // the browser demo's replies for LED reads (a MessageChannel task): jsdom timers here take ~15 ms each
  (mock as unknown as { fastLedReplies: boolean }).fastLedReplies = true;
  const out: Pkt[] = [];
  mock.onPacketRaw((dir, bytes) => { if (dir === 'out') out.push({ t: performance.now(), bytes: Array.from(bytes.slice(0, 4)) }); });
  const lighting = useLightingStore();
  await lighting.load();
  out.length = 0;
  return { device, mock, lighting, out };
}
const isLedRead = (p: Pkt) => p.bytes[0] === 0x05 && p.bytes[1] === 0x03;
const expectedPages = (keys: { row: number; col: number }[]) => [...new Set(keys.map((k) => Math.floor((k.row * LED_MATRIX_COLS + k.col) / 15)))].sort((a, b) => a - b);

describe('LED60 read loop', () => {
  let stop: (() => void) | null = null;
  afterEach(() => { stop?.(); stop = null; vi.restoreAllMocks(); });

  it('reads frame after frame without the old 100 ms wait', async () => {
    const { lighting } = await demo();
    lighting.startLivePolling();
    stop = () => lighting.stopLivePolling();
    await vi.waitFor(() => expect(lighting.liveHasFrame).toBe(true));
    const seq0 = lighting.liveFrame.seq;
    await sleep(1000);
    // paced by the display frame (jsdom: ~16–25 ms) and the replies; with a 100 ms wait it was at most 10
    expect(lighting.liveFrame.seq - seq0).toBeGreaterThanOrEqual(18);
  });

  it('never reads more than one frame per display frame', async () => {
    const { lighting } = await demo();
    let rafs = 0;
    const raf = window.requestAnimationFrame.bind(window);
    let counting = true;
    const tick = () => { if (!counting) return; rafs++; raf(tick); };
    raf(tick);
    lighting.startLivePolling();
    stop = () => { counting = false; lighting.stopLivePolling(); };
    await vi.waitFor(() => expect(lighting.liveHasFrame).toBe(true));
    const [s0, r0] = [lighting.liveFrame.seq, rafs];
    await sleep(800);
    expect(lighting.liveFrame.seq - s0).toBeLessThanOrEqual(rafs - r0 + 1);
  });

  it('on a display faster than the bus a frame still starts at least 14 ms after the one before (at most ~70 a second)', async () => {
    // a 200 Hz display (a frame of reads takes ~2 ms here): some frames end within the display frame they started in,
    // some after it, so both ways to the next frame run; only the frame interval paces the reads
    let queue: FrameRequestCallback[] = [];
    let vsync = performance.now() + 5;
    let running = true;
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      if (!running) return;
      const t = performance.now();
      if (t >= vsync) {
        vsync = t + 5;
        const due = queue;
        queue = [];
        for (const cb of due) cb(t);
      }
      ch.port2.postMessage(0);
    };
    ch.port2.postMessage(0);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.push(cb); return 1; });
    vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
    const { device, lighting, out } = await demo();
    const first = expectedPages(device.keys)[0];
    lighting.startLivePolling();
    stop = () => { lighting.stopLivePolling(); running = false; ch.port1.close(); vi.unstubAllGlobals(); };
    await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(2));
    out.length = 0;
    await sleep(600);
    const starts = out.filter((p) => p.bytes[2] === 0 && p.bytes[3] === first).map((p) => p.t);
    expect(starts.length).toBeGreaterThanOrEqual(5);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    // 14 ms, less the 1 ms the loop does not wait for and a timer that fires up to ~1 ms early (without the interval: ≤ ~6 ms)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(11);
  });

  for (const model of ['max', 'pro'] as const) {
    it(`${model}: a frame reads only the area-0 packets that hold a key's LED and the 3 strip packets; nothing is written`, async () => {
      const { device, lighting, out } = await demo(model);
      const pages = expectedPages(device.keys);
      if (model === 'max') expect(pages).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(lighting.livePages).toEqual(pages);
      lighting.startLivePolling();
      stop = () => lighting.stopLivePolling();
      await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(6));
      lighting.stopLivePolling();
      await sleep(50);
      const frames = lighting.liveFrame.seq;
      expect(out.every(isLedRead)).toBe(true); // 0 writes, 0 other commands
      expect(out.some((p) => isWriteCommand(p.bytes))).toBe(false);
      const count = (area: number, page: number) => out.filter((p) => p.bytes[2] === area && p.bytes[3] === page).length;
      for (let p = 0; p < 9; p++) {
        if (pages.includes(p)) expect(count(0, p), `area 0 packet ${p}`).toBeGreaterThanOrEqual(frames);
        else expect(count(0, p), `area 0 packet ${p}`).toBe(0);
      }
      // the strip every frame (no longer every other one)
      for (const p of [0, 1, 2]) {
        expect(count(1, p)).toBeGreaterThanOrEqual(frames);
        expect(count(1, p)).toBeLessThanOrEqual(frames + 1);
      }
      expect(out.length).toBeLessThanOrEqual((pages.length + 3) * (frames + 1));
    });
  }

  it('the live frame carries what the keyboard returned, by matrix cell and strip index', async () => {
    const { device, mock, lighting } = await demo();
    lighting.startLivePolling();
    stop = () => lighting.stopLivePolling();
    await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(2));
    lighting.stopLivePolling();
    await sleep(30);
    // a custom LED answers its own colour (not the moving pattern): compare with a direct read
    const m0 = await mock.readLedMatrix(0);
    const m1 = await mock.readLedMatrix(1);
    for (const k of device.keys) {
      const cell = k.row * LED_MATRIX_COLS + k.col;
      if (!m0[cell].custom) continue;
      expect([...lighting.liveFrame.keys.slice(cell * 3, cell * 3 + 3)]).toEqual([m0[cell].r, m0[cell].g, m0[cell].b]);
    }
    for (let i = 0; i < 38; i++) {
      if (!m1[i].custom) continue;
      expect([...lighting.liveFrame.strip.slice(i * 3, i * 3 + 3)]).toEqual([m1[i].r, m1[i].g, m1[i].b]);
    }
  });

  // Each reason to stop: no packet after the one in flight, no error shown, and it reads again once the reason is gone.
  let hiddenReads = 0;
  const reasons: [string, (c: Awaited<ReturnType<typeof demo>>) => () => void][] = [
    ['the tab is hidden', () => {
      const d = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden')!;
      hiddenReads = 0;
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => { hiddenReads++; return true; } });
      return () => { delete (document as unknown as Record<string, unknown>).hidden; Object.defineProperty(Document.prototype, 'hidden', d); };
    }],
    ['the device is not connected', ({ device }) => {
      device.status = 'connecting';
      return () => { device.status = 'connected'; };
    }],
    ['another page holds the device (exclusive)', ({ device }) => {
      let release!: () => void;
      void device.withTransport(() => new Promise<void>((r) => { release = r; }), { exclusive: true });
      return () => release();
    }],
    ['a write is pending', () => {
      useSyncStore().state = 'pending';
      return () => { useSyncStore().state = 'saved'; };
    }],
    ['a write is running', () => {
      useSyncStore().state = 'writing';
      return () => { useSyncStore().state = 'saved'; };
    }],
    ['live preview is off', ({ lighting }) => {
      lighting.livePreview = false;
      return () => { lighting.livePreview = true; };
    }],
  ];
  for (const [why, set] of reasons) {
    it(`stops while ${why}, and reads again after`, async () => {
      const c = await demo();
      c.lighting.startLivePolling();
      stop = () => c.lighting.stopLivePolling();
      await vi.waitFor(() => expect(c.lighting.liveFrame.seq).toBeGreaterThanOrEqual(2));
      const undo = set(c);
      await sleep(40); // the packet in flight
      const n = c.out.length;
      const seq = c.lighting.liveFrame.seq;
      const reads0 = hiddenReads;
      await sleep(400);
      expect(c.out.length - n).toBe(0);
      expect(c.lighting.liveFrame.seq).toBe(seq);
      expect(c.lighting.liveError).toBe(false); // paused, not failed
      if (why === 'the tab is hidden') expect(hiddenReads - reads0).toBeLessThanOrEqual(3); // looks again every 500 ms
      undo();
      await vi.waitFor(() => expect(c.lighting.liveFrame.seq).toBeGreaterThan(seq + 2), { timeout: 3000 });
    });
  }

  it('leaving the page (stop): no packet after the one in flight, no timer left', async () => {
    const { lighting, out } = await demo();
    lighting.startLivePolling();
    await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(2));
    lighting.stopLivePolling();
    await sleep(40);
    const n = out.length;
    await sleep(400);
    expect(out.length).toBe(n);
    expect(lighting.liveHasFrame).toBe(false);
  });

  it('after a failed read the next try waits 500 ms; a good read goes back to the continuous pace', async () => {
    const { mock, lighting } = await demo();
    const tries: number[] = [];
    const real = mock.readLedMatrix.bind(mock);
    let failing = true;
    vi.spyOn(mock, 'readLedMatrix').mockImplementation(async (area: number, pages?: readonly number[]) => {
      tries.push(performance.now());
      if (failing) throw new Error('read failed');
      return real(area, pages);
    });
    lighting.startLivePolling();
    stop = () => lighting.stopLivePolling();
    await vi.waitFor(() => expect(lighting.liveError).toBe(true));
    expect(lighting.liveHasFrame).toBe(false);
    await sleep(1300);
    expect(tries.length).toBeGreaterThanOrEqual(2);
    expect(tries.length).toBeLessThanOrEqual(4);
    for (let i = 1; i < tries.length; i++) expect(tries[i] - tries[i - 1]).toBeGreaterThanOrEqual(490);
    failing = false;
    await vi.waitFor(() => expect(lighting.liveError).toBe(false), { timeout: 2000 });
    const seq = lighting.liveFrame.seq;
    await sleep(500);
    expect(lighting.liveFrame.seq - seq).toBeGreaterThanOrEqual(8);
  });

  it('a write is not starved: its first packet goes out at most 2 packets after it became pending; reading resumes after', async () => {
    const { device, lighting, out } = await demo();
    const sync = useSyncStore();
    lighting.startLivePolling();
    stop = () => lighting.stopLivePolling();
    await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(3));
    let atPending = -1;
    const off = sync.$subscribe(() => { if (sync.state === 'pending' && atPending < 0) atPending = out.length; }, { flush: 'sync' });
    lighting.applyKeyColors([device.keys[10].id], { r: 1, g: 2, b: 3 }, 'test');
    expect(sync.state).toBe('pending');
    await sync.flush();
    off();
    const firstWrite = out.findIndex((p, i) => i >= atPending && isWriteCommand(p.bytes));
    expect(atPending).toBeGreaterThanOrEqual(0);
    expect(firstWrite).toBeGreaterThan(-1);
    expect(firstWrite - atPending).toBeLessThanOrEqual(2);
    const seq = lighting.liveFrame.seq;
    await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThan(seq + 2), { timeout: 3000 });
  });
});

describe('LED60 writes during live preview (the sync debounce, no explicit flush)', () => {
  it('a frame stops at the packet in flight once a write is pending: the write goes out first', async () => {
    const { device, mock, lighting, out } = await demo();
    const sync = useSyncStore();
    lighting.startLivePolling();
    try {
      await vi.waitFor(() => expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(3));
      let atPending = -1;
      const off = sync.$subscribe(() => { if (sync.state === 'pending' && atPending < 0) atPending = out.length; }, { flush: 'sync' });
      // mid-frame: the write is made just after an area-0 read went out, before its reply
      let armed = false;
      let sentAt = -1;
      const offHook = mock.onPacketRaw((dir, b) => {
        if (armed || dir !== 'out' || b[0] !== 0x05 || b[1] !== 0x03 || b[2] !== 0x00) return;
        armed = true;
        queueMicrotask(() => { sentAt = out.length; lighting.applyKeyColors([device.keys[10].id], { r: 9, g: 8, b: 7 }, 'test'); });
      });
      await vi.waitFor(() => expect(sentAt).toBeGreaterThan(-1));
      offHook();
      expect(out[sentAt - 1].bytes.slice(0, 3)).toEqual([0x05, 0x03, 0x00]);
      await vi.waitFor(() => expect(sync.state).toBe('saved'), { timeout: 5000 });
      off();
      const firstWrite = out.findIndex((p, i) => i >= atPending && isWriteCommand(p.bytes));
      expect(firstWrite).toBeGreaterThan(-1);
      expect(firstWrite - atPending).toBeLessThanOrEqual(2);
    } finally {
      lighting.stopLivePolling();
    }
  });
});

describe('LiveLedPainter', () => {
  function board() {
    const root = document.createElement('div');
    const keys = PHYSICAL_KEYS.slice(0, 4);
    root.innerHTML = keys.map((k) => `<button data-key="${k.id}"><span class="cap"><span class="cap__face"></span></span></button>`).join('')
      + Array.from({ length: 38 }, (_, i) => `<button class="led" data-led="${i}"><span class="led__dot"></span></button>`).join('')
      + ['top', 'right', 'bottom', 'left'].map((s) => `<span class="ring__band ring__band--live ring__band--${s}"></span>`).join('');
    document.body.appendChild(root);
    return { root, keys };
  }
  const frame = () => ({ seq: 0, keys: new Uint8Array(126 * 3), strip: new Uint8Array(38 * 3) });
  afterEach(() => { document.body.innerHTML = ''; });

  it('repaints only what changed: an identical frame writes nothing, one LED writes that dot and its side band', () => {
    const { root, keys } = board();
    const painter = new LiveLedPainter(root);
    const f = frame();
    f.keys.fill(100);
    f.strip.fill(50);
    painter.paint(f, keys);
    expect(painter.writes).toBe(keys.length + 38 + 4);
    painter.paint(f, keys);
    expect(painter.writes).toBe(keys.length + 38 + 4);
    const led = stripRing().find((l) => l.side === 'left')!;
    f.strip.set([255, 0, 0], led.index * 3);
    painter.paint(f, keys);
    expect(painter.writes).toBe(keys.length + 38 + 4 + 2); // the dot and the left band
    const left = (root.querySelector('.ring__band--left') as HTMLElement).style.getPropertyValue('--band');
    expect(left).toContain('#ff0000');
    expect((root.querySelector('.ring__band--top') as HTMLElement).style.getPropertyValue('--band')).not.toContain('#ff0000');
    painter.clear();
    expect(root.querySelectorAll(`.${LIVE_FACE_CLASS}`)).toHaveLength(0);
    for (const el of root.querySelectorAll('[style]')) expect(el.getAttribute('style')).toBe('');
  });

  it('after invalidate() a key whose state changed (selected, flashing) is repainted with that state, the others are not', () => {
    const { root, keys } = board();
    const painter = new LiveLedPainter(root);
    const f = frame();
    for (const k of keys) f.keys.set([255, 0, 0], (k.row * LED_MATRIX_COLS + k.col) * 3);
    painter.paint(f, keys);
    const cap = root.querySelector(`[data-key="${keys[1].id}"] .cap`)!;
    const el = cap.querySelector('.cap__face') as HTMLElement;
    const want = (st: Partial<FaceState>) => asStored(faceStyle({ led: '#ff0000', level: 1 }, { hover: false, selected: false, focus: false, flash: false, ...st }));
    const shown = () => ({ background: el.style.getPropertyValue('background'), borderColor: el.style.getPropertyValue('border-color'), boxShadow: el.style.getPropertyValue('box-shadow') });
    expect(shown()).toEqual(want({}));
    const before = painter.writes;
    cap.classList.add('cap--sel');
    painter.paint(f, keys); // the state is looked up again only when the page says it may have changed
    expect(painter.writes).toBe(before);
    painter.invalidate();
    painter.paint(f, keys);
    expect(painter.writes).toBe(before + 1);
    expect(shown()).toEqual(want({ selected: true }));
    cap.classList.add('cap--flash');
    painter.invalidate();
    painter.paint(f, keys);
    expect(shown()).toEqual(want({ selected: true, flash: true }));
    cap.classList.remove('cap--sel', 'cap--flash');
    painter.invalidate();
    painter.paint(f, keys);
    expect(shown()).toEqual(want({}));
    expect(painter.writes).toBe(before + 3);
  });

  it('a lit key that goes off loses its live class and every inline value', () => {
    const { root, keys } = board();
    const painter = new LiveLedPainter(root);
    const f = frame();
    for (const k of keys) f.keys.set([0, 200, 100], (k.row * LED_MATRIX_COLS + k.col) * 3);
    painter.paint(f, keys);
    const el = root.querySelector(`[data-key="${keys[2].id}"] .cap__face`) as HTMLElement;
    expect(el.classList.contains(LIVE_FACE_CLASS)).toBe(true);
    expect(el.getAttribute('style')).not.toBe('');
    f.keys.set([3, 3, 3], (keys[2].row * LED_MATRIX_COLS + keys[2].col) * 3); // under 8/255: off
    painter.paint(f, keys);
    expect(el.classList.contains(LIVE_FACE_CLASS)).toBe(false);
    expect(el.getAttribute('style') ?? '').toBe('');
  });

  it('a re-rendered element is painted again even when its colour did not change', () => {
    const { root, keys } = board();
    const painter = new LiveLedPainter(root);
    const f = frame();
    f.keys.fill(200);
    painter.paint(f, keys);
    const btn = root.querySelector(`[data-key="${keys[0].id}"]`)!;
    btn.innerHTML = '<span class="cap"><span class="cap__face"></span></span>'; // Vue replaced the keycap
    painter.paint(f, keys);
    const face = btn.querySelector('.cap__face') as HTMLElement;
    expect(face.classList.contains(LIVE_FACE_CLASS)).toBe(true);
    expect(ledOf(face)).toBe('#ffffff');
  });
});

describe('readLedMatrix with pages', () => {
  it('without pages: 126 and 38 records as before; with pages: the full length, only those packets filled', async () => {
    const mock = new MockTransport({ latencyMs: 0 });
    await mock.getDeviceInfo();
    const all0 = await mock.readLedMatrix(0);
    const all1 = await mock.readLedMatrix(1);
    expect(all0).toHaveLength(126);
    expect(all1).toHaveLength(38);
    expect(all0.every((r) => r && typeof r.r === 'number')).toBe(true);
    const sent: number[][] = [];
    mock.onPacketRaw((dir, b) => { if (dir === 'out') sent.push(Array.from(b.slice(0, 4))); });
    const part = await mock.readLedMatrix(0, [2, 5]);
    expect(sent).toEqual([[0x05, 0x03, 0, 2], [0x05, 0x03, 0, 5]]);
    expect(part).toHaveLength(126);
    for (let i = 0; i < 126; i++) {
      const p = Math.floor(i / 15);
      if (p === 2 || p === 5) expect(part[i], `cell ${i}`).toBeTruthy();
      else expect(part[i], `cell ${i}`).toBeUndefined();
    }
    const strip = await mock.readLedMatrix(1, [2]);
    expect(strip).toHaveLength(38);
    expect(strip.filter(Boolean)).toHaveLength(8); // LEDs 30..37
  });
});

describe('ledGlowRgb', () => {
  it('gives what ledGlow gives for the same colour, off under 8/255 included', () => {
    const table: [number, number, number][] = [[0, 0, 0], [7, 7, 7], [8, 0, 0], [0, 7, 8], [64, 0, 0], [255, 255, 255], [255, 128, 0], [16, 32, 48], [1, 254, 3], [200, 100, 50]];
    const hex = (c: number[]) => `#${c.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    for (const c of table) expect(ledGlowRgb(...c), hex(c)).toEqual(ledGlow(hex(c)));
    expect(ledGlowRgb(LED_OFF_BELOW - 1, 0, 0)).toBeUndefined();
    expect(ledGlowRgb(LED_OFF_BELOW, 0, 0)).toBeDefined();
  });
});

describe('fast demo replies', () => {
  it('the browser demo answers LED reads on a MessageChannel task, everything else as before', async () => {
    const mock = new MockTransport({ latencyMs: 50, fastLedReplies: true });
    await mock.getDeviceInfo();
    const t0 = performance.now();
    for (let p = 0; p < 9; p++) await mock.readLedMatrix(0, [p]);
    expect(performance.now() - t0).toBeLessThan(150); // 9 × 50 ms through the timer
    const t1 = performance.now();
    await mock.getLightingBase(0);
    expect(performance.now() - t1).toBeGreaterThanOrEqual(40);
    await mock.close();
  });
});

describe('LED60 painter on the Lighting page', () => {
  let page: VueWrapper | null = null;
  let keycapUpdates = 0;
  beforeEach(() => {
    setLocale('vi');
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      unobserve() {}
      disconnect() {}
    });
  });
  afterEach(async () => {
    page?.unmount();
    page = null;
    await flushPromises();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountPage() {
    const { device, lighting } = await demo();
    keycapUpdates = 0;
    page = mount(LightingPage, {
      attachTo: document.body,
      global: { mixins: [{ updated(this: { $options: { __name?: string } }) { if (this.$options.__name === 'Keycap') keycapUpdates++; } }] },
    });
    await flushPromises();
    lighting.stopLivePolling(); // frames are pushed by hand below
    await sleep(60);
    await flushPromises();
    return { device, lighting };
  }
  /** A frame as the store publishes it: every key and LED from fns of the key / LED index. */
  async function push(lighting: ReturnType<typeof useLightingStore>, key: (id: number) => number[], led: (i: number) => number[]) {
    const f = lighting.liveFrame;
    for (const k of useDeviceStore().keys) f.keys.set(key(k.id), (k.row * LED_MATRIX_COLS + k.col) * 3);
    for (let i = 0; i < 38; i++) f.strip.set(led(i), i * 3);
    f.seq++;
    lighting.liveError = false;
    lighting.liveHasFrame = true;
    await flushPromises();
    await nextPaint();
    await nextPaint();
  }
  const face = (id: number) => page!.find(`[data-key="${id}"] .cap__face`).element as HTMLElement;
  const dot = (i: number) => page!.find(`[data-led="${i}"] .led__dot`).element as HTMLElement;
  const liveFaces = () => page!.findAll(`.${LIVE_FACE_CLASS}`);
  function watchWrites(): { targets: Set<Element>; records: () => number; stop: () => void } {
    const targets = new Set<Element>();
    let n = 0;
    const mo = new MutationObserver((list) => { for (const r of list) { n++; targets.add(r.target as Element); } });
    mo.observe(page!.element.ownerDocument.body, { attributes: true, subtree: true, attributeFilter: ['style', 'class'] });
    return { targets, records: () => { for (const r of mo.takeRecords()) { n++; targets.add(r.target as Element); } return n; }, stop: () => mo.disconnect() };
  }

  it('paints keys, dots and bands from the frame; an identical frame writes nothing; one changed key writes one key', async () => {
    const { device, lighting } = await mountPage();
    await push(lighting, () => [64, 0, 0], () => [0, 255, 0]);
    expect(liveFaces().length).toBe(device.keys.length);
    expect(ledOf(face(device.keys[0].id))).toBe('#ff0000');
    expect(face(device.keys[0].id).style.getPropertyValue('background')).toBe(faceStyle({ led: '#ff0000', level: 0.251 }, { hover: false, selected: false, focus: false, flash: false }).background);
    expect(page!.findAll('.cap--glow')).toHaveLength(0); // Vue draws the keys unlit; the faces carry the live glow
    expect(dot(3).style.getPropertyValue('--led-color')).toBe(liveDotColor(0, 255, 0, ledGlowRgb(0, 255, 0)));
    const bands = page!.findAll('.ring__band--live');
    expect(bands).toHaveLength(4);
    for (const b of bands) expect((b.element as HTMLElement).style.getPropertyValue('--band')).toContain('#00ff00');

    const w = watchWrites();
    await push(lighting, () => [64, 0, 0], () => [0, 255, 0]);
    expect(w.records()).toBe(0);
    const target = device.keys[12].id;
    await push(lighting, (id) => (id === target ? [0, 0, 255] : [64, 0, 0]), () => [0, 255, 0]);
    w.records();
    w.stop();
    expect([...w.targets]).toEqual([face(target)]);
    expect(ledOf(face(target))).toBe('#0000ff');
  });

  it('an LED that is off: the key is not lit, the dot keeps its raw colour, a dark side has no band', async () => {
    const { device, lighting } = await mountPage();
    const target = device.keys[5].id;
    await push(lighting, (id) => (id === target ? [7, 7, 7] : [255, 255, 255]), (i) => (i === 2 ? [16, 0, 0] : [0, 0, 0]));
    expect(face(target).classList.contains(LIVE_FACE_CLASS)).toBe(false);
    expect(ledOf(face(target))).toBe('');
    expect(dot(2).style.getPropertyValue('--led-color')).toBe('color-mix(in srgb, #ff0000 35%, transparent)');
    expect(dot(4).style.getPropertyValue('--led-color')).toBe('#000000');
    const lit = page!.findAll('.ring__band--live').filter((b) => (b.element as HTMLElement).style.getPropertyValue('--band') !== 'none');
    expect(lit).toHaveLength(1);
  });

  it('a key state change repaints it on the next display frame without a new frame: selected, flashing, hover, focus', async () => {
    const { device, lighting } = await mountPage();
    await push(lighting, () => [255, 0, 0], () => [0, 0, 0]);
    const id = device.keys[3].id;
    const seq = lighting.liveFrame.seq;
    const want = (st: Partial<FaceState>) => asStored(faceStyle({ led: '#ff0000', level: 1 }, { hover: false, selected: false, focus: false, flash: false, ...st }));
    const shown = () => ({ background: face(id).style.getPropertyValue('background'), borderColor: face(id).style.getPropertyValue('border-color'), boxShadow: face(id).style.getPropertyValue('box-shadow') });
    const settle = async () => { await flushPromises(); await nextPaint(); await nextPaint(); };
    expect(shown()).toEqual(want({}));
    useSelectionStore().selectMany([id]);
    await settle();
    expect(shown()).toEqual(want({ selected: true }));
    useFlashStore().flash([id], 5000);
    await settle();
    expect(shown()).toEqual(want({ selected: true, flash: true }));
    useSelectionStore().clear();
    await settle();
    expect(shown()).toEqual(want({ flash: true }));
    // jsdom has no pointer or focus-visible state: the key says it has one, the page hears the event
    const cap = face(id).parentElement!;
    const btn = cap.parentElement!;
    const real = Element.prototype.matches;
    Object.assign(cap, { matches: (q: string) => q === ':hover' || real.call(cap, q) });
    face(id).dispatchEvent(new Event('pointerover', { bubbles: true }));
    await settle();
    expect(shown()).toEqual(want({ flash: true, hover: true }));
    Object.assign(btn, { matches: (q: string) => q === ':focus-visible' || real.call(btn, q) });
    btn.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    await settle();
    expect(shown()).toEqual(want({ flash: true, hover: true, focus: true }));
    delete (cap as unknown as Record<string, unknown>).matches;
    delete (btn as unknown as Record<string, unknown>).matches;
    face(id).dispatchEvent(new Event('pointerout', { bubbles: true }));
    btn.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    await settle();
    expect(shown()).toEqual(want({ flash: true }));
    expect(lighting.liveFrame.seq).toBe(seq); // no frame came in between
  });

  it('60 frames: no keycap is updated through Vue', async () => {
    const { lighting } = await mountPage();
    await push(lighting, () => [10, 20, 30], () => [30, 20, 10]);
    keycapUpdates = 0;
    for (let i = 0; i < 60; i++) await push(lighting, (id) => [(id * 7 + i * 13) % 256, i * 4, 200], (n) => [i * 4, n, 100]);
    expect(lighting.liveFrame.seq).toBeGreaterThanOrEqual(61);
    expect(keycapUpdates).toBe(0);
  });

  it('live preview off: nothing hand-written is left, the colours from the settings show', async () => {
    const { lighting } = await mountPage();
    await push(lighting, () => [255, 0, 0], () => [0, 255, 0]);
    expect(liveFaces().length).toBeGreaterThan(0);
    lighting.livePreview = false;
    await flushPromises();
    await nextPaint();
    expect(liveFaces()).toHaveLength(0);
    for (const el of page!.findAll('.cap__face')) expect((el.element as HTMLElement).getAttribute('style') ?? '').toBe('');
    for (const el of page!.findAll('.led__dot')) expect((el.element as HTMLElement).style.getPropertyValue('--led-color')).toBe('');
    expect(page!.findAll('.ring__band--live')).toHaveLength(0);
    expect(page!.findAll('.cap--glow').length).toBeGreaterThan(0); // the demo's settings light the keys (rainbow)
  });

  for (const why of ['a read error', 'the tab hidden', 'another profile loading'] as const) {
    it(`${why}: nothing hand-written is left`, async () => {
      const { lighting } = await mountPage();
      await push(lighting, () => [255, 0, 0], () => [0, 255, 0]);
      expect(liveFaces().length).toBeGreaterThan(0);
      if (why === 'a read error') lighting.liveError = true;
      else if (why === 'the tab hidden') {
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      } else lighting.loadedProfile = null;
      await flushPromises();
      await nextPaint();
      expect(liveFaces()).toHaveLength(0);
      for (const el of page!.findAll('.led__dot')) expect((el.element as HTMLElement).style.getPropertyValue('--led-color')).toBe('');
      if (why === 'the tab hidden') delete (document as unknown as Record<string, unknown>).hidden;
    });
  }

  it('Vue updates do not wipe the live colours: selection, tab switch, a key turning custom; off still clears them', async () => {
    const { device, lighting } = await mountPage();
    await push(lighting, () => [0, 128, 255], () => [255, 0, 0]);
    const id = device.keys[20].id;
    const check = () => {
      expect(liveFaces().length).toBe(device.keys.length);
      expect(ledOf(face(id))).toBe('#0080ff');
      expect(dot(7).style.getPropertyValue('--led-color')).toBe(liveDotColor(255, 0, 0, ledGlowRgb(255, 0, 0)));
    };
    useSelectionStore().selectMany([id, device.keys[21].id]);
    await flushPromises();
    check();
    await page!.find('[data-id="strip"]').trigger('click');
    await flushPromises();
    await page!.find('.led[data-led="7"]').trigger('click'); // select a ring LED (class binding on its button)
    await flushPromises();
    check();
    await page!.find('[data-id="keys"]').trigger('click');
    await flushPromises();
    check();
    // a key gets its own colour: its Keycap re-renders (badge, class, style binding)
    const cell = PHYSICAL_KEYS[id].row * LED_MATRIX_COLS + PHYSICAL_KEYS[id].col;
    lighting.area0Matrix = lighting.area0Matrix.map((r, i) => (i === cell ? { ...r, custom: true } : r));
    await flushPromises();
    expect(page!.find(`[data-key="${id}"] .cap__badge`).exists()).toBe(true);
    check();
    lighting.area0Matrix = lighting.area0Matrix.map((r, i) => (i === cell ? { ...r, custom: false } : r));
    await flushPromises();
    check();
    lighting.livePreview = false;
    await flushPromises();
    expect(liveFaces()).toHaveLength(0);
    for (const el of page!.findAll('.cap__face')) expect((el.element as HTMLElement).getAttribute('style') ?? '').toBe('');
  });
});
