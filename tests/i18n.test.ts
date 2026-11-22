import { describe, expect, it } from 'vitest';
import { vi, t, type MessageKey } from '../src/i18n/vi';
import { en } from '../src/i18n/en';
import { locale, plural, setLocale } from '../src/i18n/locale';

function getPlaceholders(str: string): { all: string[]; value: string[] } {
  const all = new Set<string>();
  const value = new Set<string>();
  for (const [, name, pluralSpec] of str.matchAll(/\{(\w+)(?:\|([^}]*))?\}/g)) {
    all.add(name);
    // Plain `{x}` or `{n|# one|# other}` renders the value; `{n|one|other}` without `#` is English-only grammatical agreement.
    if (pluralSpec === undefined || pluralSpec.includes('#')) value.add(name);
  }
  return { all: [...all].sort(), value: [...value].sort() };
}

describe('i18n', () => {
  it('every key in vi has a non-empty en string', () => {
    const viKeys = Object.keys(vi) as MessageKey[];
    expect(viKeys.length).toBeGreaterThan(0);

    for (const key of viKeys) {
      const enVal = (en as Record<string, string>)[key];
      expect(enVal, `Missing English translation for "${key}"`).toBeDefined();
      expect(typeof enVal).toBe('string');
      expect(enVal.trim().length, `Empty English translation for "${key}"`).toBeGreaterThan(0);
    }
  });

  it('placeholders in each en string match the vi string placeholders', () => {
    const viKeys = Object.keys(vi) as MessageKey[];
    for (const key of viKeys) {
      const viVal = vi[key];
      const enVal = (en as Record<string, string>)[key];
      const viP = getPlaceholders(viVal);
      const enP = getPlaceholders(enVal);
      for (const name of viP.all) {
        expect(
          enP.all,
          `Missing placeholder "${name}" in en "${key}" (vi: ${viVal}, en: ${enVal})`,
        ).toContain(name);
      }
      for (const name of enP.value) {
        expect(
          viP.all,
          `Extra placeholder "${name}" in en "${key}" (vi: ${viVal}, en: ${enVal})`,
        ).toContain(name);
      }
      for (const [, , spec] of enVal.matchAll(/\{(\w+)\|([^}]*)\}/g)) {
        expect(spec.split('|'), `Malformed plural in "${key}" (en: ${enVal})`).toHaveLength(2);
      }
    }
  });

  it('switching locale changes t() output', () => {
    setLocale('vi');
    expect(locale.value).toBe('vi');
    expect(t('nav.configure')).toBe('Cấu hình');
    expect(t('device.renamed', { name: 'Gaming' })).toBe('Đã đổi tên profile thành “Gaming”.');

    setLocale('en');
    expect(locale.value).toBe('en');
    expect(t('nav.configure')).toBe('Configure');
    expect(t('device.renamed', { name: 'Gaming' })).toBe('Renamed profile to “Gaming”.');

    setLocale('vi');
    expect(t('nav.configure')).toBe('Cấu hình');
  });

  it('picks plural forms in English and ignores them in Vietnamese', () => {
    expect(plural(1, '# key', '# keys', 'en')).toBe('1 key');
    expect(plural(0, '# key', '# keys', 'en')).toBe('0 keys');
    expect(plural(5, '# key', '# keys', 'en')).toBe('5 keys');
    expect(plural(1, '# phím', '# phím', 'vi')).toBe('1 phím');

    setLocale('en');
    expect(t('sel.count', { n: 1 })).toBe('1 key selected');
    expect(t('sel.count', { n: 3 })).toBe('3 keys selected');
    expect(t('perf.presetApplied', { name: 'Gaming', n: 1 })).toBe('Applied preset Gaming to 1 key.');
    setLocale('vi');
    expect(t('sel.count', { n: 1 })).toBe('1 phím đã chọn');
  });
});
