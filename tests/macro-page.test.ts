// Macro page: leaving with unsaved drafts asks in a Dialog, not window.confirm (DESIGN L §3.3, §8.1 M1–M10). The recorder
// is stopped before the question; a write in flight refuses the leave with a toast.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import MacroPage from '../src/pages/MacroPage.vue';
import { useToast } from '../src/components/ui/toast';
import { MockTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useMacroStore } from '../src/stores/macro';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

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
let mock: MockTransport;
let macro: ReturnType<typeof useMacroStore>;

async function open() {
  const leaf = { template: '<i />' };
  router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/macro', component: MacroPage }, { path: '/keymap', component: leaf },
      { path: '/a', component: leaf }, { path: '/b', component: leaf },
      { path: '/blocked', component: leaf, beforeEnter: () => false },
    ],
  });
  await router.push('/macro');
  w = mount({ template: '<RouterView />' }, { global: { plugins: [router, pinia] }, attachTo: document.body });
  await until(() => macro.loaded && !macro.loading && macro.slots.length === 16);
  await flushPromises();
}
const route = () => router.currentRoute.value.fullPath;
const dlgs = () => document.body.querySelectorAll('.dlg').length;
const panelOf = (title: string) => [...document.body.querySelectorAll<HTMLElement>('.dlg__panel')].find((p) => p.querySelector('.dlg__title')?.textContent === title);
const leaveDlg = () => panelOf(t('macro.leaveTitle'));
const bodyButton = (label: string) => [...document.body.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent?.trim() === label).pop();
const pageButton = (label: string) => w!.findAll('button').find((b) => b.text() === label)!;
const rows = () => w!.findAll('.row').length;
const toasts = () => useToast().items.value.map((x) => x.text);
async function ask(to: string) {
  await router.push(to);
  await flushPromises();
}
/** One unsaved change on a slot: an added action (two: a balanced down + up). */
async function edit(id: number, n = 1) {
  await w!.find(`#macro-tab-${id}`).trigger('click');
  for (let i = 0; i < n; i++) await pageButton(t('macro.add')).trigger('click');
  await flushPromises();
}
/** A stand-in sidebar link outside the page, focused before the push (review L-P2). */
function fromLink() {
  const a = document.createElement('a');
  a.href = '#/keymap';
  a.textContent = 'Keymap';
  document.body.appendChild(a);
  a.focus();
  return a;
}
const key = (type: 'keydown' | 'keyup', code: string, target: EventTarget = window) => {
  const e = new KeyboardEvent(type, { code, key: code === 'Escape' ? 'Escape' : code.replace('Key', '').toLowerCase(), bubbles: true, cancelable: true });
  target.dispatchEvent(e);
  return e.defaultPrevented;
};
function countOpens() {
  let n = 0;
  const mo = new MutationObserver((recs) => {
    for (const r of recs) for (const x of r.addedNodes) if (x instanceof HTMLElement && (x.matches('.dlg') || x.querySelector('.dlg'))) n++;
  });
  mo.observe(document.body, { childList: true, subtree: true });
  return { get n() { return n; }, stop: () => mo.disconnect() };
}

let confirm: ReturnType<typeof vi.spyOn>;
beforeEach(async () => {
  pinia = createPinia();
  setActivePinia(pinia);
  locale.value = 'vi';
  vi.stubGlobal('ResizeObserver', RO);
  useToast().items.value = [];
  const device = useDeviceStore(pinia);
  await device.connectDemo();
  mock = device.transport as MockTransport;
  macro = useMacroStore(pinia);
  confirm = vi.spyOn(window, 'confirm').mockImplementation(() => true);
});
afterEach(() => {
  expect(confirm).not.toHaveBeenCalled();
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('leave dialog (DESIGN L)', () => {
  it('M1. nothing unsaved: a push leaves at once, no dialog', async () => {
    await open();
    await ask('/keymap');
    expect([route(), dlgs()]).toEqual(['/keymap', 0]);
  });

  it('M2. slots 2 then 0 edited: one dialog naming "Macro 0, Macro 2"; "Tiếp tục sửa" stays with both drafts, focus back on the link', async () => {
    await open();
    await edit(2);
    await edit(0);
    const link = fromLink();
    await ask('/keymap');
    expect(dlgs()).toBe(1);
    expect(route()).toBe('/macro');
    expect(leaveDlg()!.querySelector('.dlg__body')!.textContent).toBe(t('macro.leaveBody', { names: 'Macro 0, Macro 2' }));
    expect(document.activeElement?.textContent?.trim()).toBe(t('macro.leaveKeep'));
    bodyButton(t('macro.leaveKeep'))!.click();
    await flushPromises();
    expect(leaveDlg()).toBeUndefined();
    expect(route()).toBe('/macro');
    expect(w!.findAll('.slot__dirty').length).toBe(2);
    expect(document.activeElement).toBe(link);
  });

  it('M3. "Bỏ thay đổi": leaves, writes nothing, undo is back on, the dialog opened once', async () => {
    await open();
    await edit(0);
    const history = useHistoryStore(pinia);
    expect(history.suspended).toBe(true);
    const meta = vi.spyOn(mock, 'setMacroMeta');
    const actions = vi.spyOn(mock, 'writeMacroActions');
    const opens = countOpens();
    await ask('/keymap');
    bodyButton(t('macro.discard'))!.click();
    await until(() => route() === '/keymap');
    await flushPromises();
    opens.stop();
    expect(meta).not.toHaveBeenCalled();
    expect(actions).not.toHaveBeenCalled();
    expect(history.suspended).toBe(false);
    expect(opens.n).toBe(1);
  });

  it('M4. recording that caught nothing: a push leaves at once; the recorder no longer takes keys', async () => {
    await open();
    await pageButton(t('macro.record')).trigger('click');
    await flushPromises();
    expect(w!.findAll('button').some((b) => b.text() === t('macro.stop'))).toBe(true); // recording
    await ask('/keymap');
    expect([route(), dlgs()]).toEqual(['/keymap', 0]);
    expect(key('keydown', 'KeyA')).toBe(false);
  });

  it('M5. recording with KeyA held: the push stops it (a release is added), asks, and Esc closes the dialog', async () => {
    await open();
    const before = rows();
    await pageButton(t('macro.record')).trigger('click');
    await flushPromises();
    expect(key('keydown', 'KeyA')).toBe(true); // taken by the recorder
    await flushPromises();
    await ask('/keymap');
    expect(w!.findAll('button').some((b) => b.text() === t('macro.stop'))).toBe(false); // stopped
    expect(rows()).toBe(before + 2); // the press and the release added on stop
    expect(leaveDlg()).toBeTruthy();
    key('keydown', 'Escape', document.activeElement!);
    await flushPromises();
    expect(leaveDlg()).toBeUndefined();
    expect(route()).toBe('/macro');
    expect(w!.findAll('button').some((b) => b.text() === t('macro.record'))).toBe(true); // still stopped
  });

  it('M6. a save in flight: a push is refused with a toast, no dialog; once saved it leaves', async () => {
    await open();
    await edit(0, 2);
    let release!: () => void;
    vi.spyOn(macro, 'save').mockImplementation(() => new Promise<void>((r) => { release = r; }));
    await pageButton(t('macro.save')).trigger('click');
    await until(() => !!release);
    await ask('/keymap');
    expect([route(), dlgs()]).toEqual(['/macro', 0]);
    expect(toasts()).toContain(t('macro.leaveSaving'));
    release();
    await flushPromises();
    await ask('/keymap');
    expect([route(), dlgs()]).toEqual(['/keymap', 0]);
  });

  it('M6. "Xoá dữ liệu" in flight on a clean slot: the push is refused too', async () => {
    await open();
    let release!: () => void;
    vi.spyOn(macro, 'clearData').mockImplementation(() => new Promise<void>((r) => { release = r; }));
    await pageButton(t('macro.clearData')).trigger('click');
    await flushPromises();
    bodyButton(t('macro.clearData'))!.click(); // the dialog's button
    await until(() => !!release);
    useToast().items.value = [];
    await ask('/keymap');
    expect([route(), dlgs()]).toEqual(['/macro', 0]);
    expect(toasts()).toContain(t('macro.leaveSaving'));
    release();
    await flushPromises();
  });

  it('M7. "Xoá danh sách" is open over a dirty slot: a push opens no second dialog and stays', async () => {
    await open();
    await edit(0);
    await pageButton(t('macro.clearList')).trigger('click');
    await flushPromises();
    expect(panelOf(t('macro.clearList'))).toBeTruthy();
    await ask('/keymap');
    expect(dlgs()).toBe(1);
    expect(leaveDlg()).toBeUndefined();
    expect(panelOf(t('macro.clearList'))).toBeTruthy();
    expect(route()).toBe('/macro');
  });

  it('M8. a second push while the dialog is open: the latest target wins', async () => {
    await open();
    await edit(0);
    await ask('/a');
    await ask('/b');
    expect(dlgs()).toBe(1);
    bodyButton(t('macro.discard'))!.click();
    await until(() => route() === '/b');
  });

  it('M9. the body describes the dialog (aria-describedby); "Xoá danh sách" has none', async () => {
    await open();
    await edit(0);
    await ask('/keymap');
    const panel = leaveDlg()!;
    const body = panel.querySelector('.dlg__body')!;
    expect(body.id).not.toBe('');
    expect(panel.getAttribute('aria-describedby')).toBe(body.id);
    bodyButton(t('macro.leaveKeep'))!.click();
    await flushPromises();
    await pageButton(t('macro.clearList')).trigger('click');
    await flushPromises();
    expect(panelOf(t('macro.clearList'))!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('M10. "Bỏ thay đổi" to a target that refuses: stays with the draft; the next push asks again', async () => {
    await open();
    await edit(2);
    await ask('/blocked');
    bodyButton(t('macro.discard'))!.click();
    await flushPromises();
    expect(route()).toBe('/macro');
    expect(w!.findAll('.slot__dirty').length).toBe(1);
    expect(leaveDlg()).toBeUndefined();
    await ask('/keymap');
    expect(leaveDlg()).toBeTruthy();
    expect(leaveDlg()!.textContent).toContain(t('macro.leaveBody', { names: 'Macro 2' }));
  });
});
