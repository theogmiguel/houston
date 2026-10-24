//! `thread_permission`: the `--permission-prompt-tool` of thread sessions. Claude calls it
//! when a tool needs approval; Houston holds the call until the user answers the approval
//! card. Terminal panes never get it: Houston answers no permission prompt there.
use std::sync::{Arc, Weak};

use serde_json::{json, Value};

use crate::daemon::Daemon;
use crate::mcp_creds::McpScope;
use crate::mcp_server::{Annotations, BoxFuture, ToolError, ToolOutput, ToolProvider, ToolSpec};
use crate::thread_session::{ApprovalAnswer, PERMISSION_TOOL};

pub struct ThreadPermissionTools {
    daemon: Weak<Daemon>,
}

impl ThreadPermissionTools {
    pub fn new(daemon: &Arc<Daemon>) -> Self {
        Self {
            daemon: Arc::downgrade(daemon),
        }
    }
}

fn spec() -> ToolSpec {
    ToolSpec {
        name: PERMISSION_TOOL.into(),
        title: "Thread permission prompt".into(),
        description: "Claude Code's permission prompt for this thread; Claude Code calls it \
                      itself through --permission-prompt-tool. Do not call it directly: it \
                      asks the user and grants nothing to the caller."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": {
                "tool_name": { "type": "string" },
                "input": { "type": "object" },
                "tool_use_id": { "type": "string" },
            },
            "required": ["tool_name", "input"],
        }),
        annotations: Annotations {
            read_only: false,
            destructive: false,
            idempotent: false,
            open_world: false,
        },
    }
}

/// The result shape `--permission-prompt-tool` expects, as the tool's text content.
fn decision(answer: ApprovalAnswer, input: Value) -> Value {
    match answer {
        ApprovalAnswer::Allow => json!({ "behavior": "allow", "updatedInput": input }),
        ApprovalAnswer::Deny(message) => json!({ "behavior": "deny", "message": message }),
    }
}

impl ToolProvider for ThreadPermissionTools {
    fn progress_message(&self, _scope: &McpScope, name: &str, elapsed: u64) -> Option<String> {
        (name == PERMISSION_TOOL).then(|| {
            format!(
                "waiting for the user to answer this permission request in Houston ({elapsed}s)"
            )
        })
    }

    fn tools(&self, scope: &McpScope) -> Vec<ToolSpec> {
        match self.daemon.upgrade() {
            Some(d)
                if d.session_view(scope.session_id) == houston_protocol::SessionView::Thread =>
            {
                vec![spec()]
            }
            _ => Vec::new(),
        }
    }

    fn all_tools(&self) -> Vec<ToolSpec> {
        vec![spec()]
    }

    fn call<'a>(
        &'a self,
        scope: &'a McpScope,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            if name != PERMISSION_TOOL {
                return Err(ToolError(format!(
                    "thread permission provider has no tool {name:?}; expected {PERMISSION_TOOL:?}"
                )));
            }
            let daemon = self
                .daemon
                .upgrade()
                .ok_or_else(|| ToolError("the Houston daemon is shutting down".into()))?;
            let session = scope.session_id;
            let args = args.clone();
            let (receiver, guard, input) = tokio::task::spawn_blocking(move || {
                daemon.thread_permission_request(session, &args)
            })
            .await
            .map_err(|e| ToolError(format!("permission request task panicked: {e}")))??;
            // Dropping this future (Claude cancelled or disconnected) drops the guard,
            // which records the request as withdrawn.
            let answer = receiver.await.unwrap_or_else(|_| {
                ApprovalAnswer::Deny("Houston lost this permission request; try again.".into())
            });
            drop(guard);
            Ok(ToolOutput::text(decision(answer, input).to_string()))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decisions_use_the_permission_prompt_result_shape() {
        let input = json!({ "command": "ls" });
        assert_eq!(
            decision(ApprovalAnswer::Allow, input.clone()),
            json!({ "behavior": "allow", "updatedInput": { "command": "ls" } })
        );
        assert_eq!(
            decision(ApprovalAnswer::Deny("no".into()), input),
            json!({ "behavior": "deny", "message": "no" })
        );
    }
}
