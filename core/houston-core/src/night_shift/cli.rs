//! `hs-night`: the CLI door to the `night_*` tools for an orchestrator whose
//! CLI has no MCP. It talks to the daemon over the pane's own MCP address.
use anyhow::{anyhow, bail, Result};
use serde_json::{json, Map, Value};

use crate::host_env::HostEnv;

const USAGE: &str = "usage: hs-night <verb> [flags]

verbs (only inside a Night shift run's orchestrator pane):
  plan --title T [--theme T] [--body B] [--status S]
       (--claim C --proof P)...   (one pair per claim; or --deferred without claims)
  pr --number N --title T [--head BRANCH] [--plans 3,4] [--built-by 12,13]
     [--theme T] [--status S] [--visible] [--body B] [--review G] [--qa G]
     (G: pending|passed|failed; Houston records checks, ci and verify itself)
  lesson --title T [--body B] [--flaky-test NAME]
  decision --title T [--body B] [--option A]...   (one --option per choice)
  studied --competitor NAME --version TAG [--body B]
  report --summary S [--merge-order 12,15,9]

verifier (a run pane that neither orchestrates nor built the change):
  verdict --pr N --plan ID --index I (--passed | --failed) --evidence FILE:LINE...
          [--fault F]   (--fault is required with Standard verification depth)";

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

/// Takes every `--claim` and `--proof` out of `args`, paired in order.
fn take_claims(args: Vec<String>) -> Result<(Vec<String>, Vec<Value>)> {
    let (mut rest, mut claims, mut proofs) = (Vec::new(), Vec::new(), Vec::new());
    let mut it = args.into_iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--claim" | "--proof" => match it.next() {
                Some(v) if !v.starts_with("--") => {
                    if a == "--claim" {
                        claims.push(v)
                    } else {
                        proofs.push(v)
                    }
                }
                _ => bail!("{a} needs a value"),
            },
            _ => rest.push(a),
        }
    }
    if claims.len() != proofs.len() {
        bail!(
            "{} --claim and {} --proof: give each claim its proof, as --claim C --proof P",
            claims.len(),
            proofs.len()
        );
    }
    let pairs = claims
        .into_iter()
        .zip(proofs)
        .map(|(claim, proof)| json!({ "claim": claim, "proof": proof }))
        .collect();
    Ok((rest, pairs))
}

/// Takes every `--option <text>` out of `args`: the one flag that repeats. A single
/// separated value would not survive Windows, where `hs-night.cmd` hands `%*` to
/// cmd.exe and a `|` or `&` in an argument becomes a pipe or a second command.
fn take_options(args: &[String]) -> Result<(Vec<String>, Vec<String>)> {
    let (mut rest, mut options) = (Vec::new(), Vec::new());
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--option" => match it.next() {
                Some(v) if !v.starts_with("--") => options.push(v.trim().to_string()),
                _ => bail!("--option needs a value, for example --option keep"),
            },
            "--options" => bail!(
                "--options is not accepted: pass each choice as its own --option, \
                 for example --option keep --option remove"
            ),
            _ => rest.push(a.clone()),
        }
    }
    options.retain(|o| !o.is_empty());
    Ok((rest, options))
}

/// The JSON a verb's flags and `--option` values become; the same shape the MCP tool takes.
pub fn args_json(
    verb: &str,
    flags: &std::collections::HashMap<String, String>,
    options: &[String],
) -> Result<Value> {
    let mut out = Map::new();
    if !options.is_empty() {
        out.insert("options".into(), json!(options));
    }
    let list = |v: &str, what: &str| {
        v.split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| {
                s.trim_start_matches('#')
                    .parse::<u32>()
                    .map_err(|_| anyhow!("{what} item {s:?} is not a number"))
            })
            .collect::<Result<Vec<_>>>()
    };
    for (k, v) in flags {
        let key = k.replace('-', "_");
        let value = match key.as_str() {
            "number" => json!(v
                .parse::<u32>()
                .map_err(|_| anyhow!("--number {v:?} is not a PR number"))?),
            "deferred" | "visible" => json!(v != "false"),
            "plans" | "built_by" => json!(list(v, &format!("--{k}"))?),
            "pr" | "plan" | "index" => json!(v
                .parse::<u32>()
                .map_err(|_| anyhow!("--{k} {v:?} is not a number"))?),
            "passed" => json!(v != "false"),
            "failed" => json!(v != "false"),
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

/// The CLI's one verdict per call, as the tool's `{pr, verdicts: [..]}`.
fn verdict_body(flat: Value) -> Result<Value> {
    let passed = match (flat.get("passed"), flat.get("failed")) {
        (Some(_), Some(_)) => bail!("give --passed or --failed, not both"),
        (Some(p), None) => p.clone(),
        (None, Some(f)) => json!(!f.as_bool().unwrap_or(true)),
        (None, None) => bail!("give --passed or --failed"),
    };
    let mut verdict = json!({
        "plan": flat["plan"], "claim": flat["index"], "passed": passed,
        "evidence": flat["evidence"],
    });
    if let Some(f) = flat.get("fault") {
        verdict["fault"] = f.clone();
    }
    Ok(json!({ "pr": flat["pr"], "verdicts": [verdict] }))
}

fn cli(env: &HostEnv, args: &[String]) -> Result<String> {
    let (args, options) = take_options(args)?;
    let (args, claims) = take_claims(args)?;
    let (positional, flags) = crate::orchestrate::parse_flags(&args);
    let Some(verb) = positional.first().map(String::as_str) else {
        bail!("{USAGE}");
    };
    if verb == "help" || flags.contains_key("help") {
        return Ok(USAGE.to_string());
    }
    let mut body = args_json(verb, &flags, &options)?;
    if !claims.is_empty() {
        body["claims"] = json!(claims);
    }
    if verb == "verdict" {
        body = verdict_body(body)?;
    }
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
        let v = args_json("pr", &flags, &[]).unwrap();
        assert_eq!(v["flaky_test"], json!("pty::resize_race"));
        assert_eq!(v["merge_order"], json!([12, 15]));
        assert_eq!(v["visible"], json!(true));
        assert_eq!(v["number"], json!(41));
        assert!(args_json("merge", &Default::default(), &[]).is_err());
    }

    fn strings(args: &[&str]) -> Vec<String> {
        args.iter().map(|a| a.to_string()).collect()
    }

    #[test]
    fn each_option_is_its_own_argument() {
        let args = strings(&[
            "decision",
            "--title",
            "Keep the old API?",
            "--option",
            "keep",
            "--option",
            "remove it",
        ]);
        let (rest, options) = take_options(&args).unwrap();
        assert_eq!(options, ["keep", "remove it"]);
        let (positional, flags) = crate::orchestrate::parse_flags(&rest);
        assert_eq!(positional, ["decision"]);
        let v = args_json("decision", &flags, &options).unwrap();
        assert_eq!(v["options"], json!(["keep", "remove it"]));
        assert_eq!(v["title"], json!("Keep the old API?"));
        assert!(v.get("option").is_none(), "{v}");
    }

    #[test]
    fn claims_pair_with_proofs_and_a_verdict_nests() {
        let args = strings(&[
            "plan",
            "--title",
            "Keep hooks",
            "--claim",
            "3 events survive",
            "--proof",
            "hooks::restart",
            "--claim",
            "applied once",
            "--proof",
            "hooks::dedupe",
        ]);
        let (rest, claims) = take_claims(args).unwrap();
        assert_eq!(rest, ["plan", "--title", "Keep hooks"]);
        assert_eq!(
            claims[1],
            json!({ "claim": "applied once", "proof": "hooks::dedupe" })
        );
        let err = take_claims(strings(&["plan", "--claim", "x"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("1 --claim and 0 --proof"), "{err}");

        let (positional, flags) = crate::orchestrate::parse_flags(&strings(&[
            "verdict",
            "--pr",
            "7",
            "--plan",
            "3",
            "--index",
            "0",
            "--failed",
            "--evidence",
            "a.rs:4 asserts nothing",
            "--built-by",
            "12,13",
        ]));
        assert_eq!(positional, ["verdict"]);
        let flat = args_json("verdict", &flags, &[]).unwrap();
        assert_eq!(flat["built_by"], json!([12, 13]));
        let v = verdict_body(flat).unwrap();
        assert_eq!(v["pr"], json!(7));
        assert_eq!(
            v["verdicts"][0],
            json!({ "plan": 3, "claim": 0, "passed": false, "evidence": "a.rs:4 asserts nothing" })
        );
    }

    #[test]
    fn the_separated_options_form_is_refused_by_name() {
        let err = take_options(&strings(&["decision", "--options", "keep|remove"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("--option keep --option remove"), "{err}");
        let err = take_options(&strings(&["decision", "--option"]))
            .unwrap_err()
            .to_string();
        assert!(err.contains("--option needs a value"), "{err}");
    }
}
