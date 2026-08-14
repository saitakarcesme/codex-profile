use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::{path::{Path, PathBuf}, process::Command};
use tauri::{AppHandle, Manager, State};
use crate::desktop;

#[derive(Clone)]
pub struct CoreBridge {
    node: PathBuf,
    cli: PathBuf,
    cwd: PathBuf,
}

impl CoreBridge {
    pub fn discover(app: &AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let node = discover_node()?;
        let manifest_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf();
        let resource_root = app.path().resource_dir()?;
        let candidates = [
            std::env::var_os("CODEX_PROFILE_CLI_PATH").map(PathBuf::from),
            Some(manifest_root.join("bin/codex-profile.js")),
            Some(resource_root.join("core/bin/codex-profile.js")),
            Some(resource_root.join("resources/core/bin/codex-profile.js")),
        ];
        let cli = candidates.into_iter().flatten().find(|path| path.is_file())
            .ok_or("Codex Profile Node core could not be located")?;
        let cwd = cli.parent().and_then(Path::parent).unwrap_or(&manifest_root).to_path_buf();
        Ok(Self { node, cli, cwd })
    }

    fn execute(&self, args: &[&str]) -> Result<String, String> {
        let output = Command::new(&self.node)
            .arg(&self.cli)
            .args(args)
            .current_dir(&self.cwd)
            .env("CODEX_PROFILE_DESKTOP_SHELL", "tauri")
            .output()
            .map_err(|error| format!("Could not start Codex Profile core: {error}"))?;
        if !output.status.success() {
            let message = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(if message.is_empty() { "Codex Profile operation failed".into() } else { message });
        }
        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }
}

fn discover_node() -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(value) = std::env::var_os("CODEX_PROFILE_NODE_BIN") {
        let path = PathBuf::from(value);
        if path.is_file() { return Ok(path); }
    }
    let mut candidates = Vec::new();
    if cfg!(windows) {
        if let Some(program_files) = std::env::var_os("ProgramFiles") {
            candidates.push(PathBuf::from(program_files).join("nodejs/node.exe"));
        }
    } else {
        candidates.extend([PathBuf::from("/opt/homebrew/bin/node"), PathBuf::from("/usr/local/bin/node"), PathBuf::from("/usr/bin/node")]);
    }
    if let Some(path) = std::env::var_os("PATH") {
        let executable = if cfg!(windows) { "node.exe" } else { "node" };
        candidates.extend(std::env::split_paths(&path).map(|entry| entry.join(executable)));
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(|| "Node.js 20+ was not found".into())
}

fn avatar_data_url(path: &str) -> Option<String> {
    let file = Path::new(path);
    let bytes = std::fs::read(file).ok()?;
    if bytes.len() > 5 * 1024 * 1024 { return None; }
    let mime = match file.extension()?.to_string_lossy().to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "webp" => "image/webp",
        _ => "image/jpeg",
    };
    Some(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
pub async fn list_profiles(bridge: State<'_, CoreBridge>) -> Result<Value, String> {
    let bridge = bridge.inner().clone();
    let raw = tauri::async_runtime::spawn_blocking(move || bridge.execute(&["list", "--json"]))
        .await
        .map_err(|error| format!("Codex Profile worker stopped unexpectedly: {error}"))??;
    let mut value: Value = serde_json::from_str(&raw).map_err(|_| "Codex Profile returned invalid profile data")?;
    if let Some(profiles) = value.get_mut("profiles").and_then(Value::as_array_mut) {
        for profile in profiles {
            let avatar = profile.get("avatar").and_then(Value::as_str).and_then(avatar_data_url);
            if let Some(object) = profile.as_object_mut() {
                object.remove("avatar");
                object.insert("avatarDataUrl".into(), avatar.map(Value::String).unwrap_or(Value::Null));
                object.remove("email");
            }
        }
    }
    Ok(json!({ "profiles": value.get("profiles").cloned().unwrap_or_else(|| json!([])) }))
}

#[tauri::command]
pub async fn switch_profile(profile_id: String, bridge: State<'_, CoreBridge>) -> Result<(), String> {
    if profile_id.is_empty() || !profile_id.chars().all(|c| c.is_ascii_hexdigit() || c == '-') { return Err("Invalid profile identifier".into()); }
    let bridge = bridge.inner().clone();
    tauri::async_runtime::spawn_blocking(move || bridge.execute(&["desktop", "use", &profile_id]))
        .await
        .map_err(|error| format!("Codex Profile worker stopped unexpectedly: {error}"))??;
    Ok(())
}

#[tauri::command]
pub async fn add_account(bridge: State<'_, CoreBridge>) -> Result<(), String> {
    let bridge = bridge.inner().clone();
    tauri::async_runtime::spawn_blocking(move || bridge.execute(&["add"]))
        .await
        .map_err(|error| format!("Codex Profile worker stopped unexpectedly: {error}"))??;
    Ok(())
}

#[tauri::command]
pub fn brand_icon() -> Result<String, String> {
    let path = desktop::installed_codex_icon_path().ok_or("The installed Codex icon could not be found")?;
    let bytes = std::fs::read(&path).map_err(|_| "The installed Codex icon could not be read")?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err("The installed Codex icon is unexpectedly large".into());
    }
    let mime = match path.extension().and_then(|value| value.to_str()).unwrap_or_default().to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "ico" => "image/x-icon",
        _ => return Err("The installed Codex icon format is not supported".into()),
    };
    Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}
