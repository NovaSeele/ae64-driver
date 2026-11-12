// Layout choice of the selection bar (DESIGN B §3.3), kept apart from the DOM measuring so it can be tested without layout.
// The bar takes the first layout that fits its own width, compared with natural (unclipped) widths:
//   1  sb--hint                one row, the how-to-select line shown inline and the (i) hidden
//   2  (no class)              one row, the line in the (i) next to the count
//   3  sb--compact             one row, the lead's .sb__opt parts dropped (they are in the (i) too)
//   4  sb--compact sb--stack   the keycap legend (or the page's detail) on a second row under the count
// One row or two is decided first, and only by what does not change while the user works: the widest lead the page can
// show ("all 64 keys", not the current count) and the widest legend it can switch to (every chip, layer, colour source).
// So selecting keys, arming a gamepad output, changing the chip or opening a detail never moves the cards below. On one
// row, a page's detail that is too long shortens with an ellipsis (it has a title).

export interface FitInput {
  /** .sb clientWidth */
  bar: number;
  /** .sb__lead offsetWidth with the .sb__opt parts and the (i) */
  lead: number;
  /** .sb__lead offsetWidth with sb--compact */
  leadCompact: number;
  /** the widest compact lead the page can show, with the (i) (measured in the ghost) */
  leadMax: number;
  /** the (i) offsetWidth + its 4px gap */
  tip: number;
  /** natural width of the legend shown (0 when none) */
  legend: number;
  /** natural width of the widest legend the page can switch to, the one shown included (0 when none) */
  legendMax: number;
  /** natural width of the page's detail (0 when none); it takes the legend's place */
  detail: number;
  /** scrollWidth of .sb__hint while shown */
  hint: number;
  /** .sb__actions offsetWidth */
  actions: number;
  /** the gap between parts (--s-3, 12px) */
  gap: number;
}

export type Fit = 1 | 2 | 3 | 4;

export function pickFit(m: FitInput): Fit {
  // lead · divider · middle · actions (no divider without a middle)
  const row = (lead: number, middle: number) => lead + (middle ? m.gap + 1 + m.gap + middle : 0) + m.gap + m.actions;
  if (m.legendMax && row(Math.max(m.leadMax, m.leadCompact), m.legendMax) > m.bar) return 4;
  const middle = m.detail || m.legend;
  if (row(m.lead - m.tip, middle) + m.gap + m.hint <= m.bar) return 1;
  if (row(m.lead, middle) <= m.bar) return 2;
  return 3;
}

export const FIT_CLASSES: Record<Fit, string[]> = { 1: ['sb--hint'], 2: [], 3: ['sb--compact'], 4: ['sb--compact', 'sb--stack'] };
