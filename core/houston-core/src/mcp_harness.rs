//! `harness_publish`: offered only to the pane of a Harness review run in
//! flight, whatever the orchestration setting, since it hands the run's result
//! to the Harness view rather than to another pane.
use std::sync::{Arc, Weak};

use serde_json::{json, Value};

use crate::daemon::Daemon;
use crate::mcp_creds::McpScope;
use crate::mcp_server::{Annotations, BoxFuture, ToolError, ToolOutput, ToolProvider, ToolSpec};

pub const PUBLISH_TOOL: &str = "harness_publish";

pub struct HarnessTools {
    daemon: Weak<Daemon>,
}

impl HarnessTools {
    pub fn new(daemon: &Arc<Daemon>) -> Self {
        Self {
            daemon: Arc::downgrade(daemon),
        }
    }
}

fn spec() -> ToolSpec {
    ToolSpec {
        name: PUBLISH_TOOL.into(),
        title: "Publish harness review".into(),
        description: "Hand this Harness review run's result to Houston: reads report.md and \
                      findings.json from the run directory, `.houston/harness/<run>/`, and shows \
                      them in the Harness view. Call it once both files are written; publishing \
                      again replaces the earlier result of this run. `summary` is one line of at \
                      most 200 characters naming the number of findings."
            .into(),
        input_schema: json!({
            "type": "object",
            "properties": { "summary": { "type": "string", "maxLength": 200 } },
            "additionalProperties": false
        }),
        annotations: Annotations {
            read_only: false,
            destructive: false,
            idempotent: true,
            open_world: false,
        },
    }
}

impl ToolProvider for HarnessTools {
    fn tools(&self, scope: &McpScope) -> Vec<ToolSpec> {
        match self.daemon.upgrade() {
            Some(d) if d.is_harness_review_pane(scope.session_id) => vec![spec()],
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
            if name != PUBLISH_TOOL {
                return Err(ToolError(format!("harness provider has no tool {name:?}")));
            }
            let daemon = self
                .daemon
                .upgrade()
                .ok_or_else(|| ToolError("the Houston daemon is shutting down".into()))?;
            let summary = match args.get("summary") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                Some(other) => {
                    return Err(ToolError(format!(
                        "summary must be a string of at most 200 characters; got {other}"
                    )))
                }
            };
            let caller = scope.session_id;
            let note = tokio::task::spawn_blocking(move || daemon.harness_publish(caller, summary))
                .await
                .map_err(|e| ToolError(format!("publish task panicked: {e}")))?
                .map_err(|e| ToolError(format!("{e:#}")))?;
            Ok(ToolOutput::structured(
                json!({ "published": true, "note": note }),
            ))
        })
    }
}
