// WX6 item 11: the KeyPicker's modifiers are the edited key's own. Pick A for key X; select key Y (Ctrl+C); select key Z
// (A): Ctrl is not armed and the next pick is B. A mask the user set and did not use goes when the target changes.
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import KeyPicker from '../src/components/ui/KeyPicker.vue';
import { setLocale } from '../src/i18n/locale';

let w: VueWrapper | null = null;
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; setLocale('vi'); });

const key = (label: string) => w!.findAll('.kp__key').find((b) => b.find('.kp__label').text() === label)!;
const ctrl = () => w!.findAll('.kp__mod').find((b) => b.text() === 'Ctrl')!;

describe('WX6: KeyPicker modifiers', () => {
  it('L turned round: X (pick A), Y (Ctrl+C), Z (A): Ctrl is off on Z and the pick is B', async () => {
    setLocale('en');
    w = mount(KeyPicker, { props: { current: 0x0005, target: 'X' }, attachTo: document.body });
    await key('A').trigger('click');
    expect(w.emitted('pick')![0]).toEqual([0x0004]);
    await w.setProps({ current: 0x0004 }); // echo of our own pick
    await w.setProps({ current: 0x0106, target: 'Y' }); // key Y: Ctrl+C
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('true');
    await w.setProps({ current: 0x0004, target: 'Z' }); // key Z: plain A
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('false');
    await key('B').trigger('click');
    expect(w.emitted('pick')!.at(-1)).toEqual([0x0005]);
  });

  it('the same order without a target (the code alone): Z still loads its own modifiers', async () => {
    setLocale('en');
    w = mount(KeyPicker, { props: { current: 0x0005 }, attachTo: document.body });
    await key('A').trigger('click');
    await w.setProps({ current: 0x0004 });
    await w.setProps({ current: 0x0106 });
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('true');
    await w.setProps({ current: 0x0004 });
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('false');
  });

  it('a mask set and not used goes when the target changes to a key with the same code', async () => {
    setLocale('en');
    w = mount(KeyPicker, { props: { current: 0x0004, target: 'X' }, attachTo: document.body });
    await ctrl().trigger('click');
    expect(ctrl().attributes('aria-pressed')).toBe('true');
    await w.setProps({ target: 'W' }); // another key, also A
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('false');
    await key('B').trigger('click');
    expect(w.emitted('pick')!.at(-1)).toEqual([0x0005]);
  });

  it('the target holds a combo: its modifiers come with it; the echo of a combo pick keeps the picker as it is', async () => {
    setLocale('en');
    w = mount(KeyPicker, { props: { current: 0x0004, target: 'X' }, attachTo: document.body });
    await w.setProps({ current: 0x0106, target: 'Y' });
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('true');
    await key('B').trigger('click'); // Ctrl+B
    expect(w.emitted('pick')!.at(-1)).toEqual([0x0105]);
    expect(ctrl().attributes('aria-pressed')).toBe('false'); // one pick only
    await w.setProps({ current: 0x0105 }); // the echo
    await nextTick();
    expect(ctrl().attributes('aria-pressed')).toBe('false');
  });
});
