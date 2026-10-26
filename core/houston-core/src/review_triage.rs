//! Deterministic triage for a pull request the operator was asked to review:
//! file facts and CI state become a tier and its reasons, with no model and no
//! score. Tier A stays disabled until triage is calibrated and reports B.

use houston_protocol as proto;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileFacts {
    pub path: String,
    pub additions: u32,
    pub deletions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Facts {
    pub files: Vec<FileFacts>,
    /// The pull request's base branch name, without `origin/`.
    pub base: String,
    /// Every check passed or was skipped. No checks is not green.
    pub ci_green: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub tier: proto::ReviewTier,
    pub reasons: Vec<String>,
}

fn dependency_manifest(name: &str) -> bool {
    matches!(
        name,
        "Cargo.toml"
            | "Cargo.lock"
            | "package.json"
            | "bun.lock"
            | "bun.lockb"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "go.mod"
            | "go.sum"
            | "poetry.lock"
            | "Pipfile.lock"
    ) || name.starts_with("requirements")
}

fn config_or_secret(path: &str, name: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.contains("secret")
        || lower.contains("credential")
        || lower.contains("/config/")
        || lower.ends_with("/config")
        || name.starts_with(".env")
        || name.starts_with("config.")
        || name == "config"
        || name.ends_with(".pem")
        || name.ends_with(".key")
}

fn auth_or_policy(lower: &str) -> bool {
    lower.contains("auth")
        || lower.contains("policy")
        || lower.contains("policies")
        || lower.contains("permission")
        || lower.contains("oauth")
}

fn payment_or_integration(lower: &str) -> bool {
    lower.contains("payment")
        || lower.contains("billing")
        || lower.contains("stripe")
        || lower.contains("checkout")
        || lower.contains("/integrations/")
}

fn dependency_change(name: &str) -> bool {
    dependency_manifest(name)
}

fn release_base(base: &str) -> bool {
    let lower = base
        .trim()
        .trim_start_matches("origin/")
        .to_ascii_lowercase();
    lower.starts_with("release") || lower.starts_with("hotfix")
}

fn is_docs_tests_or_translation(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with("docs/")
        || lower.starts_with("tests/")
        || lower.contains("/tests/")
        || lower.ends_with(".md")
        || lower.ends_with(".mdx")
        || lower.ends_with(".snap")
        || lower.contains("/locales/")
        || lower.contains("/i18n/")
        || lower.contains("/translations/")
}

/// One strong escalator sends a pull request to tier C; a quick-look diff that
/// qualifies for tier A is reported as B until calibration exists.
pub fn triage(facts: &Facts) -> Verdict {
    let lines: u32 = facts
        .files
        .iter()
        .map(|file| file.additions.saturating_add(file.deletions))
        .fold(0, u32::saturating_add);
    let file_count = u32::try_from(facts.files.len()).unwrap_or(u32::MAX);
    let mut reasons = vec![format!("{lines} changed line(s) in {file_count} file(s)")];
    let mut strong = false;

    if release_base(&facts.base) {
        strong = true;
        reasons.push(format!(
            "base branch {:?} is a release or hotfix branch",
            facts.base
        ));
    }
    let push = |reasons: &mut Vec<String>, reason: String| {
        if !reasons.contains(&reason) {
            reasons.push(reason);
        }
    };
    for file in &facts.files {
        let lower = file.path.to_ascii_lowercase();
        let name = file.path.rsplit('/').next().unwrap_or(file.path.as_str());
        let checks: &[(&bool, &str)] = &[
            (&lower.contains("migration"), "migration"),
            (&auth_or_policy(&lower), "auth or policy path"),
            (
                &payment_or_integration(&lower),
                "payment or integration path",
            ),
            (&config_or_secret(&lower, name), "config or secrets file"),
            (&dependency_change(name), "dependency manifest or lockfile"),
            (
                &(lower.starts_with("core/houston-protocol/") || lower == "protocol/protocol.md"),
                "protocol",
            ),
            (&(lower == "core/houston-core/src/pid.rs"), "PID handling"),
            (
                &(lower.starts_with("scripts/install")
                    || lower.contains("nsis")
                    || (lower.starts_with("src-tauri/") && lower.contains("installer"))
                    || lower.ends_with("tauri.conf.json")),
                "installer or version manifest",
            ),
        ];
        for (matched, reason) in checks {
            if **matched {
                strong = true;
                push(&mut reasons, format!("{}: {reason}", file.path));
            }
        }
    }
    if lines > proto::REVIEW_REQUEST_TIER_C_LINES || file_count > proto::REVIEW_REQUEST_TIER_C_FILES
    {
        strong = true;
        push(
            &mut reasons,
            format!(
                "over the tier C size caps of {} lines and {} files",
                proto::REVIEW_REQUEST_TIER_C_LINES,
                proto::REVIEW_REQUEST_TIER_C_FILES
            ),
        );
    }
    if strong {
        return Verdict {
            tier: proto::ReviewTier::C,
            reasons,
        };
    }

    let docs_only = facts
        .files
        .iter()
        .all(|file| is_docs_tests_or_translation(&file.path));
    let dependency = facts
        .files
        .iter()
        .any(|file| dependency_manifest(file.path.rsplit('/').next().unwrap_or_default()));
    let lines_cap = proto::REVIEW_SKIP_MAX_LINES;
    let files_cap = proto::REVIEW_SKIP_MAX_FILES;
    if lines <= lines_cap && file_count <= files_cap && docs_only && !dependency && facts.ci_green {
        push(
            &mut reasons,
            "qualifies for tier A, but tier A is disabled until triage is calibrated".into(),
        );
        return Verdict {
            tier: proto::ReviewTier::B,
            reasons,
        };
    }
    if !docs_only {
        push(
            &mut reasons,
            "code changes, not only docs, tests or translations".into(),
        );
    }
    if dependency {
        push(&mut reasons, "a dependency manifest changed".into());
    }
    if !facts.ci_green {
        push(&mut reasons, "CI is not green or has not reported".into());
    }
    if lines > lines_cap || file_count > files_cap {
        push(
            &mut reasons,
            format!("over the tier A quick-look caps of {lines_cap} lines and {files_cap} files"),
        );
    }
    Verdict {
        tier: proto::ReviewTier::B,
        reasons,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(path: &str, additions: u32, deletions: u32) -> FileFacts {
        FileFacts {
            path: path.into(),
            additions,
            deletions,
        }
    }

    fn facts(files: Vec<FileFacts>, base: &str, ci_green: bool) -> Facts {
        Facts {
            files,
            base: base.into(),
            ci_green,
        }
    }

    #[test]
    fn a_small_docs_diff_is_reported_as_b_because_tier_a_is_disabled() {
        let verdict = triage(&facts(vec![file("docs/user/tasks.md", 4, 2)], "main", true));
        assert_eq!(verdict.tier, proto::ReviewTier::B);
        assert!(verdict
            .reasons
            .iter()
            .any(|reason| reason.contains("tier A is disabled")));
    }

    #[test]
    fn strong_escalators_name_the_file_that_caused_them() {
        for path in [
            "core/houston-core/migrations/007.sql",
            "core/houston-core/src/pid.rs",
            "core/houston-protocol/src/lib.rs",
            "protocol/protocol.md",
            "Cargo.toml",
            "src-tauri/tauri.conf.json",
            "src/auth/session.rs",
            "src/config/secrets.rs",
            "src/payment/checkout.rs",
        ] {
            let verdict = triage(&facts(vec![file(path, 1, 0)], "main", true));
            assert_eq!(verdict.tier, proto::ReviewTier::C, "{path}: {verdict:?}");
            assert!(
                verdict.reasons.iter().any(|reason| reason.contains(path)),
                "{path}: {verdict:?}"
            );
        }
    }

    #[test]
    fn release_hotfix_and_size_caps_are_tier_c() {
        for facts in [
            facts(vec![file("src/lib.rs", 1, 0)], "origin/release-2", true),
            facts(vec![file("src/lib.rs", 1, 0)], "hotfix/login", true),
            facts(vec![file("src/lib.rs", 399, 2)], "main", true),
            facts(
                (0..16)
                    .map(|n| file(&format!("src/{n}.rs"), 1, 0))
                    .collect(),
                "main",
                true,
            ),
        ] {
            let verdict = triage(&facts);
            assert_eq!(verdict.tier, proto::ReviewTier::C, "{verdict:?}");
        }
    }

    #[test]
    fn everything_else_is_tier_b_with_its_reasons() {
        let verdict = triage(&facts(vec![file("src/lib.rs", 70, 3)], "main", false));
        assert_eq!(verdict.tier, proto::ReviewTier::B);
        assert!(verdict
            .reasons
            .iter()
            .any(|reason| reason.contains("73 changed")));
        assert!(verdict
            .reasons
            .iter()
            .any(|reason| reason.contains("CI is not green")));
    }
}
