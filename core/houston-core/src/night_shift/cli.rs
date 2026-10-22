//! `hs-night`: the CLI door to the `night_*` tools for an orchestrator whose
//! CLI has no MCP. It talks to the daemon over the pane's own MCP address.
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};

use crate::host_env::HostEnv;

const USAGE: &str = "usage: hs-night <verb> [flags]

verbs (only inside a Night shift run's orchestrator pane):
  plan --title T [--theme T] [--body B] [--deferred] [--status S]
  pr --number N --title T [--theme T] [--status S] [--visible] [--body B]
     [--checks G] [--review G] [--qa G] [--ci G]   (G: pending|passed|failed)
  lesson --title T [--body B] [--flaky-test NAME]
  decision --title T [--body B] [--options 'a|b|c']
  report --summary S [--merge-order 12,15,9]";

pub fn run_cli(args: &[String]) -> i32 {
    match cli(&HostEnv::capture(), args) {
        Ok(note) => {
            println!("{note}");
            0
        }
        Err(e) => {
            eprintln!("hs-night: {e:#}");
            2
        }
    }
}

/// The JSON a verb's flags become; the same shape the MCP tool takes.
pub fn args_json(verb: &str, flags: &std::collections::HashMap<String, String>) -> Result<Value> {
    let mut out = Map::new();
    for (k, v) in flags {
        let key = k.replace('-', "_");
        let value = match key.as_str() {
            "number" => json!(v
                .parse::<u32>()
                .map_err(|_| anyhow!("--number {v:?} is not a PR number"))?),
            "deferred" | "visible" => json!(v != "false"),
            "options" => json!(v
                .split('|')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()),
            "merge_order" => json!(v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s
                    .trim_start_matches('#')
                    .parse::<u32>()
                    .map_err(|_| anyhow!("--merge-order item {s:?} is not a PR number")))
                .collect::<Result<Vec<_>>>()?),
            _ => json!(v),
        };
        out.insert(key, value);
    }
    if !super::VERBS.contains(&verb) {
        bail!("unknown verb {verb:?}\n{USAGE}");
    }
    Ok(Value::Object(out))
}

fn cli(env: &HostEnv, args: &[String]) -> Result<String> {
    let (positional, flags) = crate::orchestrate::parse_flags(args);
    let Some(verb) = positional.first().map(String::as_str) else {
        bail!("{USAGE}");
    };
    if verb == "help" || flags.contains_key("help") {
        return Ok(USAGE.to_string());
    }
    let body = args_json(verb, &flags)?;
    let outside = |var: &str| {
        anyhow!("{var} is not set; hs-night runs only inside a Night shift run's orchestrator pane")
    };
    let url = env
        .var("HOUSTON_MCP_URL")
        .ok_or_else(|| outside("HOUSTON_MCP_URL"))?;
    let token = env
        .var("HOUSTON_MCP_TOKEN")
        .ok_or_else(|| outside("HOUSTON_MCP_TOKEN"))?;
    let base = crate::orchestrate::cli_base_url(Some(&url))?;
    let v = crate::orchestrate::cli_call(
        &base,
        &token,
        "POST",
        &format!("/night/{verb}"),
        Some(body),
        crate::orchestrate::CLI_HTTP_TIMEOUT,
    )?;
    Ok(v["note"].as_str().unwrap_or_default().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_become_tool_arguments() {
        let flags = [
            ("title", "Cache diff"),
            ("flaky-test", "pty::resize_race"),
            ("merge-order", "#12, 15"),
            ("visible", "true"),
            ("number", "41"),
        ]
        .into_iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let v = args_json("pr", &flags).unwrap();
        assert_eq!(v["flaky_test"], json!("pty::resize_race"));
        assert_eq!(v["merge_order"], json!([12, 15]));
        assert_eq!(v["visible"], json!(true));
        assert_eq!(v["number"], json!(41));
        assert!(args_json("merge", &Default::default()).is_err());
    }
}
