/**
 * WX7: a file dragged over the page and dropped where no drop zone takes it would be opened by the browser in this tab,
 * which ends the page and the keyboard session with it. The zones (the firmware file step, the wallpaper box) prevent
 * the default themselves; this window-level guard (bubble phase, so it runs after them) prevents it for every drag that
 * carries files and that no zone took, and shows "no drop" on the way. Drags without files (a macro row) are left alone.
 */
const carriesFiles = (e: DragEvent): boolean => !!e.dataTransfer && Array.from(e.dataTransfer.types ?? []).includes('Files');

export function installDropGuard(target: Window = window): () => void {
  const onOver = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
  };
  const onDrop = (e: DragEvent) => {
    if (e.defaultPrevented || !carriesFiles(e)) return;
    e.preventDefault();
  };
  target.addEventListener('dragover', onOver);
  target.addEventListener('drop', onDrop);
  return () => {
    target.removeEventListener('dragover', onOver);
    target.removeEventListener('drop', onDrop);
  };
}
