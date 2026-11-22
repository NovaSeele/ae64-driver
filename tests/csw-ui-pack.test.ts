// CSW step 4a UI tests: SwitchPackPanel & SwitchPackImport (DESIGN §19 Test 18 UI half; kills M23 and M24).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { MockTransport, PHYSICAL_KEYS } from '../src/protocol';
import SwitchCard from '../src/components/performance/SwitchCard.vue';
import { useDeviceStore } from '../src/stores/device';
import { usePerformanceStore } from '../src/stores/performance';
import { useToast } from '../src/components/ui/toast';
import { PACK_FORMAT, PACK_MAX_BYTES, PACK_SCHEMA, PACK_TEMPLATE } from '../src/data/switchPack';
import type { CustomSwitch } from '../src/data/customSwitch';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;

let w: VueWrapper | null = null;
const body = () => document.body;
const footBtn = (text: string) =>
  [...body().querySelectorAll<HTMLButtonElement>('.dlg__foot button')].find((b) => b.textContent?.trim() === text);
const spyExchange = (mock: MockTransport) =>
  vi.spyOn(mock as unknown as { exchange: (f: Uint8Array) => Promise<unknown> }, 'exchange');

async function openPackPanel() {
  const device = useDeviceStore();
  await device.connectDemo('max');
  const mock = device.transport as MockTransport;
  const perf = usePerformanceStore();
  await perf.load();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<i />' } }] });
  w = mount(SwitchCard, { props: { ids: [W.id] }, global: { plugins: [router] }, attachTo: document.body });
  (w.findAll('.swc__foot button')[1].element as HTMLElement).click();
  await flushPromises();
  [...body().querySelectorAll<HTMLButtonElement>('.csw-head__btns button')][1].click();
  await flushPromises();
  return { device, mock, perf };
}

async function feedFile(file: File) {
  const input = body().querySelector<HTMLInputElement>('.csw-packpanel input[type="file"]')!;
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}

function makeFile(name: string, content: string, sizeOverride?: number): File {
  const f = new File([content], name, { type: 'application/json' });
  if (sizeOverride !== undefined) Object.defineProperty(f, 'size', { value: sizeOverride });
  // Ensure f.text() exists in jsdom
  if (typeof f.text !== 'function') {
    Object.defineProperty(f, 'text', { value: vi.fn().mockResolvedValue(content), configurable: true });
  }
  return f;
}

describe('Switch pack UI: panel, preview, import, export, template (DESIGN §19 Test 18)', () => {
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

  it('refuses a 65 537 byte file BEFORE reading or parsing with csw.pkTooBig toast (kills M24)', async () => {
    const { mock } = await openPackPanel();
    const ex = spyExchange(mock);
    const big = makeFile('huge.json', '{}', PACK_MAX_BYTES + 1);
    const textSpy = vi.spyOn(big, 'text');

    await feedFile(big);
    expect(textSpy).not.toHaveBeenCalled();
    expect(useToast().items.value.at(-1)?.text).toBe(t('csw.pkTooBig'));
    expect(body().querySelector('.csw-imp')).toBeNull();
    expect(ex).not.toHaveBeenCalled();
  });

  it('import preview shows add/clamped/skip rows, renders HTML-like names as text (no v-html), adds only via perf.addCustomSwitches with 0 HID (kills M23)', async () => {
    const { mock, perf } = await openPackPanel();
    const existing: CustomSwitch = {
      uid: 'u-111111111111',
      name: 'Existing One',
      maker: 'MyMaker',
      travelUm: 3500,
      rangeUm: 3500,
      coefficient: 19850,
      curve: { kind: 'travel' },
      color: '',
      note: '',
    };
    perf.saveCustomSwitch(existing);
    await flushPromises();

    const ex = spyExchange(mock);
    const xssName = '<img src=x onerror=alert(1)>';
    const json = JSON.stringify({
      format: PACK_FORMAT,
      schema: PACK_SCHEMA,
      switches: [
        { name: xssName, maker: 'SafeLab', travelMm: 4.1, color: '#5cc27a', note: 'Clamped' },
        { name: 'Existing One', travelMm: 3.5 },
        { name: 'Bad Coef', travelMm: 3.5, coefficient: 30000 },
        { name: 'Bad Field', travelMm: 3.5, extra: 1 },
      ],
    });
    await feedFile(makeFile('pack.json', json));

    expect(body().querySelector('.dlg__title')?.textContent).toBe(t('csw.pkTitle'));
    expect(body().querySelector('.csw-imp__sum')?.textContent).toContain(t('csw.pkSummary', { file: 'pack.json', a: 1, b: 3 }));

    const rows = [...body().querySelectorAll('.csw-imp__row')];
    expect(rows).toHaveLength(4);
    // XSS name rendered strictly as text — zero <img> elements created!
    expect(rows[0].querySelector('.csw-imp__name')?.textContent).toBe(xssName);
    expect(rows[0].querySelector('img')).toBeNull();
    expect(rows[0].querySelector('.csw-imp__meta')?.textContent).toContain(t('csw.pkClamped', { mm: '4.10', used: '4.015' }));
    expect(rows[1].querySelector('.csw-imp__st')?.textContent).toContain(t('csw.pkWhy.nameTaken'));
    expect(rows[2].querySelector('.csw-imp__st')?.textContent).toContain(t('csw.pkWhy.coef', { min: 13300, max: 26800 }));
    expect(rows[3].querySelector('.csw-imp__st')?.textContent).toContain(t('csw.pkWhy.field', { f: 'extra' }));
    expect(ex).not.toHaveBeenCalled();

    // Confirm add: keeps existing entry (add-only, does NOT replace), writes 0 HID (kills M23)
    const addBtn = footBtn(t('csw.pkAddN', { n: 1 }))!;
    addBtn.click();
    await flushPromises();
    expect(ex).not.toHaveBeenCalled();
    expect(perf.customSwitches.map((s) => s.name)).toEqual(['Existing One', xssName]);
    expect(perf.customSwitches[1]).toMatchObject({ travelUm: 4100, rangeUm: 4015, color: '#5cc27a', note: 'Clamped' });
    expect(useToast().items.value.at(-1)?.text).toBe(t('csw.pkAdded', { n: 1 }));
    // Returned to custom tab with nothing chosen
    expect(body().querySelector('.csw-imp')).toBeNull();
    expect(body().querySelector('.swp__idle')?.textContent).toBe(t('csw.idle'));
  });

  it('shows csw.pkBadFile with Back button for refused files, and template imports cleanly as 2 entries with 0 HID', async () => {
    const { mock, perf } = await openPackPanel();
    const ex = spyExchange(mock);

    await feedFile(makeFile('bad.json', JSON.stringify({ format: PACK_FORMAT, schema: 2, switches: [] })));
    expect(body().querySelector('.csw-imp__warn')?.textContent).toContain(
      t('csw.pkBadFile', { file: 'bad.json', why: t('csw.pkFile.schema', { v: '2' }) }),
    );
    const back = footBtn(t('csw.pkBack'))!;
    expect(back).toBeDefined();
    back.click();
    await flushPromises();

    // Open pack panel again and import PACK_TEMPLATE
    [...body().querySelectorAll<HTMLButtonElement>('.csw-head__btns button')][1].click();
    await flushPromises();
    await feedFile(makeFile('ae64-switch-pack-template.json', PACK_TEMPLATE));
    footBtn(t('csw.pkAddN', { n: 2 }))!.click();
    await flushPromises();
    expect(perf.customSwitches).toHaveLength(2);
    expect(ex).not.toHaveBeenCalled();
  });

  it('export is disabled with 0 switches; export and template download JSON with 0 HID and keep panel open', async () => {
    const { mock, perf } = await openPackPanel();
    const ex = spyExchange(mock);
    const panelBtns = () => [...body().querySelectorAll<HTMLButtonElement>('.csw-packpanel__btns button')];
    expect(panelBtns()[1].disabled).toBe(true);
    expect(panelBtns()[1].title).toBe(t('csw.packExportNone'));

    const blobs: Blob[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:test'; });
    URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    try {
      // Download template keeps panel open
      panelBtns()[2].click();
      await flushPromises();
      expect(clickSpy).toHaveBeenCalledTimes(1);
      expect(body().querySelector('.csw-packpanel')).not.toBeNull();

      // Add a switch -> export enabled, downloads pack without uid/serial/assignments
      perf.saveCustomSwitch({
        uid: 'u-abcdef012345',
        name: 'Export Me',
        maker: 'TestLab',
        travelUm: 3500,
        rangeUm: 3500,
        coefficient: 19850,
        curve: { kind: 'travel' },
        color: '#4fc3d9',
        note: 'Hi',
      });
      await flushPromises();
      expect(panelBtns()[1].disabled).toBe(false);
      panelBtns()[1].click();
      await flushPromises();
      expect(clickSpy).toHaveBeenCalledTimes(2);
      expect(body().querySelector('.csw-packpanel')).not.toBeNull();
      expect(useToast().items.value.at(-1)?.text).toBe(t('csw.pkExported', { n: 1 }));
      expect(ex).not.toHaveBeenCalled();
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
