// Hides the console window in release builds on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// The page talks to the keyboard itself (WebHID); this shell only hosts it.
fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running AE64 Max Control");
}
