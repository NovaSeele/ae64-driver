import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { PHYSICAL_KEYS } from '../src/protocol';
import LiveTravelPage from '../src/pages/LiveTravelPage.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useLiveStore } from '../src/stores/live';
import { locale } from '../src/i18n/locale';

const key = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!;
const W = key('W');
const TAB = key('Tab');
const SHIFT = key('Left Shift') ?? PHYSICAL_KEYS.find((k) => /shift/i.test(k.name))!;

describe('undoAutoFollow', () => {
  let live: ReturnType<typeof useLiveStore>;
  const depth = new Map<number, number>();

  /** Set one key's travel (mm) and feed its whole row, like a poll does. */
  function set(k: { id: number; row: number }, mm: number, now: number) {
    depth.set(k.id, mm);
    const values: number[] = [];
    for (const p of PHYSICAL_KEYS) if (p.row === k.row) values[p.col] = Math.round((depth.get(p.id) ?? 0) * 1000);
    for (let i = 0; i < values.length; i++) values[i] ??= 0;
    live.ingest('route', k.row, values, now);
  }

  beforeEach(async () => {
    setActivePinia(createPinia());
    depth.clear();
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    live = useLiveStore();
    live.reset();
  });

  it('restores the key followed before a Tab pressed while it was released', () => {
    set(W, 2, 1000);
    expect(live.focusId).toBe(W.id);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow(1150)).toBe(true);
    expect(live.focusId).toBe(W.id);
    expect(live.follow).toBe(true);
  });

  it('Shift+Tab: undoes both switches and restores W', () => {
    set(W, 2, 1000);
    set(W, 0, 1020);
    set(SHIFT, 1, 1050);
    set(TAB, 2, 1100);
    expect(live.focusId).toBe(TAB.id);
    expect(live.undoAutoFollow(1150)).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  it('does nothing when the Tab was already released', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    set(TAB, 0, 1120);
    expect(live.undoAutoFollow(1150)).toBe(false);
    expect(live.focusId).toBe(TAB.id);
  });

  it('does nothing when the switch is older than the window', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    expect(live.undoAutoFollow(1601)).toBe(false);
    expect(live.undoAutoFollow(1600)).toBe(true);
  });

  it('does nothing after pin()', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    live.pin(TAB.id);
    expect(live.undoAutoFollow(1150)).toBe(false);
    expect(live.follow).toBe(false);
  });

  it('does nothing after a manual setFocus', () => {
    set(W, 2, 1000);
    set(W, 0, 1050);
    set(TAB, 2, 1100);
    live.setFocus(W.id);
    live.setFocus(TAB.id);
    expect(live.undoAutoFollow(1150)).toBe(false);
  });

  it('restores W when the Tab came long after W was released', () => {
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(TAB, 2, 1700);
    expect(live.undoAutoFollow(1750)).toBe(true);
    expect(live.focusId).toBe(W.id);
  });

  it('does not chain past a key that was released before the undo', () => {
    set(W, 2, 1000);
    set(W, 0, 1100);
    set(SHIFT, 1, 1200); // W → Shift
    set(SHIFT, 0, 1300); // Shift released
    set(TAB, 2, 1400); // Shift → Tab
    expect(live.undoAutoFollow(1450)).toBe(true);
    expect(live.focusId).toBe(SHIFT.id);
  });
});

describe('graph keyboard focus', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    locale.value = 'vi';
    vi.stubGlobal('requestAnimationFrame', () => 1);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  });
  afterEach(() => { document.body.innerHTML = ''; vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  async function mountPage() {
    await useDeviceStore().connectDemo();
    await usePerformanceStore().load();
    const live = useLiveStore();
    const undo = vi.spyOn(live, 'undoAutoFollow');
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
    const w = mount(LiveTravelPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return { w, undo, live };
  }

  it('undoes auto-follow once when :focus-visible matches', async () => {
    const { w, undo } = await mountPage();
    const canvas = w.find('canvas.graph').element as HTMLCanvasElement;
    vi.spyOn(canvas, 'matches').mockImplementation((s: string) => s === ':focus-visible');
    canvas.focus();
    await flushPromises();
    expect(undo).toHaveBeenCalledTimes(1);
    w.unmount();
  });

  it('leaves auto-follow alone on pointer focus', async () => {
    const { w, undo } = await mountPage();
    const canvas = w.find('canvas.graph').element as HTMLCanvasElement;
    vi.spyOn(canvas, 'matches').mockReturnValue(false);
    canvas.focus();
    await flushPromises();
    expect(undo).not.toHaveBeenCalled();
    w.unmount();
  });

  it('does not undo when the page is pinned', async () => {
    const { w, undo, live } = await mountPage();
    live.pin(W.id);
    const canvas = w.find('canvas.graph').element as HTMLCanvasElement;
    vi.spyOn(canvas, 'matches').mockReturnValue(true);
    canvas.focus();
    await flushPromises();
    expect(undo).not.toHaveBeenCalled();
    w.unmount();
  });
});
