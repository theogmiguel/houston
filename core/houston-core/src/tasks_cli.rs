//! `hs-task`: the CLI door to a workspace's Tasks backlog, for agents whose
//! provider cannot use MCP. Every command is the same daemon call an MCP tool
//! makes, through the `/task/*` routes and the pane's own bearer token.
use anyhow::{bail, Result};
use serde_json::{json, Value};

const USAGE: &str = "\
hs-task — a Houston pane's view of its workspace's task backlog

  hs-task next
  hs-task ls [--mine] [--ready] [--status S] [--query TEXT] [--limit N]
  hs-task show [HOU-n]
  hs-task add TITLE [-p 1|2|3|4] [--parent HOU-n] [--description T]
  hs-task claim [HOU-n]
  hs-task comment [HOU-n] TEXT
  hs-task check [HOU-n] ITEM          (ITEM is the 1-based acceptance position)
  hs-task handback [HOU-n] --summary T
  hs-task handback [HOU-n] --subject T --changes T --step T [--step …] [--caveats T]
             --live-note T --dropped-note T [--size small|medium|large]
             [--note T …] [--warning T …] [--blocker T …]
             (a Slack-filed task)
  hs-task handback [HOU-n] --refused --subject T --changes T
             (a Slack-filed task: refused at triage)
  hs-task ask --question Q --option A --option B [--option …] --recommended N
             [--why T] [--context T]           (a Slack-filed task: asks in its thread)

The task key defaults to $HOUSTON_TASK when set; otherwise pass HOU-n.
Statuses: backlog, todo, in_progress, in_review, done, canceled.
Priorities: 1 urgent, 2 high, 3 medium, 4 low (absent is none).
Done is never set from here: the user closes a task.";

pub fn run_cli(args: &[String]) -> i32 {
    match cli(args) {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("hs-task: {e:#}");
            2
        }
    }
}

fn cli(args: &[String]) -> Result<()> {
    if args.is_empty() {
        println!("{USAGE}");
        return Ok(());
    }
    let args = normalize_priority_flag(args);
    let (positional, flags) = crate::orchestrate::parse_flags(&args);
    let Some(command) = positional.first().map(String::as_str) else {
        println!("{USAGE}");
        return Ok(());
    };
    let rest = &positional[1..];
    let flag = |k: &str| flags.get(k).map(String::as_str);

    let base = crate::orchestrate::cli_base_url(std::env::var("HOUSTON_MCP_URL").ok().as_deref())
        .map_err(|e| anyhow::anyhow!("{e:#}"))?;
    let token = std::env::var("HOUSTON_MCP_TOKEN").map_err(|_| {
        anyhow::anyhow!("HOUSTON_MCP_TOKEN is not set — hs-task only works inside a Houston pane")
    })?;
    let call = |method: &str, path: &str, body: Option<Value>| {
        crate::orchestrate::cli_call(
            &base,
            &token,
            method,
            path,
            body,
            crate::orchestrate::CLI_HTTP_TIMEOUT,
        )
    };

    match command {
        "next" => print(call("GET", "/task/next", None)?),
        "ls" => {
            let mut path = String::from("/task/list?");
            if flags.contains_key("mine") {
                path.push_str("mine=true&");
            }
            if flags.contains_key("ready") {
                path.push_str("ready=true&");
            }
            if let Some(status) = flag("status") {
                path.push_str(&format!("status={}&", query_escape(status)));
            }
            if let Some(query) = flag("query") {
                path.push_str(&format!("query={}&", query_escape(query)));
            }
            if let Some(limit) = flag("limit") {
                let limit: u32 = limit
                    .parse()
                    .map_err(|e| anyhow::anyhow!("--limit {limit:?} is not a number: {e}"))?;
                path.push_str(&format!("limit={limit}&"));
            }
            print(call("GET", path.trim_end_matches(['?', '&']), None)?)
        }
        "show" => {
            let key = key_arg(rest.first())?;
            print(call(
                "GET",
                &format!("/task/get?key={}", query_escape(&key)),
                None,
            )?)
        }
        "add" => {
            let title = rest.join(" ");
            let title = title.trim();
            if title.is_empty() {
                bail!(
                    "add needs a title; expected `hs-task add TITLE [-p N] [--parent HOU-n] \
                     [--description T]`"
                );
            }
            let mut body = json!({ "title": title });
            if let Some(priority) = flag("priority") {
                let priority = match priority {
                    "1" => "urgent",
                    "2" => "high",
                    "3" => "medium",
                    "4" => "low",
                    other => bail!(
                        "--priority {other:?} is not a priority; expected 1 urgent, 2 high, \
                         3 medium or 4 low"
                    ),
                };
                body["priority"] = json!(priority);
            }
            if let Some(parent) = flag("parent") {
                body["parent"] = json!(parent);
            }
            if let Some(description) = flag("description") {
                body["description"] = json!(description);
            }
            print(call("POST", "/task/create", Some(body))?)
        }
        "claim" => {
            let key = key_arg(rest.first())?;
            print(call("POST", "/task/claim", Some(json!({ "key": key })))?)
        }
        "comment" => {
            let (key, text) = split_key_and_text(rest)?;
            print(call(
                "POST",
                "/task/comment",
                Some(json!({ "key": key, "body": text })),
            )?)
        }
        "check" => {
            let (key, item) = split_key_and_item(rest)?;
            print(call(
                "POST",
                "/task/check",
                Some(json!({ "key": key, "item": item })),
            )?)
        }
        "handback" => {
            let key = key_arg(rest.first())?;
            let structured = ["subject", "changes", "refused"]
                .iter()
                .any(|k| flags.contains_key(*k));
            let mut body = json!({ "key": key, "summary": flag("summary") });
            if structured {
                body["result"] = json!({
                    "outcome": if flags.contains_key("refused") { "refused" } else { "ready" },
                    "subject": flag("subject").unwrap_or_default(),
                    "changes": flag("changes").unwrap_or_default(),
                    "steps": repeated(&args, "--step"),
                    "caveats": flag("caveats"),
                    "live_note": flag("live-note"),
                    "dropped_note": flag("dropped-note"),
                    "size": flag("size"),
                    "notes": repeated(&args, "--note"),
                    "warnings": repeated(&args, "--warning"),
                    "blockers": repeated(&args, "--blocker"),
                });
            } else if flag("summary").is_none() {
                bail!(
                    "handback needs --summary \"…\" — one line on what was done; expected \
                     `hs-task handback [HOU-n] --summary T` (a Slack-filed task hands back \
                     --subject, --changes, --step, --live-note and --dropped-note instead)"
                );
            }
            print(call("POST", "/task/handback", Some(body))?)
        }
        "ask" => {
            let options = repeated(&args, "--option");
            let recommended = match flag("recommended") {
                Some(raw) => Some(raw.parse::<usize>().map_err(|e| {
                    anyhow::anyhow!("--recommended {raw:?} is not an option number: {e}")
                })?),
                None => None,
            };
            let question = flag("question")
                .map(str::to_string)
                .unwrap_or_else(|| rest.join(" "));
            let body = json!({
                "context": flag("context"),
                "question": question,
                "options": options,
                "recommended": recommended,
                "why": flag("why"),
            });
            let reply = call("POST", "/task/ask", Some(body))?;
            println!(
                "{}",
                reply
                    .get("text")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
            );
            Ok(())
        }
        other => bail!("unknown hs-task command {other:?}\n\n{USAGE}"),
    }
}

/// Every value of a flag that may repeat, in order; the shared parser keeps
/// only the last.
fn repeated(args: &[String], name: &str) -> Vec<String> {
    args.windows(2)
        .filter(|w| w[0] == name)
        .map(|w| w[1].clone())
        .collect()
}

/// `-p` is the short spelling of `--priority`; the shared flag parser only
/// knows long flags.
fn normalize_priority_flag(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    for arg in args {
        if arg == "-p" {
            out.push("--priority".to_string());
        } else {
            out.push(arg.clone());
        }
    }
    out
}

fn is_key_like(value: &str) -> bool {
    value
        .strip_prefix("HOU-")
        .is_some_and(|number| !number.is_empty() && number.chars().all(|c| c.is_ascii_digit()))
}

fn validate_key(key: &str) -> Result<String> {
    if is_key_like(key.trim()) {
        Ok(key.trim().to_string())
    } else {
        bail!("task key {key:?} is not a task key; expected HOU-<number>, for example HOU-1")
    }
}

/// The explicit positional, else `$HOUSTON_TASK`; absent either way is an
/// error naming both ways to supply one.
fn key_arg(explicit: Option<&String>) -> Result<String> {
    if let Some(key) = explicit {
        return validate_key(key);
    }
    match std::env::var("HOUSTON_TASK") {
        Ok(key) if !key.trim().is_empty() => validate_key(&key),
        _ => bail!(
            "no task key: pass HOU-n or set HOUSTON_TASK (expected HOU-<number>, for example \
             HOU-1)"
        ),
    }
}

fn split_key_and_text(rest: &[String]) -> Result<(String, String)> {
    if rest.len() >= 2 && is_key_like(&rest[0]) {
        let key = validate_key(&rest[0])?;
        let text = rest[1..].join(" ");
        if text.trim().is_empty() {
            bail!("comment needs text after the key; expected `hs-task comment HOU-1 TEXT`");
        }
        return Ok((key, text));
    }
    let key = key_arg(None)?;
    let text = rest.join(" ");
    if text.trim().is_empty() {
        bail!("comment needs text; expected `hs-task comment [HOU-n] TEXT`");
    }
    Ok((key, text))
}

fn split_key_and_item(rest: &[String]) -> Result<(String, u32)> {
    let item = |raw: Option<&String>| -> Result<u32> {
        let raw = raw.ok_or_else(|| {
            anyhow::anyhow!(
                "check needs an acceptance item; expected `hs-task check [HOU-n] ITEM`, where \
                 ITEM is the 1-based position"
            )
        })?;
        raw.parse::<u32>()
            .map_err(|e| anyhow::anyhow!("acceptance item {raw:?} is not a number: {e}"))
    };
    if rest.len() >= 2 && is_key_like(&rest[0]) {
        return Ok((validate_key(&rest[0])?, item(rest.get(1))?));
    }
    Ok((key_arg(None)?, item(rest.first())?))
}

fn print(value: Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

/// Percent-encodes the few characters a task key, status or search text could
/// carry in a query string; the values are otherwise printable.
fn query_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::repeated;

    #[test]
    fn a_repeated_flag_keeps_every_value_in_order() {
        let args: Vec<String> = [
            "ask",
            "--option",
            "Save",
            "--question",
            "Which?",
            "--option",
            "Submit",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(repeated(&args, "--option"), ["Save", "Submit"]);
        assert!(repeated(&args, "--step").is_empty());
    }
}
