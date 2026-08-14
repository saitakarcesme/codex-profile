#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub use windows::{configure_shell, focus_codex_window};

#[cfg(target_os = "macos")]
pub use macos::{configure_shell, focus_codex_window};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn configure_shell<R: tauri::Runtime>(
    _app: &tauri::App<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn focus_codex_window() {}
