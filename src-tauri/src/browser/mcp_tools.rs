//! The browser tools an agent hosted in a Houston pane can call over MCP.
//! Targets are restricted to live surfaces in the credential workspace.
use houston_core::mcp_creds::McpScope;
use houston_core::mcp_server::{BoxFuture, ToolError, ToolOutput, ToolProvider, ToolSpec};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use super::{confirm, BrowserRegistry};

pub struct BrowserTools {
    app: AppHandle,
}

fn requires_reveal(name: &str) -> bool {
    matches!(
        name,
        "browser_capture"
            | "browser_select_tab"
            | "browser_click"
            | "browser_type"
            | "browser_hover"
            | "browser_press_key"
            | "browser_select_option"
    )
}

impl BrowserTools {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

// A cold WebKit child registers in one to three seconds, and a routine's first browser
// step is the caller here with nobody to retry for it: 8 s is generous, and still
// nothing after that is a named error, never a silent no-op.
const OPEN_WAIT: std::time::Duration = std::time::Duration::from_secs(8);

fn existing_surface(
    app: &AppHandle,
    scope: &McpScope,
    args: &Value,
) -> Result<Option<String>, ToolError> {
    let registry = app.state::<BrowserRegistry>();
    let state = super::lock_registry(&registry).map_err(ToolError)?;
    resolve_target(&state, scope, args)
}

pub(super) fn resolve_target(
    state: &super::RegistryState,
    scope: &McpScope,
    args: &Value,
) -> Result<Option<String>, ToolError> {
    if let Some(value) = args.get("tabId") {
        let id = value
            .as_str()
            .ok_or_else(|| ToolError(format!("tabId must be a string, got {value}")))?;
        if state.children.get(id).is_some_and(|entry| {
            !entry.closing && entry.workspace_id.as_deref() == Some(&scope.workspace_id)
        }) {
            return Ok(Some(id.to_string()));
        }
        let available: Vec<_> = state.children.iter().filter(|(_, e)| !e.closing && e.workspace_id.as_deref() == Some(&scope.workspace_id))
            .map(|(id, e)| json!({"tabId": id, "url": e.last_state.as_ref().and_then(|s| s.url.as_deref())})).collect();
        return Err(ToolError(format!(
            "tabId {id:?} is not live in workspace {:?}; available tabs: {}",
            scope.workspace_id,
            json!(available)
        )));
    }
    Ok(super::resolve_default_surface(state, &scope.workspace_id))
}

// A browser pane registers a surface only once it has a page, so the open request must
// carry the URL: a pane opened empty shows its start screen and never becomes reachable.
async fn open_surface_at(
    app: &AppHandle,
    scope: &McpScope,
    url: &str,
    operation: &str,
) -> Result<String, ToolError> {
    let surface_id = format!("agent-{}", uuid::Uuid::new_v4());
    {
        let registry = app.state::<BrowserRegistry>();
        let state = super::lock_registry(&registry).map_err(ToolError)?;
        let live_ids: Vec<_> = state.children.keys().cloned().collect();
        super::check_cap(&live_ids, &surface_id, super::MAX_LIVE_CHILDREN)
            .map_err(|err| ToolError(format!("{operation}: {err}")))?;
    }
    if let Err(err) = app.emit(
        super::state::OPEN_REQUEST_EVENT,
        &json!({ "workspaceId": scope.workspace_id, "action": "open", "surfaceId": surface_id, "url": url }),
    ) {
        return Err(ToolError(format!(
            "browser_open_failed: requested {operation}: no browser pane in workspace {:?}, and asking the app to open one failed: {err}",
            scope.workspace_id
        )));
    }
    if wait_for_exact_surface(&surface_id, OPEN_WAIT, || {
        super::surfaces_in(app, &scope.workspace_id)
    })
    .await
    {
        let registry = app.state::<BrowserRegistry>();
        super::lock_registry(&registry)
            .map_err(ToolError)?
            .opened_by_session
            .insert(surface_id.clone(), scope.session_id);
        return Ok(surface_id);
    }
    Err(ToolError(format!(
        "{} Requested surfaceId {surface_id:?}.",
        no_pane_after_wait(&scope.workspace_id, url, OPEN_WAIT, operation)
    )))
}

async fn wait_for_exact_surface(
    id: &str,
    timeout: std::time::Duration,
    mut live: impl FnMut() -> Vec<String>,
) -> bool {
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if live().iter().any(|surface| surface == id) {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep_until((tokio::time::Instant::now() + WAIT_POLL).min(deadline)).await;
    }
}

// Reveal must finish promptly even if the renderer never acknowledges the requested tab.
const REVEAL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

fn surface_visible(app: &AppHandle, surface: &str) -> Result<bool, String> {
    let registry = app.state::<BrowserRegistry>();
    let guard = super::lock_registry(&registry)?;
    let entry = guard
        .children
        .get(surface)
        .ok_or_else(|| format!("surface {surface:?} disappeared"))?;
    Ok(!entry.closing && !entry.suppressed.is_hidden())
}

async fn reveal_surface(
    app: &AppHandle,
    scope: &McpScope,
    surface: &str,
    operation: &str,
) -> Result<(), ToolError> {
    let url = super::last_state_for(app, surface)
        .and_then(|state| state.url)
        .unwrap_or_default();
    reveal_when_hidden(
        &scope.workspace_id,
        surface,
        &format!("{operation} at {url}"),
        REVEAL_TIMEOUT,
        || surface_visible(app, surface),
        || {
            app.emit(
                super::state::OPEN_REQUEST_EVENT,
                &json!({"workspaceId": scope.workspace_id, "surfaceId": surface, "action": "reveal"}),
            )
            .map_err(|err| err.to_string())
        },
    )
    .await
}

async fn reveal_when_hidden(
    workspace: &str,
    surface: &str,
    url: &str,
    timeout: std::time::Duration,
    mut visible: impl FnMut() -> Result<bool, String>,
    request: impl FnOnce() -> Result<(), String>,
) -> Result<(), ToolError> {
    let started = tokio::time::Instant::now();
    let failure = |reason: String| {
        ToolError(format!(
        "browser_reveal_failed: requested operation {url:?}, workspace {workspace:?}, surface {surface:?}: {reason} (REVEAL_TIMEOUT={}ms, actual={}ms)", timeout.as_millis(), started.elapsed().as_millis()
    ))
    };
    if visible().map_err(failure)? {
        return Ok(());
    }
    request().map_err(failure)?;
    let deadline = tokio::time::Instant::now() + timeout;
    loop {
        if visible().map_err(failure)? {
            return Ok(());
        }
        if tokio::time::Instant::now() >= deadline {
            return Err(failure("exact surface did not become visible".into()));
        }
        tokio::time::sleep_until((tokio::time::Instant::now() + WAIT_POLL).min(deadline)).await;
    }
}

fn no_pane_after_wait(
    workspace_id: &str,
    url: &str,
    waited: std::time::Duration,
    operation: &str,
) -> String {
    format!(
        "browser_open_failed: OPEN_WAIT limit={}ms, actual={}ms, requested {operation}: no browser pane in workspace {workspace_id:?} — asked the app to open one at {url:?} \
         and none appeared within {}s. Open a browser pane in this workspace and retry. \
         (Browser tools only ever reach panes in the workspace this agent session runs in.)",
        waited.as_millis(), waited.as_millis(), waited.as_secs()
    )
}

fn no_page_open(workspace_id: &str, tool: &str) -> String {
    format!(
        "{tool} found no browser pane with a page open in workspace {workspace_id:?}. Call \
         browser_navigate with a URL first; it opens a browser pane at that URL when the \
         workspace has none. (Browser tools only ever reach panes in the workspace this agent \
         session runs in.)"
    )
}

pub(super) fn require_session_opened(
    state: &super::RegistryState,
    surface: &str,
    session: u32,
) -> Result<(), ToolError> {
    if state.opened_by_session.get(surface) == Some(&session) {
        return Ok(());
    }
    Err(ToolError(format!(
        "browser_close_tab refuses tab {surface:?}: session {session} did not open it"
    )))
}

impl ToolProvider for BrowserTools {
    fn tools(&self, _scope: &McpScope) -> Vec<ToolSpec> {
        houston_core::browser_relay::tool_specs()
    }

    fn all_tools(&self) -> Vec<ToolSpec> {
        houston_core::browser_relay::tool_specs()
    }

    fn instructions(&self, _scope: &McpScope) -> Option<String> {
        Some(houston_core::browser_relay::INSTRUCTIONS.to_string())
    }

    fn call<'a>(
        &'a self,
        scope: &'a McpScope,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            #[cfg(not(target_os = "linux"))]
            if matches!(name, "browser_console_messages" | "browser_scroll") {
                return Err(ToolError(format!(
                    "{name} is unsupported on {}: native page instrumentation is unavailable",
                    std::env::consts::OS
                )));
            }
            if name == "browser_tabs" {
                let registry = self.app.state::<BrowserRegistry>();
                let state = super::lock_registry(&registry).map_err(ToolError)?;
                let active = super::resolve_default_surface(&state, &scope.workspace_id);
                let tabs: Vec<_> = state.children.iter()
                    .filter(|(_, e)| !e.closing && e.workspace_id.as_deref() == Some(&scope.workspace_id))
                    .map(|(id, e)| json!({"tabId": id, "url": e.last_state.as_ref().and_then(|s| s.url.as_deref()),
                        "title": e.last_state.as_ref().and_then(|s| s.title.as_deref()), "active": active.as_ref() == Some(id),
                        "openedBySession": state.opened_by_session.get(id) == Some(&scope.session_id)})).collect();
                return Ok(ToolOutput::structured(json!({"tabs": tabs})));
            }
            if name == "browser_new_tab" {
                let url = navigate_url(args)?;
                let surface = open_surface_at(&self.app, scope, url, name).await?;
                return Ok(navigated(&surface, url));
            }
            if name == "browser_navigate" {
                let url = navigate_url(args)?;
                return match existing_surface(&self.app, scope, args)? {
                    Some(surface) => navigate(&self.app, &surface, url),
                    None => {
                        let surface = open_surface_at(&self.app, scope, url, name).await?;
                        Ok(navigated(&surface, url))
                    }
                };
            }
            if matches!(name, "browser_select_tab" | "browser_close_tab")
                && args.get("tabId").is_none()
            {
                return Err(ToolError(format!(
                    "{name} requires a string tabId; use browser_tabs to list available ids"
                )));
            }
            let surface = existing_surface(&self.app, scope, args)?
                .ok_or_else(|| ToolError(no_page_open(&scope.workspace_id, name)))?;
            if name == "browser_close_tab" {
                let registry = self.app.state::<BrowserRegistry>();
                require_session_opened(
                    &*super::lock_registry(&registry).map_err(ToolError)?,
                    &surface,
                    scope.session_id,
                )?;
                self.app.emit(super::state::OPEN_REQUEST_EVENT, json!({"workspaceId": scope.workspace_id, "action": "close", "surfaceId": surface})).map_err(|e| ToolError(e.to_string()))?;
                return Ok(ToolOutput::structured(
                    json!({"surfaceId": surface, "action": "close"}),
                ));
            }
            if requires_reveal(name) {
                reveal_surface(&self.app, scope, &surface, name).await?;
            }
            match name {
                "browser_select_tab" => {
                    super::browser_set_active(
                        self.app.state::<BrowserRegistry>(),
                        surface.clone(),
                        scope.workspace_id.clone(),
                    )
                    .map_err(ToolError)?;
                    // A visible background tab still needs selection.
                    self.app.emit(super::state::OPEN_REQUEST_EVENT, json!({"workspaceId": scope.workspace_id, "action": "reveal", "surfaceId": surface})).map_err(|e| ToolError(e.to_string()))?;
                    Ok(ToolOutput::structured(
                        json!({"surfaceId": surface, "selected": true}),
                    ))
                }
                "browser_reload" => {
                    let bypass = match args.get("bypassCache") {
                        None => false,
                        Some(v) => v.as_bool().ok_or_else(|| {
                            ToolError(format!(
                                "browser_reload bypassCache must be a boolean, got {v}"
                            ))
                        })?,
                    };
                    super::browser_reload(
                        self.app.clone(),
                        self.app.state::<BrowserRegistry>(),
                        surface.clone(),
                        bypass,
                    )
                    .map_err(ToolError)?;
                    Ok(ToolOutput::structured(
                        json!({"surfaceId": surface, "reloaded": true, "bypassCache": bypass}),
                    ))
                }
                "browser_scroll" => {
                    let delta = match args.get("deltaY") {
                        None => 600.0,
                        Some(v) => v.as_f64().filter(|d| d.is_finite() && d.abs() <= 100_000.0)
                            .ok_or_else(|| ToolError(format!("browser_scroll deltaY {v} exceeds the 100000 pixel limit or is not a finite number")))?,
                    };
                    let op = if args.get("ref").is_some() {
                        let element = required_ref(args, name)?;
                        let locator = locator_for(&self.app, &surface, &element)?;
                        locator_op("scroll", &element, &locator, json!({"deltaY": delta}))
                    } else {
                        json!({"kind": "scroll", "deltaY": delta})
                    };
                    page_op(&self.app, &surface, op).await
                }
                "browser_console_messages" => console_messages(&self.app, &surface, args),
                "browser_current_page" => current_page(&self.app, &surface),
                "browser_capture" => capture(&self.app, &surface).await,
                "browser_snapshot" => snapshot(&self.app, &surface).await,
                "browser_click" => {
                    let element = required_ref(args, "browser_click")?;
                    let locator = locator_for(&self.app, &surface, &element)?;
                    gate(
                        &self.app,
                        scope,
                        &surface,
                        PendingAct {
                            kind: confirm::ActKind::Click,
                            element_ref: &element,
                            locator: &locator,
                            text: None,
                            replace: false,
                        },
                    )
                    .await?;
                    note_page_outcome(
                        &self.app,
                        &surface,
                        page_op(
                            &self.app,
                            &surface,
                            locator_op("click", &element, &locator, json!({})),
                        )
                        .await,
                    )
                }
                "browser_type" => {
                    let element = required_ref(args, "browser_type")?;
                    let text = args.get("text").and_then(Value::as_str).ok_or_else(|| {
                        ToolError("browser_type needs a string \"text\" argument".to_string())
                    })?;
                    let replace = args
                        .get("replace")
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    let locator = locator_for(&self.app, &surface, &element)?;
                    gate(
                        &self.app,
                        scope,
                        &surface,
                        PendingAct {
                            kind: confirm::ActKind::Type,
                            element_ref: &element,
                            locator: &locator,
                            text: Some(text),
                            replace,
                        },
                    )
                    .await?;
                    note_page_outcome(
                        &self.app,
                        &surface,
                        page_op(
                            &self.app,
                            &surface,
                            locator_op(
                                "type",
                                &element,
                                &locator,
                                json!({ "text": text, "replace": replace }),
                            ),
                        )
                        .await,
                    )
                }
                "browser_hover" => {
                    let element = required_ref(args, "browser_hover")?;
                    let locator = locator_for(&self.app, &surface, &element)?;
                    gate(
                        &self.app,
                        scope,
                        &surface,
                        PendingAct {
                            kind: confirm::ActKind::Hover,
                            element_ref: &element,
                            locator: &locator,
                            text: None,
                            replace: false,
                        },
                    )
                    .await?;
                    page_op(
                        &self.app,
                        &surface,
                        locator_op("hover", &element, &locator, json!({})),
                    )
                    .await
                }
                "browser_press_key" => {
                    let element = required_ref(args, "browser_press_key")?;
                    let key = args.get("key").and_then(Value::as_str).ok_or_else(|| {
                        ToolError(
                            "browser_press_key needs a string \"key\" argument, e.g. \"Enter\""
                                .to_string(),
                        )
                    })?;
                    let locator = locator_for(&self.app, &surface, &element)?;
                    gate(
                        &self.app,
                        scope,
                        &surface,
                        PendingAct {
                            kind: confirm::ActKind::PressKey,
                            element_ref: &element,
                            locator: &locator,
                            text: Some(key),
                            replace: false,
                        },
                    )
                    .await?;
                    note_page_outcome(
                        &self.app,
                        &surface,
                        page_op(
                            &self.app,
                            &surface,
                            locator_op("press", &element, &locator, json!({ "key": key })),
                        )
                        .await,
                    )
                }
                "browser_select_option" => {
                    let element = required_ref(args, "browser_select_option")?;
                    let value = args.get("value").and_then(Value::as_str).ok_or_else(|| {
                        ToolError(
                            "browser_select_option needs a string \"value\" argument naming \
                             the option to choose (by value or visible label)"
                                .to_string(),
                        )
                    })?;
                    let locator = locator_for(&self.app, &surface, &element)?;
                    gate(
                        &self.app,
                        scope,
                        &surface,
                        PendingAct {
                            kind: confirm::ActKind::SelectOption,
                            element_ref: &element,
                            locator: &locator,
                            text: Some(value),
                            replace: false,
                        },
                    )
                    .await?;
                    note_page_outcome(
                        &self.app,
                        &surface,
                        page_op(
                            &self.app,
                            &surface,
                            locator_op(
                                "selectOption",
                                &element,
                                &locator,
                                json!({ "value": value }),
                            ),
                        )
                        .await,
                    )
                }
                "browser_go_back" => history_step(&self.app, &surface, HistoryStep::Back),
                "browser_go_forward" => history_step(&self.app, &surface, HistoryStep::Forward),
                "browser_wait_for" => wait_for(&self.app, &surface, args).await,
                other => Err(ToolError(format!("browser provider has no tool {other:?}"))),
            }
        })
    }
}

fn console_messages(app: &AppHandle, surface: &str, args: &Value) -> Result<ToolOutput, ToolError> {
    #[cfg(not(target_os = "linux"))]
    {
        let _ = (app, surface, args);
        Err(ToolError(format!(
            "browser_console_messages is unsupported on {}",
            std::env::consts::OS
        )))
    }
    #[cfg(target_os = "linux")]
    {
        let level = match args.get("level") {
            None => None,
            Some(v) => Some(v.as_str().filter(|l| matches!(*l, "log" | "debug" | "info" | "warn" | "error"))
                .ok_or_else(|| ToolError(format!("browser_console_messages level {v} must be log, debug, info, warn or error")))?),
        };
        let since = args
            .get("sinceId")
            .map(|v| {
                v.as_u64().ok_or_else(|| {
                    ToolError(format!(
                        "browser_console_messages sinceId must be a non-negative integer, got {v}"
                    ))
                })
            })
            .transpose()?
            .unwrap_or(0);
        let limit = args
            .get("limit")
            .map(|v| {
                v.as_u64()
                    .filter(|n| *n > 0 && *n <= super::console::MAX_MESSAGES as u64)
                    .ok_or_else(|| {
                        ToolError(format!(
                            "browser_console_messages limit {v} must be 1..={} (MAX_MESSAGES)",
                            super::console::MAX_MESSAGES
                        ))
                    })
            })
            .transpose()?
            .unwrap_or(100) as usize;
        let registry = app.state::<BrowserRegistry>();
        let state = super::lock_registry(&registry).map_err(ToolError)?;
        let entry = state.children.get(surface).ok_or_else(|| {
            ToolError(format!(
                "browser_console_messages tab {surface:?} disappeared"
            ))
        })?;
        Ok(ToolOutput::structured(
            json!({"surfaceId": surface, "trust": "untrusted page content", "messages": entry.console.read(level, since, limit)}),
        ))
    }
}

fn current_page(app: &AppHandle, surface: &str) -> Result<ToolOutput, ToolError> {
    let state = super::last_state_for(app, surface).ok_or_else(|| {
        ToolError(format!(
            "browser pane {surface:?} has not reported any page state yet — it is mounted but \
             has not finished loading a page. Retry in a moment, or navigate it somewhere."
        ))
    })?;
    let mut value = serde_json::to_value(&state).map_err(|e| {
        ToolError(format!(
            "could not serialize page state for {surface:?}: {e}"
        ))
    })?;
    value["surfaceId"] = json!(surface);
    Ok(ToolOutput::structured(value))
}

async fn capture(app: &AppHandle, surface: &str) -> Result<ToolOutput, ToolError> {
    let registry = app.state::<BrowserRegistry>();
    let path = super::browser_capture(app.clone(), registry, surface.to_string())
        .await
        .map_err(ToolError)?;
    Ok(ToolOutput::structured(json!({
        "surfaceId": surface,
        "screenshotPath": path,
    })))
}

fn navigate_url(args: &Value) -> Result<&str, ToolError> {
    let url = args
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| ToolError("browser_navigate needs a string \"url\" argument".to_string()))?;
    if !crate::shell::is_http_or_https(url) {
        return Err(ToolError(format!(
            "browser_navigate refuses url {url:?}: only http:// and https:// are allowed. \
             This pane is the user's authenticated browser session."
        )));
    }
    Ok(url)
}

fn navigate(app: &AppHandle, surface: &str, url: &str) -> Result<ToolOutput, ToolError> {
    let registry = app.state::<BrowserRegistry>();
    super::browser_navigate(app.clone(), registry, surface.to_string(), url.to_string())
        .map_err(ToolError)?;
    Ok(navigated(surface, url))
}

fn navigated(surface: &str, url: &str) -> ToolOutput {
    ToolOutput::structured(json!({
        "surfaceId": surface,
        "navigatedTo": url,
    }))
}

enum HistoryStep {
    Back,
    Forward,
}

fn history_step(
    app: &AppHandle,
    surface: &str,
    step: HistoryStep,
) -> Result<ToolOutput, ToolError> {
    let registry = app.state::<BrowserRegistry>();
    let action = match step {
        HistoryStep::Back => {
            super::browser_go_back(app.clone(), registry, surface.to_string())
                .map_err(ToolError)?;
            "back"
        }
        HistoryStep::Forward => {
            super::browser_go_forward(app.clone(), registry, surface.to_string())
                .map_err(ToolError)?;
            "forward"
        }
    };
    Ok(ToolOutput::structured(json!({
        "surfaceId": surface,
        "action": action,
        "note": "history navigation started; browser_current_page reports where it landed",
    })))
}

// How often `browser_wait_for` re-checks: 250 ms keeps each check to one synchronous
// innerText scan while noticing a change within a quarter second. `WAIT_MAX_MS` stops
// one call pinning an MCP request open for minutes.
const WAIT_POLL: std::time::Duration = std::time::Duration::from_millis(250);
const WAIT_DEFAULT_MS: u64 = 5000;
const WAIT_MAX_MS: u64 = 15000;

fn wait_timeout_ms(args: &Value) -> Result<u64, ToolError> {
    match args.get("timeoutMs") {
        None => Ok(WAIT_DEFAULT_MS),
        Some(v) => {
            let asked = v.as_u64().ok_or_else(|| {
                ToolError(format!(
                    "browser_wait_for timeoutMs must be a positive integer, got {v}"
                ))
            })?;
            if asked > WAIT_MAX_MS {
                return Err(ToolError(format!(
                    "browser_wait_for timeoutMs is capped at {WAIT_MAX_MS} ms (WAIT_MAX_MS); \
                     {asked} ms was asked for. Call it again if you need to keep waiting."
                )));
            }
            Ok(asked)
        }
    }
}

async fn wait_for(app: &AppHandle, surface: &str, args: &Value) -> Result<ToolOutput, ToolError> {
    let text = args
        .get("text")
        .and_then(Value::as_str)
        .filter(|t| !t.is_empty())
        .ok_or_else(|| {
            ToolError(
                "browser_wait_for needs a non-empty string \"text\" argument to wait for"
                    .to_string(),
            )
        })?;
    let timeout_ms = wait_timeout_ms(args)?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(timeout_ms);
    loop {
        let out = page_op(app, surface, json!({ "kind": "exists", "text": text })).await?;
        let found = out
            .structured
            .as_ref()
            .and_then(|v| v.get("found"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if found {
            return Ok(ToolOutput::structured(json!({
                "surfaceId": surface,
                "found": true,
                "text": text,
            })));
        }
        if std::time::Instant::now() >= deadline {
            return Ok(ToolOutput::structured(json!({
                "surfaceId": surface,
                "found": false,
                "text": text,
                "waitedMs": timeout_ms,
            })));
        }
        tokio::time::sleep(WAIT_POLL).await;
    }
}

struct PendingAct<'a> {
    kind: confirm::ActKind,
    element_ref: &'a str,
    locator: &'a super::tool_refs::Locator,
    text: Option<&'a str>,
    replace: bool,
}

// The order here is the security property: resolve the ref, reveal and describe the
// element, and capture the pane *before* asking, so the human is shown what is actually
// there rather than the agent's account of it.
async fn gate(
    app: &AppHandle,
    scope: &McpScope,
    surface: &str,
    act: PendingAct<'_>,
) -> Result<(), ToolError> {
    let PendingAct {
        kind,
        element_ref,
        locator,
        text,
        replace,
    } = act;
    let registry = app.state::<confirm::ConfirmRegistry>();
    if registry.is_trusted(&scope.workspace_id) {
        return Ok(());
    }

    let _ = page_op(
        app,
        surface,
        locator_op("reveal", element_ref, locator, json!({})),
    )
    .await;

    let described = page_op(
        app,
        surface,
        locator_op("describe", element_ref, locator, json!({})),
    )
    .await?;
    let element = described
        .structured
        .as_ref()
        .and_then(|v| v.get("element"))
        .cloned()
        .unwrap_or_else(|| json!({ "ref": element_ref }));

    let screenshot = capture(app, surface).await.ok().and_then(|out| {
        out.structured
            .as_ref()
            .and_then(|v| v.get("screenshotPath"))
            .and_then(Value::as_str)
            .map(std::path::PathBuf::from)
    });

    let page = super::last_state_for(app, surface);
    confirm::await_decision(
        app,
        &registry,
        confirm::ConfirmRequest {
            id: String::new(),
            surface_id: surface.to_string(),
            workspace_id: scope.workspace_id.clone(),
            kind,
            element,
            text: text.map(str::to_string),
            replace,
            has_screenshot: screenshot.is_some(),
            url: page.as_ref().and_then(|p| p.url.clone()),
            title: page.as_ref().and_then(|p| p.title.clone()),
            timeout_secs: confirm::DECISION_TIMEOUT.as_secs(),
        },
        screenshot,
    )
    .await
    .map_err(ToolError)?;
    if super::tool_ref_get(app, surface, element_ref).as_ref() != Some(locator) {
        return Err(unknown_ref_error(element_ref));
    }
    Ok(())
}

fn required_ref(args: &Value, tool: &str) -> Result<String, ToolError> {
    let element = args.get("ref").and_then(Value::as_str).ok_or_else(|| {
        ToolError(format!(
            "{tool} needs a string \"ref\" argument naming an element from the latest \
             browser_snapshot"
        ))
    })?;
    let valid = element.len() >= 2
        && element.starts_with('e')
        && element[1..].bytes().all(|b| b.is_ascii_digit());
    if !valid {
        return Err(ToolError(format!(
            "{tool} was given ref {element:?}, which is not a snapshot ref. Refs look like \
             \"e12\" and come from browser_snapshot — take one and use a ref it returned."
        )));
    }
    Ok(element.to_string())
}

fn locator_for(
    app: &AppHandle,
    surface: &str,
    element_ref: &str,
) -> Result<super::tool_refs::Locator, ToolError> {
    super::tool_ref_get(app, surface, element_ref).ok_or_else(|| unknown_ref_error(element_ref))
}

fn unknown_ref_error(element_ref: &str) -> ToolError {
    ToolError(format!(
        "no element for ref {element_ref:?}. Refs come from the most recent \
             browser_snapshot of this surface and do not survive a navigation — take a \
             fresh browser_snapshot and use a ref it returned."
    ))
}

fn locator_op(
    kind: &str,
    element_ref: &str,
    locator: &super::tool_refs::Locator,
    extra: Value,
) -> Value {
    let mut op = json!({
        "kind": kind,
        "ref": element_ref,
        "path": locator.path,
        "tags": locator.tags,
        "documentIdentity": locator.document_identity,
        "elementIdentity": locator.element_identity,
    });
    if let Value::Object(extra) = extra {
        for (k, v) in extra {
            op[k] = v;
        }
    }
    op
}

async fn snapshot(app: &AppHandle, surface: &str) -> Result<ToolOutput, ToolError> {
    let start_seq = super::tool_refs_start(app, surface).ok_or_else(|| {
        ToolError(format!(
            "browser surface {surface:?} disappeared between resolving it and              snapshotting it — retry, and reopen the browser pane if this persists"
        ))
    })?;
    let out = page_op(
        app,
        surface,
        json!({ "kind": "snapshot", "startSeq": start_seq,
            "cleanupIdentity": super::tool_refs_cleanup_identity(app, surface) }),
    )
    .await?;
    let Some(mut result) = out.structured else {
        return Err(ToolError(
            "the page toolkit returned a snapshot with no structured result".to_string(),
        ));
    };
    let raw_locators = result
        .as_object_mut()
        .and_then(|map| map.remove("locators"))
        .unwrap_or_else(|| json!({}));
    let entries = parse_locators(&raw_locators)?;
    let minted = entries.len() as u64;
    super::tool_refs_replace(app, surface, entries, minted);
    Ok(ToolOutput::structured(result))
}

fn parse_locators(
    raw: &Value,
) -> Result<std::collections::HashMap<String, super::tool_refs::Locator>, ToolError> {
    let Some(map) = raw.as_object() else {
        return Err(ToolError(format!(
            "the page toolkit's snapshot returned locators of the wrong shape              (expected an object, got {raw})"
        )));
    };
    let mut out = std::collections::HashMap::with_capacity(map.len());
    for (element_ref, locator) in map {
        let path: Option<Vec<u32>> = locator.get("path").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(Value::as_u64)
                .filter_map(|n| u32::try_from(n).ok())
                .collect()
        });
        let tags: Option<Vec<String>> = locator.get("tags").and_then(Value::as_array).map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        });
        match (path, tags) {
            (Some(path), Some(tags)) if path.len() == tags.len() => {
                out.insert(
                    element_ref.clone(),
                    super::tool_refs::Locator { path, tags,
                        document_identity: locator.get("documentIdentity").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| ToolError(format!("missing document identity in locator {locator}")))?.into(),
                        element_identity: locator.get("elementIdentity").and_then(Value::as_str).filter(|s| !s.is_empty()).ok_or_else(|| ToolError(format!("missing element identity in locator {locator}")))?.into(),
                    },
                );
            }
            _ => {
                return Err(ToolError(format!(
                    "the page toolkit's snapshot returned a malformed locator for                      {element_ref:?}: {locator}"
                )))
            }
        }
    }
    Ok(out)
}

async fn page_op(app: &AppHandle, surface: &str, op: Value) -> Result<ToolOutput, ToolError> {
    let registry = app.state::<BrowserRegistry>();
    let webview =
        super::live_webview(app, &registry, surface, "using the page tools").map_err(ToolError)?;
    let raw = super::webkit::eval_tools(&webview, surface, &op.to_string())
        .await
        .map_err(ToolError)?;
    let envelope: Value = serde_json::from_str(&raw).map_err(|e| {
        ToolError(format!(
            "the page toolkit returned something that is not JSON for surface {surface:?}: {e}"
        ))
    })?;
    if envelope.get("ok").and_then(Value::as_bool) != Some(true) {
        let message = envelope
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("the page toolkit reported a failure with no message");
        return Err(ToolError(message.to_string()));
    }
    let mut result = envelope.get("result").cloned().unwrap_or_else(|| json!({}));
    result["surfaceId"] = json!(surface);
    Ok(ToolOutput::structured(result))
}

const PAGE_OUTCOME_NOTE: &str = "navigation triggered by this act may still be in flight; \
     browser_current_page has the settled answer once it does";

fn attach_page_outcome(mut structured: Value, page_url: Option<Option<String>>) -> Value {
    if let (Value::Object(map), Some(url)) = (&mut structured, page_url) {
        map.insert("pageUrl".into(), json!(url));
        map.insert("note".into(), json!(PAGE_OUTCOME_NOTE));
    }
    structured
}

fn note_page_outcome(
    app: &AppHandle,
    surface: &str,
    result: Result<ToolOutput, ToolError>,
) -> Result<ToolOutput, ToolError> {
    let output = result?;
    let Some(structured) = output.structured else {
        return Ok(output);
    };
    let page_url = super::last_state_for(app, surface).map(|state| state.url);
    Ok(ToolOutput::structured(attach_page_outcome(
        structured, page_url,
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use houston_core::browser_relay::{tool_specs, INSTRUCTIONS};

    #[test]
    fn background_page_tools_do_not_reveal_but_pixels_and_confirmation_do() {
        for name in [
            "browser_current_page",
            "browser_snapshot",
            "browser_console_messages",
            "browser_wait_for",
            "browser_tabs",
            "browser_navigate",
            "browser_go_back",
            "browser_go_forward",
            "browser_reload",
            "browser_scroll",
            "browser_close_tab",
        ] {
            assert!(
                !requires_reveal(name),
                "{name} must preserve the selected workspace and panel"
            );
        }
        for name in [
            "browser_capture",
            "browser_select_tab",
            "browser_click",
            "browser_type",
            "browser_hover",
            "browser_press_key",
            "browser_select_option",
        ] {
            assert!(
                requires_reveal(name),
                "{name} needs pixels or human confirmation"
            );
        }
    }

    fn scope() -> McpScope {
        McpScope {
            session_id: 1,
            workspace_id: "/home/dev/proj".into(),
        }
    }

    #[test]
    fn the_no_pane_error_names_the_workspace_the_wait_and_the_fix() {
        let msg = no_pane_after_wait(
            &scope().workspace_id,
            "http://localhost:4388/",
            OPEN_WAIT,
            "browser_navigate",
        );
        assert!(msg.contains("/home/dev/proj"));
        assert!(msg.contains("asked the app to open one at \"http://localhost:4388/\""));
        assert!(msg.contains("within 8s"));
        assert!(msg.contains("Open a browser pane"));
    }

    #[test]
    fn a_tool_with_no_page_open_names_the_workspace_and_points_at_navigate() {
        let msg = no_page_open(&scope().workspace_id, "browser_snapshot");
        assert!(msg.starts_with("browser_snapshot "));
        assert!(msg.contains("/home/dev/proj"));
        assert!(msg.contains("Call browser_navigate with a URL first"));
    }

    #[test]
    fn navigate_validates_the_url_before_any_pane_is_opened() {
        assert_eq!(
            navigate_url(&json!({ "url": "http://127.0.0.1:4388/" })).unwrap(),
            "http://127.0.0.1:4388/"
        );
        let refused = navigate_url(&json!({ "url": "file:///etc/passwd" })).unwrap_err();
        assert!(refused.0.contains("\"file:///etc/passwd\""));
        let missing = navigate_url(&json!({})).unwrap_err();
        assert!(missing.0.contains("needs a string \"url\" argument"));
    }

    #[test]
    fn navigate_refuses_every_scheme_but_http_and_https() {
        for url in [
            "file:///etc/passwd",
            "data:text/html,<script>1</script>",
            "javascript:alert(1)",
            "tr-asset://x",
            "ftp://example.com",
        ] {
            assert!(
                !crate::shell::is_http_or_https(url),
                "{url} must not pass the tool-boundary check"
            );
        }
        for url in ["http://example.com", "HTTPS://Example.com/x"] {
            assert!(crate::shell::is_http_or_https(url), "{url} must pass");
        }
    }

    #[test]
    fn every_tool_declares_annotations_matching_what_it_does() {
        let specs = tool_specs();
        for spec in &specs {
            let a = spec.annotations;
            assert!(a.open_world, "{} touches the open web", spec.name);
            if spec.name.ends_with("current_page") || spec.name.ends_with("capture") {
                assert!(a.read_only && a.idempotent, "{} must read only", spec.name);
            }
            if spec.name.ends_with("navigate") {
                assert!(!a.read_only, "navigate is not a read");
            }
        }
        assert!(
            specs.iter().all(|s| s.name.starts_with("browser_")),
            "every browser tool is namespaced so it cannot collide with a builtin"
        );
    }

    #[test]
    fn an_unknown_ref_names_the_ref_and_where_refs_come_from() {
        let err = unknown_ref_error("e7").0;
        assert!(err.contains("\"e7\""), "{err}");
        assert!(err.contains("browser_snapshot"), "{err}");
        assert!(err.contains("navigation"), "{err}");
    }

    #[test]
    fn snapshot_locators_parse_into_the_store_shape() {
        let raw = json!({
            "e1": { "documentIdentity": "document", "elementIdentity": "element", "path": [1, 0], "tags": ["body", "button"] },
            "e2": { "documentIdentity": "document", "elementIdentity": "element", "path": [], "tags": [] }
        });
        let parsed = parse_locators(&raw).unwrap();
        assert_eq!(
            parsed.get("e1"),
            Some(&super::super::tool_refs::Locator {
                document_identity: "document".into(),
                element_identity: "element".into(),
                path: vec![1, 0],
                tags: vec!["body".into(), "button".into()],
            })
        );
        assert_eq!(parsed.len(), 2);
    }

    #[test]
    fn a_malformed_locator_is_refused_and_named() {
        let raw = json!({ "e3": { "documentIdentity": "document", "elementIdentity": "element", "path": [0], "tags": ["body", "button"] } });
        let err = parse_locators(&raw).unwrap_err().0;
        assert!(err.contains("\"e3\""), "{err}");
        assert!(err.contains("malformed"), "{err}");
    }

    #[test]
    fn the_instructions_name_the_tools_the_gate_and_the_alternatives() {
        assert!(INSTRUCTIONS.contains("browser_"), "{INSTRUCTIONS}");
        assert!(INSTRUCTIONS.contains("browser_snapshot"), "{INSTRUCTIONS}");
        assert!(
            INSTRUCTIONS.contains("confirmed by the user"),
            "{INSTRUCTIONS}"
        );
        assert!(INSTRUCTIONS.contains("Playwright"), "{INSTRUCTIONS}");
        assert!(
            INSTRUCTIONS.contains("120"),
            "must warn that an act tool can block up to 120s on the confirmation gate: {INSTRUCTIONS}"
        );
    }

    #[test]
    fn the_wait_timeout_cap_names_the_limit_and_the_ask() {
        let err = wait_timeout_ms(&json!({ "timeoutMs": 60000 }))
            .unwrap_err()
            .0;
        assert!(err.contains("15000"), "{err}");
        assert!(err.contains("60000"), "{err}");
        assert!(err.contains("again"), "{err}");
        assert_eq!(wait_timeout_ms(&json!({})).unwrap(), 5000);
        assert_eq!(wait_timeout_ms(&json!({ "timeoutMs": 200 })).unwrap(), 200);
    }

    #[test]
    fn the_tool_surface_is_the_expected_closed_set() {
        let names: Vec<String> = tool_specs().into_iter().map(|s| s.name).collect();
        assert_eq!(
            names,
            [
                "browser_current_page",
                "browser_capture",
                "browser_navigate",
                "browser_snapshot",
                "browser_click",
                "browser_type",
                "browser_hover",
                "browser_press_key",
                "browser_select_option",
                "browser_go_back",
                "browser_go_forward",
                "browser_wait_for",
                "browser_tabs",
                "browser_new_tab",
                "browser_select_tab",
                "browser_close_tab",
                "browser_reload",
                "browser_scroll",
                "browser_console_messages",
                "browser_local_servers",
            ]
        );
    }

    #[test]
    fn attach_page_outcome_is_a_no_op_with_no_known_page_state() {
        let structured = json!({ "surfaceId": "p1", "ok": true });
        let out = attach_page_outcome(structured.clone(), None);
        assert_eq!(out, structured);
    }

    #[test]
    fn attach_page_outcome_adds_the_url_and_note_when_state_is_known() {
        let structured = json!({ "surfaceId": "p1" });
        let out = attach_page_outcome(structured, Some(Some("https://example.com".into())));
        assert_eq!(out["surfaceId"], "p1");
        assert_eq!(out["pageUrl"], "https://example.com");
        assert_eq!(out["note"], PAGE_OUTCOME_NOTE);
    }

    #[test]
    fn attach_page_outcome_reports_a_null_url_explicitly() {
        let out = attach_page_outcome(json!({}), Some(None));
        assert_eq!(out["pageUrl"], Value::Null);
        assert!(out.get("note").is_some());
    }

    #[test]
    fn the_page_op_carries_the_locator_beside_the_ref() {
        let locator = super::super::tool_refs::Locator {
            document_identity: "document".into(),
            element_identity: "element".into(),
            path: vec![1, 0],
            tags: vec!["body".into(), "input".into()],
        };
        let op = locator_op(
            "type",
            "e4",
            &locator,
            json!({ "text": "hi", "replace": true }),
        );
        assert_eq!(op["kind"], "type");
        assert_eq!(op["ref"], "e4");
        assert_eq!(op["path"], json!([1, 0]));
        assert_eq!(op["tags"], json!(["body", "input"]));
        assert_eq!(op["text"], "hi");
        assert_eq!(op["replace"], true);
    }

    #[test]
    fn byte_accounting() {
        // Workspace registration installs hooks; keep process-wide config out of parallel tests.
        if crate::test_home::run_isolated_test("browser::mcp_tools::tests::byte_accounting") {
            return;
        }
        let tmp = tempfile::tempdir().expect("tempdir");
        let daemon = houston_core::daemon::Daemon::new(houston_core::daemon::DaemonConfig::new(
            "byte-accounting-token".to_string(),
            tmp.path().join("houston.db"),
            houston_core::host_env::HostEnv::capture(),
        ))
        .expect("construct a daemon for byte accounting");
        daemon.mcp_tools.register(std::sync::Arc::new(
            houston_core::mcp_orchestration::OrchestrationTools::new(&daemon),
        ));

        let workspace = tmp.path().display().to_string();
        daemon
            .workspace_add(&workspace)
            .expect("register workspace");
        // On Windows, registration pre-warms the hook launcher in a background child. Exiting
        // while that child is still being created orphans it holding this process's stdout,
        // and the parent test then waits forever for the pipe to close.
        houston_core::claude_hooks::wait_for_launcher_prewarm();

        let served_bytes_and_count = |specs: &[ToolSpec]| -> (usize, usize) {
            let bytes: usize = specs.iter().map(|s| s.to_json().to_string().len()).sum();
            (bytes, specs.len())
        };

        daemon
            .orchestration_set(true)
            .expect("enable orchestration");
        let enabled_scope = McpScope {
            session_id: 1,
            workspace_id: workspace.clone(),
        };
        let enabled_specs = daemon.mcp_tools.list(&enabled_scope);
        let (enabled_bytes, enabled_count) = served_bytes_and_count(&enabled_specs);

        daemon
            .orchestration_set(false)
            .expect("disable orchestration");
        let disabled_scope = McpScope {
            session_id: 1,
            workspace_id: workspace.clone(),
        };
        let disabled_specs = daemon.mcp_tools.list(&disabled_scope);
        let (disabled_bytes, disabled_count) = served_bytes_and_count(&disabled_specs);

        let gateway_specs = houston_core::mcp_server::gateway_tool_specs();
        let (gateway_bytes, gateway_count) = served_bytes_and_count(&gateway_specs);

        eprintln!(
            "byte_accounting: claude/enabled {enabled_bytes} B / {enabled_count} tools, \
             claude/disabled {disabled_bytes} B / {disabled_count} tools, \
             codex gateway {gateway_bytes} B / {gateway_count} tools"
        );

        // Two merge queue verbs (#124); measured 57 tools and 28,441 bytes after adding them.
        assert_eq!(enabled_count, 57, "{enabled_specs:?}");
        assert_eq!(disabled_count, 37, "{disabled_specs:?}");
        assert_eq!(gateway_count, 2, "{gateway_specs:?}");
        assert!(
            enabled_bytes < 29_000,
            "claude/enabled catalogue is {enabled_bytes} B; expected less than 29000 B"
        );
        assert!(
            disabled_bytes < 16_700,
            "claude/disabled catalogue is {disabled_bytes} B; expected less than 16700 B"
        );
        assert!(
            gateway_bytes < 1_300,
            "codex gateway catalogue is {gateway_bytes} B; expected less than 1300 B"
        );
    }
}

#[cfg(test)]
mod reveal_tests {
    use super::*;
    use std::cell::Cell;

    #[tokio::test]
    async fn opening_waits_for_exact_host_chosen_surface_not_another_workspace_tab() {
        assert!(
            !wait_for_exact_surface("agent-new", std::time::Duration::ZERO, || vec![
                "user-existing".into()
            ])
            .await
        );
        assert!(
            wait_for_exact_surface("agent-new", std::time::Duration::ZERO, || vec![
                "user-existing".into(),
                "agent-new".into()
            ])
            .await
        );
    }

    #[tokio::test]
    async fn hidden_surface_requests_reveal_before_capture_can_proceed() {
        let requested = Cell::new(false);
        let checks = Cell::new(0);
        reveal_when_hidden(
            "/workspace",
            "side-1",
            "https://example.test",
            REVEAL_TIMEOUT,
            || {
                checks.set(checks.get() + 1);
                Ok(requested.get())
            },
            || {
                requested.set(true);
                Ok(())
            },
        )
        .await
        .unwrap();
        assert!(requested.get());
        assert!(checks.get() >= 2);
    }

    #[tokio::test]
    async fn hidden_surface_waits_for_visibility_receipt() {
        let requested = Cell::new(false);
        let visible = Cell::new(false);
        let (result, ()) = tokio::join!(
            reveal_when_hidden(
                "/workspace",
                "side-1",
                "https://example.test",
                REVEAL_TIMEOUT,
                || Ok(visible.get()),
                || {
                    requested.set(true);
                    Ok(())
                },
            ),
            async {
                tokio::task::yield_now().await;
                assert!(requested.get());
                visible.set(true);
            }
        );
        result.unwrap();
        assert!(visible.get());
    }

    #[tokio::test]
    async fn visible_surface_does_not_request_reveal() {
        reveal_when_hidden(
            "/workspace",
            "side-1",
            "https://example.test",
            REVEAL_TIMEOUT,
            || Ok(true),
            || panic!("visible surface must proceed directly"),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn another_visible_surface_cannot_satisfy_exact_surface_reveal() {
        let requested = Cell::new(false);
        let surfaces = std::collections::BTreeMap::from([("hidden-1", false), ("visible-2", true)]);
        let err = reveal_when_hidden(
            "/workspace",
            "hidden-1",
            "https://example.test",
            std::time::Duration::ZERO,
            || Ok(surfaces["hidden-1"]),
            || {
                requested.set(true);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert!(requested.get());
        for value in [
            "browser_reveal_failed",
            "/workspace",
            "hidden-1",
            "https://example.test",
            "REVEAL_TIMEOUT=0ms",
        ] {
            assert!(err.0.contains(value), "{}", err.0);
        }
    }

    #[tokio::test]
    async fn reveal_reports_emit_failure_and_surface_destruction() {
        let err = reveal_when_hidden(
            "/workspace",
            "side-1",
            "https://example.test",
            REVEAL_TIMEOUT,
            || Ok(false),
            || Err("renderer unavailable".into()),
        )
        .await
        .unwrap_err();
        assert!(err.0.contains("browser_reveal_failed") && err.0.contains("renderer unavailable"));
        let requested = Cell::new(false);
        let err = reveal_when_hidden(
            "/workspace",
            "side-1",
            "https://example.test",
            REVEAL_TIMEOUT,
            || {
                if requested.get() {
                    Err("surface disappeared".into())
                } else {
                    Ok(false)
                }
            },
            || {
                requested.set(true);
                Ok(())
            },
        )
        .await
        .unwrap_err();
        assert!(err.0.contains("browser_reveal_failed") && err.0.contains("surface disappeared"));
    }
}
