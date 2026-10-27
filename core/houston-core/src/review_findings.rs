//! Reads a `task_review` verdict's findings into what the daemon stores: every
//! field is bounded and a wrong shape names the offending path. A legacy
//! plain-text finding is still accepted and carried with no location.

use anyhow::{bail, Result};
use houston_protocol as proto;
use serde_json::Value;
use std::path::{Component, Path};

fn field_text<'a>(value: &'a Value, at: &str, max: usize) -> Result<&'a str> {
    let Some(text) = value.as_str() else {
        bail!("task_review: {at} is {value}; expected a string")
    };
    let text = text.trim();
    if text.is_empty() {
        bail!("task_review: {at} is empty; expected a non-empty string");
    }
    let len = text.chars().count();
    if len > max {
        bail!("task_review: {at} has {len} characters; expected at most {max}");
    }
    Ok(text)
}

/// A repository-relative path, normalized to forward slashes. A drive, a root
/// and any `..` component would let a finding name a file outside the branch.
fn relative_path(value: &Value, at: &str) -> Result<String> {
    let raw = field_text(value, at, proto::TASK_REVIEW_PATH_MAX)?;
    let path = raw.replace('\\', "/");
    let bytes = path.as_bytes();
    let drive = bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':';
    if path.starts_with('/') || drive {
        bail!(
            "task_review: {at} is {raw:?}; expected a repository-relative path, not an absolute \
             path or a drive"
        );
    }
    if Path::new(&path)
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        bail!("task_review: {at} is {raw:?}; expected a relative path without `..`");
    }
    Ok(path)
}

fn severity(value: &Value, at: &str) -> Result<proto::TaskReviewSeverity> {
    match value.as_str().unwrap_or_default() {
        "high" => Ok(proto::TaskReviewSeverity::High),
        "medium" => Ok(proto::TaskReviewSeverity::Medium),
        "low" => Ok(proto::TaskReviewSeverity::Low),
        "nit" => Ok(proto::TaskReviewSeverity::Nit),
        _ => bail!("task_review: {at} is {value}; expected one of high, medium, low or nit"),
    }
}

fn category(value: &Value, at: &str) -> Result<proto::TaskReviewCategory> {
    match value.as_str().unwrap_or_default() {
        "bug" => Ok(proto::TaskReviewCategory::Bug),
        "security" => Ok(proto::TaskReviewCategory::Security),
        "performance" => Ok(proto::TaskReviewCategory::Performance),
        "other" => Ok(proto::TaskReviewCategory::Other),
        _ => bail!(
            "task_review: {at} is {value}; expected one of bug, security, performance or other"
        ),
    }
}

fn line(value: &Value, at: &str) -> Result<u32> {
    let Some(number) = value.as_u64() else {
        bail!("task_review: {at} is {value}; expected an integer of at least 1")
    };
    let Some(number) = u32::try_from(number).ok().filter(|number| *number >= 1) else {
        bail!("task_review: {at} is {number}; expected an integer of at least 1")
    };
    Ok(number)
}

/// Findings as the reviewer wrote them: structured objects or legacy strings.
/// At most `TASK_REVIEW_FINDINGS_MAX`; every structured object must name a
/// repository-relative path and a line at least 1.
pub fn parse(items: &[Value]) -> Result<Vec<proto::TaskReviewFinding>> {
    let max = usize::try_from(proto::TASK_REVIEW_FINDINGS_MAX).unwrap_or(100);
    if items.len() > max {
        bail!(
            "task_review: findings has {} entries; expected at most {max}",
            items.len()
        );
    }
    let mut out = Vec::with_capacity(items.len());
    for (index, item) in items.iter().enumerate() {
        let at = |field: &str| format!("findings[{index}].{field}");
        match item {
            Value::String(_) => out.push(proto::TaskReviewFinding {
                path: String::new(),
                line: 0,
                severity: proto::TaskReviewSeverity::Nit,
                category: proto::TaskReviewCategory::Other,
                message: field_text(item, &at("message"), proto::TASK_REVIEW_MESSAGE_MAX)?
                    .to_string(),
            }),
            Value::Object(map) => {
                let path = relative_path(map.get("path").unwrap_or(&Value::Null), &at("path"))?;
                let line = line(map.get("line").unwrap_or(&Value::Null), &at("line"))?;
                let severity =
                    severity(map.get("severity").unwrap_or(&Value::Null), &at("severity"))?;
                let category =
                    category(map.get("category").unwrap_or(&Value::Null), &at("category"))?;
                let message = field_text(
                    map.get("message").unwrap_or(&Value::Null),
                    &at("message"),
                    proto::TASK_REVIEW_MESSAGE_MAX,
                )?
                .to_string();
                out.push(proto::TaskReviewFinding {
                    path,
                    line,
                    severity,
                    category,
                    message,
                });
            }
            other => bail!(
                "task_review: findings[{index}] is {other}; expected a string or an object with \
                 path, line, severity, category and message"
            ),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn structured_and_legacy_findings_parse_together() {
        let findings = parse(&[
            json!({
                "path": "src\\lib.rs",
                "line": 12,
                "severity": "high",
                "category": "bug",
                "message": "the guard is inverted"
            }),
            json!("a legacy plain-text finding"),
        ])
        .unwrap();
        assert_eq!(findings.len(), 2);
        assert_eq!(findings[0].path, "src/lib.rs");
        assert_eq!(findings[0].line, 12);
        assert_eq!(findings[0].severity, proto::TaskReviewSeverity::High);
        assert_eq!(findings[1].path, "");
        assert_eq!(findings[1].line, 0);
        assert_eq!(findings[1].message, "a legacy plain-text finding");
    }

    #[test]
    fn a_finding_outside_the_repository_names_the_field() {
        for path in ["../secret", "/etc/passwd", "C:\\Windows\\win.ini", ""] {
            let error = parse(&[json!({
                "path": path, "line": 1, "severity": "low", "category": "other", "message": "x"
            })])
            .unwrap_err()
            .to_string();
            assert!(error.contains("findings[0].path"), "{path}: {error}");
            assert!(
                error.contains(&format!("{path:?}")) || path.is_empty(),
                "{path}: {error}"
            );
        }
    }

    #[test]
    fn a_bad_line_severity_category_or_message_names_it() {
        for (field, value) in [
            ("line", json!(0)),
            ("severity", json!("critical")),
            ("category", json!("style")),
            ("message", json!("")),
        ] {
            let mut finding = json!({
                "path": "src/lib.rs", "line": 1, "severity": "low", "category": "other",
                "message": "x"
            });
            finding[field] = value;
            let error = parse(&[finding]).unwrap_err().to_string();
            assert!(
                error.contains(&format!("findings[0].{field}")),
                "{field}: {error}"
            );
        }
    }

    #[test]
    fn more_findings_than_the_cap_are_refused_with_the_count() {
        let items: Vec<Value> = (0..=proto::TASK_REVIEW_FINDINGS_MAX)
            .map(|n| json!(format!("finding {n}")))
            .collect();
        let error = parse(&items).unwrap_err().to_string();
        assert!(error.contains("expected at most 100"), "{error}");
    }
}
