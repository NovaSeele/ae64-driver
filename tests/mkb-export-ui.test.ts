// MKB-V step 2b UI tests: Diagnostics export button/dialog, support field, backup card hiding, and ConnectScreen refusal copy (§5.4, §9.2, §13).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { routes } from '../src/router';
import DiagnosticsPage from '../src/pages/DiagnosticsPage.vue';
import ConnectScreen from '../src/components/shell/ConnectScreen.vue';
import { BaseTransport } from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useDiagnosticsStore } from '../src/stores/diagnostics';
import { useToast } from '../src/components/ui/toast';
import { GITHUB_KEYBOARD_INFO_ISSUE_URL } from '../src/data/keyboardExport';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;

let wrapper: VueWrapper | null = null;
const nav = navigator as unknown as Record<string, unknown>;

function setNav(key: string, value: unknown): void {
  Object.defineProperty(navigator, key, { value, configurable: true, writable: true });
}

async function settle<T>(promise: Promise<T>, stepMs = 5, maxSteps = 20_000): Promise<T> {
  let done = false;
  let val!: T;
  let err: unknown;
  let failed = false;
  promise.then(
    (v) => { done = true; val = v; },
    (e) => { done = true; failed = true; err = e; },
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('settle: timed out');
  if (failed) throw err;
  return val;
}

async function waitUntil(pred: () => boolean, stepMs = 5, maxSteps = 20_000): Promise<void> {
  for (let i = 0; i < maxSteps && !pred(); i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!pred()) throw new Error('waitUntil: timed out');
}

beforeEach(() => {
  localStorage.clear();
  useToast().items.value = [];
  setLocale('vi');
  setActivePinia(createPinia());
});

afterEach(async () => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  try {
    const device = useDeviceStore();
    if (device.transport) await device.disconnect({ flush: false });
  } catch {
    // store not active
  }
  delete nav.clipboard;
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  setLocale('vi');
});

describe('ConnectScreen refusal copy button (DESIGN §5.4)', () => {
  it('gff80 refusal: shows copy button and copies VID, PID, productName, collections (incl. FF80) and reason with 0 extra HID', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });

    const device = useDeviceStore();
    await settle(device.connectGenericMock('gff80', { latencyMs: 0 }));
    expect(device.status).toBe('error');
    expect(device.refusal?.reason).toBe('receiver');

    wrapper = mount(ConnectScreen, { attachTo: document.body });
    await flushPromises();

    const btn = wrapper.find('[data-test="refusal-copy"]');
    expect(btn.exists()).toBe(true);
    expect(btn.text()).toBe(t('mkb.refuse.copy'));

    const proto = BaseTransport.prototype as unknown as { log: () => void };
    const logSpy = vi.spyOn(proto, 'log');
    await btn.trigger('click');
    await flushPromises();

    expect(logSpy).not.toHaveBeenCalled();
    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('VID: 0x1CA6');
    expect(copied).toContain('PID: 0xF00A');
    expect(copied).toContain('Product: Mock Receiver');
    expect(copied).toContain('0xFFB0:0x0001 (in:[64] out:[64])');
    expect(copied).toContain('0xFF80:0x0001 (in:[64] out:[64])');
    expect(copied).toContain('Reason: receiver');
    expect(copied).not.toContain('Protocol:');
  });

  it('gproto2 refusal: copies protocol version 2.0.0.0 alongside USB facts and reason', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });

    const device = useDeviceStore();
    await settle(device.connectGenericMock('gproto2', { latencyMs: 0 }));
    expect(device.status).toBe('error');
    expect(device.refusal?.reason).toBe('version');

    wrapper = mount(ConnectScreen, { attachTo: document.body });
    await flushPromises();

    await wrapper.find('[data-test="refusal-copy"]').trigger('click');
    await flushPromises();

    expect(writeText).toHaveBeenCalledTimes(1);
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain('VID: 0x1CA6');
    expect(copied).toContain('PID: 0xF007');
    expect(copied).toContain('Product: Mock Proto 2');
    expect(copied).toContain('0xFFB0:0x0001 (in:[64] out:[64])');
    expect(copied).toContain('Reason: version');
    expect(copied).toContain('Protocol: 2.0.0.0');
  });

  it('non-refusal error or idle state does not show the copy device info button', async () => {
    const device = useDeviceStore();
    wrapper = mount(ConnectScreen, { attachTo: document.body });
    expect(wrapper.find('[data-test="refusal-copy"]').exists()).toBe(false);

    device.status = 'error';
    device.error = 'Some generic error';
    device.refusal = null;
    await flushPromises();
    expect(wrapper.find('[data-test="refusal-copy"]').exists()).toBe(false);
  });
});

describe('DiagnosticsPage (DESIGN §9.2, §13)', () => {
  async function mountDiagnostics() {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/diagnostics');
    wrapper = mount(DiagnosticsPage, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
    return wrapper;
  }

  it('generic (g75): hides AE64 backup card, shows support=generic, Export button downloads file and opens public-notice dialog', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    vi.setSystemTime(new Date(2026, 10, 27, 14, 20));

    const device = useDeviceStore();
    await settle(device.connectGenericMock('g75', { latencyMs: 0 }));

    const w = await mountDiagnostics();
    expect(w.find('[data-test="diag-backup-card"]').exists()).toBe(false);
    expect(document.getElementById('diag-backup-title')).toBeNull();
    expect(w.find('[data-test="diag-support"]').text()).toContain('generic');

    const exportBtn = w.find('[data-test="export-keyboard-info"]');
    expect(exportBtn.exists()).toBe(true);
    expect(exportBtn.text()).toBe(t('mkb.export.button'));

    // Stub URL & anchor click to capture downloaded file name without leaving DOM artifacts.
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-export');
    const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await exportBtn.trigger('click');
    const diag = useDiagnosticsStore();
    await waitUntil(() => !diag.isExportingInfo && document.body.querySelector('[data-test="export-saved-notice"]') !== null);
    await flushPromises();

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith('blob:mock-export');
    expect(clickSpy).toHaveBeenCalledTimes(1);

    // Saved dialog appears with public notice and exact GitHub Issues link (no data in URL).
    const notice = document.body.querySelector('[data-test="export-saved-notice"]');
    expect(notice).toBeTruthy();
    const expectedFile = 'ae64control-keyboard-00f00002-20261127-1420.json';
    expect(notice!.textContent?.trim()).toBe(t('mkb.export.savedDialog', { file: expectedFile }));
    expect(notice!.textContent).toContain('công khai');

    const link = document.body.querySelector<HTMLAnchorElement>('[data-test="export-open-github"]');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe(GITHUB_KEYBOARD_INFO_ISSUE_URL);
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.textContent?.trim()).toBe(t('mkb.export.openGithub'));

    // English locale notice also states the issue and file are public.
    setLocale('en');
    await flushPromises();
    expect(notice!.textContent?.trim()).toBe(t('mkb.export.savedDialog', { file: expectedFile }));
    expect(notice!.textContent?.toLowerCase()).toContain('public');
  });

  it('AE64 (max): keeps AE64 backup card visible, shows support=ae64, and Export button runs export', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    vi.setSystemTime(new Date(2026, 10, 27, 14, 25));

    const device = useDeviceStore();
    await settle(device.connectDemo('max'));

    const w = await mountDiagnostics();
    expect(w.find('[data-test="diag-backup-card"]').exists()).toBe(true);
    expect(document.getElementById('diag-backup-title')).not.toBeNull();
    expect(w.find('[data-test="diag-support"]').text()).toContain('ae64');

    const exportBtn = w.find('[data-test="export-keyboard-info"]');
    expect(exportBtn.exists()).toBe(true);

    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock-ae64');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    await exportBtn.trigger('click');
    const diag = useDiagnosticsStore();
    await waitUntil(() => !diag.isExportingInfo && document.body.querySelector('[data-test="export-saved-notice"]') !== null);
    await flushPromises();

    const notice = document.body.querySelector('[data-test="export-saved-notice"]');
    expect(notice).toBeTruthy();
    expect(notice!.textContent?.trim()).toBe(
      t('mkb.export.savedDialog', { file: 'ae64control-keyboard-0030000d-20261127-1425.json' }),
    );
  });
});
