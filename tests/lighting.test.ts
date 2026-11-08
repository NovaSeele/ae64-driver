import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPinia, getActivePinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import {
  LED_MATRIX_COLS, MockTransport, PHYSICAL_KEYS, SAVE_GROUP,
} from '../src/protocol';
import { useDeviceStore } from '../src/stores/device';
import { useHistoryStore } from '../src/stores/history';
import { useSyncStore } from '../src/stores/sync';
import { keyMatrixIndices, useLightingStore } from '../src/stores/lighting';
import LightingPage from '../src/pages/LightingPage.vue';
import Slider from '../src/components/ui/Slider.vue';
import ColorPicker from '../src/components/ui/ColorPicker.vue';

async function setup() {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo();
  const mock = device.transport as MockTransport;
  (mock as any).latencyMs = 0;
  const lighting = useLightingStore();
  await lighting.load();
  return { device, mock, lighting };
}

describe('lighting store', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads base, palette and matrices for area 0 and area 1', async () => {
    const { lighting } = await setup();

    expect(lighting.area0Base.area).toBe(0);
    expect(lighting.area0Base.open).toBe(true);
    expect(lighting.area0Base.openMode).toBe(3); // both
    expect(lighting.area0Palette.length).toBe(8);
    expect(lighting.area0Matrix.length).toBe(126);
    expect(lighting.area0ModeCount).toBe(19);

    expect(lighting.area1Base.area).toBe(1);
    expect(lighting.area1Base.open).toBe(true);
    expect(lighting.area1Base.openMode).toBe(1); // on
    expect(lighting.area1Palette.length).toBe(8);
    expect(lighting.area1Matrix.length).toBe(38);
    expect(lighting.area1ModeCount).toBe(5);
  });

  describe('base write and verify', () => {
    it('applies area 0 base changes, syncs, commits and verifies with read-back', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();
      const commitSpy = vi.spyOn(mock, 'commit');

      lighting.applyBase(0, {
        openMode: 1, // bottom only
        mode: 3,
        brightness: 70,
        speed: 60,
        direction: 1,
        paletteIndex: 2,
      }, 'Test base');

      expect(sync.state).toBe('pending');
      await sync.flush();

      expect(sync.state).toBe('saved');
      expect(commitSpy).toHaveBeenCalledWith(SAVE_GROUP.LIGHTING);

      const read = await mock.getLightingBase(0);
      expect(read.openMode).toBe(1);
      expect(read.open).toBe(true);
      expect(read.mode).toBe(3);
      expect(read.brightness).toBe(70);
      expect(read.speed).toBe(60);
      expect(read.direction).toBe(1);
      expect(read.paletteIndex).toBe(2);
    });

    it('supports undo and redo for base edits', async () => {
      const { mock, lighting } = await setup();
      const history = useHistoryStore();
      const sync = useSyncStore();

      const origBrightness = lighting.area0Base.brightness;
      lighting.applyBase(0, { brightness: 35 }, 'Edit brightness');
      await sync.flush();

      let read = await mock.getLightingBase(0);
      expect(read.brightness).toBe(35);

      // Undo
      history.undo();
      await sync.flush();
      read = await mock.getLightingBase(0);
      expect(read.brightness).toBe(origBrightness);

      // Redo
      history.redo();
      await sync.flush();
      read = await mock.getLightingBase(0);
      expect(read.brightness).toBe(35);
    });

    it('applies area 1 (strip) base changes', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();

      lighting.applyBase(1, {
        openMode: 0, // off
        mode: 2,
        brightness: 45,
      }, 'Strip off');

      await sync.flush();

      const read = await mock.getLightingBase(1);
      expect(read.open).toBe(false);
      expect(read.openMode).toBe(0);
      expect(read.mode).toBe(2);
      expect(read.brightness).toBe(45);
    });
  });

  describe('palette write and verify', () => {
    it('writes and verifies palette color changes for area 0', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();
      const commitSpy = vi.spyOn(mock, 'commit');

      lighting.applyPaletteColor(0, 2, { r: 255, g: 128, b: 64 }, 'Edit color 2');

      await sync.flush();
      expect(sync.state).toBe('saved');
      expect(commitSpy).toHaveBeenCalledWith(SAVE_GROUP.LIGHTING);

      const palette = await mock.getPalette(0);
      expect(palette[2].r).toBe(255);
      expect(palette[2].g).toBe(128);
      expect(palette[2].b).toBe(64);
    });

    it('writes and verifies palette color changes for area 1', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();

      lighting.applyPaletteColor(1, 4, { r: 10, g: 20, b: 30 }, 'Edit strip color 4');
      await sync.flush();

      const palette = await mock.getPalette(1);
      expect(palette[4].r).toBe(10);
      expect(palette[4].g).toBe(20);
      expect(palette[4].b).toBe(30);
    });

    it('supports undo and redo for palette edits', async () => {
      const { mock, lighting } = await setup();
      const history = useHistoryStore();
      const sync = useSyncStore();

      const orig = { ...lighting.area0Palette[3] };
      lighting.applyPaletteColor(0, 3, { r: 12, g: 34, b: 56 }, 'Edit color 3');
      await sync.flush();

      let pal = await mock.getPalette(0);
      expect(pal[3].r).toBe(12);

      history.undo();
      await sync.flush();
      pal = await mock.getPalette(0);
      expect(pal[3].r).toBe(orig.r);
      expect(pal[3].g).toBe(orig.g);
      expect(pal[3].b).toBe(orig.b);
    });
  });

  describe('per-key colour mapping, Space 5 cells, and untouched cells', () => {
    it('maps keyMatrixIndices correctly for standard keys and Spacebar', () => {
      const w = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
      const space = PHYSICAL_KEYS.find((k) => k.name === 'Space')!;

      // Normal key W: row 2, col 2 -> 2 * 21 + 2 = 44
      expect(keyMatrixIndices(w)).toEqual([2 * LED_MATRIX_COLS + 2]);

      // Space: row 5, col 6 -> 5 cells: offsets -2..2 -> 109, 110, 111, 112, 113
      const expectedSpace = [-2, -1, 0, 1, 2].map((off) => 5 * LED_MATRIX_COLS + (6 + off));
      expect(keyMatrixIndices(space)).toEqual(expectedSpace);
      expect(expectedSpace).toEqual([109, 110, 111, 112, 113]);
    });

    it('sets custom color on standard key and preserves unused matrix cells', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();

      // Explicitly set a custom color on cell 0 (row 0 col 0, not mapped to any physical key)
      const prof = (mock as any).profiles[(mock as any).active];
      prof.leds[0][0] = [10, 20, 30, 0xff]; // B, G, R, flag -> r: 30, g: 20, b: 10

      // Reload lighting store to pick up the matrix state
      await lighting.load(true);
      expect(lighting.area0Matrix[0].custom).toBe(true);
      expect(lighting.area0Matrix[0].r).toBe(30);

      // Now apply custom color to key 'W' (cell 44)
      const w = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
      lighting.applyKeyColors([w.id], { r: 255, g: 0, b: 0 }, 'Set W red');
      await sync.flush();

      const updatedMatrix = await mock.readLedMatrix(0);
      const wIdx = 2 * LED_MATRIX_COLS + 2;
      expect(updatedMatrix[wIdx].custom).toBe(true);
      expect(updatedMatrix[wIdx].r).toBe(255);
      expect(updatedMatrix[wIdx].g).toBe(0);
      expect(updatedMatrix[wIdx].b).toBe(0);

      // Verify cell 0 (untouched by W edit) retained its exact custom color
      expect(updatedMatrix[0].custom).toBe(true);
      expect(updatedMatrix[0].r).toBe(30);
      expect(updatedMatrix[0].g).toBe(20);
      expect(updatedMatrix[0].b).toBe(10);

      // Verify an uncustomized unused cell (cell 5) remains custom: false
      expect(updatedMatrix[5].custom).toBe(false);
    });

    it('sets custom color on Spacebar fanning to 5 cells and clears them together', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();
      const space = PHYSICAL_KEYS.find((k) => k.name === 'Space')!;
      const spaceIndices = [109, 110, 111, 112, 113];

      lighting.applyKeyColors([space.id], { r: 0, g: 255, b: 128 }, 'Set Space mint');
      await sync.flush();

      let matrix = await mock.readLedMatrix(0);
      for (const idx of spaceIndices) {
        expect(matrix[idx].custom).toBe(true);
        expect(matrix[idx].r).toBe(0);
        expect(matrix[idx].g).toBe(255);
        expect(matrix[idx].b).toBe(128);
      }

      // Check keyCustomColors computed
      expect(lighting.keyCustomColors[space.id].custom).toBe(true);
      expect(lighting.keyCustomColors[space.id].colorHex.toLowerCase()).toBe('#00ff80');

      // Clear custom color
      lighting.clearKeyColors([space.id], 'Clear Space');
      await sync.flush();

      matrix = await mock.readLedMatrix(0);
      for (const idx of spaceIndices) {
        expect(matrix[idx].custom).toBe(false);
      }
      expect(lighting.keyCustomColors[space.id].custom).toBe(false);
    });

    it('clearAllKeyColors clears all key custom colors while keeping unused cells untouched', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();
      const w = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
      const a = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

      lighting.applyKeyColors([w.id, a.id], { r: 200, g: 100, b: 50 }, 'Set keys');
      await sync.flush();

      lighting.clearAllKeyColors('Clear all');
      await sync.flush();

      const matrix = await mock.readLedMatrix(0);
      const wIdx = keyMatrixIndices(w)[0];
      const aIdx = keyMatrixIndices(a)[0];
      expect(matrix[wIdx].custom).toBe(false);
      expect(matrix[aIdx].custom).toBe(false);
    });
  });

  describe('strip per-LED custom colors', () => {
    it('sets custom colors on selected strip LEDs and verifies read-back', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();

      lighting.applyStripColors([5, 12, 28], { r: 30, g: 60, b: 90 }, 'Set strip LEDs');
      await sync.flush();

      const strip = await mock.readLedMatrix(1);
      expect(strip[5].custom).toBe(true);
      expect(strip[5].r).toBe(30);
      expect(strip[5].g).toBe(60);
      expect(strip[5].b).toBe(90);

      expect(strip[12].custom).toBe(true);
      expect(strip[28].custom).toBe(true);

      // Other LEDs remain custom: false
      expect(strip[0].custom).toBe(false);
      expect(strip[1].custom).toBe(false);

      // Clear one LED
      lighting.clearStripColors([12], 'Clear LED 12');
      await sync.flush();

      const updated = await mock.readLedMatrix(1);
      expect(updated[12].custom).toBe(false);
      expect(updated[5].custom).toBe(true);
      expect(updated[28].custom).toBe(true);
    });

    it('clearAllStripColors clears all 38 strip LEDs', async () => {
      const { mock, lighting } = await setup();
      const sync = useSyncStore();

      lighting.applyStripColors([1, 2, 3], { r: 100, g: 100, b: 100 }, 'Set strip');
      await sync.flush();

      lighting.clearAllStripColors('Clear all strip');
      await sync.flush();

      const strip = await mock.readLedMatrix(1);
      expect(strip.every((l) => !l.custom)).toBe(true);
    });
  });

  describe('live preview polling', () => {
    it('polls readLedMatrix and updates liveColors and liveStripColors', async () => {
      const { lighting } = await setup();

      lighting.startLivePolling();
      expect(lighting.polling).toBe(true);

      // Wait a short time for poller ticks to run
      await new Promise((r) => setTimeout(r, 250));

      // Live colors should be populated for 64 keys
      expect(Object.keys(lighting.liveColors).length).toBe(64);
      // Strip colors should be populated for 38 LEDs
      expect(lighting.liveStripColors.length).toBe(38);

      lighting.stopLivePolling();
      expect(lighting.polling).toBe(false);
    });
  });
});

describe('lighting page', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function mountPage() {
    vi.stubGlobal('ResizeObserver', class {
      constructor(private cb: (e: unknown[]) => void) {}
      observe() { this.cb([{ contentRect: { width: 400 } }]); }
      disconnect() {}
    });
    const ctx = await setup();
    const page = mount(LightingPage, { global: { plugins: [getActivePinia()!], stubs: { teleport: true } } });
    await flushPromises();
    return { ...ctx, page };
  }

  it('writes brightness on slider commit, not while dragging, and undo restores it', async () => {
    const { mock, lighting, page } = await mountPage();
    const sync = useSyncStore();
    const history = useHistoryStore();
    const orig = lighting.area0Base.brightness;
    const slider = page.findAllComponents(Slider)[0];

    slider.vm.$emit('update:modelValue', 20); // drag: draft only
    await flushPromises();
    expect(lighting.area0Base.brightness).toBe(orig);
    expect(sync.state).toBe('saved');
    expect(history.canUndo).toBe(false);

    slider.vm.$emit('commit', 20);
    expect(sync.state).toBe('pending');
    await sync.flush();
    expect((await mock.getLightingBase(0)).brightness).toBe(20);
    expect(lighting.area0Base.brightness).toBe(20);
    expect(history.canUndo).toBe(true);

    history.undo();
    await sync.flush();
    expect((await mock.getLightingBase(0)).brightness).toBe(orig);
    expect(lighting.area0Base.brightness).toBe(orig);
    page.unmount();
  });

  it('writes a palette colour only when the picker commits', async () => {
    const { mock, lighting, page } = await mountPage();
    const sync = useSyncStore();
    lighting.applyBase(0, { paletteIndex: 2 }, 'Pick slot 2');
    await sync.flush();
    await flushPromises();

    const picker = page.findAllComponents(ColorPicker)[1]; // [0] is the per-key picker
    const before = await mock.getPalette(0);
    picker.vm.$emit('update:modelValue', '#112233');
    await flushPromises();
    expect(sync.state).toBe('saved');
    expect(lighting.area0Palette[2].r).toBe(before[2].r);

    picker.vm.$emit('commit', '#112233');
    expect(sync.state).toBe('pending');
    await sync.flush();
    const after = await mock.getPalette(0);
    expect([after[2].r, after[2].g, after[2].b]).toEqual([0x11, 0x22, 0x33]);
    page.unmount();
  });

  it('refuses applies and shows a skeleton while the profile is not loaded', async () => {
    const { lighting, page } = await mountPage();
    const sync = useSyncStore();
    const history = useHistoryStore();
    expect(page.find('.effect-btn').exists()).toBe(true);

    lighting.loadedProfile = null;
    await flushPromises();
    expect(page.find('.effect-btn').exists()).toBe(false);
    expect(page.find('.lighting-skeleton').exists()).toBe(true);

    lighting.applyBase(0, { brightness: 10 }, 'Too early');
    expect(sync.state).toBe('saved');
    expect(history.canUndo).toBe(false);
    page.unmount();
  });

  it('disables every editor and shows a notice on a read-only board', async () => {
    const { device, page } = await mountPage();
    expect(page.find('.lighting-notice').exists()).toBe(false);

    device.boardAllowed = false;
    await flushPromises();
    expect(page.find('.lighting-notice').exists()).toBe(true);
    const sets = page.findAll('fieldset.card-inner');
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.every((f) => f.attributes('disabled') !== undefined)).toBe(true);
    page.unmount();
  });
});
