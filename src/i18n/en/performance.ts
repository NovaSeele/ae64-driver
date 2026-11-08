// Performance page strings (English). Same keys as ../performance.ts.
import type { performanceVi } from '../performance';

export const performanceEn: Record<keyof typeof performanceVi, string> = {
  'perf.rtLinkLabel': 'Link press/release',
  'perf.rtLinkHint': 'On: changing press or release sensitivity sets both to the same value. Off: edit each separately.',
  'perf.unknownModes': '{n|# key uses|# keys use} an unknown firmware mode — left unchanged, not editable.',
};
