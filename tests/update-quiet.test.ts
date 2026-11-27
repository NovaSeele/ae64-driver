import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { QUIET_CHECK_MIN_MS, useUpdateStore, type UpdateState } from '../src/update';
import { useSyncStore } from '../src/stores/sync';
import { useCalibrationStore } from '../src/stores/calibration';
import SidebarFooter from '../src/components/shell/SidebarFooter.vue';
import { locale, setLocale } from '../src/i18n/locale';
import { t as tr, vi as viDict } from '../src/i18n/vi';
import { en as enDict } from '../src/i18n/en';

const flags = vi.hoisted(() => ({ desktop: false }));
vi.mock('../src/update/desktop', () => ({
  get DESKTOP() {
    return flags.desktop;
  },
}));

const origOnLine = Object.getOwnPropertyDescriptor(Navigator.prototype, 'onLine');
const origVisibility = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

function setOnLine(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { value, configurable: true });
}

function setVisibility(value: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { value, configurable: true });
}

function mockRelease(version: string, builtAt = '2026-11-27T12:00:00Z') {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ version, builtAt, files: [] }),
  });
}

describe('update quiet checks', () => {
  const savedLocale = locale.value;

  beforeEach(() => {
    flags.desktop = false;
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    setOnLine(true);
    setVisibility('visible');
  });

  afterEach(() => {
    flags.desktop = false;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    if (origOnLine) Object.defineProperty(navigator, 'onLine', origOnLine);
    else Reflect.deleteProperty(navigator, 'onLine');
    if (origVisibility) Object.defineProperty(document, 'visibilityState', origVisibility);
    else Reflect.deleteProperty(document, 'visibilityState');
    setLocale(savedLocale);
    document.body.innerHTML = '';
  });

  describe('checkQuietly', () => {
    it('newer release transitions to available with availableInfo without entering checking', async () => {
      const store = useUpdateStore();
      const statesSeen: UpdateState[] = [];
      let resolveFetch!: (v: unknown) => void;
      const fetchMock = vi.fn().mockImplementation(() => new Promise((r) => { resolveFetch = r; }));
      vi.stubGlobal('fetch', fetchMock);

      const p = store.checkQuietly();
      statesSeen.push(store.state);
      resolveFetch({
        ok: true,
        json: async () => ({ version: '99.0.0+20261127120000', builtAt: '2026-11-27T12:00:00Z' }),
      });
      await p;

      expect(fetchMock).toHaveBeenCalledWith('/release.json', { cache: 'no-store' });
      expect(statesSeen).toEqual(['idle']);
      expect(store.state).toBe('available');
      expect(store.availableInfo).toEqual({
        version: '99.0.0+20261127120000',
        builtAt: '2026-11-27T12:00:00Z',
      });
      expect(store.error).toBeNull();
    });

    it('same version keeps state idle', async () => {
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease(store.currentVersion));

      await store.checkQuietly();

      expect(store.state).toBe('idle');
      expect(store.availableInfo).toBeNull();
      expect(store.error).toBeNull();
    });

    it('fetch rejection, non-OK response, and bad JSON stay idle with error null', async () => {
      vi.useFakeTimers();

      const store1 = useUpdateStore();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network down')));
      await store1.checkQuietly();
      expect(store1.state).toBe('idle');
      expect(store1.error).toBeNull();

      vi.advanceTimersByTime(QUIET_CHECK_MIN_MS);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }));
      await store1.checkQuietly();
      expect(store1.state).toBe('idle');
      expect(store1.error).toBeNull();

      vi.advanceTimersByTime(QUIET_CHECK_MIN_MS);
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      }));
      await store1.checkQuietly();
      expect(store1.state).toBe('idle');
      expect(store1.error).toBeNull();
    });

    it.each<UpdateState>(['available', 'deferred', 'downloading', 'checking'])(
      'does not fetch when state is %s',
      async (blockedState) => {
        const store = useUpdateStore();
        store.state = blockedState;
        const fetchMock = mockRelease('99.0.0+20261127120000');
        vi.stubGlobal('fetch', fetchMock);

        await store.checkQuietly();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.state).toBe(blockedState);
      },
    );

    it('throttles repeat calls within 30 min and fetches again after 30 min', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));

      const store = useUpdateStore();
      const fetchMock = mockRelease(store.currentVersion);
      vi.stubGlobal('fetch', fetchMock);

      await store.checkQuietly();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(QUIET_CHECK_MIN_MS - 1);
      await store.checkQuietly();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(1);
      await store.checkQuietly();
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('does not fetch when navigator.onLine is false', async () => {
      setOnLine(false);
      const store = useUpdateStore();
      const fetchMock = mockRelease('99.0.0+20261127120000');
      vi.stubGlobal('fetch', fetchMock);

      await store.checkQuietly();

      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.state).toBe('idle');
    });

    it('drops a late result if state changed to checking before it arrived', async () => {
      const store = useUpdateStore();
      let resolveFetch!: (v: unknown) => void;
      vi.stubGlobal('fetch', vi.fn().mockImplementation(() => new Promise((r) => { resolveFetch = r; })));

      const p = store.checkQuietly();
      store.state = 'checking';
      resolveFetch({
        ok: true,
        json: async () => ({ version: '99.0.0+20261127120000', builtAt: '2026-11-27T12:00:00Z' }),
      });
      await p;

      expect(store.state).toBe('checking');
      expect(store.availableInfo).toBeNull();
    });

    it('upToDate can transition to available on a newer release', async () => {
      const store = useUpdateStore();
      store.state = 'upToDate';
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));

      await store.checkQuietly();

      expect(store.state).toBe('available');
      expect(store.availableInfo?.version).toBe('99.0.0+20261127120000');
    });

    it('uses the service worker controller when present', async () => {
      const store = useUpdateStore();
      const postMessage = vi.fn((msg: { type: string }, ports: MessagePort[]) => {
        if (msg.type === 'check') {
          ports[0].postMessage({
            ok: true,
            available: true,
            latest: '99.0.0+20261127120000',
            builtAt: '2026-11-27T12:00:00Z',
          });
        }
      });
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { controller: { postMessage }, ready: Promise.resolve({}) },
        configurable: true,
      });
      const fetchMock = mockRelease('99.0.0+20261127120000');
      vi.stubGlobal('fetch', fetchMock);

      await store.checkQuietly();

      expect(postMessage).toHaveBeenCalledTimes(1);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.state).toBe('available');
      expect(store.availableInfo).toEqual({
        version: '99.0.0+20261127120000',
        builtAt: '2026-11-27T12:00:00Z',
      });
    });
  });

  describe('startQuietChecks', () => {
    it('runs the first check at 10 s, rechecks on visibilitychange after 31 min, and stops after stop()', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));

      const store = useUpdateStore();
      const fetchMock = mockRelease(store.currentVersion);
      vi.stubGlobal('fetch', fetchMock);

      const stop = store.startQuietChecks();
      try {
        await vi.advanceTimersByTimeAsync(9_999);
        expect(fetchMock).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Visibility change after 31 min triggers a second fetch
        vi.advanceTimersByTime(31 * 60 * 1000);
        setVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await flushPromises();
        expect(fetchMock).toHaveBeenCalledTimes(2);

        // Stop removes the listener and clears the interval
        stop();
        vi.advanceTimersByTime(61 * 60 * 1000);
        document.dispatchEvent(new Event('visibilitychange'));
        await flushPromises();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        stop();
      }
    });

    it('rechecks every 60 min only while visible', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));

      const store = useUpdateStore();
      const fetchMock = mockRelease(store.currentVersion);
      vi.stubGlobal('fetch', fetchMock);

      const stop = store.startQuietChecks();
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Hidden at 60 min -> skipped
        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 10_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // Visible at 120 min -> runs
        setVisibility('visible');
        await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        stop();
      }
    });
  });

  describe('SidebarFooter update button', () => {
    it('idle: no --update class, no pill, no dot, no label text', () => {
      setLocale('vi');
      const w = mount(SidebarFooter, { attachTo: document.body });
      const btn = w.find('.side-foot__btn');
      expect(btn.classes()).not.toContain('side-foot__btn--update');
      expect(btn.classes()).not.toContain('side-foot__btn--pill');
      expect(btn.find('.side-foot__dot').exists()).toBe(false);
      expect(btn.text().trim()).toBe('');
      expect(btn.attributes('aria-label')).toBe(tr('nav.update'));
      w.unmount();
    });

    it.each<'available' | 'deferred'>(['available', 'deferred'])(
      '%s expanded: pill with label text and accessible name keeping the suffix',
      async (pendingState) => {
        setLocale('vi');
        const store = useUpdateStore();
        store.availableInfo = { version: '99.0.0', builtAt: '' };
        store.deferredVersion = '99.0.0';
        store.state = pendingState;

        const w = mount(SidebarFooter, { props: { compact: false }, attachTo: document.body });
        const btn = w.find('.side-foot__btn');
        expect(btn.classes()).toContain('side-foot__btn--update');
        expect(btn.classes()).toContain('side-foot__btn--pill');
        expect(btn.find('.side-foot__dot').exists()).toBe(false);
        expect(btn.text().trim()).toBe('Bản mới');
        expect(btn.attributes('aria-label')).toContain(', có bản mới');

        // Also check English locale
        setLocale('en');
        await flushPromises();
        expect(btn.text().trim()).toBe('Update');
        expect(btn.attributes('aria-label')).toContain(', update available');
        w.unmount();
      },
    );

    it.each<'available' | 'deferred'>(['available', 'deferred'])(
      '%s compact: --update class and dot, no pill class and no label text',
      (pendingState) => {
        setLocale('vi');
        const store = useUpdateStore();
        store.availableInfo = { version: '99.0.0', builtAt: '' };
        store.deferredVersion = '99.0.0';
        store.state = pendingState;

        const w = mount(SidebarFooter, { props: { compact: true }, attachTo: document.body });
        const btn = w.find('.side-foot__btn');
        expect(btn.classes()).toContain('side-foot__btn--update');
        expect(btn.classes()).not.toContain('side-foot__btn--pill');
        expect(btn.find('.side-foot__dot').exists()).toBe(true);
        expect(btn.text().trim()).toBe('');
        expect(btn.attributes('aria-label')).toContain(', có bản mới');
        w.unmount();
      },
    );
  });

  describe('U1: screen-reader update announcement', () => {
    it('(a) status region exists and is empty before any check (kills UM1)', () => {
      setLocale('vi');
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');
      expect(region.exists()).toBe(true);
      expect(region.text()).toBe('');
      w.unmount();
    });

    it('(b) after a quiet check finds a release, the status region holds nav.updateFoundSr', async () => {
      setLocale('vi');
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');

      await store.checkQuietly();
      await flushPromises();

      expect(store.foundQuietly).toBe(true);
      expect(region.text()).toBe(tr('nav.updateFoundSr'));
      w.unmount();
    });

    it('(c) after a manual check() finds a release, the status region is empty (kills UM2)', async () => {
      setLocale('vi');
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');

      // Manual check from idle
      await store.check();
      await flushPromises();
      expect(store.state).toBe('available');
      expect(store.foundQuietly).toBe(false);
      expect(region.text()).toBe('');

      // Quiet check sets foundQuietly; a subsequent manual check() must reset it (kills UM2)
      setActivePinia(createPinia());
      const store2 = useUpdateStore();
      const w2 = mount(SidebarFooter, { attachTo: document.body });
      const region2 = w2.find('.side-foot > .sr-only[role="status"]');
      await store2.checkQuietly();
      await flushPromises();
      expect(store2.foundQuietly).toBe(true);
      expect(region2.text()).toBe(tr('nav.updateFoundSr'));

      await store2.check();
      await flushPromises();
      expect(store2.state).toBe('available');
      expect(store2.foundQuietly).toBe(false);
      expect(region2.text()).toBe('');

      w.unmount();
      w2.unmount();
    });

    it('(d) after apply() starts, the status region is empty', async () => {
      setLocale('vi');
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');

      await store.checkQuietly();
      await flushPromises();
      expect(region.text()).toBe(tr('nav.updateFoundSr'));

      const origLocation = window.location;
      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', { value: { ...origLocation, reload: reloadMock }, writable: true, configurable: true });
      try {
        let resolveFlush!: () => void;
        vi.spyOn(useSyncStore(), 'flush').mockImplementationOnce(() => new Promise<void>((r) => { resolveFlush = r; }));
        const applyPromise = store.apply();
        await flushPromises();

        expect(store.state).toBe('downloading');
        expect(store.foundQuietly).toBe(false);
        expect(region.text()).toBe('');

        resolveFlush();
        await applyPromise;

        // Also when apply() is refused because calibration is running (state stays 'available')
        store.foundQuietly = true;
        store.state = 'available';
        await flushPromises();
        expect(region.text()).toBe(tr('nav.updateFoundSr'));

        useCalibrationStore().phase = 'running';
        await store.apply();
        await flushPromises();
        expect(store.state).toBe('available');
        expect(store.foundQuietly).toBe(false);
        expect(region.text()).toBe('');
      } finally {
        Object.defineProperty(window, 'location', { value: origLocation, writable: true, configurable: true });
        w.unmount();
      }
    });

    it('(e) the update button and the dialog are not inside the status region', async () => {
      const store = useUpdateStore();
      store.availableInfo = { version: '99.0.0', builtAt: '' };
      store.state = 'available';
      store.foundQuietly = true;

      const w = mount(SidebarFooter, { attachTo: document.body });
      const btn = w.find('.side-foot__btn');
      await btn.trigger('click');
      await flushPromises();

      const regionEl = w.find('.side-foot > .sr-only[role="status"]').element;
      const dialogEl = document.querySelector('[role="dialog"]');
      expect(dialogEl).toBeTruthy();
      expect(regionEl.contains(btn.element)).toBe(false);
      expect(regionEl.contains(dialogEl!)).toBe(false);
      expect(btn.element.contains(regionEl)).toBe(false);
      expect(dialogEl!.contains(regionEl)).toBe(false);
      w.unmount();
    });

    it('(f) on desktop the status region stays empty', async () => {
      flags.desktop = true;
      setLocale('vi');
      const store = useUpdateStore();
      store.availableInfo = { version: '99.0.0', builtAt: '' };
      store.state = 'available';
      store.foundQuietly = true;

      const w = mount(SidebarFooter, { attachTo: document.body });
      await flushPromises();

      const region = w.find('.side-foot > .sr-only[role="status"]');
      expect(region.exists()).toBe(true);
      expect(region.text()).toBe('');
      expect(w.find('.side-foot__btn').classes()).not.toContain('side-foot__btn--pill');
      w.unmount();
    });

    it('(g) nav.updateFoundSr exists in vi and en with the exact strings', () => {
      expect(viDict['nav.updateFoundSr']).toBe(
        'Có bản mới của AE64 Control. Mở “Cập nhật & phiên bản” ở cuối thanh bên để cập nhật.',
      );
      expect(enDict['nav.updateFoundSr']).toBe(
        'A new version of AE64 Control is available. Open “Updates & version” at the bottom of the sidebar to update.',
      );
    });
  });

  describe('checkQuietly recovery from check error', () => {
    it('(h) after a failed manual check, quiet check finding a newer release moves to available, clears error, and announces', async () => {
      setLocale('vi');
      const store = useUpdateStore();
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Offline')));
      await store.check();
      expect(store.state).toBe('error');
      expect(store.error).toBe('Offline');
      expect(store.applyFailed).toBe(false);

      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      await store.checkQuietly();
      await flushPromises();

      expect(store.state).toBe('available');
      expect(store.availableInfo).toEqual({
        version: '99.0.0+20261127120000',
        builtAt: '2026-11-27T12:00:00Z',
      });
      expect(store.error).toBeNull();
      expect(store.foundQuietly).toBe(true);
      expect(region.text()).toBe(tr('nav.updateFoundSr'));
      w.unmount();
    });

    it('(i) after a failed manual check, quiet check with no newer release moves to upToDate and clears error', async () => {
      const store = useUpdateStore();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('HTTP 503')));
      await store.check();
      expect(store.state).toBe('error');
      expect(store.error).toBe('HTTP 503');

      vi.stubGlobal('fetch', mockRelease(store.currentVersion));
      await store.checkQuietly();

      expect(store.state).toBe('upToDate');
      expect(store.error).toBeNull();
      expect(store.foundQuietly).toBe(false);
    });

    it('(j) after a failed manual check, a failed quiet lookup keeps state error and the original error string', async () => {
      const store = useUpdateStore();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Original check error')));
      await store.check();
      expect(store.state).toBe('error');
      expect(store.error).toBe('Original check error');

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Quiet failure')));
      await store.checkQuietly();

      expect(store.state).toBe('error');
      expect(store.error).toBe('Original check error');
      expect(store.applyFailed).toBe(false);
    });

    it('(k) applyFailed true with state error: checkQuietly makes no fetch and no SW message and changes nothing', async () => {
      const store = useUpdateStore();
      store.state = 'error';
      store.applyFailed = true;
      store.error = 'Download failed';

      // No SW controller -> must not call fetch
      const fetchMock = mockRelease('99.0.0+20261127120000');
      vi.stubGlobal('fetch', fetchMock);
      await store.checkQuietly();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.state).toBe('error');
      expect(store.applyFailed).toBe(true);
      expect(store.error).toBe('Download failed');

      // With SW controller -> must not post SW message
      const postMessage = vi.fn();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { controller: { postMessage }, ready: Promise.resolve({}) },
        configurable: true,
      });
      await store.checkQuietly();
      expect(postMessage).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(store.state).toBe('error');
      expect(store.applyFailed).toBe(true);
      expect(store.error).toBe('Download failed');
    });

    it('(l) quiet check started in error is dropped if a manual check starts and fails before the quiet answer arrives', async () => {
      const store = useUpdateStore();
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('First failure')));
      await store.check();
      expect(store.state).toBe('error');

      let resolveQuiet!: (v: unknown) => void;
      const fetchMock = vi.fn()
        .mockImplementationOnce(() => new Promise((r) => { resolveQuiet = r; }))
        .mockRejectedValueOnce(new Error('Second failure'));
      vi.stubGlobal('fetch', fetchMock);

      const quietPromise = store.checkQuietly();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await store.check();
      expect(store.state).toBe('error');
      expect(store.error).toBe('Second failure');

      resolveQuiet({
        ok: true,
        status: 200,
        json: async () => ({ version: '99.0.0+20261127120000', builtAt: '2026-11-27T12:00:00Z' }),
      });
      await quietPromise;

      expect(store.state).toBe('error');
      expect(store.error).toBe('Second failure');
      expect(store.availableInfo).toBeNull();
      expect(store.foundQuietly).toBe(false);
    });
  });

  describe('mutant guards (QM1, QM2, QM6)', () => {
    it('QM1: checkQuietly() on desktop makes no fetch and no SW message from idle or check-error', async () => {
      flags.desktop = true;
      const store = useUpdateStore();

      for (const startState of ['idle', 'error'] as const) {
        store.state = startState;
        store.applyFailed = false;
        store.error = startState === 'error' ? 'Prev check error' : null;

        // Without SW controller
        Reflect.deleteProperty(navigator, 'serviceWorker');
        const fetchMock = mockRelease('99.0.0+20261127120000');
        vi.stubGlobal('fetch', fetchMock);
        await store.checkQuietly();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.state).toBe(startState);

        // With SW controller
        const postMessage = vi.fn();
        Object.defineProperty(navigator, 'serviceWorker', {
          value: { controller: { postMessage }, ready: Promise.resolve({}) },
          configurable: true,
        });
        await store.checkQuietly();
        expect(postMessage).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(store.state).toBe(startState);
      }
    });

    it('QM2: startQuietChecks() on desktop sets no timers or listener and never checks', async () => {
      flags.desktop = true;
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));

      const store = useUpdateStore();
      const fetchMock = mockRelease('99.0.0+20261127120000');
      vi.stubGlobal('fetch', fetchMock);
      const postMessage = vi.fn();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { controller: { postMessage }, ready: Promise.resolve({}) },
        configurable: true,
      });
      const addListenerSpy = vi.spyOn(document, 'addEventListener');

      const stop = store.startQuietChecks();
      try {
        expect(vi.getTimerCount()).toBe(0);
        expect(addListenerSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function));

        await vi.advanceTimersByTimeAsync(10_000);
        await vi.advanceTimersByTimeAsync(61 * 60 * 1000);
        setVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await flushPromises();

        expect(fetchMock).not.toHaveBeenCalled();
        expect(postMessage).not.toHaveBeenCalled();
        expect(store.state).toBe('idle');
      } finally {
        stop();
      }
    });

    it.each([
      ['rejected fetch', () => vi.fn().mockRejectedValue(new Error('Network down'))],
      ['HTTP 500', () => vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })],
    ])('QM6: failed quiet lookup (%s) is still throttled for 30 min', async (_label, makeFetch) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-27T12:00:00Z'));

      const store = useUpdateStore();
      const fetchMock = makeFetch();
      vi.stubGlobal('fetch', fetchMock);

      const stop = store.startQuietChecks();
      try {
        await vi.advanceTimersByTimeAsync(10_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(store.state).toBe('idle');

        // 1 min later, visibilitychange to visible -> throttled, no second fetch
        vi.advanceTimersByTime(60 * 1000);
        setVisibility('visible');
        document.dispatchEvent(new Event('visibilitychange'));
        await flushPromises();
        expect(fetchMock).toHaveBeenCalledTimes(1);

        // 31 min after the initial check -> allowed, exactly one more fetch
        vi.advanceTimersByTime(30 * 60 * 1000);
        document.dispatchEvent(new Event('visibilitychange'));
        await flushPromises();
        expect(fetchMock).toHaveBeenCalledTimes(2);
      } finally {
        stop();
      }
    });
  });

  describe('U1b: spoken once, cleared after 10 s, deferred while hidden', () => {
    it('(m) VI->EN->VI after a find keeps the vi text unchanged, and an empty span stays empty on switch (kills UM3)', async () => {
      vi.useFakeTimers();
      setLocale('vi');
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');

      await store.checkQuietly();
      await flushPromises();
      expect(region.text()).toBe(viDict['nav.updateFoundSr']);

      setLocale('en');
      await flushPromises();
      expect(region.text()).toBe(viDict['nav.updateFoundSr']);

      setLocale('vi');
      await flushPromises();
      expect(region.text()).toBe(viDict['nav.updateFoundSr']);

      // After 10 s clear, language switches leave it empty
      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(region.text()).toBe('');

      setLocale('en');
      await flushPromises();
      expect(region.text()).toBe('');

      setLocale('vi');
      await flushPromises();
      expect(region.text()).toBe('');
      w.unmount();
    });

    it('(n) span is empty after 10 s while pill and aria-label suffix stay (kills UM4)', async () => {
      vi.useFakeTimers();
      setLocale('vi');
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      const w = mount(SidebarFooter, { props: { compact: false }, attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');
      const btn = w.find('.side-foot__btn');

      await store.checkQuietly();
      await flushPromises();
      expect(region.text()).toBe(viDict['nav.updateFoundSr']);

      await vi.advanceTimersByTimeAsync(9_999);
      await flushPromises();
      expect(region.text()).toBe(viDict['nav.updateFoundSr']);

      await vi.advanceTimersByTimeAsync(1);
      await flushPromises();
      expect(region.text()).toBe('');
      expect(btn.classes()).toContain('side-foot__btn--pill');
      expect(btn.text().trim()).toBe('Bản mới');
      expect(btn.attributes('aria-label')).toContain(viDict['nav.updateAvailableSuffix']);
      w.unmount();
    });

    it('(o) find while hidden waits for first visible event and does not refill on a second visible event (kills UM5, UM6)', async () => {
      vi.useFakeTimers();
      setLocale('vi');
      setVisibility('hidden');
      const store = useUpdateStore();
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));
      const w = mount(SidebarFooter, { attachTo: document.body });
      const region = w.find('.side-foot > .sr-only[role="status"]');

      await store.checkQuietly();
      await flushPromises();
      expect(store.state).toBe('available');
      expect(store.foundQuietly).toBe(true);
      expect(region.text()).toBe('');

      // First switch to visible fills it
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushPromises();
      expect(region.text()).toBe(viDict['nav.updateFoundSr']);

      // Clears after 10 s
      await vi.advanceTimersByTimeAsync(10_000);
      await flushPromises();
      expect(region.text()).toBe('');

      // Second hidden -> visible does NOT refill it
      setVisibility('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
      setVisibility('visible');
      document.dispatchEvent(new Event('visibilitychange'));
      await flushPromises();
      expect(region.text()).toBe('');
      w.unmount();
    });

    it('(p) check() or apply() within 10 s empties the span at once', async () => {
      vi.useFakeTimers();
      setLocale('vi');
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));

      // Case 1: manual check() within 10 s
      const store1 = useUpdateStore();
      const w1 = mount(SidebarFooter, { attachTo: document.body });
      const region1 = w1.find('.side-foot > .sr-only[role="status"]');
      await store1.checkQuietly();
      await flushPromises();
      expect(region1.text()).toBe(viDict['nav.updateFoundSr']);

      await vi.advanceTimersByTimeAsync(5_000);
      await store1.check();
      await flushPromises();
      expect(region1.text()).toBe('');
      w1.unmount();

      // Case 2: apply() within 10 s
      setActivePinia(createPinia());
      const store2 = useUpdateStore();
      const w2 = mount(SidebarFooter, { attachTo: document.body });
      const region2 = w2.find('.side-foot > .sr-only[role="status"]');
      await store2.checkQuietly();
      await flushPromises();
      expect(region2.text()).toBe(viDict['nav.updateFoundSr']);

      await vi.advanceTimersByTimeAsync(5_000);
      useCalibrationStore().phase = 'running';
      await store2.apply();
      await flushPromises();
      expect(region2.text()).toBe('');
      w2.unmount();
    });

    it('(q) unmount clears the pending announcement (kills UX2)', async () => {
      vi.useFakeTimers();
      setLocale('vi');
      vi.stubGlobal('fetch', mockRelease('99.0.0+20261127120000'));

      // Case 1: unmount while hidden removes the exact pending visibilitychange listener
      const addSpy = vi.spyOn(document, 'addEventListener');
      const removeSpy = vi.spyOn(document, 'removeEventListener');
      setVisibility('hidden');
      const store1 = useUpdateStore();
      const w1 = mount(SidebarFooter, { attachTo: document.body });

      await store1.checkQuietly();
      await flushPromises();
      expect(store1.state).toBe('available');
      expect(store1.foundQuietly).toBe(true);
      const visAdds = addSpy.mock.calls.filter(([ev]) => ev === 'visibilitychange');
      expect(visAdds).toHaveLength(1);
      const listener = visAdds[0][1];
      expect(typeof listener).toBe('function');

      w1.unmount();
      expect(removeSpy).toHaveBeenCalledWith('visibilitychange', listener);

      setVisibility('visible');
      expect(() => document.dispatchEvent(new Event('visibilitychange'))).not.toThrow();

      // Case 2: unmount within 10 s clears the pending clear timer
      setActivePinia(createPinia());
      const store2 = useUpdateStore();
      const w2 = mount(SidebarFooter, { attachTo: document.body });
      const region2 = w2.find('.side-foot > .sr-only[role="status"]');
      const timersBefore = vi.getTimerCount();

      await store2.checkQuietly();
      await flushPromises();
      expect(region2.text()).toBe(viDict['nav.updateFoundSr']);
      expect(vi.getTimerCount()).toBe(timersBefore + 1);

      await vi.advanceTimersByTimeAsync(5_000);
      w2.unmount();
      expect(vi.getTimerCount()).toBe(timersBefore);
    });
  });
});
