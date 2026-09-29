//! Reads a review run's `findings.json` into what the daemon stores. The file
//! is written by an agent, so every field is bounded and a wrong shape is
//! refused with the path of the offending value.
use anyhow::{bail, Result};
use serde_json::Value;

use crate::db::HarnessFindingWrite;

/// Enough for a whole findings file with long apply prompts.
pub const FINDINGS_MAX_BYTES: u64 = 1024 * 1024;
/// A review past this many findings has stopped ranking them.
pub const FINDINGS_MAX: usize = 100;
const KEY_MAX_CHARS: usize = 80;
const TITLE_MAX_CHARS: usize = 200;
const TEXT_MAX_CHARS: usize = 2_000;
const APPLY_PROMPT_MAX_CHARS: usize = 8_000;
const QUOTES_MAX: usize = 5;
const QUOTE_MAX_CHARS: usize = 300;
const SESSIONS_MAX: usize = 50;
const SESSION_ID_MAX_CHARS: usize = 80;

pub struct Parsed {
    pub window: Option<(String, String)>,
    pub sessions: Option<u32>,
    pub prompts: Option<u32>,
    pub cost_usd: Option<f64>,
    pub findings: Vec<HarnessFindingWrite>,
}

fn cap(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.trim().to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out.trim().to_string()
}

fn text(v: &Value, path: &str, max: usize) -> Result<String> {
    match v {
        Value::String(s) => Ok(cap(s, max)),
        Value::Null => Ok(String::new()),
        other => bail!("findings.json: {path} must be a string; got {other}"),
    }
}

fn required(v: &Value, path: &str, max: usize) -> Result<String> {
    let s = text(v, path, max)?;
    if s.is_empty() {
        bail!("findings.json: {path} is required and must be a non-empty string");
    }
    Ok(s)
}

fn list(v: &Value, path: &str, max_items: usize, max_chars: usize) -> Result<Vec<String>> {
    match v {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => items
            .iter()
            .take(max_items)
            .enumerate()
            .map(|(i, item)| text(item, &format!("{path}[{i}]"), max_chars))
            .collect(),
        other => bail!("findings.json: {path} must be an array of strings; got {other}"),
    }
}

fn is_key(s: &str) -> bool {
    !s.is_empty()
        && s.chars().count() <= KEY_MAX_CHARS
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

pub fn parse(body: &str) -> Result<Parsed> {
    let root: Value = serde_json::from_str(body)
        .map_err(|e| anyhow::anyhow!("findings.json is not valid JSON: {e}"))?;
    if root["schema"] != 1 {
        bail!(
            "findings.json: schema must be 1; got {}",
            root.get("schema").unwrap_or(&Value::Null)
        );
    }
    let Some(items) = root["findings"].as_array() else {
        bail!("findings.json: findings must be an array");
    };
    if items.len() > FINDINGS_MAX {
        bail!(
            "findings.json holds {} findings, over the {FINDINGS_MAX} cap; keep the ones with \
             the most impact",
            items.len()
        );
    }
    let run = &root["run"];
    let window = match run["window"].as_array().map(Vec::as_slice) {
        Some([Value::String(a), Value::String(b)]) => Some((cap(a, 10), cap(b, 10))),
        _ => None,
    };
    let count = |v: &Value| v.as_u64().and_then(|n| u32::try_from(n).ok());
    let mut findings = Vec::with_capacity(items.len());
    let mut seen = std::collections::HashSet::new();
    for (i, f) in items.iter().enumerate() {
        let at = |field: &str| format!("findings[{i}].{field}");
        let key = required(&f["key"], &at("key"), KEY_MAX_CHARS + 1)?;
        if !is_key(&key) {
            bail!(
                "findings.json: {} is {key:?}; expected lowercase kebab-case of at most \
                 {KEY_MAX_CHARS} characters",
                at("key")
            );
        }
        if !seen.insert(key.clone()) {
            bail!("findings.json: {} repeats the key {key:?}", at("key"));
        }
        let evidence = &f["evidence"];
        let rec = &f["recommendation"];
        let sessions = list(
            &evidence["sessions"],
            &at("evidence.sessions"),
            SESSIONS_MAX,
            SESSION_ID_MAX_CHARS,
        )?;
        findings.push(HarnessFindingWrite {
            title: required(&f["title"], &at("title"), TITLE_MAX_CHARS)?,
            category: text(&f["category"], &at("category"), 40)?,
            confidence: text(&f["confidence"], &at("confidence"), 20)?,
            count: count(&evidence["count"]).unwrap_or(sessions.len() as u32),
            sessions,
            quotes: list(
                &evidence["quotes"],
                &at("evidence.quotes"),
                QUOTES_MAX,
                QUOTE_MAX_CHARS,
            )?,
            recommendation_kind: text(&rec["kind"], &at("recommendation.kind"), 40)?,
            target: text(&rec["target"], &at("recommendation.target"), 500)?,
            recommendation: text(
                &rec["summary"],
                &at("recommendation.summary"),
                TEXT_MAX_CHARS,
            )?,
            apply_prompt: text(
                &rec["apply_prompt"],
                &at("recommendation.apply_prompt"),
                APPLY_PROMPT_MAX_CHARS,
            )?,
            key,
        });
    }
    Ok(Parsed {
        window,
        sessions: count(&run["sessions"]),
        prompts: count(&run["prompts"]),
        cost_usd: run["cost_usd"]
            .as_f64()
            .filter(|c| c.is_finite() && *c >= 0.0),
        findings,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn finding(key: &str) -> Value {
        json!({
            "id": "F1", "key": key, "category": "permissions", "title": "Denied git push",
            "evidence": { "sessions": ["abc", "def"], "count": 2, "quotes": ["why denied"] },
            "recommendation": {
                "kind": "settings-allow", "target": ".claude/settings.json",
                "summary": "Allow git push to the fork", "apply_prompt": "Add the rule"
            },
            "confidence": "high", "source": "digest", "recurrence_of": null
        })
    }

    fn file(findings: Vec<Value>) -> String {
        json!({
            "schema": 1,
            "run": { "workspace": "/ws", "window": ["2026-09-01", "2026-09-15"],
                     "sessions": 12, "providers": ["claude"], "prompts": 80, "cost_usd": 4.5 },
            "findings": findings,
        })
        .to_string()
    }

    #[test]
    fn reads_the_documented_shape() {
        let p = parse(&file(vec![finding("denied-push")])).unwrap();
        assert_eq!(p.window, Some(("2026-09-01".into(), "2026-09-15".into())));
        assert_eq!(
            (p.sessions, p.prompts, p.cost_usd),
            (Some(12), Some(80), Some(4.5))
        );
        let f = &p.findings[0];
        assert_eq!(f.key, "denied-push");
        assert_eq!(f.sessions, ["abc", "def"]);
        assert_eq!(f.count, 2);
        assert_eq!(f.target, ".claude/settings.json");
        assert_eq!(f.apply_prompt, "Add the rule");
    }

    #[test]
    fn refusals_name_the_offending_value() {
        let err = |body: String| parse(&body).err().expect("refused").to_string();
        assert!(err(file(vec![finding("Bad Key")])).contains("findings[0].key is \"Bad Key\""));
        let dup = err(file(vec![finding("a"), finding("a")]));
        assert!(
            dup.contains("findings[1].key repeats the key \"a\""),
            "{dup}"
        );
        let mut untitled = finding("a");
        untitled["title"] = json!("");
        assert!(err(file(vec![untitled])).contains("findings[0].title is required"));
        let many = (0..=FINDINGS_MAX)
            .map(|i| finding(&format!("k{i}")))
            .collect();
        assert!(err(file(many)).contains("101 findings, over the 100 cap"));
        assert!(err(r#"{"schema":2,"findings":[]}"#.into()).contains("schema must be 1; got 2"));
    }

    #[test]
    fn long_fields_are_capped() {
        let mut f = finding("a");
        f["evidence"]["quotes"] = json!(vec!["q".repeat(1_000); 20]);
        let p = parse(&file(vec![f])).unwrap();
        assert_eq!(p.findings[0].quotes.len(), QUOTES_MAX);
        assert_eq!(p.findings[0].quotes[0].chars().count(), QUOTE_MAX_CHARS + 1);
    }
}
