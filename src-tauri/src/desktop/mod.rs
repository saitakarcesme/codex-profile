#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "macos")]
pub mod macos;

#[cfg(target_os = "windows")]
pub use windows::{configure_shell, installed_codex_icon_path};

#[cfg(target_os = "macos")]
pub use macos::{configure_shell, installed_codex_icon_path};

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn configure_shell<R: tauri::Runtime>(
    _app: &tauri::App<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    Ok(())
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
pub fn installed_codex_icon_path() -> Option<std::path::PathBuf> {
    None
}
