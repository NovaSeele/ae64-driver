// Đèn on the workbench (WORKBENCH-1 W5): effect numbers, the strip ring by keyboard, the strip selection bar, the palette
// popover, the per-key colour column and the Off state. Every control still calls the same store action as before.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { MockTransport, PHYSICAL_KEYS, STRIP_ORDER, STRIP_SIDES } from '../src/protocol';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useLightingStore } from '../src/stores/lighting';
import { useSelectionStore } from '../src/stores/selection';
import { useSyncStore } from '../src/stores/sync';
import LightingPage from '../src/pages/LightingPage.vue';
import ColorPicker from '../src/components/ui/ColorPicker.vue';

// Each case loads a demo keyboard in real time (the 5 s default flakes under a loaded full-suite run).
vi.setConfig({ testTimeout: 30000 });

let page: VueWrapper | null = null;

async function mountPage(model: 'max' | 'pro' = 'max') {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 400 } }]); }
    disconnect() {}
  });
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo(model);
  const mock = device.transport as MockTransport;
  (mock as any).latencyMs = 0;
  const lighting = useLightingStore();
  await lighting.load();
  page = mount(LightingPage, { attachTo: document.body });
  await flushPromises();
  lighting.stopLivePolling(); // the poll reads the LED matrix on its own; only the page's own controls are under test
  await new Promise((r) => setTimeout(r, 250)); // let a poll already in flight finish
  await flushPromises();
  return { device, mock, lighting, history: useHistoryStore(), sync: useSyncStore(), sel: useSelectionStore() };
}

beforeEach(() => setLocale('vi'));
afterEach(async () => {
  page?.unmount();
  page = null;
  await flushPromises();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tab = (id: 'keys' | 'strip') => page!.find(`[role="tab"][data-id="${id}"]`);
const effects = () => page!.findAll('.effect-btn');
const leds = () => page!.findAll('.led');
const led = (n: number) => page!.find(`.led[data-led="${n}"]`);
const sorted = (a: number[]) => [...a].sort((x, y) => x - y);
const selectedLeds = () => sorted(leds().filter((l) => l.attributes('aria-pressed') === 'true').map((l) => Number(l.attributes('data-led'))));
const popover = () => document.body.querySelector<HTMLElement>('.pop');
const spyExchange = (mock: MockTransport) => vi.spyOn(mock as unknown as { exchange: () => unknown }, 'exchange');
const keyIds = (...names: string[]) => names.map((n) => PHYSICAL_KEYS.find((k) => k.name === n)!.id);
const activeLed = () => Number((document.activeElement as HTMLElement | null)?.dataset.led);

async function toStrip() {
  await tab('strip').trigger('click');
  await flushPromises();
}

describe('Đèn workbench: effects', () => {
  it('shows number buttons labelled "Hiệu ứng N": Max 19, strip 5; the active one is marked', async () => {
    const { lighting } = await mountPage('max');
    expect(effects()).toHaveLength(19);
    expect(effects()[0].attributes('aria-label')).toBe('Hiệu ứng 1 · Tĩnh');
    expect(effects()[18].attributes('aria-label')).toBe('Hiệu ứng 19 · Phản hồi khi gõ');
    expect(effects()[18].text()).toBe('19');
    const active = effects().filter((b) => b.attributes('aria-pressed') === 'true');
    expect(active).toHaveLength(1);
    expect(effects().findIndex((b) => b.attributes('aria-pressed') === 'true')).toBe(lighting.area0Base.mode);
    expect(active[0].classes()).toContain('effect-btn--active');

    await toStrip();
    expect(effects()).toHaveLength(5);
    const stripActive = effects().filter((b) => b.attributes('aria-pressed') === 'true');
    expect(stripActive).toHaveLength(1);
    expect(effects().findIndex((b) => b.attributes('aria-pressed') === 'true')).toBe(lighting.area1Base.mode);
  });

  it('shows 20 effects on a Pro', async () => {
    await mountPage('pro');
    expect(effects()).toHaveLength(20);
    expect(effects()[19].attributes('aria-label')).toBe('Hiệu ứng 20');
  });

  it('writes the effect through applyBase on click', async () => {
    const { lighting, sync, mock } = await mountPage();
    await effects()[4].trigger('click');
    await sync.flush();
    expect((await mock.getLightingBase(0)).mode).toBe(4);
    expect(lighting.area0Base.mode).toBe(4);
  });
});

describe('Đèn workbench: the strip ring on the strip tab', () => {
  it('draws 38 LED buttons; on the keys tab they are display only', async () => {
    await mountPage();
    expect(leds()).toHaveLength(38);
    expect(leds().every((l) => l.attributes('disabled') !== undefined)).toBe(true);
    expect(leds().every((l) => l.attributes('aria-pressed') === undefined)).toBe(true);
    expect(led(7).attributes('aria-label')).toBe('LED 7, cạnh dưới');
    await toStrip();
    expect(leds().every((l) => l.attributes('disabled') === undefined)).toBe(true);
    expect(page!.find('[role="group"][aria-label="Dải đèn viền, 38 LED"]').exists()).toBe(true);
  });

  it('is one Tab stop; arrows, Home and End move focus in ring order', async () => {
    await mountPage();
    await toStrip();
    const stops = () => leds().filter((l) => l.attributes('tabindex') === '0').map((l) => l.attributes('data-led'));
    expect(stops()).toEqual([String(STRIP_ORDER[0])]);

    await led(STRIP_ORDER[0]).trigger('keydown', { key: 'ArrowRight' });
    expect(activeLed()).toBe(STRIP_ORDER[1]);
    await led(STRIP_ORDER[1]).trigger('keydown', { key: 'ArrowDown' });
    expect(activeLed()).toBe(STRIP_ORDER[2]);
    await led(STRIP_ORDER[2]).trigger('keydown', { key: 'ArrowLeft' });
    expect(activeLed()).toBe(STRIP_ORDER[1]);
    await led(STRIP_ORDER[1]).trigger('keydown', { key: 'ArrowUp' });
    expect(activeLed()).toBe(STRIP_ORDER[0]);
    await led(STRIP_ORDER[0]).trigger('keydown', { key: 'ArrowLeft' }); // wraps to the last
    expect(activeLed()).toBe(STRIP_ORDER[37]);
    await led(STRIP_ORDER[37]).trigger('keydown', { key: 'Home' });
    expect(activeLed()).toBe(STRIP_ORDER[0]);
    await led(STRIP_ORDER[0]).trigger('keydown', { key: 'End' });
    expect(activeLed()).toBe(STRIP_ORDER[37]);
    expect(stops()).toEqual([String(STRIP_ORDER[37])]); // still one Tab stop, now on the focused LED
  });

  it('Space and Enter toggle aria-pressed; Esc clears the selection and writes nothing', async () => {
    const { mock, history } = await mountPage();
    await toStrip();
    await led(7).trigger('keydown', { key: ' ' });
    expect(led(7).attributes('aria-pressed')).toBe('true');
    await led(7).trigger('keydown', { key: ' ' });
    expect(led(7).attributes('aria-pressed')).toBe('false');
    await led(7).trigger('keydown', { key: 'Enter' });
    await led(20).trigger('click');
    expect(selectedLeds()).toEqual([7, 20]);

    const spy = spyExchange(mock);
    await led(7).trigger('keydown', { key: 'Escape' });
    expect(selectedLeds()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(false);
  });

  it('the six strip-bar actions select the same sets as the old presets', async () => {
    await mountPage();
    await toStrip();
    const bar = page!.find('.sb');
    expect(bar.text()).toContain('Chưa chọn LED');
    const act = async (label: string) => { await bar.findAll('button').find((b) => b.text() === label)!.trigger('click'); };

    await act(t('sel.all'));
    expect(selectedLeds()).toEqual(sorted(STRIP_ORDER));
    expect(bar.text()).toContain('Đã chọn 38 LED');
    for (const [label, side] of [['Cạnh trên', 'top'], ['Cạnh phải', 'right'], ['Cạnh dưới', 'bottom'], ['Cạnh trái', 'left']] as const) {
      await act(label);
      expect(selectedLeds(), label).toEqual(sorted(STRIP_SIDES[side]));
    }
    await act(t('sel.clear'));
    expect(selectedLeds()).toEqual([]);
    expect(bar.findAll('button')).toHaveLength(6);
  });
});

describe('Đèn workbench: the palette popover', () => {
  it('"Sửa màu…" opens the editor; a commit makes one palette history entry; Esc closes it and focus returns to the button', async () => {
    const { lighting, history, sync, mock } = await mountPage();
    lighting.applyBase(0, { paletteIndex: 2 }, 'Pick slot 2');
    await sync.flush();
    await flushPromises();
    const btn = page!.find('.pal__edit');
    expect(popover()).toBeNull();
    await btn.trigger('click');
    expect(popover()).not.toBeNull();
    expect(popover()!.getAttribute('aria-label')).toBe('Sửa màu 2 · Bảng màu Bàn phím');

    page!.findAllComponents(ColorPicker)[0].vm.$emit('update:modelValue', '#112233');
    await flushPromises();
    expect(lighting.area0Palette[2].r).not.toBe(0x11); // a draft is not a write
    page!.findAllComponents(ColorPicker)[0].vm.$emit('commit', '#112233');
    await sync.flush();
    const after = await mock.getPalette(0);
    expect([after[2].r, after[2].g, after[2].b]).toEqual([0x11, 0x22, 0x33]);
    history.undo(); // the colour edit alone
    await sync.flush();
    await flushPromises();
    expect(lighting.area0Palette[2].r).not.toBe(0x11);
    expect(lighting.area0Base.paletteIndex).toBe(2); // the slot pick before it stays
    expect(history.canUndo).toBe(true);

    document.body.querySelector<HTMLElement>('.pop [tabindex="0"]')!.focus();
    popover()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(btn.element);
  });

  it('has no edit button on the Rainbow slot (the slot name shows in full); a numbered slot has one with its aria-label', async () => {
    const { lighting, sync } = await mountPage();
    lighting.applyBase(0, { paletteIndex: 0 }, 'Rainbow');
    await sync.flush();
    await flushPromises();
    expect(page!.find('.pal__edit').exists()).toBe(false);
    expect(page!.find('.pal__name').text()).toBe('Cầu vồng');
    lighting.applyBase(0, { paletteIndex: 3 }, 'Pick slot 3');
    await sync.flush();
    await flushPromises();
    expect(page!.find('.pal__edit').attributes('aria-label')).toBe('Sửa màu 3');
    expect(page!.find('.pal__edit').text()).toBe('Sửa màu…');
  });
});

describe('Đèn workbench: per-key colours', () => {
  it('the colour field and the quick colours cause no HID exchange', async () => {
    const { mock, history } = await mountPage();
    const spy = spyExchange(mock);
    await page!.find('.cfield').trigger('click');
    expect(popover()).not.toBeNull();
    page!.findAllComponents(ColorPicker)[0].vm.$emit('update:modelValue', '#336699');
    await flushPromises();
    await page!.findAll('.quick__chip')[3].trigger('click');
    await page!.findAll('.quick__chip')[0].trigger('click');
    await flushPromises();
    expect(spy).not.toHaveBeenCalled();
    expect(history.canUndo).toBe(false);
    expect(page!.findAll('.quick__chip')[0].attributes('aria-pressed')).toBe('true');
    // white is also palette slot 6 on the demo keyboard: only the first chip of the picked colour is marked
    const chips = page!.findAll('.quick__chip');
    expect(chips.map((c) => c.attributes('aria-label')).filter((h) => h === '#ffffff').length).toBeGreaterThan(1);
    const marked = chips.filter((c) => c.attributes('aria-pressed') === 'true');
    expect(marked).toHaveLength(1);
    expect(marked[0].element).toBe(chips[0].element);
    expect(chips.filter((c) => c.classes().includes('quick__chip--on'))).toHaveLength(1);
  });

  it('quick colours are white, then the area palette 1–7', async () => {
    const { lighting } = await mountPage();
    const chips = page!.findAll('.quick__chip');
    expect(chips).toHaveLength(8);
    expect(chips[0].attributes('aria-label')).toBe('#ffffff');
    const hex = (c: { r: number; g: number; b: number }) => `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
    expect(chips.slice(1).map((c) => c.attributes('aria-label'))).toEqual(lighting.area0Palette.slice(1, 8).map(hex));
  });

  it('"Áp dụng cho N phím" writes as before, once, with the count from the selection', async () => {
    const { lighting, history, sync, mock, sel } = await mountPage();
    const apply = () => page!.find('.own-actions button');
    expect(apply().text()).toBe('Áp dụng màu');
    expect(apply().attributes('disabled')).toBeDefined();

    const [w, a, s] = keyIds('W', 'A', 'S');
    sel.selectMany([w, a, s]);
    await flushPromises();
    expect(apply().text()).toBe('Áp dụng cho 3 phím');
    await page!.findAll('.quick__chip')[0].trigger('click'); // white
    const spy = vi.spyOn(mock, 'writeLedMatrix');
    await apply().trigger('click');
    expect(sync.state).toBe('pending');
    await sync.flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lighting.keyCustomColors[w].custom).toBe(true);
    expect(lighting.keyCustomColors[w].colorHex.toLowerCase()).toBe('#ffffff');
    await flushPromises();
    expect(page!.find('.col__meta').exists()).toBe(false); // no head meta: the title stays on one line

    history.undo(); // one entry for the whole apply
    await sync.flush();
    await flushPromises();
    expect(history.canUndo).toBe(false);
    expect(lighting.keyCustomColors[w].custom).toBe(false);
  });

  it('on the strip tab the apply button counts LEDs', async () => {
    await mountPage();
    await toStrip();
    await led(1).trigger('click');
    await led(2).trigger('click');
    expect(page!.find('.own-actions button').text()).toBe('Áp dụng cho 2 LED');
  });

  it('"Xoá tất cả…" opens the confirm dialog', async () => {
    const { lighting, sync, sel } = await mountPage();
    const all = () => page!.find('.own-actions__all');
    expect(all().attributes('disabled')).toBeDefined(); // nothing custom yet
    expect(all().text()).toBe('Xoá tất cả màu riêng…'); // no count at 0
    sel.selectMany(keyIds('W', 'A'));
    await flushPromises();
    await page!.find('.own-actions button').trigger('click');
    await sync.flush();
    await flushPromises();
    expect(all().text()).toBe('Xoá tất cả màu riêng (2)…');
    expect(document.body.querySelector('.dlg__panel')).toBeNull();
    await all().trigger('click');
    await flushPromises();
    expect(document.body.querySelector('.dlg__panel')).not.toBeNull();
    expect(Object.values(lighting.keyCustomColors).filter((v) => v.custom)).toHaveLength(2); // opening it clears nothing
  });
});

describe('Đèn workbench: strip selection drawing', () => {
  it('the selected state is drawn on the strip tab only; custom marks stay on both tabs', async () => {
    await mountPage();
    await toStrip();
    await led(7).trigger('click');
    await led(20).trigger('click');
    const drawn = () => sorted(leds().filter((l) => l.classes().includes('led--selected')).map((l) => Number(l.attributes('data-led'))));
    expect(drawn()).toEqual([7, 20]);
    await tab('keys').trigger('click');
    await flushPromises();
    expect(drawn()).toEqual([]);
    await toStrip();
    expect(drawn()).toEqual([7, 20]); // the selection itself was kept
  });

  it('a custom LED keeps its mark on the keys tab', async () => {
    const { sync } = await mountPage();
    await toStrip();
    await led(7).trigger('click');
    await page!.find('.own-actions button').trigger('click');
    await sync.flush();
    await flushPromises();
    expect(led(7).classes()).toContain('led--custom');
    await tab('keys').trigger('click');
    await flushPromises();
    expect(led(7).classes()).toContain('led--custom');
  });
});

describe('Đèn workbench: the Off state', () => {
  it('disables columns a–c and shows the notice; the per-key column stays as it is', async () => {
    const { lighting } = await mountPage();
    expect(page!.find('.dock__off').exists()).toBe(false);
    lighting.area0Base.open = false;
    await flushPromises();
    const off = page!.find('.dock__off');
    expect(off.attributes('role')).toBe('status');
    expect(off.text()).toBe(t('lighting.powerOffHint'));
    for (const c of ['fx', 'tune', 'pal']) expect(page!.find(`.col--${c} fieldset`).attributes('disabled'), c).toBeDefined();
    expect(page!.find('.col--own fieldset').attributes('disabled')).toBeUndefined();
    // the power control itself stays usable to turn the lights back on
    expect(page!.findAll('.wb__bar .seg button').every((b) => b.attributes('disabled') === undefined)).toBe(true);
  });
});
