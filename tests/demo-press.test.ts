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
});
