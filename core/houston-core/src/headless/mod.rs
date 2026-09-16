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
}

pub fn engine_for(kind: proto::AgentKind) -> Option<Box<dyn HeadlessEngine>> {
    match kind {
        proto::AgentKind::Claude => Some(Box::new(claude::ClaudeEngine)),
        proto::AgentKind::Codex => Some(Box::new(codex::CodexEngine)),
        proto::AgentKind::Opencode => Some(Box::new(opencode::OpencodeEngine::default())),
        proto::AgentKind::Grok => Some(Box::new(grok::GrokEngine::default())),
        _ => None,
    }
}

/// How long a request/response agent gets to exit on its own after its turn
/// ends before it is killed: generous for a clean shutdown, short enough that
/// a chat turn never waits on a CLI that ignores EOF.
pub const EXIT_GRACE: Duration = Duration::from_secs(2);
