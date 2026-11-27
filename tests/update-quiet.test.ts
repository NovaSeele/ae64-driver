import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import { QUIET_CHECK_MIN_MS, useUpdateStore, type UpdateState } from '../src/update';
import SidebarFooter from '../src/components/shell/SidebarFooter.vue';
import { locale, setLocale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';

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
    setActivePinia(createPinia());
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'serviceWorker');
    setOnLine(true);
    setVisibility('visible');
  });

  afterEach(() => {
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

    it.each<UpdateState>(['available', 'deferred', 'downloading', 'checking', 'error'])(
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
});
