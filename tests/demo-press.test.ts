import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachDemoPress } from '../src/components/live/demoPress';
import { MockTransport } from '../src/protocol';

describe('demo press and radio groups', () => {
  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('ArrowRight inside a radiogroup is neither prevented nor simulated; other keys still simulate', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const mock = new MockTransport({ latencyMs: 0 });
    const spy = vi.spyOn(mock, 'simulatePress');
    detach = attachDemoPress(mock);
    const flush = () => { for (let i = 0; i < 20 && frames.length; i++) frames.shift()!(performance.now() + 1000); };
    const group = document.createElement('div');
    group.setAttribute('role', 'radiogroup');
    const radio = document.createElement('button');
    radio.setAttribute('role', 'radio');
    group.appendChild(radio);
    document.body.appendChild(group);

    const arrow = new KeyboardEvent('keydown', { code: 'ArrowRight', key: 'ArrowRight', bubbles: true, cancelable: true });
    radio.dispatchEvent(arrow);
    flush();
    expect(arrow.defaultPrevented).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    const w = new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true, cancelable: true });
    radio.dispatchEvent(w);
    flush();
    expect(w.defaultPrevented).toBe(true);
    expect(spy.mock.calls.some(([, mm]) => mm > 0)).toBe(true);
  });

  it('Space/Enter on a focused control is neither prevented nor simulated; Space on a plain div still simulates', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const mock = new MockTransport({ latencyMs: 0 });
    const spy = vi.spyOn(mock, 'simulatePress');
    detach = attachDemoPress(mock);
    const flush = () => { for (let i = 0; i < 20 && frames.length; i++) frames.shift()!(performance.now() + 1000); };
    const btn = document.createElement('button');
    const sw = document.createElement('div');
    sw.setAttribute('role', 'switch');
    const div = document.createElement('div');
    document.body.append(btn, sw, div);

    const press = (el: Element, code: string, key: string) => {
      const e = new KeyboardEvent('keydown', { code, key, bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      flush();
      return e;
    };
    expect(press(btn, 'Space', ' ').defaultPrevented).toBe(false);
    expect(press(sw, 'Space', ' ').defaultPrevented).toBe(false);
    expect(press(btn, 'Enter', 'Enter').defaultPrevented).toBe(false);
    expect(press(btn, 'NumpadEnter', 'Enter').defaultPrevented).toBe(false);
    expect(spy).not.toHaveBeenCalled();

    const plain = press(div, 'Space', ' ');
    expect(plain.defaultPrevented).toBe(true);
    expect(spy.mock.calls.some(([, mm]) => mm > 0)).toBe(true);
  });
});

describe('demo press stroke timing', () => {
  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
    vi.useRealTimers();
  });

  function setup() {
    vi.useFakeTimers();
    const mock = new MockTransport({ latencyMs: 0 });
    const log: { t: number; mm: number }[] = [];
    const t0 = performance.now();
    vi.spyOn(mock, 'simulatePress').mockImplementation((_id, mm) => { log.push({ t: performance.now() - t0, mm }); });
    detach = attachDemoPress(mock);
    const key = (type: 'keydown' | 'keyup', code = 'KeyW') =>
      document.body.dispatchEvent(new KeyboardEvent(type, { code, key: 'w', bubbles: true, cancelable: true }));
    return { log, key };
  }
  const strokes = (log: { mm: number }[]) => log.reduce((n, s, i) => n + (s.mm > 0 && (i === 0 || log[i - 1].mm === 0) ? 1 : 0), 0);

  it('a 50 ms tap is a full stroke: bottom 3.31, held for 60 ms, back to 0 by ~680 ms', () => {
    const { log, key } = setup();
    key('keydown');
    vi.advanceTimersByTime(50);
    key('keyup');
    vi.advanceTimersByTime(800);
    const bottom = log.filter((s) => s.mm === 3.31);
    expect(bottom.length).toBeGreaterThan(0);
    expect(bottom[bottom.length - 1].t - bottom[0].t).toBeGreaterThanOrEqual(60);
    const end = log.find((s, i) => i > 0 && s.mm === 0)!;
    expect(end.t).toBeGreaterThanOrEqual(660);
    expect(end.t).toBeLessThanOrEqual(720);
  });

  it('a 1 s hold stays at 3.31 until keyup', () => {
    const { log, key } = setup();
    key('keydown');
    vi.advanceTimersByTime(1000);
    expect(log[log.length - 1].mm).toBe(3.31);
    key('keyup');
    vi.advanceTimersByTime(600);
    expect(log[log.length - 1].mm).toBe(0);
  });

  it('4 taps 100 ms apart give 3 strokes (1 running + 2 queued, the 4th dropped)', () => {
    const { log, key } = setup();
    for (let i = 0; i < 4; i++) {
      key('keydown');
      vi.advanceTimersByTime(30);
      key('keyup');
      vi.advanceTimersByTime(70);
    }
    vi.advanceTimersByTime(3000);
    expect(strokes(log)).toBe(3);
  });

  it('3 taps give 3 strokes', () => {
    const { log, key } = setup();
    for (let i = 0; i < 3; i++) {
      key('keydown');
      vi.advanceTimersByTime(30);
      key('keyup');
      vi.advanceTimersByTime(70);
    }
    vi.advanceTimersByTime(3000);
    expect(strokes(log)).toBe(3);
  });

  it('releaseAll (blur) clears the queue: the running stroke completes, queued taps do not run', () => {
    const { log, key } = setup();
    key('keydown');
    key('keyup');
    key('keydown');
    key('keyup');
    key('keydown');
    vi.advanceTimersByTime(100);
    window.dispatchEvent(new Event('blur'));
    vi.advanceTimersByTime(3000);
    expect(strokes(log)).toBe(1);
    expect(log[log.length - 1].mm).toBe(0);
  });
});

describe('demo press reads during a stroke', () => {
  afterEach(() => vi.useRealTimers());

  const keyEv = (type: 'keydown' | 'keyup') =>
    document.body.dispatchEvent(new KeyboardEvent(type, { code: 'KeyW', key: 'w', bubbles: true, cancelable: true }));

  /** Reads travel through the mock's axis path every `cadence` ms (first read `offset` ms after the keydown) during one held stroke. */
  function readsAt(cadence: number, offset: number): number[] {
    vi.useFakeTimers();
    const mock = new MockTransport({ latencyMs: 0 });
    const seen: number[] = [];
    const real = mock.simulatePress.bind(mock);
    vi.spyOn(mock, 'simulatePress').mockImplementation((id, mm) => { seen.push(mm); real(id, mm); });
    const detach = attachDemoPress(mock);
    const axis = mock as unknown as { axisRow(t: number, r: number): number[] };
    keyEv('keydown');
    const reads: number[] = [];
    let wait = offset;
    for (let t = offset; t < 700; t += cadence) {
      vi.advanceTimersByTime(wait);
      wait = cadence;
      axis.axisRow(1, 2); // a frame at this same instant may already have advanced the key: the read sees its position
      if (seen.length) reads.push(seen[seen.length - 1]);
    }
    detach();
    vi.useRealTimers();
    return reads;
  }

  it.each([1.0, 2.5])('12 ms reads: the first read at or past %s mm overshoots by 0.10 mm on average, 0.20 at most', (line) => {
    const over: number[] = [];
    for (let offset = 1; offset <= 12; offset++) over.push(readsAt(12, offset).find((mm) => mm >= line)! - line);
    expect(Math.min(...over)).toBeGreaterThanOrEqual(0);
    expect(over.reduce((a, b) => a + b, 0) / over.length).toBeLessThanOrEqual(0.1);
    expect(Math.max(...over)).toBeLessThanOrEqual(0.2);
  });

  it('the descent is monotonic and continuous, with constant velocity between 15% and 85% of the travel', () => {
    const reads = readsAt(5, 1);
    const down = reads.slice(0, reads.indexOf(3.31) + 1);
    const steps = down.slice(1).map((mm, i) => mm - down[i]);
    expect(steps.every((d) => d >= 0)).toBe(true);
    expect(Math.max(...steps)).toBeLessThan(0.1); // no jump at 5 ms
    const mid = down.map((mm, i) => ({ mm, i })).filter(({ mm }) => mm >= 0.15 * 3.31 && mm <= 0.85 * 3.31);
    const mids = mid.slice(1).map(({ mm }, i) => mm - mid[i].mm);
    const mean = mids.reduce((a, b) => a + b, 0) / mids.length;
    for (const d of mids) expect(Math.abs(d - mean)).toBeLessThan(1e-6);
  });
});

describe('demo press and links (DESIGN L §11.1, K5)', () => {
  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('K5. Enter (and NumpadEnter) on a focused link is neither prevented nor simulated; Space on it still is; Enter on a button as before', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const mock = new MockTransport({ latencyMs: 0 });
    const spy = vi.spyOn(mock, 'simulatePress');
    detach = attachDemoPress(mock);
    const flush = () => { for (let i = 0; i < 20 && frames.length; i++) frames.shift()!(performance.now() + 1000); };
    const link = document.createElement('a');
    link.href = '#/keymap';
    const btn = document.createElement('button');
    document.body.append(link, btn);
    const down = (code: string, el: Element) => {
      const e = new KeyboardEvent('keydown', { code, key: code === 'Space' ? ' ' : code, bubbles: true, cancelable: true });
      el.dispatchEvent(e);
      flush();
      return e.defaultPrevented;
    };

    for (const code of ['Enter', 'NumpadEnter']) {
      expect(down(code, link), code).toBe(false);
      expect(spy, code).not.toHaveBeenCalled();
    }
    expect(down('Enter', btn)).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    expect(down('Space', link)).toBe(true);
    expect(spy.mock.calls.some(([, mm]) => mm > 0)).toBe(true);
  });
});
