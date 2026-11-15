// WX6 U-06: macro drafts are not lost (a save in flight, Disconnect / Change keyboard / demo switch, a lost cable).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import App from '../src/App.vue';
import MacroPage from '../src/pages/MacroPage.vue';
import { useToast } from '../src/components/ui/toast';
import { useDeviceStore } from '../src/stores/device';
import { keyboardIdentity, useMacroStore } from '../src/stores/macro';
import { useSyncStore } from '../src/stores/sync';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

vi.setConfig({ testTimeout: 30000 });
class RO { observe() {} unobserve() {} disconnect() {} }
const until = async (cond: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let w: VueWrapper | null = null;
let router: Router;
let pinia: Pinia;
let macro: ReturnType<typeof useMacroStore>;

const pageButton = (label: string) => w!.findAll('button').find((b) => b.text() === label)!;
const dialogButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('.dlg button')].find((b) => b.textContent?.trim() === label)!;
const rows = () => w!.findAll('.row').length;
const toasts = () => useToast().items.value.map((x) => x.text);
const dialogs = () => document.body.querySelectorAll('.dlg').length;
const loadedAll = () => macro.loaded && !macro.loading && macro.slots.length === 16;

beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  locale.value = 'vi';
  vi.stubGlobal('ResizeObserver', RO);
  useToast().items.value = [];
  await useDeviceStore(pinia).connectDemo('max');
  macro = useMacroStore(pinia);
});
afterEach(async () => {
  await useSyncStore(pinia).flush().catch(() => undefined);
  w?.unmount();
  w = null;
  await flushPromises();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function mountApp() {
  router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/macro', component: MacroPage }, { path: '/', component: { template: '<i />' } }] });
  await router.push('/macro');
  w = mount(App, { global: { plugins: [router, pinia], stubs: { Sidebar: true, TopBar: true, ConnectScreen: true, transition: false } }, attachTo: document.body });
  await until(loadedAll);
  await flushPromises();
}
async function dirtySlot(id: number, adds = 1) {
  await w!.find(`#macro-tab-${id}`).trigger('click');
  await flushPromises();
  for (let i = 0; i < adds; i++) await pageButton(t('macro.add')).trigger('click');
  await flushPromises();
  expect(w!.find('.badge').text()).toBe(t('macro.dirty'));
}

describe('WX6 U-06: a save in flight', () => {
  it('E. the editor is read-only while the save runs; the saved draft goes, nothing typed meanwhile is lost', async () => {
    router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/macro', component: MacroPage }, { path: '/keymap', component: { template: '<i />' } }] });
    await router.push('/macro');
    w = mount({ template: '<RouterView />' }, { global: { plugins: [router, pinia] }, attachTo: document.body });
    await until(loadedAll);
    await flushPromises();
    await w.find('#macro-tab-0').trigger('click');
    await flushPromises();
    const base = rows();
    await pageButton(t('macro.add')).trigger('click');
    await pageButton(t('macro.add')).trigger('click');
    await flushPromises();
    expect(rows()).toBe(base + 2);
    await pageButton(t('macro.save')).trigger('click');
    await flushPromises();
    const add = pageButton(t('macro.add'));
    expect((add.element as HTMLButtonElement).disabled).toBe(true);
    expect(w.find<HTMLInputElement>('.row input').element.disabled).toBe(true);
    expect(w.findAll<HTMLButtonElement>('.mode').every((b) => b.element.disabled)).toBe(true);
    expect((pageButton(t('macro.clearList')).element as HTMLButtonElement).disabled).toBe(true);
    expect((pageButton(t('macro.record')).element as HTMLButtonElement).disabled).toBe(true);
    // a click that gets through anyway (disabled removed) changes nothing
    add.element.removeAttribute('disabled');
    await add.trigger('click');
    await flushPromises();
    expect(rows()).toBe(base + 2);
    await until(() => toasts().includes(t('macro.saved', { n: 0 })));
    await flushPromises();
    expect(rows()).toBe(base + 2);
    expect(macro.slots[0].actions.length).toBe(base + 2);
    expect(w.find('.badge').exists()).toBe(false);
    expect((pageButton(t('macro.add')).element as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('WX6 U-06: Disconnect, Change keyboard and the demo-model switch ask first', () => {
  it('F. the demo-model switch asks; "Ở lại" keeps the draft and the keyboard; "Bỏ thay đổi" switches', async () => {
    await mountApp();
    await dirtySlot(0);
    const device = useDeviceStore(pinia);
    await device.switchDemoModel('pro');
    await flushPromises();
    expect(dialogs()).toBe(1);
    expect(device.model).toBe('max');
    dialogButton(t('macro.leaveKeep')).click();
    await until(() => dialogs() === 0); // the dialog's leave transition
    expect(device.model).toBe('max');
    expect(w!.find('.badge').text()).toBe(t('macro.dirty'));

    await device.switchDemoModel('pro');
    await flushPromises();
    expect(dialogs()).toBe(1);
    dialogButton(t('macro.discard')).click();
    await until(() => device.model === 'pro' && device.connected);
    await until(loadedAll);
    await flushPromises();
    expect(w!.find('.badge').exists()).toBe(false);
    expect(macro.carried).toBeNull();
  });

  it('F. Disconnect asks; "Bỏ thay đổi" disconnects and carries nothing', async () => {
    await mountApp();
    await dirtySlot(0);
    const device = useDeviceStore(pinia);
    await device.disconnect({ user: true });
    await flushPromises();
    expect(dialogs()).toBe(1);
    expect(device.connected).toBe(true);
    expect(w!.find('#macro-panel').exists()).toBe(true);
    dialogButton(t('macro.discard')).click();
    await until(() => !device.connected);
    await flushPromises();
    expect(w!.find('#macro-panel').exists()).toBe(false);
    expect(macro.carried).toBeNull();
  });

  it('Change keyboard asks; "Ở lại" keeps the connection', async () => {
    await mountApp();
    await dirtySlot(3);
    const device = useDeviceStore(pinia);
    await device.changeKeyboard();
    await flushPromises();
    expect(dialogs()).toBe(1);
    dialogButton(t('macro.leaveKeep')).click();
    await flushPromises();
    expect(device.connected).toBe(true);
    expect(w!.find('.badge').text()).toBe(t('macro.dirty'));
  });

  it('a clean page does not ask', async () => {
    await mountApp();
    const device = useDeviceStore(pinia);
    await device.disconnect({ user: true });
    await flushPromises();
    expect(dialogs()).toBe(0);
    expect(device.connected).toBe(false);
  });
});

describe('WX6 U-06: a lost cable', () => {
  it('the same keyboard and profile back: the slot opens with the draft still dirty and the note; nothing was written', async () => {
    await mountApp();
    const device = useDeviceStore(pinia);
    await dirtySlot(2, 2);
    const savedBefore = macro.slots.find((s) => s.id === 2)!.actions.length;
    await w!.find('#macro-tab-0').trigger('click'); // the open slot is clean, slot 2 still dirty
    await flushPromises();
    (device.transport as unknown as { unplug(): void }).unplug();
    await flushPromises();
    expect(device.connected).toBe(false);
    expect(w!.find('#macro-panel').exists()).toBe(false);
    expect(macro.carried?.drafts.map(([id]) => id)).toEqual([2]);

    await device.connectDemo('max');
    await until(loadedAll);
    await until(() => w!.find('[data-test="macro-carried"]').exists());
    expect(w!.find('[data-test="macro-carried"]').text()).toBe(t('macro.carried'));
    expect(w!.find('#macro-tab-2').attributes('aria-selected')).toBe('true');
    expect(w!.find('.badge').text()).toBe(t('macro.dirty'));
    expect(rows()).toBe(savedBefore + 2);
    expect(macro.slots.find((s) => s.id === 2)!.actions.length).toBe(savedBefore); // the keyboard still has the old one
    expect(useSyncStore(pinia).pendingCount()).toBe(0);
    expect(macro.carried).toBeNull();
  });

  it('the store hands carried drafts over once, and only to the same keyboard and profile', () => {
    const c = { keyboard: 'demo:max:1', profile: 0, current: 2, drafts: [] as [number, never][] };
    macro.carry(c);
    expect(macro.takeCarried('demo:max:1', 1)).toBeNull(); // another profile
    expect(macro.carried).toBeNull(); // taken once: gone
    macro.carry(c);
    expect(macro.takeCarried('demo:pro:1', 0)).toBeNull(); // another keyboard
    macro.carry(c);
    expect(macro.takeCarried(null, 0)).toBeNull(); // a keyboard whose serial cannot be read
    macro.carry(c);
    expect(macro.takeCarried('demo:max:1', 0)).toBe(c);
    expect(macro.takeCarried('demo:max:1', 0)).toBeNull();
  });

  it('another keyboard back: the draft is dropped', async () => {
    await mountApp();
    const device = useDeviceStore(pinia);
    await dirtySlot(1);
    (device.transport as unknown as { unplug(): void }).unplug();
    await flushPromises();
    expect(macro.carried).not.toBeNull();
    await device.connectDemo('pro');
    await until(loadedAll);
    await flushPromises();
    expect(macro.carried).toBeNull();
    expect(w!.find('[data-test="macro-carried"]').exists()).toBe(false);
    expect(w!.find('.badge').exists()).toBe(false);
  });
});

describe('WX7 0a: macro draft edges (MC1, MC2, MC3, MC5, MC9)', () => {
  it('a route leave with "Bỏ thay đổi" while connected, then back to Macro: no draft and no note', async () => {
    await mountApp();
    await dirtySlot(1);
    await router.push('/');
    await flushPromises();
    expect(dialogs()).toBe(1);
    dialogButton(t('macro.discard')).click();
    await until(() => router.currentRoute.value.path === '/');
    await flushPromises();
    expect(macro.carried).toBeNull();
    await router.push('/macro');
    await until(loadedAll);
    await flushPromises();
    await new Promise((r) => setTimeout(r, 50));
    await flushPromises();
    expect(w!.find('[data-test="macro-carried"]').exists()).toBe(false);
    expect(w!.find('.badge').exists()).toBe(false);
  });

  it('the carried draft saved: the note goes', async () => {
    await mountApp();
    const device = useDeviceStore(pinia);
    await dirtySlot(2);
    (device.transport as unknown as { unplug(): void }).unplug();
    await flushPromises();
    await device.connectDemo('max');
    await until(loadedAll);
    await until(() => w!.find('[data-test="macro-carried"]').exists());
    await pageButton(t('macro.save')).trigger('click');
    await until(() => toasts().includes(t('macro.saved', { n: 2 })));
    await flushPromises();
    expect(w!.find('.badge').exists()).toBe(false);
    expect(w!.find('[data-test="macro-carried"]').exists()).toBe(false);
  });

  it('the clear-list dialog open, then Disconnect: no second dialog, still connected', async () => {
    await mountApp();
    await dirtySlot(0);
    await pageButton(t('macro.clearList')).trigger('click');
    await flushPromises();
    expect(dialogs()).toBe(1);
    const device = useDeviceStore(pinia);
    await device.disconnect({ user: true });
    await flushPromises();
    expect(dialogs()).toBe(1);
    expect(device.connected).toBe(true);
  });

  it('a save in flight, then Disconnect: the "leave while saving" toast, still connected', async () => {
    await mountApp();
    await dirtySlot(0);
    const device = useDeviceStore(pinia);
    await pageButton(t('macro.save')).trigger('click');
    await flushPromises();
    expect((pageButton(t('macro.add')).element as HTMLButtonElement).disabled).toBe(true); // the save runs
    await device.disconnect({ user: true });
    await flushPromises();
    expect(toasts()).toContain(t('macro.leaveSaving'));
    expect(device.connected).toBe(true);
    expect(dialogs()).toBe(0);
    await until(() => toasts().includes(t('macro.saved', { n: 0 })));
  });

  it('keyboardIdentity: a real keyboard with an unreadable serial has none', () => {
    const info = useDeviceStore(pinia).info!;
    expect(keyboardIdentity({ ...info, serialHex: '00'.repeat(12) }, false)).toBeNull();
    expect(keyboardIdentity({ ...info, serialHex: 'ff'.repeat(12) }, false)).toBeNull();
    expect(keyboardIdentity({ ...info, serialHex: '' }, false)).toBeNull();
    expect(keyboardIdentity({ ...info, serialHex: '0123456789abcdef01234567' }, false)).toBe(`hid:${info.boardIdHex}:0123456789abcdef01234567`);
  });
});
