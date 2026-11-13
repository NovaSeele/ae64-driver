// Live LED preview painter (LED60): the Lighting page shows up to ~70 keyboard frames a second. Going through Vue's
// render for that redrew all 64 keycaps, the 38 ring LEDs and the 4 bands every frame (~470 ms of main thread a second
// at 60 Hz). This writes the colours straight onto elements and properties Vue never binds, and only where something
// changed since the last paint:
// - a key: Keycap's `.cap--glow` look (DESIGN A §3.1) as two composited layers of the plain LED colour (`.cap__ledc`)
//   in the face, each under a static mask drawn at level 1: `.cap__tint` the background's tint (tintMask()), `.cap__lit`
//   the edge, the inner glow and the halo (litMask()). A frame writes only the colour
//   and the level, as the opacity of both, so the GPU composites a new colour or level instead of re-rastering blurs,
//   gradients and legends (re-rastering 64 faces a frame kept it busy ~1000 ms/s and dropped a 100 Hz screen to 50 fps),
//   and no level ever needs a new mask. The face gets class `cap__face--live` and, only when the key's state changes,
//   its static background, border and shadow inline, and `.cap__ring` the selection ring (faceLook()).
// - a ring LED: `--led-color` on its `.led__dot` (no bindings).
// - a band: `--band` on the page's live band of that side (no style binding), rebuilt only when an LED of the side changed.
// A key's state can change between frames (the pointer, focus, selection, a flash): invalidate() repaints every key on
// the next paint; resized() measures the keys again (size, theme). clear() takes every hand-written value off again, so
// Vue's colours from the settings show.
import { bandGradient, ledGlowRgb } from '../../ledGlow';
import type { LedGlow, RingSide } from '../../ledGlow';
import { LED_MATRIX_COLS } from '../../protocol';
import { stripRing } from '../../protocol/ledLayout';
import type { PhysicalKey } from '../../protocol';
import type { LiveLedFrame } from '../../stores/lighting';

export const LIVE_FACE_CLASS = 'cap__face--live';
const SIDES: RingSide[] = ['top', 'right', 'bottom', 'left'];
const FACE_PROPS = ['background', 'border-color', 'box-shadow'] as const;
const LIT_PROPS = ['background-color', 'opacity', 'mask-image', 'left', 'top', 'width', 'height'] as const;
/** How far .cap__lit and .cap__tint reach past the face's border box (for the halo; Keycap's inset: -19px = this + the border). */
export const LIT_MARGIN = 18;
/** Keycap's --led-inner: inset 0 -10px 18px -6px */
const INNER = { y: -10, blur: 18, spread: -6 } as const;
/** Keycap's --led-halo: 0 0 12px -2px */
const HALO = { blur: 12, spread: -2 } as const;
const SELECTION_RING = '0 0 0 1px var(--bg-1), 0 0 0 3px var(--acc)';
const hex2 = (v: number) => v.toString(16).padStart(2, '0');
const op = (v: number) => String(Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000);

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

/** A live-lit face in one state: its own static look, and the share of each part of the LED's light (x its level). */
export interface FaceLook {
  /** the face's own background, border colour and box-shadow, without the LED */
  background: string;
  borderColor: string;
  boxShadow: string;
  /** .cap__ring shows the selection ring */
  ring: boolean;
  /** the border is opaque (hover, flash): the tint stays inside it, as the background does under an opaque border */
  rim: boolean;
  /** the edge's share (0.65; 0.8 over --line-2 when hovered; 0 under the danger border), the inner glow's, the halo's */
  edge: number;
  inner: number;
  halo: number;
}

/**
 * Keycap.vue's `.cap.cap--glow` face rules and KeyboardView.vue's focus rules for one state, split into the face's own
 * look and the shares of the LED's light: --led-edge 65 % (80 % over --line-2 when hovered), --led-inner 30 %,
 * --led-halo 50 %, the tint's two stops from the theme. The cascade: glow < hover < selected < flash, and the focus
 * rules win the shadow. A test keeps this in step with the rules.
 */
export function faceLook(s: FaceState): FaceLook {
  const background = s.hover
    ? 'linear-gradient(180deg, var(--cap-hover-top), var(--cap-hover-bottom))'
    : 'linear-gradient(180deg, var(--cap-top), var(--cap-bottom))';
  let borderColor = 'transparent', edge = 0.65, rim = false;
  if (s.hover && !s.selected) { borderColor = 'var(--line-2)'; edge = 0.8; rim = true; }
  if (s.flash) { borderColor = 'var(--danger)'; edge = 0; rim = true; }
  let shadow = { boxShadow: 'none', ring: s.selected, inner: 0.3, halo: 0.5 };
  if (s.flash) shadow = { boxShadow: '0 0 0 2px var(--danger)', ring: false, inner: 0, halo: 0 };
  if (s.focus) shadow = { boxShadow: 'none', ring: s.selected, inner: 0.3, halo: s.selected ? 0 : 0.5 };
  return { background, borderColor, rim, edge, ...shadow };
}

/**
 * A face's border box (CSS px, on the pixels the browser snaps it to), where it sits in its glow layers (x, y:
 * LIT_MARGIN and the fraction that puts the layers on whole device pixels), the layers' size (lw, lh), the border
 * width, the outer corner radius and the theme's tint stops (0..1).
 */
export interface LitGeometry {
  w: number;
  h: number;
  x: number;
  y: number;
  lw: number;
  lh: number;
  /** the layer's left and top in the face (from its padding box, which layout may put at a fraction of a pixel) */
  left: number;
  top: number;
  border: number;
  radius: number;
  tintTop: number;
  tintBottom: number;
}

const num = (v: number) => String(Math.round(v * 10000) / 10000);

/** An SVG image of one box at the face's place in a glow layer, styled with `style` (a mask: black, alpha = cover). */
function boxMask(g: LitGeometry, style: string[]): string {
  const css = [
    'position:absolute',
    'box-sizing:border-box',
    `left:${num(g.x)}px`,
    `top:${num(g.y)}px`,
    `width:${num(g.w)}px`,
    `height:${num(g.h)}px`,
    `border-radius:${num(g.radius)}px`,
    ...style,
  ].join(';');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${num(g.lw)}" height="${num(g.lh)}">` +
    `<foreignObject width="100%" height="100%"><div xmlns="http://www.w3.org/1999/xhtml" style="${css}"/></foreignObject></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
const black = (cover: number) => `rgba(0,0,0,${num(cover)})`;

/**
 * The mask of a live-lit key's .cap__tint layer, which covers just the face's border box (no halo): the background's
 * tint at level 1, the theme's two stops (--led-tint-top/bottom) over the padding box and repeated into the border as
 * the background is, or kept inside an opaque border (hover, flash) as the background is under one.
 */
export function tintMask(g: LitGeometry, look: FaceLook): string {
  return boxMask({ ...g, x: 0, y: 0, lw: g.w, lh: g.h }, [
    `border:${num(g.border)}px solid transparent`,
    `background:linear-gradient(180deg,${black(g.tintTop)},${black(g.tintBottom)})`,
    ...(look.rim ? ['background-clip:padding-box'] : []),
  ]);
}

/**
 * The mask of a live-lit key's .cap__lit layer: the edge, the inner glow and the halo of the glow rules in black at
 * level 1, each colour's alpha the part's share, on a box at the face's place in the layer. Drawn by the browser from
 * the same CSS as the rules (an SVG image holding that box), so blurs and rounded edges come out as the face's own do.
 * The three parts do not overlap (the inner glow is inside the padding box, the edge on the border, the halo outside
 * the border box), so the layer at opacity `level` is each part at its share x the level, as in the rules:
 * - the edge: the border at its share (65 %, 80 % when hovered; none under the danger border);
 * - the inner glow `inset 0 -10px 18px -6px` at 30 % and the halo `0 0 12px -2px` at 50 % (outside the box only).
 * The tint is the other layer (.cap__tint): over the edge and the inner glow it stacks as the background does under
 * them, 1 - (1 - tint x level)(1 - part x level).
 */
export function litMask(g: LitGeometry, look: FaceLook): string {
  const a = black;
  const shadows = [
    look.inner > 0 ? `inset 0 ${INNER.y}px ${INNER.blur}px ${INNER.spread}px ${a(look.inner)}` : '',
    look.halo > 0 ? `0 0 ${HALO.blur}px ${HALO.spread}px ${a(look.halo)}` : '',
  ].filter(Boolean);
  return boxMask(g, [
    `border:${num(g.border)}px solid ${look.edge > 0 ? a(look.edge) : 'transparent'}`,
    `box-shadow:${shadows.length ? shadows.join(',') : 'none'}`,
  ]);
}

interface KeyEls {
  face: HTMLElement;
  /** the edge, inner glow and halo layer, and its colour */
  lit: HTMLElement | null;
  fill: HTMLElement | null;
  /** the tint layer, and its colour */
  tint: HTMLElement | null;
  tintFill: HTMLElement | null;
  ring: HTMLElement | null;
  geo?: LitGeometry;
  /** measured again or looked up again since the masks were last checked */
  stale?: boolean;
  /** the size and state the masks were made for */
  maskShape?: string;
  tintShape?: string;
  /** the colour and opacity on the colour layers (a rainbow changes only the colour, a breathing effect the level) */
  led?: string;
  opacity?: string;
}

export class LiveLedPainter {
  /** Style writes made so far (one per key, LED or band repainted); for tests and measuring. */
  writes = 0;
  /** Masks made so far; for tests and measuring. */
  masksMade = 0;
  /** A key's state may have changed: every key is checked again on the next paint. */
  dirty = false;
  private sized = false;
  /** where the board was at the last measure: the masks follow the keys' pixels, so a move measures again */
  private rootBox = '';
  private readonly ring = stripRing();
  private readonly sideLeds = new Map(SIDES.map((s) => [s, this.ring.filter((l) => l.side === s)]));
  private readonly faceEl = new Map<number, HTMLElement>();
  private readonly els = new Map<number, KeyEls>();
  private readonly keyLast = new Map<number, number>();
  /** the state bits each key was last looked up with (again only after invalidate()) */
  private readonly keyState = new Map<number, number>();
  /** the state bits each lit face's own look was last written for */
  private readonly keyLook = new Map<number, number>();
  private readonly maskUrls = new Map<string, string>();
  private readonly dot = new Map<number, HTMLElement>();
  private readonly ledLast = new Map<number, number>();
  private readonly ledGlow = new Map<number, LedGlow | undefined>();
  private readonly band = new Map<RingSide, HTMLElement>();
  private readonly touched = new Set<HTMLElement>();

  constructor(private readonly root: HTMLElement) {}

  invalidate(): void {
    this.dirty = true;
  }

  /** The keys may have changed size or place (a paint notices a moved or resized board itself) or the theme its tint:
   *  they are measured again and get new masks on the next paint. */
  resized(): void {
    this.sized = false;
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

  /**
   * A key's size, place, border, radius and tint stops (layout is read here: before any write of this paint). The face
   * is drawn on whole device pixels (the browser snaps a box's edges to the nearest pixel), so the mask uses those
   * edges, and the .cap__lit layer sits on whole pixels too: a mask at a fractional offset is resampled, which blurred
   * the 1px edge.
   */
  private measure(k: KeyEls): void {
    const box = k.face.getBoundingClientRect();
    if (!box.width || !box.height) return;
    const cs = getComputedStyle(k.face);
    const pct = (name: string) => (parseFloat(cs.getPropertyValue(name)) || 0) / 100;
    const dpr = typeof devicePixelRatio === 'number' && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const m = LIT_MARGIN;
    const snap = (v: number) => Math.round(v * dpr) / dpr;
    const fl = snap(box.left), ft = snap(box.top), fw = snap(box.right) - fl, fh = snap(box.bottom) - ft;
    const left = Math.floor((fl - m) * dpr) / dpr, top = Math.floor((ft - m) * dpr) / dpr;
    const border = parseFloat(cs.borderTopWidth) || 0;
    k.geo = {
      w: fw,
      h: fh,
      x: fl - left,
      y: ft - top,
      left: left - box.left - border,
      top: top - box.top - border,
      lw: Math.ceil((fl + fw + m) * dpr) / dpr - left,
      lh: Math.ceil((ft + fh + m) * dpr) / dpr - top,
      border,
      radius: parseFloat(cs.borderTopLeftRadius) || 0,
      tintTop: pct('--led-tint-top'),
      tintBottom: pct('--led-tint-bottom'),
    };
    k.stale = true;
  }

  private maskUrl(key: string, make: () => string): string {
    let url = this.maskUrls.get(key);
    if (url === undefined) {
      if (this.maskUrls.size > 400) this.maskUrls.clear();
      url = make();
      this.maskUrls.set(key, url);
      this.masksMade++;
    }
    return url;
  }

  paint(frame: LiveLedFrame, keys: readonly PhysicalKey[]): void {
    const at = this.root.getBoundingClientRect();
    const box = `${at.left},${at.top},${at.width},${at.height}`;
    if (box !== this.rootBox) {
      this.rootBox = box;
      this.resized();
    }
    const recheck = this.dirty;
    this.dirty = false;
    // look every face up (and measure, when sizes may have changed) before writing anything
    const fresh = new Set<number>();
    for (const k of keys) {
      const found = this.lookup(this.faceEl, k.id, `[data-key="${k.id}"] .cap__face`);
      if (!found.el) continue;
      if (found.fresh) {
        fresh.add(k.id);
        const face = found.el;
        const layer = (cls: string) => face.querySelector<HTMLElement>(`:scope > .${cls}`);
        const colour = (el: HTMLElement | null) => el?.querySelector<HTMLElement>(':scope > .cap__ledc') ?? null;
        const lit = layer('cap__lit'), tint = layer('cap__tint');
        this.els.set(k.id, { face, lit, fill: colour(lit), tint, tintFill: colour(tint), ring: layer('cap__ring') });
      }
      if (found.fresh || !this.sized) this.measure(this.els.get(k.id)!);
    }
    if (!this.sized) this.keyLast.clear(); // every key again, with masks for the new size
    this.sized = true;

    for (const k of keys) {
      const els = this.els.get(k.id);
      const el = els?.face;
      if (!els || !el?.isConnected) continue;
      const o = (k.row * LED_MATRIX_COLS + k.col) * 3;
      const r = frame.keys[o], g = frame.keys[o + 1], b = frame.keys[o + 2];
      const glow = ledGlowRgb(r, g, b);
      const isFresh = fresh.has(k.id);
      let bits = this.keyState.get(k.id);
      if (bits === undefined || recheck || isFresh) {
        const cap = el.parentElement;
        bits = +!!cap?.matches(':hover') | (+!!cap?.classList.contains('cap--sel') << 1) |
          (+!!cap?.parentElement?.matches(':focus-visible') << 2) | (+!!cap?.classList.contains('cap--flash') << 3);
        this.keyState.set(k.id, bits);
      }
      // colour and state in one number: a key is written only when either changed (an unlit key ignores its state)
      const packed = ((r << 16) | (g << 8) | b) * 16 + (glow ? bits : 0);
      if (!isFresh && this.keyLast.get(k.id) === packed) continue;
      this.keyLast.set(k.id, packed);
      // a lit key's look and masks are checked only for a new state, size or element, never for a frame
      const newState = isFresh || this.keyLook.get(k.id) !== bits;
      if (glow && (newState || els.stale)) {
        const look = faceLook({ hover: !!(bits & 1), selected: !!(bits & 2), focus: !!(bits & 4), flash: !!(bits & 8) });
        // the face's own look changes only with the state: the layers carry the colour
        if (newState) {
          this.keyLook.set(k.id, bits);
          if (!el.classList.contains(LIVE_FACE_CLASS)) el.classList.add(LIVE_FACE_CLASS);
          el.style.setProperty('background', look.background);
          el.style.setProperty('border-color', look.borderColor);
          el.style.setProperty('box-shadow', look.boxShadow);
          if (els.ring) {
            els.ring.style.setProperty('box-shadow', look.ring ? SELECTION_RING : 'none');
            this.touched.add(els.ring);
          }
        }
        // the masks: new ones only for a new size, state or theme, never for a level
        if (els.geo) {
          const geo = els.geo;
          const mask = (layer: HTMLElement | null, last: string | undefined, key: string, at: number[], make: () => string) => {
            const place = `@${at.join(',')}`;
            if (!layer || last === key + place) return last;
            // the layer's place and size in the face (from the padding box)
            layer.style.setProperty('left', `${at[0]}px`);
            layer.style.setProperty('top', `${at[1]}px`);
            layer.style.setProperty('width', `${at[2]}px`);
            layer.style.setProperty('height', `${at[3]}px`);
            layer.style.setProperty('mask-image', this.maskUrl(key, make));
            this.touched.add(layer);
            return key + place;
          };
          const face = `${geo.w}x${geo.h}b${geo.border}r${geo.radius}`;
          // .cap__lit reaches out for the halo, with the border box at (x, y) in it; .cap__tint is the border box
          els.maskShape = mask(els.lit, els.maskShape, `lit${face}+${geo.x},${geo.y}/${geo.lw}x${geo.lh}|${look.edge}|${look.inner}|${look.halo}`,
            [geo.left, geo.top, geo.lw, geo.lh], () => litMask(geo, look));
          els.tintShape = mask(els.tint, els.tintShape, `tint${face}t${geo.tintTop},${geo.tintBottom}|${+look.rim}`,
            [geo.left + geo.x, geo.top + geo.y, geo.w, geo.h], () => tintMask(geo, look));
        }
        els.stale = false;
      }
      if (glow) {
        // the frame's part: the colour and the level on both layers, each only when it changed
        const lv = op(glow.level);
        const newLed = isFresh || els.led !== glow.led, newLevel = isFresh || els.opacity !== lv;
        els.led = glow.led;
        els.opacity = lv;
        for (const fill of [els.fill, els.tintFill]) {
          if (!fill) continue;
          if (newLed) fill.style.setProperty('background-color', glow.led);
          if (newLevel) fill.style.setProperty('opacity', lv);
          this.touched.add(fill);
        }
      } else {
        this.keyLook.delete(k.id);
        if (el.classList.contains(LIVE_FACE_CLASS)) el.classList.remove(LIVE_FACE_CLASS);
        for (const p of FACE_PROPS) el.style.removeProperty(p);
        els.led = els.opacity = undefined;
        for (const fill of [els.fill, els.tintFill]) {
          fill?.style.removeProperty('background-color');
          fill?.style.removeProperty('opacity');
        }
      }
      this.touched.add(el);
      this.writes++;
    }

    const dirty = new Set<RingSide>();
    for (const side of SIDES) if (this.lookup(this.band, side, `.ring__band--live.ring__band--${side}`).fresh) dirty.add(side);
    for (const led of this.ring) {
      const { el, fresh: isFresh } = this.lookup(this.dot, led.index, `[data-led="${led.index}"] .led__dot`);
      if (!el) continue;
      const o = led.index * 3;
      const r = frame.strip[o], g = frame.strip[o + 1], b = frame.strip[o + 2];
      const packed = (r << 16) | (g << 8) | b;
      if (!isFresh && this.ledLast.get(led.index) === packed) continue;
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
      if (el.classList.contains(LIVE_FACE_CLASS)) el.classList.remove(LIVE_FACE_CLASS);
      for (const p of [...FACE_PROPS, ...LIT_PROPS, '--led-color', '--band']) el.style.removeProperty(p);
    }
    this.touched.clear();
    this.keyLast.clear();
    this.keyState.clear();
    this.keyLook.clear();
    for (const k of this.els.values()) k.maskShape = k.tintShape = k.led = k.opacity = undefined;
    this.ledLast.clear();
    this.ledGlow.clear();
    this.dirty = false;
    this.sized = false;
    this.rootBox = '';
  }
}
