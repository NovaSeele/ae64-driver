// What the wallpaper layer shows (DESIGN J §3.5): the state the app shell reads. Small on purpose: the image, IndexedDB, the
// guard and the Worker are in wallpaperRuntime.ts, loaded after the first paint (startWallpaper) or by the settings card.
import { computed, reactive } from 'vue';
import { PANEL_MIN, readWallPrefs, type WallPrefs } from './wallpaperPrefs';

export interface WallMeta { name: string; type: string; size: number; w: number; h: number; animated: boolean }
/** The other side's floor (Graphite ↔ Light) when it is at least 20 points lower (§3.6). */
export interface WallHint { kind: 'bright' | 'dark'; theme: string; veil: number }

export const wallState = reactive({
  /** A stored image is loaded (its file details); null: no wallpaper. */
  meta: null as WallMeta | null,
  /** The URL shown (blob: of the image, or of its first frame under reduced motion); set once decoded. */
  url: null as string | null,
  prefs: readWallPrefs() as WallPrefs,
  /** The floors of this image on the theme open now (0..1). */
  floor: { veil: 0, panel: PANEL_MIN },
  hint: null as WallHint | null,
  reducedMotion: false,
});

/** The user's values stay in ae64.wallpaper; the layer never goes below the floors (§3.5). */
export const veilApplied = computed(() => Math.max(wallState.prefs.veil, wallState.floor.veil));
export const panelApplied = computed(() => Math.max(wallState.prefs.panel, wallState.floor.panel, PANEL_MIN));

let started: Promise<unknown> | null = null;
/** Loads the runtime (and the stored image, if any) once the first page is painted: start-up never waits for IndexedDB. */
export function startWallpaper(): Promise<unknown> {
  if (!started) {
    started = new Promise<void>((resolve) => {
      const later = () => setTimeout(resolve, 0);
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(later);
      else later();
    }).then(() => import('./wallpaperRuntime')).then((m) => m.bootWallpaper()).catch(() => { /* no wallpaper */ });
  }
  return started;
}
