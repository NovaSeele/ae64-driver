import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachDemoPress } from '../src/components/live/demoPress';
import { MockTransport } from '../src/protocol';

// The typing-test box on Live travel: in demo mode a key typed into it still moves the simulated switch,
// and the character still reaches the box (no preventDefault). Other text fields keep ignoring demo presses.
describe('demo press and the typing-test box', () => {
  let detach: (() => void) | null = null;
  afterEach(() => {
    detach?.();
    detach = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  function setup() {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.push(cb); return frames.length; });
    vi.stubGlobal('cancelAnimationFrame', () => {});
    const mock = new MockTransport({ latencyMs: 0 });
    const spy = vi.spyOn(mock, 'simulatePress');
    detach = attachDemoPress(mock);
    const flush = () => { for (let i = 0; i < 20 && frames.length; i++) frames.shift()!(performance.now() + 1000); };
    return { spy, flush };
  }

  function press(target: HTMLElement, type: 'keydown' | 'keyup') {
    const ev = new KeyboardEvent(type, { code: 'KeyW', key: 'w', bubbles: true, cancelable: true });
    target.dispatchEvent(ev);
    return ev;
  }

  it('moves the switch for a key typed into [data-keytest] and lets the character through', () => {
    const { spy, flush } = setup();
    const box = document.createElement('textarea');
    box.setAttribute('data-keytest', '');
    document.body.appendChild(box);

    const down = press(box, 'keydown');
    expect(down.defaultPrevented).toBe(false);
    flush();
    expect(spy.mock.calls.some(([, mm]) => mm > 0)).toBe(true);

    const up = press(box, 'keyup');
    expect(up.defaultPrevented).toBe(false);
    flush();
    expect(spy.mock.calls.at(-1)?.[1]).toBe(0);
  });

  it('leaves the pan keys to the focused travel graph, but letters still simulate', () => {
    const { spy, flush } = setup();
    const graph = document.createElement('canvas');
    graph.className = 'graph';
    document.body.appendChild(graph);
    const reached: string[] = [];
    graph.addEventListener('keydown', (e) => reached.push(e.code));

    for (const code of ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']) {
      const ev = new KeyboardEvent('keydown', { code, key: code, bubbles: true, cancelable: true });
      graph.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    }
    flush();
    expect(reached).toEqual(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape']);
    expect(spy).not.toHaveBeenCalled();

    press(graph, 'keydown');
    flush();
    expect(spy.mock.calls.some(([, mm]) => mm > 0)).toBe(true);
  });

  it('still ignores other text fields', () => {
    const { spy, flush } = setup();
    const other = document.createElement('textarea');
    document.body.appendChild(other);

    const down = press(other, 'keydown');
    expect(down.defaultPrevented).toBe(false);
    flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('still takes over a key pressed outside any text field', () => {
    const { spy, flush } = setup();
    const down = press(document.body, 'keydown');
    expect(down.defaultPrevented).toBe(true);
    flush();
    expect(spy.mock.calls.some(([, mm]) => mm > 0)).toBe(true);
  });
  it('leaves arrow keys to a focused tab (Switch & calibration tabs in demo mode)', () => {
    const { spy, flush } = setup();
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    const tab = document.createElement('button');
    tab.setAttribute('role', 'tab');
    list.appendChild(tab);
    document.body.appendChild(list);
    const ev = new KeyboardEvent('keydown', { code: 'ArrowLeft', key: 'ArrowLeft', bubbles: true, cancelable: true });
    tab.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
    flush();
    expect(spy).not.toHaveBeenCalled();
  });
});
