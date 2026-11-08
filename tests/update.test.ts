import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { computeReleaseFileList } from '../build/release';
import { useUpdateStore } from '../src/update';

describe('update', () => {
  describe('computeReleaseFileList', () => {
    it('filters out sw.js and release.json, and includes ./ and index.html', () => {
      const bundle = {
        'assets/index-abc.js': {},
        'assets/style-123.css': {},
        'favicon.svg': {},
        'sw.js': {},
        'release.json': {},
      };

      const files = computeReleaseFileList(bundle);
      expect(files).toContain('./');
      expect(files).toContain('index.html');
      expect(files).toContain('assets/index-abc.js');
      expect(files).toContain('assets/style-123.css');
      expect(files).toContain('favicon.svg');
      expect(files).not.toContain('sw.js');
      expect(files).not.toContain('release.json');
    });

    it('normalises windows paths and strips leading ./', () => {
      const list = ['assets\\sub\\app.js', './favicon.svg', 'release.json'];
      const files = computeReleaseFileList(list);
      expect(files).toContain('assets/sub/app.js');
      expect(files).toContain('favicon.svg');
      expect(files).not.toContain('release.json');
      expect(files).toContain('./');
      expect(files).toContain('index.html');
    });
  });

  describe('update store state machine', () => {
    beforeEach(() => {
      setActivePinia(createPinia());
      vi.restoreAllMocks();
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('initial state is idle with currentVersion', () => {
      const store = useUpdateStore();
      expect(store.state).toBe('idle');
      expect(store.error).toBeNull();
      expect(store.availableInfo).toBeNull();
    });

    it('fallback fetch without service worker: detects up-to-date', async () => {
      const store = useUpdateStore();

      // Mock global fetch
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: store.currentVersion, builtAt: '2026-11-08T16:00:00Z', files: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.check();

      expect(mockFetch).toHaveBeenCalledWith('/release.json', { cache: 'no-store' });
      expect(store.state).toBe('upToDate');
      expect(store.availableInfo).toBeNull();
    });

    it('fallback fetch without service worker: detects new version', async () => {
      const store = useUpdateStore();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '99.0.0+9999', builtAt: '2026-11-08T20:00:00Z', files: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.check();

      expect(store.state).toBe('available');
      expect(store.availableInfo).toEqual({
        version: '99.0.0+9999',
        builtAt: '2026-11-08T20:00:00Z',
      });
    });

    it('fallback fetch error sets error state', async () => {
      const store = useUpdateStore();

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network offline')));

      await store.check();

      expect(store.state).toBe('error');
      expect(store.error).toBe('Network offline');
    });

    it('service worker messaging: check returns available', async () => {
      const store = useUpdateStore();

      // Mock navigator.serviceWorker with controller
      const mockController = {
        postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => {
          if (msg.type === 'check') {
            ports[0].postMessage({
              ok: true,
              available: true,
              latest: '0.2.0+202611082200',
              builtAt: '2026-11-08T22:00:00Z',
            });
          }
        }),
      };

      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          controller: mockController,
          ready: Promise.resolve({}),
        },
        configurable: true,
      });

      await store.check();

      expect(store.state).toBe('available');
      expect(store.availableInfo).toEqual({
        version: '0.2.0+202611082200',
        builtAt: '2026-11-08T22:00:00Z',
      });
    });

    it('service worker messaging: apply calls reload on success', async () => {
      const store = useUpdateStore();

      const reloadMock = vi.fn();
      const origLocation = window.location;
      Object.defineProperty(window, 'location', {
        value: { ...origLocation, reload: reloadMock },
        writable: true,
        configurable: true,
      });

      const mockController = {
        postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => {
          if (msg.type === 'apply') {
            ports[0].postMessage({ ok: true, version: '0.2.0' });
          }
        }),
      };

      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          controller: mockController,
          ready: Promise.resolve({}),
        },
        configurable: true,
      });

      await store.apply();

      expect(reloadMock).toHaveBeenCalled();
      Object.defineProperty(window, 'location', {
        value: origLocation,
        writable: true,
        configurable: true,
      });
    });

    it('service worker messaging: apply sets error on failure', async () => {
      const store = useUpdateStore();

      const mockController = {
        postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => {
          if (msg.type === 'apply') {
            ports[0].postMessage({ ok: false, error: 'Cache quota exceeded' });
          }
        }),
      };

      Object.defineProperty(navigator, 'serviceWorker', {
        value: {
          controller: mockController,
          ready: Promise.resolve({}),
        },
        configurable: true,
      });

      await store.apply();

      expect(store.state).toBe('error');
      expect(store.error).toBe('Cache quota exceeded');
    });
  });
});
