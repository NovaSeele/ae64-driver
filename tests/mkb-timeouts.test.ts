// TO1 (DESIGN MKB §5.2, §9.2, §16.2): Post-connect timeout handling and liveness checks for generic view-mode connections.
// Covers §16.2 TO1 tests 1–7, kills mutants MT1–MT7, plus profile-poll stop, live restart, concurrency and AE64 invariance.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import type { Pinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Router } from 'vue-router';
import {
  BaseTransport, GenericMockTransport, REQUEST_TIMEOUT_MS, TransportTimeoutError, WriteNotAllowedError,
} from '../src/protocol';
import type { Bytes } from '../src/protocol';
import { installPerfTabGuard, routes } from '../src/router';
import { setLocale } from '../src/i18n/locale';
import { t as tr } from '../src/i18n/vi';
import { PROFILE_POLL_MS, useDeviceStore } from '../src/stores/device';
import { useFirmwareStore } from '../src/stores/firmware';
import { useLiveStore } from '../src/stores/live';
import { usePerformanceStore } from '../src/stores/performance';
import { useSettingsStore } from '../src/stores/settings';
import SettingsPage from '../src/pages/SettingsPage.vue';
import ProfilesPage from '../src/pages/ProfilesPage.vue';
import ProfileSelect from '../src/components/shell/ProfileSelect.vue';
import { isProfilePoll } from './helpers/profilePoll';
import { mountPerformance, tabReady } from './mountPerformance';

vi.setConfig({ testTimeout: 30000 });

const FAKE_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date', 'performance'] as const;

let pinia: Pinia;
const mounted: VueWrapper[] = [];

const hex = (b: number): string => b.toString(16).padStart(2, '0');

function frameTag(f: Uint8Array): string {
  const len = f[0] === 0x01 ? 2
    : f[0] === 0x02 && f[1] === 0x03 && f[2] === 0x03 ? 4
      : f[0] === 0x03 && f[1] === 0x01 ? 4
        : 3;
  return Array.from(f.slice(0, len), hex).join(' ');
}

function captureOut() {
  const frames: Uint8Array[] = [];
  const proto = BaseTransport.prototype as unknown as { log: (d: 'out' | 'in', b: Uint8Array, note?: string) => void };
  const orig = proto.log;
  const spy = vi.spyOn(proto, 'log').mockImplementation(function (this: BaseTransport, dir, bytes, note) {
    if (dir === 'out') frames.push(Uint8Array.from(bytes));
    return orig.call(this, dir, bytes, note);
  });
  return { frames, tags: () => frames.map(frameTag), spy };
}

async function settle<T>(promise: Promise<T>, stepMs = 50, maxSteps = 2000): Promise<T> {
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

async function advanceUntil(pred: () => boolean, stepMs = 50, maxSteps = 2000): Promise<void> {
  for (let i = 0; i < maxSteps && !pred(); i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  if (!pred()) throw new Error('advanceUntil: condition not met');
}

function makeRouter(): Router {
  const r = createRouter({ history: createMemoryHistory(), routes });
  installPerfTabGuard(r);
  return r;
}

function buildDeviceInfoReply(boardBytes: readonly [number, number, number, number], runMode = 0): number[] {
  return [
    0x01, 0x02,
    1, 0,
    ...boardBytes,
    1, 0, 0, 0,
    1, 0, 0, 0,
    runMode,
    0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0,
  ];
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  setLocale('vi');
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb?: (e: unknown[]) => void) {}
    observe() { this.cb?.([{ contentRect: { width: 1000 } }]); }
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(async () => {
  useLiveStore().stop();
  while (mounted.length) mounted.pop()!.unmount();
  try {
    const device = useDeviceStore();
    if (device.transport) await device.disconnect({ flush: false });
  } catch {
    // store not active
  }
  await flushPromises();
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('TO1 Timeouts after the gates (DESIGN MKB §5.2, §9.2, §16.2)', () => {
  // Test 1 (kills MT1)
  it('1. Settings: 3 consecutive missing commands trigger one 01 02 liveness check, stay connected, hide missing rows and show answered ones', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.status).toBe('connected');

    const transport = device.transport as GenericMockTransport;
    const out = captureOut();
    // Drop 02 05 00, 02 05 01, 02 0D 01 (3 consecutive misses after 02 04 01); 01 02 still answers normally.
    transport.setReplyOverride(([f, op, a]) => {
      if (
        (f === 0x02 && op === 0x05 && (a === 0x00 || a === 0x01))
        || (f === 0x02 && op === 0x0d && a === 0x01)
      ) return null;
      return undefined;
    });

    const router = makeRouter();
    await router.push('/settings');
    await router.isReady();
    const w = mount(SettingsPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await advanceUntil(() => !useSettingsStore().loading && useSettingsStore().loaded);
    await flushPromises();

    // Exactly one 01 02 right after the 3rd miss (02 0d 01), then the remaining settings reads proceed.
    expect(out.tags()).toEqual([
      '02 04 01',
      '02 05 00',
      '02 05 01',
      '02 0d 01',
      '01 02',
      '02 10 01',
      '02 0e 00',
      '02 08 00',
    ]);
    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);
    expect(device.status).toBe('connected');
    expect(device.connected).toBe(true);
    expect(transport.connected).toBe(true);

    const s = useSettingsStore();
    expect(s.answered).toEqual({
      systemMode: true,
      pollingRate: false,
      rgbSleep: false,
      shakeOptimization: true,
      macroSpace: true,
      lightingAreas: true,
    });
    expect(w.find('[data-setting="systemMode"]').exists()).toBe(true);
    expect(w.find('[data-setting="pollingRate"]').exists()).toBe(false);
    expect(w.find('[data-setting="rgbSleep"]').exists()).toBe(false);
    expect(w.find('[data-setting="shakeOptimization"]').exists()).toBe(true);
    expect(w.find('[data-setting-info="macroSpace"]').exists()).toBe(true);
    expect(w.find('[data-setting-info="lightingAreas"]').exists()).toBe(true);

    // One-off page read is never retried by the store.
    const countAfterLoad = out.frames.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(out.frames).toHaveLength(countAfterLoad);
  });

  // Test 2 (kills MT2)
  it('2. Board stops answering everything after connect: 3 misses then one unanswered 01 02 -> closed with error.protocolUnknown, nothing sent after', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    expect(device.status).toBe('connected');
    const expectedName = device.displayName;

    const transport = device.transport as GenericMockTransport;
    const out = captureOut();
    // Stop answering everything (including 01 02) after connect.
    transport.setReplyOverride(() => null);

    const router = makeRouter();
    await router.push('/settings');
    await router.isReady();
    const w = mount(SettingsPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await advanceUntil(() => !useSettingsStore().loading);
    await flushPromises();

    expect(out.tags()).toEqual(['02 04 01', '02 05 00', '02 05 01', '01 02']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: expectedName }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(transport.connected).toBe(false);

    // Nothing sent after the close.
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(out.frames).toHaveLength(4);
  });

  // Test 3 (kills MT3)
  it.each([
    ['another board ID', buildDeviceInfoReply([0x00, 0xf0, 0x99, 0x99], 0)],
    ['run mode 255', buildDeviceInfoReply([0x00, 0xf0, 0x00, 0x04], 255)],
    ['non-zero run mode 1', buildDeviceInfoReply([0x00, 0xf0, 0x00, 0x04], 1)],
  ])('3. Liveness 01 02 answers with %s -> closed with error.protocolUnknown, nothing sent after', async (_label, reply) => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    const expectedName = device.displayName;
    const transport = device.transport as GenericMockTransport;
    const out = captureOut();

    transport.setReplyOverride(([f, op]) => {
      if (f === 0x01 && op === 0x02) return reply;
      return null;
    });

    const router = makeRouter();
    await router.push('/settings');
    await router.isReady();
    const w = mount(SettingsPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(w);
    await advanceUntil(() => !useSettingsStore().loading);
    await flushPromises();

    expect(out.tags()).toEqual(['02 04 01', '02 05 00', '02 05 01', '01 02']);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: expectedName }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(transport.connected).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(out.frames).toHaveLength(4);
  });

  // Test 4 (kills MT4)
  it('4. Generic mock without 04 03: Key test sends 3 × 04 03, then none over 10 s and exactly one 01 02; shows "không trả lời"; still connected; leaving and returning restarts it', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', {
      latencyMs: 0,
      overrideReply: ([f, op]) => (f === 0x04 && op === 0x03 ? null : undefined),
    }));
    expect(device.status).toBe('connected');
    // Pre-load performance settings so Key test sends only its own 04 03 reads.
    await settle(usePerformanceStore().load());

    const out = captureOut();
    const { w, router } = await mountPerformance('test', {}, { plugins: [pinia] });
    mounted.push(w);

    // Advance 10 s of fake time from mount (covers 3 × 1500 ms timeouts + 5.5 s after).
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    const live = useLiveStore();
    const liveFrames = out.frames.filter((f) => f[0] === 0x04 && f[1] === 0x03);
    const livenessFrames = out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02);
    expect(liveFrames).toHaveLength(3);
    expect(livenessFrames).toHaveLength(1);
    expect(live.running).toBe(false);
    expect(live.noAnswer).toBe(true);
    expect(w.find('[data-testid="live-no-answer"]').text()).toContain(tr('mkb.common.noAnswer'));
    expect(device.connected).toBe(true);
    expect(device.status).toBe('connected');

    // A full additional 10 s of fake time after stopping: zero further 04 03 or 01 02 frames.
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(out.frames.filter((f) => f[0] === 0x04 && f[1] === 0x03)).toHaveLength(3);
    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);

    // Leaving Key test and coming back starts polling again.
    out.frames.length = 0;
    await router.push('/performance?tab=travel');
    await tabReady(w);
    expect(live.noAnswer).toBe(false);
    await router.push('/performance?tab=test');
    await tabReady(w);
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(out.frames.filter((f) => f[0] === 0x04 && f[1] === 0x03)).toHaveLength(3);
    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);
    expect(live.running).toBe(false);
    expect(live.noAnswer).toBe(true);
    expect(w.find('[data-testid="live-no-answer"]').text()).toContain(tr('mkb.common.noAnswer'));
    expect(device.connected).toBe(true);
  });

  // Test 5 (kills MT5)
  it('5. gsilent: closed during init after 3 misses with no extra 01 02 (S6 unchanged)', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const out = captureOut();
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gsilent', { latencyMs: 0 }));

    // Only G1 (01 02), G4 (01 01), and the 3 timed-out init reads — NO second 01 02.
    expect(out.tags()).toEqual(['01 02', '01 01', '01 03', '02 03 00', '02 0c 00']);
    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: 'Mock Silent' }));
    expect(device.refusal?.reason).toBe('protocol');
  });

  // Test 6 (kills MT6)
  it('6. gspoof (0030000D): after a liveness check that answers, boardAllowed stays false, support stays generic, info untouched, and a hand-built 04 02 is still refused', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gspoof', { latencyMs: 0 }));
    expect(device.connected).toBe(true);
    expect(device.support).toBe('generic');
    expect(device.boardAllowed).toBe(false);

    const transport = device.transport as GenericMockTransport;
    const infoBefore = device.info;
    const setSupportSpy = vi.spyOn(transport, 'setSupport');
    const getInfoSpy = vi.spyOn(transport, 'getDeviceInfo');
    const out = captureOut();

    // Stop profile poll interference by silencing 02 03 01 too, and silence 02 04 01; 01 02 still answers 0030000D runMode 0.
    transport.setReplyOverride(([f, op, a]) => {
      if (f === 0x02 && op === 0x04 && a === 0x01) return null;
      if (f === 0x02 && op === 0x03 && a === 0x01) return null;
      return undefined;
    });

    for (let i = 0; i < 3; i++) {
      await expect(settle(device.withTransport((t) => t.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    }

    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);
    expect(getInfoSpy).not.toHaveBeenCalled();
    expect(setSupportSpy).not.toHaveBeenCalled();
    expect(device.connected).toBe(true);
    expect(device.status).toBe('connected');
    expect(device.info).toBe(infoBefore);
    expect(device.boardAllowed).toBe(false);
    expect(transport.boardAllowed).toBe(false);
    expect(device.support).toBe('generic');
    expect(transport.support).toBe('generic');

    // Hand-built 04 02 write must still be refused by Lock 1 (WriteNotAllowedError) with 0 04 02 frames sent.
    const req = (transport as unknown as { request(p: number[]): Promise<Bytes> }).request.bind(transport);
    const write0402 = [0x04, 0x02, 1, 0, 1, 0xd0, 0x07, 0xd0, 0x07, 0xe8, 0x03, 0xf4, 0x01, 0xf4, 0x01, 0x64, 0x00, 0x64, 0x00, 0, 1, 0x01, 0x30, 0xee, 0x0c, 0x20, 0x4e];
    await expect(req(write0402)).rejects.toThrow(WriteNotAllowedError);
    expect(out.frames.some((f) => f[0] === 0x04 && f[1] === 0x02)).toBe(false);
  });

  // Test 7 (kills MT7)
  it.each([
    ['gspoof (1CA6 + AE64 board 0030000D)', 'gspoof', [0x00, 0x30, 0x00, 0x0d] as const],
    ['g60 (1CA6 + generic board)', 'g60', [0x00, 0xf0, 0x00, 0x01] as const],
  ] as const)('7. Liveness 01 02 reply with run mode 255 on %s closes without rescue (fw.rescue false, 0 08 frames, no route to /firmware)', async (_label, mockName, boardBytes) => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const router = makeRouter();
    await router.push('/settings');
    await router.isReady();

    const device = useDeviceStore();
    const fw = useFirmwareStore();
    const openRescueSpy = vi.spyOn(fw, 'openRescue');
    await settle(device.connectGenericMock(mockName, { latencyMs: 0 }));
    const expectedName = device.displayName;
    const transport = device.transport as GenericMockTransport;
    const out = captureOut();

    transport.setReplyOverride(([f, op]) => {
      if (f === 0x01 && op === 0x02) return buildDeviceInfoReply(boardBytes, 255);
      return null;
    });

    for (let i = 0; i < 3; i++) {
      await expect(settle(device.withTransport((t) => t.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    }
    await flushPromises();

    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);
    expect(out.frames.some((f) => f[0] === 0x08)).toBe(false);
    expect(device.connected).toBe(false);
    expect(device.status).toBe('error');
    expect(device.error).toBe(tr('error.protocolUnknown', { name: expectedName }));
    expect(device.refusal?.reason).toBe('protocol');
    expect(transport.connected).toBe(false);
    expect(fw.rescue).toBe(false);
    expect(fw.active).toBe(false);
    expect(openRescueSpy).not.toHaveBeenCalled();
    expect(router.currentRoute.value.path).toBe('/settings');
    expect(router.currentRoute.value.path).not.toBe('/firmware');
  });

  // Additional TO1 checks: profile poll stops on its own 3 misses, concurrency single-flight, AE64 unaffected.
  it('profile poll stops on its own 3 consecutive misses while board is alive, shows active profile "không rõ", and only restarts on next connection', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));
    expect(device.connected).toBe(true);
    expect(device.unknown.profiles).toBe(false);

    const transport = device.transport as GenericMockTransport;
    const out = captureOut();
    // Silence ONLY 02 03 01; 01 02 still answers normally.
    transport.setReplyOverride(([f, op, a]) => (f === 0x02 && op === 0x03 && a === 0x01 ? null : undefined));

    const router = makeRouter();
    await router.push('/profiles');
    await router.isReady();
    const ps = mount(ProfileSelect, { global: { plugins: [router, pinia] }, attachTo: document.body });
    const pp = mount(ProfilesPage, { global: { plugins: [router, pinia] }, attachTo: document.body });
    mounted.push(ps, pp);
    await flushPromises();

    // Advance enough for 3 profile polls + liveness + 10 s extra.
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(Math.max(PROFILE_POLL_MS, REQUEST_TIMEOUT_MS + 100));
    }
    await flushPromises();
    const pollCountAtStop = out.frames.filter(isProfilePoll).length;
    const livenessCountAtStop = out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02).length;

    expect(pollCountAtStop).toBe(3);
    expect(livenessCountAtStop).toBe(1);
    expect(device.connected).toBe(true);
    expect(device.unknown.profiles).toBe(true);
    expect(device.activeProfileName).toBe(tr('mkb.common.unknown'));
    expect(ps.text()).toContain(tr('mkb.common.unknown'));
    expect(pp.find('[data-testid="profiles-unknown"]').text()).toContain(tr('mkb.common.unknown'));

    // Window focus and 10 s of fake time must NOT restart the profile poll on this connection.
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(out.frames.filter(isProfilePoll)).toHaveLength(3);
    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);

    // Next connection restarts the profile poll cleanly.
    await settle(device.connectGenericMock('g60', { latencyMs: 0 }));
    expect(device.connected).toBe(true);
    expect(device.unknown.profiles).toBe(false);
    out.frames.length = 0;
    await vi.advanceTimersByTimeAsync(PROFILE_POLL_MS + 100);
    expect(out.frames.filter(isProfilePoll).length).toBeGreaterThanOrEqual(1);
  });

  it('concurrency: only one liveness 01 02 runs in flight when additional misses arrive before it finishes', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectGenericMock('gmiss', { latencyMs: 0 }));
    const transport = device.transport as GenericMockTransport;
    const out = captureOut();

    // Silence 02 04 01 and delay 01 02 by 500 ms so a 4th miss completes while liveness is already in flight.
    transport.setReplyOverride(([f, op, a]) => (f === 0x02 && op === 0x04 && a === 0x01 ? null : undefined));
    const origEx = (transport as unknown as { exchange(f: Uint8Array, ms?: number): Promise<Bytes> }).exchange.bind(transport);
    (transport as unknown as { exchange(f: Uint8Array, ms?: number): Promise<Bytes> }).exchange = (f, ms) => {
      if (f[0] === 0x01 && f[1] === 0x02) {
        return new Promise((resolve) => setTimeout(() => { void origEx(f, ms).then(resolve); }, 500));
      }
      return origEx(f, ms);
    };

    // Trigger misses 1 and 2 sequentially.
    await expect(settle(device.withTransport((t) => t.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    await expect(settle(device.withTransport((t) => t.getSystemMode()))).rejects.toThrow(TransportTimeoutError);

    // Queue miss 3 and miss 4 together on the transport queue before miss 3 times out.
    const p3 = device.withTransport((t) => t.getSystemMode());
    const p4 = device.withTransport((t) => t.getSystemMode());
    const r3 = p3.then(() => 'ok', (e) => e);
    const r4 = p4.then(() => 'ok', (e) => e);
    await settle(Promise.all([r3, r4]));

    expect(await r3).toBeInstanceOf(TransportTimeoutError);
    expect(await r4).toBeInstanceOf(TransportTimeoutError);
    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(1);
    expect(device.connected).toBe(true);
  });

  it('AE64 connection sends no liveness 01 02 and does not close after 3 consecutive timeouts', async () => {
    vi.useFakeTimers({ toFake: [...FAKE_TIMERS] });
    const device = useDeviceStore();
    await settle(device.connectDemo('max'));
    const transport = device.transport!;
    const out = captureOut();

    const origEx = (transport as unknown as { exchange(f: Uint8Array, ms?: number): Promise<Bytes> }).exchange.bind(transport);
    (transport as unknown as { exchange(f: Uint8Array, ms?: number): Promise<Bytes> }).exchange = (f, ms) => {
      if (f[0] === 0x02 && f[1] === 0x04 && f[2] === 0x01) {
        return new Promise((_, reject) => setTimeout(() => reject(new TransportTimeoutError([0x02, 0x04])), ms));
      }
      return origEx(f, ms);
    };

    for (let i = 0; i < 3; i++) {
      await expect(settle(device.withTransport((t) => t.getSystemMode()))).rejects.toThrow(TransportTimeoutError);
    }

    expect(out.frames.filter((f) => f[0] === 0x01 && f[1] === 0x02)).toHaveLength(0);
    expect(device.connected).toBe(true);
    expect(transport.connected).toBe(true);
  });
});
