import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { setLocale } from '../src/i18n/locale';
import { MockTransport } from '../src/protocol';
import type { LightingBase } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useLightingStore } from '../src/stores/lighting';
import LightingPage from '../src/pages/LightingPage.vue';

async function make(seed: 'max' | 'pro' = 'max'): Promise<MockTransport> {
  const mock = new MockTransport({ latencyMs: 0, seed });
  await mock.getDeviceInfo(); // also tells the client the board may be written
  return mock;
}

const base = (o: Partial<LightingBase> = {}): LightingBase => ({
  area: 0, open: true, openMode: 3, mode: 0, brightness: 80, speed: 50, direction: 0, paletteIndex: 0, ...o,
});

/** One frame as the lighting store reads it (05 03, all packets), without the transport's timer latency. */
async function frame(mock: MockTransport, area: number, ms: number): Promise<number[]> {
  vi.setSystemTime(ms);
  const m = mock as any;
  const out: number[] = [];
  const n = area === 0 ? 126 : 38;
  for (let p = 0; p * 15 < n; p++) out.push(...m.ledPacket(m.profiles[m.active], area, p));
  const px: number[] = [];
  for (let i = 0; i < n; i++) px.push(out[i * 4], out[i * 4 + 1], out[i * 4 + 2]);
  return px;
}

/** Frames of the base's area at the given times (ms, absolute: Date.now() is mocked). */
async function frames(mock: MockTransport, b: LightingBase, times: number[]): Promise<number[][]> {
  await mock.setLightingBase(b);
  const out: number[][] = [];
  for (const ms of times) out.push(await frame(mock, b.area, ms));
  return out;
}

const differs = (a: number[], b: number[]) => a.some((v, i) => v !== b[i]);
const GHOST_TIMES = Array.from({ length: 12 }, (_, i) => 500 + i * 370);
// 3 s on: the colour step of mode 19 happens at the first breath trough, 3.4 s at the default speed.
const SEQ_TIMES = Array.from({ length: 21 }, (_, i) => 3000 + i * 100);

describe('demo LED stand-in patterns', () => {
  afterEach(() => { vi.useRealTimers(); });
  // Only Date is mocked: the mock transport's own latency timers keep running.
  const fake = () => vi.useFakeTimers({ toFake: ['Date'] });

  it('modes 1–7 change over 0.5 s, mode 0 does not; reactive modes change with ghost presses', async () => {
    fake();
    const mock = await make();
    for (let mode = 0; mode <= 7; mode++) {
      const [a, b] = await frames(mock, base({ mode }), [10_000, 10_500]);
      expect(differs(a, b), `mode ${mode}`).toBe(mode !== 0);
    }
    for (const mode of [6, 7]) {
      const seq = await frames(mock, base({ mode }), GHOST_TIMES);
      expect(seq.some((f, i) => i > 0 && differs(f, seq[i - 1])), `mode ${mode}`).toBe(true);
      expect(seq.some((f) => f.some((v) => v > 0)), `mode ${mode} lit`).toBe(true);
    }
  });

  it('modes 0–19 give 20 pairwise different sequences over 2 s (rainbow source)', async () => {
    fake();
    const mock = await make();
    const seqs: string[] = [];
    for (let mode = 0; mode < 20; mode++) seqs.push(JSON.stringify(await frames(mock, base({ mode, brightness: 100 }), SEQ_TIMES)));
    const dup = seqs.map((q, i) => seqs.findIndex((o) => o === q) === i ? -1 : [seqs.indexOf(q), i]).filter((v) => v !== -1);
    expect(dup).toEqual([]);
  });

  it('brightness 0 and open 0 give all zeros', async () => {
    fake();
    const mock = await make();
    for (const area of [0, 1]) {
      for (const mode of [0, 2, 6]) {
        for (const b of [base({ area, mode, brightness: 0 }), base({ area, mode, open: false, openMode: 0 })]) {
          const seq = await frames(mock, b, SEQ_TIMES);
          expect(seq.every((f) => f.every((v) => v === 0))).toBe(true);
        }
      }
    }
  });

  /** Milliseconds until the wave (palette colour, so the level is one scalar per LED) repeats its frame at t0. */
  async function wavePeriod(mock: MockTransport, speed: number): Promise<number> {
    await mock.setLightingBase(base({ mode: 2, speed, brightness: 100, paletteIndex: 1 }));
    const first = await frame(mock, 0, 100_000);
    let away = false;
    for (let ms = 20; ms < 8000; ms += 20) {
      const f = await frame(mock, 0, 100_000 + ms);
      const same = f.every((v, i) => Math.abs(v - first[i]) <= 6);
      if (!same) away = true;
      else if (away) return ms;
    }
    return Infinity;
  }

  it('speed 100 vs 0 changes the wave period about 7.5×; direction mirrors the wave', async () => {
    fake();
    const mock = await make();
    const slow = await wavePeriod(mock, 0);
    const fast = await wavePeriod(mock, 100);
    expect(slow / fast).toBeGreaterThan(6.5);
    expect(slow / fast).toBeLessThan(8.5);

    // φ = now / T, hue/level go as x − dir·φ: direction 1 at +t shows what direction 0 shows at −t.
    const dir1 = await frames(mock, base({ mode: 2, direction: 1, brightness: 100, paletteIndex: 1 }), [20_000]);
    const dir0 = await frames(mock, base({ mode: 2, direction: 0, brightness: 100, paletteIndex: 1 }), [-20_000]);
    dir1[0].forEach((v, i) => expect(Math.abs(v - dir0[0][i])).toBeLessThanOrEqual(1));
    const dir0Now = await frames(mock, base({ mode: 2, direction: 0, brightness: 100, paletteIndex: 1 }), [20_000]);
    expect(differs(dir1[0], dir0Now[0])).toBe(true);
  });

  it('with a palette colour every non-custom LED is a 0…1 multiple of it', async () => {
    fake();
    const mock = await make();
    const palette = await mock.getPalette(0);
    for (let idx = 1; idx <= 7; idx++) {
      const want = [palette[idx].b, palette[idx].g, palette[idx].r];
      const top = Math.max(...want);
      for (const mode of [0, 1, 2, 3, 4, 5, 6, 7, 15, 19]) {
        const seq = await frames(mock, base({ mode, paletteIndex: idx, brightness: 100 }), GHOST_TIMES);
        for (const f of seq) {
          for (let i = 0; i < f.length; i += 3) {
            const px = f.slice(i, i + 3);
            const s = top === 0 ? 0 : Math.max(...px) / top;
            expect(s).toBeLessThanOrEqual(1);
            px.forEach((v, n) => expect(Math.abs(v - want[n] * s)).toBeLessThanOrEqual(1));
          }
        }
      }
    }
  });

  it('custom LEDs stay unchanged in every mode; the Pro seed mode 19 works', async () => {
    fake();
    for (const seed of ['max', 'pro'] as const) {
      const mock = await make(seed);
      const leds = await mock.readLedMatrix(0);
      leds[22] = { r: 1, g: 2, b: 3, custom: true };
      leds[40] = { r: 250, g: 9, b: 77, custom: true };
      await mock.writeLedMatrix(0, leds);
      for (let mode = 0; mode < (seed === 'pro' ? 20 : 19); mode++) {
        for (const f of await frames(mock, base({ mode }), GHOST_TIMES.slice(0, 4))) {
          expect(f.slice(22 * 3, 22 * 3 + 3)).toEqual([3, 2, 1]);
          expect(f.slice(40 * 3, 40 * 3 + 3)).toEqual([77, 9, 250]);
        }
      }
      const [a, b] = await frames(mock, base({ mode: 19 }), [1000, 1500]);
      expect(differs(a, b)).toBe(true);
    }
  });

  it('the strip: reactive mode lights the whole strip on a ghost press', async () => {
    fake();
    const mock = await make();
    const times = Array.from({ length: 30 }, (_, i) => 500 + i * 100);
    const seq = await frames(mock, base({ area: 1, mode: 4, brightness: 100, paletteIndex: 1 }), times);
    const lit = seq.filter((f) => f.some((v) => v > 0));
    expect(lit.length).toBeGreaterThan(0);
    for (const f of lit) {
      const px = new Set<string>();
      for (let i = 0; i < f.length; i += 3) px.add(f.slice(i, i + 3).join());
      expect(px.size).toBe(1);
    }
  });
});

describe('Lighting page labels', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); setLocale('en'); });

  async function mountPage(demo: boolean) {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectDemo();
    (device.transport as any).latencyMs = 0;
    if (!demo) device.demo = false; // what a real (non-mock) connection reports
    await useLightingStore().load();
    const page = mount(LightingPage, { global: { plugins: [getActivePinia()!], stubs: { teleport: true } } });
    await flushPromises();
    return page;
  }

  it('demo: the chip reads "Mô phỏng" and the note shows', async () => {
    setLocale('vi');
    const page = await mountPage(true);
    expect(page.find('.lighting-live-badge').text()).toBe('Mô phỏng');
    expect(page.text()).toContain('Demo: khung xem trước chỉ mô phỏng');
    setLocale('en');
    await flushPromises();
    expect(page.find('.lighting-live-badge').text()).toBe('Simulated');
    expect(page.text()).toContain('Demo: the preview only simulates motion');
    page.unmount();
  });

  it('not demo: neither the simulated chip nor the note show', async () => {
    setLocale('vi');
    const page = await mountPage(false);
    expect(page.find('.lighting-live-badge').text()).toBe('Trực tiếp');
    expect(page.text()).not.toContain('Demo: khung xem trước');
    page.unmount();
  });
});
