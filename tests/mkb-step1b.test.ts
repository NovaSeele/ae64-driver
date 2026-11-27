// MKB-V step 1b tests: I1 (fail-closed default identity), L1/L2 (generic ledCount rules), RV1 (reconnectGrantedHid order).
// Covers DESIGN MKB v5.1 §3.1, §4, §10.2, §16.2.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BaseTransport, HidTransport, MockTransport,
  CONFIG_USAGE, CONFIG_USAGE_PAGE, PRODUCT_ID_MAX, PRODUCT_ID_PRO, VENDOR_ID, VENDOR_ID_AULA, VENDOR_ID_WUQUE,
  createGenericMock, ledCount, reconnectGrantedHid, rememberDevice,
} from '../src/protocol';
import type { Bytes } from '../src/protocol';
import { MockFwBus } from '../src/protocol/mockFirmware';
import { installFakeHid, removeFakeHid } from './fw-hid';

afterEach(() => {
  removeFakeHid();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
  localStorage.clear();
});

function collectTsRelPaths(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...collectTsRelPaths(root, rel));
    else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(rel);
  }
  return out;
}

// ------------------------------------------------------------------ I1: Identity (v5.1, §3.1 & §16.2)

describe('I1: BaseTransport default identity fail-closed & concrete overrides (MI-a, MI-b, MI-c)', () => {
  it('a. source scan finds every class in src/**/*.ts extending BaseTransport and each defines its own identity (MI-a)', async () => {
    const srcRoot = resolve('src');
    const files = collectTsRelPaths(srcRoot);
    const matches: { rel: string; className: string }[] = [];
    const re = /\bclass\s+(\w+)\s+extends\s+BaseTransport\b/g;

    for (const rel of files) {
      const content = readFileSync(join(srcRoot, rel), 'utf8');
      for (const m of content.matchAll(re)) {
        matches.push({ rel, className: m[1] });
      }
    }

    expect(matches.length).toBeGreaterThan(0);

    for (const { rel, className } of matches) {
      const mod = (await import(/* @vite-ignore */ `../src/${rel}`)) as Record<string, unknown>;
      const Cls = mod[className] as { prototype?: object } | undefined;
      expect(Cls, `src/${rel}:${className} must be exported`).toBeTypeOf('function');
      const desc = Object.getOwnPropertyDescriptor(Cls!.prototype, 'identity');
      expect(desc, `src/${rel}:${className} must define its own identity`).toBeDefined();
    }
  });

  it('b. HidTransport on 38A6 whose 01 02 reports 0030000D keeps 38A6 identity, undefined support, boardAllowed false (MI-b)', async () => {
    const listeners: ((e: { data: DataView }) => void)[] = [];
    const dev = {
      opened: true,
      vendorId: VENDOR_ID_AULA,
      productId: PRODUCT_ID_MAX,
      productName: 'Spoofed 38A6',
      collections: [{ usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE }],
      addEventListener: (_: string, cb: (e: { data: DataView }) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined,
      sendReport: async () => {
        const reply = new Uint8Array(64);
        // 01 02 reply reporting AE64 Max board 0030000D, run mode 0
        reply.set([
          0x01, 0x02, 0x01, 0x00, 0x00, 0x30, 0x00, 0x0d,
          0x00, 0x00, 0x04, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00,
          0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
        ]);
        setTimeout(() => { for (const cb of [...listeners]) cb({ data: new DataView(reply.buffer) }); }, 0);
      },
      close: async () => undefined,
    };
    vi.stubGlobal('navigator', {
      hid: { addEventListener: () => undefined, removeEventListener: () => undefined },
    });

    const t = new HidTransport(dev as unknown as HIDDevice);
    await t.open();
    const info = await t.getDeviceInfo();
    expect(info.boardIdHex).toBe('0030000d');
    expect(info.runMode).toBe(0);
    expect(t.identity.vendorId).toBe(VENDOR_ID_AULA);
    expect(t.identity.productId).toBe(PRODUCT_ID_MAX);
    expect(t.support).toBeUndefined();
    expect(t.boardAllowed).toBe(false);
    await t.close();
  });

  it('c. bare BaseTransport subclass throws on identity and sends no frame outside MODE=test, returns AE64 default under test (MI-c)', async () => {
    for (const mode of ['production', 'desktop', 'development'] as const) {
      vi.stubEnv('MODE', mode);
      vi.resetModules();
      const { BaseTransport: DynamicBase } = await import('../src/protocol/client');

      const exchanged: Uint8Array[] = [];
      const loggedOut: Uint8Array[] = [];

      class BareTransport extends DynamicBase {
        readonly kind = 'mock' as const;
        readonly productName = 'Bare';
        readonly productId = PRODUCT_ID_MAX;
        readonly connected = true;
        protected async exchange(frame: Uint8Array): Promise<Bytes> {
          exchanged.push(frame);
          return new Uint8Array(64);
        }
        async close(): Promise<void> { /* noop */ }
      }

      const bare = new BareTransport();
      bare.onPacketRaw((dir, bytes) => { if (dir === 'out') loggedOut.push(bytes); });

      expect(() => bare.identity, `MODE=${mode}: identity getter`).toThrow();
      await expect(bare.getDeviceInfo(), `MODE=${mode}: getDeviceInfo`).rejects.toThrow();
      expect(exchanged, `MODE=${mode}: no exchange`).toEqual([]);
      expect(loggedOut, `MODE=${mode}: no out log`).toEqual([]);
    }

    vi.unstubAllEnvs();
    vi.resetModules();
    const { BaseTransport: TestBase } = await import('../src/protocol/client');

    class BareTestTransport extends TestBase {
      readonly kind = 'mock' as const;
      readonly productName = 'Bare Test';
      readonly connected = true;
      constructor(readonly productId?: number) { super(); }
      protected async exchange(): Promise<Bytes> { return new Uint8Array(64); }
      async close(): Promise<void> { /* noop */ }
    }

    expect(new BareTestTransport(PRODUCT_ID_MAX).identity).toEqual({
      vendorId: VENDOR_ID,
      productId: PRODUCT_ID_MAX,
      productName: 'Bare Test',
      collections: [{ usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE, inputReports: [], outputReports: [] }],
    });
    expect(new BareTestTransport(PRODUCT_ID_PRO).identity.productId).toBe(PRODUCT_ID_PRO);
    expect(new BareTestTransport(undefined).identity.productId).toBe(PRODUCT_ID_MAX);
  });
});

// ------------------------------------------------------------------ L1 & L2: LED count (v5.1, §10.2 & §16.2)

/** Minimal generic transport answering 02 08 00 with custom area entries and 05 03 with dummy colors. */
class CustomAreasGenericTransport extends BaseTransport {
  readonly kind = 'mock' as const;
  readonly productName = 'Custom Areas';
  readonly productId = 0xf099;
  readonly connected = true;
  readonly sentLedPages: { area: number; page: number }[] = [];

  constructor(private readonly areaEntries: readonly { id: number; modes: number; rows: number; cols: number }[]) {
    super();
  }

  override get identity() {
    return {
      vendorId: VENDOR_ID_AULA,
      productId: this.productId,
      productName: this.productName,
      collections: [{ usagePage: CONFIG_USAGE_PAGE, usage: CONFIG_USAGE, inputReports: [64], outputReports: [64] }],
    };
  }

  protected async exchange(frame: Uint8Array): Promise<Bytes> {
    const reply = new Uint8Array(64);
    reply[0] = frame[0];
    reply[1] = frame[1];
    if (frame[0] === 0x02 && frame[1] === 0x08 && frame[2] === 0x00) {
      reply[2] = 0x00;
      reply[3] = this.areaEntries.length;
      this.areaEntries.forEach((a, i) => {
        const off = 4 + i * 4;
        reply[off] = a.id;
        reply[off + 1] = a.modes;
        reply[off + 2] = a.rows;
        reply[off + 3] = a.cols;
      });
      return reply;
    }
    if (frame[0] === 0x05 && frame[1] === 0x03) {
      reply[2] = frame[2];
      reply[3] = frame[3];
      this.sentLedPages.push({ area: frame[2], page: frame[3] });
      return reply;
    }
    return reply;
  }

  async close(): Promise<void> { /* noop */ }
}

describe('L1 & L2: generic ledCount by area id only and strip <= 135 bound (ML1, ML2)', () => {
  it('1. 02 08 00 lists only id 1 (a strip): ledCount(0) is 0 and readLedMatrix(0) sends no 05 03 (ML1)', async () => {
    const t = new CustomAreasGenericTransport([{ id: 1, modes: 5, rows: 1, cols: 20 }]);
    t.setSupport('generic');
    const areas = await t.getLightingAreas();

    expect(areas.shapes).toEqual([{ id: 1, rows: 1, cols: 20 }]);
    expect(t.ledCount(0)).toBe(0);
    expect(t.ledCount(1)).toBe(20);
    expect(ledCount(0, { support: 'generic', areas })).toBe(0);
    expect(ledCount(1, { support: 'generic', areas })).toBe(20);

    const matrix0 = await t.readLedMatrix(0);
    expect(matrix0).toEqual([]);
    expect(t.sentLedPages).toEqual([]);
  });

  it('2. generic strip of 136 gives count 0 and sends no 05 03 while preserving 02 08 00 shape; 135 reads pages 0–8 (ML2)', async () => {
    const t136 = new CustomAreasGenericTransport([
      { id: 0, modes: 10, rows: 5, cols: 15 },
      { id: 1, modes: 4, rows: 1, cols: 136 },
    ]);
    t136.setSupport('generic');
    const areas136 = await t136.getLightingAreas();

    // Shapes / count from 02 08 00 remain intact for the UI text line ("Dải đèn: 136 LED")
    expect(areas136.count).toBe(2);
    expect(areas136.shapes[1]).toEqual({ id: 1, rows: 1, cols: 136 });
    expect(areas136.areas[1]).toEqual({ modes: 4, leds: 136 });
    expect(t136.ledCount(1)).toBe(0);

    const leds136 = await t136.readLedMatrix(1);
    expect(leds136).toEqual([]);
    expect(t136.sentLedPages).toEqual([]);

    const t135 = new CustomAreasGenericTransport([
      { id: 0, modes: 10, rows: 5, cols: 15 },
      { id: 1, modes: 4, rows: 1, cols: 135 },
    ]);
    t135.setSupport('generic');
    await t135.getLightingAreas();
    expect(t135.ledCount(1)).toBe(135);

    const leds135 = await t135.readLedMatrix(1);
    expect(leds135).toHaveLength(135);
    expect(t135.sentLedPages).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8].map((page) => ({ area: 1, page })));
  });

  it('3. generic before 02 08 00 gives count 0 and sends no 05 03; AE64 keeps 126 / 38 unchanged', async () => {
    const g = createGenericMock('g75', { latencyMs: 0 });
    g.setSupport('generic');
    const sent0503: number[][] = [];
    g.onPacketRaw((dir, b) => { if (dir === 'out' && b[0] === 0x05 && b[1] === 0x03) sent0503.push(Array.from(b)); });

    expect(g.ledCount(0)).toBe(0);
    expect(g.ledCount(1)).toBe(0);
    expect(await g.readLedMatrix(0)).toEqual([]);
    expect(sent0503).toEqual([]);

    const ae64 = new MockTransport({ seed: 'max', latencyMs: 0 });
    await ae64.getDeviceInfo();
    expect(ae64.ledCount(0)).toBe(126);
    expect(ae64.ledCount(1)).toBe(38);
  });
});

// ------------------------------------------------------------------ RV1: reconnectGrantedHid order (v5.1, §4 & §16.2)

describe('RV1: reconnectGrantedHid three-branch order via FakeHid (RV1m, RV1m2)', () => {
  function setupFakeHid() {
    const bus = new MockFwBus([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], { model: 'pro' });
    return installFakeHid(bus);
  }

  it('case 1: [38A6, 1CA6:F0xx] with {1CA6, 300D} remembered opens the 1CA6 device probe-only (RV1m)', async () => {
    const hid = setupFakeHid();
    const d38a6 = hid.addStray({ vendorId: VENDOR_ID_AULA, productId: 0xf002, name: 'AULA' });
    const dBoot = hid.addStray({ vendorId: VENDOR_ID, productId: 0xf099, name: 'AE64 Boot' });

    rememberDevice(VENDOR_ID, PRODUCT_ID_MAX);
    const t = (await reconnectGrantedHid()) as HidTransport | null;

    expect(t).not.toBeNull();
    expect(t!.identity.vendorId).toBe(VENDOR_ID);
    expect(t!.identity.productId).toBe(0xf099);
    expect(t!.probeOnly).toBe(true);
    expect(dBoot.opens).toBe(1);
    expect(d38a6.opens).toBe(0);
    await t!.close();
  });

  it('case 2: [38A6 remembered, 1CA6:F0xx] opens the 1CA6 device probe-only (RV1m)', async () => {
    const hid = setupFakeHid();
    const d38a6 = hid.addStray({ vendorId: VENDOR_ID_AULA, productId: 0xf002, name: 'AULA' });
    const dBoot = hid.addStray({ vendorId: VENDOR_ID, productId: 0xf099, name: 'AE64 Boot' });

    rememberDevice(VENDOR_ID_AULA, 0xf002);
    const t = (await reconnectGrantedHid()) as HidTransport | null;

    expect(t).not.toBeNull();
    expect(t!.identity.vendorId).toBe(VENDOR_ID);
    expect(t!.identity.productId).toBe(0xf099);
    expect(t!.probeOnly).toBe(true);
    expect(dBoot.opens).toBe(1);
    expect(d38a6.opens).toBe(0);
    await t!.close();
  });

  it('case 3: [1CA6:F001, 1CA6:F002 remembered] opens 1CA6:F001 (today first match, ignores remembered) (RV1m2)', async () => {
    const hid = setupFakeHid();
    const d1 = hid.addStray({ vendorId: VENDOR_ID, productId: 0xf001, name: '1CA6 First' });
    const d2 = hid.addStray({ vendorId: VENDOR_ID, productId: 0xf002, name: '1CA6 Second' });

    rememberDevice(VENDOR_ID, 0xf002);
    const t = (await reconnectGrantedHid()) as HidTransport | null;

    expect(t).not.toBeNull();
    expect(t!.identity.vendorId).toBe(VENDOR_ID);
    expect(t!.identity.productId).toBe(0xf001);
    expect(t!.probeOnly).toBe(true);
    expect(d1.opens).toBe(1);
    expect(d2.opens).toBe(0);
    await t!.close();
  });

  it('case 4: [38A6:X, 36B5:Y remembered] opens 36B5:Y probe-only', async () => {
    const hid = setupFakeHid();
    const dX = hid.addStray({ vendorId: VENDOR_ID_AULA, productId: 0xf010, name: 'AULA X' });
    const dY = hid.addStray({ vendorId: VENDOR_ID_WUQUE, productId: 0xf020, name: 'Wuque Y' });

    rememberDevice(VENDOR_ID_WUQUE, 0xf020);
    const t = (await reconnectGrantedHid()) as HidTransport | null;

    expect(t).not.toBeNull();
    expect(t!.identity.vendorId).toBe(VENDOR_ID_WUQUE);
    expect(t!.identity.productId).toBe(0xf020);
    expect(t!.probeOnly).toBe(true);
    expect(dY.opens).toBe(1);
    expect(dX.opens).toBe(0);
    await t!.close();
  });

  it('case 5: [38A6:X, 36B5:Y] with none remembered opens 38A6:X probe-only', async () => {
    const hid = setupFakeHid();
    const dX = hid.addStray({ vendorId: VENDOR_ID_AULA, productId: 0xf010, name: 'AULA X' });
    const dY = hid.addStray({ vendorId: VENDOR_ID_WUQUE, productId: 0xf020, name: 'Wuque Y' });

    const t = (await reconnectGrantedHid()) as HidTransport | null;

    expect(t).not.toBeNull();
    expect(t!.identity.vendorId).toBe(VENDOR_ID_AULA);
    expect(t!.identity.productId).toBe(0xf010);
    expect(t!.probeOnly).toBe(true);
    expect(dX.opens).toBe(1);
    expect(dY.opens).toBe(0);
    await t!.close();
  });

  it('branch 1 unchanged: granted AE64 in its app still beats 1CA6 probe and 38A6 (prefers remembered AE64)', async () => {
    const hid = setupFakeHid();
    const d38a6 = hid.addStray({ vendorId: VENDOR_ID_AULA, productId: 0xf002, name: 'AULA' });
    const dBoot = hid.addStray({ vendorId: VENDOR_ID, productId: 0xf099, name: '1CA6 Boot' });
    const dPro = hid.addStray({ vendorId: VENDOR_ID, productId: PRODUCT_ID_PRO, name: 'AE64 Pro' });
    const dMax = hid.addStray({ vendorId: VENDOR_ID, productId: PRODUCT_ID_MAX, name: 'AE64 Max' });

    rememberDevice(VENDOR_ID, PRODUCT_ID_MAX);
    const t = (await reconnectGrantedHid()) as HidTransport | null;

    expect(t).not.toBeNull();
    expect(t!.identity.vendorId).toBe(VENDOR_ID);
    expect(t!.identity.productId).toBe(PRODUCT_ID_MAX);
    expect(t!.probeOnly).toBe(false);
    expect(dMax.opens).toBe(1);
    expect(dPro.opens).toBe(0);
    expect(dBoot.opens).toBe(0);
    expect(d38a6.opens).toBe(0);
    await t!.close();
  });
});
