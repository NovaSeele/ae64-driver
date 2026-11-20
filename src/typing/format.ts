// How the typing test shows its numbers (DESIGN TT §5.1 "Shown", §11): in the UI locale, read at each call.
import { locale } from '../i18n/locale';
import { t } from '../i18n/vi';
import type { TextLang } from './score';
import type { Content, EndKind } from './texts';

export const num = (x: number): string => new Intl.NumberFormat(locale.value).format(x);
/** Floored to a whole percent: 100 % only with no error. */
export const pct = (x: number): string =>
  new Intl.NumberFormat(locale.value, { style: 'percent', maximumFractionDigits: 0 }).format(Math.floor(x * 100 + 1e-9) / 100);
export const mmss = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** "Tiếng Việt · Từ · 30 giây" / "English · Sentences · 50 words", in the current UI language. */
export function kindText(k: { lang: TextLang; content: Content; kind: EndKind; n: number }): string {
  return [
    t(k.lang === 'vi' ? 'tt.lang.vi' : 'tt.lang.en'),
    t(k.content === 'words' ? 'tt.content.words' : 'tt.content.sentences'),
    k.kind === 'time' ? t('tt.sec', { n: k.n }) : t('tt.nWords', { n: k.n }),
  ].join(' · ');
}

/** A history row's time: HH:mm today, else day/month and HH:mm. */
export function whenText(at: number, now = Date.now()): string {
  const today = new Date(at).toDateString() === new Date(now).toDateString();
  return new Intl.DateTimeFormat(locale.value, today
    ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(at);
}
