// DESIGN F §11 items 2–13: the Overview page (/overview). Demo keyboard only. The page reads (perf.load, settings.load)
// and never writes; a key click opens that key alone in the Travel tab.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextTick } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import { IconPencil } from '@tabler/icons-vue';
import { MockTransport, PHYSICAL_KEYS, POLLING_RATE_HZ } from '../src/protocol';
import type { Performance, PhysicalKey } from '../src/protocol';
import type { DemoSeed } from '../src/protocol/mock';
import { NAV, installPerfTabGuard, routes, saveTab } from '../src/router';
import { mountAt } from './mountPerformance';
import { useDeviceStore } from '../src/stores/device';
import { rangeMm, usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { useSelectionStore } from '../src/stores/selection';
import { clearTuningSnapshots } from '../src/stores/tuning';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import SelectionLegend from '../src/components/keyboard/SelectionLegend.vue';
import SelectionBar, { legendSentence } from '../src/components/keyboard/SelectionBar.vue';
import { actuationLegend } from '../src/data/keycapActuation';
import type { LegendItem } from '../src/components/keyboard/SelectionBar.vue';
import Button from '../src/components/ui/Button.vue';
import { overviewVi } from '../src/i18n/overview';
import { overviewEn } from '../src/i18n/en/overview';
import { vi as viDict, t } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';
import { locale } from '../src/i18n/locale';

vi.setConfig({ testTimeout: 30000 });

let pinia: Pinia;
const mounted: VueWrapper[] = [];

const settle = async () => { for (let i = 0; i < 8; i++) await flushPromises(); };
/** The page's reads are done (performance, then the device settings). */
async function ready() {
  await vi.waitFor(() => {
    expect(usePerformanceStore().loading).toBe(false);
    expect(useSettingsStore().loading).toBe(false);
  }, { timeout: 15000, interval: 5 });
  await settle();
}
/** The app's routes and tab guard. `profiles` false: without part G's named route (the page still has that case). */
function appRouter(profiles = false): Router {
  const r = createRouter({ history: createMemoryHistory(), routes: profiles ? routes : routes.filter((x) => x.name !== 'profiles') });
  installPerfTabGuard(r);
  return r;
}
async function connect(seed?: DemoSeed) {
  const device = useDeviceStore();
  if (!device.connected) await device.connectDemo(seed);
  return { device, mock: device.transport as MockTransport };
}
/** Mount the app's RouterView at /overview (the demo is connected first). */
async function mountOv(opts: { profiles?: boolean; seed?: DemoSeed } = {}) {
  const { device, mock } = await connect(opts.seed);
  const router = appRouter(opts.profiles);
  await router.push('/overview');
  const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
  mounted.push(w);
  await ready();
  return { w, router, device, mock };
}
const tiles = (w: VueWrapper) => w.findAll('.ovs > li');
const value = (w: VueWrapper, i: number) => tiles(w)[i].find('.ovs__value').text();
const sub = (w: VueWrapper, i: number) => tiles(w)[i].find('.ovs__sub').text();
/** A firmware mode the app does not know (the type only lists 0/1/2). */
const odd = (m: number) => m as Performance['mode'];
const keyId = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!.id;

/** Every write of the protocol client spied (the mock's demo helpers are not HID commands). */
function spyWrites(mock: MockTransport) {
  const names = new Set<string>();
  for (let p: object | null = Object.getPrototypeOf(MockTransport.prototype); p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
    for (const n of Object.getOwnPropertyNames(p)) if (/^(set|commit|clear|write|reset|factory|start|calib)/i.test(n)) names.add(n);
  }
  return [...names].filter((n) => typeof (mock as unknown as Record<string, unknown>)[n] === 'function')
    .map((n) => [n, vi.spyOn(mock as unknown as Record<string, () => unknown>, n)] as const);
}
const called = (spies: ReturnType<typeof spyWrites>) => spies.filter(([, s]) => s.mock.calls.length).map(([n]) => n);
const spyExchange = (mock: MockTransport) => vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> }, 'exchange');
const sent = (spy: ReturnType<typeof spyExchange>) => spy.mock.calls.map(([f]) => [...f.slice(0, 2)].map((b) => b.toString(16).padStart(2, '0')).join(' '));

/** A key press the way the browser does it on a focused <button>: Enter clicks on keydown, Space on keyup, unless the
 *  page prevented the key. */
function press(el: HTMLElement, key: 'Enter' | ' ') {
  const code = key === 'Enter' ? 'Enter' : 'Space';
  el.focus();
  const down = new KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true });
  el.dispatchEvent(down);
  if (key === 'Enter' && !down.defaultPrevented) el.click();
  const up = new KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true });
  el.dispatchEvent(up);
  if (key === ' ' && !down.defaultPrevented && !up.defaultPrevented) el.click();
  return down;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  clearTuningSnapshots();
  locale.value = 'vi';
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});
afterEach(() => {
  while (mounted.length) mounted.pop()!.unmount();
  document.body.innerHTML = '';
  locale.value = 'vi';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Overview: tiles (DESIGN F §3.3, §3.4, §4)', () => {
  it('default profile: one value on every key, all RT, every key calibrated', async () => {
    const { w, device } = await mountOv();
    expect(device.activeProfile).toBe(0);
    expect(value(w, 0)).toBe(`${device.activeProfile + 1}${device.activeProfileName}`);
    expect(sub(w, 0)).toBe('Profile 1 trên 4');
    expect(value(w, 1)).toBe('1.0 mm');
    expect(sub(w, 1)).toBe('Giống nhau trên cả 64 phím');
    expect(tiles(w)[2].find('.ovs__value [aria-hidden="true"]').text()).toBe('64/64 phím');
    expect(tiles(w)[2].find('.ovs__value .sr-only').text()).toBe('Rapid Trigger bật trên 64 trong 64 phím');
    expect((tiles(w)[2].find('.ovs__bar > i').element as HTMLElement).style.width).toBe('100%');
    expect(tiles(w)[2].find('.ovs__sub').exists()).toBe(false); // the bar takes the sub line's place
    expect(value(w, 3)).toBe('Đủ 64 phím');
    expect(sub(w, 3)).toBe('Mọi phím đã hiệu chuẩn');
  });

  it('a gaming profile (FPS): a range, the most common value, 4 RT keys', async () => {
    const { device } = await connect();
    await device.switchProfile(1);
    const { w } = await mountOv();
    expect(value(w, 1)).toBe('0.3–1.2 mm');
    expect(sub(w, 1)).toBe('Phổ biến nhất 1.2 mm, trên 60 phím');
    expect(tiles(w)[2].find('.ovs__value [aria-hidden="true"]').text()).toBe('4/64 phím');
    expect((tiles(w)[2].find('.ovs__bar > i').element as HTMLElement).style.width).toBe('6.25%');
    expect(sub(w, 0)).toBe('Profile 2 trên 4');
  });

  it('AE64 Pro: 2 decimals, its own profile names and model', async () => {
    const { w, device } = await mountOv({ seed: 'pro' });
    expect(w.find('#ov-model').text()).toBe('AE64 Pro');
    device.rtPrecision = 0.01; // a board with 0.01 mm steps (the demo Pro answers 0.001)
    expect(value(w, 0)).toContain('配置一');
    const perf = usePerformanceStore();
    perf.values = { ...perf.values, [keyId('W')]: { ...perf.values[keyId('W')], rtFirstTouch: 0.151 } };
    await nextTick();
    expect(value(w, 1)).toBe('0.15–1.0 mm');
    expect(w.find(`.kb__key[data-key="${keyId('W')}"] .cap__sub`).text()).toBe('0.15');
  });

  it('item 3: the Calibration tile follows perf.uncalibrated, and shows no number while reading', async () => {
    const { w } = await mountOv();
    const perf = usePerformanceStore();
    const cal = () => tiles(w)[3];
    expect(cal().find('.ovs__tile').attributes('href')).toBe('/performance?tab=calibration');
    expect(cal().find('.ovs__state--ok').exists()).toBe(true);
    expect(cal().find('.ovs__state--warn').exists()).toBe(false);

    perf.uncalibrated = [35, 36, 40];
    await nextTick();
    expect([35, 36, 40].map((id) => useDeviceStore().legend(PHYSICAL_KEYS[id]))).toEqual(['J', 'K', 'Enter']);
    expect(value(w, 3)).toBe('Thiếu 3 phím');
    expect(sub(w, 3)).toBe('Chưa hiệu chuẩn: J, K, Enter');
    expect(cal().find('.ovs__state--warn').exists()).toBe(true);
    expect(cal().find('.ovs__state--ok').exists()).toBe(false);

    perf.uncalibrated = [35, 36, 40, 41, 50];
    await nextTick();
    expect(value(w, 3)).toBe('Thiếu 5 phím');
    expect(sub(w, 3)).toMatch(/^Chưa hiệu chuẩn: J, K, Enter \+2$/);

    // reading: "—" and "Đang đọc từ bàn phím…" even though uncalibrated has keys (it grows during a read)
    perf.loading = true;
    await nextTick();
    for (const i of [1, 2, 3]) {
      expect(value(w, i), `tile ${i}`).toBe('—');
      expect(tiles(w)[i].find('.ovs__value--wait').exists()).toBe(true);
      expect(sub(w, i), `tile ${i}`).toBe('Đang đọc từ bàn phím…');
    }
    expect(cal().find('.ovs__state').exists()).toBe(false);
    expect(value(w, 0)).toContain(useDeviceStore().activeProfileName); // the Profile tile needs no read
    perf.loading = false;
  });

  it('read error: three tiles "—" + "Chưa đọc được"; the keyboard is replaced by the error card, whose button reads again', async () => {
    const { w } = await mountOv();
    const perf = usePerformanceStore();
    const load = vi.spyOn(perf, 'load').mockResolvedValue();
    perf.loadError = 'Bàn phím không phản hồi lệnh 04:01.';
    perf.values = {};
    await nextTick();
    for (const i of [1, 2, 3]) {
      expect(value(w, i)).toBe('—');
      expect(sub(w, i)).toBe('Chưa đọc được');
    }
    expect(w.find('.ovk .kb').exists()).toBe(false);
    expect(w.find('.ovk .card__title').text()).toBe(t('perf.loadFailed'));
    expect(w.find('.ovk .card__sub').text()).toBe('Bàn phím không phản hồi lệnh 04:01.');
    await w.find('.ovk .card button').trigger('click');
    expect(load).toHaveBeenCalledWith(true);
  });

  it('no key in a known mode: Actuation "—" + "Chưa đọc được", RT 0/64', async () => {
    const { w } = await mountOv();
    const perf = usePerformanceStore();
    perf.values = Object.fromEntries(Object.entries(perf.values).map(([id, p]) => [id, { ...p, mode: odd(3) }])) as Record<number, Performance>;
    await nextTick();
    expect(value(w, 1)).toBe('—');
    expect(sub(w, 1)).toBe('Chưa đọc được');
    expect(tiles(w)[2].find('.ovs__value [aria-hidden="true"]').text()).toBe('0/64 phím');
  });

  it('F-TEST-2: every known-mode key has one value and one key is in mode 3 → "Giống nhau trên cả 63 phím" (the count, not 64)', async () => {
    const { w } = await mountOv();
    const perf = usePerformanceStore();
    perf.values = { ...perf.values, [keyId('Q')]: { ...perf.values[keyId('Q')], mode: odd(3), rtFirstTouch: 0.2, normalPress: 0.2 } };
    await nextTick();
    expect(value(w, 1)).toBe('1.0 mm');
    expect(sub(w, 1)).toBe('Giống nhau trên cả 63 phím');
  });

  it('a long profile name is cut in the tile (title = the whole name) and whole in the keyboard heading', async () => {
    const { w, device } = await mountOv();
    const long = 'Valorant ranked – Jett, RT 0.15 mm';
    device.profileNames = device.profileNames.map((n, i) => (i === device.activeProfile ? long : n));
    await nextTick();
    expect(tiles(w)[0].find('.ovs__text').attributes('title')).toBe(long);
    expect(w.find('.ovk__name').text()).toBe(long);
    expect(w.find('.ovk__sub').text()).toBe(`Actuation từng phím của profile ${long}. Bấm một phím để sửa nó.`);
  });
});

describe('Overview: the keyboard (DESIGN F §3.2, §3.5)', () => {
  it('item 2: a click, Enter or Space on a key selects only that key and opens /performance?tab=travel; Back returns', async () => {
    const { w, router } = await mountOv();
    const sel = useSelectionStore();
    const W = keyId('W');
    expect(W).toBe(16);
    const ways: [string, (el: HTMLElement) => void][] = [
      ['click', (el) => el.click()],
      ['Enter', (el) => { expect(press(el, 'Enter').defaultPrevented).toBe(false); }],
      ['Space', (el) => { expect(press(el, ' ').defaultPrevented).toBe(false); }],
    ];
    for (const [how, act] of ways) {
      sel.selectMany([1, 2], 'replace');
      expect(sel.ids, how).toEqual([1, 2]);
      const key = w.find(`.ovk .kb__key[data-key="${W}"]`);
      expect(key.attributes('aria-pressed'), how).toBeUndefined();
      expect(key.findAll('.cap--selected').length, how).toBe(0); // the board never draws a selection
      act(key.element as HTMLElement);
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/performance?tab=travel'), { timeout: 15000 });
      await settle();
      expect(sel.ids, how).toEqual([W]);
      expect(sel.focused, how).toBe(W);
      expect(router.currentRoute.value.fullPath, how).toBe('/performance?tab=travel');
      // the Travel tab shows that key alone selected
      await vi.waitFor(() => expect(w.findAll('.kb__key[aria-pressed="true"]').map((k) => Number(k.attributes('data-key')))).toEqual([W]));
      router.back();
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/overview'));
      await settle();
      expect(w.find('.ovk .kb').exists(), how).toBe(true);
    }
  });

  it('F-TEST-1: with Calibration as the last-used tab, a key click still opens /performance?tab=travel', async () => {
    saveTab('calibration');
    const { w, router } = await mountOv();
    const W = keyId('W');
    (w.find(`.ovk .kb__key[data-key="${W}"]`).element as HTMLElement).click();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/performance'), { timeout: 15000 });
    await settle();
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=travel');
    expect(useSelectionStore().ids).toEqual([W]);
  });

  it('"Sửa phím" opens the Travel tab and keeps the selection; "Chỉnh hiệu năng" opens /performance (last tab)', async () => {
    const { w, router } = await mountOv();
    const sel = useSelectionStore();
    sel.selectMany([1, 2], 'replace');
    const edit = w.find('.ovk__head a.btn');
    expect(edit.text()).toBe('Sửa phím');
    expect(edit.attributes('href')).toBe('/performance?tab=travel');
    expect(w.find('.ovh a.btn--primary').attributes('href')).toBe('/performance');
    (edit.element as HTMLElement).click();
    await settle();
    expect(router.currentRoute.value.fullPath).toBe('/performance?tab=travel');
    expect(sel.ids).toEqual([1, 2]);
  });

  it('the board: pick class, no aria-pressed, described by the hint, aria-busy while reading', async () => {
    const { w } = await mountOv();
    const kb = w.find('.ovk .kb');
    expect(kb.classes()).toContain('kb--pick');
    expect(kb.classes()).not.toContain('kb--selectable');
    expect(kb.attributes('aria-describedby')).toBe('ov-kb-hint');
    expect(document.getElementById('ov-kb-hint')!.textContent).toBe('Bấm một phím để mở nó trong tab Hành trình.');
    expect(document.getElementById('ov-kb-hint')!.hidden).toBe(true);
    expect(w.findAll('.ovk .kb__key[aria-pressed]').length).toBe(0);
    expect(w.findAll('.ovk .kb__key[tabindex="0"]').length).toBe(1);
    expect(w.find('.ovk').attributes('aria-busy')).toBeUndefined();
    usePerformanceStore().loading = true;
    await nextTick();
    expect(w.find('.ovk').attributes('aria-busy')).toBe('true');
    expect(w.find('.ovk__loading').exists()).toBe(true);
    expect(w.find('.ovk__shows').exists()).toBe(false);
    usePerformanceStore().loading = false;
  });
});

describe('Overview: reads (DESIGN F §3.10)', () => {
  it('item 6: the first visit reads 64 performance records then the 7 device settings, and writes nothing; a return reads nothing', async () => {
    const { device, mock } = await connect();
    const ex = spyExchange(mock);
    const writes = spyWrites(mock);
    const first = await mountOv();
    const frames = sent(ex);
    expect(frames.slice(0, 64)).toEqual(Array(64).fill('04 01'));
    expect(frames.length).toBe(64 + 7);
    expect(frames.slice(64).includes('04 01')).toBe(false);
    expect(useSettingsStore().loaded).toBe(true);
    expect(called(writes)).toEqual([]);
    first.w.unmount();
    mounted.length = 0;
    ex.mockClear();
    const again = await mountOv();
    expect(sent(ex)).toEqual([]);
    expect(again.w.find('.ovk .kb').exists()).toBe(true);
    expect(called(writes)).toEqual([]);
    expect(device.connected).toBe(true);
  });

  it('item 4: a profile change reads again (tiles wait meanwhile); after unmount the listener is gone', async () => {
    const { w, device } = await mountOv();
    const perf = usePerformanceStore();
    const load = vi.spyOn(perf, 'load');
    const p = device.switchProfile(1);
    await p;
    expect(load).toHaveBeenCalledWith(true);
    await nextTick();
    expect(value(w, 1)).toBe('—');
    expect(sub(w, 1)).toBe('Đang đọc từ bàn phím…');
    expect(tiles(w)[0].find('.ovs__text').text()).toBe(device.profileNames[1]); // the name changes at once
    expect(w.find('.ovk__name').text()).toBe(device.profileNames[1]);
    await ready();
    expect(value(w, 1)).toBe('0.3–1.2 mm');
    w.unmount();
    mounted.length = 0;
    load.mockClear();
    await device.switchProfile(2);
    expect(load).not.toHaveBeenCalled();
  });

  it('polling rate only once the settings are read; "—" before (the store default is not the keyboard\'s)', async () => {
    const { w } = await mountOv();
    const settings = useSettingsStore();
    expect(settings.loaded).toBe(true);
    expect(w.find('[data-ov="polling"]').text()).toBe(`${POLLING_RATE_HZ[settings.pollingRate]} Hz`);
    expect(w.find('[data-ov="polling"]').text()).toMatch(/^\d+ Hz$/);
    settings.loaded = false;
    await nextTick();
    expect(w.find('[data-ov="polling"]').text()).toBe('—');
  });

  it('a reconnected demo reads the settings again exactly once', async () => {
    const { device } = await mountOv();
    const settings = useSettingsStore();
    const load = vi.spyOn(settings, 'load');
    // App shows ConnectScreen while disconnected: the page unmounts, then mounts again on the new connection
    mounted.pop()!.unmount();
    await device.disconnect();
    expect(settings.loaded).toBe(false);
    await device.connectDemo();
    await mountOv();
    expect(load).toHaveBeenCalledTimes(1);
    expect(settings.loaded).toBe(true);
  });
});

describe('Overview: header, shortcuts, device line (DESIGN F §3.1, §3.7–§3.9, §7)', () => {
  it('item 5: without part G there is no Profile button, the Profile tile is not a link, 7 shortcuts', async () => {
    const { w } = await mountOv();
    expect(w.findAll('.ovh__actions .btn').map((b) => b.text())).toEqual(['Chỉnh hiệu năng']);
    expect(tiles(w)[0].find('.ovs__tile').element.tagName).toBe('DIV');
    expect(tiles(w)[0].find('.ovs__go').exists()).toBe(false);
    expect(w.findAll('.ovl__item')).toHaveLength(7);
    expect(w.findAll('.ovl__item').map((a) => a.attributes('href'))).toEqual([
      '/performance', '/keymap', '/lighting', '/macro', '/performance?tab=test', '/performance?tab=calibration', '/settings',
    ]);
  });

  it('item 5: with part G (a route named "profiles") the button, the tile link and the 8th shortcut appear', async () => {
    const { w } = await mountOv({ profiles: true });
    expect(w.findAll('.ovh__actions .btn').map((b) => [b.text(), b.attributes('href')])).toEqual([
      ['Profile', '/profiles'], ['Chỉnh hiệu năng', '/performance'],
    ]);
    expect(tiles(w)[0].find('.ovs__tile').attributes('href')).toBe('/profiles');
    expect(tiles(w)[0].find('.ovs__go').exists()).toBe(true);
    expect(w.findAll('.ovl__item')).toHaveLength(8);
    expect(w.findAll('.ovl__item')[6].attributes('href')).toBe('/profiles');
  });

  it('shortcuts: name and description, the tone of the page\'s sidebar item', async () => {
    const { w } = await mountOv();
    const items = w.findAll('.ovl__item');
    expect(items.map((a) => a.find('.ovl__name').text())).toEqual(['Hiệu năng', 'Keymap', 'Đèn', 'Macro', 'Kiểm tra phím', 'Hiệu chuẩn', 'Cài đặt thiết bị']);
    expect(items[0].find('.ovl__desc').text()).toBe('Hành trình, phím nâng cao, switch');
    expect(items.map((a) => (a.find('.ovl__tile').element as HTMLElement).style.getPropertyValue('--f'))).toEqual([
      'var(--f-performance)', 'var(--f-keymap)', 'var(--f-lighting)', 'var(--f-macro)', 'var(--f-live)', 'var(--f-calibration)', 'var(--f-settings)',
    ]);
    expect(w.find('nav.ovl').attributes('aria-labelledby')).toBe('ov-links-title');
  });

  it('header and device line: model, Demo, firmware, board, protocol; Diagnostics link', async () => {
    const { w, device } = await mountOv();
    expect(w.find('#ov-model').text()).toBe('AE64 Max');
    expect(w.find('.ovh__meta').text()).toContain('Demo');
    expect(w.find('.ovh__meta').text()).toContain(`Firmware ${device.info!.firmware}`);
    const dl = w.findAll('.ovd__list > div').map((d) => [d.find('dt').text(), d.find('dd').text()]);
    expect(dl[0]).toEqual(['Bo mạch', `0x${device.info!.boardIdHex.toUpperCase()}`]);
    const v = device.version!;
    expect(dl[1]).toEqual(['Protocol', `${v.main}.${v.sub}.${v.hardware}.${v.software}`]);
    expect(dl[2][0]).toBe('Polling rate');
    expect(w.find('.ovd__more').attributes('href')).toBe('/diagnostics');
    expect(w.find('.ovd__more').text()).toBe('Chẩn đoán');
  });

  it('§7: headings, landmarks and the tab order (Profile tile and RT/Actuation tiles are not stops without G)', async () => {
    const { w } = await mountOv({ profiles: true });
    expect(w.findAll('h1, h2, h3').map((h) => `${h.element.tagName}:${h.text()}`)).toEqual([
      'H1:Tổng quan', 'H2:AE64 Max', 'H2:Bàn phím của bạn', 'H2:Lối tắt', 'H2:Thiết bị',
    ]);
    expect(w.find('ul.ovs').attributes('aria-label')).toBe('Tóm tắt profile đang dùng');
    const stops = [...(w.element as HTMLElement).querySelectorAll<HTMLElement>('a[href], button')].filter((e) => e.tabIndex >= 0);
    const name = (e: HTMLElement) => (e.classList.contains('kb__key') ? 'KEY' : (e.querySelector('.ovl__name, .ovs__label > span, .btn__label')?.textContent ?? e.textContent ?? '').trim());
    expect(stops.map(name)).toEqual([
      'Profile', 'Chỉnh hiệu năng', 'Profile', 'Hiệu chuẩn', 'Sửa phím', 'KEY',
      'Hiệu năng', 'Keymap', 'Đèn', 'Macro', 'Kiểm tra phím', 'Hiệu chuẩn', 'Profile', 'Cài đặt thiết bị', 'Chẩn đoán',
    ]);
  });

  it('item 11: every ov.* key in vi and en, none empty; the page renders in English without a raw key', async () => {
    expect(Object.keys(overviewEn).sort()).toEqual(Object.keys(overviewVi).sort());
    expect(Object.keys(overviewVi)).toHaveLength(35);
    for (const [k, s] of [...Object.entries(overviewVi), ...Object.entries(overviewEn)]) expect(s.trim(), k).not.toBe('');
    for (const k of ['page.overview', 'page.profiles', ...Object.keys(overviewVi)]) {
      expect((viDict as Record<string, string>)[k], k).toBeTruthy();
      expect((enDict as Record<string, string>)[k], k).toBeTruthy();
    }
    locale.value = 'en';
    const { w } = await mountOv();
    const text = w.text();
    expect(text).not.toMatch(/\bov\.\w+/);
    expect(w.find('h1').text()).toBe('Overview');
    expect(value(w, 1)).toBe('1.0 mm');
    expect(sub(w, 1)).toBe('Same on all 64 keys');
    expect(value(w, 3)).toBe('All 64 keys');
    usePerformanceStore().uncalibrated = [35];
    await nextTick();
    expect(value(w, 3)).toBe('1 key missing');
    expect(sub(w, 3)).toBe('Not calibrated: J');
  });
});

describe('Overview: the keycap legend (item 10, DESIGN F §3.6)', () => {
  it('the fill sample draws a small key face in the tone', () => {
    const items: LegendItem[] = [{ sample: 'fill', label: 'phần tô', tone: 'var(--m-actuation)', text: 'độ sâu actuation' }];
    const l = mount(SelectionLegend, { props: { items } });
    const s = l.find('.sb__fill');
    expect(s.exists()).toBe(true);
    expect((s.element as HTMLElement).style.getPropertyValue('--tone')).toBe('var(--m-actuation)');
    expect(l.find('.sb__icon').exists()).toBe(false); // not the lock
    expect(l.text()).toBe('Keycap: = độ sâu actuation');
    l.unmount();
  });

  it('the selection bar reads the same sentence function (B unchanged)', async () => {
    await connect();
    const items: LegendItem[] = [{ text: 'Actuation (mm)', tone: 'var(--m-actuation)' }, { glyph: 'RT', text: 'bật Rapid Trigger' }];
    const b = mount(SelectionBar, { props: { shows: items }, global: { plugins: [pinia] } });
    expect(b.find('.sb__shows .sr-only').text()).toBe(legendSentence(items));
    expect(legendSentence(items)).toBe('Keycap: Actuation (mm) · RT = bật Rapid Trigger');
    b.unmount();
  });

  it('the Overview line: Actuation (mm) · fill · RT · lock · dashed outline, read once as one sentence', async () => {
    const { w } = await mountOv();
    const shows = () => w.find('.ovk__shows');
    expect(shows().find('.sr-only').text()).toBe(`Keycap: Actuation (mm) · phần tô = độ sâu actuation · RT = ${t('perf.showsRtTag')}`);
    expect(shows().attributes('title')).toBe(shows().find('.sr-only').text());
    expect(shows().find('[aria-hidden="true"] .sb__fill').exists()).toBe(true);
    const perf = usePerformanceStore();
    perf.values = { ...perf.values, 3: { ...perf.values[3], mode: odd(255) } };
    perf.uncalibrated = [35];
    await nextTick();
    const sentence = shows().find('.sr-only').text();
    expect(sentence).toBe(`Keycap: Actuation (mm) · phần tô = độ sâu actuation · RT = ${t('perf.showsRtTag')} · ${t('perf.showsLockedGlyph')} = ${t('perf.showsLocked')} · viền đứt = chưa hiệu chuẩn`);
    expect(sentence).toBe(legendSentence(w.findComponent(SelectionLegend).props('items') as LegendItem[]));
  });
});

describe('Overview: routes and building blocks (items 7, 8, 9, 12)', () => {
  it('item 7: / and unknown paths go to /overview; the route is named; Overview is first in the sidebar; Performance is lazy', async () => {
    const r = appRouter();
    await r.push('/');
    expect(r.currentRoute.value.fullPath).toBe('/overview');
    await r.push('/khong-co');
    expect(r.currentRoute.value.fullPath).toBe('/overview');
    await r.push('/a/b/c');
    expect(r.currentRoute.value.path).toBe('/overview');
    expect(r.hasRoute('overview')).toBe(true);
    expect(r.resolve({ name: 'overview' }).path).toBe('/overview');
    expect(NAV[0].group).toBe('nav.groupKeyboard');
    expect(NAV[0].items[0]).toMatchObject({ path: '/overview', title: 'page.overview', tone: 'var(--f-overview)' });
    const perfRoute = routes.find((x) => x.path === '/performance')!;
    const ovRoute = routes.find((x) => x.path === '/overview')!;
    expect(typeof perfRoute.component).toBe('function'); // () => import(…): its own chunk
    expect(typeof ovRoute.component).toBe('object'); // bundled with the app
    expect(ovRoute.meta).toEqual({ title: 'page.overview' });
  });

  it('item 8: pick on a board that does not select: a click calls pick with the key; no aria-pressed; drag selects nothing', async () => {
    const keys: PhysicalKey[] = [0, 1].map((id) => ({ id, uiRow: 0, row: 1, col: id, x: id, y: 0, w: 1, name: `K${id}` }));
    const pick = vi.fn();
    const kb = mount(KeyboardView, { props: { keys, pick }, attachTo: document.body, global: { plugins: [pinia] } });
    mounted.push(kb);
    expect(kb.find('.kb').classes()).toContain('kb--pick');
    expect(kb.findAll('.kb__key[aria-pressed]')).toHaveLength(0);
    await kb.findAll('.kb__key')[1].trigger('click');
    expect(pick).toHaveBeenCalledTimes(1);
    expect(pick.mock.calls[0][0]).toEqual(keys[1]);
    // Enter / Space are not prevented: the browser turns them into the click
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    kb.findAll('.kb__key')[0].element.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    // a drag over the board selects nothing
    const root = kb.find('.kb').element as HTMLElement;
    root.setPointerCapture = () => undefined;
    for (const [type, x] of [['pointerdown', 2], ['pointermove', 80], ['pointerup', 80]] as const) {
      kb.findAll('.kb__key')[0].element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: 5 }));
      await nextTick();
    }
    expect(useSelectionStore().count).toBe(0);
    expect(kb.find('.kb__box').exists()).toBe(false);
    // arrows still move focus between keys
    (kb.findAll('.kb__key')[0].element as HTMLElement).focus();
    kb.findAll('.kb__key')[0].element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    await nextTick();
    expect(document.activeElement).toBe(kb.findAll('.kb__key')[1].element);
    expect(pick).toHaveBeenCalledTimes(1);
  });

  it('item 8: pick on a selectable board is ignored: a key selects as before', async () => {
    const keys: PhysicalKey[] = [0, 1].map((id) => ({ id, uiRow: 0, row: 1, col: id, x: id, y: 0, w: 1, name: `K${id}` }));
    const pick = vi.fn();
    const kb = mount(KeyboardView, { props: { keys, pick, selectable: true }, attachTo: document.body, global: { plugins: [pinia] } });
    mounted.push(kb);
    expect(kb.find('.kb').classes()).not.toContain('kb--pick');
    const root = kb.find('.kb').element as HTMLElement;
    root.setPointerCapture = () => undefined;
    const key = kb.findAll('.kb__key')[1].element;
    key.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }));
    key.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, cancelable: true, button: 0 }));
    await kb.findAll('.kb__key')[1].trigger('click');
    expect(useSelectionStore().ids).toEqual([1]);
    expect(pick).not.toHaveBeenCalled();
    expect(kb.findAll('.kb__key')[1].attributes('aria-pressed')).toBe('true');
  });

  it('item 9: Button with `to` is a link with the button classes and no type, disabled or busy state', async () => {
    const r = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }, { path: '/x', component: { template: '<b />' } }] });
    await r.push('/');
    const b = mount(Button, { props: { to: '/x', variant: 'primary', icon: IconPencil }, slots: { default: 'Đi' }, global: { plugins: [r] } });
    const a = b.find('a');
    expect(a.exists()).toBe(true);
    expect(b.element.tagName).toBe('A');
    expect(a.attributes('href')).toBe('/x');
    expect(a.classes()).toEqual(expect.arrayContaining(['btn', 'btn--primary', 'btn--md']));
    for (const attr of ['type', 'disabled', 'aria-busy']) expect(a.attributes(attr), attr).toBeUndefined();
    expect(a.find('.btn__label').text()).toBe('Đi');
    await a.trigger('click');
    await flushPromises();
    expect(r.currentRoute.value.path).toBe('/x');
    b.unmount();
    // without `to`: the <button> of today
    const plain = mount(Button, { props: { loading: true }, slots: { default: 'Lưu' } });
    expect(plain.element.tagName).toBe('BUTTON');
    expect(plain.attributes('type')).toBe('button');
    expect(plain.attributes('disabled')).toBeDefined();
    expect(plain.attributes('aria-busy')).toBe('true');
    plain.unmount();
  });

  it('item 12: the tiles keep room for 2 sub lines (.ovs__sub min-height 36px), so the keyboard never moves when numbers arrive', () => {
    const css = readFileSync(resolve('src/pages/OverviewPage.vue'), 'utf8').split('<style')[1];
    const rule = css.match(/\.ovs__sub\s*\{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/min-height:\s*36px/);
    expect(rule).toMatch(/line-height:\s*18px/);
    expect(css).toMatch(/\.ovs__bar\s*\{[^}]*height:\s*6px[^}]*margin:\s*7px 0 5px/);
  });
});

describe('item 13: Overview keycaps = Travel keycaps (Actuation view, depth fill on)', () => {
  /** Unknown modes (3, 255) on two keys, RT and Standard keys, 3 uncalibrated keys. */
  function seedOddProfile() {
    const perf = usePerformanceStore();
    const v: Record<number, Performance> = { ...perf.values };
    v[keyId('Q')] = { ...v[keyId('Q')], mode: odd(3) };
    v[keyId('Tab')] = { ...v[keyId('Tab')], mode: odd(255) };
    v[keyId('E')] = { ...v[keyId('E')], mode: 0, normalPress: 1.75, rtFirstTouch: 0.4 };
    v[keyId('R')] = { ...v[keyId('R')], mode: 2, rtFirstTouch: 0.125, rtPress: 0.05, rtRelease: 0.2 };
    v[keyId('T')] = { ...v[keyId('T')], axisRangeMax: 4000, rtFirstTouch: 3.2 };
    perf.values = v;
    perf.uncalibrated = [35, 36, 40];
  }
  for (const seed of ['max', 'pro'] as const) {
    it(`${seed}: sublabel, badge, badgeIcon, badgeTitle, fill and flag are the same on every key`, async () => {
      localStorage.setItem('ae64.perf.depthShading', '1');
      const ov = await mountOv({ seed });
      const tr = await mountAt({ path: '/performance', query: { tab: 'travel' } }, { plugins: [pinia] });
      mounted.push(tr.w);
      await ready();
      seedOddProfile();
      await nextTick();
      const a = ov.w.findComponent(KeyboardView).props();
      const b = tr.w.findComponent(KeyboardView).props();
      const device = useDeviceStore();
      expect(device.keys).toHaveLength(64);
      const cap = (p: typeof a, k: PhysicalKey) => ({
        sublabel: p.sublabel?.(k), badge: p.badge?.(k), badgeIcon: p.badgeIcon?.(k), badgeTitle: p.badgeTitle?.(k), fill: p.fill?.(k), flag: p.flag?.(k),
      });
      for (const k of device.keys) expect(cap(a, k), k.name).toEqual(cap(b, k));
      // the odd keys really are odd (the comparison covers them)
      const q = cap(a, device.keys[keyId('Q')]);
      expect(q.badgeIcon).toBeDefined();
      expect(q.badgeTitle).toBe(t('perf.unsupportedMode'));
      expect(cap(a, device.keys[keyId('R')]).badge).toBe('RT');
      expect(cap(a, device.keys[35]).flag).toEqual({ label: t('kb.uncalibrated') });
      expect(cap(a, device.keys[keyId('E')]).fill).toBeCloseTo(1.75 / rangeMm(usePerformanceStore().values[keyId('E')]));
      // and the board draws them: lock badge, dashed outline
      expect(ov.w.find(`.ovk .kb__key[data-key="${keyId('Q')}"] .cap__badge--icon`).exists()).toBe(true);
      expect(ov.w.find('.ovk .kb__key[data-key="35"] .cap--flag').exists()).toBe(true);
    });
  }

  it('F-TEST-3: in the Travel tab on another metric (RT, Deadzone) a mode-3 key keeps its lock and its reason', async () => {
    await connect();
    const tr = await mountAt({ path: '/performance', query: { tab: 'travel' } }, { plugins: [pinia] });
    mounted.push(tr.w);
    await ready();
    const perf = usePerformanceStore();
    perf.values = { ...perf.values, [keyId('Q')]: { ...perf.values[keyId('Q')], mode: odd(3) } };
    await nextTick();
    const chips = tr.w.findAll('.chips[role="radiogroup"] .chip');
    expect(chips.map((c) => c.text())).toEqual([t('perf.metricActuation'), t('perf.metricRt'), t('perf.metricDeadzone')]);
    for (const i of [1, 2]) {
      await chips[i].trigger('click');
      expect(chips[i].attributes('aria-checked')).toBe('true');
      const lock = tr.w.find(`.kb__key[data-key="${keyId('Q')}"] .cap__badge--icon`);
      expect(lock.exists(), chips[i].text()).toBe(true);
      expect(lock.attributes('title')).toBe('Chế độ không hỗ trợ: chỉ đọc');
      expect(lock.attributes('aria-label')).toBe('Chế độ không hỗ trợ: chỉ đọc');
      expect(tr.w.find(`.kb__key[data-key="${keyId('W')}"] .cap__badge--icon`).exists()).toBe(false);
    }
  });

  it('F-TEST-4: the lock item of the Actuation legend has the Actuation tone (= the Travel tab METRIC_TONE.actuation)', () => {
    const base = PHYSICAL_KEYS.slice(0, 2).map(() => ({ mode: 1, rtFirstTouch: 1 }) as Performance);
    const lock = actuationLegend([base[0], { ...base[1], mode: odd(3) }], 0).find((i) => 'sample' in i && i.sample === 'lock')!;
    expect(lock).toBeDefined();
    const travel = readFileSync(resolve('src/components/performance/TravelTab.vue'), 'utf8');
    const tone = /actuation: '([^']+)',/.exec(travel)![1];
    expect(tone).toBe('var(--m-actuation)');
    expect(lock.tone).toBe(tone);
    expect(actuationLegend([base[0], { ...base[1], mode: odd(3) }], 0, true).find((i) => 'sample' in i && i.sample === 'lock')!.tone).toBe(tone);
  });
});
