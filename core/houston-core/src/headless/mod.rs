use anyhow::Result;
use houston_protocol as proto;
use std::path::PathBuf;
use std::time::Duration;

pub mod acp;
pub mod claude;
pub mod codex;
pub mod grok;
pub mod opencode;
pub mod shared;

pub use shared::{EngineSupport, PendingQuestion};

#[derive(Debug, Clone, PartialEq)]
pub enum Decoded {
    Init {
        session_id: Option<String>,
    },
    TextDelta {
        text: String,
    },
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    ToolStart {
        id: String,
        name: String,
        detail: String,
    },
    ToolEnd {
        id: String,
        ok: bool,
        detail: String,
    },
    Result {
        ok: bool,
        session_id: Option<String>,
        error: Option<String>,
        usage: proto::ChatUsage,
    },
    StreamError {
        text: String,
    },
    PermissionRequest {
        question: proto::ChatQuestion,
    },
}

#[derive(Debug, Clone, Default)]
pub struct TurnRequest {
    pub cwd: PathBuf,
    pub prompt: String,
    pub model: Option<String>,
    pub effort: Option<proto::ChatEffort>,
    pub permission_mode: Option<proto::ChatPermissionMode>,
    pub resume: Option<String>,
    pub plan: bool,
    pub purpose: Option<String>,
    pub mcp: Option<crate::mcp_launch::Credential>,
    /// The two one-shot roles: no thread, no permission to grant, no resume.
    /// Each engine maps it to its own read-only, no-tool call shape.
    pub one_shot: bool,
}

pub trait HeadlessEngine: Send + Sync {
    fn support(&self) -> EngineSupport;
    fn program(&self) -> &str;
    fn argv(&self, req: &TurnRequest) -> Result<Vec<String>>;
    fn stdin(&self, req: &TurnRequest) -> Option<String>;
    /// `&mut self` is deliberate: [`engine_for`] returns a fresh instance per
    /// turn, and a decoder may hold state a single stream needs; sharing one
    /// across two turns would leak that state between them.
    fn decode(&mut self, line: &str) -> Vec<Decoded>;
    fn reply(&self, question: &PendingQuestion, answer: &str) -> Option<String>;
    fn outbound(&mut self) -> Vec<String> {
        Vec::new()
    }
    fn stdin_stays_open(&self) -> bool {
        false
    }
    fn models(&self) -> &'static [&'static str] {
        &[]
    }
    fn verified(&self) -> bool {
        false
    }
}

pub fn engine_for(kind: proto::AgentKind) -> Option<Box<dyn HeadlessEngine>> {
    match kind {
        proto::AgentKind::Claude => Some(Box::new(claude::ClaudeEngine::default())),
        proto::AgentKind::Codex => Some(Box::new(codex::CodexEngine)),
        proto::AgentKind::Opencode => Some(Box::new(opencode::OpencodeEngine::default())),
        proto::AgentKind::Grok => Some(Box::new(grok::GrokEngine::default())),
        _ => None,
    }
}

pub fn default_engine() -> proto::AgentKind {
    use proto::AgentKind as K;
    for kind in [K::Claude, K::Codex, K::Opencode, K::Grok] {
        let Some(engine) = engine_for(kind) else {
            continue;
        };
        if crate::exe_path::resolve(engine.program()).is_some() {
            return kind;
        }
    }
    K::Claude
}

pub fn engine_options() -> Vec<proto::HeadlessEngineOption> {
    shared::engine_support_table()
        .into_iter()
        .map(|(kind, support)| {
            if !support.can_chat {
                return proto::HeadlessEngineOption {
                    engine: kind,
                    enabled: false,
                    reason: support.reason,
                    verified: false,
                    models: Vec::new(),
                };
            }
            let engine = engine_for(kind)
                .expect("can_chat implies a registered headless::engine_for implementation");
            let installed = crate::exe_path::resolve(engine.program()).is_some();
            proto::HeadlessEngineOption {
                engine: kind,
                enabled: installed,
                reason: (!installed).then(|| "not found on PATH".to_string()),
                verified: engine.verified(),
                models: engine.models().iter().map(|m| (*m).to_string()).collect(),
            }
        })
        .collect()
}

/// Claude's one-shot argv refuses a call with no model, and it has no default
/// to fall back on, so one-shot roles resolve a missing model here.
pub fn resolve_one_shot_model(engine: proto::AgentKind, model: Option<String>) -> Option<String> {
    model.or_else(|| {
        (engine == proto::AgentKind::Claude).then(|| claude::ONESHOT_DEFAULT_MODEL.to_string())
    })
}

/// The env var the hook path keys the whole session on. Stripped from any
/// headless child env: a daemon dogfooded inside a Houston pane would
/// otherwise hand its own session id to the CLI run.
pub(crate) const TR_SESSION_ENV: &str = "TR_SESSION";

/// Every variable marking a process as *being* a pane, stripped from any
/// headless CLI the daemon runs on the operator's behalf — inherited, the
/// child would authenticate as the outer pane and pay for its tool schema.
pub(crate) const PANE_IDENTITY_ENV: &[&str] = &[
    TR_SESSION_ENV,
    "HOUSTON_SESSION",
    crate::mcp_launch::URL_ENV,
    crate::mcp_launch::CODEX_TOKEN_ENV,
    crate::mcp_launch::CONFIG_ENV,
];

pub(crate) fn strip_pane_identity_env(cmd: &mut tokio::process::Command) {
    for var in PANE_IDENTITY_ENV {
        cmd.env_remove(var);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OneShotError {
    Failed,
    Unreadable,
}

#[derive(Debug, Clone)]
pub struct OneShotOutcome {
    pub text: String,
    pub raw: String,
}

pub async fn one_shot(
    mut engine: Box<dyn HeadlessEngine>,
    exe: &std::path::Path,
    req: &TurnRequest,
    timeout: Duration,
) -> std::result::Result<OneShotOutcome, OneShotError> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    let args = engine.argv(req).map_err(|e| {
        tracing::warn!("one-shot: building argv: {e:#}");
        OneShotError::Failed
    })?;
    let mut cmd = crate::spawn::tokio_command(exe);
    cmd.args(&args)
        .current_dir(&req.cwd)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    crate::headless::strip_pane_identity_env(&mut cmd);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!("one-shot: spawning {}: {e}", exe.display());
            return Err(OneShotError::Failed);
        }
    };
    let mut stdin = child.stdin.take();
    if let (Some(line), Some(pipe)) = (engine.stdin(req), stdin.as_mut()) {
        let _ = pipe.write_all(line.as_bytes()).await;
        let _ = pipe.write_all(b"\n").await;
    }
    if !engine.stdin_stays_open() {
        drop(stdin.take());
    }
    let stdout = child.stdout.take().expect("piped above");
    let stderr = child.stderr.take().expect("piped above");
    let stderr_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        let mut r = BufReader::new(stderr);
        let _ = tokio::io::AsyncReadExt::read_to_end(&mut r, &mut buf).await;
        String::from_utf8_lossy(&buf).trim().to_string()
    });

    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    let mut lines = BufReader::new(stdout).lines();
    let mut raw = String::new();
    let mut decoded = Vec::new();
    let mut ended = false;
    loop {
        tokio::select! {
            _ = &mut deadline => {
                tracing::warn!(
                    "one-shot: no answer within {}s (timeout {} ms)",
                    timeout.as_secs(),
                    timeout.as_millis()
                );
                let _ = child.start_kill();
                return Err(OneShotError::Failed);
            }
            line = lines.next_line() => match line {
                Ok(Some(line)) => {
                    if !raw.is_empty() {
                        raw.push('\n');
                    }
                    raw.push_str(&line);
                    let out = engine.decode(&line);
                    ended = out.iter().any(|d| matches!(d, Decoded::Result { .. }));
                    decoded.extend(out);
                    if let Some(pipe) = stdin.as_mut() {
                        for l in engine.outbound() {
                            let _ = pipe.write_all(l.as_bytes()).await;
                            let _ = pipe.write_all(b"\n").await;
                        }
                    }
                    if ended {
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => {
                    tracing::warn!("one-shot: reading the CLI's output: {e}");
                    let _ = child.start_kill();
                    return Err(OneShotError::Failed);
                }
            }
        }
    }
    drop(stdin.take());
    let status = if ended && engine.stdin_stays_open() {
        match tokio::time::timeout(EXIT_GRACE, child.wait()).await {
            Ok(Ok(s)) => Some(s),
            _ => {
                let _ = child.start_kill();
                child.wait().await.ok()
            }
        }
    } else {
        child.wait().await.ok()
    };
    let stderr_text = stderr_task.await.unwrap_or_default();
    let exited_clean = status
        .as_ref()
        .is_some_and(std::process::ExitStatus::success);
    let killed_after_answering = ended && engine.stdin_stays_open();
    if !(exited_clean || killed_after_answering) {
        tracing::warn!(
            "one-shot: `{}` exited {:?} — stderr: {stderr_text}",
            exe.display(),
            status.and_then(|s| s.code()),
        );
        return Err(OneShotError::Failed);
    }
    let text = decoded.iter().rev().find_map(|d| match d {
        Decoded::Text { text } => Some(text.clone()),
        _ => None,
    });
    match text {
        Some(text) => Ok(OneShotOutcome { text, raw }),
        None => {
            match decoded.iter().rev().find_map(|d| match d {
                Decoded::Result {
                    ok: false,
                    error: Some(e),
                    ..
                } => Some(e.clone()),
                _ => None,
            }) {
                Some(error) => tracing::warn!("one-shot: the reply reported an error: {error}"),
                None => tracing::warn!(
                    "one-shot: no readable reply; stdout began: {:?}",
                    raw.chars().take(200).collect::<String>()
                ),
            }
            Err(OneShotError::Unreadable)
        }
    }
}

/// How long a request/response agent gets to exit on its own after stdin
/// closes before it is killed: generous for a clean shutdown, short enough
/// that a one-shot call never waits on a CLI that ignores EOF.
pub const EXIT_GRACE: Duration = Duration::from_secs(2);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_pane_identity_variable_is_stripped() {
        for var in [
            TR_SESSION_ENV,
            "HOUSTON_SESSION",
            crate::mcp_launch::URL_ENV,
            crate::mcp_launch::CODEX_TOKEN_ENV,
            crate::mcp_launch::CONFIG_ENV,
        ] {
            assert!(
                PANE_IDENTITY_ENV.contains(&var),
                "{var} is exported into every pane but is not stripped from headless \
                 children: a daemon hosted in a pane hands it to its own one-shot child"
            );
        }
    }
}
