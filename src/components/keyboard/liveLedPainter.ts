// Live LED preview painter (LED60): the Lighting page shows up to ~70 keyboard frames a second. Going through Vue's
// render for that redrew all 64 keycaps, the 38 ring LEDs and the 4 bands every frame (~470 ms of main thread a second
// at 60 Hz). This writes the colours straight onto elements and properties Vue never binds, and only where something
// changed since the last paint:
// - a key: class `cap__face--live` and an inline background, border-color and box-shadow on its `.cap__face` (static
//   class, no style binding while live). The values are Keycap's `.cap--glow` rules (DESIGN A §3.1) with the LED's
//   colour and level filled in, for the key's state (hover, selected, focused, flashing): faceStyle() below. Not through
//   CSS variables: a variable set on the face is inherited by everything inside it, which doubled the style work.
// - a ring LED: `--led-color` on its `.led__dot` (no bindings).
// - a band: `--band` on the page's live band of that side (no style binding), rebuilt only when an LED of the side changed.
// A key's state can change between frames (the pointer, focus, selection, a flash): invalidate() repaints every key on
// the next paint. clear() takes every hand-written value off again, so Vue's colours from the settings show.
import { bandGradient, ledGlowRgb } from '../../ledGlow';
import type { LedGlow, RingSide } from '../../ledGlow';
import { LED_MATRIX_COLS } from '../../protocol';
import { stripRing } from '../../protocol/ledLayout';
import type { PhysicalKey } from '../../protocol';
import type { LiveLedFrame } from '../../stores/lighting';

export const LIVE_FACE_CLASS = 'cap__face--live';
const SIDES: RingSide[] = ['top', 'right', 'bottom', 'left'];
const FACE_PROPS = ['background', 'border-color', 'box-shadow'] as const;
const hex2 = (v: number) => v.toString(16).padStart(2, '0');

/** The ring dot of a lit LED: the normalised colour, never under 35 % cover; an LED that is off shows its raw colour. */
export function liveDotColor(r: number, g: number, b: number, glow: LedGlow | undefined): string {
  return glow ? `color-mix(in srgb, ${glow.led} ${Math.max(35, Math.round(glow.level * 1000) / 10)}%, transparent)` : `#${hex2(r)}${hex2(g)}${hex2(b)}`;
}

export interface FaceState {
  hover: boolean;
  selected: boolean;
  /** the key's button shows keyboard focus (:focus-visible) */
  focus: boolean;
  /** a dropped write flashes the key */
  flash: boolean;
}

/**
 * A lit face's background, border-color and box-shadow: Keycap.vue's `.cap.cap--glow` variables and face rules and
 * KeyboardView.vue's focus rules, with var(--led) and var(--led-level) filled in. A test keeps them in step.
 */
export function faceStyle(glow: LedGlow, s: FaceState): { background: string; borderColor: string; boxShadow: string } {
  const led = glow.led;
  const lv = String(glow.level);
  const top = `calc(var(--led-tint-top) * ${lv})`;
  const bottom = `calc(var(--led-tint-bottom) * ${lv})`;
  const edge = `color-mix(in srgb, ${led} calc(65% * ${lv}), transparent)`;
  const inner = `inset 0 -10px 18px -6px color-mix(in srgb, ${led} calc(30% * ${lv}), transparent)`;
  const halo = `0 0 12px -2px color-mix(in srgb, ${led} calc(50% * ${lv}), transparent)`;
  const ring = '0 0 0 1px var(--bg-1), 0 0 0 3px var(--acc)';
  const capTop = s.hover ? 'var(--cap-hover-top)' : 'var(--cap-top)';
  const capBottom = s.hover ? 'var(--cap-hover-bottom)' : 'var(--cap-bottom)';
  const background = `linear-gradient(180deg, color-mix(in srgb, ${led} ${top}, ${capTop}), color-mix(in srgb, ${led} ${bottom}, ${capBottom}))`;
  // the cascade of those rules: glow < hover < selected < flash, and KeyboardView's focus rules win the shadow
  let borderColor = s.hover ? `color-mix(in srgb, ${led} calc(80% * ${lv}), var(--line-2))` : edge;
  if (s.selected) borderColor = edge;
  if (s.flash) borderColor = 'var(--danger)';
  let boxShadow = s.selected ? `${ring}, ${inner}, ${halo}` : `${inner}, ${halo}`;
  if (s.flash) boxShadow = '0 0 0 2px var(--danger)';
  if (s.focus) boxShadow = s.selected ? `${ring}, ${inner}` : `${inner}, ${halo}`;
  return { background, borderColor, boxShadow };
}

export class LiveLedPainter {
  /** Style writes made so far (one per key, LED or band repainted); for tests and measuring. */
  writes = 0;
  /** A key's state may have changed: every key is checked again on the next paint. */
  dirty = false;
  private readonly ring = stripRing();
  private readonly sideLeds = new Map(SIDES.map((s) => [s, this.ring.filter((l) => l.side === s)]));
  private readonly face = new Map<number, HTMLElement>();
  private readonly keyLast = new Map<number, number>();
  /** the state bits each key was last painted with; looked up again only after invalidate() */
  private readonly keyState = new Map<number, number>();
  private readonly dot = new Map<number, HTMLElement>();
  private readonly ledLast = new Map<number, number>();
  private readonly ledGlow = new Map<number, LedGlow | undefined>();
  private readonly band = new Map<RingSide, HTMLElement>();
  private readonly touched = new Set<HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  invalidate(): void {
    this.dirty = true;
  }

  /** An element still in the page, or a fresh lookup (null when not rendered); `fresh` = looked up again. */
  private lookup<K>(cache: Map<K, HTMLElement>, key: K, selector: string): { el: HTMLElement | null; fresh: boolean } {
    const el = cache.get(key);
    if (el?.isConnected) return { el, fresh: false };
    const found = this.root.querySelector<HTMLElement>(selector);
    if (found) cache.set(key, found);
    else cache.delete(key);
    return { el: found, fresh: true };
  }

  paint(frame: LiveLedFrame, keys: readonly PhysicalKey[]): void {
    const recheck = this.dirty;
    this.dirty = false;
    for (const k of keys) {
      const { el, fresh } = this.lookup(this.face, k.id, `[data-key="${k.id}"] .cap__face`);
      if (!el) continue;
      const o = (k.row * LED_MATRIX_COLS + k.col) * 3;
      const r = frame.keys[o], g = frame.keys[o + 1], b = frame.keys[o + 2];
      const glow = ledGlowRgb(r, g, b);
      let bits = this.keyState.get(k.id);
      if (bits === undefined || recheck || fresh) {
        const cap = el.parentElement;
        bits = +!!cap?.matches(':hover') | (+!!cap?.classList.contains('cap--sel') << 1) |
          (+!!cap?.parentElement?.matches(':focus-visible') << 2) | (+!!cap?.classList.contains('cap--flash') << 3);
        this.keyState.set(k.id, bits);
      }
      // colour and state in one number: a key is written only when either changed (an unlit key ignores its state)
      const packed = ((r << 16) | (g << 8) | b) * 16 + (glow ? bits : 0);
      if (!fresh && this.keyLast.get(k.id) === packed) continue;
      this.keyLast.set(k.id, packed);
      if (glow) {
        const st = faceStyle(glow, { hover: !!(bits & 1), selected: !!(bits & 2), focus: !!(bits & 4), flash: !!(bits & 8) });
        el.classList.add(LIVE_FACE_CLASS);
        el.style.setProperty('background', st.background);
        el.style.setProperty('border-color', st.borderColor);
        el.style.setProperty('box-shadow', st.boxShadow);
      } else {
        el.classList.remove(LIVE_FACE_CLASS);
        for (const p of FACE_PROPS) el.style.removeProperty(p);
      }
      this.touched.add(el);
      this.writes++;
    }

    const dirty = new Set<RingSide>();
    for (const side of SIDES) if (this.lookup(this.band, side, `.ring__band--live.ring__band--${side}`).fresh) dirty.add(side);
    for (const led of this.ring) {
      const { el, fresh } = this.lookup(this.dot, led.index, `[data-led="${led.index}"] .led__dot`);
      if (!el) continue;
      const o = led.index * 3;
      const r = frame.strip[o], g = frame.strip[o + 1], b = frame.strip[o + 2];
      const packed = (r << 16) | (g << 8) | b;
      if (!fresh && this.ledLast.get(led.index) === packed) continue;
      this.ledLast.set(led.index, packed);
      const glow = ledGlowRgb(r, g, b);
      this.ledGlow.set(led.index, glow);
      el.style.setProperty('--led-color', liveDotColor(r, g, b, glow));
      this.touched.add(el);
      this.writes++;
      dirty.add(led.side);
    }
    for (const side of dirty) {
      const el = this.band.get(side);
      if (!el?.isConnected) continue;
      const bg = bandGradient(side, this.sideLeds.get(side)!.map((l) => ({ pos: l.t, glow: this.ledGlow.get(l.index) })));
      el.style.setProperty('--band', bg ?? 'none');
      this.touched.add(el);
      this.writes++;
    }
  }

  /** Every hand-written value off: the colours from the settings (Vue's) show again. */
  clear(): void {
    for (const el of this.touched) {
      el.classList.remove(LIVE_FACE_CLASS);
      for (const p of [...FACE_PROPS, '--led-color', '--band']) el.style.removeProperty(p);
    }
    this.touched.clear();
    this.keyLast.clear();
    this.keyState.clear();
    this.ledLast.clear();
    this.ledGlow.clear();
    this.dirty = false;
  }
}
