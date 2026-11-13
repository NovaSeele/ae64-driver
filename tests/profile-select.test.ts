import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import ProfileSelect from '../src/components/shell/ProfileSelect.vue';
import { useDeviceStore } from '../src/stores/device';

let wrapper: VueWrapper | null = null;

async function setup(compact = false) {
  setActivePinia(createPinia());
  const device = useDeviceStore();
  await device.connectDemo();
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }] });
  await router.push('/');
  const spy = vi.spyOn(device, 'switchProfile').mockResolvedValue(undefined as never);
  wrapper = mount(ProfileSelect, { props: { compact }, global: { plugins: [router] }, attachTo: document.body });
  return { device, spy, w: wrapper };
}

beforeEach(() => {
  document.body.innerHTML = '';
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
});

describe('ProfileSelect', () => {
  it('shows the active number and name on the trigger', async () => {
    const { device, w } = await setup();
    expect(device.profileNames).toHaveLength(4);
    const trig = w.get('.ps__trigger');
    expect(trig.get('.ps__chip').text()).toBe(String(device.activeProfile + 1));
    expect(trig.get('.ps__tname').text()).toBe(device.profileNames[device.activeProfile]);
    expect(w.find('.ps__pop').exists()).toBe(false);
  });

  it('opens a popover with 4 options on click', async () => {
    const { w } = await setup();
    await w.get('.ps__trigger').trigger('click');
    expect(w.get('.ps__trigger').attributes('aria-expanded')).toBe('true');
    expect(w.findAll('[role="option"]')).toHaveLength(4);
  });

  it('closes on Esc and focuses the trigger', async () => {
    const { w } = await setup();
    await w.get('.ps__trigger').trigger('click');
    await w.get('[role="option"]').trigger('keydown', { key: 'Escape' });
    expect(w.find('.ps__pop').exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('.ps__trigger').element);
  });

  it('opens on ArrowDown and focuses the active row, then arrows move clamped', async () => {
    const { device, w } = await setup();
    await w.get('.ps__trigger').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    const rows = w.findAll('[role="option"]');
    expect(document.activeElement).toBe(rows[device.activeProfile].element);
    await rows[device.activeProfile].trigger('keydown', { key: 'End' });
    expect(document.activeElement).toBe(rows[3].element);
    await rows[3].trigger('keydown', { key: 'ArrowDown' });
    expect(document.activeElement).toBe(rows[3].element);
    await rows[3].trigger('keydown', { key: 'Home' });
    expect(document.activeElement).toBe(rows[0].element);
  });

  it('choosing a row calls switchProfile with its index and closes', async () => {
    const { spy, w } = await setup();
    await w.get('.ps__trigger').trigger('click');
    await w.findAll('[role="option"]')[2].trigger('click');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(2);
    expect(w.find('.ps__pop').exists()).toBe(false);
  });

  it('closes on a pointerdown outside', async () => {
    const { w } = await setup();
    await w.get('.ps__trigger').trigger('click');
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    await flushPromises();
    expect(w.find('.ps__pop').exists()).toBe(false);
  });

  it('Enter on the already-active row only closes (no switchProfile)', async () => {
    const { device, spy, w } = await setup();
    await w.get('.ps__trigger').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    await w.findAll('[role="option"]')[device.activeProfile].trigger('keydown', { key: 'Enter' });
    expect(spy).not.toHaveBeenCalled();
    expect(w.find('.ps__pop').exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('.ps__trigger').element);
  });

  it.each([['Enter', true], ['Escape', false]] as const)('%s in the rename input puts focus back on the row, popover still open', async (key, saved) => {
    const { device, w } = await setup();
    const rename = vi.spyOn(device, 'renameProfile').mockResolvedValue(undefined as never);
    await w.get('.ps__trigger').trigger('keydown', { key: 'ArrowDown' });
    await flushPromises();
    await w.findAll('[role="option"]')[2].trigger('keydown', { key: 'F2' });
    await flushPromises();
    const input = w.get('.ps__input');
    await input.setValue('Renamed');
    await input.trigger('keydown', { key });
    await flushPromises();
    expect(w.find('.ps__input').exists()).toBe(false);
    expect(w.find('.ps__pop').exists()).toBe(true);
    expect(document.activeElement).toBe(w.findAll('[role="option"]')[2].element);
    expect(rename).toHaveBeenCalledTimes(saved ? 1 : 0);
  });

  it('compact mode still lists profile names in the popover', async () => {
    const { device, w } = await setup(true);
    await w.get('.ps__trigger').trigger('click');
    const names = w.findAll('.ps__name').map((n) => n.text());
    expect(names).toEqual(device.profileNames);
  });
});

describe('ProfileSelect double-click on another profile', () => {
  it('unmounting inside the window removes the swallow: a click right after reaches the page', async () => {
    const { spy, w } = await setup();
    await w.get('.ps__trigger').trigger('click');
    await w.findAll('[role="option"]')[2].trigger('click');
    expect(spy).toHaveBeenCalledWith(2);
    w.unmount();
    wrapper = null;
    const link = document.createElement('a');
    const onLink = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', onLink);
    document.body.appendChild(link);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    link.dispatchEvent(down);
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(down.defaultPrevented).toBe(false);
    expect(onLink).toHaveBeenCalledTimes(1);
  });

  it('ignores the second click that lands under the closed popover', async () => {
    const { spy, w } = await setup();
    const link = document.createElement('a');
    link.href = '#/keymap';
    const onLink = vi.fn((e: Event) => e.preventDefault());
    link.addEventListener('click', onLink);
    document.body.appendChild(link);
    await w.get('.ps__trigger').trigger('click');
    await w.findAll('[role="option"]')[2].trigger('click'); // first click: switches and closes
    expect(spy).toHaveBeenCalledWith(2);
    const onDown = vi.fn();
    link.addEventListener('pointerdown', onDown);
    link.addEventListener('mousedown', onDown);
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    link.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    link.dispatchEvent(down); // second press of the double-click: focus would move here
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onDown).not.toHaveBeenCalled();
    expect(down.defaultPrevented).toBe(true);
    expect(onLink).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 520));
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onLink).toHaveBeenCalledTimes(1); // a new press after the 500 ms window works again
  });

  it('a press that starts inside the window stays swallowed through its late release and click', async () => {
    const { spy, w } = await setup();
    const link = document.createElement('a');
    link.href = '#/performance';
    const onLink = vi.fn((e: Event) => e.preventDefault());
    const onUp = vi.fn();
    link.addEventListener('click', onLink);
    link.addEventListener('mouseup', onUp);
    link.addEventListener('pointerup', onUp);
    document.body.appendChild(link);
    await w.get('.ps__trigger').trigger('click');
    await w.findAll('[role="option"]')[2].trigger('click');
    expect(spy).toHaveBeenCalledWith(2);
    await new Promise((r) => setTimeout(r, 400)); // a slow double-click: second press at +400 ms
    link.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 200)); // released after the window has ended
    link.dispatchEvent(new Event('pointerup', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    expect(onUp).not.toHaveBeenCalled();
    expect(onLink).not.toHaveBeenCalled();
    link.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    link.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(onLink).toHaveBeenCalledTimes(1); // the next real press goes through
  });
});
