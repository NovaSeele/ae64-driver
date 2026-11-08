import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import KeyPicker from '../src/components/ui/KeyPicker.vue';

const keyBtn = (w: ReturnType<typeof mount>, label: string) =>
  w.findAll('.kp__key').find((b) => b.find('.kp__label').text() === label)!;
const mod = (w: ReturnType<typeof mount>, text: string) => w.findAll('.kp__mod').find((b) => b.text() === text)!;

describe('KeyPicker', () => {
  it('offers only the four left modifiers', () => {
    const w = mount(KeyPicker);
    const mods = w.findAll('.kp__mod').map((b) => b.text());
    expect(mods).toEqual(['Ctrl', 'Shift', 'Alt', 'Win']);
  });

  it('resets modifiers after a pick', async () => {
    const w = mount(KeyPicker);
    await mod(w, 'Ctrl').trigger('click');
    await keyBtn(w, 'C').trigger('click');
    await keyBtn(w, 'V').trigger('click');
    expect(w.emitted('pick')).toEqual([[0x0106], [0x19]]);
    expect(w.findAll('.kp__mod[aria-pressed="true"]')).toHaveLength(0);
  });

  it('preloads the modifiers and trigger of an existing combo', () => {
    const w = mount(KeyPicker, { props: { current: 0x0306 } }); // Ctrl+Shift+C
    expect(w.findAll('.kp__mod[aria-pressed="true"]').map((b) => b.text())).toEqual(['Ctrl', 'Shift']);
    expect(keyBtn(w, 'C').classes()).toContain('kp__key--current');
  });

  it('first Esc clears the search without closing, second Esc propagates', async () => {
    let escapes = 0;
    const host = document.createElement('div');
    host.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') escapes++; });
    document.body.appendChild(host);
    const w = mount(KeyPicker, { attachTo: host });
    const input = w.find('input[type="search"]');
    await input.setValue('fn1');
    expect(w.find('[role="tab"][aria-selected="true"]').exists()).toBe(false);
    await input.trigger('keydown', { key: 'Escape' });
    expect((input.element as HTMLInputElement).value).toBe('');
    expect(escapes).toBe(0);
    expect(w.find('[role="tab"][aria-selected="true"]').exists()).toBe(true);
    await input.trigger('keydown', { key: 'Escape' });
    expect(escapes).toBe(1);
    w.unmount();
    host.remove();
  });

  it('explains disabled keys while a modifier is on', async () => {
    const w = mount(KeyPicker);
    await mod(w, 'Ctrl').trigger('click');
    await w.find('input[type="search"]').setValue('vol +');
    const vol = w.find('.kp__key');
    expect(vol.attributes('disabled')).toBeDefined();
    expect(vol.attributes('aria-description')).toBeTruthy();
  });
});
