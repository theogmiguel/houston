use anyhow::{bail, Result};
use houston_protocol as proto;
use std::path::{Path, PathBuf};

// Prompts longer than this go to a file the CLI reads: argv has OS limits,
// and huge argv is hostile to ps/shell history. On Windows any newline
// forces the file too — cmd.exe drops everything after a quoted newline.
pub const PROMPT_FILE_THRESHOLD: usize = 12_000;

pub type LaunchArgs = (Vec<String>, Option<(PathBuf, String)>);

fn executable(agent: proto::AgentKind) -> Result<&'static str> {
    match agent {
        proto::AgentKind::Claude => Ok("claude"),
        proto::AgentKind::Codex => Ok("codex"),
        proto::AgentKind::Antigravity => Ok("agy"),
        proto::AgentKind::Opencode => Ok("opencode"),
        proto::AgentKind::Cursor => Ok("cursor-agent"),
        proto::AgentKind::Grok => Ok("grok"),
        other => bail!(
            "agent kind {other:?} cannot run a routine in a pane (expected claude, codex, \
             antigravity, opencode, cursor or grok)"
        ),
    }
}

fn prompt_outgrows_argv(prompt: &str) -> bool {
    prompt.len() > PROMPT_FILE_THRESHOLD || (cfg!(windows) && prompt.contains(['\r', '\n']))
}

pub fn launch_args(
    agent: proto::AgentKind,
    auto_approve: bool,
    plan_mode: bool,
    model: Option<&str>,
    prompt: &str,
    prompt_file_dir: Option<&Path>,
    label: &str,
) -> Result<LaunchArgs> {
    if prompt.trim().is_empty() {
        return Ok((flags_only(agent, auto_approve, plan_mode, model)?, None));
    }
    let mut prompt_file = None;
    let prompt_arg = if prompt_outgrows_argv(prompt) {
        let Some(dir) = prompt_file_dir else {
            bail!(
                "prompt is {} bytes, over the argv-safe limit for inline launch ({} bytes, \
                 and on Windows any newline), and no prompt-file directory was provided — \
                 shorten it",
                prompt.len(),
                PROMPT_FILE_THRESHOLD
            );
        };
        let sanitized: String = label
            .chars()
            .map(|c| {
                if c.is_alphanumeric() {
                    c.to_ascii_lowercase()
                } else {
                    '-'
                }
            })
            .collect();
        let path = dir.join(format!("prompt-{sanitized}.md"));
        let stub = format!(
            "Read the file {} and follow every instruction in it exactly. \
             It is your full mission brief for this job; start working immediately.",
            path.display()
        );
        prompt_file = Some((path, prompt.to_string()));
        stub
    } else {
        prompt.to_string()
    };

    let mut args = match agent {
        proto::AgentKind::Claude => vec![prompt_arg],
        proto::AgentKind::Codex => vec![prompt_arg],
        proto::AgentKind::Antigravity => vec!["-i".into(), prompt_arg],
        proto::AgentKind::Opencode => vec!["--prompt".into(), prompt_arg],
        proto::AgentKind::Cursor | proto::AgentKind::Grok => vec![prompt_arg],
        proto::AgentKind::Custom => return Ok((Vec::new(), None)),
        other => {
            bail!(
                "agent kind {other:?} is not spawnable (expected claude, codex, antigravity, \
                 opencode, cursor or grok)"
            )
        }
    };
    args.extend(flags_only(agent, auto_approve, plan_mode, model)?);
    Ok((args, prompt_file))
}

pub(crate) fn flags_only(
    agent: proto::AgentKind,
    auto_approve: bool,
    plan_mode: bool,
    model: Option<&str>,
) -> Result<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    match agent {
        proto::AgentKind::Claude
        | proto::AgentKind::Codex
        | proto::AgentKind::Antigravity
        | proto::AgentKind::Opencode
        | proto::AgentKind::Cursor
        | proto::AgentKind::Grok => {}
        proto::AgentKind::Custom => return Ok(args),
        other => {
            bail!(
                "agent kind {other:?} is not spawnable (expected claude, codex, antigravity, \
                 opencode, cursor or grok)"
            )
        }
    }
    if plan_mode {
        match agent {
            proto::AgentKind::Claude => {
                args.push("--permission-mode".into());
                args.push("plan".into());
            }
            proto::AgentKind::Codex => {
                args.push("-s".into());
                args.push("read-only".into());
                args.push("-a".into());
                args.push("on-request".into());
            }
            proto::AgentKind::Antigravity => {
                args.push("--mode".into());
                args.push("plan".into());
            }
            proto::AgentKind::Opencode => {
                args.push("--agent".into());
                args.push("plan".into());
            }
            proto::AgentKind::Cursor => args.push("--plan".into()),
            proto::AgentKind::Grok => {
                args.push("--permission-mode".into());
                args.push("plan".into());
            }
            _ => unreachable!("filtered above"),
        }
    } else if auto_approve {
        args.extend(auto_approve_args(agent).unwrap_or_default());
    }
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
        match agent {
            proto::AgentKind::Claude | proto::AgentKind::Cursor | proto::AgentKind::Antigravity => {
                args.push("--model".into())
            }
            proto::AgentKind::Codex | proto::AgentKind::Opencode | proto::AgentKind::Grok => {
                args.push("-m".into())
            }
            _ => unreachable!("filtered above"),
        }
        args.push(model.trim().into());
    }
    Ok(args)
}

fn effort_args(agent: proto::AgentKind, effort: proto::ChatEffort) -> Result<Vec<String>> {
    let value = effort.cli_value().to_string();
    match agent {
        proto::AgentKind::Claude | proto::AgentKind::Antigravity | proto::AgentKind::Grok => {
            Ok(vec!["--effort".into(), value])
        }
        proto::AgentKind::Codex => Ok(vec![
            "-c".into(),
            format!("model_reasoning_effort={value:?}"),
        ]),
        other => bail!(
            "agent {other:?} does not expose a per-run reasoning-effort flag; leave effort \
             automatic for this routine"
        ),
    }
}

pub fn routine_argv(
    agent: proto::AgentKind,
    model: Option<&str>,
    effort: Option<proto::ChatEffort>,
    permission_mode: proto::ChatPermissionMode,
) -> Result<(Vec<String>, ApprovalMode)> {
    let approval = match permission_mode {
        proto::ChatPermissionMode::AcceptEdits => ApprovalMode::Auto,
        proto::ChatPermissionMode::BypassPermissions => ApprovalMode::Bypass,
    };
    if approval == ApprovalMode::Auto {
        if agent == proto::AgentKind::Opencode {
            bail!(
                "agent Opencode has no bounded accept-edits mode for an unattended run; use \
                 an isolated full-access routine or choose another provider"
            );
        }
        if let Some(model) = model {
            if model_blocks_auto_mode(agent, model) {
                bail!(
                    "agent {agent:?} model {model:?} cannot run in auto mode; choose another \
                     model or use an isolated full-access routine"
                );
            }
        }
    }
    let mut argv = vec![executable(agent)?.to_string()];
    argv.extend(flags_only(agent, false, false, model)?);
    argv.extend(approval.args(agent).ok_or_else(|| {
        anyhow::anyhow!(
            "agent {agent:?} has no {:?} launch mode for an unattended routine",
            approval
        )
    })?);
    if let Some(effort) = effort {
        argv.extend(effort_args(agent, effort)?);
    }
    Ok((argv, approval))
}

pub fn auto_approve_args(agent: proto::AgentKind) -> Option<Vec<String>> {
    match agent {
        proto::AgentKind::Claude | proto::AgentKind::Antigravity => {
            Some(vec!["--dangerously-skip-permissions".to_string()])
        }
        proto::AgentKind::Codex => Some(vec![
            "--dangerously-bypass-approvals-and-sandbox".to_string()
        ]),
        proto::AgentKind::Opencode => Some(vec!["--auto".to_string()]),
        proto::AgentKind::Cursor => Some(vec!["--yolo".to_string()]),
        proto::AgentKind::Grok => Some(vec!["--always-approve".to_string()]),
        _ => None,
    }
}

pub fn auto_mode_args(agent: proto::AgentKind) -> Option<Vec<String>> {
    match agent {
        proto::AgentKind::Claude | proto::AgentKind::Grok => {
            Some(vec!["--permission-mode".to_string(), "auto".to_string()])
        }
        proto::AgentKind::Opencode => Some(vec!["--auto".to_string()]),
        proto::AgentKind::Codex => Some(vec!["--approve-for-me".to_string()]),
        proto::AgentKind::Cursor => Some(vec!["--auto-review".to_string()]),
        proto::AgentKind::Antigravity => {
            Some(vec!["--mode".to_string(), "accept-edits".to_string()])
        }
        _ => None,
    }
}

// `claude --permission-mode auto --model haiku` is accepted, then prints
// "auto mode unavailable for this model" and runs MANUAL for the rest — the
// child blocks on approvals with nobody at its keyboard. Only Claude measured.
pub fn model_blocks_auto_mode(agent: proto::AgentKind, model: &str) -> bool {
    let model = model.trim().to_ascii_lowercase();
    match agent {
        proto::AgentKind::Claude => model.contains("haiku"),
        _ => false,
    }
}

// Declaration order IS the ladder: `derive(PartialOrd, Ord)` compares by
// position, so `Default < Auto < Bypass` falls out of this order. Do not
// reorder the variants without re-checking every comparison.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ApprovalMode {
    Default,
    Auto,
    Bypass,
}

impl ApprovalMode {
    pub fn args(self, agent: proto::AgentKind) -> Option<Vec<String>> {
        match self {
            ApprovalMode::Default => Some(Vec::new()),
            ApprovalMode::Auto => auto_mode_args(agent),
            ApprovalMode::Bypass => auto_approve_args(agent),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalMode::Default => "default",
            ApprovalMode::Auto => "auto",
            ApprovalMode::Bypass => "bypass",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "default" => Some(ApprovalMode::Default),
            "auto" => Some(ApprovalMode::Auto),
            "bypass" => Some(ApprovalMode::Bypass),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_launch_args_never_carry_the_hook_trust_bypass() {
        const BYPASS: &str = "--dangerously-bypass-hook-trust";
        for auto_approve in [false, true] {
            for plan_mode in [false, true] {
                for model in [None, Some("gpt-5")] {
                    let args = flags_only(proto::AgentKind::Codex, auto_approve, plan_mode, model)
                        .expect("codex flags");
                    assert!(
                        !args.iter().any(|a| a == BYPASS),
                        "codex flags carry the hook-trust bypass: {args:?} \
                         (auto_approve={auto_approve}, plan_mode={plan_mode}, model={model:?})"
                    );
                    let dir = tempfile::tempdir().unwrap();
                    let (full, _) = launch_args(
                        proto::AgentKind::Codex,
                        auto_approve,
                        plan_mode,
                        model,
                        "a brief",
                        Some(dir.path()),
                        "codex-launch-test",
                    )
                    .expect("codex launch_args");
                    assert!(
                        !full.iter().any(|a| a == BYPASS),
                        "codex launch_args carry the hook-trust bypass: {full:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn auto_mode_is_never_the_dangerous_bypass() {
        use proto::AgentKind::*;
        for kind in [Claude, Codex, Antigravity, Cursor, Grok] {
            let (Some(auto), Some(bypass)) = (auto_mode_args(kind), auto_approve_args(kind)) else {
                continue;
            };
            assert_ne!(auto, bypass, "{kind:?}: auto mode must not be the bypass");
        }
        assert_eq!(auto_mode_args(Opencode), auto_approve_args(Opencode));
        assert_eq!(
            auto_mode_args(Claude).unwrap(),
            vec!["--permission-mode", "auto"]
        );
        assert_eq!(
            auto_mode_args(Grok).unwrap(),
            vec!["--permission-mode", "auto"]
        );
        assert_eq!(auto_mode_args(Opencode).unwrap(), vec!["--auto"]);
        assert_eq!(auto_mode_args(Cursor).unwrap(), vec!["--auto-review"]);
        assert_eq!(auto_mode_args(Codex).unwrap(), vec!["--approve-for-me"]);
        assert_eq!(
            auto_mode_args(Antigravity).unwrap(),
            vec!["--mode", "accept-edits"]
        );
        assert_eq!(
            auto_approve_args(Antigravity).unwrap(),
            vec!["--dangerously-skip-permissions"]
        );
        assert_eq!(auto_mode_args(Shell), None);
    }

    #[test]
    fn haiku_is_known_to_cost_claude_its_auto_mode() {
        use proto::AgentKind::*;
        assert!(model_blocks_auto_mode(Claude, "haiku"));
        assert!(model_blocks_auto_mode(Claude, "claude-haiku-4-5-20251001"));
        assert!(model_blocks_auto_mode(Claude, "  Haiku  "));
        for ok in ["sonnet", "opus", "fable", "claude-opus-5"] {
            assert!(
                !model_blocks_auto_mode(Claude, ok),
                "{ok} must stay allowed"
            );
        }
        assert!(!model_blocks_auto_mode(
            Claude,
            "some-model-shipped-next-year"
        ));
        for kind in [Grok, Codex, Antigravity, Opencode, Cursor, Shell] {
            assert!(
                !model_blocks_auto_mode(kind, "haiku"),
                "{kind:?} was never measured"
            );
        }
    }

    #[test]
    fn routine_argv_carries_its_execution_choices_and_refuses_unsafe_gaps() {
        let (claude, approval) = routine_argv(
            proto::AgentKind::Claude,
            Some("opus"),
            Some(proto::ChatEffort::High),
            proto::ChatPermissionMode::AcceptEdits,
        )
        .unwrap();
        assert_eq!(approval, ApprovalMode::Auto);
        assert_eq!(
            claude,
            [
                "claude",
                "--model",
                "opus",
                "--permission-mode",
                "auto",
                "--effort",
                "high"
            ]
        );

        let (codex, approval) = routine_argv(
            proto::AgentKind::Codex,
            Some("gpt-5.6-codex"),
            Some(proto::ChatEffort::Max),
            proto::ChatPermissionMode::AcceptEdits,
        )
        .unwrap();
        assert_eq!(approval, ApprovalMode::Auto);
        assert_eq!(
            codex,
            [
                "codex",
                "-m",
                "gpt-5.6-codex",
                "--approve-for-me",
                "-c",
                "model_reasoning_effort=\"max\""
            ]
        );

        let err = routine_argv(
            proto::AgentKind::Opencode,
            None,
            None,
            proto::ChatPermissionMode::AcceptEdits,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("no bounded accept-edits mode"), "{err}");

        let err = routine_argv(
            proto::AgentKind::Cursor,
            None,
            Some(proto::ChatEffort::High),
            proto::ChatPermissionMode::BypassPermissions,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("does not expose"), "{err}");
    }

    #[test]
    fn approval_mode_args_delegate_to_the_underlying_tables() {
        use proto::AgentKind::*;
        assert_eq!(ApprovalMode::Default.args(Claude), Some(Vec::new()));
        for kind in [Claude, Codex, Antigravity, Opencode, Cursor, Grok, Shell] {
            assert_eq!(ApprovalMode::Auto.args(kind), auto_mode_args(kind));
            assert_eq!(ApprovalMode::Bypass.args(kind), auto_approve_args(kind));
        }
    }

    #[test]
    fn approval_mode_strings_round_trip() {
        for mode in [
            ApprovalMode::Default,
            ApprovalMode::Auto,
            ApprovalMode::Bypass,
        ] {
            assert_eq!(ApprovalMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(ApprovalMode::parse("bogus"), None);
    }

    #[test]
    fn approval_mode_ladder_orders_least_to_most_permissive() {
        assert!(ApprovalMode::Default < ApprovalMode::Auto);
        assert!(ApprovalMode::Auto < ApprovalMode::Bypass);
        assert!(ApprovalMode::Default < ApprovalMode::Bypass);
    }

    #[test]
    fn launch_args_per_cli_and_approval() {
        let dir = Path::new("/tmp/scope");
        let (a, f) = launch_args(
            proto::AgentKind::Claude,
            true,
            false,
            None,
            "do it",
            Some(dir),
            "B-1",
        )
        .unwrap();
        assert_eq!(a, vec!["do it", "--dangerously-skip-permissions"]);
        assert!(f.is_none());
        let (a, _) = launch_args(
            proto::AgentKind::Codex,
            true,
            false,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--dangerously-bypass-approvals-and-sandbox"]);
        let (a, _) = launch_args(
            proto::AgentKind::Antigravity,
            false,
            false,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["-i", "p"]);
        let (a, _) = launch_args(
            proto::AgentKind::Opencode,
            true,
            false,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["--prompt", "p", "--auto"]);
        let (a, _) = launch_args(
            proto::AgentKind::Cursor,
            true,
            false,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--yolo"]);
        let (a, _) = launch_args(
            proto::AgentKind::Grok,
            true,
            false,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--always-approve"]);
        let err = launch_args(
            proto::AgentKind::Shell,
            false,
            false,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("Shell"), "error should name the kind: {err}");
        for expected in [
            "claude",
            "codex",
            "antigravity",
            "opencode",
            "cursor",
            "grok",
        ] {
            assert!(err.contains(expected), "{expected} missing from: {err}");
        }
    }

    #[test]
    fn launch_args_model_flag_per_cli() {
        let dir = Path::new("/tmp/scope");
        let (a, _) = launch_args(
            proto::AgentKind::Claude,
            false,
            false,
            Some("opus"),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--model", "opus"]);
        let (a, _) = launch_args(
            proto::AgentKind::Codex,
            true,
            false,
            Some("gpt-5-codex"),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(
            a,
            vec![
                "p",
                "--dangerously-bypass-approvals-and-sandbox",
                "-m",
                "gpt-5-codex"
            ]
        );
        let (a, _) = launch_args(
            proto::AgentKind::Antigravity,
            false,
            false,
            Some("gemini-3-pro"),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["-i", "p", "--model", "gemini-3-pro"]);
        let (a, _) = launch_args(
            proto::AgentKind::Opencode,
            false,
            false,
            Some("anthropic/claude-opus-5"),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["--prompt", "p", "-m", "anthropic/claude-opus-5"]);
        let (a, _) = launch_args(
            proto::AgentKind::Cursor,
            false,
            false,
            Some("sonnet-4.5"),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--model", "sonnet-4.5"]);
        let (a, _) = launch_args(
            proto::AgentKind::Grok,
            false,
            false,
            Some("grok-4"),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "-m", "grok-4"]);
        let (a, _) = launch_args(
            proto::AgentKind::Claude,
            false,
            false,
            Some("  "),
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p"]);
    }

    #[test]
    fn launch_args_plan_mode_per_cli_and_wins_over_auto_approve() {
        let dir = Path::new("/tmp/scope");
        let (a, _) = launch_args(
            proto::AgentKind::Claude,
            false,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--permission-mode", "plan"]);
        let (a, _) = launch_args(
            proto::AgentKind::Codex,
            false,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "-s", "read-only", "-a", "on-request"]);
        let (a, _) = launch_args(
            proto::AgentKind::Antigravity,
            false,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["-i", "p", "--mode", "plan"]);
        let (a, _) = launch_args(
            proto::AgentKind::Opencode,
            false,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["--prompt", "p", "--agent", "plan"]);
        let (a, _) = launch_args(
            proto::AgentKind::Cursor,
            false,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--plan"]);
        let (a, _) = launch_args(
            proto::AgentKind::Grok,
            false,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--permission-mode", "plan"]);
        for kind in [
            proto::AgentKind::Opencode,
            proto::AgentKind::Cursor,
            proto::AgentKind::Grok,
        ] {
            let (a, _) = launch_args(kind, true, true, None, "p", Some(dir), "x").unwrap();
            for bypass in ["--auto", "--yolo", "--always-approve"] {
                assert!(!a.iter().any(|f| f == bypass), "{kind:?} emitted {bypass}");
            }
        }
        let (a, _) = launch_args(
            proto::AgentKind::Claude,
            true,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert_eq!(a, vec!["p", "--permission-mode", "plan"]);
    }

    #[test]
    fn long_prompt_goes_to_file_with_read_stub() {
        let dir = PathBuf::from("/tmp/scope");
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        let (args, file) = launch_args(
            proto::AgentKind::Claude,
            false,
            false,
            None,
            &long,
            Some(&dir),
            "Builder 1",
        )
        .unwrap();
        let (path, contents) = file.expect("prompt file");
        assert_eq!(contents, long);
        assert_eq!(path, dir.join("prompt-builder-1.md"));
        assert!(args[0].contains("Read the file"));
        assert!(args[0].contains("prompt-builder-1.md"));
    }

    #[test]
    fn long_prompt_without_a_file_dir_is_refused_by_name() {
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        let err = launch_args(proto::AgentKind::Grok, false, false, None, &long, None, "x")
            .unwrap_err()
            .to_string();
        assert!(err.contains(&long.len().to_string()), "{err}");
        assert!(err.contains(&PROMPT_FILE_THRESHOLD.to_string()), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn multiline_prompt_goes_to_file_even_when_short() {
        let dir = Path::new("/tmp/scope");
        let (args, file) = launch_args(
            proto::AgentKind::Codex,
            false,
            false,
            Some("gpt-5-codex"),
            "line one\r\nline two",
            Some(dir),
            "x",
        )
        .unwrap();
        let (_path, contents) = file.expect("multiline prompt must go to a file");
        assert_eq!(contents, "line one\r\nline two");
        assert!(args[0].contains("Read the file"));
        assert!(args[0].contains("prompt-x.md"));
        assert_eq!(args[1], "-m");
        assert_eq!(args[2], "gpt-5-codex");
    }

    #[cfg(not(windows))]
    #[test]
    fn multiline_prompt_stays_inline_where_nothing_truncates_argv() {
        let dir = Path::new("/tmp/scope");
        let (args, file) = launch_args(
            proto::AgentKind::Codex,
            false,
            false,
            Some("gpt-5-codex"),
            "line one\nline two",
            Some(dir),
            "x",
        )
        .unwrap();
        assert!(file.is_none());
        assert_eq!(args[0], "line one\nline two");
        assert_eq!(args[1], "-m");
        assert_eq!(args[2], "gpt-5-codex");
    }

    #[test]
    fn empty_prompt_means_no_prompt_at_all_even_with_flags() {
        let (args, file) = launch_args(
            proto::AgentKind::Claude,
            false,
            false,
            None,
            "  ",
            None,
            "x",
        )
        .unwrap();
        assert!(args.is_empty());
        assert!(file.is_none());
    }
}
