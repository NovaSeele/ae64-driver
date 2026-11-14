// The plain-text block "Copy info" puts on the clipboard (DESIGN H §3.1). Fixed English labels whatever the app's language,
// so whoever helps can read it and compare reports. Never the serial number, a profile or macro name, or anything typed.

export interface SupportInfoInput {
  version: string;
  /** null: no keyboard connected. */
  keyboard: null | {
    model: string | null;
    demo: boolean;
    boardIdHex?: string | null;
    firmware?: string | null;
    protocol?: string | null;
    rtPrecision?: number | null;
    /** Hz, or null while the settings have not been read. */
    pollingHz?: number | null;
    macro?: { capacity: number; count: number } | null;
  };
  browser: string;
  locale: string;
  theme: string;
  now: Date;
}

const DASH = '—';
const pad2 = (n: number) => String(n).padStart(2, '0');

/** "2026-11-13 04:35 (UTC+07:00)", in the computer's time zone. */
export function localStamp(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    + ` (UTC${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)})`;
}

interface UaData { brands?: { brand: string; version: string }[]; platform?: string }

/** "Google Chrome 147 · Windows" from navigator.userAgentData (a named browser before the plain "Chromium"; never a
 *  "Not…A…Brand" placeholder), or "unknown" where the browser does not give it. */
export function browserLabel(nav: { userAgentData?: UaData } | undefined): string {
  const ua = nav?.userAgentData;
  const brands = (ua?.brands ?? []).filter((b) => b.brand && !/^not/i.test(b.brand.replace(/[^a-z]/gi, '')));
  if (!brands.length) return 'unknown';
  const b = brands.find((x) => x.brand !== 'Chromium') ?? brands[0];
  return ua?.platform ? `${b.brand} ${b.version} · ${ua.platform}` : `${b.brand} ${b.version}`;
}

export function buildSupportInfo(i: SupportInfoInput): string {
  const lines = [`AE64 Control ${i.version} (web)`];
  const k = i.keyboard;
  if (!k) {
    lines.push('Keyboard: not connected');
  } else {
    const v = (x: string | number | null | undefined) => (x === null || x === undefined || x === '' ? DASH : String(x));
    lines.push(
      `Keyboard: ${k.model ?? 'AE64'} (${k.demo ? 'demo' : 'WebHID'})`,
      `Board ID: ${k.boardIdHex ? `0x${k.boardIdHex.toUpperCase()}` : DASH}`,
      `Firmware: ${v(k.firmware)}`,
      `Protocol: ${v(k.protocol)}`,
      `RT resolution: ${k.rtPrecision != null ? `${k.rtPrecision} mm` : DASH}`,
      `Polling rate: ${k.pollingHz != null ? `${k.pollingHz} Hz` : DASH}`,
      `Macro memory: ${k.macro ? `${k.macro.capacity} actions, ${k.macro.count} slots` : DASH}`,
    );
  }
  lines.push(`Browser: ${i.browser}`, `App: ${i.locale}, ${i.theme}`, `Copied: ${localStamp(i.now)}`);
  return lines.join('\n');
}
