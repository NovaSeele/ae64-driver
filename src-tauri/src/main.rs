// Hides the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::Manager;

// The page talks to the keyboard itself (WebHID); this shell only hosts it. One exception (DESIGN FW §3.4): while a firmware
// session runs the page asks the shell to hold the window open; closing it then asks the page, which shows a dialog.
static HOLD_CLOSE: AtomicBool = AtomicBool::new(false);

/// The page's firmware session started (true) or ended (false).
#[tauri::command]
fn hold_close(on: bool) {
    HOLD_CLOSE.store(on, Ordering::SeqCst);
}

/// "Close anyway" in the page's dialog.
#[tauri::command]
fn force_close(window: tauri::Window) {
    HOLD_CLOSE.store(false, Ordering::SeqCst);
    let _ = window.close();
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![hold_close, force_close])
        // A page (re)load starts without a session: release the hold, so a webview that reloaded mid-session can still be
        // closed (FW review FW-2). The page also calls hold_close(false) at start-up.
        .on_page_load(|_webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                HOLD_CLOSE.store(false, Ordering::SeqCst);
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if HOLD_CLOSE.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(w) = window.app_handle().get_webview_window(window.label()) {
                        let _ = w.eval("window.dispatchEvent(new Event('ae64:close-blocked'))");
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running AE64 Control");
}
