// DESIGN G §11 items 4–13: the Profiles page (/profiles), its cards and the compare; the sidebar's ProfileSelect fixes (§3.9);
// the Settings card (§3.8); the router (§3.1). Demo keyboard only. Viewing, picking A/B, filtering and scrolling send nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { DOMWrapper, VueWrapper } from '@vue/test-utils';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { nextTick } from 'vue';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import type { Performance } from '../src/protocol';
import { NAV, installPerfTabGuard, routes } from '../src/router';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useCalibrationStore } from '../src/stores/calibration';
import { useSettingsStore } from '../src/stores/settings';
import { clearTuningSnapshots } from '../src/stores/tuning';
import ProfileSelect from '../src/components/shell/ProfileSelect.vue';
import SettingsPage from '../src/pages/SettingsPage.vue';
import { profilesVi } from '../src/i18n/profiles';
import { profilesEn } from '../src/i18n/en/profiles';
import { vi as viDict, t } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';
import { locale } from '../src/i18n/locale';

vi.setConfig({ testTimeout: 30000 });

let pinia: Pinia;
const mounted: VueWrapper[] = [];

function appRouter(): Router {
  const r = createRouter({ history: createMemoryHistory(), routes });
  installPerfTabGuard(r);
  return r;
}
async function connect() {
  const device = useDeviceStore();
  if (!device.connected) await device.connectDemo();
  return { device, perf: usePerformanceStore(), mock: device.transport as MockTransport };
}
/** The active profile is read and nothing is in progress. */
async function idle() {
  const device = useDeviceStore();
  const perf = usePerformanceStore();
  await vi.waitFor(() => {
    expect(perf.loading).toBe(false);
    expect(perf.loadedProfile).toBe(device.activeProfile);
  }, { timeout: 15000, interval: 5 });
  for (let i = 0; i < 6; i++) await flushPromises();
}
/** Before mounting: profile 1 "Default" read, then the switch to 2 "FPS" read (= 1 opened as a snapshot, 2 live). */
async function openTwo() {
  const { device, perf } = await connect();
  const off = device.onProfileChanged(() => void perf.load(true));
  await perf.load();
  await device.switchProfile(1);
  await idle();
  off();
}
async function mountPage() {
  const { device, perf, mock } = await connect();
  const router = appRouter();
  await router.push('/profiles');
  const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
  mounted.push(w);
  await idle();
  return { w, router, device, perf, mock };
}
const cards = (w: VueWrapper) => w.findAll('.pfc');
const useBtn = (w: VueWrapper, i: number) => cards(w)[i].find('.pfc__foot button');
const pencil = (w: VueWrapper, i: number) => cards(w)[i].find('.pfc__top .ibtn');
const seg = (w: VueWrapper, n: 0 | 1) => w.findAll('.cmp__pick [role="radiogroup"]')[n];
const checked = (w: VueWrapper, n: 0 | 1) => Number(seg(w, n).find('[aria-checked="true"]').attributes('data-v'));
const spyExchange = (mock: MockTransport) => vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> }, 'exchange');
const sent = (spy: ReturnType<typeof spyExchange>) => spy.mock.calls.map(([f]) => [...f.slice(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
const keyId = (name: string) => PHYSICAL_KEYS.find((k) => k.name === name)!.id;
/** Type into an input the way a browser does (an `input` event; `composing` = an IME is still composing). */
async function type(el: Pick<DOMWrapper<Element>, 'element'>, value: string, composing = false) {
  const input = el.element as HTMLInputElement;
  input.value = value;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: composing }));
  await nextTick();
}
async function key(el: Pick<DOMWrapper<Element>, 'element'>, k: string, composing = false) {
  el.element.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, isComposing: composing }));
  await flushPromises();
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

describe('Profiles: cards (DESIGN G §3.3, §4)', () => {
  it('first visit: the active card is live, the other three "not opened"; one opened profile → the compare asks for two', async () => {
    const { w, device } = await mountPage();
    expect(device.activeProfile).toBe(0);
    expect(cards(w)).toHaveLength(4);
    const on = cards(w)[0];
    expect(on.classes()).toContain('pfc--on');
    expect(on.attributes('aria-current')).toBe('true');
    expect(on.find('h3').text()).toBe('Profile 1: Default');
    expect(on.findAll('dd').map((d) => d.text())).toEqual(['1.0 mm', '64/64 phím']);
    expect(on.find('.pfc__meta').text()).toBe('Số liệu trực tiếp');
    expect(on.find('.pfc__live').text()).toBe('Đang dùng');
    expect(on.find('.pfc__foot button').exists()).toBe(false);
    for (const i of [1, 2, 3]) {
      expect(cards(w)[i].attributes('aria-current')).toBeUndefined();
      expect(cards(w)[i].find('.pfc__none').text()).toBe('Chưa mở trong phiên này');
      expect(cards(w)[i].find('.pfc__noneSub').text()).toBe('Dùng profile này một lần để đọc số liệu của nó.');
      expect(useBtn(w, i).text()).toBe('Dùng profile này');
      expect(useBtn(w, i).attributes('aria-describedby')).toBe(`pf-name-${i}`);
      expect(pencil(w, i).attributes('aria-label')).toBe(`Đổi tên ${device.profileNames[i]}`);
    }
    expect(pencil(w, 0).attributes('title')).toBe('Đổi tên profile');
    expect(w.find('.cmp__pick').exists()).toBe(false);
    expect(w.find('.cmp .cmp__empty').text()).toBe('Cần ít nhất 2 profile đã mở để so sánh.Mới mở: 1 · Default. Bấm “Dùng profile này” trên một thẻ phía trên: app đọc profile đó, rồi bạn so được.');
  });

  it('another opened profile shows its snapshot figures and the time the app left it (24 h)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 14, 3, 41));
    await openTwo();
    vi.useRealTimers();
    const { w } = await mountPage();
    expect(cards(w)[0].findAll('dd').map((d) => d.text())).toEqual(['1.0 mm', '64/64 phím']);
    expect(cards(w)[0].find('.pfc__meta').text()).toBe('Số liệu lúc 03:41');
    expect(cards(w)[1].findAll('dd').map((d) => d.text())).toEqual(['0.3–1.2 mm', '4/64 phím']);
    expect(cards(w)[1].find('.pfc__meta').text()).toBe('Số liệu trực tiếp');
    locale.value = 'en';
    await nextTick();
    expect(cards(w)[0].find('.pfc__meta').text()).toBe('Data as of 03:41');
    expect(cards(w)[1].findAll('dd').map((d) => d.text())).toEqual(['0.3–1.2 mm', '4/64 keys']);
  });

  it('the Actuation figure is the Overview\'s own function (same text on the card and the Overview tile)', async () => {
    const { w, perf, device } = await mountPage();
    const odd = { ...perf.values[keyId('Q')], mode: 3 as Performance['mode'], normalPress: 0.1, rtFirstTouch: 0.1 };
    perf.values = { ...perf.values, [keyId('Q')]: odd, [keyId('E')]: { ...perf.values[keyId('E')], rtFirstTouch: 0.45 } };
    await nextTick();
    expect(cards(w)[0].findAll('dd')[0].text()).toBe('0.45–1.0 mm'); // the mode-3 key is not counted
    const ov = appRouter();
    await ov.push('/overview');
    const o = mount(RouterView, { global: { plugins: [ov, pinia] }, attachTo: document.body });
    mounted.push(o);
    await flushPromises();
    expect(o.findAll('.ovs > li')[1].find('.ovs__value').text()).toBe('0.45–1.0 mm');
    expect(device.activeProfile).toBe(0);
  });

  it('item 8b: while the active profile is read, every "Use this profile" and pencil is disabled; the card counts', async () => {
    const { w, perf } = await mountPage();
    perf.loading = true;
    perf.loadedCount = 23;
    await nextTick();
    for (const i of [1, 2, 3]) expect(useBtn(w, i).attributes('disabled')).toBeDefined();
    for (const i of [0, 1, 2, 3]) expect(pencil(w, i).attributes('disabled')).toBeDefined();
    expect(cards(w)[0].find('.pfc__none[role="status"]').text()).toBe('Đang đọc cài đặt từ 23/64 phím…');
    expect(w.find('.cmp .cmp__empty[role="status"]').text()).toBe('Đang đọc cài đặt từ 23/64 phím…');
    perf.loading = false;
    perf.loadError = 'boom';
    await nextTick();
    expect(cards(w)[0].find('.pfc__bad').text()).toBe('Không đọc được cài đặt hành trình.');
    const reload = vi.spyOn(perf, 'load').mockResolvedValue(undefined);
    await w.find('.cmp .cmp__empty button').trigger('click');
    expect(reload).toHaveBeenCalledWith(true);
  });
});

describe('Profiles: switching (§5, items 8, 9)', () => {
  it('item 9: "Use this profile" on card 1 → switchProfile(0) once, busy meanwhile; then card 1 is active, A = 1, focus on its title', async () => {
    await openTwo();
    const { w, device, perf } = await mountPage();
    expect(device.activeProfile).toBe(1);
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]);
    const sw = vi.spyOn(device, 'switchProfile');
    const btn = useBtn(w, 0);
    await btn.trigger('click');
    await nextTick();
    expect(sw).toHaveBeenCalledTimes(1);
    expect(sw).toHaveBeenCalledWith(0);
    expect(btn.attributes('aria-busy')).toBe('true');
    expect(useBtn(w, 2).attributes('disabled')).toBeDefined();
    expect(pencil(w, 3).attributes('disabled')).toBeDefined();
    await vi.waitFor(() => expect(device.activeProfile).toBe(0), { timeout: 15000, interval: 5 });
    await idle();
    await vi.waitFor(() => expect(document.activeElement?.id).toBe('pf-name-0'), { timeout: 5000, interval: 5 });
    expect(cards(w)[0].attributes('aria-current')).toBe('true');
    expect(cards(w)[1].find('.pfc__meta').text()).toMatch(/^Số liệu lúc \d\d:\d\d$/);
    expect(perf.profileSnapshots.has(1)).toBe(true);
    expect([checked(w, 0), checked(w, 1)]).toEqual([0, 1]); // A follows the active profile, B swapped to the one left
    expect(sw).toHaveBeenCalledTimes(1);
  });

  it('item 8: a visit when the active profile is read sends nothing; picking A/B 10 times, filtering, scrolling: nothing', async () => {
    await openTwo();
    const { device, perf, mock } = await connect();
    await device.switchProfile(2);
    await perf.load(true);
    const spy = spyExchange(mock);
    const { w } = await mountPage();
    expect(sent(spy)).toEqual([]);
    for (let n = 0; n < 10; n++) {
      const opts = seg(w, n % 2 as 0 | 1).findAll('button:not([disabled])');
      await opts[n % opts.length].trigger('click');
    }
    await w.find('.cmp__filter input').setValue('W');
    await w.find('.cmp__scroll').trigger('scroll');
    await w.find('.cmp__scroll').trigger('keydown', { key: 'PageDown' });
    await flushPromises();
    expect(sent(spy)).toEqual([]);
  });

  it('item 8: the first visit reads the 64 keys of the active profile, nothing else; "Use this profile" = the switch + 64 reads', async () => {
    const { device, mock } = await connect();
    const spy = spyExchange(mock);
    const { w } = await mountPage();
    expect(sent(spy).filter((f) => f.startsWith('04 01'))).toHaveLength(64);
    expect(sent(spy)).toHaveLength(64);
    spy.mockClear();
    await useBtn(w, 2).trigger('click');
    await vi.waitFor(() => expect(device.activeProfile).toBe(2), { timeout: 15000, interval: 5 });
    await idle();
    const frames = sent(spy);
    expect(frames.filter((f) => f.startsWith('02 03 02'))).toEqual(['02 03 02']); // setActiveProfile, once
    expect(frames.filter((f) => f.startsWith('04 01'))).toHaveLength(64);
    expect(frames.filter((f) => !f.startsWith('04 01') && !f.startsWith('03 01') && f !== '02 03 02')).toEqual([]); // + layer-0 keymap reads
    expect(device.activeProfile).toBe(2);
  });

  it('a switch from the sidebar while this page reads: the read is dropped, that profile stays "not opened", the next read is right', async () => {
    const { device, perf } = await connect();
    await perf.load();
    const router = appRouter();
    await router.push('/profiles');
    const w = mount(RouterView, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await device.switchProfile(1); // the page's listener reads profile 2
    await vi.waitFor(() => expect(perf.loadedCount).toBeGreaterThanOrEqual(10), { timeout: 15000, interval: 2 });
    await device.switchProfile(2); // from the sidebar, mid-read
    await idle();
    expect(device.activeProfile).toBe(2);
    expect(perf.profileSnapshots.has(1)).toBe(false);
    expect(cards(w)[1].find('.pfc__none').text()).toBe('Chưa mở trong phiên này');
    expect(Object.values(perf.values).every((p) => p.mode === 0 && Math.abs(p.normalPress - 2) < 1e-6)).toBe(true);
  });

  it('the listener goes with the page: after unmount a switch reads nothing', async () => {
    const { w, device, mock } = await mountPage();
    w.unmount();
    mounted.length = 0;
    const spy = spyExchange(mock);
    await device.switchProfile(1);
    await flushPromises();
    expect(sent(spy).filter((f) => f.startsWith('04 01'))).toEqual([]);
  });
});

describe('Profiles: compare (§3.5, §3.6, items 4, 5)', () => {
  it('item 4: a profile not opened is listed but locked: disabled, the tip, a click changes nothing, arrows skip it', async () => {
    await openTwo();
    const { w } = await mountPage();
    for (const n of [0, 1] as const) {
      for (const i of [2, 3]) {
        const b = seg(w, n).find(`button[data-v="${i}"]`);
        expect(b.attributes('disabled')).toBeDefined();
        expect(b.attributes('aria-disabled')).toBe('true');
        expect(b.attributes('title')).toBe('Mở profile này một lần để có dữ liệu so sánh');
      }
      expect(seg(w, n).attributes('aria-describedby')).toBe('cmp-missing');
    }
    expect(w.find('#cmp-missing').text()).toBe('Chưa mở trong phiên này: 3 · Typing, 4 · Profile 4. Mở profile một lần để có dữ liệu so sánh.');
    expect(w.findAll('#cmp-missing b').map((b) => b.text())).toEqual(['3 · Typing', '4 · Profile 4']);
    await seg(w, 1).find('button[data-v="2"]').trigger('click');
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]);
    // B = 0: ArrowRight goes to 1 (A's; they swap), never to 2 or 3
    await seg(w, 1).find('button[data-v="0"]').trigger('keydown', { key: 'ArrowRight' });
    expect([checked(w, 0), checked(w, 1)]).toEqual([0, 1]);
    await seg(w, 1).find('button[data-v="1"]').trigger('keydown', { key: 'ArrowRight' });
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]);
  });

  it('A follows the active profile through a switch even when the old one is still opened (B takes the one left)', async () => {
    await openTwo(); // 1 opened (snapshot), 2 active
    const { device, perf } = await connect();
    const off = device.onProfileChanged(() => void perf.load(true));
    await device.switchProfile(0); // now 2 has a snapshot too, 1 is active again
    await idle();
    off();
    const { w } = await mountPage();
    expect([checked(w, 0), checked(w, 1)]).toEqual([0, 1]);
    await useBtn(w, 1).trigger('click');
    await vi.waitFor(() => expect(device.activeProfile).toBe(1), { timeout: 15000, interval: 5 });
    await nextTick();
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]); // at once, while profile 2 is read (its old snapshot still opened)
    await idle();
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]);
    expect(w.find('caption').text()).toBe('Khác biệt giữa A (2 · FPS) và B (1 · Default)');
  });

  it('item 5: A is never B: A = 1, B = 0, pick A = 0 → A = 0, B = 1 (and the other way)', async () => {
    await openTwo();
    const { w } = await mountPage();
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]);
    await seg(w, 0).find('button[data-v="0"]').trigger('click');
    expect([checked(w, 0), checked(w, 1)]).toEqual([0, 1]);
    await seg(w, 1).find('button[data-v="0"]').trigger('click');
    expect([checked(w, 0), checked(w, 1)]).toEqual([1, 0]);
    expect(w.find('caption').text()).toBe('Khác biệt giữa A (2 · FPS) và B (1 · Default)');
  });

  it('the table: one tbody per key, the name in a rowgroup header, values in mm; the head names A and B with their time', async () => {
    await openTwo();
    const { w } = await mountPage();
    expect(w.find('.cmp__count').text()).toBe('132 khác biệt trên 64 phím');
    expect(w.findAll('.cmp__count b').map((b) => b.text())).toEqual(['132', '64']);
    expect(w.findAll('thead th').map((th) => th.text())).toEqual(['Phím', 'Thiết lập', 'A · FPSSố liệu trực tiếp', expect.stringMatching(/^B · DefaultSố liệu lúc \d\d:\d\d$/)]);
    const bodies = w.findAll('.cmp__table tbody');
    expect(bodies).toHaveLength(64);
    const esc = bodies[0];
    expect(esc.find('th[scope="rowgroup"]').text()).toBe('Esc');
    expect(esc.find('th').attributes('rowspan')).toBe('2');
    expect(esc.findAll('tr').map((tr) => tr.findAll('td').map((td) => td.text()))).toEqual([
      ['Chế độ', 'Standard', 'Rapid Trigger'], ['Actuation', '1.2 mm', '1.0 mm'],
    ]);
    const wRows = bodies.find((b) => b.find('th').text() === 'W')!;
    expect(wRows.findAll('tr').map((tr) => tr.findAll('td').map((td) => td.text()))).toEqual([
      ['Actuation', '0.3 mm', '1.0 mm'], ['Độ nhạy nhấn', '0.1 mm', '0.8 mm'], ['Độ nhạy nhả', '0.1 mm', '0.3 mm'],
    ]);
    expect(w.find('.cmp__top').text()).toBe('Nhiều nhất: Chế độ: Standard → Rapid Trigger, 60 phím · Actuation: 1.2 mm → 1.0 mm, 60 phím · Actuation: 0.3 mm → 1.0 mm, 4 phím');
    const scroll = w.find('.cmp__scroll');
    expect(scroll.attributes()).toMatchObject({ tabindex: '0', role: 'region', 'aria-labelledby': 'cmp-cap' });
    expect(w.find('.cmp__note').text()).toBe(`${t('cmp.rtNote')} ${t('cmp.notCompared')}`);
  });

  it('the filter shows only matching keys; the count and "Most common" do not change, only "Showing n/m rows"', async () => {
    await openTwo();
    const { w } = await mountPage();
    const count = w.find('.cmp__count').text();
    const top = w.find('.cmp__top').text();
    expect(w.find('.cmp__shown').exists()).toBe(false);
    await w.find('.cmp__filter input').setValue('space');
    expect(w.find('.cmp__count').text()).toBe(count);
    expect(w.find('.cmp__top').text()).toBe(top);
    expect(w.find('.cmp__shown').text()).toBe('Đang hiện 2/132 dòng');
    expect(w.find('.cmp__shown').attributes('aria-live')).toBe('polite');
    expect(w.findAll('.cmp__table tbody th').map((th) => th.text())).toEqual(['Space']);
    await w.find('.cmp__filter input').setValue('F12');
    expect(w.find('.cmp__count').text()).toBe(count);
    expect(w.find('.cmp__top').text()).toBe(top);
    expect(w.find('.cmp__shown').text()).toBe('Đang hiện 0/132 dòng');
    expect(w.find('.cmp__scroll').exists()).toBe(false);
    expect(w.find('.cmp__empty[role="status"]').text()).toBe('Không có phím nào khớp “F12”.');
  });

  it('two equal profiles: the green "match" line; an unknown switch shows its ID', async () => {
    await openTwo();
    const { w, perf } = await mountPage();
    const snap = perf.profileSnapshots.get(0)!;
    perf.values = Object.fromEntries(Object.entries(snap.values).map(([k, v]) => [k, { ...v }]));
    await nextTick();
    expect(w.find('.cmp__same[role="status"]').text()).toBe('Hai profile giống nhau ở mọi thiết lập được so.');
    expect(w.find('.cmp__table').exists()).toBe(false);
    perf.values = { ...perf.values, 0: { ...perf.values[0], axisV2Id: 65000 } };
    await nextTick();
    expect(w.find('.cmp__count').text()).toBe('1 khác biệt trên 1 phím');
    expect(w.findAll('.cmp__table td').map((td) => td.text())).toEqual(['Switch', 'Switch lạ (ID 65000)', expect.any(String)]);
    expect(w.find('.cmp__top').exists()).toBe(false); // no change on 2 keys or more
  });

  it('en: the count uses plurals (lead\'s decision) and "Most common" its own words', async () => {
    await openTwo();
    const { w, perf } = await mountPage();
    locale.value = 'en';
    await nextTick();
    expect(w.find('.cmp__count').text()).toBe('132 differences on 64 keys');
    expect(w.findAll('.cmp__count b').map((b) => b.text())).toEqual(['132', '64']);
    const snap = perf.profileSnapshots.get(0)!;
    perf.values = { ...Object.fromEntries(Object.entries(snap.values).map(([k, v]) => [k, { ...v }])), 0: { ...snap.values[0], pressDeadStroke: 0.4 } };
    await nextTick();
    expect(w.find('.cmp__count').text()).toBe('1 difference on 1 key');
    expect(w.find('.cmp__count').findAll('b').map((b) => b.text())).toEqual(['1', '1']);
  });
});

describe('Profiles: rename on the card (§3.4, item 6, item 13)', () => {
  it('item 13: the edit takes the place of the head + figures, Cancel/Save the button\'s: nothing is added to the card', async () => {
    const { w } = await mountPage();
    const card = cards(w)[2];
    expect(card.element.children).toHaveLength(3);
    expect([...card.element.children].map((e) => e.className)).toEqual(['pfc__top', 'pfc__body', 'pfc__foot']);
    await pencil(w, 2).trigger('click');
    await flushPromises();
    expect([...card.element.children].map((e) => e.className)).toEqual(['pfc__edit', 'pfc__foot']);
    expect(card.find('.pfc__foot').element.children).toHaveLength(1);
    expect(card.findAll('.pfc__foot button').map((b) => b.text())).toEqual(['Huỷ', 'Lưu']);
    expect(card.attributes('aria-label')).toBe('Profile 3');
    expect(card.attributes('aria-labelledby')).toBeUndefined();
    const css = readFileSync(resolve('src/components/profiles/ProfileCard.vue'), 'utf8');
    expect(css).toMatch(/\.pfc__body \{[^}]*min-height: 62px;/);
    expect(css).toMatch(/\.pfc__edit \{[^}]*min-height: 102px;/);
  });

  it('item 6: 32 bytes at most, cut between characters; "32/32" in the warning colour; the input is focused with the text selected', async () => {
    const { w } = await mountPage();
    await pencil(w, 2).trigger('click');
    await flushPromises();
    const input = cards(w)[2].find('input');
    expect(document.activeElement).toBe(input.element);
    expect(input.attributes('aria-label')).toBe('Tên profile 3');
    expect(input.attributes('aria-describedby')).toBe('pf-help-2');
    expect(input.attributes('maxlength')).toBeUndefined();
    expect(cards(w)[2].find('.pfc__bytes').text()).toBe('6/32 byte');
    await type(input, 'Luyện gõ tiếng Việt có dấu nhanh');
    expect((input.element as HTMLInputElement).value).toBe('Luyện gõ tiếng Việt có d');
    expect(cards(w)[2].find('.pfc__bytes').text()).toBe('32/32 byte');
    expect(cards(w)[2].find('.pfc__count').classes()).toContain('pfc__count--full');
    expect(cards(w)[2].find('.pfc__count span').text()).toBe('Chữ có dấu, chữ Hán: 2–3 byte mỗi chữ.');
  });

  it('item 6: Enter saves once (setProfileName(2, …)) and focus goes back to the pencil; Esc and blur do not save', async () => {
    const { w, mock, device } = await mountPage();
    const set = vi.spyOn(mock, 'setProfileName');
    await pencil(w, 2).trigger('click');
    await flushPromises();
    let input = cards(w)[2].find('input');
    await type(input, 'Gõ văn bản');
    await input.trigger('blur');
    expect(cards(w)[2].find('input').exists()).toBe(true); // blur neither saves nor closes
    await key(input, 'Escape');
    expect(cards(w)[2].find('input').exists()).toBe(false);
    expect(set).not.toHaveBeenCalled();
    await pencil(w, 2).trigger('click');
    await flushPromises();
    input = cards(w)[2].find('input');
    expect((input.element as HTMLInputElement).value).toBe('Typing'); // a new edit starts from the name
    await type(input, 'Gõ văn bản');
    await key(input, 'Enter');
    await vi.waitFor(() => expect(cards(w)[2].find('input').exists()).toBe(false));
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(2, 'Gõ văn bản');
    expect(device.profileNames[2]).toBe('Gõ văn bản');
    await flushPromises();
    expect(document.activeElement).toBe(pencil(w, 2).element);
  });

  it('item 6: Save is off for an empty or unchanged name; a transport error keeps the edit, the text and an alert', async () => {
    const { w, mock } = await mountPage();
    await pencil(w, 1).trigger('click');
    await flushPromises();
    const input = cards(w)[1].find('input');
    const save = () => cards(w)[1].findAll('.pfc__foot button')[1];
    expect(save().attributes('disabled')).toBeDefined(); // unchanged
    await type(input, '   ');
    expect(save().attributes('disabled')).toBeDefined(); // empty after trim
    await type(input, 'Ranked');
    expect(save().attributes('disabled')).toBeUndefined();
    vi.spyOn(mock, 'setProfileName').mockRejectedValue(new Error('HID timeout'));
    await save().trigger('click');
    await flushPromises();
    expect(cards(w)[1].find('input').exists()).toBe(true);
    expect((cards(w)[1].find('input').element as HTMLInputElement).value).toBe('Ranked');
    expect(cards(w)[1].find('input').attributes('aria-invalid')).toBe('true');
    expect(cards(w)[1].find('[role="alert"]').text()).toBe('HID timeout');
    expect(cards(w)[1].find('.pfc__count span:not(.pfc__bytes)').exists()).toBe(false); // the error takes the help line's place
  });

  it('a name that differs only by spaces is unchanged (Pro names end with a space): Save stays off, nothing is written', async () => {
    const { w, device, mock } = await mountPage();
    await device.switchDemoModel('pro');
    await usePerformanceStore().load();
    await idle();
    expect(device.profileNames[2]).toBe('配置三 ');
    const set = vi.spyOn(device.transport as MockTransport, 'setProfileName');
    await pencil(w, 2).trigger('click');
    await flushPromises();
    const input = cards(w)[2].find('input');
    expect((input.element as HTMLInputElement).value).toBe('配置三 ');
    const save = () => cards(w)[2].findAll('.pfc__foot button')[1];
    expect(save().attributes('disabled')).toBeDefined();
    await type(input, '配置三');
    expect(save().attributes('disabled')).toBeDefined();
    await key(input, 'Enter');
    expect(set).not.toHaveBeenCalled();
    expect(mock).not.toBe(device.transport); // the Pro demo is a new transport
  });

  it('IME on the card: no cut while composing, the cut at compositionend; Enter/Esc while composing neither save nor cancel', async () => {
    const { w, mock } = await mountPage();
    const set = vi.spyOn(mock, 'setProfileName');
    await pencil(w, 2).trigger('click');
    await flushPromises();
    const input = cards(w)[2].find('input');
    const el = input.element as HTMLInputElement;
    const han = '配置一二三四五六七八九十'; // 12 × 3 bytes = 36
    await type(input, han, true);
    expect(el.value).toBe(han); // composing: left alone
    expect(cards(w)[2].find('.pfc__bytes').text()).toBe('30/32 byte'); // counted on the cut value
    await key(input, 'Enter', true);
    await key(input, 'Escape', true);
    expect(set).not.toHaveBeenCalled();
    expect(cards(w)[2].find('input').exists()).toBe(true);
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '十' }));
    await nextTick();
    expect(el.value).toBe('配置一二三四五六七八'); // 10 characters, 30 bytes: never half a character
    await key(input, 'Enter');
    await flushPromises();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(2, '配置一二三四五六七八');
  });

  it('one card at a time: the pencil of another card closes the first as Cancel', async () => {
    const { w, mock } = await mountPage();
    const set = vi.spyOn(mock, 'setProfileName');
    await pencil(w, 1).trigger('click');
    await flushPromises();
    await type(cards(w)[1].find('input'), 'Changed');
    await pencil(w, 3).trigger('click');
    await flushPromises();
    expect(cards(w)[1].find('input').exists()).toBe(false);
    expect(cards(w)[3].find('input').exists()).toBe(true);
    expect(set).not.toHaveBeenCalled();
  });

  it('no pencil on a board the app may not write (as in the sidebar)', async () => {
    const { w, device } = await mountPage();
    device.boardAllowed = false;
    await nextTick();
    expect(w.findAll('.pfc__top .ibtn')).toHaveLength(0);
  });
});

describe('Calibration lock (§3.9, item 7)', () => {
  it('item 7: calibrating → the lock line; every "Use" and pencil disabled; clicks call nothing', async () => {
    const { w, device } = await mountPage();
    const sw = vi.spyOn(device, 'switchProfile');
    const rn = vi.spyOn(device, 'renameProfile');
    expect(w.find('.pfs__lock').exists()).toBe(false);
    useCalibrationStore().phase = 'running';
    await nextTick();
    expect(w.find('.pfs__lock[role="status"]').text()).toBe('Đang hiệu chuẩn: hoàn tất hoặc huỷ hiệu chuẩn để chuyển hoặc đổi tên profile.');
    for (const i of [1, 2, 3]) expect(useBtn(w, i).attributes('disabled')).toBeDefined();
    for (const i of [0, 1, 2, 3]) {
      expect(pencil(w, i).attributes('disabled')).toBeDefined();
      expect(pencil(w, i).attributes('title')).toBe(t('device.calibrating'));
    }
    for (const i of [1, 2, 3]) await useBtn(w, i).trigger('click');
    for (const i of [0, 1, 2, 3]) await pencil(w, i).trigger('click');
    await flushPromises();
    expect(w.find('.pfc input').exists()).toBe(false);
    expect(sw).not.toHaveBeenCalled();
    expect(rn).not.toHaveBeenCalled();
  });

  it('item 7: an edit open when calibration starts stays open, Save off until it ends', async () => {
    const { w } = await mountPage();
    await pencil(w, 1).trigger('click');
    await flushPromises();
    await type(cards(w)[1].find('input'), 'Later');
    const save = () => cards(w)[1].findAll('.pfc__foot button')[1];
    expect(save().attributes('disabled')).toBeUndefined();
    useCalibrationStore().phase = 'running';
    await nextTick();
    expect(cards(w)[1].find('input').exists()).toBe(true);
    expect(save().attributes('disabled')).toBeDefined();
    useCalibrationStore().phase = 'idle';
    await nextTick();
    expect(save().attributes('disabled')).toBeUndefined();
  });
});

describe('ProfileSelect (sidebar) fixes (§3.9, items 6, 7)', () => {
  async function sidebar() {
    const { device } = await connect();
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
    await router.push('/');
    const w = mount(ProfileSelect, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await w.get('.ps__trigger').trigger('click');
    return { w, device, rows: () => w.findAll('[role="option"]') };
  }

  it('item 6: 20 CJK letters (60 bytes) → 10 (30 bytes); no maxlength', async () => {
    const { w, rows } = await sidebar();
    await rows()[2].trigger('dblclick');
    await flushPromises();
    const input = w.get('.ps__input');
    expect(input.attributes('maxlength')).toBeUndefined();
    await type(input, '一二三四五六七八九十一二三四五六七八九十');
    expect((input.element as HTMLInputElement).value).toBe('一二三四五六七八九十');
  });

  it('IME in the sidebar: no cut while composing; Enter while composing does not save', async () => {
    const { w, rows, device } = await sidebar();
    const rn = vi.spyOn(device, 'renameProfile').mockResolvedValue(undefined);
    await rows()[2].trigger('dblclick');
    await flushPromises();
    const input = w.get('.ps__input');
    const el = input.element as HTMLInputElement;
    await type(input, '一二三四五六七八九十一', true);
    expect(el.value).toBe('一二三四五六七八九十一');
    await key(input, 'Enter', true);
    expect(rn).not.toHaveBeenCalled();
    expect(w.find('.ps__input').exists()).toBe(true);
    el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    await nextTick();
    expect(el.value).toBe('一二三四五六七八九十');
    await key(input, 'Enter');
    expect(rn).toHaveBeenCalledTimes(1);
    expect(rn).toHaveBeenCalledWith(2, '一二三四五六七八九十');
  });

  it('item 7: calibrating → the pencil is disabled, and neither a double-click nor F2 opens the rename', async () => {
    const { w, rows } = await sidebar();
    useCalibrationStore().phase = 'running';
    await nextTick();
    const pen = rows()[2].find('.ps__edit');
    expect(pen.attributes('disabled')).toBeDefined();
    expect(pen.attributes('title')).toBe(t('device.calibrating'));
    await rows()[2].trigger('dblclick');
    await flushPromises();
    expect(w.find('.ps__input').exists()).toBe(false);
    await rows()[2].trigger('keydown', { key: 'F2' });
    await flushPromises();
    expect(w.find('.ps__input').exists()).toBe(false);
    useCalibrationStore().phase = 'idle';
    await nextTick();
    await rows()[2].trigger('keydown', { key: 'F2' });
    await flushPromises();
    expect(w.find('.ps__input').exists()).toBe(true);
  });
});

describe('Router, sidebar, Settings, strings (items 10, 11, 12)', () => {
  it('item 10: the route is named "profiles" and lazy; the Keyboard group is Overview, Performance, Profiles', async () => {
    const r = appRouter();
    expect(r.hasRoute('profiles')).toBe(true);
    const rec = routes.find((x) => x.name === 'profiles')!;
    expect(rec.path).toBe('/profiles');
    expect(typeof rec.component).toBe('function'); // () => import(…): its own chunk
    expect(rec.meta?.title).toBe('page.profiles');
    expect(NAV[0].group).toBe('nav.groupKeyboard');
    expect(NAV[0].items.map((i) => [i.path, i.title, i.tone])).toEqual([
      ['/overview', 'page.overview', 'var(--f-overview)'],
      ['/performance', 'page.performance', 'var(--f-performance)'],
      ['/profiles', 'page.profiles', 'var(--f-profiles)'],
    ]);
    await r.push('/profiles');
    expect(r.currentRoute.value.name).toBe('profiles');
  });

  it('item 11: Settings has no profile-name input any more, only the subtitle and a link to /profiles', async () => {
    await connect();
    await useSettingsStore().load();
    const router = appRouter();
    const w = mount(SettingsPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await flushPromises();
    const card = w.findAll('.card').find((c) => c.find('.card__title').text() === t('settings.profileNames'))!;
    expect(card.find('.card__sub').text()).toBe('Chuyển, đổi tên và so sánh profile ở trang Profile.');
    expect(card.find('input').exists()).toBe(false);
    const link = card.find('a.btn');
    expect(link.attributes('href')).toBe('/profiles');
    expect(link.text()).toBe('Quản lý profile');
    expect(w.findAll('input[type="text"]')).toHaveLength(0);
  });

  it('item 12: every pf.* and cmp.* key in vi and en (40 new keys with the 2 of Settings); the 3 old Settings keys are gone', () => {
    const keys = Object.keys(profilesVi);
    expect(keys).toHaveLength(38);
    expect(Object.keys(profilesEn).sort()).toEqual([...keys].sort());
    for (const k of [...keys, 'settings.manageProfiles', 'settings.profilesMoved']) {
      expect((viDict as Record<string, string>)[k], k).toBeTruthy();
      expect((enDict as Record<string, string>)[k], k).toBeTruthy();
    }
    for (const k of ['settings.profileRename', 'settings.profileLabel', 'settings.profileNamesDesc']) {
      expect(k in viDict, k).toBe(false);
      expect(k in enDict, k).toBe(false);
    }
  });
});
