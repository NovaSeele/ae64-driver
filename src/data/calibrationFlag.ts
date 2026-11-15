// W-12: calibration lives on the keyboard, not in the page. After `02 06 00`, a reload, a crash or a closed tab leaves the
// keyboard calibrating, and the next page would write travel records to it. The app keeps its own note of the keyboard it put
// into calibration (its serial) until a stop is answered; the next connection of that keyboard stops it first (device.init).

const KEY = 'ae64.calibrating';

export interface CalibrationFlag {
  /** The serial (hex) of the keyboard `02 06 00` was sent to. */
  serial: string;
  /** When (ms since the epoch). */
  at: number;
}

export function readCalibrationFlag(): CalibrationFlag | null {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { serial?: unknown; at?: unknown } | null;
    return v && typeof v.serial === 'string' && v.serial !== '' ? { serial: v.serial, at: typeof v.at === 'number' ? v.at : 0 } : null;
  } catch {
    return null;
  }
}

/** Set just before `02 06 00` is sent (storage may throw: then only the transport's own lock remains). */
export function writeCalibrationFlag(serial: string | null | undefined): void {
  if (!serial) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ serial, at: Date.now() } satisfies CalibrationFlag));
  } catch {
    // storage unavailable
  }
}

/** A stop was answered by the keyboard of `serial`: it is out of calibration (a flag naming another keyboard is kept). */
export function clearCalibrationFlag(serial: string | null | undefined): void {
  const f = readCalibrationFlag();
  if (!f || (serial && f.serial !== serial)) return;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}
