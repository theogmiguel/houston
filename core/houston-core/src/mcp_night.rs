//! `night_plan`, `night_pr`, `night_lesson`, `night_decision`, `night_report`:
//! offered only to the orchestrator pane of a Night shift run in flight, since
//! they write that run's ledger. `night_verdict` is offered to the run's other
//! panes: the verifier is never the orchestrator.
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

fn ids() -> Value {
    json!({ "type": "array", "items": { "type": "integer", "minimum": 1 } })
}

fn claim() -> Value {
    json!({ "type": "string", "maxLength": houston_protocol::NIGHT_SHIFT_CLAIM_TEXT_MAX })
}

fn spec(verb: &str) -> ToolSpec {
    let text = |max: usize| json!({ "type": "string", "maxLength": max });
    let title = text(houston_protocol::NIGHT_SHIFT_ENTRY_TITLE_MAX);
    let body = text(houston_protocol::NIGHT_SHIFT_ENTRY_BODY_MAX);
    let (label, description, properties, required) = match verb {
        "plan" => (
            "Record a plan entry",
            "Record one change this Night shift run takes on, with its claims: each an \
             observable claim with a concrete value and the specific test that proves it, \
             written before the build. With `deferred`, record one it leaves for a later run \
             (no claims needed); later runs see deferred entries in their brief.",
            json!({ "title": title, "theme": text(80), "body": body,
                    "deferred": { "type": "boolean" }, "status": text(40),
                    "claims": { "type": "array",
                        "maxItems": houston_protocol::NIGHT_SHIFT_CLAIMS_MAX,
                        "items": { "type": "object",
                            "properties": { "claim": claim(), "proof": claim() },
                            "required": ["claim", "proof"], "additionalProperties": false } } }),
            vec!["title"],
        ),
        "pr" => (
            "Record a pull request",
            "Record or update a PR this run opened, keyed by its number: `head` (its branch or \
             commit; Houston runs the checks there and records the Checks gate), the plan \
             entries it carries, the panes that built it, theme, the review and qa verdicts \
             and whether the change is visible in the app. Checks, CI and verify are facts \
             Houston records; they cannot be set here.",
            json!({ "number": { "type": "integer", "minimum": 1 }, "title": title,
                    "head": text(200), "plans": ids(), "built_by": ids(),
                    "theme": text(80), "status": text(40), "visible": { "type": "boolean" },
                    "body": body, "review": gate(), "qa": gate() }),
            vec!["number", "title"],
        ),
        "verdict" => (
            "Record verification verdicts",
            "As the run's verifier (not the orchestrator, not a pane that built the change), \
             record a verdict per claim after re-running its proof on the pull request's \
             branch: the plan entry, the claim's index (from 0), whether it holds, and evidence \
             naming file:line of the proof. With Standard depth, also the fault you injected \
             and the test failing on it.",
            json!({ "pr": { "type": "integer", "minimum": 1 },
                    "verdicts": { "type": "array", "minItems": 1, "items": { "type": "object",
                        "properties": { "plan": { "type": "integer" },
                            "claim": { "type": "integer", "minimum": 0 },
                            "passed": { "type": "boolean" }, "evidence": claim(),
                            "fault": claim() },
                        "required": ["plan", "claim", "passed", "evidence"],
                        "additionalProperties": false } } }),
            vec!["pr", "verdicts"],
        ),
        "lesson" => (
            "Record a lesson",
            "Record what the next run should know. With `flaky_test`, records that test as \
             known flaky: a CI failure on it is re-run once instead of fixed.",
            json!({ "title": title, "body": body, "flaky_test": text(200) }),
            vec!["title"],
        ),
        "studied" => (
            "Record what was studied",
            "Record what this run studied of a competitor: its name as the brief lists it \
             (owner/repo, or the app's name) and the release tag or app version. The next \
             run's brief passes it on, so only newer material is read.",
            json!({ "competitor": title, "version": text(80), "body": body }),
            vec!["competitor", "version"],
        ),
        "decision" => (
            "Park a decision",
            "Park a question for the user's morning report instead of asking during the \
             night; list the options you see, one array item per choice.",
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
            Some(d) if d.is_night_shift_orchestrator(scope.session_id) => all()
                .into_iter()
                .filter(|t| t.name != "night_verdict")
                .collect(),
            Some(d) if d.night_run_of_pane(scope.session_id).is_some() => vec![spec("verdict")],
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
