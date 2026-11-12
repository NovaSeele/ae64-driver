// Edge strip geometry, shared by the Lighting page and the demo transport so both walk the strip in the same order.
// LED indices run clockwise from the top edge's middle: 0..1 top right, 2..6 right, 7..20 bottom
// (right to left), 21..26 left, 27..37 top left. Drawn clockwise from the top-left corner so each
// edge is one contiguous group.
export const STRIP_SIDES = {
  top: [27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 0, 1],
  right: [2, 3, 4, 5, 6],
  bottom: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
  left: [21, 22, 23, 24, 25, 26],
};
export const STRIP_ORDER = [...STRIP_SIDES.top, ...STRIP_SIDES.right, ...STRIP_SIDES.bottom, ...STRIP_SIDES.left];

export type StripSide = keyof typeof STRIP_SIDES;
export interface StripRingLed {
  index: number;
  side: StripSide;
  /** Progress 0…1 along the side in drawing order (clockwise): the middle of the LED's slot among its side's LEDs. */
  t: number;
}

/**
 * The 38 LEDs as drawn around the keyboard frame, clockwise from the top-left corner: top left → right, right top → bottom,
 * bottom right → left, left bottom → top. `t` runs in that drawing direction, so the bottom edge's x is 1 − t and the left
 * edge's y is 1 − t.
 */
export function stripRing(): StripRingLed[] {
  return (['top', 'right', 'bottom', 'left'] as const).flatMap((side) =>
    STRIP_SIDES[side].map((index, i) => ({ index, side, t: (i + 0.5) / STRIP_SIDES[side].length })),
  );
}
