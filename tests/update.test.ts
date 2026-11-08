import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { buildVersionString, computeReleaseFileList, formatUtcStamp } from '../build/release';
import { compareVersions, isNewerVersion, useUpdateStore } from '../src/update';
import { useDeviceStore } from '../src/stores/device';
import { useCalibrationStore } from '../src/stores/calibration';
import { useSyncStore } from '../src/stores/sync';

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

  describe('version stamping and comparison', () => {
    it('generates 14-digit UTC stamp with second resolution', () => {
      const d = new Date('2026-11-09T00:20:16Z');
      const stamp = formatUtcStamp(d);
      expect(stamp).toBe('20261109002016');
      expect(buildVersionString('0.1.0', d)).toBe('0.1.0+20261109002016');
    });

    it('compares semver cores accurately', () => {
      expect(compareVersions('0.2.0', '0.1.0')).toBeGreaterThan(0);
      expect(compareVersions('0.1.0', '0.2.0')).toBeLessThan(0);
      expect(compareVersions('1.0.0', '0.9.9')).toBeGreaterThan(0);
      expect(compareVersions('0.1.1', '0.1.0')).toBeGreaterThan(0);
      expect(compareVersions('0.1.0', '0.1.0')).toBe(0);
    });

    it('compares build metadata as timestamps', () => {
      // Second resolution: later second is newer
      expect(compareVersions('0.1.0+20261109002017', '0.1.0+20261109002016')).toBeGreaterThan(0);
      expect(compareVersions('0.1.0+20261109002015', '0.1.0+20261109002016')).toBeLessThan(0);

      // 14-digit timestamp vs 12-digit timestamp
      expect(compareVersions('0.1.0+20261109002016', '0.1.0+202611082200')).toBeGreaterThan(0);
      expect(compareVersions('0.1.0+202611082200', '0.1.0+20261109002016')).toBeLessThan(0);
    });

    it('isNewerVersion rejects downgrades and identical versions', () => {
      expect(isNewerVersion('0.1.0', '0.2.0')).toBe(false);
      expect(isNewerVersion('0.1.0+202611082200', '0.1.0+20261109002016')).toBe(false);
      expect(isNewerVersion('0.1.0+20261109002016', '0.1.0+20261109002016')).toBe(false);
      expect(isNewerVersion('0.2.0+20261109002016', '0.1.0+20261109002016')).toBe(true);
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

    it('fallback fetch without service worker: downgrade is not offered', async () => {
      const store = useUpdateStore();

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ version: '0.0.1+20260101000000', builtAt: '2026-01-01T00:00:00Z', files: [] }),
      });
      vi.stubGlobal('fetch', mockFetch);

      await store.check();

      expect(store.state).toBe('upToDate');
      expect(store.availableInfo).toBeNull();
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

      const mockController = {
        postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => {
          if (msg.type === 'check') {
            ports[0].postMessage({
              ok: true,
              available: true,
              latest: '99.0.0+202611082200',
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
        version: '99.0.0+202611082200',
        builtAt: '2026-11-08T22:00:00Z',
      });
    });

    it('service worker messaging: downgrade is not offered even if SW reported available', async () => {
      const store = useUpdateStore();

      const mockController = {
        postMessage: vi.fn((msg: { type: string }, ports: MessagePort[]) => {
          if (msg.type === 'check') {
            ports[0].postMessage({
              ok: true,
              available: true,
              latest: '0.0.1+20260101000000',
              builtAt: '2026-01-01T00:00:00Z',
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

      expect(store.state).toBe('upToDate');
      expect(store.availableInfo).toBeNull();
    });

    it('service worker messaging: apply sends offered version and calls reload on success', async () => {
      const store = useUpdateStore();
      store.availableInfo = { version: '0.2.0', builtAt: '' };

      const reloadMock = vi.fn();
      const origLocation = window.location;
      Object.defineProperty(window, 'location', {
        value: { ...origLocation, reload: reloadMock },
        writable: true,
        configurable: true,
      });

      let sentMsg: any = null;
      const mockController = {
        postMessage: vi.fn((msg: { type: string; version?: string }, ports: MessagePort[]) => {
          if (msg.type === 'apply') {
            sentMsg = msg;
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

      expect(sentMsg).toEqual({ type: 'apply', version: '0.2.0' });
      expect(reloadMock).toHaveBeenCalled();
      Object.defineProperty(window, 'location', {
        value: origLocation,
        writable: true,
        configurable: true,
      });
    });

    it('service worker messaging: apply sets error on failure', async () => {
      const store = useUpdateStore();
      store.availableInfo = { version: '0.2.0', builtAt: '' };

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

    it('apply refused when exclusiveActive is true', async () => {
      const store = useUpdateStore();
      store.availableInfo = { version: '0.2.0', builtAt: '' };

      const device = useDeviceStore();
      vi.spyOn(device, 'exclusiveActive', 'get').mockReturnValue(true);
      expect(device.exclusiveActive).toBe(true);

      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
        configurable: true,
      });

      await store.apply();

      expect(store.state).toBe('error');
      expect(store.error).toMatch(/keyboard write|operation in progress/i);
      expect(reloadMock).not.toHaveBeenCalled();
    });

    it('apply refused when calibration is running', async () => {
      const store = useUpdateStore();
      store.availableInfo = { version: '0.2.0', builtAt: '' };

      const calibration = useCalibrationStore();
      calibration.phase = 'running';

      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
        configurable: true,
      });

      await store.apply();

      expect(store.state).toBe('error');
      expect(store.error).toMatch(/calibration is running/i);
      expect(reloadMock).not.toHaveBeenCalled();
    });

    it('apply aborted when sync.flush rejects', async () => {
      const store = useUpdateStore();
      store.availableInfo = { version: '0.2.0', builtAt: '' };

      const sync = useSyncStore();
      vi.spyOn(sync, 'flush').mockRejectedValue(new Error('Unsaved device edits'));

      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { reload: reloadMock },
        writable: true,
        configurable: true,
      });

      await store.apply();

      expect(store.state).toBe('error');
      expect(store.error).toBe('Unsaved device edits');
      expect(reloadMock).not.toHaveBeenCalled();
    });
  });
});
