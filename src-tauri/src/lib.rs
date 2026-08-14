mod bridge;
mod desktop;

use bridge::{add_account, brand_icon, list_profiles, switch_profile, CoreBridge};
use tauri::{menu::{Menu, MenuItem}, tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent}, Manager, WindowEvent};
use tauri_plugin_autostart::MacosLauncher;

fn show_selector(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[tauri::command]
fn open_selector(app: tauri::AppHandle) {
    show_selector(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_selector(app)))
        .plugin(tauri_plugin_autostart::init(MacosLauncher::LaunchAgent, Some(vec!["--hidden"])))
        .setup(|app| {
            app.manage(CoreBridge::discover(app.handle())?);
            desktop::configure_shell(app)?;

            let choose = MenuItem::with_id(app, "choose", "Choose a profile", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&choose, &quit])?;
            let tray = TrayIconBuilder::with_id("codex-profile")
                .tooltip("Codex Profile")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "choose" => show_selector(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_selector(tray.app_handle());
                    }
                })
                .build(app)?;
            let codex_icon = desktop::installed_codex_icon_path()
                .and_then(|path| tauri::image::Image::from_path(path).ok());
            if let Some(icon) = codex_icon {
                tray.set_icon(Some(icon.clone()))?;
                if let Some(window) = app.get_webview_window("main") { window.set_icon(icon.clone())?; }
                if let Some(window) = app.get_webview_window("launcher") { window.set_icon(icon)?; }
            } else if let Some(icon) = app.default_window_icon() {
                tray.set_icon(Some(icon.clone()))?;
            }

            let hidden = std::env::args().any(|arg| arg == "--hidden");
            if hidden {
                if let Some(window) = app.get_webview_window("main") { window.hide()?; }
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "launcher" && matches!(event, WindowEvent::Focused(true)) {
                show_selector(window.app_handle());
                return;
            }
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .invoke_handler(tauri::generate_handler![list_profiles, switch_profile, add_account, brand_icon, open_selector])
        .run(tauri::generate_context!())
        .expect("error while running Codex Profile");
}
