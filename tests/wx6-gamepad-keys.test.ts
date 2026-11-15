// WX6 item 8: keyboard operability on the Gamepad page. Demo + "read key travel": a key whose target is a control is not
// taken by the demo keyboard; travel lock: a locked curve handle takes no key and writes nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import GamepadPage from '../src/pages/GamepadPage.vue';
import type { MockTransport } from '../src/protocol';
import { controlIndex, decodeConfig, encodeConfig } from '../src/protocol/gamepad';
import { useDeviceStore } from '../src/stores/device';
import { useGamepadStore } from '../src/stores/gamepad';
import { useHistoryStore } from '../src/stores/history';
import { useLiveStore } from '../src/stores/live';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });

const router = () => createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
let w: VueWrapper | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  locale.value = 'en';
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
});
afterEach(async () => {
  await useSyncStore().flush().catch(() => undefined);
  w?.unmount();
  w = null;
  useLiveStore().stop();
  await flushPromises();
  document.body.innerHTML = '';
  locale.value = 'vi';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function open(prepare?: (t: MockTransport) => void) {
  const device = useDeviceStore();
  await device.connectDemo('pro-xinput');
  prepare?.(device.transport as MockTransport);
  w = mount(GamepadPage, { global: { plugins: [router()] }, attachTo: document.body });
  await flushPromises();
  const gp = useGamepadStore();
  await vi.waitFor(() => expect(gp.travelKnown && w!.find('.gpo').exists()).toBe(true), { timeout: 10000 });
  return { device, gp };
}

describe('WX6: Gamepad page keys', () => {
  it('demo, reading on: ArrowRight on an output tile still moves to the next tile', async () => {
    const { device } = await open();
    const up = controlIndex('LY+');
    const left = controlIndex('LX-');
    const tile = (i: number) => w!.find(`[data-gp-tile="${i}"]`).element as HTMLElement;
    const press = async () => {
      tile(up).focus();
      const e = new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true, cancelable: true });
      tile(up).dispatchEvent(e);
      await flushPromises();
      return document.activeElement?.getAttribute('data-gp-tile');
    };
    expect(await press()).toBe(String(left)); // reading off
    const sw = w!.findAll('button[role="switch"]').find((b) => b.attributes('aria-label') === tr('gp.appRead'))!;
    await sw.trigger('click');
    await flushPromises();
    expect(await press()).toBe(String(left)); // reading on: the same (the demo did not take the key)
    void device;
  });

  it('WX7 0a (DP1): demo, reading on: a focused curve handle keeps its arrow keys (the demo takes no key)', async () => {
    const { gp } = await open();
    const W = useDeviceStore().keys.find((k) => k.name === 'W')!;
    useSelectionStore().select(W.id);
    await flushPromises();
    const sw = w!.findAll('button[role="switch"]').find((b) => b.attributes('aria-label') === tr('gp.appRead'))!;
    await sw.trigger('click');
    await flushPromises();
    const LY = controlIndex('LY+');
    const handles = w!.findAll('.gpc__h');
    expect(handles.length).toBe(2);
    const endBefore = gp.config!.bindings[LY].endUm;
    const el = handles[1].element as HTMLElement;
    el.focus();
    const e = new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft', bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    await flushPromises();
    expect(gp.config!.bindings[LY].endUm).toBe(endBefore - 10);
  });

  it('travel lock: a locked curve handle has no tab stop, takes no arrow key and writes nothing', async () => {
    const { gp } = await open((t) => {
      const cfg = decodeConfig(t.gamepadFirmware!.active);
      const b = cfg.bindings[controlIndex('LY+')];
      b.declaredUm = 4000; b.endUm = 3500;
      t.gamepadFirmware!.active = encodeConfig(cfg);
    });
    await vi.waitFor(() => expect(gp.locked).toBe(true), { timeout: 10000 });
    await flushPromises();
    const W = useDeviceStore().keys.find((k) => k.name === 'W')!;
    expect(useSelectionStore().selected.has(W.id)).toBe(true);
    const handles = w!.findAll('.gpc__h');
    expect(handles.length).toBe(2);
    expect(handles.map((h) => h.attributes('tabindex'))).toEqual(['-1', '-1']);
    expect(handles[1].attributes('aria-disabled')).toBe('true');
    const history = useHistoryStore();
    const before = history.undoId;
    const endBefore = gp.config!.bindings[controlIndex('LY+')].endUm;
    await handles[1].trigger('keydown', { key: 'ArrowLeft' });
    await handles[0].trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(history.undoId).toBe(before);
    expect(gp.config!.bindings[controlIndex('LY+')].endUm).toBe(endBefore);
    expect(gp.locked).toBe(true);
  });
});
