// DESIGN FW §11 tests 7 (no reload), 11 (the switch, the guard, import / export) and 14 (the UI while a session runs), plus the
// init order of FW §3.5 (01 02 first). The session runs on the demo bus with fake timers, as in fw-flow.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';
import type { Component } from 'vue';
import { watch } from 'vue';
import App from '../src/App.vue';
import Sidebar from '../src/components/shell/Sidebar.vue';
import TopBar from '../src/components/shell/TopBar.vue';
import SidebarFooter from '../src/components/shell/SidebarFooter.vue';
import DataLocation from '../src/components/settings/DataLocation.vue';
import FirmwarePage from '../src/pages/FirmwarePage.vue';
import { BaseTransport } from '../src/protocol/client';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { installFirmwareGuard } from '../src/router';
import { APP_ID, buildExport, pageReload, parseImport, useAppSettings } from '../src/data/appSettings';
import { useDeviceStore } from '../src/stores/device';
import { LABS_FIRMWARE_KEY, useFirmwareStore } from '../src/stores/firmware';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { useUpdateStore } from '../src/update';
import { CLOSE_BLOCKED_EVENT, desktopShell, installDesktopCloseGuard } from '../src/data/desktopClose';
import { readFileSync } from 'node:fs';
import { t as tr } from '../src/i18n/vi';
import type { MessageKey } from '../src/i18n/vi';
import { CRC, demo, fileOf, makeFw, run, startWith } from './fw-helpers';

let wrappers: VueWrapper[] = [];
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});
const keep = <T extends VueWrapper>(w: T): T => { wrappers.push(w); return w; };

type S = Awaited<ReturnType<typeof demo>>;
async function until(pred: () => boolean, max = 60_000): Promise<number> {
  let ms = 0;
  while (!pred() && ms < max) { await run(250); ms += 250; }
  return ms;
}
const ENDS = ['done', 'doneUnknown', 'versionMismatch', 'noGamepad', 'enterFail', 'preflightFail', 'verifyFail', 'packetFail', 'lost', 'notFound'];
const ended = (s: S) => () => ENDS.includes(s.fw.phase);

/** A router with the app's paths (stub pages) and the firmware guard reading the store, as main.ts installs it. */
function makeRouter() {
  const page = (n: string) => ({ template: `<div class="pg-${n}" />` }) as Component;
  const r = createRouter({
    history: createMemoryHistory(),
    routes: ['/overview', '/performance', '/profiles', '/keymap', '/macro', '/lighting', '/gamepad', '/settings', '/diagnostics', '/firmware']
      .map((path): RouteRecordRaw => ({ path, component: page(path.slice(1)), meta: { title: `page.${path.slice(1)}` as MessageKey } })),
  });
  installFirmwareGuard(r, () => {
    const fw = useFirmwareStore();
    return { enabled: fw.enabled, active: fw.active, rescue: fw.rescue };
  });
  return r;
}

// --------------------------------------------------------------------------------------------- init order (FW §3.5)

// The commands a demo connection sent at 8e2a97c (before FW): dumped with the same spy, identical for the three seeds.
const OLD_INIT = [
  '01 01 00', '01 02 00', '01 03 00', '02 03 00', '02 03 01', '02 03 03', '02 03 03', '02 03 03', '02 03 03', '02 0c 00',
  '03 05 01', '03 05 02', '03 05 03', '03 05 04', '03 05 05', '03 01 00', '03 01 00', '03 01 00', '03 01 00', '03 01 00',
];

describe('init: 01 02 before 01 01, the rest unchanged', () => {
  it.each(['pro', 'max', 'pro-xinput'] as const)('%s: the old sequence with only its first two commands swapped', async (seed) => {
    setActivePinia(createPinia());
    const out: string[] = [];
    vi.spyOn(BaseTransport.prototype as unknown as { log: (d: string, b: Uint8Array) => void }, 'log')
      .mockImplementation(function (this: unknown, d: string, b: Uint8Array) {
        if (d === 'out') out.push([...b.subarray(0, 3)].map((x) => x.toString(16).padStart(2, '0')).join(' '));
      });
    await useDeviceStore().connectDemo(seed);
    expect(out).toEqual([OLD_INIT[1], OLD_INIT[0], ...OLD_INIT.slice(2)]);
  });
});

// --------------------------------------------------------------------------------------------- 7. no reload (P1-2)

describe('7. no reload while a session runs', { timeout: 60_000 }, () => {
  const PHASES = ['entering', 'needPermission', 'rebooting', 'finding'] as const;

  /** A session held in `phase`: the 6 s wait, "Allow…", the 3 s after 08 04, or finding (the keyboard never comes back). */
  async function sessionIn(phase: (typeof PHASES)[number]) {
    const s = await demo('pro');
    if (phase === 'needPermission') s.bus.flags.bootNeedsPermission = true;
    if (phase === 'finding' || phase === 'rebooting') s.bus.flags.notFound = true;
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    if (phase === 'entering') await run(3000);
    else await until(() => s.fw.phase === phase);
    expect(s.fw.phase).toBe(phase);
    expect(s.fw.active).toBe(true);
    return s;
  }
  function stubReload() {
    const reload = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, 'location', { value: { ...orig, reload }, writable: true, configurable: true });
    const h = vi.spyOn(pageReload, 'reload').mockImplementation(() => undefined);
    return { reload, h, restore: () => Object.defineProperty(window, 'location', { value: orig, writable: true, configurable: true }) };
  }
  function stubSw(on: boolean) {
    const controller = {
      postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => {
        if (msg.type === 'apply') ports[0].postMessage({ ok: true, version: '0.2.0' });
      }),
    };
    if (on) Object.defineProperty(navigator, 'serviceWorker', { value: { controller, ready: Promise.resolve({}) }, configurable: true });
    else Reflect.deleteProperty(navigator, 'serviceWorker');
    return controller;
  }
  afterEach(() => { Reflect.deleteProperty(navigator, 'serviceWorker'); });

  it.each(PHASES)('%s: apply (with and without a service worker), reloadNow and applyAndReload never reload', async (phase) => {
    const s = await sessionIn(phase);
    const r = stubReload();
    try {
      const update = useUpdateStore();
      for (const sw of [true, false]) {
        const ctl = stubSw(sw);
        update.availableInfo = { version: '0.2.0', builtAt: '' };
        update.state = 'available';
        await update.apply();
        expect(update.state).toBe('available');
        expect(update.error).toBe(tr('update.busyFirmware'));
        expect(ctl.postMessage).not.toHaveBeenCalled(); // refused before downloading
      }
      expect(update.busyReason).toBe(tr('update.busyFirmware'));
      update.state = 'deferred';
      await update.reloadNow();
      const app = useAppSettings();
      expect(app.busyNow()).toBe(tr('update.busyFirmware'));
      await expect(app.applyAndReload('reset')).rejects.toThrow(tr('update.busyFirmware'));
      await expect(app.applyAndReload('import', { 'ae64.sidebarCollapsed': '1' })).rejects.toThrow(tr('update.busyFirmware'));
      await run(1000);
      expect(r.reload).not.toHaveBeenCalled();
      expect(r.h).not.toHaveBeenCalled();
      expect(s.fw.phase).toBe(phase);
    } finally {
      r.restore();
    }
  });

  it('a session that starts while apply waits for flush(): no reload, deferred (both branches)', async () => {
    for (const sw of [true, false]) {
      const s = await demo('pro');
      const r = stubReload();
      try {
        const ctl = stubSw(sw);
        const update = useUpdateStore();
        update.availableInfo = { version: '0.2.0', builtAt: '' };
        update.state = 'available';
        const sync = useSyncStore();
        let calls = 0;
        // The second flush() is the check right before the reload: the user pressed start meanwhile.
        vi.spyOn(sync, 'flush').mockImplementation(async () => { if (++calls === 2) s.fw.active = true; });
        await update.apply();
        expect([calls, update.state, update.error]).toEqual([2, 'deferred', null]);
        if (sw) expect(ctl.postMessage).toHaveBeenCalled();
        expect(update.state).toBe('deferred');
        expect(r.reload).not.toHaveBeenCalled();
        s.fw.active = false;
      } finally {
        r.restore();
      }
    }
  });

  it('the update buttons and the import / reset buttons are off with update.busyFirmware', async () => {
    const s = await sessionIn('finding');
    vi.useRealTimers();
    const router = makeRouter();
    await router.push('/firmware');
    const update = useUpdateStore();
    update.availableInfo = { version: '0.2.0', builtAt: '' };
    update.state = 'available';
    const foot = keep(mount(SidebarFooter, { global: { plugins: [router] }, attachTo: document.body }));
    await foot.find('button.side-foot__btn').trigger('click');
    await flushPromises();
    const apply = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === tr('update.apply'))!;
    expect(apply).toBeTruthy();
    expect(apply.disabled).toBe(true);
    expect(apply.title).toBe(tr('update.busyFirmware'));
    update.state = 'deferred';
    update.deferredVersion = '0.2.0';
    await flushPromises();
    const later = [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === tr('update.reloadNow'))!;
    expect(later.disabled).toBe(true);
    expect(later.title).toBe(tr('update.busyFirmware'));

    const dl = keep(mount(DataLocation, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    const btns = dl.findAll('button').filter((b) => [tr('appcfg.import'), tr('appcfg.reset')].includes(b.text()));
    expect(btns).toHaveLength(2);
    expect(btns.every((b) => (b.element as HTMLButtonElement).disabled)).toBe(true);
    expect(dl.find('.dl__lock').text()).toBe(tr('update.busyFirmware'));
    expect(s.fw.active).toBe(true);
  });
});

// --------------------------------------------------------------------------------------------- 11. the switch, rescue

describe('11. the labs switch', { timeout: 60_000 }, () => {
  it('off: no sidebar link, /firmware goes to Settings; on: the link and the page', async () => {
    setActivePinia(createPinia());
    await useDeviceStore().connectDemo('pro');
    const fw = useFirmwareStore();
    expect(fw.enabled).toBe(false);
    const router = makeRouter();
    await router.push('/overview');
    const side = keep(mount(Sidebar, { global: { plugins: [router] }, attachTo: document.body }));
    expect(side.find('a[href="/firmware"]').exists()).toBe(false);
    await router.push('/firmware');
    expect(router.currentRoute.value.fullPath).toBe('/settings');

    fw.setEnabled(true);
    expect(localStorage.getItem(LABS_FIRMWARE_KEY)).toBe('1');
    await flushPromises();
    expect(side.find('a[href="/firmware"]').exists()).toBe(true);
    await router.push('/firmware');
    expect(router.currentRoute.value.path).toBe('/firmware');
    fw.setEnabled(false);
    expect(localStorage.getItem(LABS_FIRMWARE_KEY)).toBeNull();
    // the stored flag is read at start
    localStorage.setItem(LABS_FIRMWARE_KEY, '1');
    setActivePinia(createPinia());
    expect(useFirmwareStore().enabled).toBe(true);
  });

  it('rescue mode opens the page (and its link) with the switch off; every other path goes back to it', async () => {
    const s = await demo('pro');
    expect(s.fw.enabled).toBe(false);
    const router = makeRouter();
    await router.push('/overview');
    vi.useRealTimers();
    const app = keep(mount(App, { global: { plugins: [router], stubs: { TopBar: true, ConnectScreen: true } }, attachTo: document.body }));
    await flushPromises();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    s.bus.replugAsBootloader();
    await run(1000);
    const boot = (await s.bus.list()).find((d) => d instanceof MockBootloader)!;
    const p = s.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    await run(100);
    expect(s.fw.rescue).toBe(true);
    expect(router.currentRoute.value.fullPath).toBe('/firmware?rescue=1');
    expect(app.find('.pg-firmware').exists()).toBe(true); // kept although device.connected is false
    expect(app.find('a[href="/firmware"]').exists()).toBe(true);
    await router.push('/keymap');
    expect(router.currentRoute.value.fullPath).toBe('/firmware?rescue=1');
  });

  it('export never carries ae64.labs.firmware; an import with it ignores it (alone → errEmpty)', () => {
    localStorage.setItem(LABS_FIRMWARE_KEY, '1');
    localStorage.setItem('ae64.sidebarCollapsed', '1');
    const out = JSON.parse(buildExport().json) as { data: Record<string, string> };
    expect(out.data).not.toHaveProperty(LABS_FIRMWARE_KEY);
    expect(out.data['ae64.sidebarCollapsed']).toBe('1');
    const file = (data: Record<string, string>) => JSON.stringify({ app: APP_ID, version: '0', savedAt: '', data });
    const both = parseImport(file({ 'ae64.sidebarCollapsed': '0', [LABS_FIRMWARE_KEY]: '1' }), 100);
    expect(both.ok).toBe(true);
    expect(both.ok && both.data).toEqual({ 'ae64.sidebarCollapsed': '0' });
    expect(parseImport(file({ [LABS_FIRMWARE_KEY]: '1' }), 100)).toEqual({ ok: false, error: 'errEmpty' });
    expect(parseImport(file({ [LABS_FIRMWARE_KEY]: 'yes' }), 100)).toEqual({ ok: false, error: 'errEmpty' }); // not even checked
  });
});

// --------------------------------------------------------------------------------------------- 14. the UI while it runs

describe('14. the UI during a session', { timeout: 60_000 }, () => {
  async function mounted(o: { flags?: Partial<MockFwBus['flags']>; enabled?: boolean } = {}) {
    const s = await demo('pro');
    s.fw.setEnabled(o.enabled ?? true);
    Object.assign(s.bus.flags, o.flags ?? {});
    vi.useRealTimers();
    const router = makeRouter();
    await router.push('/firmware');
    const side = keep(mount(Sidebar, { global: { plugins: [router] }, attachTo: document.body }));
    const top = keep(mount(TopBar, { global: { plugins: [router] }, attachTo: document.body }));
    const page = keep(mount(FirmwarePage, { global: { plugins: [router] }, attachTo: document.body }));
    await flushPromises();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    return { ...s, router, side, top, page };
  }

  it('sidebar lock, pill, undo off, beforeunload and Wake Lock: on while active, off after done', async () => {
    const release = vi.fn(async () => undefined);
    const request = vi.fn(async () => ({ release }));
    Object.defineProperty(navigator, 'wakeLock', { value: { request }, configurable: true });
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    try {
      const m = await mounted();
      const history = useHistoryStore();
      history.push({ label: 'x', undo: () => undefined, redo: () => undefined } as never);
      await run(0);
      const undoBtn = () => m.top.findAll('button').filter((b) => b.attributes('aria-label') && !b.classes().includes('pill__retry'))[0];
      expect(undoBtn().attributes('disabled')).toBeUndefined(); // on before the session
      await startWith(m.fw, makeFw({ crc: CRC.v0100 }));
      await run(0);
      expect(m.fw.active).toBe(true);
      // sidebar: every link but Firmware is off and out of the tab order
      const links = m.side.findAll('a.side__link');
      expect(links.length).toBeGreaterThan(5);
      for (const a of links) {
        const fwLink = a.attributes('href') === '/firmware';
        expect(a.attributes('aria-disabled'), a.attributes('href')).toBe(fwLink ? undefined : 'true');
        expect(a.attributes('tabindex'), a.attributes('href')).toBe(fwLink ? '0' : '-1');
      }
      // pill and undo / redo
      const pill = m.top.find('.pill');
      expect(pill.classes()).toContain('pill--fw');
      expect(pill.text()).toBe(tr('fw.pill'));
      expect(pill.attributes('role')).toBe('status');
      expect(undoBtn().attributes('disabled')).toBeDefined();
      expect(history.suspended).toBe(true);
      // the page cannot be left without a warning, and the screen stays on
      // (sessions of earlier tests in this file stay active on their own stores: compare this store's listener only)
      const added = add.mock.calls.filter((c) => c[0] === 'beforeunload');
      expect(added).toHaveLength(1);
      const onLeave = added[0][1] as (e: Event) => void;
      expect(request).toHaveBeenCalledWith('screen');
      const ev = new Event('beforeunload', { cancelable: true });
      onLeave(ev);
      expect(ev.defaultPrevented).toBe(true);
      expect(remove.mock.calls.some((c) => c[1] === onLeave)).toBe(false);

      await until(ended(m));
      expect(m.fw.phase).toBe('done');
      await run(0);
      expect(m.fw.active).toBe(false);
      expect(remove.mock.calls.filter((c) => c[0] === 'beforeunload' && c[1] === onLeave)).toHaveLength(1);
      expect(release).toHaveBeenCalled();
      expect(history.suspended).toBe(false);
      expect(m.top.find('.pill').classes()).not.toContain('pill--fw');
      expect(m.side.findAll('a.side__link').every((a) => a.attributes('aria-disabled') === undefined)).toBe(true);
    } finally {
      Reflect.deleteProperty(navigator, 'wakeLock');
    }
  });

  it('the keyboard handed back (done, enterFail): the app is never both unlocked and without a keyboard (no connect-screen flash)', async () => {
    for (const flags of [{}, { enterFail: true }]) {
      const s = await demo('pro');
      Object.assign(s.bus.flags, flags);
      const gaps: string[] = [];
      const stop = watch(() => [s.device.connected, s.fw.active, s.fw.phase] as const, ([c, a, p]) => { if (!c && !a) gaps.push(p); }, { flush: 'sync' });
      await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
      await until(() => !s.fw.active && s.device.connected);
      await run(500);
      stop();
      expect(gaps).toEqual([]);
      expect(s.fw.phase).toBe('enterFail' in flags ? 'enterFail' : 'done');
      expect(s.device.connected).toBe(true);
    }
  });

  it('the keyboard handed back turns out to be in its bootloader: rescue mode stays locked (not unlocked by the hand-back)', async () => {
    const s = await demo('pro');
    const real = s.device.adoptFromFirmware;
    const boot = new MockBootloader(s.bus, [5, 4, 3, 2, 1, 0, 1, 2, 3, 4, 5, 6], 'boot');
    vi.spyOn(s.device, 'adoptFromFirmware').mockImplementation(() => real(boot, true));
    await startWith(s.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => s.fw.rescue);
    await run(1000);
    expect(s.fw.rescue).toBe(true);
    expect(s.fw.active).toBe(true);
    expect(s.fw.phase).toBe('rescue');
  });

  it('Wake Lock refused: the session still runs', async () => {
    Object.defineProperty(navigator, 'wakeLock', { value: { request: vi.fn(async () => { throw new Error('NotAllowed'); }) }, configurable: true });
    try {
      const m = await mounted();
      await startWith(m.fw, makeFw({ crc: CRC.v0100 }));
      await until(ended(m));
      expect(m.fw.phase).toBe('done');
    } finally {
      Reflect.deleteProperty(navigator, 'wakeLock');
    }
  });

  it('focus follows the step: file ok → step 2 title, writing → step 3 title, done → the banner', async () => {
    const m = await mounted();
    await m.fw.chooseFile(fileOf(makeFw({ crc: CRC.v0100 })));
    await run(0);
    expect(document.activeElement?.id).toBe('fws-2');
    m.fw.typed = 'AE64 Pro';
    await run(0);
    expect(document.activeElement?.id).toBe('fws-2'); // typing never moves the focus
    void m.fw.start();
    await until(() => m.fw.phase === 'writing');
    await run(0);
    expect(document.activeElement?.id).toBe('fws-3');
    expect(document.activeElement?.tagName).toBe('H3');
    await until(ended(m));
    await run(0);
    expect(m.fw.phase).toBe('done');
    expect(document.activeElement?.classList.contains('fw-ban__t')).toBe(true);
    expect(document.activeElement?.closest('.fw-ban--')).toBeNull();
  });

  it('progress bar aria and the live region at 25 / 50 / 75 / 100 % only', async () => {
    const m = await mounted();
    await startWith(m.fw, makeFw({ crc: CRC.v0100 }));
    await until(() => m.fw.phase === 'writing');
    await run(0);
    const bar = () => m.page.find('[role="progressbar"]');
    expect(bar().attributes('aria-valuemin')).toBe('0');
    expect(bar().attributes('aria-valuemax')).toBe('2121');
    expect(bar().attributes('aria-label')).toBe(tr('fw.s3.write'));
    const live = m.page.find('p.sr-only[aria-live="polite"]');
    const said: string[] = [];
    let last = '';
    let checked = false;
    while (m.fw.phase === 'writing') {
      await run(50);
      const txt = live.text();
      if (txt && txt !== last) { said.push(txt); last = txt; }
      if (!checked && m.fw.sent > 100 && m.fw.phase === 'writing') {
        checked = true;
        expect(bar().attributes('aria-valuenow')).toBe(String(m.fw.sent));
        expect(bar().attributes('aria-valuetext')).toBe(`${Math.floor((m.fw.sent * 100) / 2121)}%`);
      }
    }
    await run(0);
    const txt = live.text();
    if (txt && txt !== last) said.push(txt);
    expect(checked).toBe(true);
    expect(said).toEqual([25, 50, 75, 100].map((q) => `${tr('fw.s3.write')} ${q}%`));
  });

  it('the risk box points at the risk line (aria-describedby) for a third-party file', async () => {
    const m = await mounted();
    expect(m.page.find('.fw-untested').text()).toBe(tr('fw.untested')); // PLAN §M: not tested on hardware
    await m.fw.chooseFile(fileOf(makeFw({ crc: CRC.xinput081 })));
    await run(0);
    expect(m.fw.needsRisk).toBe(true);
    const box = m.page.find('input[type="checkbox"]');
    expect(box.attributes('aria-describedby')).toBe('fw-risk-line');
    expect(m.page.find('#fw-risk-line').exists()).toBe(true);
    expect(m.page.find('#fw-risk-line').text().length).toBeGreaterThan(0);
  });

  it('desktop: the window is held while active; a blocked close asks (stay / close anyway); released after done', async () => {
    const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
    vi.spyOn(desktopShell, 'get').mockReturnValue({ invoke });
    const m = await mounted();
    const holds = () => invoke.mock.calls.filter((c) => c[0] === 'hold_close').map((c) => (c[1] as { on: boolean }).on);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT)); // not active: nothing asked
    await run(0);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await startWith(m.fw, makeFw({ crc: CRC.v0100 }));
    await run(0);
    expect(holds()).toEqual([true]);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    await run(0);
    const dlg = () => document.querySelector('[role="dialog"]');
    expect(dlg()?.textContent).toContain(tr('fw.s3.dont'));
    const btn = (label: string) => [...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
    btn(tr('fw.closeStay')).click();
    await run(0);
    expect(dlg()).toBeNull();
    expect(invoke.mock.calls.some((c) => c[0] === 'force_close')).toBe(false);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    await run(0);
    btn(tr('fw.closeAnyway')).click();
    await run(0);
    expect(invoke.mock.calls.filter((c) => c[0] === 'force_close')).toHaveLength(1);
    await until(ended(m));
    await run(0);
    expect(m.fw.phase).toBe('done');
    expect(holds()).toEqual([true, false]);
  });

  it('desktop (FW review FW-2): at start-up the hold follows the session; a blocked close with no session closes at once', async () => {
    const invoke = vi.fn(async (_cmd: string, _args?: Record<string, unknown>): Promise<unknown> => undefined);
    const shell = vi.spyOn(desktopShell, 'get').mockReturnValue({ invoke });
    const forced = () => invoke.mock.calls.filter((c) => c[0] === 'force_close').length;
    let active = false;
    // a reload while the shell still held the window (the page had a session): the new page releases it at once
    const remove = installDesktopCloseGuard(() => active);
    expect(invoke.mock.calls).toEqual([['hold_close', { on: false }]]);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    expect(forced()).toBe(1); // no session: the close goes through, whatever page is open
    active = true;
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    expect(forced()).toBe(1); // a session: the Firmware page asks instead
    remove();
    active = false;
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    expect(forced()).toBe(1);
    // started while a session runs (cannot happen at start-up, but the hold must follow it)
    const remove2 = installDesktopCloseGuard(() => true);
    expect(invoke.mock.calls.at(-1)).toEqual(['hold_close', { on: true }]);
    remove2();
    // the web build: no shell, nothing installed
    shell.mockReturnValue(null);
    const n = invoke.mock.calls.length;
    const remove3 = installDesktopCloseGuard(() => false);
    window.dispatchEvent(new Event(CLOSE_BLOCKED_EVENT));
    expect(invoke.mock.calls.length).toBe(n);
    remove3();
  });

  it('desktop (FW review FW-2): main.ts installs the guard on the firmware session; the shell drops its hold on every page load', () => {
    const main = readFileSync('src/main.ts', 'utf8');
    expect(main).toContain('installDesktopCloseGuard(() => useFirmwareStore(pinia).active);');
    const rust = readFileSync('src-tauri/src/main.rs', 'utf8');
    const load = rust.slice(rust.indexOf('.on_page_load('), rust.indexOf('.on_page_load(') + 300);
    expect(load).toContain('if payload.event() == tauri::webview::PageLoadEvent::Started {');
    expect(load).toContain('HOLD_CLOSE.store(false, Ordering::SeqCst);');
  });

  it('rescue mode: focus on the step 3 title (not its button); the pill says rescue', async () => {
    const m = await mounted({ enabled: false });
    m.bus.replugAsBootloader();
    await run(1000);
    const boot = (await m.bus.list()).find((d) => d instanceof MockBootloader)!;
    const p = m.device.adoptFromFirmware(boot, true);
    await run(500);
    await p;
    await run(0);
    expect(m.fw.rescue).toBe(true);
    expect(document.activeElement?.id).toBe('fws-3');
    expect(document.activeElement?.tagName).toBe('H3');
    expect(m.top.find('.pill').text()).toBe(tr('fw.pillRescue'));
  });
});
