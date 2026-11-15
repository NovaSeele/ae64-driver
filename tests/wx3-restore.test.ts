// WX3 (backup / restore): U-01 factory keycodes in the file, U-07 factory keys on the keyboard, W-08 every write checked by
// the transport's guards before the first one, the section write-back on a transport error, the diagnostics texts, and the
// Reset dialog's wallpaper line. Demo keyboard only. The reviewer's zz-agentC-restore J / K, zz-whole-3 DG1 and
// zz-agentC-keymap I are here turned round.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import DiagnosticsPage from '../src/pages/DiagnosticsPage.vue';
import SettingsPage from '../src/pages/SettingsPage.vue';
import { routes } from '../src/router';
import { MockTransport, SAVE_GROUP } from '../src/protocol';
import type { KeyPos, Performance } from '../src/protocol';
import { isWriteCommand } from '../src/protocol/safety';
import { useDeviceStore } from '../src/stores/device';
import { useSettingsStore } from '../src/stores/settings';
import { RestoreRefusedError, useDiagnosticsStore } from '../src/stores/diagnostics';
import { MemoryWallpaperStore, getWallpaperStore, setWallpaperStore } from '../src/data/wallpaperStore';
import type { WallRecord } from '../src/data/wallpaperStore';
import { useToast } from '../src/components/ui/toast';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

let w: VueWrapper | null = null;
const prevWall = getWallpaperStore();
beforeEach(() => { localStorage.clear(); setActivePinia(createPinia()); setLocale('en'); });
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  localStorage.clear();
  setWallpaperStore(prevWall);
});

const hex = (b: ArrayLike<number>, n = 3) => [...Array.from(b).slice(0, n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
/** Every write frame sent from now on (any family), as "ff cc xx". */
function writesOf(mock: MockTransport): string[] {
  const out: string[] = [];
  mock.onPacket((e) => { if (e.dir === 'out' && isWriteCommand([...e.bytes])) out.push(hex(e.bytes)); });
  return out;
}
type Profiles = { profiles: { keymap: number[][][] }[] };
async function demoWith(model: 'max' | 'pro' = 'max') {
  const device = useDeviceStore();
  await device.connectDemo(model);
  const mock = device.transport as MockTransport;
  const key = (name: string) => device.keys.find((k) => k.name === name)!;
  return { device, mock, key, diag: useDiagnosticsStore() };
}
const setFactory = (mock: MockTransport, pos: KeyPos, layer = 2, code = 0xf200) => {
  (mock as unknown as Profiles).profiles[0].keymap[layer][pos.row][pos.col] = code;
};

async function openDialog(payload: unknown) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/diagnostics');
  w = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  const input = w.find<HTMLInputElement>('input[type="file"]').element;
  const file = new File([JSON.stringify(payload)], 'b.json', { type: 'application/json' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  input.dispatchEvent(new Event('change'));
  await vi.waitFor(() => expect(document.body.querySelector('.dlg__panel')).not.toBeNull(), { timeout: 15000 });
  const panel = () => document.body.querySelector<HTMLElement>('.dlg__panel')!;
  const apply = () => [...panel().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('diagnostics.importConfirm'))!;
  return { panel, apply, text: () => (panel().textContent ?? '').replace(/\s+/g, ' ') };
}

describe('U-01: factory keycodes in the file', () => {
  it('K turned round: the keyboard still holds the same F200: left alone, Q restored, no error', async () => {
    const { device, mock, key, diag } = await demoWith('max');
    const esc = key('Esc');
    setFactory(mock, esc);
    const payload = await diag.generateBackup();
    expect(payload.keymap[2][esc.id]).toBe(0xf200);
    const q = key('Q');
    const qWas = payload.keymap[0][q.id];
    await mock.setKeycode(q, 0x0004, 0);
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.refused).toBeNull();
    expect(diff.keymapDiffCount).toBe(1);
    expect(diff.unrestorable).toEqual([]);
    expect(diff.factory).toEqual([]);
    const writes = writesOf(mock);
    await expect(diag.applyRestore(diff)).resolves.toEqual({ skipped: 0 });
    expect(await mock.getKeycode(q, 0)).toBe(qWas); // d028465: refused ("Blocked keycode 0xf200 at layer 2")
    expect(await mock.getKeycode(esc, 2)).toBe(0xf200);
    expect(writes).toEqual(['03 04 00', `02 02 0${SAVE_GROUP.LAYOUT}`]);
    void device;
  });

  it('an ordinary key on the keyboard where the file has F200: listed (dialog too), not written; the rest restores', async () => {
    const { mock, key, diag } = await demoWith('max');
    const esc = key('Esc');
    const payload = await diag.generateBackup();
    const escWas = payload.keymap[2][esc.id];
    payload.keymap[2][esc.id] = 0xf200; // the file was taken from a keyboard with the factory-reset key there
    const q = key('Q');
    const qWas = payload.keymap[0][q.id];
    await mock.setKeycode(q, 0x0004, 0);
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.refused).toBeNull(); // d028465: the whole file refused
    expect(diff.unrestorable).toEqual([{ layer: 2, id: esc.id, code: 0xf200 }]);
    expect(diff.keymapDiffCount).toBe(1); // counted apart from the keys that change
    const d = await openDialog(payload);
    const list = d.panel().querySelector('[data-test="restore-unrestorable"]')!;
    expect(list.textContent).toContain(t('diagnostics.importUnrestorable', { n: 1 }));
    expect(list.textContent).toContain('Fn2 · Esc');
    expect(list.textContent).toContain('0xF200');
    expect(d.text()).toContain(t('diagnostics.importDiffKeymap', { n: 1 }));
    const writes = writesOf(mock);
    d.apply().click();
    await vi.waitFor(() => expect(useDiagnosticsStore().isRestoring).toBe(false), { timeout: 15000 });
    await flushPromises();
    expect(await mock.getKeycode(q, 0)).toBe(qWas);
    expect(await mock.getKeycode(esc, 2)).toBe(escWas);
    expect(writes.filter((x) => x.startsWith('03 04'))).toEqual(['03 04 00']);
  });
});

for (const model of ['max', 'pro'] as const) {
  describe(`U-07: factory keys on the keyboard (demo ${model})`, () => {
    it('J turned round: the dialog lists the factory key and the device-wide settings; nothing written until confirmed', async () => {
      const { mock, key, diag } = await demoWith(model);
      const esc = key('Esc');
      setFactory(mock, esc);
      const payload = await diag.generateBackup();
      payload.keymap[2][esc.id] = 0x0004; // the file (another unit / profile) has "A" there
      const d = await openDialog(payload);
      const text = d.text();
      expect(text).toContain(t('diagnostics.importDiffKeymap', { n: 1 }));
      const warn = d.panel().querySelector('[data-test="restore-factory"]')!;
      expect(warn.textContent).toContain('cannot be undone'); // keymap.assignFactory, as on the Keymap page
      expect(warn.textContent).toContain('Fn2 · Esc');
      expect(warn.textContent).toContain('0xF200');
      // keymap and travel → the active profile; system mode, lighting sleep, shake optimization → the whole keyboard
      expect(d.panel().querySelector('[data-test="restore-scope"]')!.textContent).toBe(t('diagnostics.importScope'));
      expect(text).toContain('whole keyboard');
      expect(d.apply().disabled).toBe(true); // d028465: on, and nothing said about the factory key
      const writes = writesOf(mock);
      d.apply().click();
      await flushPromises();
      expect(writes).toEqual([]);
      expect(await mock.getKeycode(esc, 2)).toBe(0xf200);
      // the store refuses too without the confirmation: 0 writes
      await expect(diag.applyRestore(diag.importDiff!)).rejects.toThrow(RestoreRefusedError);
      expect(writes).toEqual([]);
      // confirm, then apply: written
      const box = warn.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
      box.click();
      await flushPromises();
      expect(d.apply().disabled).toBe(false);
      d.apply().click();
      await vi.waitFor(() => expect(diag.isRestoring).toBe(false), { timeout: 15000 });
      await flushPromises();
      expect(await mock.getKeycode(esc, 2)).toBe(4);
      expect(writes).toEqual(['03 04 02', `02 02 0${SAVE_GROUP.LAYOUT}`]);
    }, 30000);
  });
}

describe('W-08: every write checked by the guards before the first one', () => {
  async function refusedWith(edit: (p: Awaited<ReturnType<ReturnType<typeof useDiagnosticsStore>['generateBackup']>>, keys: ReturnType<typeof useDeviceStore>['keys']) => void) {
    const { device, mock, diag } = await demoWith('max');
    const payload = await diag.generateBackup();
    payload.keymap[0][device.keys[0].id] = 0x0004; // a keymap change (written first)
    payload.performance[device.keys[5].id].rtPress = 0.5; // a valid travel change on an early key
    edit(payload, device.keys);
    const writes = writesOf(mock);
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    const result = await diag.applyRestore(diff).then(() => 'ok', (e: unknown) => e);
    return { diff, result, writes };
  }

  it('DG1 turned round: one key with normalPress 0 → refused, 0 writes of any family', async () => {
    const r = await refusedWith((p, keys) => { p.performance[keys[40].id].normalPress = 0; });
    expect(r.result).toBeInstanceOf(RestoreRefusedError); // d028465: keymap written + committed, travel half-written
    expect(String((r.result as Error).message)).toContain('actuation point must be above 0 mm');
    expect(r.diff.refused).toBe((r.result as Error).message); // said at file pick already
    expect(r.writes).toEqual([]);
  });

  it('systemMode 2 → refused, 0 writes', async () => {
    const r = await refusedWith((p) => { p.globalSettings.systemMode = 2; });
    expect(r.result).toBeInstanceOf(RestoreRefusedError);
    expect((r.result as Error).message).toContain('systemMode = 2');
    expect(r.writes).toEqual([]);
  });

  it('rgbSleep 70000 → refused, 0 writes', async () => {
    const r = await refusedWith((p) => { p.globalSettings.rgbSleep = 70000; });
    expect(r.result).toBeInstanceOf(RestoreRefusedError);
    expect((r.result as Error).message).toContain('rgbSleep = 70000');
    expect(r.writes).toEqual([]);
  });

  it('an RT distance of 0 on a key in an RT mode → refused, 0 writes', async () => {
    const r = await refusedWith((p, keys) => {
      expect(p.performance[keys[30].id].mode).toBe(1); // demo profile 0: every key Rapid Trigger
      p.performance[keys[30].id].rtRelease = 0;
    });
    expect(r.result).toBeInstanceOf(RestoreRefusedError);
    expect((r.result as Error).message).toContain('Rapid Trigger distances must be above 0 mm');
    expect(r.writes).toEqual([]);
  });

  it('the file\'s refusal shows at file pick, no dialog, nothing written', async () => {
    const { device, mock, diag } = await demoWith('max');
    const payload = await diag.generateBackup();
    payload.performance[device.keys[40].id].normalPress = 0;
    const writes = writesOf(mock);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/diagnostics');
    w = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    const input = w.find<HTMLInputElement>('input[type="file"]').element;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(payload)], 'b.json')], configurable: true });
    input.dispatchEvent(new Event('change'));
    const toasts = useToast().items;
    await vi.waitFor(() => expect(toasts.value.some((x) => x.kind === 'error' && x.text.includes('actuation point must be above 0 mm'))).toBe(true), { timeout: 15000 });
    expect(toasts.value.find((x) => x.kind === 'error')!.text.startsWith(t('diagnostics.vRefused', { msg: '' }).trim())).toBe(true);
    expect(document.body.querySelector('.dlg__panel')).toBeNull();
    expect(writes).toEqual([]);
  });
});

describe('W-08: a section that fails half-way is put back, and not committed', () => {
  async function threeTravelKeys() {
    const { device, mock, key, diag } = await demoWith('max');
    const payload = await diag.generateBackup();
    const q = key('Q');
    const qWas = payload.keymap[0][q.id];
    await mock.setKeycode(q, 0x0004, 0); // one keymap change to restore (that section completes)
    const ks = [device.keys[10], device.keys[11], device.keys[12]];
    const before: Performance[] = [];
    for (const k of ks) {
      const p = payload.performance[k.id];
      before.push({ ...p });
      p.normalPress = Math.round((p.normalPress + 0.3) * 1000) / 1000;
    }
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.refused).toBeNull();
    expect(diff.perfDiffCount).toBe(3);
    const orig = MockTransport.prototype.setPerformance;
    const calls: { pos: KeyPos; p: Performance }[] = [];
    return { device, mock, diag, diff, ks, before, q, qWas, orig, calls };
  }
  const travel = async (mock: MockTransport, k: KeyPos) => (await mock.getPerformance(k)).normalPress;

  it('the second setPerformance throws → keys 1 and 2 get their old records back, no travel commit, the keymap commit stays', async () => {
    const s = await threeTravelKeys();
    let n = 0;
    vi.spyOn(s.mock, 'setPerformance').mockImplementation(async function (this: MockTransport, pos, p) {
      s.calls.push({ pos, p: { ...p } });
      if (++n === 2) throw new Error('lost reply');
      return s.orig.call(s.mock, pos, p);
    });
    const writes = writesOf(s.mock);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(`${t('diagnostics.restoreDoneList', { list: t('diagnostics.secKeymap') })} `
      + t('diagnostics.restoreFailedBack', { section: t('diagnostics.secPerformance'), msg: 'lost reply' }));
    // writes: key 1, key 2 (thrown), then the put-back of key 2, then key 1, with the records read just before
    expect(s.calls.map((c) => c.pos)).toEqual([s.ks[0], s.ks[1], s.ks[1], s.ks[0]]);
    expect(s.calls[2].p.normalPress).toBeCloseTo(s.before[1].normalPress, 3);
    expect(s.calls[3].p.normalPress).toBeCloseTo(s.before[0].normalPress, 3);
    for (let i = 0; i < 3; i++) expect(await travel(s.mock, s.ks[i])).toBeCloseTo(s.before[i].normalPress, 3);
    expect(writes).toContain(`02 02 0${SAVE_GROUP.LAYOUT}`);
    expect(writes).not.toContain(`02 02 0${SAVE_GROUP.PERFORMANCE}`); // d028465: no write-back (key 1 left changed)
    expect(await s.mock.getKeycode(s.q, 0)).toBe(s.qWas); // the keymap section stays done
  });

  it('the put-back fails too → "unsaved until unplugged"', async () => {
    const s = await threeTravelKeys();
    let n = 0;
    vi.spyOn(s.mock, 'setPerformance').mockImplementation(async function (this: MockTransport, pos, p) {
      if (++n >= 2) throw new Error('keyboard gone');
      return s.orig.call(s.mock, pos, p);
    });
    const writes = writesOf(s.mock);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(`${t('diagnostics.restoreDoneList', { list: t('diagnostics.secKeymap') })} `
      + t('diagnostics.restoreFailedUnsaved', { section: t('diagnostics.secPerformance'), msg: 'keyboard gone' }));
    expect(writes).not.toContain(`02 02 0${SAVE_GROUP.PERFORMANCE}`);
  });

  it('a keymap section that fails after writing over a confirmed factory key says it cannot be put back', async () => {
    const { device, mock, key, diag } = await demoWith('max');
    const esc = key('Esc');
    setFactory(mock, esc);
    const payload = await diag.generateBackup();
    payload.keymap[2][esc.id] = 0x0004;
    const next = device.keys.find((k) => k.id > esc.id)!;
    const nextCode = payload.keymap[2][next.id] === 0x0005 ? 0x0006 : 0x0005;
    const nextWas = payload.keymap[2][next.id];
    payload.keymap[2][next.id] = nextCode;
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.factory.map((f) => f.id)).toEqual([esc.id]);
    const orig = MockTransport.prototype.setKeycode;
    const codes: number[] = [];
    vi.spyOn(mock, 'setKeycode').mockImplementation(async function (this: MockTransport, pos, code, layer) {
      codes.push(code);
      if (code === nextCode) throw new Error('lost reply');
      return orig.call(mock, pos, code, layer);
    });
    const writes = writesOf(mock);
    const msg = await diag.applyRestore(diff, { factoryOk: true }).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(`${t('diagnostics.restoreFailedBack', { section: t('diagnostics.secKeymap'), msg: 'lost reply' })} `
      + t('diagnostics.restoreFactoryLost', { n: 1, keys: 'Fn2 · Esc' }));
    expect(codes).toEqual([4, nextCode, nextWas]); // the factory key is never written back (the guard refuses F200)
    expect(writes).not.toContain(`02 02 0${SAVE_GROUP.LAYOUT}`);
    expect(await mock.getKeycode(next, 2)).toBe(nextWas);
  });
});

describe('Diagnostics texts', () => {
  it('I turned round: shakeOptimization as a number equal to the keyboard\'s → 0 settings to change', async () => {
    const { diag } = await demoWith('max');
    const settings = useSettingsStore();
    const payload = await diag.generateBackup();
    await settings.load();
    const asNumber = { ...payload, globalSettings: { ...payload.globalSettings, shakeOptimization: (settings.shakeOptimization ? 1 : 0) as unknown as boolean } };
    const diff = await diag.parseAndDiffBackup(JSON.stringify(asNumber));
    expect(diff.settingsDiffCount).toBe(0); // d028465: 1
  });

  it('the "not restored" note names the polling rate and why; refusal texts in vi and en', async () => {
    expect(t('diagnostics.importUnsupportedNotice')).toMatch(/polling rate.*restarts the keyboard.s USB.*Settings/);
    setLocale('vi');
    expect(t('diagnostics.importUnsupportedNotice')).toMatch(/tần số quét.*khởi động lại.*Cài đặt/);
    expect(t('diagnostics.vRefused', { msg: 'x' })).toBe('Từ chối khôi phục, chưa ghi gì: x');
  });
});

describe('Reset dialog: the wallpaper image', () => {
  const rec: WallRecord = {
    v: 1, blob: new Blob(['x'], { type: 'image/png' }), name: 'w.png', type: 'image/png', size: 1, w: 1, h: 1,
    box: { lo: [0, 0, 0], hi: [1, 1, 1] }, savedAt: 1,
  } as unknown as WallRecord;
  async function resetDialog() {
    const device = useDeviceStore();
    await device.connectDemo('max');
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/settings');
    w = mount(SettingsPage, { global: { plugins: [router] }, attachTo: document.body });
    await vi.waitFor(() => expect(useSettingsStore().loaded).toBe(true));
    await flushPromises();
    const btn = w.get('.dl-card').findAll('.dl__actions button').find((b) => b.text() === t('appcfg.reset'))!;
    await btn.trigger('click');
    await flushPromises();
    await new Promise((r) => setTimeout(r, 5));
    await flushPromises();
    return document.body.querySelector<HTMLElement>('.dlg__panel')!;
  }

  it('an image stored: the line says it is deleted too and the exported file does not hold it', async () => {
    const store = new MemoryWallpaperStore();
    await store.put(rec);
    setWallpaperStore(store);
    const d = await resetDialog();
    const line = d.querySelector('[data-test="reset-wallpaper"]');
    expect(line?.textContent).toBe(t('appcfg.resetWallpaper'));
    expect(t('appcfg.resetWallpaper')).toMatch(/deleted.*exported file does not hold it/);
  });

  it('no image stored: no line', async () => {
    setWallpaperStore(new MemoryWallpaperStore());
    const d = await resetDialog();
    expect(d.querySelector('[data-test="reset-wallpaper"]')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// WX4 item 0: N-WX3-1 (the commit was sent, its reply lost) and the four WX3 review tests (D17/D17b, P3, D11, P5).
describe('WX4 item 0a: the section commit sent, its reply lost', () => {
  async function travelTwo() {
    const { device, mock, diag } = await demoWith('max');
    const payload = await diag.generateBackup();
    const ks = [device.keys[10], device.keys[11]];
    const before = ks.map((k) => payload.performance[k.id].normalPress);
    for (const k of ks) payload.performance[k.id].normalPress = Math.round((payload.performance[k.id].normalPress + 0.3) * 1000) / 1000;
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    return { device, mock, diag, diff, ks, before };
  }
  /** commit(group) reaches the keyboard, then throws for the first `n` commits of `group`. */
  function loseReply(mock: MockTransport, group: number, n: number) {
    const orig = MockTransport.prototype.commit;
    let lost = 0;
    vi.spyOn(mock, 'commit').mockImplementation(async function (this: MockTransport, g) {
      await orig.call(mock, g);
      if (g === group && lost < n) { lost++; throw new Error('lost reply'); }
    });
  }

  it('travel: put back, then the travel commit once more (flash = RAM = the values before); the message says put back', async () => {
    const s = await travelTwo();
    loseReply(s.mock, SAVE_GROUP.PERFORMANCE, 1);
    const writes = writesOf(s.mock);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(t('diagnostics.restoreFailedBack', { section: t('diagnostics.secPerformance'), msg: 'lost reply' }));
    const commit = `02 02 0${SAVE_GROUP.PERFORMANCE}`;
    expect(writes.filter((x) => x === commit).length).toBe(2); // 6428ff1: 1
    expect(writes.at(-1)).toBe(commit); // the second commit comes after the put-back
    const first = writes.indexOf(commit);
    expect(writes.slice(first + 1, -1).length).toBe(2); // the two records put back between the commits
    for (let i = 0; i < 2; i++) expect((await s.mock.getPerformance(s.ks[i])).normalPress).toBeCloseTo(s.before[i], 3);
  });

  it('travel: the second commit fails too → "may come back with the file\'s values after unplugging"', async () => {
    const s = await travelTwo();
    loseReply(s.mock, SAVE_GROUP.PERFORMANCE, 2);
    const writes = writesOf(s.mock);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(t('diagnostics.restoreFailedMayReturn', { section: t('diagnostics.secPerformance'), msg: 'lost reply' }));
    expect(msg).toContain('unplug');
    expect(writes.filter((x) => x === `02 02 0${SAVE_GROUP.PERFORMANCE}`).length).toBe(2); // once more only, no loop
  });

  it('keymap: put back, then the layout commit once more; travel is not started', async () => {
    const { device, mock, key, diag } = await demoWith('max');
    const payload = await diag.generateBackup();
    const q = key('Q');
    const qWas = payload.keymap[0][q.id];
    await mock.setKeycode(q, 0x0004, 0);
    payload.performance[device.keys[10].id].normalPress = Math.round((payload.performance[device.keys[10].id].normalPress + 0.3) * 1000) / 1000;
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    loseReply(mock, SAVE_GROUP.LAYOUT, 1);
    const writes = writesOf(mock);
    const msg = await diag.applyRestore(diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(t('diagnostics.restoreFailedBack', { section: t('diagnostics.secKeymap'), msg: 'lost reply' }));
    const commit = `02 02 0${SAVE_GROUP.LAYOUT}`;
    expect(writes).toEqual(['03 04 00', commit, '03 04 00', commit]);
    expect(await mock.getKeycode(q, 0)).toBe(0x0004); // the value from before the restore
    expect(qWas).not.toBe(0x0004);
  });

  it('the commit lost and the put-back failing too: no second commit (RAM is not the old values), "unsaved until unplugged"', async () => {
    const s = await travelTwo();
    loseReply(s.mock, SAVE_GROUP.PERFORMANCE, 1);
    const orig = MockTransport.prototype.setPerformance;
    let n = 0;
    vi.spyOn(s.mock, 'setPerformance').mockImplementation(async function (this: MockTransport, pos, p) {
      if (++n >= 3) throw new Error('keyboard gone'); // the two file records go, the put-back does not
      return orig.call(s.mock, pos, p);
    });
    const writes = writesOf(s.mock);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(t('diagnostics.restoreFailedUnsaved', { section: t('diagnostics.secPerformance'), msg: 'lost reply' }));
    expect(writes.filter((x) => x === `02 02 0${SAVE_GROUP.PERFORMANCE}`).length).toBe(1);
  });

  it('a write that fails before the commit sends no commit (unchanged)', async () => {
    const s = await travelTwo();
    const orig = MockTransport.prototype.setPerformance;
    let n = 0;
    vi.spyOn(s.mock, 'setPerformance').mockImplementation(async function (this: MockTransport, pos, p) {
      if (++n === 2) throw new Error('lost reply');
      return orig.call(s.mock, pos, p);
    });
    const writes = writesOf(s.mock);
    await s.diag.applyRestore(s.diff).catch(() => undefined);
    expect(writes).not.toContain(`02 02 0${SAVE_GROUP.PERFORMANCE}`);
  });
});

describe('WX4 item 0b: the WX3 review tests', () => {
  async function settingsFile() {
    const { mock, diag } = await demoWith('max');
    const settings = useSettingsStore();
    await settings.load();
    const old = { systemMode: settings.systemMode, rgbSleep: settings.rgbSleep, shakeOptimization: settings.shakeOptimization };
    const payload = await diag.generateBackup();
    payload.globalSettings.systemMode = old.systemMode === 0 ? 1 : 0;
    payload.globalSettings.rgbSleep = old.rgbSleep === 600 ? 900 : 600;
    payload.globalSettings.shakeOptimization = !old.shakeOptimization;
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.settingsDiffCount).toBe(3);
    const calls: string[] = [];
    const spy = (name: 'setSystemMode' | 'setRgbSleep' | 'setShakeOptimization', fail: boolean) => {
      const orig = (MockTransport.prototype[name] as (v: never) => Promise<void>);
      let first = true;
      vi.spyOn(mock, name).mockImplementation((async (v: never) => {
        calls.push(`${name}(${String(v)})`);
        if (fail && first) { first = false; throw new Error('lost reply'); }
        return orig.call(mock, v);
      }) as never);
    };
    return { mock, diag, diff, old, payload, calls, spy };
  }

  it('D17: setRgbSleep throws → rgbSleep, then systemMode put back (systemMode after it); the message says put back', async () => {
    const s = await settingsFile();
    s.spy('setSystemMode', false);
    s.spy('setRgbSleep', true);
    s.spy('setShakeOptimization', false);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(t('diagnostics.restoreFailedBack', { section: t('diagnostics.secSettings'), msg: 'lost reply' }));
    const g = s.payload.globalSettings;
    expect(s.calls).toEqual([
      `setSystemMode(${g.systemMode})`, `setRgbSleep(${g.rgbSleep})`,
      `setRgbSleep(${s.old.rgbSleep})`, `setSystemMode(${s.old.systemMode})`,
    ]);
    expect(await s.mock.getSystemMode()).toBe(s.old.systemMode);
  });

  it('D17b: setShakeOptimization throws → shake, rgbSleep, then systemMode put back, last first', async () => {
    const s = await settingsFile();
    s.spy('setSystemMode', false);
    s.spy('setRgbSleep', false);
    s.spy('setShakeOptimization', true);
    const msg = await s.diag.applyRestore(s.diff).then(() => 'ok', (e: Error) => e.message);
    expect(msg).toBe(t('diagnostics.restoreFailedBack', { section: t('diagnostics.secSettings'), msg: 'lost reply' }));
    const g = s.payload.globalSettings;
    expect(s.calls).toEqual([
      `setSystemMode(${g.systemMode})`, `setRgbSleep(${g.rgbSleep})`, `setShakeOptimization(${g.shakeOptimization})`,
      `setShakeOptimization(${s.old.shakeOptimization})`, `setRgbSleep(${s.old.rgbSleep})`, `setSystemMode(${s.old.systemMode})`,
    ]);
    expect(await s.mock.getRgbSleep()).toBe(s.old.rgbSleep);
    expect(await s.mock.getSystemMode()).toBe(s.old.systemMode);
  });

  it('P3: the factory box is cleared for each new file (A ticked then cancelled → B unticked, Apply off)', async () => {
    const { mock, key, diag } = await demoWith('max');
    const esc = key('Esc');
    const tab = key('Tab');
    setFactory(mock, esc);
    setFactory(mock, tab);
    const fileA = await diag.generateBackup();
    fileA.keymap[2][esc.id] = 0x0004;
    const d = await openDialog(fileA);
    const box = () => d.panel().querySelector<HTMLInputElement>('[data-test="restore-factory"] input[type="checkbox"]')!;
    box().click();
    await flushPromises();
    expect(box().checked).toBe(true);
    expect(d.apply().disabled).toBe(false);
    const cancel = [...d.panel().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === t('diagnostics.importCancel'))!;
    cancel.click();
    await vi.waitFor(() => expect(document.body.querySelector('.dlg__panel')).toBeNull(), { timeout: 15000 });
    const fileB = await diag.generateBackup();
    fileB.keymap[2][tab.id] = 0x0005;
    const input = w!.find<HTMLInputElement>('input[type="file"]').element;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(fileB)], 'b2.json')], configurable: true });
    input.dispatchEvent(new Event('change'));
    await vi.waitFor(() => expect(document.body.querySelector('[data-test="restore-factory"]')?.textContent).toContain('Tab'), { timeout: 15000 });
    expect(box().checked).toBe(false);
    expect(d.apply().disabled).toBe(true);
  }, 30000);

  it('D11: factory key X shown and ticked; the keyboard then gets F200 on key Y where the file differs → refused, 0 writes', async () => {
    const { mock, key, diag } = await demoWith('max');
    const esc = key('Esc');
    const tab = key('Tab');
    setFactory(mock, esc);
    const payload = await diag.generateBackup();
    payload.keymap[2][esc.id] = 0x0004;
    payload.keymap[2][tab.id] = payload.keymap[2][tab.id] === 0x0005 ? 0x0006 : 0x0005;
    const diff = await diag.parseAndDiffBackup(JSON.stringify(payload));
    expect(diff.factory.map((f) => f.id)).toEqual([esc.id]);
    setFactory(mock, tab); // after the dialog was built: Y is now a factory key too
    const writes = writesOf(mock);
    await expect(diag.applyRestore(diff, { factoryOk: true })).rejects.toThrow(RestoreRefusedError);
    expect(writes).toEqual([]);
    expect(await mock.getKeycode(tab, 2)).toBe(0xf200);
  });

  it('P5: a file whose only differences are factory keycodes → the "only factory keys" warn toast, not "identical"', async () => {
    const { mock, key, diag } = await demoWith('max');
    const payload = await diag.generateBackup();
    const q = key('Q');
    payload.keymap[0][q.id] = 0xf200; // the file has a factory code where the keyboard has an ordinary key
    const writes = writesOf(mock);
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/diagnostics');
    w = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    const input = w.find<HTMLInputElement>('input[type="file"]').element;
    Object.defineProperty(input, 'files', { value: [new File([JSON.stringify(payload)], 'b.json')], configurable: true });
    input.dispatchEvent(new Event('change'));
    const toasts = useToast().items;
    await vi.waitFor(() => expect(toasts.value.length).toBeGreaterThan(0), { timeout: 15000 });
    expect(toasts.value.map((x) => [x.kind, x.text])).toEqual([['warn', t('diagnostics.importUnrestorableOnly', { n: 1 })]]);
    expect(toasts.value.some((x) => x.text === t('diagnostics.importNoChanges'))).toBe(false);
    expect(document.body.querySelector('.dlg__panel')).toBeNull();
    expect(writes).toEqual([]);
  });
});
