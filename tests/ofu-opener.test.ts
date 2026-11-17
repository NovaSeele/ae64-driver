// DESIGN OFU v1.7 §3.2 (r135): the maker's file link. Desktop: one explicit openUrl call (tauri-plugin-opener), no <a>, "(mở
// trong trình duyệt)". Web: the <a> stays (new tab, no opener, no referrer, "(mở thẻ mới)"). The Tauri side: one permission,
// opener:allow-open-url, scoped to https://hub.xsyd.top/storage/firmware/*, and no automatic link handling. Demo keyboard only,
// a fake fetch (no network), the plugin mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import * as fs from 'node:fs';
import * as path from 'node:path';
import FwFileStep from '../src/components/firmware/FwFileStep.vue';
import { openMakerUrl } from '../src/components/firmware/makerLink';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { locale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

const flags = vi.hoisted(() => ({ direct: false, desktop: true }));
vi.mock('../src/protocol/fwDownload', async (orig) => {
  const m = await orig<typeof import('../src/protocol/fwDownload')>();
  return { ...m, get FW_DIRECT() { return flags.direct; }, get FW_DESKTOP() { return flags.desktop; } };
});
const opener = vi.hoisted(() => ({ openUrl: vi.fn(async (_url: string) => undefined) }));
vi.mock('@tauri-apps/plugin-opener', () => opener);

const LIST = fs.readFileSync(path.resolve('public/firmware/manifest.json'), 'utf8');
let requests: string[] = [];
let wrappers: VueWrapper[] = [];
beforeEach(() => {
  locale.value = 'vi';
  flags.direct = false;
  flags.desktop = true;
  opener.openUrl.mockClear();
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requests.push(url);
    return url === '/firmware/manifest.json' ? new Response(LIST, { status: 200, headers: { 'content-type': 'application/json' } }) : new Response('no', { status: 404 });
  }));
});
afterEach(() => {
  wrappers.forEach((w) => w.unmount());
  wrappers = [];
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  locale.value = 'vi';
});

/** A demo Pro on 0.0.7.0: the card offers the newest build; FW_DIRECT off gives the link look (card and "Các bản khác"). */
async function page() {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo('pro');
  device.info!.firmware = '0.0.7.0';
  const fw = useFirmwareStore();
  fw.setEnabled(true);
  fw.openPage();
  await vi.waitFor(() => expect(fw.status.status).toBe('newer'));
  const w = mount(FwFileStep, { attachTo: document.body });
  wrappers.push(w);
  await flushPromises();
  await w.find('details[data-test="ofu-others"] summary').trigger('click');
  return { w, fw };
}

describe('OFU v1.7 §3.2: the maker link in the desktop app', () => {
  it('a button, no <a>: a click calls openUrl once with that build\'s URL; the hidden text says it opens the browser', async () => {
    const { w, fw } = await page();
    const links = w.findAll('[data-test="ofu-maker-link"]');
    expect(links.length).toBeGreaterThan(1); // the card and every row of "Các bản khác"
    expect(w.findAll('a').filter((a) => (a.attributes('href') ?? '').includes('hub.xsyd.top'))).toEqual([]);
    for (const l of links) {
      expect(l.element.tagName).toBe('BUTTON');
      expect(l.text()).toContain(tr('fw.on.newBrowser'));
      expect(l.text()).not.toContain(tr('fw.on.newTab'));
    }
    await w.find('[data-test="ofu-card"] [data-test="ofu-maker-link"]').trigger('click');
    await flushPromises();
    expect(opener.openUrl.mock.calls).toEqual([[fw.status.newest!.url]]);
    // a row of "Các bản khác" opens its own build
    const rows = w.findAll('[data-test="ofu-others"] [data-test="ofu-maker-link"]');
    await rows[rows.length - 1].trigger('click');
    await flushPromises();
    expect(opener.openUrl).toHaveBeenCalledTimes(2);
    expect(fw.builds.map((b) => b.url)).toContain(opener.openUrl.mock.calls[1][0]);
    expect(requests.filter((u) => u !== '/firmware/manifest.json')).toEqual([]); // a link never fetches the file
  });

  it('openMakerUrl opens only a URL of the allow-list, and never on the web', async () => {
    expect(await openMakerUrl('https://hub.xsyd.top/storage/firmware/cos/202610/x.bin')).toBe(true);
    for (const bad of ['https://hub.xsyd.top/keyboard/x.bin', 'https://evil.example/storage/firmware/x.bin', 'file:///C:/x.bin', 'https://hub.xsyd.top/storage/firmware/x.bin?a=1']) {
      expect(await openMakerUrl(bad), bad).toBe(false);
    }
    expect(opener.openUrl.mock.calls).toEqual([['https://hub.xsyd.top/storage/firmware/cos/202610/x.bin']]);
    flags.desktop = false;
    expect(await openMakerUrl('https://hub.xsyd.top/storage/firmware/cos/202610/x.bin')).toBe(false);
    expect(opener.openUrl).toHaveBeenCalledTimes(1);
  });

  it('a refused open (the scope or the plugin) ends quietly: no throw, nothing else opened', async () => {
    opener.openUrl.mockRejectedValueOnce(new Error('not allowed'));
    expect(await openMakerUrl('https://hub.xsyd.top/storage/firmware/cos/202610/x.bin')).toBe(false);
  });
});

describe('OFU v1.7 §3.2: the maker link on the web', () => {
  it('the <a> stays: the listed URL, a new tab, no opener, no referrer, "(mở thẻ mới)"; openUrl is never called', async () => {
    flags.desktop = false;
    const { w, fw } = await page();
    const a = w.find('[data-test="ofu-card"] a[data-test="ofu-maker-link"]');
    expect(a.attributes('href')).toBe(fw.status.newest!.url);
    expect(a.attributes('target')).toBe('_blank');
    expect(a.attributes('rel')).toBe('noopener noreferrer');
    expect(a.attributes('referrerpolicy')).toBe('no-referrer');
    expect(a.text()).toContain(tr('fw.on.newTab'));
    for (const l of w.findAll('[data-test="ofu-maker-link"]')) expect(l.element.tagName).toBe('A');
    a.element.addEventListener('click', (e) => e.preventDefault()); // jsdom: no navigation
    await a.trigger('click');
    expect(opener.openUrl).not.toHaveBeenCalled();
  });
});

describe('OFU v1.7 §3.2: the Tauri side', () => {
  it('the capability file allows exactly opener:allow-open-url on https://hub.xsyd.top/storage/firmware/*, for the main window', () => {
    const cap = JSON.parse(fs.readFileSync(path.resolve('src-tauri/capabilities/default.json'), 'utf8')) as { windows: string[]; permissions: unknown[]; description: string };
    expect(cap.windows).toEqual(['main']);
    expect(cap.permissions).toEqual([{ identifier: 'opener:allow-open-url', allow: [{ url: 'https://hub.xsyd.top/storage/firmware/*' }] }]);
    expect(cap.description).toContain('open_url');
  });

  it('the plugin is registered with its automatic link handling off, and only the page calls openUrl', () => {
    const main = fs.readFileSync(path.resolve('src-tauri/src/main.rs'), 'utf8');
    expect(main).toContain('.plugin(tauri_plugin_opener::Builder::new().open_js_links_on_click(false).build())');
    expect(main).not.toContain('tauri_plugin_opener::init()');
    // the page's one caller
    const callers = ['src/components/firmware/makerLink.ts', 'src/components/firmware/FwMakerLink.vue', 'src/components/firmware/FwOnline.vue']
      .filter((f) => fs.readFileSync(path.resolve(f), 'utf8').includes("'@tauri-apps/plugin-opener'"));
    expect(callers).toEqual(['src/components/firmware/makerLink.ts']);
  });
});
