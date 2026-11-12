import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { mount, type VueWrapper } from '@vue/test-utils';
import { PHYSICAL_KEYS } from '../src/protocol';
import KeyboardView from '../src/components/keyboard/KeyboardView.vue';
import { locale } from '../src/i18n/locale';
import { t } from '../src/i18n/vi';

const W = PHYSICAL_KEYS.find((k) => k.name === 'W')!;
const A = PHYSICAL_KEYS.find((k) => k.name === 'A')!;

let w: VueWrapper | null = null;
class RO { observe() {} disconnect() {} }

describe('uncalibrated keycap mark', () => {
  beforeEach(() => { setActivePinia(createPinia()); locale.value = 'vi'; vi.stubGlobal('ResizeObserver', RO); });
  afterEach(() => { w?.unmount(); w = null; vi.unstubAllGlobals(); });

  it('marks only the flagged key and names it in aria-label and title', () => {
    w = mount(KeyboardView, {
      props: { keys: [...PHYSICAL_KEYS], selectable: true, flag: (k) => (k.id === W.id ? { label: t('kb.uncalibrated') } : undefined) },
    });
    const wk = w.find(`[data-key="${W.id}"]`);
    const ak = w.find(`[data-key="${A.id}"]`);
    expect(wk.find('.cap').classes()).toContain('cap--flag');
    expect(wk.attributes('aria-label')).toContain('chưa hiệu chuẩn');
    expect(wk.attributes('title')).toContain('chưa hiệu chuẩn');
    expect(ak.find('.cap').classes()).not.toContain('cap--flag');
    expect(ak.attributes('aria-label')).not.toContain('chưa hiệu chuẩn');
    expect(ak.attributes('title')).toBeUndefined();
  });
});
