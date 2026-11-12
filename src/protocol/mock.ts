// Demo transport: a byte-level emulator of an AE64 (Max or Pro) seeded from contracts/device-snapshot.md.
// seed 'pro' answers as an AE64 Pro (board 0030000a, firmware 0.1.0.0, 20 area-0 lighting modes, the user's profile names and White Wukong switches); everything else is the Max's.
// Requests go through the same codecs as WebHID; this class only answers 64-byte frames.
// Writes persist in memory for the session; commits are acknowledged and otherwise no-ops.

import type { Bytes, Performance, PhysicalKey } from './types';
import { BaseTransport } from './client';
import { encodeLayoutStyleEntry, encodePerformance, le16, mmToUm, read16 } from './codec';
import { STRIP_ORDER } from './ledLayout';
import { LED_MATRIX_COLS, PRODUCT_ID_MAX, PRODUCT_ID_PRO, LED_RECORDS_PER_PACKET, LED_STRIP_COUNT, MACRO_ACTIONS_PER_PAGE, RATIO_UNITS } from './constants';
import { PHYSICAL_KEYS } from './layout';

const hex = (s: string) => s.trim().split(/\s+/).map((h) => parseInt(h, 16));

// Measured replies (device-snapshot.md).
const SNAPSHOT: Record<string, number[]> = {
  '01:01': hex('01 01 01 03 00 00'),
  '01:02': hex('01 02 01 00 00 30 00 0d 00 00 04 00 01 00 00 00 00 36 08 12 50 43 39 46 35 36 05 16 57 32 30 32 36 31 30 31 32 31 35 3a 31 33 3a 34 31'),
  '01:03': hex('01 03 02 01 01 00'),
  '02:05:00': hex('02 05 00 06 00 01 02 03 04 05'),
  '02:07:00': hex('02 07 00 00'),
  '02:08:00': hex('02 08 00 02 00 13 06 0f 01 05 01 26'),
  '02:09:01': hex('02 09 01 20 10 3e 0d 20 4e'),
  '02:0c:00': hex('02 0c 00 01 01'),
  '02:0e:00': hex('02 0e 00 10 c0 03'),
};

/** Replies that differ on the AE64 Pro seed: board bytes 00 30 00 0a, firmware 0.1.0.0 (bytes 8..11), 20 modes in area 0. */
const PRO_SNAPSHOT: Record<string, number[]> = {
  '01:02': SNAPSHOT['01:02'].map((b, i) => (i === 7 ? 0x0a : i === 9 ? 0x01 : i === 10 ? 0x00 : b)),
  '02:08:00': hex('02 08 00 02 00 14 06 0F 01 05 01 26'),
};

// Layer-0 keymap measured on the user's board (row → firmware column → keycode, 0 = empty).
const LAYER0: number[][] = [
  hex('29 1e 1f 20 21 22 23 24 25 26 27 2d 2e 2a'),
  hex('2b 14 1a 08 15 17 1c 18 0c 12 13 2f 30 31'),
  hex('39 04 16 07 09 0a 0b 0d 0e 0f 33 34 00 28'),
  hex('e1 00 1d 1b 06 19 05 11 10 36 37 38 4c 52 46'),
  [0xe0, 0xe3, 0xe2, 0, 0, 0, 0x2c, 0, 0, 0xe6, 0xf101, 0, 0x50, 0x51, 0x4f],
];

/** Snapshot performance record (W/A/Esc); Space has a 0.2 mm top dead zone. */
const SNAPSHOT_PERF: Performance = {
  mode: 1, normalPress: 2, normalRelease: 2, rtFirstTouch: 1, rtPress: 0.8, rtRelease: 0.3,
  pressDeadStroke: 0.1, releaseDeadStroke: 0.1, axis: 0, calibrate: 1, axisV2Id: 12432, axisRangeMax: 3310, axisCoefficient: 20500,
};

/** The real Pro's profile names (each with a trailing space) and its switch on every key: 14544 White Wukong. */
const PRO_PROFILE_NAMES = ['配置一 ', '配置二 ', '配置三 ', '配置四 '];
const PRO_SWITCH: Partial<Performance> = { axisV2Id: 14544, axisRangeMax: 3400, axisCoefficient: 17664 };

const ROW3_ADC = [2632, 2760, 2687, 2717, 2696, 2835, 2694, 2494, 2680, 2740, 2646, 2634, 0, 2645, 0];
const KEYMAP_COLS = 30;
const RATIO_CODE = new Map(Object.entries(RATIO_UNITS).map(([code, units]) => [units, Number(code)]));
const keyAt = (row: number, col: number) => PHYSICAL_KEYS.find((k) => k.row === row && k.col === col);
const posKey = (row: number, col: number) => `${row}:${col}`;

interface MockProfile {
  name: string;
  keymap: number[][][];               // [layer][row 0..5][col]
  perf: Map<string, number[]>;        // row:col → bytes 4..26 of the 04 01 reply
  advanced: Map<string, number[]>;    // row:col → bytes 4.. of the 06 01 reply
  lightBase: number[][];              // [area] → bytes 4..9
  palette: number[][];                // [area] → 32 bytes
  leds: number[][][];                 // [area][index] → B,G,R,flag
}

interface LiveKey { travel: number; pressed: boolean; extreme: number; rtArmed: boolean }

function perfBytes(p: Performance): number[] {
  return encodePerformance({ row: 0, col: 0 }, p).slice(4);
}

function makeProfile(name: string, perfFor: (k: PhysicalKey) => Partial<Performance>): MockProfile {
  const keymap = Array.from({ length: 4 }, (_, layer) =>
    Array.from({ length: 6 }, (_, row) => Array.from({ length: KEYMAP_COLS }, (_, col) => {
      if (row === 0) return 0;
      const base = LAYER0[row - 1][col] ?? 0;
      if (layer === 0 || !base) return base;
      if (layer === 1) {
        if (row === 1 && col >= 1 && col <= 12) return 0x3a + col - 1;      // F1–F12 on the number row
        if (row === 1 && col === 13) return 0x4c;                             // Delete
        if (row === 4 && col === 13) return 0x4b;                             // PgUp
        if (row === 5 && col >= 12) return [0x4a, 0x4e, 0x4d][col - 12];      // Home / PgDn / End
        if (row === 2 && col === 1) return 0xf300;                            // RGB mode
      }
      return 0x0001;                                                          // Transparent
    })),
  );
  const perf = new Map<string, number[]>();
  for (const k of PHYSICAL_KEYS) {
    const p: Performance = { ...SNAPSHOT_PERF, ...(k.name === 'Space' ? { pressDeadStroke: 0.2 } : {}), ...perfFor(k) };
    perf.set(posKey(k.row, k.col), perfBytes(p));
  }
  const palette = [[0, 0, 255], [0, 255, 0], [0, 255, 255], [255, 0, 0], [255, 0, 255], [255, 255, 0], [255, 255, 255], [0, 0, 0]]
    .flatMap((bgr) => [...bgr, 0]);
  return {
    name,
    keymap,
    perf,
    advanced: new Map(),
    lightBase: [[3, 1, 80, 50, 0, 0], [1, 0, 80, 50, 0, 0]],
    palette: [palette.slice(), palette.slice()],
    leds: [
      Array.from({ length: 6 * LED_MATRIX_COLS }, () => [0xc5, 0xe0, 0x3f, 0]),
      Array.from({ length: LED_STRIP_COUNT }, () => [0xc5, 0xe0, 0x3f, 0]),
    ],
  };
}

const isWasd = (k: PhysicalKey) => ['W', 'A', 'S', 'D'].includes(k.name);

export class MockTransport extends BaseTransport {
  readonly kind = 'mock' as const;
  readonly productName: string;
  readonly productId: number;
  private readonly snapshot: Record<string, number[]>;
  private open = true;
  private readonly latencyMs: number;
  private readonly profiles: MockProfile[];
  private active = 0;
  private systemMode = 0;
  private pollingRate = 0;
  private rgbSleep = 0;
  private shake = true;
  private calibrating = false;
  /** Keys pressed to the bottom during the running calibration: calibrated when it stops. */
  private newlyCalibrated = new Set<string>();
  private readonly macroMeta: number[][] = Array.from({ length: 16 }, () => [0, 0, 0, 1, 0, 0]);
  private readonly macroActions: number[][] = Array.from({ length: 16 }, () => []);
  private readonly live = new Map<number, LiveKey>();

  constructor(opts: { latencyMs?: number; seed?: 'max' | 'pro' } = {}) {
    super();
    const pro = opts.seed === 'pro';
    this.productName = pro ? 'AE64 Pro (demo)' : 'AE64-MAX (demo)';
    this.productId = pro ? PRODUCT_ID_PRO : PRODUCT_ID_MAX;
    this.snapshot = pro ? { ...SNAPSHOT, ...PRO_SNAPSHOT } : SNAPSHOT;
    this.latencyMs = opts.latencyMs ?? 2;
    const sw = pro ? PRO_SWITCH : {};
    const profileName = (i: number, name: string) => (pro ? PRO_PROFILE_NAMES[i] : name);
    this.profiles = [
      makeProfile(profileName(0, 'Default'), () => sw),
      makeProfile(profileName(1, 'FPS'), (k) => ({
        ...(isWasd(k)
          ? { mode: 1, rtFirstTouch: 0.3, rtPress: 0.1, rtRelease: 0.1, pressDeadStroke: 0.1 }
          : { mode: 0, normalPress: 1.2, normalRelease: 1.2 }),
        ...sw,
      })),
      makeProfile(profileName(2, 'Typing'), () => ({ mode: 0, normalPress: 2, normalRelease: 2, pressDeadStroke: 0.2, releaseDeadStroke: 0.2, ...sw })),
      makeProfile(profileName(3, 'Profile 4'), () => ({ mode: 0, normalPress: 1.5, normalRelease: 1.5, ...sw })),
    ];
    // FPS profile: SOCD Last Override on A/D (row 3 cols 1 and 3), as a demo of advanced keys.
    this.profiles[1].advanced.set(posKey(3, 1), [6, 3, 3, ...le16(0x04), ...le16(0x07), 0, 0, 0]);
    this.profiles[1].advanced.set(posKey(3, 3), [6, 3, 1, ...le16(0x07), ...le16(0x04), 0, 0, 0]);
    // Macro 0: Ctrl+C then Ctrl+V.
    const act = (down: boolean, delay: number, code: number) => {
      const p = ((down ? 0x80000000 : 0) | (delay << 16) | code) >>> 0;
      return [p & 0xff, (p >>> 8) & 0xff, (p >>> 16) & 0xff, p >>> 24];
    };
    this.macroActions[0] = [
      act(true, 10, 0xe0), act(true, 30, 0x06), act(false, 10, 0x06),
      act(true, 30, 0x19), act(false, 10, 0x19), act(false, 10, 0xe0),
    ].flat();
    this.macroMeta[0] = [1, 6, 0, 1, 0, 0];
  }

  get connected(): boolean {
    return this.open;
  }

  async close(): Promise<void> {
    this.open = false;
  }

  private travelTicker: ((now: number) => void) | null = null;

  /** Demo helper: a function run before every axis-data read, so simulated travel is current at read time. */
  setTravelTicker(fn: ((now: number) => void) | null): void {
    this.travelTicker = fn;
  }

  /** Demo helper: set a key's travel (mm) so axis data (route/status/ADC) reflects a press. */
  simulatePress(keyId: number, travelMm: number): void {
    const key = PHYSICAL_KEYS[keyId];
    if (!key) return;
    const perfRec = this.profiles[this.active].perf.get(posKey(key.row, key.col))!;
    const p = this.decodePerfRecord(perfRec);
    const rangeMax = p.axisRangeMax / 1000;
    let t = Math.min(Math.max(travelMm, 0), rangeMax);
    if (t <= p.pressDeadStroke) t = 0;
    const s = this.live.get(keyId) ?? { travel: 0, pressed: false, extreme: 0, rtArmed: false };
    if (p.mode === 0) {
      const release = p.normalRelease > 0 && p.normalRelease < p.normalPress ? p.normalRelease : p.normalPress;
      s.pressed = s.pressed ? t >= release : t >= p.normalPress;
    } else if (p.mode === 1 ? t <= 0 : t < p.rtFirstTouch) {
      // Continuous RT (1) resets only when fully up; mode 2 resets above the first actuation point.
      s.pressed = false;
      s.rtArmed = false;
    } else if (!s.rtArmed) {
      if (t < p.rtFirstTouch) { s.travel = t; this.live.set(keyId, s); return; }
      s.pressed = true;
      s.rtArmed = true;
      s.extreme = t;
    } else if (s.pressed) {
      s.extreme = Math.max(s.extreme, t);
      if (t <= s.extreme - p.rtRelease) { s.pressed = false; s.extreme = t; }
    } else {
      s.extreme = Math.min(s.extreme, t);
      // Never past the bottom: lifting near the bottom and pressing back down re-actuates, as on the real board.
      if (t >= Math.min(s.extreme + p.rtPress, rangeMax)) { s.pressed = true; s.extreme = t; }
    }
    s.travel = t;
    this.live.set(keyId, s);
  }

  private decodePerfRecord(rec: number[]) {
    const r = (o: number) => read16(rec, o - 4) / 1000;
    return {
      mode: rec[0], normalPress: r(5), normalRelease: r(7), rtFirstTouch: r(9), rtPress: r(11), rtRelease: r(13),
      pressDeadStroke: r(15), axisRangeMax: read16(rec, 19),
    };
  }

  protected exchange(frame: Uint8Array): Promise<Bytes> {
    const reply = this.handle(Array.from(frame));
    return new Promise((resolve) => setTimeout(() => resolve(reply), this.latencyMs));
  }

  private handle(req: number[]): Uint8Array {
    const out = new Uint8Array(64);
    const set = (bytes: number[]) => { out.set(bytes.slice(0, 64)); return out; };
    const [f, op, a = 0, b = 0, c2 = 0] = req;
    const prof = this.profiles[this.active];
    const snap = this.snapshot[[f, op, a].map((x) => x.toString(16).padStart(2, '0')).join(':')]
      ?? this.snapshot[[f, op].map((x) => x.toString(16).padStart(2, '0')).join(':')];
    if (snap) return set(snap);

    switch (f) {
      case 0x02:
        switch (op) {
          case 0x03:
            if (a === 0) return set([2, 3, 0, this.profiles.length]);
            if (a === 1) return set([2, 3, 1, this.active]);
            if (a === 2) { if (b < this.profiles.length) { this.active = b; this.live.clear(); } return set([2, 3, 2, this.active]); }
            if (a === 3) return set([2, 3, 3, b, ...new TextEncoder().encode(this.profiles[b]?.name ?? '')]);
            if (a === 4 && this.profiles[b]) {
              const bytes = req.slice(4, 36);
              const end = bytes.indexOf(0);
              this.profiles[b].name = new TextDecoder().decode(Uint8Array.from(end < 0 ? bytes : bytes.slice(0, end)));
            }
            return set(req);
          case 0x04:
            if (a === 1) return set([2, 4, 1, this.systemMode]);
            if (a === 2) this.systemMode = b;
            if (a === 0) return set([2, 4, 0, 2, 0, 1]);
            return set(req);
          case 0x05:
            if (a === 1) return set([2, 5, 1, this.pollingRate]);
            if (a === 2) this.pollingRate = b;
            return set(req);
          case 0x06:
            this.calibrating = a === 0;
            if (a === 0) this.newlyCalibrated.clear();
            else {
              // Stopping keeps what was calibrated: the key's calibrate flag is 1 again.
              for (const pos of this.newlyCalibrated) { const rec = prof.perf.get(pos); if (rec) rec[16] = 1; }
              this.newlyCalibrated.clear();
            }
            return set(req);
          case 0x0d:
            if (a === 1) return set([2, 0x0d, 1, ...le16(this.rgbSleep)]);
            if (a === 0) this.rgbSleep = read16(req, 3);
            return set(req);
          case 0x10:
            if (a === 1) return set([2, 0x10, 1, this.shake ? 1 : 0]);
            if (a === 0) this.shake = b === 1;
            return set(req);
          default:
            return set(req); // 02 02 commit and anything else: acknowledge
        }
      case 0x03:
        switch (op) {
          case 0x01: return set([3, 1, a, b, ...(prof.keymap[a]?.[b] ?? []).flatMap((k) => le16(k))]);
          case 0x02: {
            const row = prof.keymap[a]?.[b];
            if (row) for (let i = 0; 4 + i * 2 + 1 < req.length && i < KEYMAP_COLS; i++) row[i] = read16(req, 4 + i * 2);
            return set(req);
          }
          case 0x03: return set([3, 3, a, b, c2, ...le16(prof.keymap[a]?.[b]?.[c2] ?? 0)]);
          case 0x04: {
            const row = prof.keymap[a]?.[b];
            if (row) row[c2] = read16(req, 5);
            return set(req);
          }
          case 0x05: {
            const entries: number[] = [];
            for (let col = 0; col < 30; col++) {
              const k = keyAt(a, col);
              entries.push(...le16(k ? encodeLayoutStyleEntry({ y: k.y, x: k.x, ratio: RATIO_CODE.get(k.w) ?? 1 }) : 0));
            }
            return set([3, 5, a, ...entries]);
          }
          case 0x06: {
            const layer = a & 15;
            const row = b;
            const codes = (LAYER0[row - 1] ?? []).map((code, col) => {
              if (layer !== 0) return code ? 1 : 0;
              if (row === 4 && col >= 12) return [0xe5, 0x52, 0x4c][col - 12]; // factory: RShift / Up / Delete
              return code;
            });
            return set([3, 6, a, b, ...codes.flatMap((k) => le16(k))]);
          }
        }
        break;
      case 0x04:
        if (op === 0x01) return set([4, 1, a, b, ...(prof.perf.get(posKey(a, b)) ?? [])]);
        if (op === 0x02) {
          const old = prof.perf.get(posKey(a, b));
          if (old) {
            const next = req.slice(4, 27);
            // Like the firmware: a changed switch triple (record bytes 17..22) resets the key's calibration, whatever was written.
            if (old.slice(17, 23).some((v, i) => v !== next[17 + i])) next[16] = 0;
            prof.perf.set(posKey(a, b), next);
          }
          return set(req);
        }
        if (op === 0x03) return set([4, 3, a, b, ...this.axisRow(a, b).flatMap((v) => le16(v))]);
        break;
      case 0x05: {
        const area = a;
        if (op === 0x01 && b === 0) return set([5, 1, area, 0, ...(prof.lightBase[area] ?? [])]);
        if (op === 0x01 && b === 1) return set([5, 1, area, 1, ...(prof.palette[area] ?? [])]);
        if (op === 0x02 && b === 0 && prof.lightBase[area]) prof.lightBase[area] = req.slice(4, 10);
        if (op === 0x02 && b === 1 && prof.palette[area]) prof.palette[area] = req.slice(4, 36);
        if (op === 0x03) return set([5, 3, area, b, ...this.ledPacket(prof, area, b)]);
        if (op === 0x04) {
          const leds = prof.leds[area] ?? [];
          for (let i = 0; i < LED_RECORDS_PER_PACKET; i++) {
            const idx = b * LED_RECORDS_PER_PACKET + i;
            if (idx < leds.length) leds[idx] = req.slice(4 + i * 4, 8 + i * 4);
          }
        }
        return set(req);
      }
      case 0x06:
        if (op === 0x01) return set([6, 1, a, b, ...(prof.advanced.get(posKey(a, b)) ?? [0])]);
        if (op === 0x02) {
          if (c2 === 0) prof.advanced.delete(posKey(a, b));
          else prof.advanced.set(posKey(a, b), req.slice(4));
          return set(req);
        }
        break;
      case 0x07:
        if (op === 0x01) return set([7, 1, a, ...(this.macroMeta[a] ?? [])]);
        if (op === 0x02) { if (this.macroMeta[a]) this.macroMeta[a] = req.slice(3, 9); return set(req); }
        if (op === 0x03) {
          const start = b * MACRO_ACTIONS_PER_PAGE * 4;
          return set([7, 3, a, b, ...(this.macroActions[a] ?? []).slice(start, start + MACRO_ACTIONS_PER_PAGE * 4)]);
        }
        if (op === 0x04 && this.macroActions[a]) {
          const start = b * MACRO_ACTIONS_PER_PAGE * 4;
          req.slice(4, 4 + MACRO_ACTIONS_PER_PAGE * 4).forEach((v, i) => { this.macroActions[a][start + i] = v; });
          return set(req);
        }
        break;
    }
    return set([f, op, a, b]);
  }

  private axisRow(type: number, row: number): number[] {
    this.travelTicker?.(performance.now());
    return Array.from({ length: 15 }, (_, col) => {
      const key = keyAt(row, col);
      if (!key) return 0;
      const s = this.live.get(key.id);
      const route = s ? Math.round(mmToUm(s.travel)) : 0;
      switch (type) {
        case 0: return (row === 3 ? ROW3_ADC[col] : 2600 + ((row * 37 + col * 53) % 240)) + Math.round(route * 0.45);
        case 1: return route;
        case 2: {
          const pos = posKey(key.row, key.col);
          if (this.calibrating && route > 3000) { this.newlyCalibrated.add(pos); return 2; }
          return this.profiles[this.active].perf.get(pos)?.[16] === 0 ? 0 : 1;
        }
        case 3: return s?.pressed ? 1 : 0;
        default: return 0;
      }
    });
  }

  /**
   * 05 03 is also the live framebuffer: custom LEDs return their colour, the others a stand-in motion pattern
   * (demo only). Depends on Date.now() and on the demo keys currently pressed (simulatePress), which the reactive modes show.
   */
  /** Demo key presses for the reactive stand-ins: a press starts when a key is first seen pressed; kept 3 s. */
  private ledHeld = new Set<number>();
  private ledPressLog: { id: number; t0: number }[] = [];
  private ledPresses(now: number): { cell: number; age: number }[] {
    const held = new Set<number>();
    for (const [id, s] of this.live) {
      if (!s.pressed) continue;
      held.add(id);
      if (!this.ledHeld.has(id)) this.ledPressLog.push({ id, t0: now });
    }
    this.ledHeld = held;
    this.ledPressLog = this.ledPressLog.filter((p) => now - p.t0 <= 3).slice(-16);
    return this.ledPressLog.flatMap((p) => {
      const key = PHYSICAL_KEYS[p.id];
      return key ? [{ cell: key.row * LED_MATRIX_COLS + key.col, age: now - p.t0 }] : [];
    });
  }

  private ledPacket(prof: MockProfile, area: number, packet: number): number[] {
    const leds = prof.leds[area] ?? [];
    const [open, mode, brightness, speed, direction, paletteIndex] = prof.lightBase[area] ?? [0, 0, 0, 50, 0, 0];
    const pal = paletteIndex > 0 ? (prof.palette[area] ?? []).slice(paletteIndex * 4, paletteIndex * 4 + 3) : null; // B, G, R
    const now = Date.now() / 1000;
    const frame = open ? makeLedFrame(area, mode, speed, direction, !pal, now, this.ledPresses(now)) : null;
    const out: number[] = [];
    for (let i = 0; i < LED_RECORDS_PER_PACKET; i++) {
      const idx = packet * LED_RECORDS_PER_PACKET + i;
      const rec = leds[idx];
      if (!rec) { out.push(0, 0, 0, 0); continue; }
      if (rec[3] === 0xff) { out.push(...rec); continue; }
      if (!frame) { out.push(0, 0, 0, 0); continue; }
      const { hue, lvl } = frame(idx);
      const k = brightness / 100 * lvl;
      if (pal) {
        out.push(...[0, 1, 2].map((n) => Math.round((pal[n] ?? 0) * k)), 0);
      } else {
        const h = frac(hue) * 6;
        const ch = (n: number) => Math.round(255 * k * Math.max(0, Math.min(1, Math.abs(((h + n) % 6) - 3) - 1)));
        out.push(ch(4), ch(2), ch(0), 0); // B, G, R
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- demo LED patterns (stand-ins, see ledPacket)
const frac = (v: number) => v - Math.floor(v);

/** Fixed hash of (n, salt) to 0…1. */
function hash01(n: number, salt = 0): number {
  let h = Math.imul(n | 0, 0x85ebca6b) ^ Math.imul(salt + 1, 0x9e3779b1);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const STRIP_POS = new Map(STRIP_ORDER.map((led, i) => [led, i / LED_STRIP_COUNT]));
/** A demo key press as the reactive stand-ins see it: the LED cell and the age in seconds. */
interface LedPress { cell: number; age: number }

/**
 * The pattern of one area at one instant: LED index → hue (cycles, rainbow source) and level (0…1, multiplies
 * the colour). Each firmware mode gets the stand-in that looks like what the board does (recorded on a real AE64 Max;
 * the UI number is mode + 1). Keys: 0 static, 1 horizontal wave, 2 vertical wave, 3 ripple, 4 spiral, 7 breathing,
 * 9 colour wipe, 10 arc wave, 11 sine line, 12 random steady, 13 twinkle, 14 starlight, 15 raindrop, 16 reactive key,
 * 17 reactive key + neighbours, 18 reactive row; 5, 6, 8 and anything above 18 are unknown and get a neutral dim
 * static. Strip: 0 static, 1 chase, 2 breathing, 3 mirrored wave from the top centre, 4 mirrored chase.
 * Reactive modes are dark until a demo key is pressed (presses).
 */
function makeLedFrame(area: number, mode: number, speed: number, direction: number, rainbow: boolean, now: number, presses: LedPress[] = []) {
  const T = 6 - 5.2 * speed / 100;
  const dir = direction ? -1 : 1;
  const phi = now / T;
  const wave = (p: number) => 0.15 + 0.85 * (0.5 + 0.5 * Math.cos(2 * Math.PI * p)); // palette level of a moving band
  const breath = 0.08 + 0.92 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phi));
  const fade = 0.3 + 1.2 * (1 - speed / 100);
  const live = presses.filter((p) => p.age >= 0 && p.age < fade);
  const cellXy = (cell: number) => [Math.min((cell % LED_MATRIX_COLS) / 14, 1), Math.min(Math.floor(cell / LED_MATRIX_COLS), 4) / 4];

  if (area === 1) {
    return (idx: number): { hue: number; lvl: number } => {
      const pos = STRIP_POS.get(idx) ?? 0;
      const m = Math.min(idx, LED_STRIP_COUNT - idx) / (LED_STRIP_COUNT / 2); // 0 at the top centre → 1 at the bottom centre
      switch (mode) {
        case 1: { // chase: a head runs around the edge with a tail behind it
          const d = frac(phi - dir * pos);
          return { hue: pos, lvl: Math.max(0.05, 1 - d / 0.3) };
        }
        case 2: return { hue: rainbow ? Math.floor(phi) * 0.2 : 0, lvl: breath };
        case 3: { const p = m - dir * phi; return { hue: p, lvl: rainbow ? 1 : wave(p) }; }
        case 4: { const f = frac(3 * m - dir * phi); return { hue: m, lvl: f < 0.3 ? 1 : 0.04 }; }
        default: return { hue: pos, lvl: 1 };
      }
    };
  }

  return (idx: number): { hue: number; lvl: number } => {
    const [x, y] = cellXy(idx);
    const kx = (x - 0.5) * 14, ky = (y - 0.5) * 4; // key units from the centre
    switch (mode) {
      case 0: return { hue: x, lvl: 1 };
      case 1: { const p = x - dir * phi; return { hue: p, lvl: rainbow ? 1 : wave(p) }; }
      case 2: { const p = y - dir * phi; return { hue: p, lvl: rainbow ? 1 : wave(p) }; }
      case 3: {
        const d = Math.hypot(x - 0.5, y - 0.5);
        return { hue: d - dir * phi, lvl: rainbow ? 1 : 0.1 + 0.9 * Math.max(0, Math.cos(2 * Math.PI * (2 * d - dir * phi))) };
      }
      case 4: { // pinwheel: three arms turning around the centre
        const ang = Math.atan2(ky, kx) / (2 * Math.PI);
        const p = 3 * ang - dir * phi;
        return { hue: ang - dir * phi, lvl: rainbow ? 0.25 + 0.75 * (0.5 + 0.5 * Math.cos(2 * Math.PI * p)) : 0.05 + 0.95 * Math.max(0, Math.cos(2 * Math.PI * p)) };
      }
      case 7: return { hue: x + 0.17 * Math.floor(phi), lvl: breath };
      case 9: { // colour wipe: the next colour fills from the left over the previous one
        const c = phi / 2;
        const step = Math.floor(c);
        const filled = (dir > 0 ? x : 1 - x) <= Math.min(1, frac(c) * 1.2);
        return { hue: (filled ? step : step - 1) * 0.23, lvl: filled ? 1 : 0.3 };
      }
      case 10: { const p = x + 0.5 * (2 * (y - 0.5)) ** 2 * 0.4 - dir * phi; return { hue: p, lvl: rainbow ? 1 : wave(p) }; }
      case 11: { // a thin wavy line across a dark board
        const yc = 0.5 + 0.38 * Math.sin(2 * Math.PI * (x * 1.3 - dir * phi));
        return { hue: x - dir * phi, lvl: Math.max(0, 1 - Math.abs(y - yc) / 0.2) };
      }
      case 12: { // each key a random colour, changing slowly
        const s = Math.floor(phi * 0.4 + hash01(idx, 7));
        return { hue: hash01(idx, s), lvl: 0.5 + 0.5 * hash01(idx, s + 100) };
      }
      case 13: { // many keys fade in and out in random colours
        const q = phi * 0.8 + hash01(idx);
        const s = frac(q);
        return { hue: hash01(idx, Math.floor(q) + 1), lvl: s < 0.7 ? Math.sin(Math.PI * s / 0.7) : 0 };
      }
      case 14: { // a few keys flash briefly
        const q = phi * 1.2 + hash01(idx);
        const s = frac(q);
        return { hue: hash01(idx, Math.floor(q) + 1), lvl: s < 0.07 && hash01(idx, Math.floor(q) + 9) < 0.7 ? 1 - s / 0.07 : 0 };
      }
      case 15: { // one soft blob at a random place that fades
        const c = phi * 0.5;
        const n = Math.floor(c);
        const age = frac(c);
        const px = (hash01(n, 3) - 0.5) * 14, py = (hash01(n, 4) - 0.5) * 4;
        const d = Math.hypot(kx - px, (ky - py) * 1.5);
        return { hue: hash01(n, 5), lvl: Math.max(0, 1 - d / 2.4) * (1 - age) };
      }
      case 16: case 17: case 18: { // reactive: key / key + neighbours / row
        const row = Math.floor(idx / LED_MATRIX_COLS), col = idx % LED_MATRIX_COLS;
        let lvl = 0;
        for (const p of live) {
          const pr = Math.floor(p.cell / LED_MATRIX_COLS), pc = p.cell % LED_MATRIX_COLS;
          const k = 1 - p.age / fade;
          if (p.cell === idx) lvl = Math.max(lvl, k);
          else if (mode === 17 && Math.abs(pr - row) <= 1 && Math.abs(pc - col) <= 1) lvl = Math.max(lvl, k * 0.5);
          else if (mode === 18 && pr === row) lvl = Math.max(lvl, k);
        }
        return { hue: x, lvl };
      }
      default: return { hue: x, lvl: 0.45 }; // unknown modes: neutral
    }
  };
}

export function createMockTransport(opts?: { seed?: 'max' | 'pro' }): MockTransport {
  return new MockTransport({ seed: opts?.seed });
}
