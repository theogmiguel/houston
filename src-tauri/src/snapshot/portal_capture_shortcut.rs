//! xdg-desktop-portal GlobalShortcuts registration. Mirrors upstream
//! `PortalCaptureShortcut.ts`; a desktop without the interface reports the same
//! permission message instead of silently dropping the shortcut.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::sync::watch;
use zbus::message::Type;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};
use zbus::{Connection, MatchRule, MessageStream, Proxy};

use super::linux_capture_session::{portal_shortcut_trigger, sandboxed};
use super::platform::{ChangedCallback, KeyChord, TriggerCallback};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PATH: &str = "/org/freedesktop/portal/desktop";
const SHORTCUTS: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST: &str = "org.freedesktop.portal.Request";
const REGISTRY: &str = "org.freedesktop.host.portal.Registry";
const BIND_TIMEOUT: Duration = Duration::from_secs(120);
const CALL_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Default)]
pub struct PortalShortcutState {
    pub registered: bool,
    pub pending: bool,
    pub can_retry: bool,
    pub label: Option<String>,
    pub message: Option<String>,
}

pub struct PortalCaptureShortcut {
    state: Arc<Mutex<PortalShortcutState>>,
    stop: watch::Sender<bool>,
    handle: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl PortalCaptureShortcut {
    pub fn start(
        app_id: String,
        shortcut: KeyChord,
        on_capture: TriggerCallback,
        on_changed: ChangedCallback,
    ) -> Self {
        let state = Arc::new(Mutex::new(PortalShortcutState {
            pending: true,
            can_retry: true,
            message: Some(
                "Waiting for shortcut permission. Approve the desktop prompt if one appears."
                    .to_string(),
            ),
            ..Default::default()
        }));
        let (stop, mut receiver) = watch::channel(false);
        let task_state = Arc::clone(&state);
        let handle = tauri::async_runtime::spawn(async move {
            let result = run(
                &app_id,
                &shortcut,
                &task_state,
                &on_capture,
                &on_changed,
                &mut receiver,
            )
            .await;
            if let Err(error) = result {
                if let Ok(mut state) = task_state.lock() {
                    state.registered = false;
                    state.pending = false;
                    state.can_retry = true;
                    state.message = Some(error);
                }
                on_changed();
            }
        });
        Self {
            state,
            stop,
            handle: Mutex::new(Some(handle)),
        }
    }

    pub fn state(&self) -> PortalShortcutState {
        self.state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default()
    }

    pub fn release(&self) {
        let _ = self.stop.send(true);
        if let Ok(mut handle) = self.handle.lock() {
            if let Some(handle) = handle.take() {
                handle.abort();
            }
        }
    }
}

impl Drop for PortalCaptureShortcut {
    fn drop(&mut self) {
        self.release();
    }
}

fn signal_rule<'a>(
    interface: &'a str,
    member: &'a str,
    path: Option<&'a str>,
) -> Option<MatchRule<'a>> {
    let mut builder = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(interface)
        .ok()?
        .member(member)
        .ok()?;
    if let Some(path) = path {
        builder = builder.path(path).ok()?;
    }
    Some(builder.build())
}

async fn request(
    conn: &Connection,
    namespace: &str,
    timeout: Duration,
    call: impl std::future::Future<Output = zbus::Result<OwnedObjectPath>>,
) -> Result<HashMap<String, OwnedValue>, String> {
    let rule = MatchRule::builder()
        .msg_type(Type::Signal)
        .interface(REQUEST)
        .map_err(|error| format!("portal match rule: {error}"))?
        .member("Response")
        .map_err(|error| format!("portal match rule: {error}"))?
        .path_namespace(namespace.trim_end_matches('/'))
        .map_err(|error| format!("portal match rule: {error}"))?
        .build();
    let mut responses = MessageStream::for_match_rule(rule, conn, Some(8))
        .await
        .map_err(|error| format!("subscribing to portal responses: {error}"))?;
    let _handle = call
        .await
        .map_err(|error| format!("portal request: {error}"))?;
    let message = tokio::time::timeout(timeout, responses.next())
        .await
        .map_err(|_| "Shortcut permission request timed out. Try again.".to_string())?
        .ok_or_else(|| "The desktop shortcut service disconnected.".to_string())?
        .map_err(|error| format!("portal response: {error}"))?;
    let body = message.body();
    let (status, results): (u32, HashMap<String, OwnedValue>) = body
        .deserialize()
        .map_err(|error| format!("portal response body: {error}"))?;
    if status != 0 {
        return Err(if status == 1 {
            "Shortcut permission wasn't granted. Open shortcut permissions to allow it.".to_string()
        } else {
            "Your desktop could not create a capture shortcut session.".to_string()
        });
    }
    Ok(results)
}

fn shortcut_id(trigger: &str) -> String {
    let digest = Sha256::digest(trigger.as_bytes());
    format!(
        "t3-snap-shot-{}",
        digest
            .iter()
            .take(8)
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

async fn run(
    app_id: &str,
    shortcut: &KeyChord,
    state: &Arc<Mutex<PortalShortcutState>>,
    on_capture: &TriggerCallback,
    on_changed: &ChangedCallback,
    stop: &mut watch::Receiver<bool>,
) -> Result<(), String> {
    let trigger = portal_shortcut_trigger(shortcut)?;
    let conn = Connection::session().await.map_err(|error| {
        format!("Could not connect to your desktop's shortcut service: {error}")
    })?;
    if !sandboxed() {
        let registry = Proxy::new(&conn, PORTAL, PATH, REGISTRY).await.ok();
        if let Some(registry) = registry {
            let options: HashMap<String, Value<'_>> = HashMap::new();
            let _ = registry
                .call::<_, _, ()>("Register", &(app_id, options))
                .await;
        }
    }
    let properties = Proxy::new(&conn, PORTAL, PATH, "org.freedesktop.DBus.Properties")
        .await
        .map_err(|error| format!("desktop shortcut properties: {error}"))?;
    let version: OwnedValue = properties
        .call("Get", &(SHORTCUTS, "version"))
        .await
        .map_err(|_| {
            "Your desktop does not provide the GlobalShortcuts portal. Choose another shortcut or use Take snapshot from the command palette."
                .to_string()
        })?;
    let version = u32::try_from(version).unwrap_or(1);

    let activated_rule = signal_rule(SHORTCUTS, "Activated", Some(PATH))
        .ok_or_else(|| "invalid Activated match rule".to_string())?;
    let changed_rule = signal_rule(SHORTCUTS, "ShortcutsChanged", Some(PATH))
        .ok_or_else(|| "invalid ShortcutsChanged match rule".to_string())?;
    let mut activated = MessageStream::for_match_rule(activated_rule, &conn, Some(16))
        .await
        .map_err(|error| format!("subscribing to shortcut activations: {error}"))?;
    let mut changed = MessageStream::for_match_rule(changed_rule, &conn, Some(16))
        .await
        .map_err(|error| format!("subscribing to shortcut changes: {error}"))?;

    let proxy = Proxy::new(&conn, PORTAL, PATH, SHORTCUTS)
        .await
        .map_err(|error| format!("desktop shortcut service: {error}"))?;
    let unique = conn
        .unique_name()
        .map(|name| name.as_str().trim_start_matches(':').replace('.', "_"))
        .unwrap_or_else(|| "unknown".to_string());
    let namespace = format!("{PATH}/request/{unique}/");
    let session_namespace = format!("{PATH}/session/{unique}/");
    let token = format!("houston_capture_{}", uuid::Uuid::new_v4().simple());
    let mut options: HashMap<String, Value<'_>> = HashMap::new();
    options.insert("session_handle_token".to_string(), Value::from(token));
    let created = request(
        &conn,
        &namespace,
        CALL_TIMEOUT,
        proxy.call::<_, _, OwnedObjectPath>("CreateSession", &(options,)),
    )
    .await?;
    let session_handle = created
        .get("session_handle")
        .cloned()
        .ok_or_else(|| "the desktop returned no shortcut session".to_string())?;
    let session_handle = String::try_from(session_handle)
        .map_err(|_| "the desktop returned an invalid shortcut session".to_string())?;
    let session = OwnedObjectPath::try_from(session_handle)
        .map_err(|_| "the desktop returned an invalid shortcut session".to_string())?;
    if !session.as_str().starts_with(&session_namespace) {
        return Err("Invalid shortcut session handle.".to_string());
    }
    let id = shortcut_id(&trigger);
    let mut entry_options: HashMap<String, Value<'_>> = HashMap::new();
    entry_options.insert(
        "description".to_string(),
        Value::from("Capture a window".to_string()),
    );
    entry_options.insert(
        "preferred_trigger".to_string(),
        Value::from(trigger.clone()),
    );
    let entries = vec![(id.clone(), entry_options)];
    let token = format!("houston_bind_{}", uuid::Uuid::new_v4().simple());
    let mut bind_options: HashMap<String, Value<'_>> = HashMap::new();
    bind_options.insert("handle_token".to_string(), Value::from(token));
    let bound = request(
        &conn,
        &namespace,
        BIND_TIMEOUT,
        proxy.call::<_, _, OwnedObjectPath>(
            "BindShortcuts",
            &(session.clone(), entries, String::new(), bind_options),
        ),
    )
    .await?;
    let label = bound
        .get("shortcuts")
        .and_then(|shortcuts| {
            Vec::<(String, HashMap<String, OwnedValue>)>::try_from(shortcuts.clone()).ok()
        })
        .and_then(|shortcuts| {
            shortcuts
                .into_iter()
                .find(|(shortcut_id, _)| shortcut_id == &id)
                .and_then(|(_, options)| options.get("trigger_description").cloned())
                .and_then(|value| String::try_from(value).ok())
        })
        .map(|label| label.trim().to_string())
        .filter(|label| !label.is_empty());
    if let Ok(mut state) = state.lock() {
        state.registered = label.is_some();
        state.pending = false;
        state.can_retry = version >= 2;
        state.label = label.clone();
        state.message = Some(match label {
            Some(label) => format!("Desktop shortcut: {label}"),
            None => "No shortcut is assigned. Open shortcut permissions to choose one.".to_string(),
        });
    }
    on_changed();

    loop {
        tokio::select! {
            _ = stop.changed() => return Ok(()),
            message = activated.next() => {
                let Some(Ok(message)) = message else { return Ok(()) };
                let body = message.body();
                if let Ok((session_path, shortcut, _)) = body.deserialize::<(OwnedObjectPath, String, HashMap<String, OwnedValue>)>() {
                    if session_path.as_str() == session.as_str() && shortcut == id {
                        on_capture();
                    }
                }
            }
            message = changed.next() => {
                let Some(Ok(message)) = message else { return Ok(()) };
                let body = message.body();
                if let Ok((session_path, shortcuts)) = body.deserialize::<(OwnedObjectPath, Vec<(String, HashMap<String, OwnedValue>)>)>() {
                    if session_path.as_str() != session.as_str() {
                        continue;
                    }
                    let label = shortcuts.into_iter().find(|(shortcut_id, _)| shortcut_id == &id)
                        .and_then(|(_, options)| options.get("trigger_description").cloned())
                        .and_then(|value| String::try_from(value).ok())
                        .map(|label| label.trim().to_string())
                        .filter(|label| !label.is_empty());
                    if let Ok(mut state) = state.lock() {
                        state.registered = label.is_some();
                        state.pending = false;
                        state.label = label.clone();
                        state.message = Some(match label {
                            Some(label) => format!("Desktop shortcut: {label}"),
                            None => "No shortcut is assigned. Open shortcut permissions to choose one.".to_string(),
                        });
                    }
                    on_changed();
                }
            }
        }
    }
}
