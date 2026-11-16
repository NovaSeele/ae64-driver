// FXP: the effect buttons' three views (Tắt / Sơ lược / Chi tiết), the Chi tiết mini keyboards' loop, and "Xem thử", the
// preview of an effect on the big keyboard (DESIGN FXP §3, §4, §7, §8, §11). All of it is display only: these tests count
// the packets and the store writes as well as what shows.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import { MockTransport } from '../src/protocol';
import { isWriteCommand } from '../src/protocol/safety';
import { setLocale } from '../src/i18n/locale';
import { useDeviceStore } from '../src/stores/device';
import { useLightingStore } from '../src/stores/lighting';
import { useSyncStore } from '../src/stores/sync';
import { LiveLedPainter } from '../src/components/keyboard/liveLedPainter';
import { TileDriver } from '../src/components/lighting/tileDriver';
import { FX_VIEW_KEY } from '../src/components/lighting/fxView';
import { PreviewControl, REST_MS, SWITCH_MS } from '../src/components/lighting/previewControl';
import { parseImport, storedSettings } from '../src/data/appSettings';
import LightingPage from '../src/pages/LightingPage.vue';

vi.setConfig({ testTimeout: 30000 });

let page: VueWrapper | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface MountOpts { model?: 'max' | 'pro'; keepLive?: boolean; reduced?: boolean; observer?: boolean }
let ioCallbacks: ((e: { isIntersecting: boolean }[]) => void)[] = [];

async function mountPage(o: MountOpts = {}) {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 400 } }]); }
    disconnect() {}
  });
  if (o.observer) {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(cb: (e: { isIntersecting: boolean }[]) => void) { ioCallbacks.push(cb); }
      observe() {}
      disconnect() {}
    });
  }
  if (o.reduced) {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {},
    }));
  }
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(o.model ?? 'max');
  const mock = device.transport as MockTransport;
  (mock as unknown as { latencyMs: number }).latencyMs = 0;
  if (o.keepLive) (mock as unknown as { fastLedReplies: boolean }).fastLedReplies = true;
  const lighting = useLightingStore();
  await lighting.load();
  const gate = vi.spyOn(TileDriver.prototype, 'setGate');
  page = mount(LightingPage, { attachTo: document.body });
  await flushPromises();
  if (!o.keepLive) {
    lighting.stopLivePolling(); // the poll reads the LED matrix on its own; only the page's own parts are under test
    await sleep(250);
    await flushPromises();
  }
  const driver = gate.mock.contexts[0] as TileDriver;
  const out: number[][] = [];
  mock.onPacketRaw((dir, bytes) => { if (dir === 'out') out.push(Array.from(bytes)); });
  return { device, mock, lighting, sync: useSyncStore(), driver, out };
}

beforeEach(() => {
  setLocale('vi');
  localStorage.removeItem(FX_VIEW_KEY);
  ioCallbacks = [];
});
afterEach(async () => {
  vi.useRealTimers();
  page?.unmount();
  page = null;
  await flushPromises();
  document.body.innerHTML = '';
  localStorage.removeItem(FX_VIEW_KEY);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const grid = () => page!.find('.fx__grid');
const tiles = () => page!.findAll('.effect-btn');
const tile = (n: number) => page!.find(`.effect-btn[data-n="${n}"]`);
const viewOpt = (v: 'off' | 'lite' | 'detail') => page!.find(`[data-testid="fx-view"] [data-v="${v}"]`);
const chip = () => page!.find('[data-testid="live-chip"]').text();
const cue = () => { const c = page!.find('[data-testid="preview-cue"]'); return c.exists() ? c.text() : null; };
const tryTiles = () => tiles().filter((b) => b.classes('effect-btn--try')).map((b) => Number(b.attributes('data-n')));

/** A pointer moving onto tile n (or onto `inner`, an element inside it). jsdom has no PointerEvent: a MouseEvent with the field. */
function over(n: number, pointerType = 'mouse', inner?: string) {
  const host = tile(n).element;
  const el = inner ? host.querySelector(inner)! : host;
  const ev = new MouseEvent('pointerover', { bubbles: true });
  Object.defineProperty(ev, 'pointerType', { value: pointerType });
  el.dispatchEvent(ev);
}
const leaveGrid = () => grid().element.dispatchEvent(new MouseEvent('pointerleave'));
const esc = () => {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  (document.activeElement ?? document.body).dispatchEvent(ev); // as a real key press: at the focused element, bubbling to window
  return ev;
};
const fakeTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
async function advance(ms: number) {
  vi.advanceTimersByTime(ms);
  await nextTick();
  await nextTick();
}
const writes = (out: number[][]) => out.filter((b) => isWriteCommand(b));
/** Tiles 2… that are known and not the chosen effect. */
const pick = (chosen: number, ns: number[]) => ns.filter((n) => n !== chosen);
/** Face colour layers the painter has written a colour to. */
const paintedFaces = () => [...document.querySelectorAll<HTMLElement>('.cap__ledc')].filter((e) => e.style.getPropertyValue('background-color'));

describe('FXP: the view toggle', () => {
  it('defaults to Sơ lược: icon, number and name on each button', async () => {
    await mountPage();
    expect(viewOpt('lite').attributes('aria-checked')).toBe('true');
    expect(grid().classes()).toContain('fx__grid--lite');
    expect(tile(3).find('.effect-btn__icon').exists()).toBe(true);
    expect(tile(3).find('.effect-btn__n').text()).toBe('3');
    expect(tile(3).find('.effect-btn__name').text()).toBe('Sóng dọc');
  });

  it('reads and writes localStorage; a bad stored value counts as Sơ lược; no packet is sent', async () => {
    localStorage.setItem(FX_VIEW_KEY, 'detail');
    const { out } = await mountPage();
    expect(grid().classes()).toContain('fx__grid--detail');
    expect(tiles().every((b) => b.find('canvas').exists())).toBe(true);

    await viewOpt('off').trigger('click');
    await nextTick();
    expect(localStorage.getItem(FX_VIEW_KEY)).toBe('off');
    expect(grid().classes()).toContain('fx__grid--off');
    expect(tile(3).text()).toBe('3');
    expect(tile(3).find('canvas').exists()).toBe(false);
    expect(tile(3).find('.effect-btn__icon').exists()).toBe(false);

    await viewOpt('lite').trigger('click');
    await nextTick();
    expect(localStorage.getItem(FX_VIEW_KEY)).toBe('lite');
    expect(out).toHaveLength(0);

    page!.unmount();
    page = null;
    localStorage.setItem(FX_VIEW_KEY, 'bogus');
    await mountPage();
    expect(grid().classes()).toContain('fx__grid--lite');
  });
});

describe('FXP: the view in the settings file', () => {
  it('is exported and imported with the other display choices; a bad value refuses the file', () => {
    localStorage.setItem(FX_VIEW_KEY, 'detail');
    expect(storedSettings()[FX_VIEW_KEY]).toBe('detail');
    const file = (v: string) => JSON.stringify({ app: 'ae64-control', version: '1', savedAt: '', data: { [FX_VIEW_KEY]: v } });
    expect(parseImport(file('off'), 10).ok).toBe(true);
    expect(parseImport(file('bogus'), 10)).toMatchObject({ ok: false, error: 'errValue' });
  });
});

describe('FXP: the effect buttons', () => {
  it('Max 19, Pro 20, strip 5, with today\'s labels and aria-pressed; icons and canvases are hidden from screen readers', async () => {
    localStorage.setItem(FX_VIEW_KEY, 'lite');
    const { lighting } = await mountPage();
    expect(tiles()).toHaveLength(19);
    expect(tile(5).attributes('aria-label')).toBe('Hiệu ứng 5 · Xoáy');
    expect(tiles().filter((b) => b.attributes('aria-pressed') === 'true').map((b) => Number(b.attributes('data-n')))).toEqual([lighting.area0Base.mode + 1]);
    expect(page!.findAll('.effect-btn__icon').every((s) => s.attributes('aria-hidden') === 'true')).toBe(true);
    await viewOpt('detail').trigger('click');
    await nextTick();
    const canvases = page!.findAll('canvas.effect-btn__cv');
    expect(canvases).toHaveLength(19); // one per tile
    expect(canvases.map((c) => c.attributes('data-mode'))).toEqual(Array.from({ length: 19 }, (_, i) => String(i)));
    expect(canvases.every((c) => c.attributes('aria-hidden') === 'true')).toBe(true);
    await page!.find('[role="tab"][data-id="strip"]').trigger('click');
    await flushPromises();
    expect(tiles()).toHaveLength(5);
    expect(page!.findAll('canvas.effect-btn__cv')).toHaveLength(5);
  });

  it('unknown effects show "?", "Chưa rõ" and say why in the title; Pro\'s 20 too', async () => {
    await mountPage();
    for (const n of [6, 7, 9]) {
      expect(tile(n).classes()).toContain('effect-btn--unknown');
      expect(tile(n).find('.effect-btn__name').text()).toBe('Chưa rõ');
      expect(tile(n).attributes('title')).toBe(`Hiệu ứng ${n} — Chưa có hình xem trước: chưa rõ hiệu ứng này trông thế nào trên phím thật.`);
    }
    await viewOpt('detail').trigger('click');
    await nextTick();
    expect(tile(6).find('.effect-btn__q').text()).toBe('?');
    expect(tile(5).find('.effect-btn__q').exists()).toBe(false);
    page!.unmount();
    page = null;
    await mountPage({ model: 'pro' });
    expect(tiles()).toHaveLength(20);
    expect(tile(20).find('.effect-btn__q').text()).toBe('?');
  });

  it('the chosen effect has every cue: aria-pressed, the active class and the ✓, in both pictured views', async () => {
    const { lighting } = await mountPage();
    const chosen = lighting.area0Base.mode + 1;
    for (const v of ['lite', 'detail'] as const) {
      await viewOpt(v).trigger('click');
      await nextTick();
      expect(tile(chosen).attributes('aria-pressed')).toBe('true');
      expect(tile(chosen).classes()).toContain('effect-btn--active');
      const checks = page!.findAll('[data-testid="fx-check"]');
      expect(checks).toHaveLength(1);
      expect(tile(chosen).find('[data-testid="fx-check"]').exists()).toBe(true);
      expect(checks[0].attributes('aria-hidden')).toBe('true');
    }
  });

  it('titles keep " — ": the name, then the hint', async () => {
    await mountPage();
    expect(tile(18).attributes('title')).toBe('Hiệu ứng 18 · Phản hồi lan — Sáng khi bạn gõ phím');
    expect(tile(16).attributes('aria-label')).toBe('Hiệu ứng 16 · Đốm nảy');
    expect(tile(19).find('.effect-btn__name').text()).toBe('Phản hồi hàng');
    setLocale('en');
    await nextTick();
    expect(tile(18).attributes('title')).toBe('Effect 18 · Reactive spread — Lights up as you type');
    expect(tile(6).attributes('title')).toBe("Effect 6 — No preview yet: we don't know how this effect looks on a real keyboard.");
  });
});

describe('FXP: the Chi tiết loop', () => {
  it('runs only in Chi tiết, on screen, with the area on; stops on unmount', async () => {
    const { driver, lighting, sync } = await mountPage({ observer: true });
    expect(driver.running).toBe(false); // Sơ lược draws nothing
    await viewOpt('detail').trigger('click');
    await nextTick();
    expect(driver.running).toBe(true);
    const f0 = driver.loopFrames;
    await sleep(200);
    expect(driver.loopFrames).toBeGreaterThan(f0);

    // off screen: no loop and no drawing
    for (const cb of ioCallbacks) cb([{ isIntersecting: false }]);
    await nextTick();
    expect(driver.running).toBe(false);
    const d0 = driver.draws;
    await sleep(150);
    expect(driver.draws).toBe(d0);
    for (const cb of ioCallbacks) cb([{ isIntersecting: true }]);
    await nextTick();
    expect(driver.running).toBe(true);

    // the area off: unlit stills, no loop
    lighting.applyBase(0, { open: false }, 'x');
    await sync.flush();
    await nextTick();
    expect(driver.running).toBe(false);
    lighting.applyBase(0, { open: true }, 'x');
    await sync.flush();
    await nextTick();
    expect(driver.running).toBe(true);

    page!.unmount();
    page = null;
    expect(driver.running).toBe(false);
  });

  it('reduced motion: one still per tile, never a loop', async () => {
    localStorage.setItem(FX_VIEW_KEY, 'detail');
    const { driver } = await mountPage({ reduced: true });
    expect(driver.running).toBe(false);
    expect(driver.draws).toBeGreaterThanOrEqual(19);
    const d0 = driver.draws;
    await sleep(200);
    expect(driver.loopFrames).toBe(0);
    expect(driver.draws).toBe(d0);
  });
});

describe('FXP: "Xem thử" on the big keyboard', () => {
  it('starts after resting 300 ms, with the chip and the cue; switches after 100 ms; nothing is sent', async () => {
    const { lighting, out } = await mountPage();
    const [a, b] = pick(lighting.area0Base.mode + 1, [5, 12, 13]);
    const chip0 = chip();
    fakeTimers();
    over(a);
    await advance(REST_MS - 1);
    expect(cue()).toBeNull();
    expect(chip()).toBe(chip0);
    await advance(1);
    expect(cue()).toBe(`Đang xem thử ${a} · ${tile(a).find('.effect-btn__name').text()}: mô phỏng, chưa ghi vào phím`);
    expect(chip()).toBe('Xem thử');
    expect(tryTiles()).toEqual([a]);
    expect(paintedFaces().length).toBeGreaterThan(0);

    over(b);
    await advance(SWITCH_MS - 1);
    expect(tryTiles()).toEqual([a]);
    await advance(1);
    expect(tryTiles()).toEqual([b]);

    leaveGrid();
    await nextTick();
    expect(cue()).toBeNull();
    expect(chip()).toBe(chip0);
    expect(paintedFaces()).toHaveLength(0); // the board's own colours are back
    expect(out).toHaveLength(0);
    expect(writes(out)).toHaveLength(0);
  });

  it('keyboard focus starts it at once; focus leaving the grid ends it; a touch never starts one', async () => {
    const { lighting } = await mountPage();
    const [a] = pick(lighting.area0Base.mode + 1, [5, 12]);
    fakeTimers();
    (tile(a).element as HTMLElement).focus();
    await nextTick();
    expect(tryTiles()).toEqual([a]);
    (page!.find('[data-testid="fx-view"] [data-v="lite"]').element as HTMLElement).focus();
    await nextTick();
    expect(cue()).toBeNull();

    over(a, 'touch');
    await advance(2000);
    expect(cue()).toBeNull();
  });

  it('Esc, a view change and a tab change each end it and give the board back', async () => {
    const { lighting } = await mountPage();
    const [a] = pick(lighting.area0Base.mode + 1, [5, 12]);
    fakeTimers();
    const start = async () => { over(a); await advance(REST_MS); expect(tryTiles()).toEqual([a]); };

    await start();
    expect(esc().defaultPrevented).toBe(true);
    await nextTick();
    expect(cue()).toBeNull();
    expect(paintedFaces()).toHaveLength(0);
    leaveGrid();

    await start();
    await viewOpt('detail').trigger('click');
    await nextTick();
    expect(cue()).toBeNull();
    leaveGrid();

    await start();
    await page!.find('[role="tab"][data-id="strip"]').trigger('click');
    await nextTick();
    expect(cue()).toBeNull();
    expect(paintedFaces()).toHaveLength(0);
    expect(esc().defaultPrevented).toBe(false); // nothing to end: Esc goes on to the page
  });

  it('after Esc, moves inside the same tile do not restart it; another tile, or leaving and coming back, does (F4)', async () => {
    const { lighting } = await mountPage();
    const [a, b] = pick(lighting.area0Base.mode + 1, [12, 13, 5]);
    fakeTimers();
    over(a);
    await advance(REST_MS);
    esc();
    await nextTick();
    over(a, 'mouse', '.effect-btn__name');
    over(a, 'mouse', '.effect-btn__n');
    over(a);
    await advance(1000);
    expect(cue()).toBeNull();

    over(b);
    await advance(REST_MS);
    expect(tryTiles()).toEqual([b]);

    esc();
    leaveGrid();
    over(b);
    await advance(REST_MS);
    expect(tryTiles()).toEqual([b]);
  });

  it('paints at the area\'s brightness, never under 15 % (F5), and only the previewed half', async () => {
    const { lighting, sync } = await mountPage();
    lighting.applyBase(0, { mode: 1, paletteIndex: 0, brightness: 3 }, 'x'); // effect 2 chosen, the rainbow, 3 %
    await sync.flush();
    const paint = vi.spyOn(LiveLedPainter.prototype, 'paint');
    fakeTimers();
    const maxOf = () => {
      const [frame, , parts] = paint.mock.calls.at(-1)!;
      expect(parts).toEqual({ keys: true, strip: false });
      let m = 0;
      for (let i = 0; i < 126; i++) {
        if (lighting.area0Matrix[i]?.custom) continue;
        m = Math.max(m, frame.keys[i * 3], frame.keys[i * 3 + 1], frame.keys[i * 3 + 2]);
      }
      return m;
    };
    over(1); // Tĩnh: a still rainbow, so the level is the brightness
    await advance(REST_MS);
    expect(maxOf()).toBe(Math.round(255 * 0.15));
    esc();
    leaveGrid();
    await nextTick();
    vi.useRealTimers();

    lighting.applyBase(0, { brightness: 80 }, 'x');
    await sync.flush();
    fakeTimers();
    over(1);
    await advance(REST_MS);
    expect(maxOf()).toBe(Math.round(255 * 0.8));
  });

  it('a click writes once (one applyBase) and ends it', async () => {
    const { lighting, sync, out } = await mountPage();
    const [a] = pick(lighting.area0Base.mode + 1, [5, 12]);
    const apply = vi.spyOn(lighting, 'applyBase');
    fakeTimers();
    over(a);
    await advance(REST_MS);
    expect(writes(out)).toHaveLength(0);
    await tile(a).trigger('click');
    await nextTick();
    expect(cue()).toBeNull();
    vi.useRealTimers();
    await sync.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply.mock.calls[0][1]).toEqual({ mode: a - 1 });
    expect(writes(out).length).toBeGreaterThan(0);
    expect(lighting.area0Base.mode).toBe(a - 1);
  });

  it('never for an unknown effect (a cue only), the chosen one, the area off or the view "Tắt"', async () => {
    const { lighting, sync, out } = await mountPage();
    const chosen = lighting.area0Base.mode + 1;
    const paint = vi.spyOn(LiveLedPainter.prototype, 'paint');
    fakeTimers();
    over(6);
    await advance(REST_MS);
    expect(cue()).toBe('Hiệu ứng 6 chưa có hình xem trước');
    expect(chip()).not.toBe('Xem thử');
    expect(paint).not.toHaveBeenCalled();
    leaveGrid();

    over(chosen);
    await advance(1000);
    expect(cue()).toBeNull();

    await viewOpt('off').trigger('click');
    await nextTick();
    over(pick(chosen, [5, 12])[0]);
    await advance(1000);
    expect(cue()).toBeNull();
    leaveGrid();
    await viewOpt('lite').trigger('click');
    await nextTick();
    vi.useRealTimers();

    lighting.applyBase(0, { open: false }, 'x');
    await sync.flush();
    out.length = 0;
    fakeTimers();
    over(pick(chosen, [5, 12])[0]);
    await advance(1000);
    expect(cue()).toBeNull();
    expect(paint).not.toHaveBeenCalled();
    expect(out).toHaveLength(0);
  });

  it('the live read loop keeps reading at its own pace while a preview shows, and nothing is written', async () => {
    const { lighting, out } = await mountPage({ keepLive: true });
    await vi.waitFor(() => expect(lighting.liveHasFrame).toBe(true));
    const reads = () => out.filter((b) => b[0] === 0x05 && b[1] === 0x03).length;
    let r0 = reads();
    await sleep(600);
    const before = reads() - r0;
    const [a] = pick(lighting.area0Base.mode + 1, [5, 12]);
    (tile(a).element as HTMLElement).focus();
    await nextTick();
    expect(tryTiles()).toEqual([a]);
    r0 = reads();
    await sleep(600);
    const during = reads() - r0;
    expect(before).toBeGreaterThan(5);
    expect(during).toBeGreaterThan(before * 0.5);
    expect(writes(out)).toHaveLength(0);
    lighting.stopLivePolling();
  });
});

describe('FXP: PreviewControl on its own', () => {
  afterEach(() => vi.useRealTimers());

  it('rest, switch, focus, touch and the held tile after Esc', () => {
    vi.useFakeTimers();
    const shown: (number | null)[] = [];
    const c = new PreviewControl({ allowed: (n) => n !== 4, show: (n) => shown.push(n) });
    c.over(2, 'mouse');
    vi.advanceTimersByTime(REST_MS - 1);
    expect(c.shown).toBeNull();
    vi.advanceTimersByTime(1);
    expect(c.shown).toBe(2);
    c.over(3, 'pen');
    vi.advanceTimersByTime(SWITCH_MS);
    expect(c.shown).toBe(3);
    c.over(4, 'mouse'); // not allowed: ends it
    vi.advanceTimersByTime(SWITCH_MS);
    expect(c.shown).toBeNull();
    c.over(5, 'touch');
    vi.advanceTimersByTime(1000);
    expect(c.shown).toBeNull();
    c.focus(7);
    expect(c.shown).toBe(7);
    expect(c.escape()).toBe(true);
    expect(c.escape()).toBe(false);
    c.over(5, 'mouse');
    c.dispose();
    vi.advanceTimersByTime(1000);
    expect(c.shown).toBeNull(); // no timer fires after dispose
    expect(shown).toEqual([2, 3, null, 7, null]);
  });
});
