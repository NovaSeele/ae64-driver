// DESIGN H §3.2 + brief H point 5, §11 items 11, 12: the "Saved to keyboard" pill and its bubble, Tooltip's `disabled`,
// and the toast App shows after an app-settings import / reset reloaded the page.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import { defineComponent, h, ref } from 'vue';
import { routes } from '../src/router';
import TopBar from '../src/components/shell/TopBar.vue';
import Tooltip from '../src/components/ui/Tooltip.vue';
import App from '../src/App.vue';
import { useSyncStore } from '../src/stores/sync';
import { useToast } from '../src/components/ui/toast';
import { APPCFG_DONE_KEY } from '../src/data/appcfgDone';
import { t } from '../src/i18n/vi';

let wrapper: VueWrapper | null = null;
beforeEach(() => {
  setActivePinia(createPinia());
  sessionStorage.clear();
  useToast().items.value = []; // toasts are module-wide: none left from another test
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

async function topBar() {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push('/settings');
  wrapper = mount(TopBar, { global: { plugins: [router] }, attachTo: document.body });
  await flushPromises();
  const sync = useSyncStore();
  const w = wrapper;
  const pill = () => w.get('.pill').element as HTMLElement;
  const describedBy = () => {
    const id = pill().getAttribute('aria-describedby');
    return id ? document.getElementById(id) : null;
  };
  const hover = async () => {
    pill().parentElement!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(400);
    await flushPromises();
  };
  const tips = () => [...document.querySelectorAll('[role="tooltip"]')].map((e) => e.textContent);
  return { sync, w, pill, describedBy, hover, tips };
}

describe('item 11: the pill', () => {
  it('saved: focusable, described by the promise in a hidden span; Tab / hover shows one bubble with it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = await topBar();
    expect(p.sync.state).toBe('saved');
    expect(p.pill().getAttribute('tabindex')).toBe('0');
    expect(p.pill().getAttribute('role')).toBe('status');
    expect(p.pill().getAttribute('aria-live')).toBe('polite');
    const help = p.describedBy()!;
    expect(help.id).toBe('sync-saved-help');
    expect(help.hidden).toBe(true);
    expect(help.textContent).toBe(t('sync.savedHelp'));
    p.pill().focus();
    p.pill().dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    vi.advanceTimersByTime(400);
    await flushPromises();
    expect(p.tips()).toEqual([t('sync.savedHelp')]);
    p.pill().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(p.tips()).toEqual([]);
  });

  it('the same pill element across saved → writing → saved (the live region is never re-created)', async () => {
    const p = await topBar();
    const first = p.pill();
    p.sync.state = 'writing';
    await flushPromises();
    expect(p.pill()).toBe(first);
    expect(first.textContent).toContain(t('sync.writing'));
    p.sync.state = 'pending';
    await flushPromises();
    expect(p.pill()).toBe(first);
    p.sync.state = 'error';
    await flushPromises();
    expect(p.pill()).toBe(first);
    p.sync.state = 'saved';
    await flushPromises();
    expect(p.pill()).toBe(first);
    expect(first.textContent).toContain(t('sync.saved'));
  });

  it('saved with a problem last time: the one bubble and the description say that problem', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = await topBar();
    p.sync.lastProblem = 'Đọc lại không khớp: Polling rate';
    await flushPromises();
    const text = t('sync.lastProblem', { msg: 'Đọc lại không khớp: Polling rate' });
    expect(p.pill().getAttribute('tabindex')).toBe('0');
    expect(p.describedBy()!.textContent).toBe(text);
    await p.hover();
    expect(p.tips()).toEqual([text]);
  });

  it.each(['writing', 'pending'] as const)('%s: not focusable, not described, no bubble on hover', async (state) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = await topBar();
    p.sync.state = state;
    await flushPromises();
    expect(p.pill().hasAttribute('tabindex')).toBe(false);
    expect(p.pill().hasAttribute('aria-describedby')).toBe(false);
    expect(document.getElementById('sync-saved-help')).toBeNull();
    await p.hover();
    expect(p.tips()).toEqual([]);
  });

  it('error: not focusable, not described; the error text keeps its own bubble inside the pill', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = await topBar();
    p.sync.state = 'error';
    p.sync.lastError = 'USB';
    await flushPromises();
    expect(p.pill().hasAttribute('tabindex')).toBe(false);
    expect(p.pill().hasAttribute('aria-describedby')).toBe(false);
    p.pill().querySelector('.tip')!.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(400);
    await flushPromises();
    expect(p.tips()).toEqual(['USB']);
    expect(p.pill().querySelector('.pill__retry')).not.toBeNull();
  });

  it('a bubble open on "saved" closes when the state turns to writing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const p = await topBar();
    await p.hover();
    expect(p.tips()).toHaveLength(1);
    p.sync.state = 'writing';
    await flushPromises();
    expect(p.tips()).toEqual([]);
  });
});

describe('Tooltip disabled', () => {
  const Host = defineComponent({
    props: { off: Boolean },
    setup(props) { return () => h(Tooltip, { text: 'Hi', disabled: props.off }, () => h('button', 'b')); },
  });

  it('default (not disabled) is unchanged; disabled shows nothing; turning disabled on closes an open bubble', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const off = ref(false);
    wrapper = mount(defineComponent({ setup: () => () => h(Host, { off: off.value }) }), { attachTo: document.body });
    const tip = () => wrapper!.get('.tip');
    await tip().trigger('pointerenter');
    vi.advanceTimersByTime(349);
    await flushPromises();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    vi.advanceTimersByTime(1);
    await flushPromises();
    expect(wrapper.get('[role="tooltip"]').text()).toBe('Hi');
    expect(tip().attributes('aria-describedby')).toBe(wrapper.get('[role="tooltip"]').attributes('id'));
    off.value = true;
    await flushPromises();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    await tip().trigger('pointerleave');
    await tip().trigger('pointerenter');
    vi.advanceTimersByTime(500);
    await flushPromises();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
    off.value = false;
    await flushPromises();
    await tip().trigger('focusin');
    vi.advanceTimersByTime(400);
    await flushPromises();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(true);
  });

  it('disabled while the delay runs: no bubble afterwards', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const off = ref(false);
    wrapper = mount(defineComponent({ setup: () => () => h(Host, { off: off.value }) }), { attachTo: document.body });
    await wrapper.get('.tip').trigger('pointerenter');
    vi.advanceTimersByTime(200);
    off.value = true;
    await flushPromises();
    vi.advanceTimersByTime(400);
    await flushPromises();
    expect(wrapper.find('[role="tooltip"]').exists()).toBe(false);
  });
});

describe('item 12: the toast after the reload', () => {
  async function mountApp() {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/overview');
    wrapper = mount(App, { global: { plugins: [router] }, attachTo: document.body });
    await flushPromises();
  }

  it('flag "import": the import toast once, and the flag is gone', async () => {
    sessionStorage.setItem(APPCFG_DONE_KEY, 'import');
    await mountApp();
    const items = useToast().items.value.filter((x) => x.text === t('appcfg.doneImport'));
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('success');
    expect(sessionStorage.getItem(APPCFG_DONE_KEY)).toBeNull();
    expect(document.body.textContent).toContain(t('appcfg.doneImport'));
  });

  it('flag "reset": the reset toast', async () => {
    sessionStorage.setItem(APPCFG_DONE_KEY, 'reset');
    await mountApp();
    expect(useToast().items.value.map((x) => x.text)).toContain(t('appcfg.doneReset'));
  });

  it('no flag: no toast', async () => {
    await mountApp();
    expect(useToast().items.value).toEqual([]);
  });
});
