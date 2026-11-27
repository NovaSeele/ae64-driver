import { describe, expect, it } from 'vitest';
import { vi, t, type MessageKey } from '../src/i18n/vi';
import { en } from '../src/i18n/en';
import { setLocale } from '../src/i18n/locale';

const MKB_KEYS: MessageKey[] = [
  'app.tagline',
  'connect.subtitle',
  'help.body',
  'error.noAe64Selected',
  'error.protocolUnknown',
  'error.protocolVersion',
  'error.bootOther',
  'error.receiver',
  'mkb.refuse.copy',
  'mkb.name.fallback',
  'mkb.name.cardSub',
  'mkb.layout.unknownSize',
  'mkb.layout.overlap',
  'mkb.layout.empty',
  'mkb.banner.title',
  'mkb.banner.body',
  'mkb.banner.why',
  'mkb.banner.announce',
  'mkb.common.unknown',
  'mkb.common.noAnswer',
  'mkb.common.unsupported',
  'mkb.page.macroUnsupported',
  'mkb.page.firmwareOnlyAe64',
  'mkb.light.extraArea',
  'mkb.light.effect',
  'mkb.light.strip',
  'mkb.switch.current',
  'mkb.switch.catalogAe64Only',
  'mkb.export.button',
  'mkb.export.exporting',
  'mkb.export.savedDialog',
  'mkb.export.openGithub',
];

describe('mkb-i18n', () => {
  it('defines all MKB-V keys in both vi and en', () => {
    for (const key of MKB_KEYS) {
      expect(vi[key]).toBeTruthy();
      expect(en[key]).toBeTruthy();
    }
  });

  it('formats key placeholders cleanly in both locales', () => {
    setLocale('vi');
    expect(t('mkb.name.fallback', { vid: '1CA6', pid: 'F004' })).toBe('Bàn phím 1CA6:F004');
    expect(t('mkb.light.extraArea', { n: 2, m: 5 })).toBe('Vùng 2: 5 chế độ');

    setLocale('en');
    expect(t('mkb.name.fallback', { vid: '1CA6', pid: 'F004' })).toBe('Keyboard 1CA6:F004');
    expect(t('mkb.light.extraArea', { n: 2, m: 1 })).toBe('Area 2: 1 mode');
    expect(t('mkb.light.extraArea', { n: 2, m: 5 })).toBe('Area 2: 5 modes');

    setLocale('vi');
  });
});
