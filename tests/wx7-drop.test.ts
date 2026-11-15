// WX7 item 3: a file dropped outside a drop zone does not open in the tab (the window-level guard prevents it); the
// zones keep working: the wallpaper box gets its drop, and a macro row drag (no files) still reorders.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import App from '../src/App.vue';
import ActionTable from '../src/components/macro/ActionTable.vue';
import WallpaperCard from '../src/components/settings/WallpaperCard.vue';
import FwFileStep from '../src/components/firmware/FwFileStep.vue';
import { useFirmwareStore } from '../src/stores/firmware';
import { installDropGuard } from '../src/composables/dropGuard';
import type { MacroAction } from '../src/protocol/types';

class RO { observe() {} unobserve() {} disconnect() {} }
let w: VueWrapper | null = null;
let off: (() => void) | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  vi.stubGlobal('ResizeObserver', RO);
});
afterEach(() => {
  w?.unmount();
  w = null;
  off?.();
  off = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** jsdom has no DragEvent / DataTransfer: an Event with a DataTransfer-like object. */
function drag(type: string, types: string[], files: File[] = []) {
  const store: Record<string, string> = {};
  const dataTransfer = {
    types, files, dropEffect: 'move', effectAllowed: 'all',
    setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] ?? '',
  };
  const e = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(e, 'dataTransfer', { value: dataTransfer });
  Object.defineProperty(e, 'clientY', { value: 0 });
  return e;
}

describe('WX7 item 3: the window-level drop guard', () => {
  it('the app installs it: a file dragged over and dropped on the page body is prevented ("no drop")', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<p class="pg">page</p>' } }] });
    await router.push('/');
    w = mount(App, { global: { plugins: [router], stubs: { Sidebar: true, TopBar: true, ConnectScreen: true } }, attachTo: document.body });
    await flushPromises();
    const file = new File(['x'], 'a.bin');
    const over = drag('dragover', ['Files'], [file]);
    document.body.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true);
    expect(over.dataTransfer!.dropEffect).toBe('none');
    const drop = drag('drop', ['Files'], [file]);
    document.body.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true); // the browser does not open the file in this tab
    // a drag without files (text, a link) is left to the browser
    const text = drag('drop', ['text/plain']);
    document.body.dispatchEvent(text);
    expect(text.defaultPrevented).toBe(false);
    // and the guard goes with the app
    w.unmount();
    w = null;
    const after = drag('drop', ['Files'], [file]);
    document.body.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('a drop on the wallpaper box still reaches its handler', async () => {
    off = installDropGuard();
    w = mount(WallpaperCard, { attachTo: document.body });
    await flushPromises();
    const box = w.find('.wp__drop');
    expect(box.exists()).toBe(true);
    const over = drag('dragover', ['Files']);
    box.element.dispatchEvent(over);
    await flushPromises();
    expect(box.classes()).toContain('wp__drop--over'); // the box's own dragover ran
    expect(over.dataTransfer!.dropEffect).not.toBe('none'); // the guard left the zone's drag alone
    const drop = drag('drop', ['Files'], []);
    box.element.dispatchEvent(drop);
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(w.find('.wp__drop').classes()).not.toContain('wp__drop--over'); // its drop handler ran
  });

  it('a .bin dropped on the firmware file step still reaches it (the file is only handed to the store, mocked here)', async () => {
    off = installDropGuard();
    const fw = useFirmwareStore();
    expect(fw.canChoose).toBe(true);
    const choose = vi.spyOn(fw, 'chooseFile').mockResolvedValue(undefined as never);
    w = mount(FwFileStep, { attachTo: document.body });
    const zone = w.find('.fw-drop');
    const file = new File([new Uint8Array(4)], 'fw.bin');
    const over = drag('dragover', ['Files'], [file]);
    zone.element.dispatchEvent(over);
    await flushPromises();
    expect(over.dataTransfer!.dropEffect).not.toBe('none');
    expect(w.find('.fw-drop').classes()).toContain('fw-drop--over');
    const drop = drag('drop', ['Files'], [file]);
    zone.element.dispatchEvent(drop);
    await flushPromises();
    expect(drop.defaultPrevented).toBe(true);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose.mock.calls[0][0]).toBe(file);
  });

  it('a macro row drag (no files) still reorders', async () => {
    off = installDropGuard();
    const actions: MacroAction[] = [
      { down: true, delay: 10, keycode: 4 },
      { down: false, delay: 10, keycode: 4 },
      { down: true, delay: 10, keycode: 5 },
    ];
    w = mount(ActionTable, { props: { actions, canInsert: true, warnings: new Set<number>() }, attachTo: document.body });
    const rows = w.findAll('.row');
    rows[0].find('.row__grip').element.dispatchEvent(drag('dragstart', []));
    const r = rows[2].element as HTMLElement;
    r.getBoundingClientRect = () => ({ top: -10, height: 4, left: 0, width: 10, right: 10, bottom: -6, x: 0, y: -10, toJSON: () => ({}) });
    const over = drag('dragover', ['text/plain']);
    r.dispatchEvent(over);
    expect(over.defaultPrevented).toBe(true); // the row took it
    r.dispatchEvent(drag('drop', ['text/plain']));
    await flushPromises();
    const out = w.emitted('update')!.at(-1)![0] as MacroAction[];
    expect(out.map((a) => `${a.down ? 'd' : 'u'}${a.keycode}`)).toEqual(['u4', 'd5', 'd4']);
  });
});
