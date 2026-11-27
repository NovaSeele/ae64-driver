// MKB-V step 0 (DESIGN §16.1, safety rule S8): golden outgoing HID frame logs for the three AE64 seeds
// (`max`, `pro`, `pro-xinput`). Recorded on the untouched pre-MKB base (eeab422). Every outgoing 64-byte frame
// sent through BaseTransport (MockTransport, HidTransport, MockBootloader) is captured with fake timers and
// compared byte for byte against tests/golden/<seed>-<scenario>.json. Only the periodic active-profile poll
// (`02 03 01`, isProfilePoll) is dropped.
//
// Re-record (only before MKB starts): AE64_GOLDEN_RECORD=1 npx vitest run tests/golden-ae64.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { RouterView, createMemoryHistory, createRouter } from 'vue-router';
import { BaseTransport } from '../src/protocol/client';
import { FW_BOARD_MAX, FW_BOARD_PRO, FW_HEADER_BYTES } from '../src/protocol/firmware';
import { MockTransport } from '../src/protocol/mock';
import type { DemoSeed } from '../src/protocol/mock';
import { MockBootloader } from '../src/protocol/mockFirmware';
import type { MockFwBus } from '../src/protocol/mockFirmware';
import { NAV, PERF_TABS, installFirmwareGuard, installPerfTabGuard, routes } from '../src/router';
import { useAdvancedStore } from '../src/stores/advanced';
import { useCalibrationStore } from '../src/stores/calibration';
import { useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { useGamepadStore } from '../src/stores/gamepad';
import { useKeymapStore } from '../src/stores/keymap';
import { useLightingStore } from '../src/stores/lighting';
import { useLiveStore } from '../src/stores/live';
import { useMacroStore } from '../src/stores/macro';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import { useSyncStore } from '../src/stores/sync';
import { CRC, fileOf, makeFw, startWith } from './fw-helpers';
import { installFakeHid, removeFakeHid } from './fw-hid';
import { isProfilePoll } from './helpers/profilePoll';
import { tabReady } from './mountPerformance';

const SEEDS: readonly DemoSeed[] = ['max', 'pro', 'pro-xinput'];
const GOLDEN_DIR = path.resolve('tests', 'golden');
const RECORD = process.env.AE64_GOLDEN_RECORD === '1';
const FAKE_TIMERS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'Date', 'performance', 'requestAnimationFrame', 'cancelAnimationFrame',
] as const;
const FIXED_TIME = new Date('2026-01-01T00:00:00.000Z');
/** Synthetic firmware size: 4 KiB header + 224 B payload = 78 packets (77 × 56 B + 8 B). */
const GOLDEN_FW_SIZE = FW_HEADER_BYTES + 224;
/** Fixed 4 live ticks in Key test: tick 0 sends 3 reads, ticks 1–3 send 2 each → 9 × `04 03`. */
const LIVE_TEST_FOUR_TICKS_FRAMES = 9;
/** Fixed 4 live preview ticks in Lighting: 1 load + 4 live frames each ending at strip page 2 (`05 03 01 02`). */
const LIGHTING_END_MARKER = '05 03 01 02';
const LIGHTING_LOAD_PLUS_FOUR_TICKS = 5;

const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

/** Build the ordered route list from NAV, expanding /performance into all PERF_TABS. */
const PAGE_ROUTES: readonly string[] = NAV.flatMap((g) => g.items).flatMap((item) =>
  item.path === '/performance'
    ? PERF_TABS.map((tab) => `/performance?tab=${tab}`)
    : [item.path],
);

/** Preload all lazy pages and Performance tabs so route transitions resolve in microtasks under fake timers. */
async function preloadAllPages(): Promise<void> {
  await Promise.all([
    import('../src/pages/OverviewPage.vue'),
    import('../src/pages/PerformancePage.vue'),
    import('../src/pages/ProfilesPage.vue'),
    import('../src/pages/TypingPage.vue'),
    import('../src/pages/KeymapPage.vue'),
    import('../src/pages/MacroPage.vue'),
    import('../src/pages/LightingPage.vue'),
    import('../src/pages/GamepadPage.vue'),
    import('../src/pages/SettingsPage.vue'),
    import('../src/pages/DiagnosticsPage.vue'),
    import('../src/pages/FirmwarePage.vue'),
    import('../src/components/advanced/AdvancedTab.vue'),
    import('../src/components/switch/SwitchTab.vue'),
    import('../src/components/calibration/CalibrationView.vue'),
    import('../src/components/live/TestTab.vue'),
  ]);
}

function assertGolden<T>(seed: DemoSeed, scenario: string, actual: T): void {
  const file = path.join(GOLDEN_DIR, `${seed}-${scenario}.json`);
  if (RECORD) {
    writeFileSync(file, `${JSON.stringify(actual, null, 2)}\n`, 'utf8');
    return;
  }
  if (!existsSync(file)) {
    throw new Error(`Missing golden fixture for ${seed}/${scenario}: ${file} (record with AE64_GOLDEN_RECORD=1)`);
  }
  const expected = JSON.parse(readFileSync(file, 'utf8')) as T;
  expect(actual, `golden frame mismatch for ${seed}/${scenario}`).toEqual(expected);
}

/** Advance fake timers in small steps until `promise` settles. */
async function settle<T>(promise: Promise<T>, stepMs = 2, maxSteps = 25_000): Promise<T> {
  let done = false;
  let value!: T;
  let err: unknown;
  let failed = false;
  promise.then(
    (v) => { done = true; value = v; },
    (e) => { done = true; failed = true; err = e; },
  );
  for (let i = 0; i < maxSteps && !done; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!done) throw new Error('settle: timed out waiting for promise');
  if (failed) throw err;
  return value;
}

/** Advance fake timers in steps until `pred` returns true. */
async function waitUntil(pred: () => boolean, stepMs = 2, maxSteps = 25_000): Promise<void> {
  for (let i = 0; i < maxSteps && !pred(); i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!pred()) throw new Error('waitUntil: timed out waiting for condition');
}

interface Recorder {
  frames: string[];
  active: boolean;
  clear(): void;
  take(): string[];
  onOut: ((frame: Uint8Array, hex: string) => void) | null;
}

/** Spy on BaseTransport.prototype.log for every outgoing frame across MockTransport, HidTransport and MockBootloader. */
function installRecorder(): Recorder {
  const rec: Recorder = {
    frames: [],
    active: true,
    clear() { this.frames.length = 0; },
    take() { const out = this.frames.slice(); this.frames.length = 0; return out; },
    onOut: null,
  };
  const proto = BaseTransport.prototype as unknown as { log: (d: 'out' | 'in', b: Uint8Array, note?: string) => void };
  const orig = proto.log;
  vi.spyOn(proto, 'log').mockImplementation(function (this: BaseTransport, dir, bytes, note) {
    if (dir === 'out' && !isProfilePoll(bytes)) {
      const hex = toHex(bytes);
      if (rec.active) rec.frames.push(hex);
      rec.onOut?.(bytes, hex);
    }
    return orig.call(this, dir, bytes, note);
  });
  return rec;
}

/** Firmware file and typed confirmation matching each seed. */
function fwSpecFor(seed: DemoSeed): { bytes: Uint8Array; typed: string; expectedVersion: string } {
  if (seed === 'max') {
    return {
      bytes: makeFw({ size: GOLDEN_FW_SIZE, board: FW_BOARD_MAX, crc: CRC.max0040 }),
      typed: 'AE64 Max',
      expectedVersion: '0.0.4.0',
    };
  }
  if (seed === 'pro-xinput') {
    return {
      bytes: makeFw({ size: GOLDEN_FW_SIZE, board: FW_BOARD_PRO, crc: CRC.xinput081 }),
      typed: 'AE64 Pro',
      expectedVersion: '0.8.1',
    };
  }
  return {
    bytes: makeFw({ size: GOLDEN_FW_SIZE, board: FW_BOARD_PRO, crc: CRC.v0100 }),
    typed: 'AE64 Pro',
    expectedVersion: '0.1.0.0',
  };
}

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}

let activeWrappers: VueWrapper[] = [];

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
  vi.setSystemTime(FIXED_TIME);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
  setActivePinia(createPinia());
});

afterEach(async () => {
  for (const w of activeWrappers) w.unmount();
  activeWrappers = [];
  document.body.innerHTML = '';
  try {
    useLiveStore().stop();
    useLightingStore().stopLivePolling();
    const device = useDeviceStore();
    if (device.transport) await device.disconnect({ flush: false });
  } catch {
    // store not active
  }
  removeFakeHid();
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe('golden AE64 frame logs (S8)', { timeout: 60_000 }, () => {
  // ------------------------------------------------------------------ 1. connect
  describe.each(SEEDS)('%s: connect', (seed) => {
    it('matches golden connect frame log', async () => {
      const rec = installRecorder();
      const device = useDeviceStore();
      await settle(device.connectDemo(seed));
      expect(device.connected).toBe(true);
      // Let idle time elapse past PROFILE_POLL_MS to verify only profile polls fire (and are filtered).
      await vi.advanceTimersByTimeAsync(2500);
      const frames = rec.take();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].startsWith('01 02 ')).toBe(true);
      expect(frames[1].startsWith('01 01 ')).toBe(true);
      assertGolden(seed, 'connect', frames);
    });
  });

  // ------------------------------------------------------------------ 2. first visit to each page (NAV order)
  describe.each(SEEDS)('%s: pages', (seed) => {
    it('matches golden first-visit frame log for every route in NAV order', async () => {
      await preloadAllPages();
      const rec = installRecorder();
      rec.active = false;

      const device = useDeviceStore();
      const perf = usePerformanceStore();
      const settings = useSettingsStore();
      const adv = useAdvancedStore();
      const cal = useCalibrationStore();
      const keymap = useKeymapStore();
      const macro = useMacroStore();
      const lighting = useLightingStore();
      const gp = useGamepadStore();
      const fw = useFirmwareStore();

      await settle(device.connectDemo(seed));
      fw.setEnabled(true);

      const router = createRouter({ history: createMemoryHistory(), routes });
      installPerfTabGuard(router);
      installFirmwareGuard(router, () => ({ enabled: fw.enabled, active: fw.active, rescue: fw.rescue }));

      const byRoute: Record<string, string[]> = {};
      let wrapper: VueWrapper | null = null;

      for (const route of PAGE_ROUTES) {
        rec.clear();
        rec.active = true;

        // Track fixed poll-tick counts for live-polling pages and stop the poller before tick 5 starts.
        let liveAxisSent = 0;
        let lightingEndsSeen = 0;
        if (route === '/performance?tab=test') {
          rec.onOut = (frame) => {
            if (frame[0] === 0x04 && frame[1] === 0x03) {
              liveAxisSent++;
              if (liveAxisSent === LIVE_TEST_FOUR_TICKS_FRAMES) useLiveStore().stop();
            }
          };
        } else if (route === '/lighting') {
          rec.onOut = (_frame, hex) => {
            if (hex.startsWith(LIGHTING_END_MARKER)) {
              lightingEndsSeen++;
              if (lightingEndsSeen === LIGHTING_LOAD_PLUS_FOUR_TICKS) lighting.stopLivePolling();
            }
          };
        } else {
          rec.onOut = null;
        }

        if (!wrapper) {
          await router.push(route);
          await router.isReady();
          wrapper = mount(RouterView, { global: { plugins: [router] }, attachTo: document.body });
          activeWrappers.push(wrapper);
        } else {
          await router.push(route);
        }
        if (route.startsWith('/performance')) await tabReady(wrapper);
        else await flushPromises();

        switch (route) {
          case '/overview':
            await waitUntil(() => !perf.loading && perf.loadedProfile === device.activeProfile && settings.loaded && !settings.loading);
            break;
          case '/performance?tab=travel':
          case '/performance?tab=switch':
          case '/profiles':
            await waitUntil(() => !perf.loading && perf.loadedProfile === device.activeProfile);
            await vi.advanceTimersByTimeAsync(20);
            break;
          case '/performance?tab=advanced':
            await waitUntil(() => !adv.loading && adv.loadedProfile === device.activeProfile);
            break;
          case '/performance?tab=calibration':
            await waitUntil(() => cal.loaded && !perf.loading);
            break;
          case '/performance?tab=test':
            await waitUntil(() => liveAxisSent >= LIVE_TEST_FOUR_TICKS_FRAMES);
            // Let the 9th in-flight reply resolve cleanly now that live.stop() has bumped generation.
            await vi.advanceTimersByTimeAsync(4);
            break;
          case '/typing':
          case '/diagnostics':
            await vi.advanceTimersByTimeAsync(20);
            break;
          case '/keymap':
            await waitUntil(() => !keymap.loading && keymap.loadedProfile === device.activeProfile);
            break;
          case '/macro':
            await waitUntil(() => !macro.loading && macro.loaded && !keymap.loading);
            break;
          case '/lighting':
            await waitUntil(() => lightingEndsSeen >= LIGHTING_LOAD_PLUS_FOUR_TICKS);
            // Let the 4th live tick's final reply resolve cleanly now that stopLivePolling() was called.
            await waitUntil(() => !lighting.loading && lighting.loadedProfile === device.activeProfile);
            await vi.advanceTimersByTimeAsync(4);
            break;
          case '/gamepad':
            await waitUntil(() => gp.support !== 'unknown' && gp.support !== 'loading' && !perf.loading);
            break;
          case '/settings':
            await waitUntil(() => settings.loaded && !settings.loading);
            await vi.advanceTimersByTimeAsync(20);
            break;
          case '/firmware':
            await waitUntil(() => fw.listState !== 'loading' && (seed === 'max' || fw.kind !== null));
            await vi.advanceTimersByTimeAsync(20);
            break;
        }

        rec.onOut = null;
        rec.active = false;
        byRoute[route] = rec.take();
      }

      const total = Object.values(byRoute).reduce((n, list) => n + list.length, 0);
      expect(total).toBeGreaterThan(0);
      assertGolden(seed, 'pages', byRoute);
    });
  });

  // ------------------------------------------------------------------ 2b. cold visit to each page (fresh connection per route)
  describe.each(SEEDS)('%s: pages-cold', (seed) => {
    it('matches golden cold-entry frame log for each route independently', async () => {
      await preloadAllPages();
      const rec = installRecorder();
      rec.active = false;

      const byRoute: Record<string, string[]> = {};

      for (const route of PAGE_ROUTES) {
        localStorage.clear();
        vi.setSystemTime(FIXED_TIME);
        setActivePinia(createPinia());

        const device = useDeviceStore();
        const perf = usePerformanceStore();
        const settings = useSettingsStore();
        const adv = useAdvancedStore();
        const cal = useCalibrationStore();
        const keymap = useKeymapStore();
        const macro = useMacroStore();
        const lighting = useLightingStore();
        const gp = useGamepadStore();
        const fw = useFirmwareStore();

        rec.active = false;
        await settle(device.connectDemo(seed));
        fw.setEnabled(true);

        const router = createRouter({ history: createMemoryHistory(), routes });
        installPerfTabGuard(router);
        installFirmwareGuard(router, () => ({ enabled: fw.enabled, active: fw.active, rescue: fw.rescue }));

        let wrapper: VueWrapper | null = null;
        try {
          rec.clear();
          rec.active = true;

          let liveAxisSent = 0;
          let lightingEndsSeen = 0;
          if (route === '/performance?tab=test') {
            rec.onOut = (frame) => {
              if (frame[0] === 0x04 && frame[1] === 0x03) {
                liveAxisSent++;
                if (liveAxisSent === LIVE_TEST_FOUR_TICKS_FRAMES) useLiveStore().stop();
              }
            };
          } else if (route === '/lighting') {
            rec.onOut = (_frame, hex) => {
              if (hex.startsWith(LIGHTING_END_MARKER)) {
                lightingEndsSeen++;
                if (lightingEndsSeen === LIGHTING_LOAD_PLUS_FOUR_TICKS) lighting.stopLivePolling();
              }
            };
          } else {
            rec.onOut = null;
          }

          await router.push(route);
          await router.isReady();
          wrapper = mount(RouterView, { global: { plugins: [router] }, attachTo: document.body });
          if (route.startsWith('/performance')) await tabReady(wrapper);
          else await flushPromises();

          switch (route) {
            case '/overview':
              await waitUntil(() => !perf.loading && perf.loadedProfile === device.activeProfile && settings.loaded && !settings.loading);
              break;
            case '/performance?tab=travel':
            case '/performance?tab=switch':
            case '/profiles':
              await waitUntil(() => !perf.loading && perf.loadedProfile === device.activeProfile);
              await vi.advanceTimersByTimeAsync(20);
              break;
            case '/performance?tab=advanced':
              await waitUntil(() => !adv.loading && adv.loadedProfile === device.activeProfile);
              break;
            case '/performance?tab=calibration':
              await waitUntil(() => cal.loaded && !perf.loading && perf.loadedProfile === device.activeProfile);
              break;
            case '/performance?tab=test':
              // Cold Key test starts live polling and perf.load() together; stop live after 4 ticks, then let perf.load() finish.
              await waitUntil(() => liveAxisSent >= LIVE_TEST_FOUR_TICKS_FRAMES && !perf.loading && perf.loadedProfile === device.activeProfile);
              await vi.advanceTimersByTimeAsync(4);
              break;
            case '/typing':
            case '/diagnostics':
              await vi.advanceTimersByTimeAsync(20);
              break;
            case '/keymap':
              await waitUntil(() => !keymap.loading && keymap.loadedProfile === device.activeProfile);
              break;
            case '/macro':
              await waitUntil(() => !macro.loading && macro.loaded && !keymap.loading && keymap.loadedProfile === device.activeProfile);
              break;
            case '/lighting':
              await waitUntil(() => lightingEndsSeen >= LIGHTING_LOAD_PLUS_FOUR_TICKS);
              await waitUntil(() => !lighting.loading && lighting.loadedProfile === device.activeProfile);
              await vi.advanceTimersByTimeAsync(4);
              break;
            case '/gamepad':
              await waitUntil(() => gp.support !== 'unknown' && gp.support !== 'loading'
                && (gp.support !== 'ready' || (gp.usb !== null && !perf.loading && perf.loadedProfile === device.activeProfile)));
              break;
            case '/settings':
              await waitUntil(() => settings.loaded && !settings.loading);
              await vi.advanceTimersByTimeAsync(20);
              break;
            case '/firmware':
              await waitUntil(() => fw.listState !== 'loading' && (seed === 'max' || fw.kind !== null));
              await vi.advanceTimersByTimeAsync(20);
              break;
          }

          rec.onOut = null;
          rec.active = false;
          byRoute[route] = rec.take();
        } finally {
          rec.onOut = null;
          rec.active = false;
          wrapper?.unmount();
          document.body.innerHTML = '';
          useLiveStore().stop();
          lighting.stopLivePolling();
          if (device.transport) await device.disconnect({ flush: false });
        }
      }

      const total = Object.values(byRoute).reduce((n, list) => n + list.length, 0);
      expect(total).toBeGreaterThan(0);
      assertGolden(seed, 'pages-cold', byRoute);
    });
  });

  // ------------------------------------------------------------------ 3. one write of each kind
  describe.each(SEEDS)('%s: writes', (seed) => {
    it('matches golden frame log for one write of each kind', async () => {
      const rec = installRecorder();
      rec.active = false;

      const device = useDeviceStore();
      const sync = useSyncStore();
      const perf = usePerformanceStore();
      const keymap = useKeymapStore();
      const lighting = useLightingStore();
      const settings = useSettingsStore();
      const adv = useAdvancedStore();
      const macro = useMacroStore();
      const cal = useCalibrationStore();

      await settle(device.connectDemo(seed));

      const record = async (fn: () => Promise<void>): Promise<string[]> => {
        rec.clear();
        rec.active = true;
        try {
          await fn();
        } finally {
          rec.active = false;
        }
        return rec.take();
      };

      const writes: Record<string, string[]> = {};

      // Calibration start/stop before perf.load so cal.finish() does not mix a 64-key perf reload into calibration frames.
      writes.calibration = await record(async () => {
        await settle(cal.start());
        await waitUntil(() => cal.loaded);
        expect(await settle(cal.finish())).toBe(true);
      });

      // Preload stores (not recorded here; covered by `pages`).
      // Fix wall clock & hold exclusive only during lighting.load() setup so MockTransport's Date.now()-based
      // stand-in LED pattern returns identical initial RGB bytes regardless of PROFILE_POLL_MS.
      await settle(perf.load());
      await settle(keymap.load());
      {
        const release = device.holdExclusive();
        try {
          vi.setSystemTime(FIXED_TIME);
          await settle(lighting.load());
        } finally {
          release();
        }
      }
      await settle(settings.load());
      await settle(adv.load());
      await settle(macro.load());

      // Travel (04 02 + 02 02 02)
      writes.travel = await record(async () => {
        expect(perf.apply([0], () => ({ mode: 0, normalPress: 1.5 }), 'golden')).toBe(1);
        await settle(sync.flush());
      });

      // Switch change (04 02 with new catalog triple + 02 02 02)
      const currentSwitchId = perf.values[0].axisV2Id;
      const nextSwitch = perf.catalog!.find((e) => e.id !== currentSwitchId)!;
      writes.switchChange = await record(async () => {
        const res = perf.applySwitch({ kind: 'catalog', entry: nextSwitch }, [0]);
        expect(res.status).toBe('applied');
        await settle(sync.flush());
      });

      // Keymap key (03 04 + 02 02 04)
      writes.keymap = await record(async () => {
        keymap.applyKeycode([0], 0x0004);
        await settle(sync.flush());
      });

      // Lighting base (05 02 00 00 + 02 02 03)
      writes.lightingBase = await record(async () => {
        lighting.applyBase(0, { brightness: 60 }, 'golden');
        await settle(sync.flush());
      });

      // Lighting palette (05 02 00 01 + 02 02 03)
      writes.lightingPalette = await record(async () => {
        lighting.applyPaletteColor(0, 1, { r: 10, g: 20, b: 30 }, 'golden');
        await settle(sync.flush());
      });

      // Lighting per-key LED colours (05 04 00 + 02 02 03)
      writes.lightingKeyColors = await record(async () => {
        lighting.applyKeyColors([0], { r: 255, g: 0, b: 128 }, 'golden');
        await settle(sync.flush());
      });

      // Lighting strip LED colours (05 04 01 + 02 02 03)
      writes.lightingStripColors = await record(async () => {
        lighting.applyStripColors([0], { r: 0, g: 128, b: 255 }, 'golden');
        await settle(sync.flush());
      });

      // Advanced record: DKS on W (06 02 + 02 02 05 + tuning restore 04 02 + 02 02 02)
      const wId = device.keys.find((k) => k.name === 'W')!.id;
      writes.advanced = await record(async () => {
        await settle(adv.save({
          type: 'DKS', keys: [wId], keycodes: [0x04, 0, 0, 0], travels: [0xff, 0, 0, 0], dbs: [1.5, 3.0],
        }));
      });

      // Macro slot 1 (07 02 + 07 04 + 02 02 06)
      writes.macro = await record(async () => {
        await settle(macro.save(1, {
          mode: 0,
          repeatCount: 1,
          actions: [
            { keycode: 0x04, down: true, delay: 10 },
            { keycode: 0x04, down: false, delay: 10 },
          ],
        }));
      });

      // Settings device writes: system mode (02 04 02), RGB sleep (02 0d 00), shake (02 10 00), polling rate (02 05 02)
      writes.settingsSystemMode = await record(async () => {
        settings.setSystemMode(1);
        await settle(sync.flush());
      });
      writes.settingsRgbSleep = await record(async () => {
        settings.setRgbSleep(15);
        await settle(sync.flush());
      });
      writes.settingsShake = await record(async () => {
        settings.setShakeOptimization(false);
        await settle(sync.flush());
      });
      writes.settingsPollingRate = await record(async () => {
        await settle(settings.setPollingRate(1));
      });

      // Profile rename (02 03 04) and profile select (02 03 02)
      writes.profileRename = await record(async () => {
        await settle(device.renameProfile(0, 'Golden'));
      });
      writes.profileSelect = await record(async () => {
        await settle(device.switchProfile(1));
      });

      // Gamepad writes (10 xx) — only pro-xinput supports AGP1 writes; max and stock pro skip this.
      if (seed === 'pro-xinput') {
        const gp = useGamepadStore();
        await settle(gp.load());
        expect(gp.support).toBe('ready');
        vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView>(arr: T): T => {
          const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
          for (let i = 0; i < u8.length; i++) u8[i] = 0x11 * (i + 1);
          return arr;
        });

        writes.gamepad = await record(async () => {
          expect(gp.setMode(gp.config!.mode === 'mixed' ? 'controller' : 'mixed')).toBe(true);
          await settle(sync.flush());
        });
        writes.gamepadUsb = await record(async () => {
          expect(await settle(gp.setXboxDevice(false))).toBe(true);
        });
      }

      for (const [kind, frames] of Object.entries(writes)) {
        expect(frames.length, `${seed}/writes/${kind}`).toBeGreaterThan(0);
      }
      assertGolden(seed, 'writes', writes);
    });
  });

  // ------------------------------------------------------------------ 4. reconnect (WebHID tryAutoReconnect)
  describe.each(SEEDS)('%s: reconnect', (seed) => {
    it('matches golden WebHID tryAutoReconnect frame log', async () => {
      const app = new MockTransport({ seed });
      const bus = app.fwMock as MockFwBus;
      const hid = installFakeHid(bus);
      // Fresh pinia after installing fake navigator.hid so device.hidAvailable is true.
      setActivePinia(createPinia());

      const rec = installRecorder();
      rec.active = false;
      const device = useDeviceStore();
      expect(device.hidAvailable).toBe(true);

      hid.next = (all) => all.filter((d) => d.inner === app);
      await settle(device.connect());
      expect(device.connected).toBe(true);
      await device.disconnect({ flush: false });
      expect(device.connected).toBe(false);

      rec.clear();
      rec.active = true;
      const ok = await settle(device.tryAutoReconnect());
      expect(ok).toBe(true);
      expect(device.connected).toBe(true);
      await vi.advanceTimersByTimeAsync(2500);
      rec.active = false;

      const frames = rec.take();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].startsWith('01 02 ')).toBe(true);
      expect(frames[1].startsWith('01 01 ')).toBe(true);
      assertGolden(seed, 'reconnect', frames);
    });
  });

  // ------------------------------------------------------------------ 5a. firmware update (MockFwBus)
  describe.each(SEEDS)('%s: fw-update', (seed) => {
    it('matches golden MockFwBus firmware update frame log', async () => {
      const rec = installRecorder();
      rec.active = false;
      const device = useDeviceStore();
      await settle(device.connectDemo(seed));
      const t = device.transport as MockTransport;
      const bus = t.fwMock as MockFwBus;
      const fw = useFirmwareStore();
      const spec = fwSpecFor(seed);

      rec.clear();
      rec.active = true;
      await startWith(fw, spec.bytes, { typed: spec.typed });
      await waitUntil(() => !fw.active && fw.phase === 'done' && device.connected, 50);
      rec.active = false;

      expect(fw.phase).toBe('done');
      expect(fw.doneVersion).toBe(spec.expectedVersion);
      expect(bus.violations).toEqual([]);

      const frames = rec.take();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames.some((f) => f.startsWith('08 01 '))).toBe(true);
      expect(frames.some((f) => f.startsWith('08 02 '))).toBe(true);
      expect(frames.some((f) => f.startsWith('08 03 '))).toBe(true);
      expect(frames.some((f) => f.startsWith('08 04 '))).toBe(true);
      assertGolden(seed, 'fw-update', frames);
    });
  });

  // ------------------------------------------------------------------ 5b. firmware rescue (MockFwBus)
  describe.each(SEEDS)('%s: fw-rescue', (seed) => {
    it('matches golden MockFwBus rescue frame log', async () => {
      const rec = installRecorder();
      rec.active = false;
      const device = useDeviceStore();
      await settle(device.connectDemo(seed));
      const t = device.transport as MockTransport;
      const bus = t.fwMock as MockFwBus;
      const fw = useFirmwareStore();
      const spec = fwSpecFor(seed);
      // Third-party XInput build needs the labs switch enabled in rescue mode.
      fw.setEnabled(seed === 'pro-xinput');

      bus.replugAsBootloader();
      await vi.advanceTimersByTimeAsync(1000);
      const boot = (await bus.list()).find((d) => d instanceof MockBootloader)!;
      expect(boot).toBeTruthy();

      rec.clear();
      rec.active = true;
      await settle(device.adoptFromFirmware(boot, true));
      expect(fw.rescue).toBe(true);
      expect(fw.phase).toBe('rescue');

      await fw.chooseFile(fileOf(spec.bytes));
      if (fw.needsRisk) fw.riskOk = true;
      expect(fw.canRescueWrite).toBe(true);
      void fw.rescueWrite();
      await waitUntil(() => !fw.active && fw.phase === 'done' && device.connected, 50);
      rec.active = false;

      expect(fw.phase).toBe('done');
      expect(fw.doneVersion).toBe(spec.expectedVersion);
      expect(bus.violations).toEqual([]);

      const frames = rec.take();
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0].startsWith('01 02 ')).toBe(true);
      expect(frames.some((f) => f.startsWith('08 02 '))).toBe(true);
      expect(frames.some((f) => f.startsWith('08 03 '))).toBe(true);
      expect(frames.some((f) => f.startsWith('08 04 '))).toBe(true);
      assertGolden(seed, 'fw-rescue', frames);
    });
  });
});
