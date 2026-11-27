// Generic (non-AE64) mock keyboards built from public facts only (DESIGN MKB §15).
// Each mock supplies a USB identity and byte-level replies (reusing MockTransport's emulation);
// none presets `support` — the pure classifier (§3.3) decides.

import type { Bytes, Performance, TransportCollection, TransportIdentity } from './types';
import { BaseTransport, TransportTimeoutError, replyMatches } from './client';
import { MockTransport } from './mock';
import { encodeLayoutStyleEntry, encodePerformance, le16, mmToUm } from './codec';
import {
  CONFIG_USAGE, CONFIG_USAGE_PAGE, LED_MATRIX_COLS, RECEIVER_USAGE_PAGE, REPORT_LENGTH,
  VENDOR_ID, VENDOR_ID_AULA, VENDOR_ID_WUQUE,
} from './constants';

export const GENERIC_MOCK_NAMES = [
  'g60', 'g75', 'godd', 'gmiss', 'gsilent', 'gv3',
  'gproto2', 'gboot', 'gtwin', 'gff80', 'gspoof', 'gspoofPro',
] as const;

export type GenericMockName = typeof GENERIC_MOCK_NAMES[number];

export function isGenericMockName(v: unknown): v is GenericMockName {
  return typeof v === 'string' && (GENERIC_MOCK_NAMES as readonly string[]).includes(v);
}

/** Dev-only `?mock=<name>` lookup (DESIGN MKB §15). Always null outside dev builds (`import.meta.env.DEV`). */
export function devMockNameFromSearch(search?: string): GenericMockName | null {
  if (!import.meta.env.DEV) return null;
  const q = search ?? (typeof window !== 'undefined' ? window.location.search : '');
  const name = new URLSearchParams(q).get('mock');
  return isGenericMockName(name) ? name : null;
}

interface MockKeyDef {
  row: number;
  col: number;
  x: number;
  y: number;
  ratio: number;
  code: number;
  rangeMax?: number;
}

interface MockAreaDef {
  id: number;
  modes: number;
  rows: number;
  cols: number;
}

interface GenericMockSpec {
  vendorId: number;
  productId: number;
  productName: string;
  extraCollections?: TransportCollection[];
  boardBytes: readonly [number, number, number, number];
  typeByte?: number;
  subTypeByte?: number;
  runMode?: number;
  serial?: readonly number[];
  protocol?: readonly [number, number, number, number];
  profileCount?: number;
  rtPrecisionUm?: number;
  defaultRangeMaxUm?: number;
  areas: readonly MockAreaDef[];
  areasDeclaredCount?: number;
  keys: readonly MockKeyDef[];
  /** Optional non-zero layout entries in cols 21–29 (to test R12 padding handling on `godd`). */
  padding?: readonly { row: number; col: number; x: number; y: number; ratio: number }[];
  /** Custom reply override (returns null to simulate no answer / timeout; undefined to fall through). */
  overrideReply?: (req: readonly number[]) => number[] | null | undefined;
}

const CONFIG_COLLECTION: TransportCollection = {
  usagePage: CONFIG_USAGE_PAGE,
  usage: CONFIG_USAGE,
  inputReports: [REPORT_LENGTH],
  outputReports: [REPORT_LENGTH],
};

const RECEIVER_COLLECTION: TransportCollection = {
  usagePage: RECEIVER_USAGE_PAGE,
  usage: CONFIG_USAGE,
  inputReports: [REPORT_LENGTH],
  outputReports: [REPORT_LENGTH],
};

interface RowKeyInput {
  code: number;
  ratio: number;
  col?: number;
  x?: number;
}

const rk = (code: number, ratio = 1, col?: number, x?: number): RowKeyInput => ({ code, ratio, col, x });

/** Helper to lay out sequential keys along a single row. */
function rowKeys(row: number, y: number, items: readonly RowKeyInput[]): MockKeyDef[] {
  const out: MockKeyDef[] = [];
  let x = 0;
  const ratioW: Record<number, number> = { 1: 1, 2: 1.25, 3: 1.5, 4: 1.75, 5: 2, 6: 2.25, 9: 6.25 };
  items.forEach((item, idx) => {
    const col = item.col ?? idx;
    if (item.x !== undefined) x = item.x;
    out.push({ row, col, x, y, ratio: item.ratio, code: item.code });
    x += ratioW[item.ratio] ?? 1;
  });
  return out;
}

// 61-key 60% ANSI layout on firmware rows 1–5 (Esc in number row, 6.25u Space, 8-key bottom row with Fn & Menu).
const KEYS_60: readonly MockKeyDef[] = [
  ...rowKeys(1, 0, [
    rk(0x29), rk(0x1e), rk(0x1f), rk(0x20), rk(0x21), rk(0x22), rk(0x23),
    rk(0x24), rk(0x25), rk(0x26), rk(0x27), rk(0x2d), rk(0x2e), rk(0x2a, 5),
  ]),
  ...rowKeys(2, 1, [
    rk(0x2b, 3), rk(0x14), rk(0x1a), rk(0x08), rk(0x15), rk(0x17), rk(0x1c),
    rk(0x18), rk(0x0c), rk(0x12), rk(0x13), rk(0x2f), rk(0x30), rk(0x31, 3),
  ]),
  ...rowKeys(3, 2, [
    rk(0x39, 4), rk(0x04), rk(0x16), rk(0x07), rk(0x09), rk(0x0a), rk(0x0b),
    rk(0x0d), rk(0x0e), rk(0x0f), rk(0x33), rk(0x34), rk(0x28, 6),
  ]),
  ...rowKeys(4, 3, [
    rk(0xe1, 6), rk(0x1d), rk(0x1b), rk(0x06), rk(0x19), rk(0x05), rk(0x11),
    rk(0x10), rk(0x36), rk(0x37), rk(0x38), rk(0xe5, 6),
  ]),
  ...rowKeys(5, 4, [
    rk(0xe0, 2, 0), rk(0xe3, 2, 1), rk(0xe2, 2, 2), rk(0x2c, 9, 6),
    rk(0xe6, 2, 9), rk(0xf101, 2, 10), rk(0x65, 2, 11), rk(0xe4, 2, 12),
  ]),
];

// 81-key 75% ANSI layout with F-row on firmware row 0 (rows 0–5, 16u wide).
const KEYS_75: readonly MockKeyDef[] = [
  ...rowKeys(0, 0, [
    rk(0x29, 1, 0, 0),
    rk(0x3a, 1, 1, 1.5), rk(0x3b, 1, 2), rk(0x3c, 1, 3), rk(0x3d, 1, 4),
    rk(0x3e, 1, 5, 6), rk(0x3f, 1, 6), rk(0x40, 1, 7), rk(0x41, 1, 8),
    rk(0x42, 1, 9, 10.5), rk(0x43, 1, 10), rk(0x44, 1, 11), rk(0x45, 1, 12),
    rk(0x4c, 1, 14, 15),
  ]),
  ...rowKeys(1, 1, [
    rk(0x35), rk(0x1e), rk(0x1f), rk(0x20), rk(0x21), rk(0x22), rk(0x23),
    rk(0x24), rk(0x25), rk(0x26), rk(0x27), rk(0x2d), rk(0x2e), rk(0x2a, 5), rk(0x4a),
  ]),
  ...rowKeys(2, 2, [
    rk(0x2b, 3), rk(0x14), rk(0x1a), rk(0x08), rk(0x15), rk(0x17), rk(0x1c),
    rk(0x18), rk(0x0c), rk(0x12), rk(0x13), rk(0x2f), rk(0x30), rk(0x31, 3), rk(0x4b),
  ]),
  ...rowKeys(3, 3, [
    rk(0x39, 4), rk(0x04), rk(0x16), rk(0x07), rk(0x09), rk(0x0a), rk(0x0b),
    rk(0x0d), rk(0x0e), rk(0x0f), rk(0x33), rk(0x34), rk(0x28, 6), rk(0x4e, 1, 14, 15),
  ]),
  ...rowKeys(4, 4, [
    rk(0xe1, 6), rk(0x1d), rk(0x1b), rk(0x06), rk(0x19), rk(0x05), rk(0x11),
    rk(0x10), rk(0x36), rk(0x37), rk(0x38), rk(0xe5, 4), rk(0x52, 1, 13, 14), rk(0x4d, 1, 14, 15),
  ]),
  ...rowKeys(5, 5, [
    rk(0xe0, 2, 0), rk(0xe3, 2, 1), rk(0xe2, 2, 2), rk(0x2c, 9, 6),
    rk(0xe6, 3, 9), rk(0xf101, 3, 10), rk(0x50, 1, 12), rk(0x51, 1, 13), rk(0x4f, 1, 14),
  ]),
];

// Odd board layout (DESIGN §15 `godd`): unknown ratio codes 7, 8 (at row end) and 12 (2-row-tall slot),
// mid-row hole (col 2 absent), > 1/4u overlap on row 2, 4.5 mm key, plus padding entries 21–29 on row 1.
const KEYS_ODD: readonly MockKeyDef[] = [
  { row: 1, col: 0, x: 0, y: 0, ratio: 1, code: 0x29, rangeMax: 4500 },
  { row: 1, col: 1, x: 1, y: 0, ratio: 7, code: 0x1e }, // unknown code 7; gap to col 3 (x=3.75) = 2.75u
  // row 1 col 2 omitted -> ratio 0 mid-row hole
  { row: 1, col: 3, x: 3.75, y: 0, ratio: 1, code: 0x1f },
  { row: 1, col: 4, x: 4.75, y: 0, ratio: 8, code: 0x20 }, // unknown code 8 at row end -> 1u
  { row: 2, col: 0, x: 0, y: 1, ratio: 5, code: 0x2b }, // 2u [0, 2]
  { row: 2, col: 1, x: 1.5, y: 1, ratio: 1, code: 0x14 }, // 1u [1.5, 2.5] -> overlaps col 0 by 0.5u > 0.25u
  { row: 2, col: 2, x: 3, y: 1, ratio: 12, code: 0x28 }, // unknown code 12 (2-row-tall slot); gap to x=4.5 = 1.5u
  { row: 2, col: 3, x: 4.5, y: 1, ratio: 1, code: 0x1a },
  { row: 3, col: 0, x: 0, y: 2, ratio: 1, code: 0x04 },
  { row: 3, col: 1, x: 1, y: 2, ratio: 1, code: 0x16 },
  { row: 3, col: 2, x: 2, y: 2, ratio: 1, code: 0x07 },
];

const ODD_AREAS: readonly MockAreaDef[] = Array.from({ length: 15 }, (_, id) => (
  id === 0 ? { id: 0, modes: 10, rows: 5, cols: 15 }
    : id === 1 ? { id: 1, modes: 4, rows: 1, cols: 12 }
      : { id, modes: 3, rows: 1, cols: 8 }
));

const SPECS: Readonly<Record<GenericMockName, GenericMockSpec>> = {
  g60: {
    vendorId: VENDOR_ID,
    productId: 0xf001,
    productName: 'Mock 60',
    boardBytes: [0x00, 0xf0, 0x00, 0x01],
    protocol: [1, 3, 0, 0],
    profileCount: 4,
    areas: [{ id: 0, modes: 12, rows: 6, cols: 15 }],
    keys: KEYS_60,
  },
  g75: {
    vendorId: VENDOR_ID_AULA,
    productId: 0xf002,
    productName: 'Mock 75',
    boardBytes: [0x00, 0xf0, 0x00, 0x02],
    protocol: [1, 3, 0, 0],
    profileCount: 4,
    defaultRangeMaxUm: 3500,
    rtPrecisionUm: 1,
    areas: [
      { id: 0, modes: 15, rows: 6, cols: 16 },
      { id: 1, modes: 6, rows: 1, cols: 20 },
    ],
    keys: KEYS_75,
  },
  godd: {
    vendorId: VENDOR_ID_WUQUE,
    productId: 0xf003,
    productName: 'Mock Odd',
    boardBytes: [0x00, 0xf0, 0x00, 0x03],
    protocol: [1, 3, 0, 0],
    profileCount: 6,
    areas: ODD_AREAS,
    areasDeclaredCount: 16,
    keys: KEYS_ODD,
    padding: [
      { row: 1, col: 21, x: 14, y: 0, ratio: 1 },
      { row: 1, col: 25, x: 15, y: 0, ratio: 1 },
    ],
  },
  gmiss: {
    vendorId: VENDOR_ID,
    productId: 0xf004,
    productName: '',
    boardBytes: [0x00, 0xf0, 0x00, 0x04],
    protocol: [1, 3, 0, 0],
    profileCount: 4,
    areas: [
      { id: 0, modes: 10, rows: 5, cols: 14 },
      { id: 1, modes: 4, rows: 1, cols: 10 },
    ],
    keys: KEYS_60,
    overrideReply: ([f, op, a, b]) => {
      if (f === 0x02 && op === 0x0c && a === 0x00) return null;
      if (f === 0x03 && op === 0x05 && a === 3) return null;
      if (f === 0x05 && op === 0x01 && a === 1 && b === 0x00) return null;
      if (f === 0x02 && op === 0x03 && a === 0x01) return null;
      return undefined;
    },
  },
  gsilent: {
    vendorId: VENDOR_ID,
    productId: 0xf005,
    productName: 'Mock Silent',
    boardBytes: [0x00, 0xf0, 0x00, 0x05],
    protocol: [1, 3, 0, 0],
    profileCount: 4,
    areas: [{ id: 0, modes: 12, rows: 6, cols: 15 }],
    keys: KEYS_60,
    overrideReply: ([f, op]) => (f === 0x01 && (op === 0x02 || op === 0x01) ? undefined : null),
  },
  gv3: {
    vendorId: VENDOR_ID,
    productId: 0xf006,
    productName: 'Mock V3',
    boardBytes: [0x00, 0xf0, 0x00, 0x06],
    protocol: [1, 3, 0, 0],
    areas: [{ id: 0, modes: 12, rows: 6, cols: 15 }],
    keys: [],
    overrideReply: () => [0x55, 0xaa, 0x01, 0x02, 0x00, 0x01],
  },
  gproto2: {
    vendorId: VENDOR_ID,
    productId: 0xf007,
    productName: 'Mock Proto 2',
    boardBytes: [0x00, 0xf0, 0x00, 0x07],
    protocol: [2, 0, 0, 0],
    areas: [{ id: 0, modes: 12, rows: 6, cols: 15 }],
    keys: KEYS_60,
  },
  gboot: {
    vendorId: VENDOR_ID,
    productId: 0xf008,
    productName: 'Mock Boot',
    boardBytes: [0x00, 0xf0, 0x00, 0x08],
    runMode: 255,
    protocol: [1, 3, 0, 0],
    areas: [{ id: 0, modes: 12, rows: 6, cols: 15 }],
    keys: [],
  },
  gtwin: {
    vendorId: VENDOR_ID,
    productId: 0xf009,
    productName: 'Mock Twin',
    boardBytes: [0x00, 0xf0, 0x00, 0x09],
    typeByte: 2,
    subTypeByte: 3,
    protocol: [1, 2, 0, 0],
    profileCount: 4,
    areas: [
      { id: 0, modes: 14, rows: 6, cols: 15 },
      { id: 1, modes: 5, rows: 1, cols: 16 },
    ],
    keys: KEYS_60,
  },
  gff80: {
    vendorId: VENDOR_ID,
    productId: 0xf00a,
    productName: 'Mock Receiver',
    extraCollections: [RECEIVER_COLLECTION],
    boardBytes: [0x00, 0xf0, 0x00, 0x0a],
    protocol: [1, 3, 0, 0],
    areas: [{ id: 0, modes: 12, rows: 6, cols: 15 }],
    keys: KEYS_60,
  },
  gspoof: {
    vendorId: VENDOR_ID,
    productId: 0xf00b,
    productName: 'Mock Spoof',
    // Intentionally reports AE64 Max board, run mode 0, readable serial (DESIGN MKB §15, N4).
    boardBytes: [0x00, 0x30, 0x00, 0x0d],
    runMode: 0,
    serial: [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc],
    protocol: [1, 3, 0, 0],
    profileCount: 4,
    areas: [{ id: 0, modes: 19, rows: 6, cols: 15 }],
    keys: KEYS_60,
  },
  gspoofPro: {
    vendorId: VENDOR_ID,
    productId: 0xf00c,
    productName: 'Mock Spoof Pro',
    // Intentionally reports AE64 Pro board, run mode 0, readable serial (DESIGN MKB §15, R3).
    boardBytes: [0x00, 0x30, 0x00, 0x0a],
    runMode: 0,
    serial: [0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x2b, 0x2c],
    protocol: [1, 3, 0, 0],
    profileCount: 4,
    areas: [
      { id: 0, modes: 20, rows: 6, cols: 15 },
      { id: 1, modes: 5, rows: 1, cols: 38 },
    ],
    keys: KEYS_60,
  },
};

export interface GenericMockOptions {
  latencyMs?: number;
  /** Override VID (used for the `gboot` 38A6:F008 variant, DESIGN §15). */
  vendorId?: number;
  /** Test-only reply override (returns null for no answer / timeout; undefined to fall through). */
  overrideReply?: (req: readonly number[]) => number[] | null | undefined;
}

const DEFAULT_SERIAL: readonly number[] = [0x10, 0x20, 0x30, 0x40, 0x50, 0x60, 0x70, 0x80, 0x90, 0xa0, 0xb0, 0xc0];
const DEFAULT_TIMESTAMP = Array.from('2026112700:00:00', (ch) => ch.charCodeAt(0));

const posKey = (row: number, col: number): string => `${row}:${col}`;

export class GenericMockTransport extends BaseTransport {
  readonly kind = 'mock' as const;
  readonly mockName: GenericMockName;
  readonly productName: string;
  readonly productId: number;
  private readonly _identity: TransportIdentity;
  private readonly spec: GenericMockSpec;
  private readonly backing: MockTransport;
  private readonly latencyMs: number;
  private readonly keysByPos = new Map<string, MockKeyDef>();
  private readonly liveTravel = new Map<string, { travelUm: number; pressed: boolean }>();
  private replyOverride?: (req: readonly number[]) => number[] | null | undefined;
  private activeProfile = 0;
  private open = true;

  constructor(name: GenericMockName, opts: GenericMockOptions = {}) {
    super();
    const spec = SPECS[name];
    this.mockName = name;
    this.spec = spec;
    this.latencyMs = opts.latencyMs ?? 2;
    this.replyOverride = opts.overrideReply;
    this.productName = spec.productName;
    this.productId = spec.productId;
    this._identity = {
      vendorId: opts.vendorId ?? spec.vendorId,
      productId: spec.productId,
      productName: spec.productName,
      collections: [CONFIG_COLLECTION, ...(spec.extraCollections ?? [])],
    };
    this.backing = new MockTransport({ latencyMs: 0 });
    for (const k of spec.keys) this.keysByPos.set(posKey(k.row, k.col), k);
  }

  override get identity(): TransportIdentity {
    return this._identity;
  }

  get connected(): boolean {
    return this.open;
  }

  async close(): Promise<void> {
    this.open = false;
    await this.backing.close();
  }

  /** Test helper: override replies dynamically (return null for no answer / timeout; undefined to fall through). */
  setReplyOverride(fn?: (req: readonly number[]) => number[] | null | undefined): void {
    this.replyOverride = fn;
  }

  /** Test helper: simulate hardware profile switch (e.g. Fn profile key mid-export). */
  setHardwareProfile(index: number): void {
    this.activeProfile = index;
  }

  /** Test helper: simulate a key press on any `(row, col)` of this generic layout (including row 0 on `g75`). */
  simulatePressPos(row: number, col: number, travelMm: number): void {
    const key = this.keysByPos.get(posKey(row, col));
    if (!key) return;
    const rangeUm = key.rangeMax ?? this.spec.defaultRangeMaxUm ?? 3310;
    const travelUm = Math.min(Math.max(Math.round(mmToUm(travelMm)), 0), rangeUm);
    this.liveTravel.set(posKey(row, col), { travelUm, pressed: travelUm >= 1000 });
  }

  protected exchange(frame: Uint8Array, timeoutMs = 1500): Promise<Bytes> {
    const reply = this.handleGeneric(Array.from(frame));
    if (!reply || !replyMatches(frame, reply)) {
      return new Promise((_, reject) => {
        setTimeout(() => reject(new TransportTimeoutError(Array.from(frame.slice(0, 2)))), timeoutMs);
      });
    }
    return new Promise((resolve) => setTimeout(() => resolve(reply), this.latencyMs));
  }

  private handleGeneric(req: number[]): Uint8Array | null {
    const out = new Uint8Array(REPORT_LENGTH);
    const set = (bytes: readonly number[]) => { out.set(bytes.slice(0, REPORT_LENGTH)); return out; };
    const dyn = this.replyOverride?.(req);
    if (dyn === null) return null;
    if (dyn !== undefined) return set(dyn);
    const override = this.spec.overrideReply?.(req);
    if (override === null) return null;
    if (override !== undefined) return set(override);

    const [f, op, a = 0, b = 0] = req;
    const s = this.spec;

    if (f === 0x01 && op === 0x01) {
      return set([0x01, 0x01, ...(s.protocol ?? [1, 3, 0, 0])]);
    }
    if (f === 0x01 && op === 0x02) {
      const serial = s.serial ?? DEFAULT_SERIAL;
      return set([
        0x01, 0x02,
        s.typeByte ?? 1, s.subTypeByte ?? 0,
        ...s.boardBytes,
        1, 0, 0, 0, // firmware
        1, 0, 0, 0, // pcb
        s.runMode ?? 0,
        ...serial,
        ...DEFAULT_TIMESTAMP,
      ]);
    }
    if (f === 0x02 && op === 0x03) {
      const count = s.profileCount ?? 4;
      if (a === 0x00) return set([0x02, 0x03, 0x00, count]);
      if (a === 0x01) return set([0x02, 0x03, 0x01, this.activeProfile]);
      if (a === 0x03) return set([0x02, 0x03, 0x03, b, ...new TextEncoder().encode(`Profile ${b + 1}`)]);
    }
    if (f === 0x02 && op === 0x08 && a === 0x00) {
      const count = s.areasDeclaredCount ?? s.areas.length;
      const body = s.areas.flatMap((ar) => [ar.id, ar.modes, ar.rows, ar.cols]);
      return set([0x02, 0x08, 0x00, count, ...body]);
    }
    if (f === 0x02 && op === 0x0c && a === 0x00) {
      return set([0x02, 0x0c, 0x00, s.rtPrecisionUm ?? 1, 1]);
    }
    if (f === 0x03 && op === 0x05) {
      const entries: number[] = [];
      for (let col = 0; col < 30; col++) {
        const k = this.keysByPos.get(posKey(a, col));
        const pad = !k ? s.padding?.find((p) => p.row === a && p.col === col) : undefined;
        const src = k ?? pad;
        entries.push(...le16(src ? encodeLayoutStyleEntry({ y: src.y, x: src.x, ratio: src.ratio }) : 0));
      }
      return set([0x03, 0x05, a, ...entries]);
    }
    if (f === 0x03 && (op === 0x01 || op === 0x06)) {
      const layer = op === 0x01 ? a : (a & 15);
      const row = b;
      const codes: number[] = [];
      for (let col = 0; col < 30; col++) {
        const k = this.keysByPos.get(posKey(row, col));
        const code = !k ? 0 : layer === 0 ? k.code : 0x0001;
        codes.push(...le16(code));
      }
      return set([0x03, op, a, b, ...codes]);
    }
    if (f === 0x03 && op === 0x03) {
      const k = this.keysByPos.get(posKey(b, req[4] ?? 0));
      const code = !k ? 0 : a === 0 ? k.code : 0x0001;
      return set([0x03, 0x03, a, b, req[4] ?? 0, ...le16(code)]);
    }
    if (f === 0x04 && op === 0x01) {
      const k = this.keysByPos.get(posKey(a, b));
      if (!k) return set([0x04, 0x01, a, b]);
      const rangeMax = k.rangeMax ?? s.defaultRangeMaxUm ?? 3310;
      const perf: Performance = {
        mode: 1,
        normalPress: 2.0,
        normalRelease: 2.0,
        rtFirstTouch: 1.0,
        rtPress: 0.5,
        rtRelease: 0.5,
        pressDeadStroke: 0.1,
        releaseDeadStroke: 0.1,
        axis: 0,
        calibrate: 1,
        axisV2Id: 0x3001,
        axisRangeMax: rangeMax,
        axisCoefficient: 20000,
      };
      return set([0x04, 0x01, a, b, ...encodePerformance({ row: a, col: b }, perf).slice(4)]);
    }
    if (f === 0x04 && op === 0x03) {
      const vals: number[] = [];
      for (let col = 0; col < LED_MATRIX_COLS; col++) {
        const k = this.keysByPos.get(posKey(b, col));
        if (!k) { vals.push(0); continue; }
        const st = this.liveTravel.get(posKey(b, col));
        const route = st?.travelUm ?? 0;
        if (a === 0) vals.push(2600 + Math.round(route * 0.45));
        else if (a === 1) vals.push(route);
        else if (a === 2) vals.push(1);
        else if (a === 3) vals.push(st?.pressed ? 1 : 0);
        else vals.push(0);
      }
      return set([0x04, 0x03, a, b, ...vals.flatMap((v) => le16(v))]);
    }
    return this.backing.handle(req);
  }
}

export function createGenericMock(name: GenericMockName, opts?: GenericMockOptions): GenericMockTransport {
  return new GenericMockTransport(name, opts);
}
