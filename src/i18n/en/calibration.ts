// English strings for the calibration area. Must have exactly the keys of calibrationVi (../calibration.ts).
import type { calibrationVi } from '../calibration';

export const calibrationEn: Record<keyof typeof calibrationVi, string> = {
  'calibration.intro': 'Calibration maps the exact top and bottom positions of each switch, ensuring Actuation and Rapid Trigger work as configured.',
  'calibration.steps': 'Steps',
  'calibration.step1': 'Click “Start calibration”. Do not touch any keys when starting.',
  'calibration.step2': 'Press each key fully down and release. Keys turn green once calibrated.',
  'calibration.step3': 'When all keys are pressed, click “Finish” to save to the keyboard.',
  'calibration.start': 'Start calibration',
  'calibration.finish': 'Finish',
  'calibration.cancel': 'Cancel',
  'calibration.confirmTitle': 'Start calibration?',
  'calibration.confirmBody': 'During calibration, normal typing may not work. Release all keys, click Start, then press each key all the way down and release.',
  'calibration.progress': '{n}/64 keys calibrated',
  'calibration.progressSession': '{n}/64 keys calibrated this session',
  'calibration.legendNone': 'Not calibrated',
  'calibration.legendDone': 'Calibrated',
  'calibration.legendNew': 'Just calibrated',
  'calibration.status': 'Status',
  'calibration.running': 'Calibrating — press each key fully down and release',
  'calibration.saved': 'Calibration saved.',
  'calibration.cancelled': 'Calibration cancelled — not saved.',
  'calibration.readOnly': 'Board is not in write allowlist — calibration unavailable.',
  'calibration.failed': 'Calibration failed: {error}',
  'calibration.uncalibrated': '{n} uncalibrated keys — consider recalibrating.',
  'calibration.adcHint': 'Small numbers show raw Hall sensor ADC values.',
  'calibration.demoHint': 'Demo: hold any key on your keyboard to simulate a full bottom-out.',
};
