// The peak table renders only the rows in and near its visible part (C-PERF-1): spacer rows keep the scroll height,
// the Tab stop row is always in the page, arrow keys bring the next row in and focus it, and the real positions are
// given to screen readers (aria-rowcount / aria-rowindex).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import PeakTable from '../src/components/live/PeakTable.vue';
import type { CheckRow } from '../src/components/live/keyCheck';

let w: VueWrapper | null = null;
afterEach(() => {
  w?.unmount();
  w = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

/** 64 rows, deepest first: key i at 3.31 − i·0.01 mm. */
const rows = (n = 64): CheckRow[] => Array.from({ length: n }, (_, i) => {
  const mm = +(3.31 - i * 0.01).toFixed(2);
  return { id: i, name: `K${i}`, mm, ratio: mm / 3.31, kind: 'ok', bar: 'ok' };
});
async function table(list = rows()) {
  w = mount(PeakTable, { props: { rows: list, pinnedId: null, estimated: false, sinceReset: false }, attachTo: document.body });
  await flushPromises();
  return w;
}
const ids = () => w!.findAll('.pt__row').map((r) => Number(r.find('.pt__key').attributes('data-rid')));
const pads = () => w!.findAll('.pt__pad td').map((td) => parseFloat((td.element as HTMLElement).style.height));
async function scrollTo(y: number) {
  const el = w!.find('.pt__wrap').element as HTMLElement;
  el.scrollTop = y;
  el.dispatchEvent(new Event('scroll'));
  await flushPromises();
}

describe('peak table: only the visible rows are in the page (C-PERF-1)', () => {
  it('64 rows: the first ones and a spacer for the rest, same scroll height', async () => {
    await table();
    const shown = ids();
    expect(shown[0]).toBe(0);
    expect(shown.length).toBeGreaterThanOrEqual(7); // 206px of list shows 6 rows under the head, plus some kept beyond
    expect(shown.length).toBeLessThanOrEqual(14);
    expect(shown).toEqual(shown.map((_, i) => i));
    expect(pads()).toEqual([(64 - shown.length) * 28]); // rows left out keep their 28px each
    expect(w!.find('table').attributes('aria-rowcount')).toBe('65');
    expect(w!.findAll('.pt__row').map((r) => r.attributes('aria-rowindex'))).toEqual(shown.map((i) => String(i + 2)));
    expect(w!.find('.pt__pad').attributes('aria-hidden')).toBe('true');
  });

  it('scrolling down brings the rows there in; spacers above and below keep the total', async () => {
    await table();
    await scrollTo(22 + 40 * 28);
    const shown = ids();
    expect(shown).toContain(40);
    expect(shown).toContain(45);
    expect(shown).not.toContain(20);
    expect(Math.min(...shown.filter((i) => i !== 0))).toBeGreaterThan(30); // row 0 may stay: it holds the Tab stop
    expect(pads().reduce((a, b) => a + b, 0) + shown.length * 28).toBe(64 * 28);
  });

  it('the row holding the Tab stop stays in the page when the list scrolls away from it', async () => {
    await table();
    expect(w!.find('[tabindex="0"]').attributes('data-rid')).toBe('0');
    await scrollTo(22 + 50 * 28);
    expect(ids()).toContain(0); // Tab still reaches the table
    expect(ids()).toContain(50);
    expect(w!.find('[tabindex="0"]').attributes('data-rid')).toBe('0');
    expect(pads().reduce((a, b) => a + b, 0) + ids().length * 28).toBe(64 * 28);
  });

  it('End and ↓ bring the next row in and focus it', async () => {
    await table();
    const first = w!.find('[data-rid="0"]').element as HTMLElement;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    await flushPromises();
    const last = w!.find('[data-rid="63"]');
    expect(last.exists()).toBe(true);
    expect(document.activeElement).toBe(last.element);
    expect((w!.find('.pt__wrap').element as HTMLElement).scrollTop).toBe(22 + 64 * 28 - 206); // the last row at the bottom edge
    last.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    await flushPromises();
    expect(document.activeElement).toBe(w!.find('[data-rid="0"]').element);
    expect((w!.find('.pt__wrap').element as HTMLElement).scrollTop).toBe(0);
  });

  it('a short list renders every row and no spacer', async () => {
    await table(rows(5));
    expect(ids()).toEqual([0, 1, 2, 3, 4]);
    expect(w!.findAll('.pt__pad')).toHaveLength(0);
  });
});
