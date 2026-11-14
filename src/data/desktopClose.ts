// The desktop app (Tauri) holds its window open while a firmware session runs (DESIGN FW §3.4): `beforeunload` does not stop a
// window close there. The page tells the shell when to hold (`hold_close`); a close then fires CLOSE_BLOCKED_EVENT on the page,
// which asks the user (stay, or close anyway: `force_close`). In the web build every call here does nothing.

type TauriInternals = { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };

/** The shell's IPC, or null (the web build); replaceable in tests. */
export const desktopShell = {
  get(): TauriInternals | null {
    if (typeof __DESKTOP__ === 'undefined' || !__DESKTOP__ || typeof window === 'undefined') return null;
    return (window as unknown as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ ?? null;
  },
};

/** Fired on window by the shell when it refused a close. */
export const CLOSE_BLOCKED_EVENT = 'ae64:close-blocked';

export function holdWindowClose(on: boolean): void {
  void desktopShell.get()?.invoke('hold_close', { on }).catch(() => undefined);
}

export function forceWindowClose(): void {
  void desktopShell.get()?.invoke('force_close').catch(() => undefined);
}
