// CSW step 4a UI tests: CustomSwitchForm & generic switch declaration (DESIGN §19 Tests 15 and 17).
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
import { GENERIC_CLASSES, GENERIC_START, GENERIC_UID, coefFromTravel } from '../src/data/customSwitch';
import { READY_SWITCHES } from '../src/data/readySwitches';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

let w: VueWrapper | null = null;
const body = () => document.body;
const dialog = () => body().querySelector<HTMLElement>('[role="dialog"]')!;
const footBtn = (text: string) =>
  [...body().querySelectorAll<HTMLButtonElement>('.dlg__foot button')].find((b) => b.textContent?.trim() === text);
const tileByUid = (uid: string) => body().querySelector<HTMLElement>(`.sw-opt[data-uid="${uid}"]`)!;
function spyExchange(mock: MockTransport) {
  const seen = vi.fn();
  const target = mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> };
  const orig = target.exchange.bind(mock);
  // Ignore the periodic active-profile read (02 03 01) sent by watchKeyboardProfile every PROFILE_POLL_MS.
  vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array) => {
    if (!(f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x01)) seen(f);
    return orig(f);
  });
  return seen;
}

async function setup(ids: number[] = [W.id, A.id]) {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(SwitchCard, { props: { ids }, global: { plugins: [router] }, attachTo: document.body });
  (w.findAll('.swc__foot button')[1].element as HTMLElement).click(); // open on Custom tab
  await flushPromises();
  return { device, mock, perf };
}

async function openNewForm() {
  body().querySelector<HTMLButtonElement>('.csw-head__btns button')!.click();
  await flushPromises();
}

async function setInput(el: HTMLInputElement, value: string, blur = false) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  if (blur) el.dispatchEvent(new Event('blur', { bubbles: true }));
  await flushPromises();
}

describe('CustomSwitchForm (DESIGN §19 Test 15)', () => {
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

  it('validates required fields, folded unique names, Esc returns without closing dialog, and Save focuses new tile with 0 HID', async () => {
    const { mock, perf } = await setup();
    const ex = spyExchange(mock);
    await openNewForm();
    expect(body().querySelector('.dlg__title')?.textContent).toBe(t('csw.formNew'));

    // Submit empty -> nameRequired, aria-invalid, focus on name input
    footBtn(t('csw.save'))!.click();
    await flushPromises();
    const nameIn = body().querySelector<HTMLInputElement>('input[placeholder*="WS Flux"]')!;
    expect(nameIn.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(nameIn.getAttribute('aria-describedby')!)?.textContent).toContain(t('csw.nameRequired'));
    expect(document.activeElement).toBe(nameIn);

    // Fill name, leave travel empty -> travelRequired
    await setInput(nameIn, 'Dash tím');
    footBtn(t('csw.save'))!.click();
    await flushPromises();
    expect(body().querySelector('.csw-err')?.textContent).toContain(t('csw.travelRequired'));

    // Esc inside form goes back to custom tab WITHOUT closing dialog
    nameIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(dialog()).not.toBeNull();
    expect(body().querySelector('.csw-form')).toBeNull();
    expect(perf.customSwitches).toHaveLength(0);

    // Reopen, fill fields with travel estimate curve and colour, save -> 0 HID, tile chosen & focused
    await openNewForm();
    const name2 = body().querySelector<HTMLInputElement>('input[placeholder*="WS Flux"]')!;
    const maker2 = body().querySelector<HTMLInputElement>('input[placeholder*="Wuque Studio"]')!;
    const travel2 = body().querySelector<HTMLInputElement>('.nf__input')!;
    const note2 = body().querySelector<HTMLInputElement>('input[placeholder*="lube"]')!;
    await setInput(name2, 'Dash tím');
    await setInput(maker2, 'Wuque Studio');
    await setInput(travel2, '3.45', true);
    await setInput(note2, 'Lube tay');

    // Select "Ước tính từ hành trình" radio
    const travelRadio = body().querySelector<HTMLInputElement>('input[type="radio"][value="travel"]')!;
    travelRadio.checked = true;
    travelRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    expect(body().querySelector('.csw-coefval')?.textContent).toBe(t('csw.fCoefValue', { coef: coefFromTravel(3450) }));

    // Pick purple colour
    const purple = body().querySelector<HTMLElement>(`.csw-dot[aria-label="${t('csw.color.purple')}"]`)!;
    purple.click();
    await flushPromises();

    footBtn(t('csw.save'))!.click();
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.customSwitches).toHaveLength(1);
    const saved = perf.customSwitches[0];
    expect(saved).toMatchObject({
      name: 'Dash tím',
      maker: 'Wuque Studio',
      travelUm: 3450,
      rangeUm: 3450,
      coefficient: 20200,
      curve: { kind: 'travel' },
      color: '#9b6cf0',
      note: 'Lube tay',
    });
    expect(useToast().items.value.at(-1)?.text).toBe(t('csw.saved', { name: 'Dash tím' }));
    expect(tileByUid(saved.uid).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(tileByUid(saved.uid));
    expect(body().querySelector('.csw-noteline')?.textContent).toContain('Lube tay');

    // Folded duplicate name ('dash tim') blocks Save
    await openNewForm();
    const name3 = body().querySelector<HTMLInputElement>('input[placeholder*="WS Flux"]')!;
    await setInput(name3, 'dash tim');
    await setInput(body().querySelector<HTMLInputElement>('.nf__input')!, '3.5', true);
    footBtn(t('csw.save'))!.click();
    await flushPromises();
    expect(body().querySelector('.csw-err')?.textContent).toContain(t('csw.nameTaken'));
    expect(perf.customSwitches).toHaveLength(1);
    expect(ex).not.toHaveBeenCalled();
  });

  it('curve radios, manual clamp, notes (travel clamp, sameAsCatalog, nameCatalog) and copy-from-ready-made', async () => {
    const { mock } = await setup();
    const ex = spyExchange(mock);
    await openNewForm();

    const nameIn = body().querySelector<HTMLInputElement>('input[placeholder*="WS Flux"]')!;
    const travelIn = body().querySelector<HTMLInputElement>('.nf__input')!;

    // Travel 3.0 -> travelClamp note; name 'Skyline V3' -> nameCatalog note
    await setInput(nameIn, 'Skyline V3');
    await setInput(travelIn, '3.0', true);
    expect(body().querySelector('.csw-preview')?.textContent).toContain(
      t('csw.fTravelClamp', { min: '3.13', max: '4.015', used: '3.13', diff: '0.13' }),
    );
    expect(body().querySelector('.csw-preview')?.textContent).toContain('Skyline V3');
    expect(body().querySelector('.csw-preview')?.textContent).toContain(t('csw.saveNote'));

    // Travel 3.5 -> suggested Skyline V3 (3500 / 17536) -> sameAsCatalog note
    await setInput(travelIn, '3.5', true);
    expect(body().querySelector('.csw-preview')?.textContent).toContain(t('csw.sameAsCatalog', { name: 'Skyline V3' }));

    // Manual curve: out-of-bounds 10000 clamps on blur to 13300 with fCoefClamp + fCoefNote
    const manualRadio = body().querySelector<HTMLInputElement>('input[type="radio"][value="manual"]')!;
    manualRadio.checked = true;
    manualRadio.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();
    const coefIn = body().querySelector<HTMLInputElement>('.csw-coefin')!;
    await setInput(coefIn, '10000', true);
    expect(coefIn.value).toBe('13300');
    expect(body().querySelector('.csw-curve')?.textContent).toContain(t('csw.fCoefClamp', { used: 13300, min: 13300, max: 26800 }));
    expect(body().querySelector('.csw-curve')?.textContent).toContain(t('csw.fCoefNote', { min: 13300, max: 26800 }));

    // Cancel back to custom tab, choose WS Flux and click "Tạo bản sao để sửa"
    footBtn(t('csw.cancel'))!.click();
    await flushPromises();
    const flux = READY_SWITCHES.find((r) => r.name === 'WS Flux')!;
    tileByUid(flux.uid).click();
    await flushPromises();
    body().querySelector<HTMLButtonElement>('.csw-acts button')!.click();
    await flushPromises();
    expect(body().querySelector<HTMLInputElement>('input[placeholder*="WS Flux"]')!.value).toBe('WS Flux (2)');
    expect(body().querySelector<HTMLSelectElement>('.csw-select')!.value).toBe(String(flux.curveFrom.id));
    expect(ex).not.toHaveBeenCalled();
  });

  it('edit shows inUseEdit when values change, and in-place delete removes entry & assignments with 0 HID', async () => {
    const { mock, perf } = await setup([W.id]);
    const entry = {
      uid: 'u-001122334455' as const,
      name: 'My Switch',
      maker: 'MyMaker',
      travelUm: 3500,
      rangeUm: 3500,
      coefficient: 19850,
      curve: { kind: 'travel' as const },
      color: '',
      note: '',
    };
    perf.saveCustomSwitch(entry);
    perf.applySwitch({ kind: 'custom', custom: { uid: entry.uid, name: entry.name, maker: entry.maker, rangeUm: entry.rangeUm, coefficient: entry.coefficient } }, [W.id], 'notReplaced');
    await useSyncStore().flush();

    const ex = spyExchange(mock);
    tileByUid(entry.uid).click();
    await flushPromises();
    // Entry action button is visible even when all selected keys already carry this switch!
    const editBtn = body().querySelector<HTMLButtonElement>('.csw-acts button')!;
    expect(editBtn.textContent?.trim()).toBe(t('csw.edit'));
    editBtn.click();
    await flushPromises();
    expect(body().querySelector('.dlg__title')?.textContent).toBe(t('csw.formEdit'));

    // Change travel -> inUseEdit warning appears
    await setInput(body().querySelector<HTMLInputElement>('.nf__input')!, '3.6', true);
    expect(body().querySelector('.csw-preview')?.textContent).toContain(t('csw.inUseEdit', { n: 1 }));

    // Delete in-place confirmation (no second dialog)
    footBtn(t('csw.delete'))!.click();
    await flushPromises();
    expect(body().querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(body().querySelector('.csw-del')?.textContent).toContain(t('csw.delTitle', { name: 'My Switch' }));
    expect(body().querySelector('.csw-del')?.textContent).toContain(t('csw.delBody', { n: 1 }));
    expect(document.activeElement).toBe(footBtn(t('csw.cancel')));

    // Esc cancels delete confirmation without leaving form
    footBtn(t('csw.cancel'))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(body().querySelector('.csw-del')).toBeNull();
    expect(body().querySelector('.csw-form')).not.toBeNull();

    // Confirm delete -> entry & assignment gone, 0 HID
    footBtn(t('csw.delete'))!.click();
    await flushPromises();
    footBtn(t('csw.delete'))!.click();
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.customSwitches).toHaveLength(0);
    expect(perf.assignments[W.id]).toBeUndefined();
    expect(useToast().items.value.at(-1)?.text).toBe(t('csw.deleted', { name: 'My Switch' }));
  });
});

describe('Generic switch declaration form (DESIGN §19 Test 17)', () => {
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

  it('defaults to 3400/20550, every class chip matches §5.7, "Số khác" 3.45 -> 20200, "Về mặc định" only selects 3.40, saving writes 0 HID', async () => {
    const { mock, perf } = await setup([W.id]);
    const ex = spyExchange(mock);
    expect(perf.genericEntry.rangeUm).toBe(3400);
    expect(perf.genericEntry.coefficient).toBe(20550);

    tileByUid(GENERIC_UID).click();
    await flushPromises();
    expect(body().querySelector('.swp__sum')?.textContent).toContain(t('csw.genericNote'));
    body().querySelector<HTMLButtonElement>('.csw-acts button')!.click();
    await flushPromises();
    expect(body().querySelector('.dlg__title')?.textContent).toBe(t('csw.formGeneric'));

    const chips = [...body().querySelectorAll<HTMLButtonElement>('.csw-chip')];
    expect(chips).toHaveLength(GENERIC_CLASSES.length + 1);
    const expected: Record<number, number> = { 3200: 25728, 3400: 20550, 3500: 19850, 3600: 18750, 3800: 16925, 4000: 15100 };
    for (let i = 0; i < GENERIC_CLASSES.length; i++) {
      const r = GENERIC_CLASSES[i];
      chips[i].click();
      await flushPromises();
      expect(body().querySelector('.csw-writes')?.textContent).toContain(`${r} µm`);
      expect(body().querySelector('.csw-writes')?.textContent).toContain(String(expected[r]));
    }

    // At 4.00 mm, "Về mặc định" appears; clicking it ONLY selects 3.40 chip (does NOT save!)
    const resetBtn = footBtn(t('csw.genericReset', { mm: '3.40' }))!;
    expect(resetBtn).toBeDefined();
    resetBtn.click();
    await flushPromises();
    expect(chips[GENERIC_CLASSES.indexOf(GENERIC_START)].getAttribute('aria-checked')).toBe('true');
    expect(body().querySelector('.csw-form')).not.toBeNull();
    expect(footBtn(t('csw.genericReset', { mm: '3.40' }))).toBeUndefined();

    // Select "Số khác" and enter 3.45 -> 3450 / 20200 with fGenericCurveTyped
    chips.at(-1)!.click();
    await flushPromises();
    const otherIn = body().querySelector<HTMLInputElement>('.nf__input')!;
    expect(otherIn.disabled).toBe(false);
    await setInput(otherIn, '3.45', true);
    expect(body().querySelector('.csw-fixed')?.textContent).toBe(t('csw.fGenericCurveTyped', { coef: 20200 }));

    // Save writes 0 HID, saves ae64.switch.generic, returns with generic chosen & focused
    footBtn(t('csw.save'))!.click();
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.genericEntry.rangeUm).toBe(3450);
    expect(perf.genericEntry.coefficient).toBe(20200);
    expect(useToast().items.value.at(-1)?.text).toBe(t('csw.genericSaved', { mm: '3.45' }));
    expect(tileByUid(GENERIC_UID).getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(tileByUid(GENERIC_UID));
  });
});
