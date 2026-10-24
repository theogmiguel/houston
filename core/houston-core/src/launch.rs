use anyhow::{bail, Result};
use houston_protocol as proto;
use std::path::{Path, PathBuf};

// Prompts longer than this go to a file the CLI reads: argv has OS limits,
// and huge argv is hostile to ps/shell history. On Windows any newline
// forces the file too — cmd.exe drops everything after a quoted newline.
pub const PROMPT_FILE_THRESHOLD: usize = 12_000;

pub type LaunchArgs = (Vec<String>, Option<(PathBuf, String)>);

/// Writes the pane's merged Claude settings to `settings_file` and returns the `--settings`
/// arguments naming it. The env carries the pane bearer token, so it travels in an
/// owner-only file rather than argv, which other local users can read.
pub(crate) fn claude_pane_env_args(
    command: &portable_pty::CommandBuilder,
    settings_file: &Path,
) -> Result<[String; 2]> {
    // Claude's background host preserves argv but inherits its daemon's environment.
    let env: serde_json::Map<String, serde_json::Value> = command
        .iter_extra_env_as_str()
        .filter(|(key, _)| {
            key.starts_with("HOUSTON_")
                || key.starts_with("TR_")
                || matches!(*key, "PATH" | "CLAUDE_CONFIG_DIR")
        })
        .map(|(key, value)| {
            (
                key.to_string(),
                serde_json::Value::String(value.to_string()),
            )
        })
        .collect();
    let supplied = command
        .get_argv()
        .iter()
        .enumerate()
        .rev()
        .find_map(|(index, arg)| {
            if arg == "--settings" {
                command
                    .get_argv()
                    .get(index + 1)
                    .and_then(|value| value.to_str())
            } else {
                arg.to_str()
                    .and_then(|value| value.strip_prefix("--settings="))
            }
        });
    let mut settings = if let Some(supplied) = supplied {
        let text = if supplied.trim_start().starts_with('{') {
            supplied.to_string()
        } else {
            let path = Path::new(supplied);
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                PathBuf::from(command.get_cwd().cloned().unwrap_or_default()).join(path)
            };
            std::fs::read_to_string(&path).map_err(|error| {
                anyhow::anyhow!(
                    "Claude --settings path {} must be a readable JSON object: {error}",
                    path.display()
                )
            })?
        };
        serde_json::from_str::<serde_json::Value>(&text)?
    } else {
        serde_json::json!({})
    };
    let object = settings
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Claude --settings must be a JSON object"))?;
    let settings_env = object
        .entry("env")
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow::anyhow!("Claude --settings env must be a JSON object"))?;
    settings_env.extend(env);
    write_owner_only(settings_file, settings.to_string().as_bytes())?;
    Ok(["--settings".into(), settings_file.display().to_string()])
}

fn write_owner_only(path: &Path, contents: &[u8]) -> Result<()> {
    let dir = path.parent().ok_or_else(|| {
        anyhow::anyhow!(
            "pane settings path {} has no parent directory",
            path.display()
        )
    })?;
    std::fs::create_dir_all(dir).map_err(|e| anyhow::anyhow!("creating {}: {e}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
            .map_err(|e| anyhow::anyhow!("chmod 0700 {}: {e}", dir.display()))?;
        // Replace rather than truncate, so a file left with wider permissions never keeps them.
        let _ = std::fs::remove_file(path);
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| anyhow::anyhow!("creating {}: {e}", path.display()))?;
        file.write_all(contents)
            .map_err(|e| anyhow::anyhow!("writing {}: {e}", path.display()))?;
    }
    #[cfg(not(unix))]
    std::fs::write(path, contents)
        .map_err(|e| anyhow::anyhow!("writing {}: {e}", path.display()))?;
    Ok(())
}

/// Providers Houston still recognises (stored rows, detected processes) but no longer launches.
pub const RETIRED_PROVIDERS: [proto::AgentKind; 2] =
    [proto::AgentKind::Cursor, proto::AgentKind::Grok];

/// The providers Houston launches, in the order refusals list them.
pub const LAUNCHABLE_PROVIDER_NAMES: &str = "claude, codex, antigravity, opencode or zcode";

/// The refusal for a retired provider, or `None` when `agent` is not retired.
pub fn retired_provider_refusal(agent: proto::AgentKind) -> Option<String> {
    let name = match agent {
        proto::AgentKind::Cursor => "cursor",
        proto::AgentKind::Grok => "grok",
        _ => return None,
    };
    Some(format!(
        "{name} is no longer a supported provider: Houston recognises it but cannot launch it; \
         close this pane or choose {LAUNCHABLE_PROVIDER_NAMES}"
    ))
}

pub fn ensure_launchable(agent: proto::AgentKind) -> Result<()> {
    match retired_provider_refusal(agent) {
        Some(refusal) => bail!("{refusal}"),
        None => Ok(()),
    }
}

pub fn dialogue_permission_args(agent: proto::AgentKind) -> Vec<String> {
    match agent {
        // One token: the flag is variadic, so a separate value could swallow a later positional.
        proto::AgentKind::Claude => vec!["--allowedTools=mcp__houston__pane_submit,mcp__houston__pane_report,mcp__houston__pane_reply,mcp__houston__pane_message,mcp__houston__pane_wait,mcp__houston__pane_deny,mcp__houston__pane_escalate".into()],
        _ => Vec::new(),
    }
}

/// The launch-only permission rules for an orchestrated child: Houston's dialogue
/// tools plus, for a child given a file-backed brief, a Read rule for exactly that
/// file. One `--allowedTools` token: Houston never relies on repeating the flag.
pub fn child_permission_args(agent: proto::AgentKind, brief: Option<&Path>) -> Vec<String> {
    let Some(mut flag) = dialogue_permission_args(agent).into_iter().next() else {
        return Vec::new();
    };
    if let Some(rule) = brief_read_rule(agent, brief) {
        flag.push(',');
        flag.push_str(&rule);
    }
    vec![flag]
}

/// The child-facing form of a brief path. Paths Houston keeps internally may be
/// canonicalised into the Windows `\\?\` verbatim form, which child CLIs read as
/// a foreign path; the plain DOS/UNC form names the same file.
pub fn brief_display_path(path: &Path) -> String {
    #[cfg(windows)]
    let plain = crate::paths::windows_command_path(path);
    #[cfg(not(windows))]
    let plain = path.to_path_buf();
    plain.display().to_string()
}

/// Claude Code's exact-file Read allow rule for a launch brief, or `None` for other
/// providers or no brief. Absolute rules start with `//`, and Claude matches Windows
/// paths in POSIX form (`C:\x` becomes `/c/x`), so the rule is written that way.
pub fn brief_read_rule(agent: proto::AgentKind, brief: Option<&Path>) -> Option<String> {
    let brief = brief?;
    if agent != proto::AgentKind::Claude {
        return None;
    }
    let mut body = brief_display_path(brief).replace('\\', "/");
    if body.as_bytes().get(1) == Some(&b':') {
        // `C:/x` normalises to `/c/x`: the drive letter lowers and the colon drops.
        let drive = body[..1].to_ascii_lowercase();
        body.replace_range(..2, &format!("/{drive}"));
    }
    Some(format!("Read(/{body})"))
}

pub fn worktree_trust_args(agent: proto::AgentKind, cwd: &Path) -> Result<Vec<String>> {
    use proto::AgentKind::*;
    ensure_launchable(agent)?;
    match agent {
        Codex => {
            let directory = cwd.display().to_string();
            let path = toml::Value::String(directory.clone()).to_string();
            let mut projects = format!("{path}={{trust_level=\"trusted\"}}");
            if cwd.is_dir() {
                if let Some(main) = crate::worktrees::list(cwd)?
                    .into_iter()
                    .find(|tree| tree.is_main && !tree.is_bare)
                {
                    let main = main.path.display().to_string();
                    if main != directory {
                        let main = toml::Value::String(main).to_string();
                        projects.push_str(&format!(",{main}={{trust_level=\"trusted\"}}"));
                    }
                }
            }
            Ok(vec!["-c".into(), format!("projects={{{projects}}}")])
        }
        Claude | Antigravity | Opencode | Zcode => Ok(Vec::new()),
        other => {
            bail!("worktree spawn refused for provider {other:?}: expected a spawnable provider")
        }
    }
}

pub fn worktree_trust_warning(agent: proto::AgentKind) -> Option<String> {
    let provider = match agent {
        proto::AgentKind::Claude => "Claude",
        proto::AgentKind::Antigravity => "Antigravity",
        proto::AgentKind::Opencode => "OpenCode",
        _ => return None,
    };
    Some(format!("{provider} may ask to trust this new worktree folder before it starts; answer it in the child's pane"))
}

fn executable(agent: proto::AgentKind) -> Result<&'static str> {
    match agent {
        proto::AgentKind::Claude => Ok("claude"),
        proto::AgentKind::Codex => Ok("codex"),
        proto::AgentKind::Antigravity => Ok("agy"),
        proto::AgentKind::Opencode => Ok("opencode"),
        proto::AgentKind::Zcode => Ok("zcode"),
        other => {
            ensure_launchable(other)?;
            bail!(
                "agent kind {other:?} cannot run a routine in a pane (expected claude, codex, \
                 antigravity, opencode or zcode)"
            )
        }
    }
}

fn prompt_outgrows_argv(prompt: &str) -> bool {
    prompt.len() > PROMPT_FILE_THRESHOLD || (cfg!(windows) && prompt.contains(['\r', '\n']))
}

/// ZCode reads its first positional as a subcommand and has no prompt flag for its
/// TUI, so its first prompt is pasted once its composer takes input (`composer_ready.rs`).
pub fn prompt_in_argv(agent: proto::AgentKind) -> bool {
    agent != proto::AgentKind::Zcode
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
    ensure_launchable(agent)?;
    if prompt.trim().is_empty() {
        return Ok((flags_only(agent, auto_approve, plan_mode, model)?, None));
    }
    if !prompt_in_argv(agent) {
        bail!(
            "agent kind {agent:?} takes no prompt in argv; deliver it with prompt_text after \
             the TUI starts"
        );
    }
    let (prompt_arg, prompt_file) = prompt_text(prompt, prompt_file_dir, label)?;

    let mut args = match agent {
        proto::AgentKind::Claude => vec![prompt_arg],
        proto::AgentKind::Codex => vec![prompt_arg],
        proto::AgentKind::Antigravity => vec!["-i".into(), prompt_arg],
        proto::AgentKind::Opencode => vec!["--prompt".into(), prompt_arg],
        proto::AgentKind::Custom => return Ok((Vec::new(), None)),
        other => {
            bail!(
                "agent kind {other:?} is not spawnable (expected claude, codex, antigravity, \
                 opencode or zcode)"
            )
        }
    };
    args.extend(flags_only(agent, auto_approve, plan_mode, model)?);
    Ok((args, prompt_file))
}

/// The text that carries `prompt` to the agent: the prompt itself, or for one that
/// outgrows argv, a pointer to the file (returned for the caller to write) holding it.
pub fn prompt_text(
    prompt: &str,
    prompt_file_dir: Option<&Path>,
    label: &str,
) -> Result<(String, Option<(PathBuf, String)>)> {
    let mut prompt_file = None;
    let text = if prompt_outgrows_argv(prompt) {
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
        // A running agent may reread its brief after compaction or resume.
        let path = dir.join(format!("prompt-{sanitized}-{}.md", uuid::Uuid::new_v4()));
        let stub = format!(
            "Read the file {} and follow every instruction in it exactly. \
             It is your full mission brief for this job; start working immediately.",
            brief_display_path(&path)
        );
        prompt_file = Some((path, prompt.to_string()));
        stub
    } else {
        prompt.to_string()
    };

    Ok((text, prompt_file))
}

pub(crate) fn flags_only(
    agent: proto::AgentKind,
    auto_approve: bool,
    plan_mode: bool,
    model: Option<&str>,
) -> Result<Vec<String>> {
    let mut args: Vec<String> = Vec::new();
    ensure_launchable(agent)?;
    match agent {
        proto::AgentKind::Claude
        | proto::AgentKind::Codex
        | proto::AgentKind::Antigravity
        | proto::AgentKind::Opencode
        | proto::AgentKind::Zcode => {}
        proto::AgentKind::Custom => return Ok(args),
        other => {
            bail!(
                "agent kind {other:?} is not spawnable (expected claude, codex, antigravity, \
                 opencode or zcode)"
            )
        }
    }
    if agent == proto::AgentKind::Zcode {
        if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
            bail!(
                "model {:?} refused for ZCode: it has no model flag and rejects unknown \
                 flags; leave model empty and choose the model in ZCode with /model",
                model.trim()
            );
        }
    }
    if plan_mode {
        if let Some(reason) = planning_refusal(agent) {
            bail!("agent {agent:?} refused for read-only planning: {reason}");
        }
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
            _ => unreachable!("filtered above"),
        }
    } else if auto_approve {
        args.extend(auto_approve_args(agent).unwrap_or_default());
    }
    if let Some(model) = model.filter(|m| !m.trim().is_empty()) {
        match agent {
            proto::AgentKind::Claude | proto::AgentKind::Antigravity => args.push("--model".into()),
            proto::AgentKind::Codex | proto::AgentKind::Opencode => args.push("-m".into()),
            _ => unreachable!("filtered above; ZCode's model is refused"),
        }
        args.push(model.trim().into());
    }
    Ok(args)
}

pub(crate) fn effort_args(
    agent: proto::AgentKind,
    effort: proto::ChatEffort,
) -> Result<Vec<String>> {
    let value = effort.cli_value().to_string();
    ensure_launchable(agent)?;
    match agent {
        proto::AgentKind::Claude | proto::AgentKind::Antigravity => {
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

/// Why `agent` cannot start in an enforced read-only planning mode. `flags_only` refuses
/// exactly these; task domain state carries them so the planning control is disabled.
pub fn planning_refusal(agent: proto::AgentKind) -> Option<&'static str> {
    match agent {
        // `--mode` takes build, edit or yolo only. `/plan` inside the TUI is read-only,
        // but no flag, setting or hook payload lets Houston set or confirm it.
        proto::AgentKind::Zcode => Some(
            "its command line has no read-only planning mode; planning is switched on only \
             inside ZCode, with /plan",
        ),
        _ => None,
    }
}

/// Every refusal `planning_refusal` makes, for the planning control.
pub fn planning_refusals() -> Vec<proto::PlanningRefusal> {
    use proto::AgentKind::*;
    [Claude, Codex, Antigravity, Opencode, Zcode]
        .into_iter()
        .filter_map(|agent| {
            planning_refusal(agent).map(|reason| proto::PlanningRefusal {
                agent,
                reason: reason.to_string(),
            })
        })
        .collect()
}

/// Why `agent` cannot run an unattended routine with `permission_mode`, whatever its
/// model and effort. `routine_argv` refuses exactly these; routine and Harness state
/// carry them so a picker disables the choice before it is made.
pub fn routine_access_refusal(
    agent: proto::AgentKind,
    permission_mode: proto::ChatPermissionMode,
) -> Option<&'static str> {
    if permission_mode != proto::ChatPermissionMode::AcceptEdits {
        return None;
    }
    match agent {
        // OpenCode's `--auto` is its only unattended mode, the same flag as full access.
        proto::AgentKind::Opencode => {
            Some("its only unattended mode approves every action, as full access does")
        }
        // `--mode edit` approves workspace file edits only; every other command asks,
        // and its TUI waits on an unanswered approval without a timeout.
        proto::AgentKind::Zcode => {
            Some("its edit mode waits for approval on every shell command, and nobody gives it")
        }
        _ => None,
    }
}

/// Every access refusal `routine_access_refusal` makes, for the routine pickers.
pub fn routine_engine_refusals() -> Vec<proto::RoutineEngineRefusal> {
    use proto::AgentKind::*;
    use proto::ChatPermissionMode::*;
    [Claude, Codex, Antigravity, Opencode, Zcode]
        .into_iter()
        .flat_map(|engine| [AcceptEdits, BypassPermissions].map(|mode| (engine, mode)))
        .filter_map(|(engine, permission_mode)| {
            routine_access_refusal(engine, permission_mode).map(|reason| {
                proto::RoutineEngineRefusal {
                    engine,
                    permission_mode,
                    reason: reason.to_string(),
                }
            })
        })
        .collect()
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
    if let Some(reason) = routine_access_refusal(agent, permission_mode) {
        bail!(
            "agent {agent:?} has no bounded accept-edits mode for an unattended run: {reason}; \
             use an isolated full-access routine or choose another provider"
        );
    }
    if approval == ApprovalMode::Auto {
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
        proto::AgentKind::Zcode => Some(vec!["--mode".to_string(), "yolo".to_string()]),
        _ => None,
    }
}

/// The argv that reopens conversation `id` in a new process. Only providers whose
/// resume-by-exact-id is verified answer; `--continue` is never an option, because it
/// picks the newest conversation in the directory, not this pane's.
pub fn resume_args(agent: proto::AgentKind, id: &str) -> Result<Vec<String>> {
    match agent {
        proto::AgentKind::Claude => Ok(vec!["--resume".to_string(), id.to_string()]),
        proto::AgentKind::Codex => Ok(vec!["resume".to_string(), id.to_string()]),
        proto::AgentKind::Zcode => Ok(vec!["--resume".to_string(), id.to_string()]),
        other => bail!(
            "resuming a conversation is not supported for {other:?} (only Claude, Codex and \
             ZCode); conversation {id:?} stays unresumed"
        ),
    }
}

/// Providers whose conversation Houston records from hooks and resumes by exact id.
pub fn resumes_conversations(agent: proto::AgentKind) -> bool {
    matches!(
        agent,
        proto::AgentKind::Claude | proto::AgentKind::Codex | proto::AgentKind::Zcode
    )
}

/// Whether resuming is checked against a transcript file. ZCode keeps its sessions
/// in its own database, so a missing one surfaces as ZCode's error in the pane.
pub fn resume_needs_transcript(agent: proto::AgentKind) -> bool {
    agent != proto::AgentKind::Zcode
}

pub fn auto_mode_args(agent: proto::AgentKind) -> Option<Vec<String>> {
    match agent {
        proto::AgentKind::Claude => Some(vec!["--permission-mode".to_string(), "auto".to_string()]),
        proto::AgentKind::Opencode => Some(vec!["--auto".to_string()]),
        proto::AgentKind::Codex => Some(vec!["--approve-for-me".to_string()]),
        proto::AgentKind::Antigravity => {
            Some(vec!["--mode".to_string(), "accept-edits".to_string()])
        }
        proto::AgentKind::Zcode => Some(vec!["--mode".to_string(), "edit".to_string()]),
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

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalMode {
    Default,
    Auto,
    Bypass,
    Plan,
    /// Claude only; set from a thread's permission mode control.
    AcceptEdits,
}

impl ApprovalMode {
    pub fn args(self, agent: proto::AgentKind) -> Option<Vec<String>> {
        match self {
            ApprovalMode::Default => Some(Vec::new()),
            ApprovalMode::Auto => auto_mode_args(agent),
            ApprovalMode::Bypass => auto_approve_args(agent),
            ApprovalMode::Plan => flags_only(agent, false, true, None).ok(),
            ApprovalMode::AcceptEdits => (agent == proto::AgentKind::Claude)
                .then(|| vec!["--permission-mode".to_string(), "acceptEdits".to_string()]),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            ApprovalMode::Default => "default",
            ApprovalMode::Auto => "auto",
            ApprovalMode::Bypass => "bypass",
            ApprovalMode::Plan => "plan",
            ApprovalMode::AcceptEdits => "accept_edits",
        }
    }

    pub fn from_thread(mode: proto::ThreadPermissionMode) -> Self {
        match mode {
            proto::ThreadPermissionMode::Default => ApprovalMode::Default,
            proto::ThreadPermissionMode::AcceptEdits => ApprovalMode::AcceptEdits,
            proto::ThreadPermissionMode::Plan => ApprovalMode::Plan,
            proto::ThreadPermissionMode::Auto => ApprovalMode::Auto,
            proto::ThreadPermissionMode::Bypass => ApprovalMode::Bypass,
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "default" => Some(ApprovalMode::Default),
            "auto" => Some(ApprovalMode::Auto),
            "bypass" => Some(ApprovalMode::Bypass),
            "plan" => Some(ApprovalMode::Plan),
            "accept_edits" => Some(ApprovalMode::AcceptEdits),
            _ => None,
        }
    }
}

/// Reusable provider choices only: never an initial prompt, arbitrary argv or environment.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionLaunchSelections {
    pub provider: proto::AgentKind,
    pub model: Option<String>,
    pub effort: Option<proto::ChatEffort>,
    pub approval: ApprovalMode,
    pub dialogue: bool,
}

impl SessionLaunchSelections {
    pub fn supports(provider: proto::AgentKind) -> bool {
        executable(provider).is_ok()
    }

    pub fn args(&self, provider: proto::AgentKind) -> Result<Vec<String>> {
        anyhow::ensure!(
            self.provider == provider,
            "launch selections name {:?}, expected {provider:?}",
            self.provider
        );
        let mut args = flags_only(provider, false, false, self.model.as_deref())?;
        args.extend(self.approval.args(provider).ok_or_else(|| {
            anyhow::anyhow!(
                "provider {provider:?} does not support launch mode {:?}",
                self.approval
            )
        })?);
        if let Some(effort) = self.effort {
            args.extend(effort_args(provider, effort)?);
        }
        if self.dialogue {
            args.extend(dialogue_permission_args(provider));
        }
        Ok(args)
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn claude_pane_env_preserves_relative_settings_files() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(
            directory.path().join("settings.json"),
            r#"{"model":"sonnet","env":{"USER_SETTING":"retained"}}"#,
        )
        .unwrap();
        let mut command = portable_pty::CommandBuilder::new("claude");
        command.env_clear();
        command.cwd(directory.path());
        command.arg("--settings=settings.json");
        command.env("TR_SESSION", "7");
        let settings_file = directory.path().join("state/hooks/pane-settings/7.json");
        let args = super::claude_pane_env_args(&command, &settings_file).unwrap();
        assert_eq!(args[1], settings_file.display().to_string());
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&settings_file).unwrap()).unwrap();
        assert_eq!(settings["model"], "sonnet");
        assert_eq!(settings["env"]["USER_SETTING"], "retained");
        assert_eq!(settings["env"]["TR_SESSION"], "7");
    }
    #[test]
    fn claude_settings_carry_only_the_pane_launch_environment() {
        let mut command = portable_pty::CommandBuilder::new("claude");
        command.env_clear();
        for (key, value) in [
            ("TR_SESSION", "7"),
            ("HOUSTON_SESSION", "7"),
            ("HOUSTON_CHANNEL", "dev"),
            ("HOUSTON_MCP_TOKEN", "pane-token"),
            ("PATH", "/tmp/bin"),
            ("CLAUDE_CONFIG_DIR", "/tmp/profile with spaces"),
            ("ANTHROPIC_API_KEY", "excluded"),
        ] {
            command.env(key, value);
        }
        command.args(["--settings", r#"{"env":{"USER_SETTING":"retained","TR_SESSION":"stale"},"hooks":{"SessionStart":[]}}"#]);
        let directory = tempfile::tempdir().unwrap();
        let settings_file = directory.path().join("pane-settings/7.json");
        // A file left by an earlier launch with wider permissions must not keep them.
        std::fs::create_dir_all(settings_file.parent().unwrap()).unwrap();
        std::fs::write(&settings_file, "stale").unwrap();
        let args = super::claude_pane_env_args(&command, &settings_file).unwrap();
        assert_eq!(args[0], "--settings");
        assert!(
            !args.iter().any(|arg| arg.contains("pane-token")),
            "the pane bearer token must not reach argv: {args:?}"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = |path: &std::path::Path| {
                std::fs::metadata(path).unwrap().permissions().mode() & 0o777
            };
            assert_eq!(mode(&settings_file), 0o600);
            assert_eq!(mode(settings_file.parent().unwrap()), 0o700);
        }
        let settings: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&args[1]).unwrap()).unwrap();
        assert_eq!(settings["env"]["TR_SESSION"], "7");
        assert_eq!(settings["env"]["HOUSTON_SESSION"], "7");
        assert_eq!(settings["env"]["HOUSTON_CHANNEL"], "dev");
        assert_eq!(settings["env"]["HOUSTON_MCP_TOKEN"], "pane-token");
        assert_eq!(settings["env"]["PATH"], "/tmp/bin");
        assert_eq!(
            settings["env"]["CLAUDE_CONFIG_DIR"],
            "/tmp/profile with spaces"
        );
        assert!(settings["env"].get("ANTHROPIC_API_KEY").is_none());
        assert_eq!(settings["env"]["USER_SETTING"], "retained");
        assert_eq!(settings["hooks"]["SessionStart"], serde_json::json!([]));
    }
    #[test]
    fn child_dialogue_permissions_are_limited_to_exact_houston_tools() {
        use houston_protocol::AgentKind::*;
        assert_eq!(
            super::dialogue_permission_args(Claude),
            ["--allowedTools=mcp__houston__pane_submit,mcp__houston__pane_report,mcp__houston__pane_reply,mcp__houston__pane_message,mcp__houston__pane_wait,mcp__houston__pane_deny,mcp__houston__pane_escalate"]
        );
        for agent in [Codex, Antigravity, Opencode, Cursor, Grok] {
            assert!(super::dialogue_permission_args(agent).is_empty());
        }
    }
    use super::*;

    #[test]
    fn resume_args_accepts_claude_and_codex_and_refuses_other_providers_by_name() {
        use proto::AgentKind as K;
        assert_eq!(
            resume_args(K::Claude, "c-1").unwrap(),
            ["--resume".to_string(), "c-1".to_string()]
        );
        assert_eq!(
            resume_args(K::Codex, "c-1").unwrap(),
            ["resume".to_string(), "c-1".to_string()]
        );
        for kind in [
            K::Antigravity,
            K::Shell,
            K::Custom,
            K::Opencode,
            K::Cursor,
            K::Grok,
            K::Droid,
            K::Copilot,
            K::Aider,
            K::Ssh,
        ] {
            let err = resume_args(kind, "c-1").unwrap_err().to_string();
            assert!(err.contains(&format!("{kind:?}")), "{kind:?}: {err}");
        }
    }

    #[test]
    fn zcode_takes_modes_and_resume_but_no_model_and_no_prompt_in_argv() {
        use proto::AgentKind::Zcode;
        assert_eq!(
            flags_only(Zcode, false, false, None).unwrap(),
            Vec::<String>::new()
        );
        assert_eq!(
            flags_only(Zcode, true, false, None).unwrap(),
            ["--mode", "yolo"]
        );
        assert_eq!(auto_mode_args(Zcode).unwrap(), ["--mode", "edit"]);
        assert_eq!(
            ApprovalMode::Bypass.args(Zcode).unwrap(),
            ["--mode", "yolo"]
        );
        assert_eq!(
            resume_args(Zcode, "sess_01").unwrap(),
            ["--resume".to_string(), "sess_01".to_string()]
        );
        assert!(!resume_needs_transcript(Zcode));
        assert!(flags_only(Zcode, false, false, Some("  "))
            .unwrap()
            .is_empty());
        let err = flags_only(Zcode, true, false, Some("glm-5.3"))
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("\"glm-5.3\"") && err.contains("/model") && err.contains("ZCode"),
            "{err}"
        );
        assert!(!prompt_in_argv(Zcode));
        let err = launch_args(Zcode, false, false, None, "fix it", None, "x").unwrap_err();
        assert!(err.to_string().contains("no prompt in argv"), "{err}");
        assert!(effort_args(Zcode, proto::ChatEffort::High).is_err());
    }

    /// ZCode 3.14.4 exits on `--mode plan` ("Supported modes: build, edit, yolo").
    #[test]
    fn zcode_planning_is_refused_by_name_and_listed_for_the_planning_control() {
        use proto::AgentKind::*;
        let err = flags_only(Zcode, false, true, None)
            .expect_err("ZCode has no read-only planning flag")
            .to_string();
        assert!(
            err.contains("Zcode") && err.contains("read-only planning") && err.contains("/plan"),
            "{err}"
        );
        let listed: Vec<_> = planning_refusals()
            .into_iter()
            .map(|r| (r.agent, r.reason))
            .collect();
        assert_eq!(listed.iter().map(|(a, _)| *a).collect::<Vec<_>>(), [Zcode]);
        for agent in [Claude, Codex, Antigravity, Opencode, Zcode] {
            let refused = flags_only(agent, false, true, None).err();
            match listed.iter().find(|(a, _)| *a == agent) {
                Some((_, reason)) => {
                    let err = refused.expect("a listed agent is refused").to_string();
                    assert!(err.contains(reason.as_str()), "{err}");
                }
                None => assert!(refused.is_none(), "{agent:?}: {refused:?}"),
            }
        }
    }

    #[test]
    fn a_zcode_routine_runs_with_full_access_and_refuses_accept_edits_by_name() {
        use proto::AgentKind::Zcode;
        let (argv, approval) = routine_argv(
            Zcode,
            None,
            None,
            proto::ChatPermissionMode::BypassPermissions,
        )
        .expect("an isolated full-access routine runs ZCode");
        assert_eq!(argv, ["zcode", "--mode", "yolo"]);
        assert_eq!(approval, ApprovalMode::Bypass);
        let err = routine_argv(Zcode, None, None, proto::ChatPermissionMode::AcceptEdits)
            .expect_err("edit mode blocks on shell approvals");
        assert!(
            err.to_string()
                .contains("agent Zcode has no bounded accept-edits mode"),
            "{err}"
        );
    }

    #[test]
    fn the_listed_engine_refusals_are_exactly_what_routine_argv_refuses() {
        use proto::AgentKind::*;
        use proto::ChatPermissionMode::*;
        let listed: Vec<_> = routine_engine_refusals()
            .into_iter()
            .map(|r| (r.engine, r.permission_mode, r.reason))
            .collect();
        let pairs: Vec<_> = listed.iter().map(|(e, m, _)| (*e, *m)).collect();
        assert_eq!(pairs, [(Opencode, AcceptEdits), (Zcode, AcceptEdits)]);
        for engine in [Claude, Codex, Antigravity, Opencode, Zcode] {
            for mode in [AcceptEdits, BypassPermissions] {
                let refused = routine_argv(engine, None, None, mode).err();
                match listed.iter().find(|(e, m, _)| (*e, *m) == (engine, mode)) {
                    Some((_, _, reason)) => {
                        let err = refused.expect("a listed pair is refused").to_string();
                        assert!(err.contains(reason.as_str()), "{err}");
                    }
                    None => assert!(refused.is_none(), "{engine:?} {mode:?}: {refused:?}"),
                }
            }
        }
    }

    #[test]
    fn prompt_text_points_at_a_file_once_the_prompt_outgrows_argv() {
        let dir = tempfile::tempdir().unwrap();
        let (text, file) = prompt_text("short", Some(dir.path()), "a b").unwrap();
        assert_eq!((text.as_str(), file), ("short", None));
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        let (text, file) = prompt_text(&long, Some(dir.path()), "a b").unwrap();
        let (path, contents) = file.expect("a file for a long prompt");
        assert_eq!(path.parent(), Some(dir.path()));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("prompt-a-b-"));
        assert_eq!(contents, long);
        assert!(text.contains(&path.display().to_string()), "{text}");
    }

    #[test]
    fn a_prompt_file_instruction_names_a_plain_path() {
        let dir = tempfile::tempdir().unwrap();
        // Spawn briefs live under the canonicalised workspace, which on Windows
        // is a `\\?\` verbatim path the child must never be told to read.
        #[cfg(windows)]
        let dir = std::fs::canonicalize(dir.path()).unwrap();
        #[cfg(not(windows))]
        let dir = dir.path().to_path_buf();
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        let (stub, file) = prompt_text(&long, Some(&dir), "spawned").unwrap();
        let (path, _) = file.expect("a long brief becomes a file");
        assert!(
            !stub.contains(r"\\?\"),
            "the instruction names a verbatim path: {stub}"
        );
        #[cfg(windows)]
        let plain = crate::paths::windows_command_path(&path);
        #[cfg(not(windows))]
        let plain = path.clone();
        assert!(
            stub.contains(&plain.display().to_string()),
            "the instruction must name the plain path: {stub}"
        );
    }

    #[test]
    fn a_claude_child_rules_allow_reading_exactly_its_brief_file() {
        let dir = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let dir = std::fs::canonicalize(dir.path()).unwrap();
        #[cfg(not(windows))]
        let dir = dir.path().to_path_buf();
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        let (_, file) = prompt_text(&long, Some(&dir), "spawned").unwrap();
        let (path, _) = file.expect("a long brief becomes a file");
        let flag = child_permission_args(proto::AgentKind::Claude, Some(&path))
            .into_iter()
            .next()
            .expect("a Claude child carries one permission flag");
        let rules = flag.trim_start_matches("--allowedTools=");
        let read: Vec<&str> = rules
            .split(',')
            .filter(|r| r.starts_with("Read("))
            .collect();
        assert_eq!(read.len(), 1, "exactly one Read rule: {flag}");
        let rule = read[0];
        assert!(
            rule.starts_with("Read(//"),
            "the Read rule must be absolute: {rule}"
        );
        assert!(
            !rule.contains('*') && !rule.contains(r"\\?\"),
            "the Read rule must name exactly one plain file: {rule}"
        );
        let name = path.file_name().and_then(|n| n.to_str()).unwrap();
        assert!(rule.contains(name), "the Read rule names the brief: {rule}");
        for tool in [
            "mcp__houston__pane_submit",
            "mcp__houston__pane_report",
            "mcp__houston__pane_reply",
            "mcp__houston__pane_message",
            "mcp__houston__pane_wait",
            "mcp__houston__pane_deny",
            "mcp__houston__pane_escalate",
        ] {
            assert!(rules.split(',').any(|r| r == tool), "{tool} lost: {flag}");
        }
    }

    #[test]
    fn a_child_without_a_brief_keeps_the_dialogue_rules_alone() {
        use proto::AgentKind::*;
        assert_eq!(
            child_permission_args(Claude, None),
            dialogue_permission_args(Claude)
        );
        for kind in [Codex, Antigravity, Opencode, Zcode] {
            assert!(child_permission_args(kind, None).is_empty());
            let brief = Path::new("/tmp/prompt-x.md");
            assert!(child_permission_args(kind, Some(brief)).is_empty());
            assert!(brief_read_rule(kind, Some(brief)).is_none());
        }
    }

    #[cfg(windows)]
    #[test]
    fn claude_brief_read_rule_uses_claudes_posix_absolute_form() {
        let rule = brief_read_rule(
            proto::AgentKind::Claude,
            Some(Path::new(
                r"\\?\C:\dev\houston\.houston\orchestration\prompts\prompt-spawned-01.md",
            )),
        )
        .unwrap();
        assert_eq!(
            rule,
            "Read(//c/dev/houston/.houston/orchestration/prompts/prompt-spawned-01.md)"
        );
        let plain = brief_read_rule(
            proto::AgentKind::Claude,
            Some(Path::new(r"C:\dev\prompt-x.md")),
        )
        .unwrap();
        assert_eq!(plain, "Read(//c/dev/prompt-x.md)");
    }

    #[cfg(not(windows))]
    #[test]
    fn claude_brief_read_rule_uses_the_double_slash_absolute_form() {
        let rule = brief_read_rule(
            proto::AgentKind::Claude,
            Some(Path::new("/home/u/prompt-x.md")),
        )
        .unwrap();
        assert_eq!(rule, "Read(//home/u/prompt-x.md)");
        assert_eq!(brief_read_rule(proto::AgentKind::Claude, None), None);
    }

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
        for kind in [Claude, Codex, Antigravity] {
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
        assert_eq!(auto_mode_args(Opencode).unwrap(), vec!["--auto"]);
        assert_eq!(auto_mode_args(Cursor), None);
        assert_eq!(auto_mode_args(Grok), None);
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
        for kind in [Codex, Antigravity, Opencode, Shell] {
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
            proto::AgentKind::Opencode,
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
        for kind in [Claude, Codex, Antigravity, Opencode, Shell] {
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
            ApprovalMode::Plan,
            ApprovalMode::AcceptEdits,
        ] {
            assert_eq!(ApprovalMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(
            ApprovalMode::AcceptEdits.args(proto::AgentKind::Claude),
            Some(vec!["--permission-mode".into(), "acceptEdits".into()])
        );
        assert_eq!(
            ApprovalMode::AcceptEdits.args(proto::AgentKind::Codex),
            None
        );
        assert_eq!(ApprovalMode::parse("bogus"), None);
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
        for expected in ["claude", "codex", "antigravity", "opencode", "zcode"] {
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
            proto::AgentKind::Opencode,
            true,
            true,
            None,
            "p",
            Some(dir),
            "x",
        )
        .unwrap();
        assert!(!a.iter().any(|f| f == "--auto"), "opencode emitted --auto");
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
        assert_eq!(path.parent(), Some(dir.as_path()));
        assert!(path
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("prompt-builder-1-"));
        assert!(args[0].contains("Read the file"));
        assert!(args[0].contains(&path.display().to_string()));
    }

    #[test]
    fn retired_providers_are_refused_by_name_at_every_launch_entry_point() {
        use proto::AgentKind::{Cursor, Grok};
        let dir = Path::new("/tmp/scope");
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        for (kind, name) in [(Cursor, "cursor"), (Grok, "grok")] {
            let expected = format!(
                "{name} is no longer a supported provider: Houston recognises it but cannot \
                 launch it; close this pane or choose claude, codex, antigravity, opencode or zcode"
            );
            let errors = [
                launch_args(kind, false, false, None, "p", Some(dir), "x").unwrap_err(),
                launch_args(kind, false, false, None, "", None, "x").unwrap_err(),
                launch_args(kind, false, false, None, &long, None, "x").unwrap_err(),
                flags_only(kind, true, false, None).unwrap_err(),
                routine_argv(
                    kind,
                    None,
                    None,
                    proto::ChatPermissionMode::BypassPermissions,
                )
                .unwrap_err(),
                effort_args(kind, proto::ChatEffort::High).unwrap_err(),
                worktree_trust_args(kind, dir).unwrap_err(),
                ensure_launchable(kind).unwrap_err(),
            ];
            for err in errors {
                assert_eq!(err.to_string(), expected);
            }
            assert_eq!(auto_approve_args(kind), None);
            assert!(!SessionLaunchSelections::supports(kind));
        }
        assert_eq!(retired_provider_refusal(proto::AgentKind::Claude), None);
    }

    #[test]
    fn long_prompt_without_a_file_dir_is_refused_by_name() {
        let long = "x".repeat(PROMPT_FILE_THRESHOLD + 1);
        let err = launch_args(
            proto::AgentKind::Codex,
            false,
            false,
            None,
            &long,
            None,
            "x",
        )
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
        let (path, contents) = file.expect("multiline prompt must go to a file");
        assert_eq!(contents, "line one\r\nline two");
        assert!(args[0].contains("Read the file"));
        assert!(args[0].contains(&path.display().to_string()));
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

#[cfg(test)]
mod worktree_trust_tests {
    use super::*;

    #[test]
    fn k6_codex_trust_uses_inline_projects_for_dotted_paths() {
        let root = tempfile::tempdir().unwrap();
        let path = root
            .path()
            .join("project.with.dots/.houston/worktrees/child");
        let args = worktree_trust_args(proto::AgentKind::Codex, &path).unwrap();
        assert_eq!(args[0], "-c");
        assert!(args[1].starts_with("projects={"));
        let parsed: toml::Value = args[1].parse().unwrap();
        assert_eq!(
            parsed["projects"][path.display().to_string()]["trust_level"].as_str(),
            Some("trusted")
        );
    }
}
