// Layout choice of the selection bar (DESIGN B §3.3), kept apart from the DOM measuring so it can be tested without layout.
// The bar takes the first layout that fits its own width, compared with natural (unclipped) widths:
//   1  sb--hint                one row, the how-to-select line shown inline and the (i) hidden
//   2  (no class)              one row, the line in the (i) next to the count
//   3  sb--compact             one row, the lead's .sb__opt parts dropped (they are in the (i) too)
//   4  sb--compact sb--stack   the keycap legend on a second row under the count
// A page's detail (slot) never moves rows on a key click: it stops at 3 and shortens with an ellipsis instead.

export interface FitInput {
  /** .sb clientWidth */
  bar: number;
  /** .sb__lead offsetWidth with the .sb__opt parts and the (i) */
  lead: number;
  /** .sb__lead offsetWidth with sb--compact */
  leadCompact: number;
  /** the (i) offsetWidth + its 4px gap */
  tip: number;
  /** scrollWidth of .sb__shows or .sb__detail (0 when neither) */
  middle: number;
  /** scrollWidth of .sb__hint while shown */
  hint: number;
  /** .sb__actions offsetWidth */
  actions: number;
  /** the gap between parts (--s-3, 12px) */
  gap: number;
  /** the middle part is the page's detail slot */
  detail: boolean;
}

export type Fit = 1 | 2 | 3 | 4;

export function pickFit(m: FitInput): Fit {
  const row = (lead: number) => lead + m.gap + 1 + m.gap + m.middle + m.gap + m.actions; // 1 = the divider
  if (row(m.lead - m.tip) + m.gap + m.hint <= m.bar) return 1;
  if (row(m.lead) <= m.bar) return 2;
  if (row(m.leadCompact) <= m.bar || m.detail) return 3;
  return 4;
}

export const FIT_CLASSES: Record<Fit, string[]> = { 1: ['sb--hint'], 2: [], 3: ['sb--compact'], 4: ['sb--compact', 'sb--stack'] };
