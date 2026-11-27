// CSW step 4a UI tests: SwitchPicker & SwitchCard (DESIGN §19 Tests 16, 17 picker part, 21 clamp parity, §7.5–7.8).
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { CUSTOM_SWITCH_MAX, GENERIC_UID } from '../src/data/customSwitch';
import type { CustomSwitch } from '../src/data/customSwitch';
import { INCOMPATIBLE_SWITCHES, READY_SWITCHES } from '../src/data/readySwitches';
import { findSwitch } from '../src/protocol/switches';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { isProfilePoll } from './helpers/profilePoll';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;
const S = PHYSICAL_KEYS.find((k) => k.name === 'S')!;
const D = PHYSICAL_KEYS.find((k) => k.name === 'D')!;
const WASD = [W.id, A.id, S.id, D.id];

let w: VueWrapper | null = null;
const body = () => document.body;
const dialog = () => body().querySelector<HTMLElement>('[role="dialog"]')!;
const tabs = () => [...body().querySelectorAll<HTMLElement>('[role="tab"]')];
const tabById = (id: string) => body().querySelector<HTMLElement>(`[role="tab"][data-id="${id}"]`)!;
const tileByUid = (uid: string) => body().querySelector<HTMLElement>(`.sw-opt[data-uid="${uid}"]`)!;
const footBtns = () => [...body().querySelectorAll<HTMLButtonElement>('.dlg__foot button')];
const footBtn = (text: string) => footBtns().find((b) => b.textContent?.trim() === text);
function spyExchange(mock: MockTransport) {
  const seen = vi.fn();
  const target = mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> };
  const orig = target.exchange.bind(mock);
  // Ignore the periodic active-profile read (02 03 01) sent by watchKeyboardProfile every PROFILE_POLL_MS.
  vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array) => {
    if (!isProfilePoll(f)) seen(f);
    return orig(f);
  });
  return seen;
}

async function setup(ids: number[] = WASD) {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(SwitchCard, { props: { ids }, global: { plugins: [router] }, attachTo: document.body });
  return { device, mock, perf };
}

async function openDefault() {
  (w!.findAll('.swc__foot button')[0].element as HTMLElement).click();
  await flushPromises();
}

async function openCustom() {
  (w!.findAll('.swc__foot button')[1].element as HTMLElement).click();
  await flushPromises();
}

describe('SwitchPicker & SwitchCard (DESIGN §19 Test 16)', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
    locale.value = 'vi';
    useToast().items.value = [];
  });
  afterEach(() => {
    w?.unmount();
    w = null;
    document.body.innerHTML = '';
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('custom tab is last with icon and separator, counts ready + yours + generic (not incompatible), header says all 4 profiles', async () => {
    const { mock } = await setup();
    const ex = spyExchange(mock);
    await openDefault();

    // Header line: all 4 profiles, no sw.forProfile / sw.profileOnly
    expect(body().querySelector('.swp__for')?.textContent).toBe(`${t('sw.forKeys', { n: 4 })} · ${t('sw.forBoard')}`);
    expect(body().textContent).not.toContain('Chỉ đổi trong profile'); // sw.profileOnly is gone (§17.1)

    // Custom tab last, with separator before it and icon inside
    const list = tabs();
    const last = list.at(-1)!;
    expect(last.dataset.id).toBe('custom');
    expect(last.querySelector('.tabs__icon')).not.toBeNull();
    expect(last.previousElementSibling?.classList.contains('tabs__sep')).toBe(true);
    expect(last.querySelector('.tabs__n')?.textContent).toBe(String(READY_SWITCHES.length + 1));
    expect(ex).not.toHaveBeenCalled();
  });

  it('SwitchCard second button opens directly on the custom tab; one radiogroup with roving stop; disclosures sit outside radiogroup', async () => {
    const { mock } = await setup();
    const ex = spyExchange(mock);
    const btns = w!.findAll('.swc__foot button');
    expect(btns).toHaveLength(2);
    expect(btns[1].text()).toBe(t('csw.open'));

    await openCustom();
    expect(tabById('custom').getAttribute('aria-selected')).toBe('true');

    // One radiogroup over all sections, with exactly one tabindex=0 stop even when nothing is chosen
    const groups = body().querySelectorAll('.csw-scroll [role="radiogroup"]');
    expect(groups).toHaveLength(1);
    const stops = [...groups[0].querySelectorAll('[tabindex="0"]')];
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(tileByUid(READY_SWITCHES[0].uid));

    // Disclosures open at the top of .csw-scroll, outside role=radiogroup, and close each other
    const whyBtn = body().querySelector<HTMLButtonElement>('.csw-why')!;
    const packBtn = [...body().querySelectorAll<HTMLButtonElement>('.csw-head__btns button')][1];
    whyBtn.click();
    await flushPromises();
    const whyBody = body().querySelector('.csw-whybody')!;
    expect(whyBody).not.toBeNull();
    expect(whyBody.closest('[role="radiogroup"]')).toBeNull();
    expect(whyBody.querySelectorAll('p')).toHaveLength(4);
    expect(whyBtn.getAttribute('aria-expanded')).toBe('true');

    packBtn.click();
    await flushPromises();
    expect(body().querySelector('.csw-whybody')).toBeNull();
    const packPanel = body().querySelector('.csw-packpanel')!;
    expect(packPanel).not.toBeNull();
    expect(packPanel.closest('[role="radiogroup"]')).toBeNull();
    expect(packBtn.getAttribute('aria-expanded')).toBe('true');
    expect(ex).not.toHaveBeenCalled();
  });

  it('not-usable tiles are aria-disabled, skipped by arrow keys and cannot be selected or applied', async () => {
    await setup();
    await openCustom();
    const bad = [...body().querySelectorAll<HTMLElement>('.sw-opt[aria-disabled="true"]')];
    expect(bad).toHaveLength(INCOMPATIBLE_SWITCHES.length);
    for (const el of bad) expect(el.getAttribute('tabindex')).toBe('-1');

    // Clicking a not-usable tile chooses nothing and keeps Apply disabled
    bad[0].click();
    await flushPromises();
    expect(body().querySelector('.swp__idle')?.textContent).toBe(t('csw.idle'));
    expect(footBtn(t('sw.applyBare'))!.disabled).toBe(true);

    // End lands on the generic switch (last usable tile), skipping all not-usable tiles; ArrowRight wraps to first ready-made
    const first = tileByUid(READY_SWITCHES[0].uid);
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(tileByUid(GENERIC_UID));
    expect(tileByUid(GENERIC_UID).getAttribute('aria-checked')).toBe('true');

    tileByUid(GENERIC_UID).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await flushPromises();
    expect(document.activeElement).toBe(first);
  });

  it('search filters across sections, finds both sides of a collision ("aurora"), keeps generic on no-match, Esc clears search without closing', async () => {
    const { mock } = await setup();
    const ex = spyExchange(mock);
    await openCustom();
    const search = body().querySelector<HTMLInputElement>('.csw-search__in')!;

    // Collision: Kailh Aurora Magnetic & Keychron Gateron Double-Rail Magnetic Aurora both shown
    search.value = 'aurora';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    const shownNames = [...body().querySelectorAll('.csw-radios .sw-opt__name')].map((x) => x.textContent);
    expect(shownNames).toContain('Aurora Magnetic');
    expect(shownNames).toContain('Gateron Double-Rail Magnetic Aurora');
    expect(shownNames).toContain(t('csw.generic'));

    // Choose one, then search for a non-matching term: chosen stays chosen and generic stays visible under csw.noMatch
    const fluxUid = READY_SWITCHES.find((r) => r.name === 'WS Flux')!.uid;
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    tileByUid(fluxUid).click();
    await flushPromises();

    search.value = 'NoSuchSwitch999';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    expect(body().querySelector('.csw-nomatch')?.textContent).toContain('NoSuchSwitch999');
    expect(tileByUid(GENERIC_UID)).not.toBeNull();
    expect(body().querySelector('.swp__sum')?.textContent).toContain('WS Flux');

    // Esc in non-empty search clears it and does NOT close dialog
    search.focus();
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(search.value).toBe('');
    expect(dialog()).not.toBeNull();
    expect(ex).not.toHaveBeenCalled();
  });

  it('swap question on custom Apply (idKept > 0): Back/Esc writes 0 HID, tab/choice change cancels, Đã thay marks recal, Chưa thay does not', async () => {
    const { mock, perf } = await setup();
    const ex = spyExchange(mock);
    await openCustom();

    const flux = READY_SWITCHES.find((r) => r.name === 'WS Flux')!;
    tileByUid(flux.uid).click();
    await flushPromises();
    // WS Flux shares 3500/17536 with Skyline V3 -> csw.sumSame
    expect(body().querySelector('.swp__sum')?.textContent).toContain('3500 µm');
    expect(body().querySelector('.swp__sum')?.textContent).toContain('17536');

    // First click on Apply opens swap question with 0 HID
    footBtn(t('sw.apply', { n: 4 }))!.click();
    await flushPromises();
    expect(body().querySelector('.csw-ask')).not.toBeNull();
    expect(document.activeElement).toBe(footBtn(t('sw.askYes')));
    expect(ex).not.toHaveBeenCalled();

    // Esc cancels question without closing dialog and focuses Apply (0 HID)
    footBtn(t('sw.askYes'))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(dialog()).not.toBeNull();
    expect(body().querySelector('.csw-ask')).toBeNull();
    expect(document.activeElement).toBe(footBtn(t('sw.apply', { n: 4 })));
    expect(ex).not.toHaveBeenCalled();

    // Open question again, then switching tabs cancels it
    footBtn(t('sw.apply', { n: 4 }))!.click();
    await flushPromises();
    expect(body().querySelector('.csw-ask')).not.toBeNull();
    tabById('Gateron').click();
    await flushPromises();
    expect(body().querySelector('.csw-ask')).toBeNull();
    tabById('custom').click();
    await flushPromises();

    // Open question again and press "Quay lại": 0 HID
    footBtn(t('sw.apply', { n: 4 }))!.click();
    await flushPromises();
    footBtn(t('sw.askBack'))!.click();
    await flushPromises();
    expect(body().querySelector('.csw-ask')).toBeNull();
    expect(ex).not.toHaveBeenCalled();

    // Open question and press "Đã thay, áp dụng": writes 4 keys, marks recal, shows sw.appliedMarked
    footBtn(t('sw.apply', { n: 4 }))!.click();
    await flushPromises();
    footBtn(t('sw.askYes'))!.click();
    await flushPromises();
    expect(body().querySelector('[role="dialog"]')).toBeNull();
    expect(useToast().items.value.at(-1)?.text).toBe(t('sw.appliedMarked', { n: 4, name: 'WS Flux' }));
    await useSyncStore().flush();
    expect(perf.recalKeys).toEqual([...WASD].sort((a, b) => a - b));
    expect(perf.assignments[W.id]).toBe(flux.uid);
    expect(w!.find('.swc__name').text()).toBe('WS Flux');

    // Reopening default picker when most-used switch is custom opens directly on custom tab with "Hiện tại" tag
    await openDefault();
    expect(tabById('custom').getAttribute('aria-selected')).toBe('true');
    expect(tileByUid(flux.uid).querySelector('.sw-opt__tag')?.textContent).toBe(t('sw.inUse'));
  });

  it('rename-only Apply writes 0 HID, skips swap question, shows csw.renameOnly and csw.renamed toast', async () => {
    const { mock, perf } = await setup();
    const flux = READY_SWITCHES.find((r) => r.name === 'WS Flux')!;
    const twin = READY_SWITCHES.find((r) => r.uid !== flux.uid && r.rangeUm === flux.rangeUm && r.coefficient === flux.coefficient)!;
    // Apply WS Flux first
    perf.applySwitch({ kind: 'custom', custom: { uid: flux.uid, name: flux.name, maker: flux.maker, rangeUm: flux.rangeUm, coefficient: flux.coefficient, curveFrom: { id: flux.curveFrom.id } } }, WASD, 'notReplaced');
    await useSyncStore().flush();

    const ex = spyExchange(mock);
    await openCustom();
    tileByUid(twin.uid).click();
    await flushPromises();
    expect(body().querySelector('.swp__sum')?.textContent).toContain(t('csw.renameOnly'));
    const apply = footBtn(t('csw.renameApply', { n: 4 }))!;
    expect(apply).toBeDefined();
    apply.click();
    await flushPromises();
    await useSyncStore().flush();
    expect(ex).not.toHaveBeenCalled();
    expect(body().querySelector('[role="dialog"]')).toBeNull();
    expect(useToast().items.value.at(-1)?.text).toBe(t('csw.renamed', { n: 4, name: twin.name }));
    expect(perf.assignments[W.id]).toBe(twin.uid);
  });

  it('counts a key with both actuation and deadzone clamped in both sw.clampAct and sw.clampOther (Test 21)', async () => {
    const { mock, perf } = await setup([W.id]);
    const pos = `${W.row}:${W.col}`;
    const m = mock as unknown as { profiles: { perf: Map<string, number[]> }[]; active: number };
    const rec = m.profiles[m.active].perf.get(pos)!;
    rec[0] = 0; // Standard
    rec[1] = 4010 & 0xff; rec[2] = 4010 >>> 8; // normalPress 4.01
    rec[3] = 4010 & 0xff; rec[4] = 4010 >>> 8; // normalRelease 4.01
    rec[11] = 3500 & 0xff; rec[12] = 3500 >>> 8; // pressDeadStroke 3.50
    await perf.load(true);

    await openDefault();
    tabById('Gateron').click();
    await flushPromises();
    const jadePro = findSwitch(perf.catalog, 4128)!; // 3390 µm
    const tile = [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === 'Magnetic Jade Pro')!;
    tile.click();
    await flushPromises();
    const warns = [...body().querySelectorAll('.swp__warn')].map((p) => p.textContent);
    expect(warns).toContain(t('sw.clampAct', { n: 1, max: '3.39' }));
    expect(warns).toContain(t('sw.clampOther', { n: 1, max: '3.39' }));
    expect(warns).toContain(t('sw.clearsCal', { n: 1 }));
    // sw.otherProfiles shows because new R (3390) > cur R (3310) is false; test deeper with Apollo (3130 < 3310)
    const apollo = [...body().querySelectorAll<HTMLElement>('.sw-opt')].find((o) => o.querySelector('.sw-opt__name')?.textContent === 'Apollo')!;
    apollo.click();
    await flushPromises();
    expect(body().querySelector('.swp__sum')?.textContent).toContain(t('sw.otherProfiles', { max: '3.13' }));
    expect(jadePro.rangeMax).toBe(3390);
  });

  it('at 50 user switches Create is disabled with title=csw.full and csw.full note shows at top of scroll area', async () => {
    const { perf } = await setup();
    const fifty: CustomSwitch[] = Array.from({ length: CUSTOM_SWITCH_MAX }, (_, i) => ({
      uid: `u-${String(i).padStart(12, '0')}`,
      name: `Custom ${i + 1}`,
      maker: '',
      travelUm: 3500,
      rangeUm: 3500,
      coefficient: 19850,
      curve: { kind: 'travel' },
      color: '',
      note: '',
    }));
    perf.addCustomSwitches(fifty);
    await openCustom();
    const createBtn = body().querySelector<HTMLButtonElement>('.csw-head__btns button')!;
    expect(createBtn.disabled).toBe(true);
    expect(createBtn.title).toBe(t('csw.full'));
    expect(body().querySelector('.csw-full-note')?.textContent).toContain(t('csw.full'));
  });

  it('openPicker({ uid }) opens on custom tab with that entry chosen and writes 0 HID', async () => {
    const { mock } = await setup();
    const ex = spyExchange(mock);
    const flux = READY_SWITCHES.find((r) => r.name === 'WS Flux')!;
    (w!.vm as unknown as { openPicker: (init?: { uid: string } | null) => void }).openPicker({ uid: flux.uid });
    await flushPromises();
    expect(tabById('custom').getAttribute('aria-selected')).toBe('true');
    expect(tileByUid(flux.uid).getAttribute('aria-checked')).toBe('true');
    expect(ex).not.toHaveBeenCalled();
  });

  it('CSS rules enforce §7.7 reserved heights so box + summary stay constant across tabs', () => {
    const src = readFileSync('src/components/performance/SwitchPicker.vue', 'utf8');
    expect(src).toContain('min-height: 112px;');
    expect(src).toContain('.swp__sum--custom { min-height: 221px; }');
    expect(src).toContain('height: calc(clamp(160px, 100vh - 460px, 372px) + 112px - 221px);');
    expect(src).toContain('min-height: min-content;');
    expect(src).toMatch(/\.csw-scroll\s*\{[^}]*flex:\s*1 1 0;[^}]*min-height:\s*150px;/);
  });
});
