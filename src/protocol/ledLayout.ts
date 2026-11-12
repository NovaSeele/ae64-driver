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
