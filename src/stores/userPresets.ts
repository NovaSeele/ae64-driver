// Hành trình presets saved by the user. They live in this browser's localStorage only: saving or deleting one never
// touches the keyboard. What is read back is untrusted (a hand edit or an old build can leave anything there), so every
// entry is validated and clamped on load; applying one still goes through performance.apply, which clamps again to each
// key's own range and the connected model's precision.
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { LIMITS } from './performance';

export interface UserPreset {
  id: string;
  name: string;
  /** 0 Standard, 1 Rapid Trigger. */
  mode: 0 | 1;
  /** Rapid Trigger only: true = continuous (firmware mode 1), false = mode 2. */
  continuous: boolean;
  /** mm: one actuation point for Standard and Rapid Trigger. */
  actuation: number;
  rtPress: number;
  rtRelease: number;
  deadTop: number;
  deadBottom: number;
}

export const USER_PRESET_MAX = 6;
export const USER_PRESET_NAME_MAX = 24;
/** Ceiling for a stored actuation (mm). The real limit is each key's own travel range, applied when the preset is used. */
const ACTUATION_CEIL = 10;
const STORAGE_KEY = 'ae64.perf.userPresets';

const num = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v)) * 1000) / 1000 : null;

/** A stored entry made safe, or null when its shape or types are wrong (numbers are clamped, not rejected). */
export function sanitizePreset(raw: unknown): UserPreset | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id || r.id.length > 40) return null;
  if (typeof r.name !== 'string') return null;
  const name = r.name.trim();
  if (!name || name.length > USER_PRESET_NAME_MAX) return null;
  if (r.mode !== 0 && r.mode !== 1) return null;
  if (typeof r.continuous !== 'boolean') return null;
  const actuation = num(r.actuation, LIMITS.actuationMin, ACTUATION_CEIL);
  const rtPress = num(r.rtPress, LIMITS.rtMin, LIMITS.rtMax);
  const rtRelease = num(r.rtRelease, LIMITS.rtMin, LIMITS.rtMax);
  const deadTop = num(r.deadTop, 0, LIMITS.deadMax);
  const deadBottom = num(r.deadBottom, 0, LIMITS.deadMax);
  if (actuation === null || rtPress === null || rtRelease === null || deadTop === null || deadBottom === null) return null;
  return { id: r.id, name, mode: r.mode, continuous: r.continuous, actuation, rtPress, rtRelease, deadTop, deadBottom };
}

function read(): UserPreset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    const out: UserPreset[] = [];
    for (const raw of parsed) {
      const p = sanitizePreset(raw);
      if (p && !out.some((o) => o.id === p.id)) out.push(p);
    }
    return out.slice(0, USER_PRESET_MAX);
  } catch {
    return [];
  }
}

export const useUserPresetsStore = defineStore('userPresets', () => {
  const presets = ref<UserPreset[]>(read());

  function persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(presets.value));
    } catch {
      // storage unavailable or full: the presets stay for this session only
    }
  }

  /** Saves the values under a name. Returns the new preset, or null when the name is empty/too long or 6 are saved already. */
  function add(name: string, values: Omit<UserPreset, 'id' | 'name'>): UserPreset | null {
    if (presets.value.length >= USER_PRESET_MAX) return null;
    const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const p = sanitizePreset({ ...values, id, name });
    if (!p) return null;
    presets.value = [...presets.value, p];
    persist();
    return p;
  }

  function remove(id: string): void {
    presets.value = presets.value.filter((p) => p.id !== id);
    persist();
  }

  return { presets, add, remove };
});
