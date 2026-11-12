/**
 * Height cap of the "Đã cấu hình" card in the two-column layout: the card stops `gap` px above the bottom of the
 * page's scroller, so its list box can always scroll the last entry into view without the page scrolling.
 * `top` is the card's top in the scroller's content coordinates; `floor` keeps the list usable on short windows.
 */
export function cardCap(clientHeight: number, top: number, floor = 240, gap = 16): number {
  return Math.max(floor, clientHeight - top - gap);
}
