// Session undo/redo. Entries mutate page-store state and enqueue the same sync jobs as the original edit.
import { defineStore } from 'pinia';
import { computed, shallowRef } from 'vue';

export interface HistoryEntry {
  label: string;
  undo: () => void;
  redo: () => void;
  /** Consecutive pushes with the same key within COALESCE_MS merge into one entry (slider drags, typing). */
  coalesce?: string;
}

const MAX_ENTRIES = 200;
const COALESCE_MS = 800;

interface Stored extends HistoryEntry { at: number }

export const useHistoryStore = defineStore('history', () => {
  const undoStack = shallowRef<Stored[]>([]);
  const redoStack = shallowRef<Stored[]>([]);
  const canUndo = computed(() => undoStack.value.length > 0);
  const canRedo = computed(() => redoStack.value.length > 0);
  const undoLabel = computed(() => undoStack.value.at(-1)?.label ?? null);
  const redoLabel = computed(() => redoStack.value.at(-1)?.label ?? null);

  function push(entry: HistoryEntry): void {
    const now = Date.now();
    const top = undoStack.value.at(-1);
    redoStack.value = [];
    if (entry.coalesce && top?.coalesce === entry.coalesce && now - top.at < COALESCE_MS) {
      // Keep the oldest undo (state before the gesture), take the newest redo.
      undoStack.value = [...undoStack.value.slice(0, -1), { ...top, redo: entry.redo, at: now }];
      return;
    }
    undoStack.value = [...undoStack.value, { ...entry, at: now }].slice(-MAX_ENTRIES);
  }

  function undo(): void {
    const e = undoStack.value.at(-1);
    if (!e) return;
    undoStack.value = undoStack.value.slice(0, -1);
    e.undo();
    redoStack.value = [...redoStack.value, { ...e, coalesce: undefined }];
  }

  function redo(): void {
    const e = redoStack.value.at(-1);
    if (!e) return;
    redoStack.value = redoStack.value.slice(0, -1);
    e.redo();
    undoStack.value = [...undoStack.value, { ...e, coalesce: undefined }];
  }

  function clear(): void {
    undoStack.value = [];
    redoStack.value = [];
  }

  /** Global Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z. Text inputs keep their native undo. Returns a remover. */
  function installShortcuts(target: Window = window): () => void {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && (el as HTMLInputElement).type !== 'range'))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
    };
    target.addEventListener('keydown', onKey);
    return () => target.removeEventListener('keydown', onKey);
  }

  return { canUndo, canRedo, undoLabel, redoLabel, push, undo, redo, clear, installShortcuts };
});
