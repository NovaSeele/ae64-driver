import type { Router } from 'vue-router';

/**
 * WX7 4a: a lazy chunk that does not load (the release this window runs was replaced and its files are gone, or the
 * network dropped) is reported to `onFail`, which shows a note that a newer version is installed, with a reload button.
 * Nothing here reloads the page: a reload while the keyboard is being written can leave it half-written, so the user
 * presses the button (and `reloadNow` still waits for queued edits and refuses during a write or calibration).
 */
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Failed to load module script|Unable to preload CSS|error loading dynamically imported module/i;

export function isChunkLoadError(err: unknown): boolean {
  if (!err) return false;
  const name = (err as { name?: unknown }).name;
  if (name === 'ChunkLoadError') return true;
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : String((err as { message?: unknown }).message ?? '');
  return CHUNK_ERROR.test(msg);
}

export function installChunkGuard(router: Pick<Router, 'onError'>, onFail: () => void, target: Window = window): () => void {
  // Vite dispatches this before it throws; the default is left alone, so the navigation fails and the page stays as it is.
  const onPreload = () => onFail();
  target.addEventListener('vite:preloadError', onPreload);
  const removeRouter = router.onError((err) => {
    if (isChunkLoadError(err)) onFail();
  });
  return () => {
    target.removeEventListener('vite:preloadError', onPreload);
    removeRouter();
  };
}
