//! Host side of upstream's desktop SSH bridge: runs the server entry with a hidden
//! `__ssh-bridge` argument (protocol work stays in `@t3tools/ssh`) and owns the child,
//! request correlation, password prompts and remote-editor probing.

use std::ffi::OsString;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::Emitter;
use tokio::sync::oneshot;

use crate::sys::host_env::HostEnv;
use crate::v2_server::ServerEntry;

const SSH_OPERATION_TIMEOUT: Duration = Duration::from_secs(120);
const SSH_ENSURE_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const PASSWORD_PROMPT_EVENT: &str = "v2-ssh-password-prompt";

/// How to start the helper: the bundled single executable runs itself, while a
/// dev checkout runs its JavaScript entry with the resolved Node runtime.
#[derive(Debug, Clone)]
pub struct SshLaunch {
    pub node: PathBuf,
    pub entry: ServerEntry,
}

#[derive(Debug, Clone, PartialEq)]
pub enum HelperMessage {
    Response {
        id: u64,
        outcome: Result<Value, String>,
    },
    PasswordPrompt(Value),
    Ignored,
}

/// Parse one helper stdout line without trusting its shape.
pub fn parse_helper_line(line: &str) -> HelperMessage {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return HelperMessage::Ignored;
    };
    match value.get("type").and_then(Value::as_str) {
        Some("response") => {
            let Some(id) = value.get("id").and_then(Value::as_u64) else {
                return HelperMessage::Ignored;
            };
            if value.get("ok").and_then(Value::as_bool) == Some(true) {
                return HelperMessage::Response {
                    id,
                    outcome: Ok(value.get("result").cloned().unwrap_or(Value::Null)),
                };
            }
            let message = value
                .get("error")
                .and_then(|error| error.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("The SSH bridge request failed.")
                .to_string();
            HelperMessage::Response {
                id,
                outcome: Err(message),
            }
        }
        Some("event")
            if value.get("event").and_then(Value::as_str) == Some("ssh-password-prompt") =>
        {
            match value.get("request") {
                Some(request) if request.is_object() => {
                    HelperMessage::PasswordPrompt(request.clone())
                }
                _ => HelperMessage::Ignored,
            }
        }
        _ => HelperMessage::Ignored,
    }
}

pub fn helper_program(launch: &SshLaunch) -> (PathBuf, Vec<OsString>) {
    match &launch.entry {
        ServerEntry::Bundled(executable) => {
            (executable.clone(), vec![OsString::from("__ssh-bridge")])
        }
        ServerEntry::Node(entry) => (
            launch.node.clone(),
            vec![
                entry.clone().into_os_string(),
                OsString::from("__ssh-bridge"),
            ],
        ),
    }
}

type Pending = Arc<Mutex<std::collections::HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

fn fail_pending(pending: &Pending, message: &str) {
    let mut entries = pending
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for (_, sender) in entries.drain() {
        let _ = sender.send(Err(message.to_string()));
    }
}

struct HelperProcess {
    child: Child,
    stdin: ChildStdin,
    pending: Pending,
    next_id: u64,
}

impl HelperProcess {
    fn spawn(launch: &SshLaunch, app: &tauri::AppHandle) -> Result<Self, String> {
        let (program, args) = helper_program(launch);
        let mut command = crate::sys::spawn::command(&program);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command.spawn().map_err(|error| {
            format!(
                "starting the SSH bridge through {}: {error}",
                program.display()
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "the SSH bridge process has no stdin pipe".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "the SSH bridge process has no stdout pipe".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "the SSH bridge process has no stderr pipe".to_string())?;
        let pending: Pending = Arc::new(Mutex::new(std::collections::HashMap::new()));
        let reader_pending = Arc::clone(&pending);
        let events = app.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                match parse_helper_line(&line) {
                    HelperMessage::Response { id, outcome } => {
                        let sender = reader_pending
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&id);
                        if let Some(sender) = sender {
                            let _ = sender.send(outcome);
                        }
                    }
                    HelperMessage::PasswordPrompt(request) => {
                        let _ = events.emit(PASSWORD_PROMPT_EVENT, request);
                    }
                    HelperMessage::Ignored => {}
                }
            }
            fail_pending(&reader_pending, "The SSH bridge process exited.");
        });
        std::thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(|line| line.ok()) {
                eprintln!("houston-tauri: ssh bridge: {line}");
            }
        });
        Ok(Self {
            child,
            stdin,
            pending,
            next_id: 0,
        })
    }

    fn write_frame(&mut self, frame: &Value) -> Result<(), String> {
        let line = serde_json::to_string(frame)
            .map_err(|error| format!("encoding an SSH bridge request: {error}"))?;
        writeln!(self.stdin, "{line}")
            .and_then(|()| self.stdin.flush())
            .map_err(|error| format!("writing to the SSH bridge process: {error}"))
    }

    fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub struct V2SshHost {
    launch: SshLaunch,
    inner: Mutex<Option<HelperProcess>>,
}

impl V2SshHost {
    pub fn new(node: PathBuf, entry: ServerEntry) -> Self {
        Self {
            launch: SshLaunch { node, entry },
            inner: Mutex::new(None),
        }
    }

    fn dispatch(
        &self,
        app: &tauri::AppHandle,
        make_frame: impl FnOnce(u64) -> Value,
    ) -> Result<oneshot::Receiver<Result<Value, String>>, String> {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(process) = guard.as_mut() {
            if matches!(process.child.try_wait(), Ok(Some(_))) {
                *guard = None;
            }
        }
        if guard.is_none() {
            *guard = Some(HelperProcess::spawn(&self.launch, app)?);
        }
        let process = guard
            .as_mut()
            .ok_or_else(|| "the SSH bridge process could not be started".to_string())?;
        process.next_id = process.next_id.wrapping_add(1);
        let id = process.next_id;
        let (sender, receiver) = oneshot::channel();
        process
            .pending
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id, sender);
        let frame = make_frame(id);
        if let Err(error) = process.write_frame(&frame) {
            process
                .pending
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&id);
            process.kill();
            *guard = None;
            return Err(error);
        }
        Ok(receiver)
    }

    async fn request(
        &self,
        app: &tauri::AppHandle,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let receiver = self.dispatch(
            app,
            |id| json!({ "type": "request", "id": id, "method": method, "params": params }),
        )?;
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(message),
            Ok(Err(_)) => Err(format!(
                "the SSH bridge process exited before answering {method:?}"
            )),
            Err(_) => Err(format!(
                "the SSH bridge did not answer {method:?} within {} seconds",
                timeout.as_secs()
            )),
        }
    }

    async fn resolve_password(
        &self,
        app: &tauri::AppHandle,
        request_id: String,
        password: Option<String>,
    ) -> Result<Value, String> {
        let receiver = self.dispatch(app, |id| {
            json!({
                "type": "resolve-password",
                "id": id,
                "requestId": request_id,
                "password": password,
            })
        })?;
        match tokio::time::timeout(SSH_OPERATION_TIMEOUT, receiver).await {
            Ok(Ok(Ok(value))) => Ok(value),
            Ok(Ok(Err(message))) => Err(message),
            Ok(Err(_)) => Err("the SSH bridge process exited before resolving the prompt".into()),
            Err(_) => Err("the SSH bridge did not resolve the password prompt in time".into()),
        }
    }
}

#[tauri::command]
pub async fn v2_ssh_discover_hosts(
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    let host = Arc::clone(&host);
    host.request(&app, "discover-hosts", json!({}), SSH_OPERATION_TIMEOUT)
        .await
}

#[tauri::command]
pub async fn v2_ssh_resolve_host(
    alias: String,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    let host = Arc::clone(&host);
    host.request(
        &app,
        "resolve-host",
        json!({ "alias": alias }),
        SSH_OPERATION_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn v2_ssh_ensure_environment(
    target: Value,
    options: Option<Value>,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    if !target.is_object() {
        return Err(format!(
            "v2_ssh_ensure_environment expects an SSH target object, got {target}"
        ));
    }
    let host = Arc::clone(&host);
    host.request(
        &app,
        "ensure-environment",
        json!({ "target": target, "options": options }),
        SSH_ENSURE_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn v2_ssh_disconnect_environment(
    target: Value,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    if !target.is_object() {
        return Err(format!(
            "v2_ssh_disconnect_environment expects an SSH target object, got {target}"
        ));
    }
    let host = Arc::clone(&host);
    host.request(
        &app,
        "disconnect-environment",
        json!({ "target": target }),
        SSH_ENSURE_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn v2_ssh_fetch_environment_descriptor(
    http_base_url: String,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    let host = Arc::clone(&host);
    host.request(
        &app,
        "fetch-environment-descriptor",
        json!({ "httpBaseUrl": http_base_url }),
        SSH_OPERATION_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn v2_ssh_bootstrap_bearer_session(
    http_base_url: String,
    credential: String,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    let host = Arc::clone(&host);
    host.request(
        &app,
        "bootstrap-bearer-session",
        json!({ "httpBaseUrl": http_base_url, "credential": credential }),
        SSH_OPERATION_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn v2_ssh_fetch_session_state(
    http_base_url: String,
    bearer_token: String,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    let host = Arc::clone(&host);
    host.request(
        &app,
        "fetch-session-state",
        json!({ "httpBaseUrl": http_base_url, "bearerToken": bearer_token }),
        SSH_OPERATION_TIMEOUT,
    )
    .await
}

#[tauri::command]
pub async fn v2_ssh_resolve_password_prompt(
    request_id: String,
    password: Option<String>,
    app: tauri::AppHandle,
    host: tauri::State<'_, Arc<V2SshHost>>,
) -> Result<Value, String> {
    if request_id.trim().is_empty() {
        return Err("v2_ssh_resolve_password_prompt expects a non-empty requestId".to_string());
    }
    let host = Arc::clone(&host);
    host.resolve_password(&app, request_id, password).await
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EditorProbeEnv {
    pub home: Option<PathBuf>,
    pub xdg_data_home: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub program_roots: Vec<PathBuf>,
}

struct EditorSpec {
    id: &'static str,
    label: &'static str,
    names: &'static [&'static str],
    commands: &'static [&'static str],
    jetbrains: bool,
}

const REMOTE_EDITORS: &[EditorSpec] = &[
    EditorSpec {
        id: "cursor",
        label: "Cursor",
        names: &["Cursor"],
        commands: &["cursor"],
        jetbrains: false,
    },
    EditorSpec {
        id: "vscode",
        label: "VS Code",
        names: &["Visual Studio Code"],
        commands: &["code"],
        jetbrains: false,
    },
    EditorSpec {
        id: "vscode-insiders",
        label: "VS Code Insiders",
        names: &["Visual Studio Code - Insiders"],
        commands: &["code-insiders"],
        jetbrains: false,
    },
    EditorSpec {
        id: "vscodium",
        label: "VSCodium",
        names: &["VSCodium"],
        commands: &["codium"],
        jetbrains: false,
    },
    EditorSpec {
        id: "zed",
        label: "Zed",
        names: &["Zed"],
        commands: &["zed", "zeditor"],
        jetbrains: false,
    },
    EditorSpec {
        id: "idea",
        label: "IntelliJ IDEA",
        names: &[
            "IntelliJ IDEA",
            "IntelliJ IDEA CE",
            "IntelliJ IDEA Ultimate",
        ],
        commands: &["idea"],
        jetbrains: true,
    },
    EditorSpec {
        id: "aqua",
        label: "Aqua",
        names: &["Aqua"],
        commands: &["aqua"],
        jetbrains: true,
    },
    EditorSpec {
        id: "clion",
        label: "CLion",
        names: &["CLion"],
        commands: &["clion"],
        jetbrains: true,
    },
    EditorSpec {
        id: "datagrip",
        label: "DataGrip",
        names: &["DataGrip"],
        commands: &["datagrip"],
        jetbrains: true,
    },
    EditorSpec {
        id: "dataspell",
        label: "DataSpell",
        names: &["DataSpell"],
        commands: &["dataspell"],
        jetbrains: true,
    },
    EditorSpec {
        id: "goland",
        label: "GoLand",
        names: &["GoLand"],
        commands: &["goland"],
        jetbrains: true,
    },
    EditorSpec {
        id: "phpstorm",
        label: "PhpStorm",
        names: &["PhpStorm"],
        commands: &["phpstorm"],
        jetbrains: true,
    },
    EditorSpec {
        id: "pycharm",
        label: "PyCharm",
        names: &["PyCharm", "PyCharm CE"],
        commands: &["pycharm"],
        jetbrains: true,
    },
    EditorSpec {
        id: "rider",
        label: "Rider",
        names: &["Rider", "JetBrains Rider"],
        commands: &["rider"],
        jetbrains: true,
    },
    EditorSpec {
        id: "rubymine",
        label: "RubyMine",
        names: &["RubyMine"],
        commands: &["rubymine"],
        jetbrains: true,
    },
    EditorSpec {
        id: "rustrover",
        label: "RustRover",
        names: &["RustRover"],
        commands: &["rustrover"],
        jetbrains: true,
    },
    EditorSpec {
        id: "webstorm",
        label: "WebStorm",
        names: &["WebStorm"],
        commands: &["webstorm"],
        jetbrains: true,
    },
];

#[derive(Debug, Clone, PartialEq, Eq)]
enum Candidate {
    Command(&'static str),
    Path(PathBuf),
}

fn is_versioned_bundle(entry: &str, name: &str) -> bool {
    let stem = entry
        .strip_prefix(name)
        .and_then(|rest| rest.strip_prefix(' '))
        .and_then(|rest| rest.strip_suffix(".app"));
    stem.is_some_and(|version| {
        !version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.')
    })
}

fn push_bundle_candidates(
    out: &mut Vec<Candidate>,
    root: &Path,
    spec: &EditorSpec,
    command: &'static str,
) {
    let mut bundles: Vec<String> = spec
        .names
        .iter()
        .map(|name| format!("{name}.app"))
        .collect();
    if let Ok(entries) = std::fs::read_dir(root) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if spec
                .names
                .iter()
                .any(|base| is_versioned_bundle(&name, base))
            {
                bundles.push(name);
            }
        }
    }
    for bundle in bundles {
        let contents = root.join(bundle).join("Contents");
        if spec.jetbrains || spec.id == "zed" {
            let executable = if spec.id == "zed" { "cli" } else { command };
            out.push(Candidate::Path(contents.join("MacOS").join(executable)));
        } else {
            out.push(Candidate::Path(
                contents.join("Resources/app/bin").join(command),
            ));
            out.push(Candidate::Path(contents.join("Resources/app/bin/code")));
        }
    }
}

fn editor_candidates(spec: &EditorSpec, platform: &str, env: &EditorProbeEnv) -> Vec<Candidate> {
    let command = spec.commands[0];
    let zed_linux = spec.id == "zed" && platform == "linux";
    let mut out = Vec::new();
    if !zed_linux {
        for name in spec.commands {
            out.push(Candidate::Command(name));
        }
    }
    match platform {
        "linux" => {
            let mut directories = Vec::new();
            if let Some(home) = &env.home {
                directories.push(home.join(".local/bin"));
            }
            directories.push(PathBuf::from("/usr/local/bin"));
            directories.push(PathBuf::from("/usr/bin"));
            directories.push(PathBuf::from("/snap/bin"));
            if spec.jetbrains {
                if let Some(data) = &env.xdg_data_home {
                    directories.push(data.join("JetBrains/Toolbox/scripts"));
                } else if let Some(home) = &env.home {
                    directories.push(home.join(".local/share/JetBrains/Toolbox/scripts"));
                }
            }
            if zed_linux {
                for name in ["zeditor", "zed"] {
                    out.push(Candidate::Command(name));
                    for directory in &directories {
                        out.push(Candidate::Path(directory.join(name)));
                    }
                }
            } else {
                for directory in &directories {
                    for name in spec.commands {
                        out.push(Candidate::Path(directory.join(name)));
                    }
                }
            }
        }
        "macos" => {
            let mut roots = Vec::new();
            if let Some(home) = &env.home {
                roots.push(home.join("Applications"));
            }
            roots.push(PathBuf::from("/Applications"));
            for root in roots {
                push_bundle_candidates(&mut out, &root, spec, command);
            }
            if spec.jetbrains {
                if let Some(home) = &env.home {
                    out.push(Candidate::Path(
                        home.join("Library/Application Support/JetBrains/Toolbox/scripts")
                            .join(command),
                    ));
                }
            }
        }
        "windows" => {
            let mut roots = Vec::new();
            if let Some(local) = &env.local_app_data {
                roots.push(local.join("Programs"));
            }
            roots.extend(env.program_roots.iter().cloned());
            if spec.jetbrains {
                if let Some(local) = &env.local_app_data {
                    out.push(Candidate::Path(
                        local
                            .join("JetBrains/Toolbox/scripts")
                            .join(format!("{command}.cmd")),
                    ));
                }
                for root in roots
                    .iter()
                    .flat_map(|root| [root.clone(), root.join("JetBrains")])
                {
                    let mut names: Vec<String> =
                        spec.names.iter().map(|name| (*name).to_string()).collect();
                    if let Ok(entries) = std::fs::read_dir(&root) {
                        for entry in entries.flatten() {
                            let entry_name = entry.file_name().to_string_lossy().into_owned();
                            if spec.names.iter().any(|name| {
                                entry_name == *name || entry_name.starts_with(&format!("{name} "))
                            }) {
                                names.push(entry_name);
                            }
                        }
                    }
                    for name in names {
                        out.push(Candidate::Path(
                            root.join(&name)
                                .join("bin")
                                .join(format!("{command}64.exe")),
                        ));
                        out.push(Candidate::Path(
                            root.join(&name).join("bin").join(format!("{command}.exe")),
                        ));
                    }
                }
            } else {
                let name = match spec.id {
                    "vscode" => "Microsoft VS Code",
                    "vscode-insiders" => "Microsoft VS Code Insiders",
                    _ => spec.label,
                };
                for root in &roots {
                    let base = root.join(name);
                    out.push(Candidate::Path(
                        base.join("resources/app/bin")
                            .join(format!("{command}.cmd")),
                    ));
                    out.push(Candidate::Path(base.join("resources/app/bin/code.cmd")));
                    out.push(Candidate::Path(
                        base.join("bin").join(format!("{command}.cmd")),
                    ));
                    out.push(Candidate::Path(base.join("bin/code.cmd")));
                    if spec.id == "zed" {
                        out.push(Candidate::Path(base.join("bin/zed.exe")));
                        out.push(Candidate::Path(base.join("zed.exe")));
                    }
                }
            }
        }
        _ => {}
    }
    out
}

fn host_platform() -> &'static str {
    match std::env::consts::OS {
        "windows" => "windows",
        "macos" => "macos",
        _ => "linux",
    }
}

fn editor_probe_env(env: &HostEnv) -> EditorProbeEnv {
    let home = env
        .var_os("HOME")
        .or_else(|| env.var_os("USERPROFILE"))
        .map(PathBuf::from);
    let program_roots = ["ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"]
        .iter()
        .filter_map(|name| env.var_os(name))
        .map(PathBuf::from)
        .collect();
    EditorProbeEnv {
        home,
        xdg_data_home: env.var_os("XDG_DATA_HOME").map(PathBuf::from),
        local_app_data: env.var_os("LOCALAPPDATA").map(PathBuf::from),
        program_roots,
    }
}

#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn probe_remote_editors_with(
    platform: &str,
    env: &EditorProbeEnv,
    command_available: &dyn Fn(&str) -> bool,
    path_exists: &dyn Fn(&Path) -> bool,
) -> Vec<&'static str> {
    REMOTE_EDITORS
        .iter()
        .filter(|spec| {
            editor_candidates(spec, platform, env)
                .iter()
                .any(|candidate| match candidate {
                    Candidate::Command(command) => command_available(command),
                    Candidate::Path(path) => path_exists(path),
                })
        })
        .map(|spec| spec.id)
        .collect()
}

#[tauri::command]
pub fn v2_probe_remote_editors() -> Vec<&'static str> {
    let env = HostEnv::capture();
    let probe = editor_probe_env(&env);
    let command_available =
        |command: &str| crate::sys::exe_path::resolve_in(&env, command).is_some();
    let path_exists = |path: &Path| path.is_file();
    probe_remote_editors_with(host_platform(), &probe, &command_available, &path_exists)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_successful_response() {
        assert_eq!(
            parse_helper_line(r#"{"type":"response","id":7,"ok":true,"result":[1,2]}"#),
            HelperMessage::Response {
                id: 7,
                outcome: Ok(json!([1, 2]))
            }
        );
    }

    #[test]
    fn parses_an_error_response_with_the_helper_message() {
        assert_eq!(
            parse_helper_line(
                r#"{"type":"response","id":9,"ok":false,"error":{"message":"denied"}}"#
            ),
            HelperMessage::Response {
                id: 9,
                outcome: Err("denied".to_string())
            }
        );
    }

    #[test]
    fn parses_a_password_prompt_event() {
        let request = json!({
            "requestId": "abc",
            "destination": "host",
            "username": null,
            "prompt": "password",
            "expiresAt": "2026-01-01T00:00:00.000Z"
        });
        assert_eq!(
            parse_helper_line(
                &json!({
                    "type": "event",
                    "event": "ssh-password-prompt",
                    "request": request.clone()
                })
                .to_string()
            ),
            HelperMessage::PasswordPrompt(request)
        );
    }

    #[test]
    fn ignores_malformed_lines_and_unknown_events() {
        assert_eq!(parse_helper_line("not json"), HelperMessage::Ignored);
        assert_eq!(
            parse_helper_line(r#"{"type":"response","ok":true}"#),
            HelperMessage::Ignored
        );
        assert_eq!(
            parse_helper_line(r#"{"type":"event","event":"other","request":{}}"#),
            HelperMessage::Ignored
        );
    }

    #[test]
    fn a_node_entry_runs_through_the_node_runtime() {
        let launch = SshLaunch {
            node: PathBuf::from("/opt/node"),
            entry: ServerEntry::Node(PathBuf::from("/repo/apps/server/dist/bin.mjs")),
        };
        assert_eq!(
            helper_program(&launch),
            (
                PathBuf::from("/opt/node"),
                vec![
                    OsString::from("/repo/apps/server/dist/bin.mjs"),
                    OsString::from("__ssh-bridge")
                ]
            )
        );
    }

    #[test]
    fn a_bundled_entry_runs_itself() {
        let launch = SshLaunch {
            node: PathBuf::from("/opt/node"),
            entry: ServerEntry::Bundled(PathBuf::from("/opt/houston-v2-server")),
        };
        assert_eq!(
            helper_program(&launch),
            (
                PathBuf::from("/opt/houston-v2-server"),
                vec![OsString::from("__ssh-bridge")]
            )
        );
    }

    #[test]
    fn probe_finds_path_commands_and_application_bundles() {
        let root = tempfile::tempdir().expect("temp dir");
        let home = root.path().join("home");
        let bin = home.join(".local/bin");
        std::fs::create_dir_all(&bin).expect("bin dir");
        std::fs::write(bin.join("code"), b"").expect("code");
        let idea = home.join("Applications/IntelliJ IDEA.app/Contents/MacOS/idea");
        std::fs::create_dir_all(idea.parent().expect("parent")).expect("idea dir");
        std::fs::write(&idea, b"").expect("idea");
        let env = EditorProbeEnv {
            home: Some(home.clone()),
            xdg_data_home: None,
            local_app_data: None,
            program_roots: Vec::new(),
        };
        let command_available = |command: &str| command == "code";
        let exists = |path: &Path| path == idea;
        let linux = probe_remote_editors_with("linux", &env, &command_available, &exists);
        assert!(linux.contains(&"vscode"));
        assert!(!linux.contains(&"idea"));
        let macos = probe_remote_editors_with("macos", &env, &command_available, &exists);
        assert!(macos.contains(&"vscode"));
        assert!(macos.contains(&"idea"));
    }
}
