//! macOS-only shell integration. Account switching remains in the shared Node core.

use std::path::PathBuf;
use tauri::{App, Runtime};
#[cfg(not(debug_assertions))]
use tauri_plugin_autostart::ManagerExt;

pub fn configure_shell<R: Runtime>(app: &App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // The plugin is configured with LaunchAgent in lib.rs. Keep development builds
    // out of Login Items and register only the signed/release application.
    #[cfg(not(debug_assertions))]
    {
        let autolaunch = app.autolaunch();
        if !autolaunch.is_enabled()? {
            autolaunch.enable()?;
        }
    }

    #[cfg(debug_assertions)]
    let _ = app;

    Ok(())
}

pub fn installed_codex_icon_path() -> Option<PathBuf> {
    [
        "/Applications/Codex.app/Contents/Resources/icon.png",
        "/Applications/ChatGPT.app/Contents/Resources/icon.png",
    ]
    .into_iter()
    .map(PathBuf::from)
    .find(|path| path.is_file())
}

pub fn focus_codex_window() {
    let _ = std::process::Command::new("osascript")
        .args(["-e", "tell application \"Codex\" to activate"])
        .output();
}
