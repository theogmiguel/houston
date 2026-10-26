//! One short headless request tells a slow turn from a spent quota or a
//! signed-out CLI. It sends only `PROMPT`, in a scratch directory, to the
//! user's own provider account.
use std::path::Path;
use std::time::Duration;

use houston_protocol::AgentKind;

pub const PROMPT: &str = "Reply with the single word OK.";

/// A refused request returns in about 20 s, after the CLI's own retries; an
/// answer takes a few seconds. Past this the probe counts as failed.
pub const TIMEOUT: Duration = Duration::from_secs(90);

/// Longest reason kept from the provider's output.
const REASON_MAX: usize = 200;

/// The non-interactive argv for one provider: one fixed prompt, no tools
/// where the CLI allows it. `None` is a provider Houston never probes.
pub fn argv(provider: AgentKind) -> Option<Vec<&'static str>> {
    match provider {
        AgentKind::Claude => Some(vec!["-p", PROMPT, "--tools", ""]),
        AgentKind::Codex => Some(vec![
            "exec",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--ephemeral",
            "--color",
            "never",
            PROMPT,
        ]),
        AgentKind::Opencode => Some(vec!["run", PROMPT, "--agent", "plan", "--pure"]),
        AgentKind::Zcode => Some(vec![
            "-p",
            PROMPT,
            "--mode",
            "build",
            "--disallowed-tools",
            "Bash Edit Write",
        ]),
        _ => None,
    }
}

/// The name a preflight item shows for a provider.
pub fn display_name(provider: AgentKind) -> &'static str {
    match provider {
        AgentKind::Claude => "Claude",
        AgentKind::Codex => "Codex",
        AgentKind::Opencode => "OpenCode",
        AgentKind::Zcode => "ZCode",
        _ => "Provider",
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Answered,
    /// The CLI ran and refused: a spent quota, a signed-out account.
    Failed(String),
    /// Houston could not run the probe at all: no program, no spawn, no
    /// scratch directory. Never evidence about the provider's quota.
    Unavailable(String),
    /// The probe did not finish within `TIMEOUT`: at a run's start that is
    /// inconclusive, while a pane already stalled treats it as failed.
    TimedOut(String),
}

/// `exited_ok` is `None` when the probe did not finish within `TIMEOUT`.
pub fn classify(
    provider: AgentKind,
    exited_ok: Option<bool>,
    stdout: &str,
    stderr: &str,
) -> Outcome {
    match exited_ok {
        Some(true) => Outcome::Answered,
        None => Outcome::TimedOut(format!(
            "{} probe did not answer within {} s",
            crate::agent_hooks::provider_slug(provider),
            TIMEOUT.as_secs()
        )),
        Some(false) => {
            let lines = || stderr.lines().chain(stdout.lines()).map(str::trim);
            let reason = lines()
                .find_map(|l| {
                    l.split_once("ProviderBusinessError:")
                        .map(|(_, r)| r.trim())
                })
                .or_else(|| lines().find(|l| !l.is_empty()))
                .unwrap_or("the probe exited with an error and printed nothing");
            // The reason reaches the run's notes and the database, so a
            // credential the CLI echoed never leaves this function.
            let reason = crate::sanitize::redact_secrets(reason).0;
            Outcome::Failed(reason.chars().take(REASON_MAX).collect())
        }
    }
}

/// The config-dir variable a pane of `provider` gets from its active agent
/// profile, so a probe reads the same account a pane would.
pub fn profile_env(provider: AgentKind, config_dir: Option<&str>) -> Vec<(String, String)> {
    let key = match provider {
        AgentKind::Claude => "CLAUDE_CONFIG_DIR",
        AgentKind::Codex => "CODEX_HOME",
        _ => return Vec::new(),
    };
    config_dir
        .filter(|dir| !dir.trim().is_empty())
        .map(|dir| vec![(key.to_string(), dir.to_string())])
        .unwrap_or_default()
}

/// Runs the probe with `program` and `env` from `cwd`; blocks for up to `TIMEOUT`.
pub fn run(program: &Path, provider: AgentKind, cwd: &Path, env: &[(String, String)]) -> Outcome {
    let Some(args) = argv(provider) else {
        return Outcome::Unavailable(format!(
            "{} has no headless probe",
            crate::agent_hooks::provider_slug(provider)
        ));
    };
    let mut cmd = crate::spawn::command(program);
    cmd.args(args).current_dir(cwd);
    for (name, value) in env {
        cmd.env(name, value);
    }
    match crate::spawn::output_within(cmd, TIMEOUT) {
        Ok(Some(out)) => classify(
            provider,
            Some(out.status.success()),
            &String::from_utf8_lossy(&out.stdout),
            &String::from_utf8_lossy(&out.stderr),
        ),
        Ok(None) => classify(provider, None, "", ""),
        Err(e) => Outcome::Unavailable(format!("starting {}: {e}", program.display())),
    }
}

/// The reset time ZCode's typed provider error carries in its
/// `[... reset at <timestamp>]` form, if any.
pub fn reset_at(reason: &str) -> Option<&str> {
    let start = reason.find("reset at ")? + "reset at ".len();
    let rest = &reason[start..];
    let end = rest.find(']').unwrap_or(rest.len());
    let value = rest[..end].trim();
    (!value.is_empty() && value.chars().count() <= 40).then_some(value)
}

/// How many minutes a pane has been Working with no turn end, once it reaches
/// `stall_ms`. Not working resets the clock to `now_ms`.
pub fn stalled_minutes(working: bool, since_ms: i64, now_ms: i64, stall_ms: i64) -> Option<u32> {
    (working && now_ms - since_ms >= stall_ms)
        .then(|| u32::try_from((now_ms - since_ms) / 60_000).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What `zcode -p` 0.16.9 printed on an account whose quota was spent.
    const SPENT: &str = "\nZCode Built-in missing\nProviderBusinessError: [1310][Weekly/Monthly Limit \
         Exhausted. Your limit will reset at 2026-10-24 22:18:34][202610221259195fa55e167c7a40e7]\n    \
         at detectProviderBusinessError (zcode.cjs:2073:11154)\n";

    #[test]
    fn each_probed_provider_has_a_non_interactive_argv() {
        assert_eq!(
            argv(AgentKind::Claude).unwrap(),
            ["-p", PROMPT, "--tools", ""]
        );
        let codex = argv(AgentKind::Codex).unwrap();
        assert_eq!(codex[0], "exec");
        assert!(codex.contains(&"read-only") && codex.contains(&"--ephemeral"));
        assert_eq!(codex.last(), Some(&PROMPT));
        let opencode = argv(AgentKind::Opencode).unwrap();
        assert_eq!(opencode[0], "run");
        assert!(opencode.contains(&"plan") && opencode.contains(&"--pure"));
        assert_eq!(
            argv(AgentKind::Zcode).unwrap(),
            [
                "-p",
                PROMPT,
                "--mode",
                "build",
                "--disallowed-tools",
                "Bash Edit Write"
            ]
        );
        for provider in [
            AgentKind::Antigravity,
            AgentKind::Cursor,
            AgentKind::Grok,
            AgentKind::Shell,
        ] {
            assert_eq!(argv(provider), None, "{provider:?} has no probe");
        }
    }

    #[test]
    fn a_probe_gets_the_profile_config_dir_its_panes_get() {
        assert_eq!(
            profile_env(AgentKind::Claude, Some("/home/me/.claude-work")),
            [(
                "CLAUDE_CONFIG_DIR".to_string(),
                "/home/me/.claude-work".to_string()
            )]
        );
        assert_eq!(
            profile_env(AgentKind::Codex, Some("/home/me/.codex-work")),
            [("CODEX_HOME".to_string(), "/home/me/.codex-work".to_string())]
        );
        assert_eq!(profile_env(AgentKind::Zcode, Some("/z")), []);
        assert_eq!(profile_env(AgentKind::Claude, Some("  ")), []);
        assert_eq!(profile_env(AgentKind::Codex, None), []);
    }

    #[test]
    fn a_typed_reset_time_is_lifted_from_the_provider_error() {
        assert_eq!(reset_at(SPENT), Some("2026-10-24 22:18:34"));
        assert_eq!(reset_at("[1310][limit]"), None);
        assert_eq!(reset_at("reset at "), None);
        assert_eq!(reset_at("limit; reset at ]"), None);
    }

    #[test]
    fn spent_quota_names_the_provider_error() {
        let Outcome::Failed(why) = classify(AgentKind::Zcode, Some(false), "", SPENT) else {
            panic!("a spent quota fails the probe");
        };
        assert!(
            why.starts_with("[1310][Weekly/Monthly Limit Exhausted."),
            "{why}"
        );
        assert!(why.chars().count() <= REASON_MAX);
    }

    #[test]
    fn answer_timeout_and_other_failures() {
        assert_eq!(
            classify(AgentKind::Zcode, Some(true), "OK", ""),
            Outcome::Answered
        );
        assert!(
            matches!(classify(AgentKind::Codex, None, "", ""), Outcome::TimedOut(w) if w.contains("codex probe did not answer within 90 s")),
            "a probe that did not answer timed out"
        );
        assert_eq!(
            classify(AgentKind::Opencode, Some(false), "", "\nnot logged in\n"),
            Outcome::Failed("not logged in".into())
        );
        assert!(
            matches!(classify(AgentKind::Claude, Some(false), "", ""), Outcome::Failed(w) if w.contains("printed nothing"))
        );
    }

    #[test]
    fn a_probe_reason_never_keeps_a_credential_it_echoed() {
        let token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.\
                     dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
        let stderr =
            format!("ProviderBusinessError: request failed with Authorization: Bearer {token}\n");
        let Outcome::Failed(why) = classify(AgentKind::Opencode, Some(false), "", &stderr) else {
            panic!("a failed probe keeps a reason");
        };
        assert!(!why.contains(token), "{why}");
        assert!(why.contains("[redacted:"), "{why}");
        assert!(why.chars().count() <= REASON_MAX);
    }

    #[test]
    fn a_probe_houston_cannot_start_is_unavailable_not_a_limit() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("houston-no-such-cli");
        assert!(
            matches!(
                run(&missing, AgentKind::Claude, dir.path(), &[]),
                Outcome::Unavailable(why) if why.contains("starting")
            ),
            "a program that cannot start says nothing about the account"
        );
        assert!(
            matches!(
                run(&missing, AgentKind::Antigravity, dir.path(), &[]),
                Outcome::Unavailable(why) if why.contains("no headless probe")
            ),
            "a provider without a probe is a Houston limitation"
        );
        assert!(
            matches!(
                classify(AgentKind::Claude, Some(false), "", "not logged in"),
                Outcome::Failed(_)
            ),
            "a CLI that ran and refused is a failure"
        );
    }

    #[test]
    fn a_stall_needs_working_and_the_whole_stall_window() {
        let stall = 20 * 60_000;
        assert_eq!(stalled_minutes(true, 1_000, 1_000 + stall, stall), Some(20));
        assert_eq!(stalled_minutes(true, 1_000, 1_000 + stall - 1, stall), None);
        assert_eq!(stalled_minutes(false, 1_000, 1_000 + stall, stall), None);
        assert_eq!(
            stalled_minutes(true, 1_000, 1_000 + 21 * 60_000, stall),
            Some(21)
        );
    }

    #[cfg(unix)]
    #[test]
    fn runs_the_program_without_tools() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let script = dir.path().join("zcode");
        std::fs::write(
            &script,
            "#!/bin/sh\necho \"$*\" > args\necho 'ProviderBusinessError: [1310][limit]' >&2\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            run(&script, AgentKind::Zcode, dir.path(), &[]),
            Outcome::Failed("[1310][limit]".into())
        );
        let args = std::fs::read_to_string(dir.path().join("args")).unwrap();
        assert!(
            args.contains("--disallowed-tools Bash Edit Write"),
            "{args}"
        );
    }
}
