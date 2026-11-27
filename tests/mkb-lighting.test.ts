// MKB-V step 2a-2: Lighting page & store on generic keyboards (DESIGN MKB §10.1–§10.3).
// Kills K3 (Space 5-cell rule), M11 (no AE64 ring), M12 (no AE64 effect names on gspoof),
// plus g60/g75/godd/gmiss, strip > 135 LEDs (ledCount 0), and unsupported matrix (> 6x21).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { GenericMockTransport, LED_MATRIX_COLS, PHYSICAL_KEYS } from '../src/protocol';
import type { GenericMockName } from '../src/protocol';
import { checkFrame } from '../src/protocol/safety';
import { effectName } from '../src/data/ledEffects';
import { setLocale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';
import { useDeviceStore } from '../src/stores/device';
import { keyMatrixIndices, useLightingStore } from '../src/stores/lighting';
import { useSyncStore } from '../src/stores/sync';
import LightingPage from '../src/pages/LightingPage.vue';
import { isProfilePoll } from './helpers/profilePoll';

vi.setConfig({ testTimeout: 30000 });

let page: VueWrapper | null = null;

function spyExchange(transport: GenericMockTransport) {
  const frames: Uint8Array[] = [];
  const target = transport as unknown as { exchange: (f: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
  const orig = target.exchange.bind(transport);
  vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array, timeoutMs?: number) => {
    frames.push(new Uint8Array(f));
    return orig(f, timeoutMs);
  });
  return frames;
}

async function mountGenericLighting(name: GenericMockName) {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectGenericMock(name, { latencyMs: 0 });
  const transport = device.transport as GenericMockTransport;
  const frames = spyExchange(transport);
  const lighting = useLightingStore();
  page = mount(LightingPage, { attachTo: document.body });
  await vi.waitFor(() => {
    expect(lighting.loading).toBe(false);
    expect(lighting.loadedProfile).toBe(device.activeProfile);
  }, { timeout: 10000, interval: 5 });
  await flushPromises();
  return { device, transport, lighting, frames, sync: useSyncStore() };
}

beforeEach(() => {
  setLocale('vi');
  localStorage.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (e: unknown[]) => void) {}
    observe() { this.cb([{ contentRect: { width: 900 } }]); }
    unobserve() {}
    disconnect() {}
  });
});

afterEach(async () => {
  page?.unmount();
  page = null;
  if (getActivePinia()) await useDeviceStore().disconnect({ flush: false }).catch(() => undefined);
  await flushPromises();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Lighting on generic boards (DESIGN MKB §10)', () => {
  it('K3: Space maps to a single cell on generic (not AE64 5-cell span), while AE64 keeps 5 cells', async () => {
    const aeSpace = PHYSICAL_KEYS.find((k) => k.name === 'Space')!;
    expect(keyMatrixIndices(aeSpace, false)).toHaveLength(5);
    expect(keyMatrixIndices(aeSpace, true)).toEqual([aeSpace.row * LED_MATRIX_COLS + aeSpace.col]);

    const { device, lighting } = await mountGenericLighting('g60');
    const space = device.keys.find((k) => k.row === 5 && k.col === 6)!;
    expect(space).toBeDefined();
    // Simulate Space carrying name "Space" so the K3 guard is actually exercised on keyCustomColors
    const namedSpace = { ...space, name: 'Space' };
    device.keys = device.keys.map((k) => (k.id === space.id ? namedSpace : k));
    await flushPromises();

    // Put a custom color ONLY on adjacent cell (5, 5), leaving Space's own cell (5, 6) non-custom
    const adjacentIdx = 5 * LED_MATRIX_COLS + 5;
    const ownIdx = 5 * LED_MATRIX_COLS + 6;
    lighting.area0Matrix = lighting.area0Matrix.map((rec, i) => (
      i === adjacentIdx ? { custom: true, r: 255, g: 0, b: 0 }
        : i === ownIdx ? { custom: false, r: 0, g: 0, b: 0 }
          : rec
    ));
    await flushPromises();

    // On generic, adjacent cell (5, 5) must NOT bleed into Space (5, 6)
    expect(lighting.keyCustomColors[space.id].custom).toBe(false);

    // Setting Space's own cell (5, 6) marks Space custom
    lighting.area0Matrix = lighting.area0Matrix.map((rec, i) => (
      i === ownIdx ? { custom: true, r: 0, g: 255, b: 0 } : rec
    ));
    await flushPromises();
    expect(lighting.keyCustomColors[space.id].custom).toBe(true);
    expect(lighting.keyCustomColors[space.id].colorHex).toBe('#00ff00');
  });

  it('g60 (1 area): reads only area 0, hides Strip tab and ring, sends 0 area-1 commands and 0 writes', async () => {
    const { frames, sync } = await mountGenericLighting('g60');

    expect(page!.findAll('[role="tab"]')).toHaveLength(1);
    expect(page!.find('[role="tab"][data-id="keys"]').exists()).toBe(true);
    expect(page!.find('[role="tab"][data-id="strip"]').exists()).toBe(false);
    expect(page!.find('.ring').exists()).toBe(false);
    expect(page!.find('[data-testid="generic-strip-line"]').exists()).toBe(false);
    expect(page!.find('.wb__live').exists()).toBe(false);
    expect(page!.find('[data-testid="fx-view"]').exists()).toBe(false);

    // No area-1 lighting frames sent
    const area1Frames = frames.filter((f) => f[0] === 0x05 && f[2] === 1);
    expect(area1Frames).toHaveLength(0);

    // Every sent frame is read-only
    for (const f of frames) checkFrame(Array.from(f), { readOnly: true, rows: 'generic' });
    await sync.flush();
    await flushPromises();
  });

  it('g75 (matrix + 20-LED strip): shows strip text line, NEVER draws AE64 ring (kills M11), no live polling, "Hiệu ứng N" / "không rõ"', async () => {
    const { lighting, frames } = await mountGenericLighting('g75');

    // Two tabs (keys & strip), no ring, no live preview controls
    expect(page!.findAll('[role="tab"]')).toHaveLength(2);
    expect(page!.find('.ring').exists()).toBe(false);
    expect(page!.find('.wb__live').exists()).toBe(false);
    expect(page!.find('[data-testid="fx-view"]').exists()).toBe(false);

    // Strip one-line summary with exact LED count from 02 08 00
    const stripLine = page!.find('[data-testid="generic-strip-line"]');
    expect(stripLine.exists()).toBe(true);
    expect(stripLine.text()).toBe(t('mkb.light.strip', { n: 20 }));

    // Effect readout uses "Hiệu ứng {n}", and mode >= modeCount shows "không rõ"
    expect(page!.find('[data-testid="effect-readout"]').text()).toBe(t('mkb.light.effect', { n: lighting.area0Base.mode + 1 }));
    lighting.area0Base = { ...lighting.area0Base, mode: lighting.area0ModeCount };
    await flushPromises();
    expect(page!.find('[data-testid="effect-readout"]').text()).toBe(t('mkb.common.unknown'));

    // Switch to strip tab: still no ring, strip base controls read-only, no per-LED color column
    await page!.find('[role="tab"][data-id="strip"]').trigger('click');
    await flushPromises();
    expect(page!.find('.ring').exists()).toBe(false);
    expect(page!.find('.col--own').exists()).toBe(false);
    expect(page!.findAll('.effect-btn')).toHaveLength(6);

    // No live polling occurs after load
    const beforePoll = frames.filter((f) => !isProfilePoll(f)).length;
    await new Promise((r) => setTimeout(r, 120));
    const afterPoll = frames.filter((f) => !isProfilePoll(f)).length;
    expect(afterPoll).toBe(beforePoll);

    for (const f of frames) checkFrame(Array.from(f), { readOnly: true, rows: 'generic' });
  });

  it('godd (15 areas + truncated): lists areas 2–14 as text and truncated unknown note, never reads area >= 2', async () => {
    const { frames } = await mountGenericLighting('godd');

    expect(page!.find('[data-testid="generic-strip-line"]').text()).toBe(t('mkb.light.strip', { n: 12 }));
    const extraBox = page!.find('[data-testid="generic-extra-areas"]');
    expect(extraBox.exists()).toBe(true);
    for (let id = 2; id <= 14; id++) {
      expect(page!.find(`[data-testid="generic-extra-area-${id}"]`).text()).toBe(t('mkb.light.extraArea', { n: id, m: 3 }));
    }
    expect(page!.find('[data-testid="generic-areas-truncated"]').text()).toContain(t('mkb.common.unknown'));

    // Never sends 05 xx for area >= 2
    const extraReads = frames.filter((f) => f[0] === 0x05 && f[2] >= 2);
    expect(extraReads).toHaveLength(0);
  });

  it('gmiss (area 1 base no answer): loads cleanly without error and hides area 1', async () => {
    const { lighting } = await mountGenericLighting('gmiss');

    expect(lighting.loadError).toBeNull();
    expect(lighting.area0Available).toBe(true);
    expect(lighting.area1Available).toBe(false);
    expect(page!.find('[role="tab"][data-id="keys"]').exists()).toBe(true);
    expect(page!.find('[role="tab"][data-id="strip"]').exists()).toBe(false);
    expect(page!.find('[data-testid="generic-strip-line"]').exists()).toBe(false);
  });

  it('gspoof (board 0030000D): NEVER shows AE64 effect names anywhere on LightingPage (kills M12)', async () => {
    const { lighting } = await mountGenericLighting('gspoof');

    const collectAllText = () => {
      const root = page!.element as HTMLElement;
      const attrs = Array.from(root.querySelectorAll<HTMLElement>('[title], [aria-label]'))
        .flatMap((el) => [el.getAttribute('title') ?? '', el.getAttribute('aria-label') ?? '']);
      return `${root.textContent ?? ''}\n${attrs.join('\n')}`;
    };

    for (const loc of ['vi', 'en'] as const) {
      setLocale(loc);
      await flushPromises();
      const dump = collectAllText();
      for (let n = 1; n <= 19; n++) {
        const aeName = effectName('0030000D', 0, n, loc);
        if (aeName) expect(dump).not.toContain(aeName);
      }
      expect(page!.find('[data-testid="effect-readout"]').text()).toBe(t('mkb.light.effect', { n: lighting.area0Base.mode + 1 }));
    }
  });

  it('strip > 135 LEDs (ledCount 0): loads cleanly, sends 0 05 03 1 frames, shows strip line with n from 02 08 00', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectGenericMock('g75', { latencyMs: 0 });
    const transport = device.transport as GenericMockTransport;
    const frames: Uint8Array[] = [];
    const target = transport as unknown as { exchange: (f: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
    const orig = target.exchange.bind(transport);

    // Override 02 08 00 to declare area 1 as a 136-LED strip (> 135 max pages 0..8)
    vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array, timeoutMs?: number) => {
      frames.push(new Uint8Array(f));
      if (f[0] === 0x02 && f[1] === 0x08 && f[2] === 0x00) {
        const out = new Uint8Array(64);
        out.set([0x02, 0x08, 0x00, 1, 1, 5, 1, 136]); // strip-only, id=1, 5 modes, 1x136
        return Promise.resolve(out);
      }
      return orig(f, timeoutMs);
    });

    const lighting = useLightingStore();
    page = mount(LightingPage, { attachTo: document.body });
    await vi.waitFor(() => {
      expect(lighting.loading).toBe(false);
      expect(lighting.loadedProfile).toBe(device.activeProfile);
    }, { timeout: 10000, interval: 5 });
    await flushPromises();

    expect(lighting.loadError).toBeNull();
    expect(transport.ledCount(1)).toBe(0);
    expect(lighting.stripCustomColors).toEqual([]);
    expect(frames.filter((f) => f[0] === 0x05 && f[1] === 0x03 && f[2] === 1)).toHaveLength(0);
    expect(page!.find('[data-testid="generic-strip-line"]').text()).toBe(t('mkb.light.strip', { n: 136 }));
    // Auto-selected strip tab since area 0 is absent
    expect(page!.find('[role="tab"][data-id="strip"]').attributes('aria-selected')).toBe('true');
    expect(page!.find('.wb__board').exists()).toBe(false);
  });

  it('oversized matrix (rows > 6 or cols > 21): shows "không hỗ trợ" and sends 0 05 xx frames for that area', async () => {
    setActivePinia(createPinia());
    const device = useDeviceStore();
    await device.connectGenericMock('g60', { latencyMs: 0 });
    const transport = device.transport as GenericMockTransport;
    const frames: Uint8Array[] = [];
    const target = transport as unknown as { exchange: (f: Uint8Array, timeoutMs?: number) => Promise<Uint8Array> };
    const orig = target.exchange.bind(transport);

    vi.spyOn(target, 'exchange').mockImplementation((f: Uint8Array, timeoutMs?: number) => {
      frames.push(new Uint8Array(f));
      if (f[0] === 0x02 && f[1] === 0x08 && f[2] === 0x00) {
        const out = new Uint8Array(64);
        out.set([0x02, 0x08, 0x00, 1, 0, 10, 7, 15]); // rows=7 > 6
        return Promise.resolve(out);
      }
      return orig(f, timeoutMs);
    });

    const lighting = useLightingStore();
    page = mount(LightingPage, { attachTo: document.body });
    await vi.waitFor(() => {
      expect(lighting.loading).toBe(false);
      expect(lighting.loadedProfile).toBe(device.activeProfile);
    }, { timeout: 10000, interval: 5 });
    await flushPromises();

    expect(lighting.loadError).toBeNull();
    expect(lighting.area0Unsupported).toBe(true);
    expect(page!.find('[data-testid="generic-area-unsupported"]').text()).toBe(t('mkb.common.unsupported'));
    expect(page!.find('.wb__board').exists()).toBe(false);
    expect(frames.filter((f) => f[0] === 0x05 && f[2] === 0)).toHaveLength(0);
  });
});
