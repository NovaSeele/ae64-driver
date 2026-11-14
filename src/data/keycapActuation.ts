// The keycap in the Actuation view, in one place for every board that draws it (DESIGN F §3.2): the Travel tab with its
// "Actuation" chip, and the Overview page (always Actuation, depth fill always on). Pure functions of one key's record and
// the number of decimals, so both boards show exactly the same caps.
import type { Component } from 'vue';
import { IconLock } from '@tabler/icons-vue';
import { isRtMode } from '../protocol';
import type { Performance } from '../protocol';
import { actuationOf, isKnownMode, rangeMm } from '../stores/performance';
import type { LegendItem } from '../components/keyboard/SelectionBar.vue';
import { t } from '../i18n/vi';

/** Decimals of a keycap value: 3 on a board with 0.001 mm steps (Max), 2 on 0.01 mm (Pro). */
export const capDecimals = (rtPrecision: number): number => (rtPrecision < 0.01 ? 3 : 2);

/** The keycap way of writing mm: `decimals` digits, trailing zeros dropped, at least one decimal ("1.0", "0.15", "2.0"). */
export function fmtMm(v: number, decimals: number): string {
  const s = v.toFixed(decimals).replace(/0+$/, '');
  return s.endsWith('.') ? `${s}0` : s;
}

/** The value under the legend: the actuation point. */
export const actSublabel = (p: Performance, decimals: number): string => fmtMm(actuationOf(p), decimals);

/** Rapid Trigger keys carry an "RT" tag; the full numbers are in its title. */
export const actBadge = (p: Performance): string | undefined => (isRtMode(p.mode) ? 'RT' : undefined);

/** A key in a firmware mode the app does not know shows a lock (read-only). */
export const actBadgeIcon = (p: Performance): Component | undefined => (isKnownMode(p.mode) ? undefined : IconLock);

/** Title / accessible name of the badge: the lock's reason, or the RT press and release. */
export function actBadgeTitle(p: Performance, decimals: number): string | undefined {
  if (!isKnownMode(p.mode)) return t('perf.unsupportedMode');
  return actBadge(p) ? t('perf.rtTagTitle', { press: fmtMm(p.rtPress, decimals), release: fmtMm(p.rtRelease, decimals) }) : undefined;
}

/** Depth fill: how far down the switch's travel the key actuates (0..1). */
export const actFill = (p: Performance): number => actuationOf(p) / rangeMm(p);

/** The dashed "not calibrated" outline. */
export const uncalFlagFor = (uncalibrated: readonly number[], id: number): { label: string } | undefined =>
  (uncalibrated.includes(id) ? { label: t('kb.uncalibrated') } : undefined);

/**
 * The keycap legend of the Actuation view, built from the loaded records with the same tests as the caps, so an item is
 * listed exactly when a keycap shows it: Actuation (mm) · [fill] · RT · lock · dashed outline. `fill` adds the depth-fill
 * sample (Overview, where the fill is always on).
 */
export function actuationLegend(recs: readonly Performance[], uncalibrated: number, fill = false): LegendItem[] {
  const tone = 'var(--m-actuation)';
  const items: LegendItem[] = [{ text: t('perf.showsAct'), tone }];
  if (fill) items.push({ sample: 'fill', label: t('ov.fillGlyph'), tone, text: t('ov.showsFill') });
  if (recs.some((p) => isRtMode(p.mode))) items.push({ glyph: 'RT', tone: 'var(--m-press)', text: t('perf.showsRtTag') });
  if (recs.some((p) => !isKnownMode(p.mode))) items.push({ sample: 'lock', label: t('perf.showsLockedGlyph'), text: t('perf.showsLocked'), tone });
  if (uncalibrated) items.push({ sample: 'flag', label: t('sel.flaggedGlyph'), text: t('sel.flagged') });
  return items;
}
