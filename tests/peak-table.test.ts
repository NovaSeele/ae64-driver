// The peak table renders only the rows in and near its visible part (C-PERF-1): spacer rows keep the scroll height,
// the Tab stop row is always in the page, arrow keys bring the next row in and focus it, and the real positions are
// given to screen readers (aria-rowcount / aria-rowindex). Rows and chips that are kept (v-memo, the chip cache) still
// follow the pin and the language (C-TEST-2).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { toRaw } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import PeakTable from '../src/components/live/PeakTable.vue';
import HealthCheck from '../src/components/live/HealthCheck.vue';
import type { CheckIssue, CheckRow } from '../src/components/live/keyCheck';
import { locale, setLocale } from '../src/i18n/locale';

const startLocale = locale.value;

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

describe('peak table: rows that did not change still follow the pin and the language (C-TEST-2)', () => {
  afterEach(() => setLocale(startLocale));

  it('moving the pin from one key to another with the same rows: only the new row is marked (#46)', async () => {
    const list = rows(5);
    await table(list);
    await w!.setProps({ pinnedId: 1 });
    const pinned = () => w!.findAll('.pt__row').filter((r) => r.classes('pt__row--pin')).map((r) => r.find('.pt__key').attributes('data-rid'));
    const current = () => w!.findAll('.pt__row').filter((r) => r.attributes('aria-current') === 'true').map((r) => r.find('.pt__key').attributes('data-rid'));
    expect(pinned()).toEqual(['1']);
    await w!.setProps({ rows: list, pinnedId: 3 });
    expect(pinned()).toEqual(['3']);
    expect(current()).toEqual(['3']);
  });

  it('switching to English with the same rows: the hidden kind and the pin label change (#47)', async () => {
    setLocale('vi');
    const list = rows(3);
    await table(list);
    const first = () => w!.find('.pt__row .pt__key');
    expect(first().find('.pt__sr').text()).toBe(', đủ');
    expect(first().attributes('aria-label')).toBe('Ghim K0');
    setLocale('en');
    await w!.setProps({ rows: list });
    await flushPromises();
    expect(first().find('.pt__sr').text()).toBe(', full');
    expect(first().attributes('aria-label')).toBe('Pin K0');
  });
});

describe('health check: chips follow the language with the same issues (C-TEST-2 #49)', () => {
  afterEach(() => setLocale(startLocale));

  it('the chip text and its label change, the issues are the same array', async () => {
    setLocale('vi');
    const issues: CheckIssue[] = [{ id: 7, name: 'A', kind: 'short', mm: 2.6, range: 3.31 }];
    w = mount(HealthCheck, {
      props: { pressed: 1, full: 0, short: 1, stuck: 0, total: 64, issues, estimated: false, partialKey: null, pinnedId: null },
      attachTo: document.body,
    });
    await flushPromises();
    const chip = () => w!.find('.hc__chip');
    expect(chip().text()).toBe('A đạt 2.60 / 3.31 mm');
    expect(chip().attributes('aria-label')).toBe('A đạt 2.60 trên 3.31 mm, chưa đủ hành trình. Ghim phím này.');
    setLocale('en');
    await w!.setProps({ issues });
    await flushPromises();
    expect(toRaw((w!.vm.$props as { issues: CheckIssue[] }).issues)).toBe(issues); // the same issue objects: only the language changed
    expect(chip().text()).toBe('A reached 2.60 / 3.31 mm');
    expect(chip().attributes('aria-label')).toBe('A reached 2.60 of 3.31 mm, short travel. Pin this key.');
  });
});
