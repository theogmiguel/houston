#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

pub mod confirm;
mod corner;
mod gtk_host;
pub(crate) mod id;
pub mod mcp_tools;
mod picker;
mod rect;
pub mod relay_client;
mod state;
mod suppress;
mod webkit;

#[cfg(target_os = "windows")]
pub(crate) mod webview2_commands;
#[cfg(target_os = "windows")]
pub(crate) mod webview2_engine;
#[cfg(target_os = "windows")]
pub(crate) mod webview2_host;

pub mod selftest;
pub(crate) mod tool_refs;

pub use rect::{Rect, RectSpec};

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};

const HOST_WINDOW: &str = gtk_host::HOST_WINDOW;

const DETACHED_WINDOW_URL: &str =
    "data:text/html,<html><body style=\"margin:0;background:%23151515\"></body></html>";

pub const DETACHED_CLOSED_EVENT: &str = "browser://detached-closed";

fn detached_window_to_close(window_label: &str) -> Option<&str> {
    (window_label != HOST_WINDOW).then_some(window_label)
}

pub(crate) fn popup_event_target() -> &'static str {
    HOST_WINDOW
}

fn detached_window_label(id: &str) -> String {
    format!("tr-browser-window-{id}")
}

fn child_data_dir_for(state_dir: &Path) -> PathBuf {
    state_dir.join("browser-webview")
}

const CHILD_DATA_DIR_NAME: &str = "browser-webview";

fn browsing_data_size_under(dir: &Path) -> Result<u64, String> {
    let meta = match std::fs::symlink_metadata(dir) {
        Ok(meta) => meta,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => {
            return Err(format!(
                "browser: cannot stat the browser store {dir:?}: {err}"
            ))
        }
    };
    if !meta.is_dir() {
        return Err(format!(
            "browser: the browser store {dir:?} is not a directory (it is {:?}); refusing to \
             measure it",
            meta.file_type()
        ));
    }
    let mut total = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(next) = stack.pop() {
        let entries = std::fs::read_dir(&next)
            .map_err(|err| format!("browser: cannot read the browser store {next:?}: {err}"))?;
        for entry in entries {
            let entry =
                entry.map_err(|err| format!("browser: cannot read an entry in {next:?}: {err}"))?;
            let meta = match entry.path().symlink_metadata() {
                Ok(meta) => meta,
                Err(_) => continue,
            };
            if meta.is_dir() {
                stack.push(entry.path());
            } else {
                total = total.saturating_add(meta.len());
            }
        }
    }
    Ok(total)
}

fn clear_browsing_data_under(dir: &Path, live_ids: &[String]) -> Result<u64, String> {
    if !live_ids.is_empty() {
        return Err(format!(
            "browser: {} browser pane(s) are still live ({live_ids:?}); close them before \
             clearing browsing data -- WebKit holds this store open and would rewrite it at \
             exit, so clearing it now would neither take effect nor leave the store intact",
            live_ids.len()
        ));
    }
    if dir.file_name().and_then(|name| name.to_str()) != Some(CHILD_DATA_DIR_NAME) {
        return Err(format!(
            "browser: refusing to clear {dir:?}: a browser store must be a directory named \
             {CHILD_DATA_DIR_NAME:?}, and deleting anything else would take the channel's own \
             state with it"
        ));
    }
    match std::fs::symlink_metadata(dir) {
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(err) => {
            return Err(format!(
                "browser: cannot stat the browser store {dir:?}: {err}"
            ))
        }
        Ok(meta) if meta.file_type().is_symlink() => {
            return Err(format!(
                "browser: refusing to clear {dir:?}: it is a symlink, and clearing it would \
                 delete its target rather than the browser store"
            ));
        }
        Ok(meta) if !meta.is_dir() => {
            return Err(format!(
                "browser: refusing to clear {dir:?}: it is not a directory (it is {:?})",
                meta.file_type()
            ));
        }
        Ok(_) => {}
    }
    let reclaimed = browsing_data_size_under(dir)?;
    std::fs::remove_dir_all(dir)
        .map_err(|err| format!("browser: could not clear the browser store {dir:?}: {err}"))?;
    Ok(reclaimed)
}

#[tauri::command]
pub fn browser_browsing_data_size() -> Result<u64, String> {
    let state_dir = houston_core::paths::config_dir()
        .map_err(|err| format!("browser: cannot resolve state directory: {err}"))?;
    browsing_data_size_under(&child_data_dir_for(&state_dir))
}

#[tauri::command]
pub fn browser_clear_browsing_data(registry: State<'_, BrowserRegistry>) -> Result<u64, String> {
    let live_ids: Vec<String> = {
        let state = lock_registry(&registry)?;
        state.children.keys().cloned().collect()
    };
    let state_dir = houston_core::paths::config_dir()
        .map_err(|err| format!("browser: cannot resolve state directory: {err}"))?;
    clear_browsing_data_under(&child_data_dir_for(&state_dir), &live_ids)
}

pub const MAX_LIVE_CHILDREN: usize = 8;

#[derive(Debug, Clone)]
struct ChildEntry {
    label: String,
    window_label: String,
    workspace_id: Option<String>,
    last_rect: Rect,
    suppressed: suppress::SuppressionSet,
    closing: bool,
    #[allow(dead_code)]
    fullscreen: bool,
    sticky: state::Sticky,
    last_state: Option<state::BrowserState>,
    tool_refs: tool_refs::RefStore,
    #[allow(dead_code)]
    generation: u64,
    picker: Option<PickerState>,
}

#[derive(Debug, Clone)]
struct PickerState {
    token: String,
    label: String,
}

#[derive(Default)]
struct RegistryState {
    children: BTreeMap<String, ChildEntry>,
    generations: BTreeMap<String, u64>,
}

#[derive(Default)]
pub struct BrowserRegistry(Mutex<RegistryState>);

impl BrowserRegistry {
    pub fn new() -> Self {
        Self::default()
    }
}

pub fn follow_window_resize(window: &tauri::Window) {
    gtk_host::follow_window_resize(window.app_handle(), window.label());
}

pub const MAX_WORKSPACE_ID_LEN: usize = 4096;

fn validate_workspace_id(workspace_id: Option<String>, id: &str) -> Result<Option<String>, String> {
    let Some(workspace_id) = workspace_id else {
        return Ok(None);
    };
    if workspace_id.trim().is_empty() {
        return Err(format!(
            "browser: surface {id:?} was mounted with an empty workspace id \
             ({workspace_id:?}); expected an absolute directory path, or no workspace id at \
             all for an unscoped surface"
        ));
    }
    if workspace_id.len() > MAX_WORKSPACE_ID_LEN {
        return Err(format!(
            "browser: surface {id:?} was mounted with a workspace id of {} bytes; the limit \
             is {MAX_WORKSPACE_ID_LEN} bytes (MAX_WORKSPACE_ID_LEN). Expected an absolute \
             directory path.",
            workspace_id.len()
        ));
    }
    if !is_absolute_workspace_path(&workspace_id) {
        return Err(format!(
            "browser: surface {id:?} was mounted with a relative workspace id \
             ({workspace_id:?}); expected an absolute directory path (POSIX `/...` or a \
             Windows drive/UNC path), since that is what the daemon records as a session's \
             workspace and what this must match to scope against"
        ));
    }
    Ok(Some(workspace_id))
}

/// Either shape is accepted on every platform -- a POSIX id simply matches no
/// Windows workspace -- because the check exists to refuse *relative* ids,
/// which could never match one.
fn is_absolute_workspace_path(workspace_id: &str) -> bool {
    workspace_id.starts_with('/') || Path::new(workspace_id).is_absolute()
}

#[tauri::command]
pub fn browser_set_workspace(
    registry: State<'_, BrowserRegistry>,
    id: String,
    workspace_id: Option<String>,
) -> Result<(), String> {
    id::validate_surface_id(&id)?;
    let workspace_id = validate_workspace_id(workspace_id, &id)?;
    let mut state = lock_registry(&registry)?;
    let entry = state
        .children
        .get_mut(&id)
        .ok_or_else(|| format!("browser: no live browser surface with id {id:?} to re-scope"))?;
    entry.workspace_id = workspace_id;
    Ok(())
}

pub fn surfaces_in(app: &AppHandle, workspace_id: &str) -> Vec<String> {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return Vec::new();
    };
    let Ok(state) = registry.0.lock() else {
        return Vec::new();
    };
    state
        .children
        .iter()
        .filter(|(_, entry)| !entry.closing)
        .filter(|(_, entry)| entry.workspace_id.as_deref() == Some(workspace_id))
        .map(|(id, _)| id.clone())
        .collect()
}

// `workspace_id` names the workspace the renderer's prompt was shown for —
// what the user actually consented to. Re-deriving it from the surface at
// answer time would trust whatever that surface happens to belong to now.
#[tauri::command]
pub fn browser_confirm_respond(
    registry: State<'_, confirm::ConfirmRegistry>,
    id: String,
    approved: bool,
    trust_workspace: bool,
    workspace_id: String,
) -> Result<(), String> {
    registry.respond(&id, approved, trust_workspace, &workspace_id)
}

#[tauri::command]
pub async fn browser_confirm_screenshot(
    registry: State<'_, confirm::ConfirmRegistry>,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let path = registry.screenshot_for(&id).ok_or_else(|| {
        format!(
            "browser: no pending confirmation with id {id:?} has a capture; it was answered, it \
             timed out, or the pane could not be captured at all"
        )
    })?;
    let bytes = tokio::fs::read(&path).await.map_err(|e| {
        format!(
            "browser: could not read the confirmation capture for {id:?} at {}: {e}",
            path.display()
        )
    })?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub fn browser_confirm_trusted(registry: State<'_, confirm::ConfirmRegistry>) -> Vec<String> {
    registry.trusted_workspaces()
}

#[tauri::command]
pub fn browser_confirm_revoke_trust(
    registry: State<'_, confirm::ConfirmRegistry>,
    workspace_id: String,
) -> bool {
    registry.revoke_trust(&workspace_id)
}

pub(crate) fn cache_last_state(app: &AppHandle, id: &str, payload: &state::BrowserState) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let Ok(mut state) = registry.0.lock() else {
        return;
    };
    if let Some(entry) = state.children.get_mut(id) {
        let navigated = entry
            .last_state
            .as_ref()
            .is_some_and(|prev| prev.url != payload.url);
        if navigated {
            entry.tool_refs.clear_for_navigation();
        }
        entry.last_state = Some(payload.clone());
    }
}

pub(crate) fn tool_refs_start(app: &AppHandle, id: &str) -> Option<u64> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let state = registry.0.lock().ok()?;
    Some(state.children.get(id)?.tool_refs.start_seq())
}

pub(crate) fn tool_refs_replace(
    app: &AppHandle,
    id: &str,
    entries: std::collections::HashMap<String, tool_refs::Locator>,
    minted: u64,
) {
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let Ok(mut state) = registry.0.lock() else {
        return;
    };
    if let Some(entry) = state.children.get_mut(id) {
        entry.tool_refs.replace(entries, minted);
    }
}

pub(crate) fn tool_ref_get(
    app: &AppHandle,
    id: &str,
    element_ref: &str,
) -> Option<tool_refs::Locator> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let state = registry.0.lock().ok()?;
    state.children.get(id)?.tool_refs.get(element_ref).cloned()
}

pub fn last_state_for(app: &AppHandle, id: &str) -> Option<state::BrowserState> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let state = registry.0.lock().ok()?;
    state.children.get(id)?.last_state.clone()
}

pub(crate) fn sticky_for(app: &AppHandle, id: &str) -> Option<state::Sticky> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let guard = lock_registry_recovering(&registry);
    guard.children.get(id).map(|entry| entry.sticky.clone())
}

pub(crate) fn update_sticky(
    app: &AppHandle,
    id: &str,
    mutate: impl FnOnce(&mut state::Sticky),
) -> Option<state::Sticky> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let mut guard = lock_registry_recovering(&registry);
    let entry = guard.children.get_mut(id)?;
    mutate(&mut entry.sticky);
    Some(entry.sticky.clone())
}

pub(crate) fn picker_state_for(app: &AppHandle, id: &str) -> Option<(String, String)> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let guard = lock_registry_recovering(&registry);
    guard
        .children
        .get(id)
        .and_then(|entry| entry.picker.as_ref())
        .map(|picker| (picker.token.clone(), picker.label.clone()))
}

pub(crate) fn window_label_for(app: &AppHandle, id: &str) -> Option<String> {
    let registry = app.try_state::<BrowserRegistry>()?;
    let guard = lock_registry_recovering(&registry);
    guard
        .children
        .get(id)
        .map(|entry| entry.window_label.clone())
}

fn lock_registry_recovering(
    registry: &BrowserRegistry,
) -> std::sync::MutexGuard<'_, RegistryState> {
    registry.0.lock().unwrap_or_else(|poisoned| {
        eprintln!(
            "browser: registry mutex was poisoned by an earlier panic; recovering it so state \
             events keep reporting real state"
        );
        poisoned.into_inner()
    })
}

fn lock_registry(
    registry: &BrowserRegistry,
) -> Result<std::sync::MutexGuard<'_, RegistryState>, String> {
    registry
        .0
        .lock()
        .map_err(|err| format!("browser: registry mutex poisoned: {err}"))
}

fn check_cap(live_ids: &[String], requested_id: &str, max: usize) -> Result<(), String> {
    if live_ids.len() >= max {
        return Err(format!(
            "browser: MAX_LIVE_CHILDREN is {max}; {} already live {live_ids:?}; refusing to \
             mount {requested_id:?}",
            live_ids.len()
        ));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_mount(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    url: String,
    fullscreen: bool,
    rect: RectSpec,
    workspace_id: Option<String>,
) -> Result<Rect, String> {
    id::validate_surface_id(&id)?;
    let workspace_id = validate_workspace_id(workspace_id, &id)?;
    let label = id::derive_label(&id);

    let adopted = {
        let state = lock_registry(&registry)?;
        match state.children.get(&id) {
            Some(existing) if existing.closing => {
                return Err(format!(
                    "browser: surface {id:?} is being destroyed (webview {:?}); retry the mount \
                     once its teardown completes",
                    existing.label
                ));
            }
            Some(existing) if app.get_webview(&existing.label).is_some() => {
                Some((existing.window_label.clone(), existing.label.clone()))
            }
            Some(existing) => {
                return Err(format!(
                    "browser: surface {id:?} has a registry entry naming webview {:?}, but no \
                     such webview exists; destroy it before mounting again",
                    existing.label
                ));
            }
            None => {
                let live_ids: Vec<String> = state.children.keys().cloned().collect();
                check_cap(&live_ids, &id, MAX_LIVE_CHILDREN)?;
                None
            }
        }
    };
    if let Some((existing_window, existing_label)) = adopted {
        let committed = gtk_host::commit_rect(&app, &existing_window, &existing_label, rect)?;
        let mut state = lock_registry(&registry)?;
        let Some(entry) = state.children.get_mut(&id) else {
            return Err(format!(
                "browser: surface {id:?} was destroyed while being adopted; retry the mount"
            ));
        };
        if entry.closing {
            return Err(format!(
                "browser: surface {id:?} began being destroyed while being adopted; retry the \
                 mount once its teardown completes"
            ));
        }
        entry.last_rect = committed;
        entry.fullscreen = fullscreen;
        entry.workspace_id = workspace_id;
        return Ok(committed);
    }
    if app.get_webview(&label).is_some() {
        return Err(format!(
            "browser: a webview labelled {label:?} already exists outside the registry; \
             refusing to mount id {id:?}"
        ));
    }

    let window = app
        .get_window(HOST_WINDOW)
        .ok_or_else(|| format!("browser: no window labelled {HOST_WINDOW:?}"))?;
    let parsed_url: tauri::Url = url
        .parse()
        .map_err(|err| format!("browser: could not parse url {url:?} for id {id:?}: {err}"))?;
    if !webkit::scheme_is_allowed(parsed_url.scheme()) {
        return Err(format!(
            "browser: refusing to mount id {id:?} at the {:?} scheme (url {url:?}); browser \
             panes may only load {}",
            parsed_url.scheme(),
            webkit::ALLOWED_CHILD_SCHEMES.join(", ")
        ));
    }
    let state_dir = houston_core::paths::config_dir()
        .map_err(|err| format!("browser: cannot resolve state directory for id {id:?}: {err}"))?;
    let builder =
        tauri::webview::WebviewBuilder::new(&label, tauri::WebviewUrl::External(parsed_url))
            .focused(false)
            .data_directory(child_data_dir_for(&state_dir));
    #[cfg(target_os = "linux")]
    let builder = builder.user_agent(webkit::CHILD_USER_AGENT);
    #[cfg(target_os = "windows")]
    let builder = builder.initialization_script(webview2_commands::IPC_NEUTER_SCRIPT);
    let builder = builder.on_navigation({
        let app_for_nav = app.clone();
        let id_for_nav = id.clone();
        move |url| {
            if webkit::scheme_is_allowed(url.scheme()) {
                return true;
            }
            let shown: String = url.as_str().chars().take(200).collect();
            eprintln!(
                "browser: refused to navigate {id_for_nav:?} to the {:?} scheme (url \
                         {shown:?}); browser panes may only load {}",
                url.scheme(),
                webkit::ALLOWED_CHILD_SCHEMES.join(", ")
            );
            update_sticky(&app_for_nav, &id_for_nav, |sticky| {
                sticky.error = Some(state::BrowserError::blocked_scheme(&shown, url.scheme()));
            });
            false
        }
    });
    let webview = window
        .add_child(
            builder,
            tauri::LogicalPosition::new(0.0, 0.0),
            tauri::LogicalSize::new(1.0, 1.0),
        )
        .map_err(|err| {
            format!("browser: add_child failed for id {id:?} (label {label:?}): {err}")
        })?;

    if let Err(err) = gtk_host::adopt_child(&app, HOST_WINDOW, &label, &webview) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        return Err(format!(
            "browser: mounted webview {label:?} for id {id:?} but GTK adoption failed, rolled \
             back: {err}"
        ));
    }

    if let Err(err) = webkit::sever_ipc_transport(&webview, &id) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        return Err(format!(
            "browser: mounted webview {label:?} for id {id:?} but could not sever its IPC \
             transport, rolled back rather than leaving a page with reachable app IPC: {err}"
        ));
    }

    if let Err(err) = webkit::enable_console_logging_if_asked(&webview, &id) {
        eprintln!("browser: could not enable console logging for id {id:?}: {err}");
    }

    if let Err(err) = webkit::wire_signals(&app, &id, HOST_WINDOW, &webview) {
        if let Some(webview) = app.get_webview(&label) {
            let _ = webview.close();
        }
        return Err(format!(
            "browser: mounted webview {label:?} for id {id:?} but wiring its WebKit signals \
             failed, rolled back: {err}"
        ));
    }

    let committed = match gtk_host::commit_rect(&app, HOST_WINDOW, &label, rect) {
        Ok(committed) => committed,
        Err(err) => {
            if let Some(webview) = app.get_webview(&label) {
                let _ = webview.close();
            }
            return Err(format!(
                "browser: mounted webview {label:?} for id {id:?} but GTK positioning failed, \
                 rolled back: {err}"
            ));
        }
    };

    let mut state = lock_registry(&registry)?;
    let generation = {
        let counter = state.generations.entry(id.clone()).or_insert(0);
        *counter += 1;
        *counter
    };
    state.children.insert(
        id,
        ChildEntry {
            label,
            window_label: HOST_WINDOW.to_string(),
            workspace_id,
            last_state: None,
            last_rect: committed,
            suppressed: suppress::SuppressionSet::new(),
            closing: false,
            sticky: state::Sticky::default(),
            fullscreen,
            generation,
            picker: None,
            tool_refs: tool_refs::RefStore::default(),
        },
    );
    Ok(committed)
}

#[tauri::command]
pub fn browser_destroy(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<(), String> {
    id::validate_surface_id(&id)?;
    let (label, window_label) = {
        let mut state = lock_registry(&registry)?;
        let entry = state.children.get_mut(&id).ok_or_else(|| {
            format!("browser: no live browser surface with id {id:?}; nothing to destroy")
        })?;
        entry.closing = true;
        (entry.label.clone(), entry.window_label.clone())
    };
    let webview = app.get_webview(&label).ok_or_else(|| {
        format!("browser: registry had id {id:?} but no webview labelled {label:?} exists")
    })?;
    if let Err(err) = webkit::forget_picker_state(&webview, &id) {
        eprintln!("browser: could not forget id {id:?}'s picker state before destroying it: {err}");
    }
    if let Err(err) = webview.close() {
        let mut state = lock_registry(&registry)?;
        if let Some(entry) = state.children.get_mut(&id) {
            entry.closing = false;
        }
        return Err(format!("browser: close() on {label:?} (id {id:?}): {err}"));
    }
    let mut state = lock_registry(&registry)?;
    let window_label = state
        .children
        .remove(&id)
        .map_or(window_label, |entry| entry.window_label);
    drop(state);
    if let Some(window_label) = detached_window_to_close(&window_label) {
        match app.get_window(window_label) {
            Some(window) => match window.close() {
                Ok(()) => eprintln!(
                    "browser: destroyed detached id {id:?} and closed its window {window_label:?}"
                ),
                Err(err) => eprintln!(
                    "browser: destroyed id {id:?} but could not close its detached window \
                     {window_label:?}: {err}"
                ),
            },
            None => {
                eprintln!(
                    "browser: destroyed detached id {id:?}; its window {window_label:?} was \
                     already gone"
                );
            }
        }
    }
    Ok(())
}

#[tauri::command]
pub fn browser_detach(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<Rect, String> {
    id::validate_surface_id(&id)?;
    let (label, current_window) = {
        let state = lock_registry(&registry)?;
        let entry = state.children.get(&id).ok_or_else(|| {
            format!("browser: no live browser surface with id {id:?}; mount it before detaching")
        })?;
        (entry.label.clone(), entry.window_label.clone())
    };
    if current_window != HOST_WINDOW {
        return Err(format!(
            "browser: id {id:?} is already detached into window {current_window:?}; reattach it \
             (browser_reattach) before detaching again"
        ));
    }

    let window_label = detached_window_label(&id);
    if app.get_window(&window_label).is_some() {
        return Err(format!(
            "browser: a detached window labelled {window_label:?} already exists for id {id:?}; \
             refusing to build a second one"
        ));
    }

    let placeholder_url: tauri::Url = DETACHED_WINDOW_URL
        .parse()
        .expect("DETACHED_WINDOW_URL is a fixed, valid data: URL");
    tauri::WebviewWindowBuilder::new(
        &app,
        window_label.as_str(),
        tauri::WebviewUrl::External(placeholder_url),
    )
    .title(format!("Houston — {id}"))
    .inner_size(900.0, 640.0)
    .decorations(true)
    .build()
    .map_err(|err| {
        format!("browser: could not build detached window {window_label:?} for id {id:?}: {err}")
    })?;

    let committed = match gtk_host::move_child(&app, HOST_WINDOW, &window_label, &label) {
        Ok(rect) => rect,
        Err(err) => {
            if let Some(window) = app.get_window(&window_label) {
                let _ = window.close();
            }
            return Err(format!(
                "browser: built detached window {window_label:?} for id {id:?} but moving its \
                 child into it failed, rolled back: {err}"
            ));
        }
    };

    let mut state = lock_registry(&registry)?;
    if let Some(entry) = state.children.get_mut(&id) {
        entry.window_label = window_label;
        entry.last_rect = committed;
    }
    Ok(committed)
}

#[tauri::command]
pub fn browser_reattach(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<Rect, String> {
    id::validate_surface_id(&id)?;
    let (label, current_window) = {
        let state = lock_registry(&registry)?;
        let entry = state.children.get(&id).ok_or_else(|| {
            format!("browser: no live browser surface with id {id:?}; mount it before reattaching")
        })?;
        (entry.label.clone(), entry.window_label.clone())
    };
    if current_window == HOST_WINDOW {
        return Err(format!(
            "browser: id {id:?} is not detached (already in window {HOST_WINDOW:?}); nothing to \
             reattach"
        ));
    }

    let committed = gtk_host::move_child(&app, &current_window, HOST_WINDOW, &label)?;

    {
        let mut state = lock_registry(&registry)?;
        if let Some(entry) = state.children.get_mut(&id) {
            entry.window_label = HOST_WINDOW.to_string();
            entry.last_rect = committed;
        }
    }

    if let Some(window) = app.get_window(&current_window) {
        if let Err(err) = window.close() {
            eprintln!(
                "browser: reattached id {id:?} but could not close its now-empty detached \
                 window {current_window:?}: {err}"
            );
        }
    }
    Ok(committed)
}

pub fn handle_window_closed(app: &AppHandle, window_label: &str) {
    if window_label == HOST_WINDOW {
        return;
    }
    let Some(registry) = app.try_state::<BrowserRegistry>() else {
        return;
    };
    let id = {
        let guard = lock_registry_recovering(&registry);
        guard
            .children
            .iter()
            .find(|(_, entry)| entry.window_label == window_label)
            .map(|(id, _)| id.clone())
    };
    let Some(id) = id else { return };

    let label = {
        let mut guard = lock_registry_recovering(&registry);
        guard.children.remove(&id).map(|entry| entry.label)
    };
    let Some(label) = label else { return };

    if let Some(webview) = app.get_webview(&label) {
        if let Err(err) = webkit::forget_picker_state(&webview, &id) {
            eprintln!(
                "browser: could not forget id {id:?}'s picker state before its detached window \
                 closed: {err}"
            );
        }
        if let Err(err) = webview.close() {
            eprintln!(
                "browser: detached window {window_label:?} closed but could not close its \
                 child webview {label:?} (id {id:?}): {err}"
            );
        }
    }

    if let Err(err) = app.emit_to(
        tauri::EventTarget::AnyLabel {
            label: HOST_WINDOW.to_string(),
        },
        DETACHED_CLOSED_EVENT,
        serde_json::json!({ "id": &id }),
    ) {
        eprintln!("browser: could not emit {DETACHED_CLOSED_EVENT} for id {id:?}: {err}");
    }
}

#[tauri::command]
pub fn browser_resize(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    rect: RectSpec,
) -> Result<Rect, String> {
    id::validate_surface_id(&id)?;
    let (window_label, label) = {
        let state = lock_registry(&registry)?;
        let entry = state.children.get(&id).ok_or_else(|| {
            format!("browser: no live browser surface with id {id:?}; mount it before resizing")
        })?;
        (entry.window_label.clone(), entry.label.clone())
    };
    let committed = gtk_host::commit_rect(&app, &window_label, &label, rect)?;
    let mut state = lock_registry(&registry)?;
    if let Some(entry) = state.children.get_mut(&id) {
        entry.last_rect = committed;
    }
    Ok(committed)
}

#[tauri::command]
pub fn browser_set_visible(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    visible: bool,
    reason: String,
) -> Result<(), String> {
    id::validate_surface_id(&id)?;
    let (label, mut suppressed) = {
        let state = lock_registry(&registry)?;
        let entry = state.children.get(&id).ok_or_else(|| {
            format!(
                "browser: no live browser surface with id {id:?}; mount it before changing \
                 visibility"
            )
        })?;
        (entry.label.clone(), entry.suppressed.clone())
    };
    if visible {
        suppressed.release(&reason)?;
    } else {
        suppressed.assert(&reason)?;
    }
    let should_hide = suppressed.is_hidden();
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| format!("browser: no webview labelled {label:?} for id {id:?}"))?;
    let result = if should_hide {
        webview.hide()
    } else {
        webview.show()
    };
    result.map_err(|err| {
        format!("browser: set_visible(hidden={should_hide}) on id {id:?} (label {label:?}): {err}")
    })?;
    let mut state = lock_registry(&registry)?;
    if let Some(entry) = state.children.get_mut(&id) {
        entry.suppressed = suppressed;
    }
    Ok(())
}

fn live_webview(
    app: &AppHandle,
    registry: &State<'_, BrowserRegistry>,
    id: &str,
    verb: &str,
) -> Result<tauri::Webview, String> {
    id::validate_surface_id(id)?;
    let label = {
        let guard = lock_registry(registry)?;
        guard
            .children
            .get(id)
            .ok_or_else(|| {
                format!("browser: no live browser surface with id {id:?}; mount it before {verb}")
            })?
            .label
            .clone()
    };
    app.get_webview(&label)
        .ok_or_else(|| format!("browser: registry had id {id:?} but no webview labelled {label:?}"))
}

fn refuse_if_hidden(
    registry: &State<'_, BrowserRegistry>,
    id: &str,
    when: &str,
) -> Result<(), String> {
    let hidden_by = {
        let guard = lock_registry(registry)?;
        guard
            .children
            .get(id)
            .filter(|entry| entry.suppressed.is_hidden())
            .map(|entry| entry.suppressed.reasons())
    };
    match hidden_by {
        None => Ok(()),
        Some(reasons) => Err(format!(
            "browser: id {id:?} is hidden by {reasons:?} ({when} the capture); refusing to \
             capture it because WebKit would return the last frame it painted while visible, not \
             what the pane shows now. Release the suppression reasons first (browser_set_visible)."
        )),
    }
}

#[tauri::command]
pub fn browser_navigate(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    url: String,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "navigating")?;
    let _: tauri::Url = url
        .parse()
        .map_err(|err| format!("browser: could not parse url {url:?} for id {id:?}: {err}"))?;
    webkit::navigate(&webview, &id, &url)
}

#[tauri::command]
pub fn browser_reload(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    bypass_cache: bool,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "reloading")?;
    webkit::reload(&webview, &id, bypass_cache)
}

#[tauri::command]
pub fn browser_go_back(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "going back")?;
    webkit::go_back(&webview, &id)
}

#[tauri::command]
pub fn browser_go_forward(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "going forward")?;
    webkit::go_forward(&webview, &id)
}

#[tauri::command]
pub fn browser_set_picker_mode(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    enabled: bool,
    config: Option<picker::PickerConfig>,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "setting the picker mode of")?;

    if !enabled {
        let currently_enabled = {
            let guard = lock_registry(&registry)?;
            guard
                .children
                .get(&id)
                .is_some_and(|entry| entry.picker.is_some())
        };
        if !currently_enabled {
            return Ok(());
        }
        {
            let mut guard = lock_registry(&registry)?;
            if let Some(entry) = guard.children.get_mut(&id) {
                entry.picker = None;
            }
        }
        webkit::disable_picker(&webview, &id)?;
        return Ok(());
    }

    let config = config.ok_or_else(|| {
        format!(
            "browser: browser_set_picker_mode(id={id:?}, enabled=true) has no config; a config \
             ({{agents, preferredAgent}}) is required to enable the picker"
        )
    })?;
    let label = config
        .agents
        .iter()
        .find(|agent| config.preferred_agent.as_deref() == Some(agent.id.as_str()))
        .or_else(|| config.agents.first())
        .map(|agent| agent.name.clone())
        .unwrap_or_default();
    let token = uuid::Uuid::new_v4().to_string();
    let source = picker::build_picker_source(&token);
    {
        let mut guard = lock_registry(&registry)?;
        if let Some(entry) = guard.children.get_mut(&id) {
            entry.picker = Some(PickerState {
                token: token.clone(),
                label,
            });
        }
    }
    if let Err(err) = webkit::enable_picker(&app, &webview, &id, HOST_WINDOW, &source) {
        let mut guard = lock_registry(&registry)?;
        if let Some(entry) = guard.children.get_mut(&id) {
            entry.picker = None;
        }
        return Err(err);
    }
    Ok(())
}

#[tauri::command]
pub fn browser_focus_host(app: AppHandle, window_label: Option<String>) -> Result<bool, String> {
    let label = window_label.unwrap_or_else(|| HOST_WINDOW.to_string());
    gtk_host::focus_host(&app, &label)
}

#[tauri::command]
pub fn browser_clear_picker_selection(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "clearing the picker selection of")?;
    let enabled = {
        let guard = lock_registry(&registry)?;
        guard
            .children
            .get(&id)
            .is_some_and(|entry| entry.picker.is_some())
    };
    if !enabled {
        return Err(format!(
            "browser: id {id:?}'s picker is not enabled; call browser_set_picker_mode(id: \
             {id:?}, enabled: true, ...) before clearing a selection"
        ));
    }
    webkit::clear_picker_selection(&webview, &id)
}

#[tauri::command]
pub fn browser_submit_picker_prompt(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
    user_prompt: String,
    agent_id: String,
) -> Result<(), String> {
    let webview = live_webview(&app, &registry, &id, "submitting the picker prompt of")?;
    let enabled = {
        let guard = lock_registry(&registry)?;
        guard
            .children
            .get(&id)
            .is_some_and(|entry| entry.picker.is_some())
    };
    if !enabled {
        return Err(format!(
            "browser: id {id:?}'s picker is not enabled; call browser_set_picker_mode(id: \
             {id:?}, enabled: true, ...) before submitting a prompt"
        ));
    }
    if user_prompt.trim().is_empty() {
        return Err(format!(
            "browser: browser_submit_picker_prompt(id: {id:?}) was given a blank userPrompt; \
             expected the text the user typed (the parser rejects a blank one too)"
        ));
    }
    webkit::submit_picker_prompt(&webview, &id, &user_prompt, &agent_id)
}

#[tauri::command]
pub async fn browser_capture(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    id: String,
) -> Result<String, String> {
    let webview = live_webview(&app, &registry, &id, "capturing")?;
    refuse_if_hidden(&registry, &id, "before")?;
    let capture = webkit::capture_rgba(&webview, &id).await?;
    refuse_if_hidden(&registry, &id, "during")?;
    let png = state::rgba_to_png(&capture.rgba, capture.width, capture.height)?;
    crate::fs::save_bytes_under("pastes", "png", &png).await
}

#[cfg(test)]
mod workspace_scope_tests {
    use super::*;

    #[test]
    fn an_empty_workspace_id_is_refused_and_named() {
        let err = validate_workspace_id(Some("   ".into()), "leaf-1").unwrap_err();
        assert!(err.contains("leaf-1"), "{err}");
        assert!(err.contains("empty workspace id"), "{err}");
    }

    #[test]
    fn a_relative_workspace_id_is_refused_because_it_could_never_match() {
        let err = validate_workspace_id(Some("proj".into()), "leaf-1").unwrap_err();
        assert!(err.contains("relative"), "{err}");
        assert!(err.contains("proj"), "{err}");
    }

    #[test]
    fn an_over_long_workspace_id_names_the_limit_and_the_actual_length() {
        let long = format!("/{}", "a".repeat(MAX_WORKSPACE_ID_LEN));
        let err = validate_workspace_id(Some(long.clone()), "leaf-1").unwrap_err();
        assert!(err.contains(&long.len().to_string()), "{err}");
        assert!(err.contains(&MAX_WORKSPACE_ID_LEN.to_string()), "{err}");
    }

    #[test]
    fn no_workspace_id_is_accepted_as_unscoped() {
        assert_eq!(validate_workspace_id(None, "right-panel"), Ok(None));
    }

    #[test]
    fn an_absolute_path_is_accepted_verbatim() {
        assert_eq!(
            validate_workspace_id(Some("/home/dev/proj".into()), "leaf-1"),
            Ok(Some("/home/dev/proj".to_string()))
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_windows_absolute_path_is_accepted_verbatim() {
        for id in [r"C:\Users\dev\proj", r"\\server\share\proj"] {
            assert_eq!(
                validate_workspace_id(Some(id.to_string()), "leaf-1"),
                Ok(Some(id.to_string()))
            );
        }
    }

    #[test]
    fn a_windows_relative_path_is_refused() {
        let err = validate_workspace_id(Some(r"proj\sub".into()), "leaf-1").unwrap_err();
        assert!(err.contains("relative"), "{err}");
        // The id is rendered through `{...:?}`, so its backslash is escaped;
        // the head of the path is enough to prove the offending value is named.
        assert!(err.contains("proj"), "{err}");
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_popup_is_always_addressed_to_the_host_window() {
        assert_eq!(popup_event_target(), HOST_WINDOW);

        for window_label in [HOST_WINDOW, &detached_window_label("abc")] {
            assert_eq!(
                popup_event_target(),
                HOST_WINDOW,
                "a surface in {window_label:?} must still send its popups to the host"
            );
        }

        assert_eq!(detached_window_to_close(HOST_WINDOW), None);
        assert_eq!(
            detached_window_to_close("tr-browser-window-abc"),
            Some("tr-browser-window-abc")
        );
    }

    use super::*;

    #[test]
    fn child_storage_is_per_channel_and_never_the_main_webviews() {
        let dev = child_data_dir_for(Path::new("/home/u/.houston-dev"));
        let release = child_data_dir_for(Path::new("/home/u/.houston"));
        assert_eq!(dev, PathBuf::from("/home/u/.houston-dev/browser-webview"));
        assert_ne!(
            dev, release,
            "both channels resolved to one browser store, so a dev run would \
             rewrite the installed app's pane cookies and logins"
        );
        for base in ["/home/u/.houston-dev", "/home/u/.houston"] {
            assert!(
                child_data_dir_for(Path::new(base)).starts_with(base),
                "the child store for {base:?} resolved outside its own channel"
            );
        }
        assert_ne!(
            dev,
            PathBuf::from("/home/u/.houston-dev/webview"),
            "browser children were pointed at the main webview's own data directory"
        );
    }

    #[test]
    fn a_detached_child_names_a_window_to_close_and_a_hosted_one_does_not() {
        assert_eq!(detached_window_to_close(HOST_WINDOW), None);

        let detached = detached_window_label("b1-2");
        assert_eq!(detached_window_to_close(&detached), Some(detached.as_str()));

        assert_eq!(
            detached_window_to_close("some-other-window"),
            Some("some-other-window")
        );
    }

    #[cfg(unix)]
    #[test]
    fn clearing_refuses_live_panes_a_symlink_and_any_directory_but_the_store() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = tmp.path().join(CHILD_DATA_DIR_NAME);
        std::fs::create_dir_all(store.join("localstorage")).expect("store");
        std::fs::write(store.join("cookies"), b"a-login-cookie").expect("cookies");

        let live = vec!["pane-1".to_string(), "pane-2".to_string()];
        let err = clear_browsing_data_under(&store, &live).expect_err("must refuse while live");
        assert!(
            err.contains("pane-1") && err.contains('2'),
            "unhelpful: {err}"
        );
        assert!(
            store.join("cookies").exists(),
            "it deleted the store anyway"
        );

        let err =
            clear_browsing_data_under(tmp.path(), &[]).expect_err("must refuse the state dir");
        assert!(
            err.contains(CHILD_DATA_DIR_NAME),
            "did not name the rule: {err}"
        );
        assert!(store.exists(), "it deleted the state directory");

        let elsewhere = tmp.path().join("elsewhere");
        std::fs::create_dir_all(&elsewhere).expect("elsewhere");
        std::fs::write(elsewhere.join("precious"), b"not a cookie").expect("precious");
        let linked = tmp.path().join("link-dir");
        std::fs::create_dir_all(&linked).expect("link parent");
        let link = linked.join(CHILD_DATA_DIR_NAME);
        std::os::unix::fs::symlink(&elsewhere, &link).expect("symlink");
        let err = clear_browsing_data_under(&link, &[]).expect_err("must refuse a symlink");
        assert!(err.contains("symlink"), "did not name the reason: {err}");
        assert!(elsewhere.join("precious").exists(), "it followed the link");
    }

    #[cfg(unix)]
    #[test]
    fn clearing_an_idle_store_removes_it_and_reports_the_bytes() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = tmp.path().join(CHILD_DATA_DIR_NAME);
        std::fs::create_dir_all(store.join("localstorage")).expect("store");
        std::fs::write(store.join("cookies"), vec![b'x'; 300]).expect("cookies");
        std::fs::write(store.join("localstorage").join("db"), vec![b'y'; 700]).expect("db");

        let size = browsing_data_size_under(&store).expect("size");
        assert_eq!(size, 1000, "the size readout must cover nested files too");

        let reclaimed = clear_browsing_data_under(&store, &[]).expect("clear");
        assert_eq!(reclaimed, 1000);
        assert!(!store.exists(), "the store survived a clear");

        assert_eq!(
            clear_browsing_data_under(&store, &[]).expect("second clear"),
            0
        );
        assert_eq!(
            browsing_data_size_under(&store).expect("size of nothing"),
            0
        );
    }

    #[cfg(unix)]
    #[test]
    fn neither_sizing_nor_clearing_follows_a_symlink_out_of_the_store() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let store = tmp.path().join(CHILD_DATA_DIR_NAME);
        std::fs::create_dir_all(&store).expect("store");
        std::fs::write(store.join("cookies"), vec![b'x'; 100]).expect("cookies");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).expect("outside");
        std::fs::write(outside.join("huge"), vec![b'z'; 5000]).expect("huge");
        std::os::unix::fs::symlink(&outside, store.join("link-out")).expect("link out");
        std::os::unix::fs::symlink(tmp.path(), store.join("link-up")).expect("link up");

        let size = browsing_data_size_under(&store).expect("size with links");
        assert!(
            size < 5000,
            "the walk followed a symlink out of the store: {size} bytes"
        );

        clear_browsing_data_under(&store, &[]).expect("clear");
        assert!(!store.exists(), "the store survived");
        assert!(
            outside.join("huge").exists(),
            "clearing deleted a tree outside the store by following a symlink"
        );
    }

    #[test]
    fn cap_allows_mount_below_the_limit() {
        let live = vec!["a".to_string(), "b".to_string()];
        assert!(check_cap(&live, "c", 3).is_ok());
    }

    #[test]
    fn cap_refuses_mount_at_the_limit_and_names_everything() {
        let live: Vec<String> = (0..MAX_LIVE_CHILDREN).map(|i| format!("id-{i}")).collect();
        let err = check_cap(&live, "one-too-many", MAX_LIVE_CHILDREN).unwrap_err();
        assert!(
            err.contains(&format!("MAX_LIVE_CHILDREN is {MAX_LIVE_CHILDREN}")),
            "{err}"
        );
        assert!(
            err.contains(&format!("{} already live", live.len())),
            "{err}"
        );
        assert!(err.contains("one-too-many"), "{err}");
        for id in &live {
            assert!(err.contains(id), "{err} must list live id {id}");
        }
    }

    #[test]
    fn cap_message_names_the_limit_the_count_and_the_request() {
        let live = vec!["x".to_string()];
        let err = check_cap(&live, "y", 1).unwrap_err();
        assert!(err.contains("MAX_LIVE_CHILDREN is 1"), "{err}");
        assert!(err.contains('1'), "{err}");
        assert!(err.contains("\"y\""), "{err}");
    }

    #[test]
    fn detached_window_label_is_namespaced_and_carries_the_id() {
        let label = detached_window_label("grid-leaf-3");
        assert_eq!(label, "tr-browser-window-grid-leaf-3");
        assert_ne!(label, HOST_WINDOW);
        assert!(!label.starts_with(HOST_WINDOW));
    }

    #[test]
    fn detached_window_label_differs_from_the_child_webview_label() {
        let id = "pane-1";
        assert_ne!(detached_window_label(id), id::derive_label(id));
    }

    #[test]
    fn detached_window_url_is_a_parseable_data_url() {
        let parsed: Result<tauri::Url, _> = DETACHED_WINDOW_URL.parse();
        assert!(
            parsed.is_ok(),
            "{DETACHED_WINDOW_URL:?} must parse as a URL"
        );
        assert_eq!(parsed.unwrap().scheme(), "data");
    }
}
