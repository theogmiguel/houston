//! `night_plan`, `night_pr`, `night_lesson`, `night_decision`, `night_report`:
//! offered only to the orchestrator pane of a Night shift run in flight, since
//! they write that run's ledger.
use std::sync::{Arc, Weak};

use serde_json::{json, Value};

use crate::daemon::Daemon;
use crate::mcp_creds::McpScope;
use crate::mcp_server::{Annotations, BoxFuture, ToolError, ToolOutput, ToolProvider, ToolSpec};

pub struct NightTools {
    daemon: Weak<Daemon>,
}

impl NightTools {
    pub fn new(daemon: &Arc<Daemon>) -> Self {
        Self {
            daemon: Arc::downgrade(daemon),
        }
    }
}

fn gate() -> Value {
    json!({ "type": "string", "enum": ["pending", "passed", "failed"] })
}

fn spec(verb: &str) -> ToolSpec {
    let text = |max: usize| json!({ "type": "string", "maxLength": max });
    let title = text(houston_protocol::NIGHT_SHIFT_ENTRY_TITLE_MAX);
    let body = text(houston_protocol::NIGHT_SHIFT_ENTRY_BODY_MAX);
    let (label, description, properties, required) = match verb {
        "plan" => (
            "Record a plan entry",
            "Record one change this Night shift run takes on, or with `deferred` one it leaves \
             for a later run. Later runs see deferred entries in their brief.",
            json!({ "title": title, "theme": text(80), "body": body,
                    "deferred": { "type": "boolean" }, "status": text(40) }),
            vec!["title"],
        ),
        "pr" => (
            "Record a pull request",
            "Record or update a PR this run opened, keyed by its number: theme, gates \
             (checks and ci are facts; review and qa are agents' verdicts) and whether the \
             change is visible in the app.",
            json!({ "number": { "type": "integer", "minimum": 1 }, "title": title,
                    "theme": text(80), "status": text(40), "visible": { "type": "boolean" },
                    "body": body, "checks": gate(), "review": gate(), "qa": gate(),
                    "ci": gate() }),
            vec!["number", "title"],
        ),
        "lesson" => (
            "Record a lesson",
            "Record what the next run should know. With `flaky_test`, records that test as \
             known flaky: a CI failure on it is re-run once instead of fixed.",
            json!({ "title": title, "body": body, "flaky_test": text(200) }),
            vec!["title"],
        ),
        "decision" => (
            "Park a decision",
            "Park a question for the user's morning report instead of asking during the \
             night; list the options you see.",
            json!({ "title": title, "body": body,
                    "options": { "type": "array", "items": text(120), "maxItems": 8 } }),
            vec!["title"],
        ),
        _ => (
            "Publish the morning report",
            "Hand the run's report.md (in the run folder named in your brief, at most \
             256 KiB) to Houston with a one-line summary and the suggested merge order. \
             End your turn afterwards; the run settles then.",
            json!({ "summary": text(200),
                    "merge_order": { "type": "array", "items": { "type": "integer" } } }),
            vec!["summary"],
        ),
    };
    ToolSpec {
        name: format!("night_{verb}"),
        title: label.into(),
        description: description.into(),
        input_schema: json!({
            "type": "object",
            "properties": properties,
            "required": required,
            "additionalProperties": false
        }),
        annotations: Annotations {
            read_only: false,
            destructive: false,
            idempotent: verb == "pr" || verb == "report",
            open_world: false,
        },
    }
}

fn all() -> Vec<ToolSpec> {
    crate::night_shift::VERBS.iter().map(|v| spec(v)).collect()
}

impl ToolProvider for NightTools {
    fn tools(&self, scope: &McpScope) -> Vec<ToolSpec> {
        match self.daemon.upgrade() {
            Some(d) if d.is_night_shift_orchestrator(scope.session_id) => all(),
            _ => Vec::new(),
        }
    }

    fn all_tools(&self) -> Vec<ToolSpec> {
        all()
    }

    fn call<'a>(
        &'a self,
        scope: &'a McpScope,
        name: &'a str,
        args: &'a Value,
    ) -> BoxFuture<'a, Result<ToolOutput, ToolError>> {
        Box::pin(async move {
            let verb = name
                .strip_prefix("night_")
                .filter(|v| crate::night_shift::VERBS.contains(v))
                .ok_or_else(|| ToolError(format!("night provider has no tool {name:?}")))?
                .to_string();
            let daemon = self
                .daemon
                .upgrade()
                .ok_or_else(|| ToolError("the Houston daemon is shutting down".into()))?;
            let caller = scope.session_id;
            let args = args.clone();
            let out = tokio::task::spawn_blocking(move || daemon.night_tool(caller, &verb, &args))
                .await
                .map_err(|e| ToolError(format!("night tool task panicked: {e}")))?
                .map_err(|e| ToolError(format!("{e:#}")))?;
            Ok(ToolOutput::structured(out))
        })
    }
}
