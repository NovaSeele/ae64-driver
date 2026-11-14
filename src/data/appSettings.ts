// App settings kept in this browser (localStorage), and their export / import / reset (DESIGN H §3.5, §3.6).
// Nothing here sends a command to the keyboard. Import and reset reload the page, so they first wait for every write to the
// keyboard to finish (applyAndReload).
import { computed } from 'vue';
import { isThemeChoice } from '../theme';
import { isLocale } from '../i18n/locale';
import { presetsValid } from '../stores/userPresets';
import { asPerfTab } from '../router';
import { recentValid } from '../components/ui/recentColors';
import { isDemoSeed } from '../protocol/mock';
import { APPCFG_DONE_KEY, setAppcfgDone } from './appcfgDone';
import { useCalibrationStore } from '../stores/calibration';
import { useDeviceStore } from '../stores/device';
import { useGamepadStore } from '../stores/gamepad';
import { useSettingsStore } from '../stores/settings';
import { useSyncStore } from '../stores/sync';
import { t } from '../i18n/vi';

/** The "Stored on this computer" list, in this order. A new key joins a group (or J adds one). */
export const APP_SETTING_GROUPS = ['theme', 'locale', 'presets', 'tabs', 'toggles', 'colors', 'sidebar', 'demo'] as const;
export type AppSettingGroup = (typeof APP_SETTING_GROUPS)[number];

export interface AppSetting {
  key: string;
  group: AppSettingGroup;
  /** The same rule as the place that reads the key (stricter only where the reader silently fixes a value). */
  valid: (raw: string) => boolean;
}

/** A remembered on/off switch: the readers take '1' as on and '0' as off. */
export const isFlag01 = (raw: string): boolean => raw === '0' || raw === '1';

export const APP_SETTINGS: readonly AppSetting[] = [
  { key: 'ae64.theme', group: 'theme', valid: isThemeChoice },
  { key: 'ae64.locale', group: 'locale', valid: isLocale },
  { key: 'ae64.perf.userPresets', group: 'presets', valid: presetsValid },
  { key: 'ae64.perfTab', group: 'tabs', valid: (r) => asPerfTab(r) !== null },
  { key: 'ae64.perf.depthShading', group: 'toggles', valid: isFlag01 },
  { key: 'ae64.live.keyLock', group: 'toggles', valid: isFlag01 },
  { key: 'ae64.live.colorByResult', group: 'toggles', valid: isFlag01 },
  { key: 'ae64.calibration.showAdc', group: 'toggles', valid: isFlag01 },
  { key: 'ae64.recentColors', group: 'colors', valid: recentValid },
  { key: 'ae64.sidebarCollapsed', group: 'sidebar', valid: isFlag01 },
  { key: 'ae64.demoModel', group: 'demo', valid: isDemoSeed },
];
/** localStorage, never exported, imported or reset: which keyboard this browser connected last (auto-reconnect). */
export const NOT_EXPORTED = ['ae64.lastDevice'] as const;
/** sessionStorage keys. */
export const SESSION_KEYS = [APPCFG_DONE_KEY] as const;

const BY_KEY = new Map(APP_SETTINGS.map((s) => [s.key, s]));
export const PRESETS_KEY = 'ae64.perf.userPresets';
export const MAX_IMPORT_BYTES = 1_048_576;
export const APP_ID = 'ae64-control';

export interface AppSettingsFile {
  app: typeof APP_ID;
  version: string;
  savedAt: string;
  data: Record<string, string>;
}

function getItem(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** The settings of the table that are stored now with a value the app reads as itself. */
export function storedSettings(): Record<string, string> {
  const data: Record<string, string> = {};
  for (const s of APP_SETTINGS) {
    const v = getItem(s.key);
    if (v !== null && s.valid(v)) data[s.key] = v;
  }
  return data;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

export function exportFileName(now: Date): string {
  return `ae64-control-settings-${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}.json`;
}

/** The export file: JSON (indent 2), its name and how many settings it holds. */
export function buildExport(now = new Date()): { json: string; file: string; n: number } {
  const data = storedSettings();
  const body: AppSettingsFile = {
    app: APP_ID,
    version: typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0',
    savedAt: now.toISOString(),
    data,
  };
  return { json: JSON.stringify(body, null, 2), file: exportFileName(now), n: Object.keys(data).length };
}

export type ImportError = 'errSize' | 'errJson' | 'errApp' | 'errKeys' | 'errValue' | 'errEmpty';
export type ParsedImport =
  | { ok: true; data: Record<string, string>; savedAt: string; version: string }
  | { ok: false; error: ImportError; keys?: string };

/** The longest key shown whole in an error; a longer one is cut to 39 characters + "…" (the longest real key has 23). */
export const KEY_SHOWN_MAX = 40;
const shortKey = (k: string): string => {
  const ch = [...k];
  return ch.length > KEY_SHOWN_MAX ? `${ch.slice(0, KEY_SHOWN_MAX - 1).join('')}…` : k;
};

/** At most 3 keys, each at most KEY_SHOWN_MAX characters, then "…". */
function keyList(keys: string[]): string {
  return keys.slice(0, 3).map(shortKey).join(', ') + (keys.length > 3 ? '…' : '');
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks a chosen file, in this order (§3.5). One unknown key or one wrong value refuses the whole file. */
export function parseImport(text: string, size: number): ParsedImport {
  if (size > MAX_IMPORT_BYTES) return { ok: false, error: 'errSize' };
  let file: unknown;
  try { file = JSON.parse(text); } catch { return { ok: false, error: 'errJson' }; }
  if (!isPlainObject(file) || file.app !== APP_ID || !isPlainObject(file.data)) return { ok: false, error: 'errApp' };
  const data = file.data;
  const keys = Object.keys(data);
  const unknown = keys.filter((k) => !BY_KEY.has(k));
  if (unknown.length) return { ok: false, error: 'errKeys', keys: keyList(unknown) };
  const bad = keys.filter((k) => { const v = data[k]; return typeof v !== 'string' || !BY_KEY.get(k)!.valid(v); });
  if (bad.length) return { ok: false, error: 'errValue', keys: keyList(bad) };
  if (!keys.length) return { ok: false, error: 'errEmpty' };
  return {
    ok: true,
    data: data as Record<string, string>,
    savedAt: typeof file.savedAt === 'string' ? file.savedAt : '',
    version: typeof file.version === 'string' ? file.version : '',
  };
}

/** What a reset removes: every `ae64.` key of localStorage (old builds' keys too) except NOT_EXPORTED. */
export function resetKeys(): string[] {
  const out: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k !== null && k.startsWith('ae64.') && !(NOT_EXPORTED as readonly string[]).includes(k)) out.push(k);
  }
  return out;
}

/** The groups of the table that have a key in `keys`, in list order. */
export function groupsOf(keys: Iterable<string>): AppSettingGroup[] {
  const set = new Set([...keys].map((k) => BY_KEY.get(k)?.group).filter((g): g is AppSettingGroup => !!g));
  return APP_SETTING_GROUPS.filter((g) => set.has(g));
}

/** How many presets a stored or imported presets value holds (0 when unreadable). */
export function presetCount(raw: string | null | undefined): number {
  if (!raw) return 0;
  try { const v: unknown = JSON.parse(raw); return Array.isArray(v) ? v.length : 0; } catch { return 0; }
}

/** The page reload, replaceable in tests. */
export const pageReload = { reload: (): void => window.location.reload() };

export function useAppSettings() {
  const device = useDeviceStore();
  const calibration = useCalibrationStore();
  const settings = useSettingsStore();
  const gamepad = useGamepadStore();
  const sync = useSyncStore();

  /**
   * Why the page must not reload now, or null; read fresh every time (device.calibrationLocked() is not reactive).
   * Writes through sync are waited for by sync.flush(); these go straight to the keyboard (exclusive) and flush() does
   * not see them: a polling-rate change (and the USB restart after it), a config restore, gamepad writes and its USB
   * restart, a profile switch.
   */
  function busyNow(): string | null {
    if (calibration.phase !== 'idle' || device.calibrationLocked()) return t('appcfg.busyCal');
    if (device.exclusiveActive || settings.pollingState === 'applying' || settings.pollingState === 'reconnecting' || gamepad.usbBusy) {
      return t('appcfg.busyWrite');
    }
    return null;
  }
  /** For the buttons and the `dl__lock` line only; applyAndReload calls busyNow(). */
  const busyReason = computed(busyNow);

  /**
   * Import (write the file's keys) or reset (remove resetKeys()), then reload. Nothing is written and nothing reloads
   * when the keyboard is busy before or after flush(), when flush() refuses, or when the browser refuses a write (the
   * keys already written get their old values back).
   */
  async function applyAndReload(kind: 'import' | 'reset', data?: Record<string, string>): Promise<void> {
    const before = busyNow();
    if (before) throw new Error(before);
    try {
      await sync.flush();
    } catch (e) {
      throw new Error(t('appcfg.errPending', { msg: e instanceof Error ? e.message : String(e) }));
    }
    // An exclusive write may have started while flush() waited.
    const after = busyNow();
    if (after) throw new Error(after);
    writeKeys(kind === 'import' ? data ?? {} : null);
    setAppcfgDone(kind);
    pageReload.reload();
  }

  return { busyNow, busyReason, applyAndReload };
}

/** Writes `data` (or removes resetKeys() when null), key by key; on a refused write every key touched gets its old value. */
function writeKeys(data: Record<string, string> | null): void {
  const old = new Map<string, string | null>();
  try {
    const keys = data ? Object.keys(data) : resetKeys();
    for (const k of keys) {
      old.set(k, localStorage.getItem(k));
      if (data) localStorage.setItem(k, data[k]);
      else localStorage.removeItem(k);
    }
  } catch {
    for (const [k, v] of old) {
      try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* nothing more to do */ }
    }
    throw new Error(t('appcfg.errWrite'));
  }
}
