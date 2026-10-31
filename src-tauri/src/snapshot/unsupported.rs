//! Windows and macOS have no capture backend yet. The module keeps the same
//! command surface as the Linux host so the bridge and settings page report an
//! explicit unsupported state instead of a missing command.

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{json, Value};
use tauri::State;

pub struct SnapShotHost;

impl SnapShotHost {
    pub fn new(_state_dir: PathBuf, _app_id: String) -> Self {
        Self
    }
}

fn unsupported() -> String {
    "SnapShots are not available on this platform yet.".to_string()
}

#[tauri::command]
pub async fn snap_shot_configure(
    settings: Value,
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = (settings, host, app);
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_state(host: State<'_, Arc<SnapShotHost>>) -> Result<Value, String> {
    let _ = host;
    Ok(json!({
        "mode": "unavailable",
        "shortcut": { "kind": "both-shift-keys" },
        "shortcutRegistered": false,
        "shortcutMessage": Value::Null,
        "message": unsupported(),
    }))
}

#[tauri::command]
pub async fn snap_shot_capture(
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = (host, app);
    Err(unsupported())
}

#[tauri::command]
pub async fn snap_shot_check_shortcut(
    shortcut: Value,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Value, String> {
    let _ = (shortcut, host);
    Ok(json!({ "available": false, "message": unsupported() }))
}

#[tauri::command]
pub async fn snap_shot_setup(
    action: String,
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<(), String> {
    let _ = (action, host, app);
    Err(unsupported())
}

#[tauri::command]
pub async fn snap_shot_preview_config(
    request: Value,
    host: State<'_, Arc<SnapShotHost>>,
    app: tauri::AppHandle,
) -> Result<Option<Value>, String> {
    let _ = (request, host, app);
    Err(unsupported())
}

#[tauri::command]
pub async fn snap_shot_apply_config(
    preview_id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Value, String> {
    let _ = (preview_id, host);
    Err(unsupported())
}

#[tauri::command]
pub async fn snap_shot_set_shortcut_suppressed(
    suppressed: bool,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    let _ = (suppressed, host);
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_list_pending(
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Vec<Value>, String> {
    let _ = host;
    Ok(Vec::new())
}

#[tauri::command]
pub async fn snap_shot_read(
    id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<Value, String> {
    let _ = (id, host);
    Err(unsupported())
}

#[tauri::command]
pub async fn snap_shot_acknowledge(
    id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    let _ = (id, host);
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_set_animation_destination(
    id: String,
    destination: Value,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    let _ = (id, destination, host);
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_dismiss_animation(
    id: String,
    host: State<'_, Arc<SnapShotHost>>,
) -> Result<(), String> {
    let _ = (id, host);
    Ok(())
}

#[tauri::command]
pub async fn snap_shot_request_permissions(include_accessibility: bool) -> Result<(), String> {
    let _ = include_accessibility;
    Ok(())
}
