//! Windows-only shell integration. Account switching remains in the shared Node core.

use std::{os::windows::process::CommandExt, path::PathBuf, process::Command, thread, time::Duration};
use tauri::{App, Manager, PhysicalPosition, Runtime};
#[cfg(not(debug_assertions))]
use tauri_plugin_autostart::ManagerExt;
use windows_sys::Win32::{
    Foundation::{CloseHandle, HWND, LPARAM, RECT},
    System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_QUERY_LIMITED_INFORMATION},
    UI::WindowsAndMessaging::{EnumWindows, GetWindow, GetWindowRect, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER},
};

struct CodexWindowSearch {
    bounds: Option<RECT>,
}

unsafe extern "system" fn find_codex_window(hwnd: HWND, parameter: LPARAM) -> i32 {
    if IsWindowVisible(hwnd) == 0 || !GetWindow(hwnd, GW_OWNER).is_null() {
        return 1;
    }

    let mut process_id = 0u32;
    GetWindowThreadProcessId(hwnd, &mut process_id);
    if process_id == 0 {
        return 1;
    }

    let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id);
    if process.is_null() {
        return 1;
    }
    let mut path_buffer = vec![0u16; 32_768];
    let mut path_length = path_buffer.len() as u32;
    let resolved = QueryFullProcessImageNameW(process, 0, path_buffer.as_mut_ptr(), &mut path_length) != 0;
    CloseHandle(process);
    if !resolved {
        return 1;
    }

    let executable = String::from_utf16_lossy(&path_buffer[..path_length as usize]).to_ascii_lowercase();
    let is_codex = executable.ends_with("\\app\\chatgpt.exe")
        && executable.contains("\\windowsapps\\openai.codex_");
    if !is_codex {
        return 1;
    }

    let mut bounds = RECT::default();
    if GetWindowRect(hwnd, &mut bounds) != 0 && bounds.right > bounds.left && bounds.bottom > bounds.top {
        let search = &mut *(parameter as *mut CodexWindowSearch);
        search.bounds = Some(bounds);
        return 0;
    }
    1
}

fn codex_window_bounds() -> Option<RECT> {
    let mut search = CodexWindowSearch { bounds: None };
    unsafe {
        EnumWindows(Some(find_codex_window), &mut search as *mut CodexWindowSearch as LPARAM);
    }
    search.bounds
}

fn start_overlay_monitor<R: Runtime>(app: &App<R>) {
    let handle = app.handle().clone();
    thread::spawn(move || loop {
        if let Some(launcher) = handle.get_webview_window("launcher") {
            if let Some(bounds) = codex_window_bounds() {
                let size = launcher.outer_size().unwrap_or(tauri::PhysicalSize::new(58, 58));
                let x = bounds.right.saturating_sub(size.width as i32).saturating_sub(42);
                let y = bounds.bottom.saturating_sub(size.height as i32).saturating_sub(42);
                let _ = launcher.set_position(PhysicalPosition::new(x, y));
                let _ = launcher.show();
            } else {
                let _ = launcher.hide();
            }
        }
        thread::sleep(Duration::from_millis(700));
    });
}

pub fn installed_codex_icon_path() -> Option<PathBuf> {
    if let Some(configured) = std::env::var_os("CODEX_PROFILE_CODEX_ICON") {
        let path = PathBuf::from(configured);
        if path.is_file() {
            return Some(path);
        }
    }
    let script = "$package = Get-AppxPackage OpenAI.Codex | Select-Object -First 1; if ($package) { $icon = Join-Path $package.InstallLocation 'app\\resources\\chatgpt-tray-dark.ico'; if (Test-Path -LiteralPath $icon) { $icon } }";
    let output = Command::new("powershell.exe")
        .args(["-NoProfile", "-Command", script])
        .creation_flags(0x08000000)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = PathBuf::from(String::from_utf8_lossy(&output.stdout).trim().to_string());
    path.is_file().then_some(path)
}

pub fn configure_shell<R: Runtime>(app: &App<R>) -> Result<(), Box<dyn std::error::Error>> {
    // Never register an unpackaged debug build in the user's startup apps.
    #[cfg(not(debug_assertions))]
    {
        let autolaunch = app.autolaunch();
        if !autolaunch.is_enabled()? {
            autolaunch.enable()?;
        }
    }

    #[cfg(debug_assertions)]
    let _ = app;

    start_overlay_monitor(app);

    Ok(())
}
