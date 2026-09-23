use anyhow::{anyhow, bail, Context, Result};
use houston_protocol as proto;
use std::path::{Path, PathBuf};

pub const PROVIDERS: [proto::AgentKind; 5] = [
    proto::AgentKind::Codex,
    proto::AgentKind::Opencode,
    proto::AgentKind::Cursor,
    proto::AgentKind::Grok,
    proto::AgentKind::Antigravity,
];

#[derive(Debug, Clone)]
pub struct ConfigHome {
    pub home: PathBuf,
    pub xdg_config: Option<PathBuf>,
}

impl ConfigHome {
    pub fn from_env() -> Result<Self> {
        #[cfg(unix)]
        let raw = std::env::var("HOME");
        #[cfg(windows)]
        let raw = match std::env::var("HOME") {
            Ok(h) if !h.trim().is_empty() => Ok(h),
            _ => std::env::var("USERPROFILE"),
        };
        let home = raw
            .ok()
            .filter(|h| !h.trim().is_empty())
            .ok_or_else(|| anyhow!("HOME is unset or empty — cannot locate a CLI's config dir"))?;
        let xdg = std::env::var("XDG_CONFIG_HOME")
            .ok()
            .filter(|d| !d.trim().is_empty())
            .map(PathBuf::from);
        Ok(Self {
            home: PathBuf::from(home),
            xdg_config: xdg,
        })
    }

    pub(crate) fn config_dir(&self) -> PathBuf {
        self.xdg_config
            .clone()
            .unwrap_or_else(|| self.home.join(".config"))
    }
}

pub fn config_path(provider: proto::AgentKind, home: &ConfigHome) -> Result<PathBuf> {
    Ok(match provider {
        proto::AgentKind::Codex => home.home.join(".codex").join("hooks.json"),
        proto::AgentKind::Cursor => home.home.join(".cursor").join("hooks.json"),
        proto::AgentKind::Opencode => home
            .config_dir()
            .join("opencode")
            .join("plugins")
            .join(PLUGIN_FILE),
        proto::AgentKind::Grok => home.home.join(".grok").join("hooks").join(GROK_HOOKS_FILE),
        proto::AgentKind::Antigravity => home.home.join(".gemini").join("config").join("hooks.json"),
        other => bail!(
            "{other:?} has no hook installer here (expected codex, opencode, cursor, grok or antigravity; \
             Claude Code installs per workspace via claude_hooks.rs)"
        ),
    })
}

const PLUGIN_FILE: &str = "houston-notify.js";

const GROK_HOOKS_FILE: &str = "houston.json";

pub fn install(
    provider: proto::AgentKind,
    home: &ConfigHome,
    launcher: &Path,
    sentinel: &str,
) -> Result<PathBuf> {
    let path = config_path(provider, home)?;
    let mut commands: Vec<(&'static str, String)> = crate::agent_events::events_for(provider)
        .iter()
        .map(|(event, _)| (*event, hook_command(launcher, provider, event, sentinel)))
        .collect();
    if commands.is_empty() {
        bail!(
            "{provider:?} has no event mapping in agent_events — an installer without a \
             taxonomy row would deliver events nothing can read"
        );
    }
    if provider == proto::AgentKind::Codex {
        commands.extend(
            crate::agent_events::CODEX_CORRELATION_EVENTS
                .iter()
                .map(|event| (*event, hook_command(launcher, provider, event, sentinel))),
        );
    }
    if provider == proto::AgentKind::Opencode {
        commands.extend(
            crate::agent_events::OPENCODE_CORRELATION_EVENTS
                .iter()
                .map(|event| (*event, hook_command(launcher, provider, event, sentinel))),
        );
    }
    if provider == proto::AgentKind::Grok {
        commands.extend(
            crate::agent_events::GROK_CORRELATION_EVENTS
                .iter()
                .map(|event| (*event, hook_command(launcher, provider, event, sentinel))),
        );
    }
    if provider == proto::AgentKind::Cursor {
        commands.extend(
            crate::agent_events::CURSOR_CORRELATION_EVENTS
                .iter()
                .map(|event| (*event, hook_command(launcher, provider, event, sentinel))),
        );
    }
    if provider == proto::AgentKind::Antigravity {
        commands.extend(
            crate::agent_events::ANTIGRAVITY_CORRELATION_EVENTS
                .iter()
                .map(|event| (*event, hook_command(launcher, provider, event, sentinel))),
        );
    }
    match provider {
        proto::AgentKind::Codex => codex_install(&path, &commands, sentinel)?,
        proto::AgentKind::Cursor => cursor_install(&path, &commands, sentinel)?,
        proto::AgentKind::Opencode => opencode_install(&path, &commands, sentinel)?,
        proto::AgentKind::Grok => grok_install(&path, &commands, sentinel, proto::AgentKind::Grok)?,
        proto::AgentKind::Antigravity => antigravity_install(&path, &commands, sentinel)?,
        other => bail!("{other:?} has no hook installer here"),
    }
    Ok(path)
}

pub fn uninstall(provider: proto::AgentKind, home: &ConfigHome, sentinel: &str) -> Result<bool> {
    let path = config_path(provider, home)?;
    match provider {
        proto::AgentKind::Codex => codex_uninstall(&path, sentinel),
        proto::AgentKind::Cursor => cursor_uninstall(&path, sentinel),
        proto::AgentKind::Opencode => opencode_uninstall(&path, sentinel),
        proto::AgentKind::Grok => grok_uninstall(&path, sentinel),
        proto::AgentKind::Antigravity => antigravity_uninstall(&path, sentinel),
        other => bail!("{other:?} has no hook installer here"),
    }
}

pub fn is_installed(provider: proto::AgentKind, home: &ConfigHome, sentinel: &str) -> bool {
    let Ok(path) = config_path(provider, home) else {
        return false;
    };
    let Ok(text) = std::fs::read_to_string(&path) else {
        return false;
    };
    match provider {
        proto::AgentKind::Codex | proto::AgentKind::Cursor | proto::AgentKind::Grok => {
            hooks_json_commands(&text)
                .iter()
                .any(|c| has_sentinel(c, sentinel))
        }
        proto::AgentKind::Antigravity => antigravity_is_installed(&path, sentinel),
        proto::AgentKind::Opencode => has_sentinel(&text, sentinel),
        _ => false,
    }
}

// Guarded like claude_hooks::hook_command, since Codex/OpenCode/Cursor/Grok
// all run this through a shell. Codex's Windows arm builds its own argv
// directly and never reaches here — unguarded by necessity, not oversight.
fn hook_command(
    launcher: &Path,
    provider: proto::AgentKind,
    event: &str,
    sentinel: &str,
) -> String {
    crate::claude_hooks::guard_launcher_exec(
        launcher,
        &format!(
            "hook {event} --agent {} {sentinel}",
            provider_slug(provider)
        ),
    )
}

pub fn provider_slug(provider: proto::AgentKind) -> &'static str {
    match provider {
        proto::AgentKind::Claude => "claude",
        proto::AgentKind::Codex => "codex",
        proto::AgentKind::Antigravity => "antigravity",
        proto::AgentKind::Opencode => "opencode",
        proto::AgentKind::Cursor => "cursor",
        proto::AgentKind::Droid => "droid",
        proto::AgentKind::Copilot => "copilot",
        proto::AgentKind::Aider => "aider",
        proto::AgentKind::Grok => "grok",
        proto::AgentKind::Shell => "shell",
        proto::AgentKind::Ssh => "ssh",
        proto::AgentKind::Custom => "custom",
    }
}

pub fn provider_from_slug(slug: &str) -> Result<proto::AgentKind> {
    PROVIDERS
        .iter()
        .chain(std::iter::once(&proto::AgentKind::Claude))
        .copied()
        .find(|p| provider_slug(*p) == slug)
        .ok_or_else(|| {
            anyhow!(
                "unknown --agent {slug:?} (expected one of: claude, codex, opencode, cursor, grok, antigravity)"
            )
        })
}

// Token-exact, never `contains`: the release sentinel is a prefix of every
// channel's, so a substring test would let release claim (and evict) dev's
// entry — the same trap claude_hooks::command_has_sentinel avoids.
fn has_sentinel(text: &str, sentinel: &str) -> bool {
    text.split(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ',' | '[' | ']' | ';'))
        .any(|t| t == sentinel)
}

fn ensure_parent(path: &Path) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("creating {} for a hook install", dir.display()))?;
    }
    Ok(())
}

fn read_to_string_or_empty(path: &Path) -> Result<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

// Carries the sentinel, so one channel's uninstall never restores a line
// another channel parked.
fn parked_marker(sentinel: &str) -> String {
    format!("# {sentinel} parked-user-notify")
}

fn is_notify_line(line: &str) -> bool {
    let t = line.trim_start();
    t.strip_prefix("notify")
        .map(|rest| rest.trim_start().starts_with('='))
        .unwrap_or(false)
}

fn is_commented(line: &str) -> bool {
    line.trim_start().starts_with('#')
}

fn opens_unclosed_array(line: &str) -> bool {
    let mut depth = 0i32;
    let mut in_string = false;
    let mut escaped = false;
    for c in line.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match c {
            '\\' => escaped = true,
            '"' => in_string = !in_string,
            '[' if !in_string => depth += 1,
            ']' if !in_string => depth -= 1,
            '#' if !in_string => break,
            _ => {}
        }
    }
    depth > 0
}

fn codex_install(path: &Path, commands: &[(&str, String)], sentinel: &str) -> Result<()> {
    codex_park_notify(&codex_config_toml_path(path), sentinel)?;
    grok_install(path, commands, sentinel, proto::AgentKind::Codex)
}

fn codex_config_toml_path(hooks_json: &Path) -> PathBuf {
    hooks_json
        .parent()
        .map(|dir| dir.join("config.toml"))
        .unwrap_or_else(|| PathBuf::from("config.toml"))
}

fn codex_park_notify(path: &Path, sentinel: &str) -> Result<()> {
    let text = read_to_string_or_empty(path)?;
    if text.is_empty() {
        return Ok(());
    }
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let before = lines.clone();

    lines.retain(|l| !(is_notify_line(l) && has_sentinel(l, sentinel) && !is_parked(l, sentinel)));

    if let Some(i) = lines
        .iter()
        .position(|l| is_notify_line(l) && !is_commented(l))
    {
        if opens_unclosed_array(&lines[i]) {
            bail!(
                "{}: line {} is a multi-line `notify` array, which Houston will not rewrite. \
                 Houston needs `notify` to be a single line (or absent) so it can park it and \
                 restore it later. Collapse it onto one line, or remove it, then install again.",
                path.display(),
                i + 1
            );
        }
        lines[i] = format!("# {} {}", lines[i], parked_marker(sentinel));
    }

    if lines == before {
        return Ok(());
    }
    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))
}

fn codex_wake_notify(path: &Path, sentinel: &str) -> Result<bool> {
    let text = read_to_string_or_empty(path)?;
    if text.is_empty() {
        return Ok(false);
    }
    let mut lines: Vec<String> = text.lines().map(str::to_string).collect();
    let marker = parked_marker(sentinel);
    let mut restored = false;
    for line in lines.iter_mut() {
        if !is_parked(line, sentinel) {
            continue;
        }
        let body = line
            .trim_start()
            .trim_start_matches('#')
            .trim_start()
            .trim_end()
            .trim_end_matches(marker.as_str())
            .trim_end()
            .to_string();
        *line = body;
        restored = true;
        break;
    }
    if !restored {
        return Ok(false);
    }
    let mut out = lines.join("\n");
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

fn codex_uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let removed_hooks = grok_uninstall(path, sentinel)?;
    let restored = codex_wake_notify(&codex_config_toml_path(path), sentinel)?;
    Ok(removed_hooks || restored)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CodexHookTrust {
    SomeTrusted,
    NotConfirmed,
    NoConfig,
}

pub fn codex_trust_status(home: &ConfigHome) -> CodexHookTrust {
    let path = home.home.join(".codex").join("config.toml");
    let Ok(text) = std::fs::read_to_string(&path) else {
        return CodexHookTrust::NoConfig;
    };
    let Ok(root) = text.parse::<toml::Value>() else {
        return CodexHookTrust::NoConfig;
    };
    match root.get("hooks").and_then(|h| h.get("state")) {
        Some(toml::Value::Table(t)) if !t.is_empty() => CodexHookTrust::SomeTrusted,
        _ => CodexHookTrust::NotConfirmed,
    }
}

pub(crate) fn toml_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn is_parked(line: &str, sentinel: &str) -> bool {
    is_commented(line) && line.contains(&parked_marker(sentinel))
}

fn cursor_install(path: &Path, commands: &[(&str, String)], sentinel: &str) -> Result<()> {
    let text = read_to_string_or_empty(path)?;
    let mut root: serde_json::Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).with_context(|| {
            format!(
                "{} is not valid JSON — refusing to overwrite it",
                path.display()
            )
        })?
    };
    let obj = root.as_object_mut().ok_or_else(|| {
        anyhow!(
            "{}: expected a JSON object at the top level, found {}",
            path.display(),
            json_shape_of(&text)
        )
    })?;
    obj.entry("version".to_string())
        .or_insert_with(|| serde_json::json!(CURSOR_HOOKS_VERSION));
    match obj.get("hooks") {
        None => {
            obj.insert("hooks".to_string(), serde_json::json!({}));
        }
        Some(h) if h.is_object() => {}
        Some(h) => bail!(
            "{}: \"hooks\" is {}, expected an object",
            path.display(),
            json_shape(h)
        ),
    }
    let hooks = obj
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .expect("hooks was just ensured to be an object");
    for (event, command) in commands {
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("{}: hooks.{event} is not an array", path.display()))?;
        arr.retain(|e| !entry_is_ours(e, sentinel));
        arr.push(serde_json::json!({ "command": command }));
    }

    ensure_parent(path)?;
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn entry_is_ours(entry: &serde_json::Value, sentinel: &str) -> bool {
    entry
        .get("command")
        .and_then(|c| c.as_str())
        .is_some_and(|c| has_sentinel(c, sentinel))
}

fn hooks_json_commands(text: &str) -> Vec<String> {
    let Ok(root) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(hooks) = root.get("hooks").and_then(|h| h.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entries in hooks.values().filter_map(|v| v.as_array()) {
        for e in entries {
            if let Some(c) = e.get("command").and_then(|c| c.as_str()) {
                out.push(c.to_string());
            }
            if let Some(nested) = e.get("hooks").and_then(|h| h.as_array()) {
                for h in nested {
                    if let Some(c) = h.get("command").and_then(|c| c.as_str()) {
                        out.push(c.to_string());
                    }
                }
            }
        }
    }
    out
}

fn json_shape_of(text: &str) -> &'static str {
    serde_json::from_str::<serde_json::Value>(text)
        .map(|v| json_shape(&v))
        .unwrap_or("unparseable")
}

const CURSOR_HOOKS_VERSION: u32 = 1;

fn cursor_uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let text = read_to_string_or_empty(path)?;
    if text.trim().is_empty() {
        return Ok(false);
    }
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(false);
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(false);
    };
    let mut removed = false;
    let mut empties = Vec::new();
    for (event, value) in hooks.iter_mut() {
        let Some(arr) = value.as_array_mut() else {
            continue;
        };
        let before = arr.len();
        arr.retain(|e| {
            !e.get("command")
                .and_then(|c| c.as_str())
                .is_some_and(|c| has_sentinel(c, sentinel))
        });
        if arr.len() != before {
            removed = true;
        }
        if arr.is_empty() {
            empties.push(event.clone());
        }
    }
    if !removed {
        return Ok(false);
    }
    for event in empties {
        hooks.remove(&event);
    }
    if hooks.is_empty() {
        obj.remove("hooks");
    }
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

fn json_shape(v: &serde_json::Value) -> &'static str {
    match v {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

fn opencode_plugin_source(commands: &[(&str, String)], sentinel: &str) -> String {
    let cmd_entries: Vec<String> = commands
        .iter()
        .map(|(event, command)| format!("    {}: {},", js_string(event), js_string(command)))
        .collect();
    format!(
        "// Installed by Houston ({sentinel}). Houston rewrites this file on install and\n\
         // deletes it on uninstall — edit it and Houston will leave it alone instead.\n\
         export const HoustonNotify = async ({{ $, client }}) => {{\n\
         \x20 const CMDS = {{\n\
         {cmd_entries}\n\
         \x20 }}\n\
         \x20 const parents = new Map()\n\
         \x20 const run = async (name, payload) => {{\n\
         \x20   const cmd = CMDS[name]\n\
         \x20   if (!cmd) return\n\
         \x20   const json = JSON.stringify(payload ?? {{}})\n\
         \x20   try {{ await $`printf '%s' ${{json}} | sh -c ${{cmd}}`.quiet() }} catch {{}}\n\
         \x20 }}\n\
         \x20 const parentOf = async (id) => {{\n\
         \x20   if (parents.has(id)) return parents.get(id)\n\
         \x20   try {{\n\
         \x20     const info = await client.session.get({{ path: {{ id }} }})\n\
         \x20     const parentID = info?.data?.parentID ?? null\n\
         \x20     parents.set(id, parentID)\n\
         \x20     return parentID\n\
         \x20   }} catch {{ return null }}\n\
         \x20 }}\n\
         \x20 const lastAssistantText = async (id) => {{\n\
         \x20   try {{\n\
         \x20     const res = await client.session.messages({{ path: {{ id }} }})\n\
         \x20     const messages = res?.data ?? []\n\
         \x20     for (let i = messages.length - 1; i >= 0; i--) {{\n\
         \x20       const m = messages[i]\n\
         \x20       if ((m?.info?.role ?? \"\") !== \"assistant\") continue\n\
         \x20       const parts = m?.parts ?? []\n\
         \x20       const text = parts.filter((p) => p?.type === \"text\").map((p) => p?.text ?? \"\").join(\"\")\n\
         \x20       if (text) return text\n\
         \x20     }}\n\
         \x20   }} catch {{}}\n\
         \x20   return \"\"\n\
         \x20 }}\n\
         \x20 return {{\n\
         \x20   event: async ({{ event }}) => {{\n\
         \x20     try {{\n\
         \x20       const t = event?.type ?? \"\"\n\
         \x20       const p = event?.properties ?? {{}}\n\
         \x20       if (t === \"session.created\") {{\n\
         \x20         const id = p?.info?.id\n\
         \x20         const parentID = p?.info?.parentID ?? null\n\
         \x20         if (id) parents.set(id, parentID)\n\
         \x20         if (parentID) return\n\
         \x20         await run(t, {{ session_id: id ?? \"\" }})\n\
         \x20         return\n\
         \x20       }}\n\
         \x20       if (t === \"message.updated\") {{\n\
         \x20         if ((p?.info?.role ?? \"\") !== \"user\") return\n\
         \x20         const msgId = p?.info?.sessionID ?? \"\"\n\
         \x20         if (await parentOf(msgId)) return\n\
         \x20         await run(t, {{ session_id: msgId, prompt_id: p?.info?.id ?? \"\" }})\n\
         \x20         return\n\
         \x20       }}\n\
         \x20       if (t === \"session.status\") {{\n\
         \x20         const id = p?.sessionID ?? \"\"\n\
         \x20         if (await parentOf(id)) return\n\
         \x20         const status = p?.status?.type ?? \"\"\n\
         \x20         if (status === \"busy\" || status === \"retry\") {{\n\
         \x20           await run(t, {{ session_id: id }})\n\
         \x20         }} else if (status === \"idle\") {{\n\
         \x20           const last = await lastAssistantText(id)\n\
         \x20           await run(\"session.idle\", {{ session_id: id, last_assistant_message: last }})\n\
         \x20         }}\n\
         \x20         return\n\
         \x20       }}\n\
         \x20       if (t === \"permission.asked\" || t === \"permission.updated\" || t === \"permission.replied\") {{\n\
         \x20         const bits = [p?.permission].concat(Array.isArray(p?.patterns) ? p.patterns : [])\n\
         \x20         const message = bits.filter(Boolean).join(\" \")\n\
         \x20         await run(t, {{ session_id: p?.sessionID ?? \"\", request_id: p?.id ?? p?.requestID ?? \"\", message }})\n\
         \x20         return\n\
         \x20       }}\n\
         \x20       if (t === \"question.asked\" || t === \"question.replied\" || t === \"question.rejected\" || t === \"question.v2.asked\" || t === \"question.v2.replied\" || t === \"question.v2.rejected\") {{\n\
         \x20         const message = (p?.questions ?? []).map((q) => q?.question ?? \"\").filter(Boolean).join(\"; \")\n\
         \x20         await run(t, {{ session_id: p?.sessionID ?? \"\", request_id: p?.id ?? p?.requestID ?? \"\", message }})\n\
         \x20         return\n\
         \x20       }}\n\
         \x20       if (t === \"session.error\") {{\n\
         \x20         const id = p?.sessionID ?? \"\"\n\
         \x20         if (!id || await parentOf(id)) return\n\
         \x20         const message = p?.error?.data?.message ?? \"Session error\"\n\
         \x20         await run(t, {{ session_id: id, message }})\n\
         \x20         return\n\
         \x20       }}\n\
         \x20       if (t === \"session.idle\") {{\n\
         \x20         const id = p?.sessionID ?? \"\"\n\
         \x20         const parentID = await parentOf(id)\n\
         \x20         if (parentID) {{ await run(\"SubagentStop\", {{ session_id: id }}); return }}\n\
         \x20         const last = await lastAssistantText(id)\n\
         \x20         await run(t, {{ session_id: id, last_assistant_message: last }})\n\
         \x20         return\n\
         \x20       }}\n\
         \x20     }} catch {{}}\n\
         \x20   }},\n\
         \x20 }}\n\
         }}\n",
        cmd_entries = cmd_entries.join("\n"),
    )
}

fn js_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

fn opencode_install(path: &Path, commands: &[(&str, String)], sentinel: &str) -> Result<()> {
    if let Ok(existing) = std::fs::read_to_string(path) {
        if !has_sentinel(&existing, sentinel) && !existing.trim().is_empty() {
            bail!(
                "{} exists and carries no Houston marker — refusing to overwrite a file \
                 Houston does not own. Move or delete it, then install again.",
                path.display()
            );
        }
    }
    ensure_parent(path)?;
    std::fs::write(path, opencode_plugin_source(commands, sentinel))
        .with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn opencode_uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let Ok(existing) = std::fs::read_to_string(path) else {
        return Ok(false);
    };
    if !has_sentinel(&existing, sentinel) {
        return Ok(false);
    }
    std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
    Ok(true)
}

fn grok_entry_is_ours(value: &serde_json::Value, sentinel: &str) -> bool {
    if let Some(c) = value.get("command").and_then(|c| c.as_str()) {
        if has_sentinel(c, sentinel) {
            return true;
        }
    }
    value
        .get("hooks")
        .and_then(|h| h.as_array())
        .map(|nested| {
            nested
                .iter()
                .filter_map(|h| h.get("command").and_then(|c| c.as_str()))
                .any(|c| has_sentinel(c, sentinel))
        })
        .unwrap_or(false)
}

fn grok_install(
    path: &Path,
    commands: &[(&str, String)],
    sentinel: &str,
    provider: proto::AgentKind,
) -> Result<()> {
    let text = read_to_string_or_empty(path)?;
    let mut root: serde_json::Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).with_context(|| {
            format!(
                "{} is not valid JSON — refusing to overwrite it",
                path.display()
            )
        })?
    };
    let obj = root.as_object_mut().ok_or_else(|| {
        anyhow!(
            "{}: expected a JSON object at the top level, found {}",
            path.display(),
            json_shape_of(&text)
        )
    })?;
    match obj.get("hooks") {
        None => {
            obj.insert("hooks".to_string(), serde_json::json!({}));
        }
        Some(h) if h.is_object() => {}
        Some(h) => bail!(
            "{}: \"hooks\" is {}, expected an object",
            path.display(),
            json_shape(h)
        ),
    }
    let hooks = obj
        .get_mut("hooks")
        .and_then(|h| h.as_object_mut())
        .expect("hooks was just ensured to be an object");
    for (event, command) in commands {
        let arr = hooks
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("{}: hooks.{event} is not an array", path.display()))?;
        arr.retain(|e| !grok_entry_is_ours(e, sentinel));
        let mut group = serde_json::json!({
            "hooks": [{ "type": "command", "command": command }]
        });
        let matcher = match (provider, *event) {
            (proto::AgentKind::Codex, "PreToolUse") => Some("^request_user_input$"),
            (proto::AgentKind::Codex, "PostToolUse") => Some("*"),
            _ => None,
        };
        if let Some(matcher) = matcher {
            group
                .as_object_mut()
                .expect("hook group is an object")
                .insert("matcher".to_string(), serde_json::json!(matcher));
        }
        arr.push(group);
    }

    ensure_parent(path)?;
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn grok_uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let text = read_to_string_or_empty(path)?;
    if text.trim().is_empty() {
        return Ok(false);
    }
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(false);
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) else {
        return Ok(false);
    };
    let mut removed = false;
    let mut empties = Vec::new();
    for (event, value) in hooks.iter_mut() {
        let Some(arr) = value.as_array_mut() else {
            continue;
        };
        let before = arr.len();
        arr.retain(|e| !grok_entry_is_ours(e, sentinel));
        if arr.len() != before {
            removed = true;
        }
        if arr.is_empty() {
            empties.push(event.clone());
        }
    }
    if !removed {
        return Ok(false);
    }
    for event in empties {
        hooks.remove(&event);
    }
    if hooks.is_empty() {
        obj.remove("hooks");
    }
    if obj.is_empty() {
        std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
        return Ok(true);
    }
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

fn antigravity_install(path: &Path, commands: &[(&str, String)], sentinel: &str) -> Result<()> {
    let text = read_to_string_or_empty(path)?;
    let mut root: serde_json::Value = if text.trim().is_empty() {
        serde_json::json!({})
    } else {
        serde_json::from_str(&text).with_context(|| {
            format!(
                "{} is not valid JSON — refusing to overwrite it",
                path.display()
            )
        })?
    };
    let obj = root.as_object_mut().ok_or_else(|| {
        anyhow!(
            "{}: expected a JSON object at the top level, found {}",
            path.display(),
            json_shape_of(&text)
        )
    })?;

    let group = obj
        .entry("houston".to_string())
        .or_insert_with(|| serde_json::json!({}))
        .as_object_mut()
        .ok_or_else(|| anyhow!("{}: \"houston\" is not an object", path.display()))?;

    let mut emptied = Vec::new();
    for (event, value) in group.iter_mut() {
        let Some(arr) = value.as_array_mut() else {
            continue;
        };
        arr.retain(|e| !grok_entry_is_ours(e, sentinel));
        if arr.is_empty() {
            emptied.push(event.clone());
        }
    }
    for event in emptied {
        group.remove(&event);
    }

    for (event, command) in commands {
        let arr = group
            .entry(event.to_string())
            .or_insert_with(|| serde_json::json!([]))
            .as_array_mut()
            .ok_or_else(|| anyhow!("{}: houston.{event} is not an array", path.display()))?;
        let entry = if matches!(*event, "PreToolUse" | "PostToolUse") {
            serde_json::json!({
                "matcher": ".*",
                "hooks": [{ "type": "command", "command": command }]
            })
        } else {
            serde_json::json!({
                "type": "command",
                "command": command
            })
        };
        arr.push(entry);
    }

    ensure_parent(path)?;
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(())
}

fn antigravity_uninstall(path: &Path, sentinel: &str) -> Result<bool> {
    let text = read_to_string_or_empty(path)?;
    if text.trim().is_empty() {
        return Ok(false);
    }
    let Ok(mut root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return Ok(false);
    };
    let Some(obj) = root.as_object_mut() else {
        return Ok(false);
    };
    let Some(group) = obj.get_mut("houston").and_then(|g| g.as_object_mut()) else {
        return Ok(false);
    };
    let mut removed = false;
    let mut empties = Vec::new();
    for (event, value) in group.iter_mut() {
        if let Some(arr) = value.as_array_mut() {
            let before = arr.len();
            arr.retain(|e| {
                if let Some(cmd) = e.get("command").and_then(|c| c.as_str()) {
                    !has_sentinel(cmd, sentinel)
                } else if let Some(nested) = e.get("hooks").and_then(|h| h.as_array()) {
                    !nested.iter().any(|h| {
                        h.get("command")
                            .and_then(|c| c.as_str())
                            .map(|cmd| has_sentinel(cmd, sentinel))
                            .unwrap_or(false)
                    })
                } else {
                    true
                }
            });
            if arr.len() < before {
                removed = true;
            }
            if arr.is_empty() {
                empties.push(event.clone());
            }
        }
    }
    if !removed {
        return Ok(false);
    }
    for event in empties {
        group.remove(&event);
    }
    if group.is_empty() {
        obj.remove("houston");
    }
    if obj.is_empty() {
        std::fs::remove_file(path).with_context(|| format!("removing {}", path.display()))?;
        return Ok(true);
    }
    let mut out = serde_json::to_string_pretty(&root)?;
    out.push('\n');
    std::fs::write(path, out).with_context(|| format!("writing {}", path.display()))?;
    Ok(true)
}

fn antigravity_is_installed(path: &Path, sentinel: &str) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else {
        return false;
    };
    let Ok(root) = serde_json::from_str::<serde_json::Value>(&text) else {
        return false;
    };
    let Some(group) = root.get("houston").and_then(|g| g.as_object()) else {
        return false;
    };
    for entries in group.values().filter_map(|v| v.as_array()) {
        for e in entries {
            if let Some(c) = e.get("command").and_then(|c| c.as_str()) {
                if has_sentinel(c, sentinel) {
                    return true;
                }
            }
            if let Some(nested) = e.get("hooks").and_then(|h| h.as_array()) {
                for h in nested {
                    if let Some(c) = h.get("command").and_then(|c| c.as_str()) {
                        if has_sentinel(c, sentinel) {
                            return true;
                        }
                    }
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    #[test]
    fn tokenizer_recognizes_every_writer_grammar() {
        let win_launcher = "C:/Users/t/.houston-dev/bin/claude-hook";
        let samples = [
            format!("'{win_launcher}' hook SessionStart --houston-managed=dev"),
            "'/home/t/.houston/bin/claude-hook' hook agent-exited --agent codex --houston-managed".to_string(),
            format!("'{win_launcher}' quota-statusline --houston-managed=dev"),
            format!("notify = [\"{win_launcher}\", \"hook\", \"agent-spawned\", \"--agent\", \"codex\", \"--houston-managed\"]"),
            "echo hello".to_string(),
        ];
        for s in &samples {
            let want = s != "echo hello";
            let got =
                has_sentinel(s, "--houston-managed") || has_sentinel(s, "--houston-managed=dev");
            assert_eq!(got, want, "tokenizer vs writer grammar: {s}");
        }
    }
    use super::*;

    fn home(dir: &tempfile::TempDir) -> ConfigHome {
        ConfigHome {
            home: dir.path().to_path_buf(),
            xdg_config: Some(dir.path().join("xdg")),
        }
    }

    fn launcher() -> PathBuf {
        PathBuf::from("/home/dev/.houston-dev/bin/claude-hook")
    }

    const DEV: &str = "--houston-managed=dev";
    const RELEASE: &str = "--houston-managed";

    fn read(path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_default()
    }

    fn codex_config_toml(h: &ConfigHome) -> PathBuf {
        h.home.join(".codex").join("config.toml")
    }

    #[test]
    fn codex_trust_status_reads_hooks_state() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        assert_eq!(codex_trust_status(&h), CodexHookTrust::NoConfig);

        let toml = codex_config_toml(&h);
        std::fs::create_dir_all(toml.parent().expect("parent")).expect("mkdir");
        std::fs::write(&toml, "model = \"gpt-5\"\n").expect("write");
        assert_eq!(codex_trust_status(&h), CodexHookTrust::NotConfirmed);

        std::fs::write(&toml, "[hooks.state]\n").expect("write");
        assert_eq!(codex_trust_status(&h), CodexHookTrust::NotConfirmed);

        std::fs::write(
            &toml,
            "[hooks.state]\n\"/home/t/.codex/hooks.json:Stop:command:abc\" = \
             { trusted_hash = \"sha256:deadbeef\" }\n",
        )
        .expect("write");
        assert_eq!(codex_trust_status(&h), CodexHookTrust::SomeTrusted);
    }

    #[test]
    fn codex_installs_hooks_json_and_keeps_the_users_own_entries() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Codex, &h).expect("path");
        assert!(path.ends_with(".codex/hooks.json"), "{}", path.display());
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            "{\n  \"hooks\": {\n    \"Stop\": [{\"hooks\": [{\"type\": \"command\", \
             \"command\": \"my-own-hook\"}]}]\n  }\n}\n",
        )
        .expect("write");

        install(proto::AgentKind::Codex, &h, &launcher(), DEV).expect("install");
        let cmds = hooks_json_commands(&read(&path));
        assert!(cmds.iter().any(|c| c == "my-own-hook"), "{cmds:?}");
        assert!(cmds.iter().any(|c| has_sentinel(c, DEV)), "{cmds:?}");
        assert!(is_installed(proto::AgentKind::Codex, &h, DEV));
        let events = crate::agent_events::events_for(proto::AgentKind::Codex);
        assert_eq!(events.len(), 5, "Codex maps lifecycle plus interruption");
        let extra = crate::agent_events::CODEX_CORRELATION_EVENTS.len();
        assert_eq!(cmds.len(), events.len() + extra + 1, "{cmds:?}");
        let root: serde_json::Value =
            serde_json::from_str(&read(&path)).expect("valid Codex hooks JSON");
        assert_eq!(
            root["hooks"]["PreToolUse"][0]["matcher"],
            "^request_user_input$"
        );
        assert_eq!(root["hooks"]["PostToolUse"][0]["matcher"], "*");

        install(proto::AgentKind::Codex, &h, &launcher(), DEV).expect("reinstall");
        assert_eq!(
            hooks_json_commands(&read(&path)).len(),
            events.len() + extra + 1,
            "a reinstall replaces Houston's entries rather than adding a second set"
        );

        assert!(uninstall(proto::AgentKind::Codex, &h, DEV).expect("uninstall"));
        assert_eq!(
            hooks_json_commands(&read(&path)),
            vec!["my-own-hook".to_string()]
        );
        assert!(!is_installed(proto::AgentKind::Codex, &h, DEV));
        assert!(
            !uninstall(proto::AgentKind::Codex, &h, DEV).expect("second uninstall"),
            "a second uninstall removes nothing and says so"
        );
    }

    #[test]
    fn codex_channels_coexist_in_hooks_json() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        install(proto::AgentKind::Codex, &h, &launcher(), RELEASE).expect("release install");
        install(proto::AgentKind::Codex, &h, &launcher(), DEV).expect("dev install");
        assert!(is_installed(proto::AgentKind::Codex, &h, RELEASE));
        assert!(is_installed(proto::AgentKind::Codex, &h, DEV));

        assert!(uninstall(proto::AgentKind::Codex, &h, RELEASE).expect("release uninstall"));
        assert!(!is_installed(proto::AgentKind::Codex, &h, RELEASE));
        assert!(
            is_installed(proto::AgentKind::Codex, &h, DEV),
            "removing release's entries must not touch dev's"
        );
    }

    #[test]
    fn codex_parks_an_active_notify_line_and_wakes_it_on_uninstall() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let toml = codex_config_toml(&h);
        std::fs::create_dir_all(toml.parent().expect("parent")).expect("mkdir");
        let mine = "notify   =  [ 'my-own-notifier',  \"--flag\" ]   # mine";
        std::fs::write(&toml, format!("{mine}\nmodel = \"gpt-5\"\n")).expect("write");

        install(proto::AgentKind::Codex, &h, &launcher(), DEV).expect("install");
        let after = read(&toml);
        assert!(
            after.contains(&format!("# {mine}")),
            "the user's notify is commented out, never deleted:\n{after}"
        );
        assert!(is_installed(proto::AgentKind::Codex, &h, DEV));

        uninstall(proto::AgentKind::Codex, &h, DEV).expect("uninstall");
        let restored = read(&toml);
        assert!(
            restored.lines().any(|l| l == mine),
            "uninstall must wake the parked line exactly as it was:\n{restored}"
        );
        assert!(!restored.contains("houston-managed"));
    }

    #[test]
    fn codex_install_removes_its_own_stale_notify_line_outright() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let toml = codex_config_toml(&h);
        std::fs::create_dir_all(toml.parent().expect("parent")).expect("mkdir");
        let stale = format!("notify = [\"bash\", \"-c\", \"old seam\", \"--\"] {DEV}");
        std::fs::write(&toml, format!("{stale}\nmodel = \"gpt-5\"\n")).expect("write");

        install(proto::AgentKind::Codex, &h, &launcher(), DEV).expect("install");
        let after = read(&toml);
        assert!(!after.contains("old seam"), "{after}");
        assert!(!after.lines().any(is_notify_line), "{after}");
    }

    #[test]
    fn codex_refuses_a_multi_line_notify_array_and_touches_neither_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Codex, &h).expect("path");
        let toml = codex_config_toml(&h);
        std::fs::create_dir_all(toml.parent().expect("parent")).expect("mkdir");
        let original = "notify = [\n  \"bash\",\n  \"-c\",\n  \"echo hi\",\n]\n";
        std::fs::write(&toml, original).expect("write");

        let err = install(proto::AgentKind::Codex, &h, &launcher(), DEV)
            .expect_err("a multi-line notify must be refused, not rewritten");
        let msg = format!("{err:#}");
        assert!(msg.contains("multi-line"), "{msg}");
        assert!(msg.contains("single line"), "{msg}");
        assert!(msg.contains(&toml.display().to_string()), "{msg}");
        assert_eq!(
            read(&toml),
            original,
            "a refusal writes nothing to config.toml"
        );
        assert!(
            !path.exists(),
            "a refusal writes nothing to hooks.json either"
        );
    }

    #[test]
    fn cursor_keeps_the_users_own_hooks_through_install_and_uninstall() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Cursor, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            "{\n  \"version\": 1,\n  \"hooks\": {\n    \"stop\": [{\"command\": \"my-own-hook\"}]\n  }\n}\n",
        )
        .expect("write");

        install(proto::AgentKind::Cursor, &h, &launcher(), DEV).expect("install");
        let cmds = hooks_json_commands(&read(&path));
        assert!(cmds.iter().any(|c| c == "my-own-hook"), "{cmds:?}");
        assert!(cmds.iter().any(|c| has_sentinel(c, DEV)), "{cmds:?}");
        assert!(is_installed(proto::AgentKind::Cursor, &h, DEV));
        let tr_entries = crate::agent_events::events_for(proto::AgentKind::Cursor).len();
        let extra = crate::agent_events::CURSOR_CORRELATION_EVENTS.len();
        assert_eq!(cmds.len(), tr_entries + extra + 1, "{cmds:?}");

        install(proto::AgentKind::Cursor, &h, &launcher(), DEV).expect("reinstall");
        assert_eq!(
            hooks_json_commands(&read(&path)).len(),
            tr_entries + extra + 1,
            "a reinstall replaces Houston's entries rather than adding a second set"
        );

        assert!(uninstall(proto::AgentKind::Cursor, &h, DEV).expect("uninstall"));
        assert_eq!(
            hooks_json_commands(&read(&path)),
            vec!["my-own-hook".to_string()]
        );
        assert!(!is_installed(proto::AgentKind::Cursor, &h, DEV));
    }

    #[test]
    fn cursor_refuses_a_config_it_cannot_parse_rather_than_replacing_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Cursor, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let original = "{ this is not json ";
        std::fs::write(&path, original).expect("write");

        let err = install(proto::AgentKind::Cursor, &h, &launcher(), DEV).expect_err("must refuse");
        assert!(format!("{err:#}").contains("not valid JSON"), "{err:#}");
        assert_eq!(read(&path), original, "a refusal writes nothing");
        assert!(!uninstall(proto::AgentKind::Cursor, &h, DEV).expect("uninstall"));
        assert_eq!(read(&path), original);
    }

    #[test]
    fn grok_installs_one_nested_entry_per_event_and_keeps_the_users_own() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Grok, &h).expect("path");
        assert!(
            path.ends_with(".grok/hooks/houston.json"),
            "{}",
            path.display()
        );
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(
            &path,
            "{\n  \"hooks\": {\n    \"Stop\": [{\"hooks\": [{\"type\": \"command\", \
             \"command\": \"my-own-hook\"}]}]\n  }\n}\n",
        )
        .expect("write");

        install(proto::AgentKind::Grok, &h, &launcher(), DEV).expect("install");
        let cmds = hooks_json_commands(&read(&path));
        assert!(cmds.iter().any(|c| c == "my-own-hook"), "{cmds:?}");
        let events = crate::agent_events::events_for(proto::AgentKind::Grok);
        assert_eq!(events.len(), 4, "Grok maps the full Claude four");
        let extra = crate::agent_events::GROK_CORRELATION_EVENTS.len();
        assert_eq!(cmds.len(), events.len() + extra + 1, "{cmds:?}");
        let root: serde_json::Value =
            serde_json::from_str(&read(&path)).expect("valid JSON after install");
        for (event, _) in events {
            let arr = root["hooks"][event]
                .as_array()
                .unwrap_or_else(|| panic!("hooks.{event} missing: {root}"));
            assert!(
                arr.iter().any(|e| grok_entry_is_ours(e, DEV)),
                "hooks.{event} carries no Houston entry: {root}"
            );
        }
        assert!(is_installed(proto::AgentKind::Grok, &h, DEV));

        install(proto::AgentKind::Grok, &h, &launcher(), DEV).expect("reinstall");
        assert_eq!(
            hooks_json_commands(&read(&path)).len(),
            events.len() + extra + 1,
            "a reinstall replaces Houston's entries rather than adding a second set"
        );

        assert!(uninstall(proto::AgentKind::Grok, &h, DEV).expect("uninstall"));
        assert_eq!(
            hooks_json_commands(&read(&path)),
            vec!["my-own-hook".to_string()],
            "uninstall takes back exactly Houston's own"
        );
        assert!(!is_installed(proto::AgentKind::Grok, &h, DEV));
        assert!(
            !uninstall(proto::AgentKind::Grok, &h, DEV).expect("second uninstall"),
            "a second uninstall removes nothing and says so"
        );
    }

    #[test]
    fn grok_deletes_the_file_it_owns_once_nothing_is_left_in_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = install(proto::AgentKind::Grok, &h, &launcher(), DEV).expect("install");
        assert!(path.exists());
        assert!(uninstall(proto::AgentKind::Grok, &h, DEV).expect("uninstall"));
        assert!(
            !path.exists(),
            "an empty Houston-owned hooks file is removed, not left as {{}}"
        );
    }

    #[test]
    fn grok_refuses_a_config_it_cannot_parse_rather_than_replacing_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Grok, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let original = "{ this is not json ";
        std::fs::write(&path, original).expect("write");

        let err = install(proto::AgentKind::Grok, &h, &launcher(), DEV).expect_err("must refuse");
        assert!(format!("{err:#}").contains("not valid JSON"), "{err:#}");
        assert_eq!(read(&path), original, "a refusal writes nothing");
        assert!(!uninstall(proto::AgentKind::Grok, &h, DEV).expect("uninstall"));
        assert_eq!(read(&path), original);
    }

    #[test]
    fn opencode_writes_a_marked_plugin_and_deletes_only_its_own() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = install(proto::AgentKind::Opencode, &h, &launcher(), DEV).expect("install");
        assert!(
            path.starts_with(dir.path().join("xdg")),
            "{}",
            path.display()
        );
        let src = read(&path);
        assert!(has_sentinel(&src, DEV), "{src}");
        for (event, _) in crate::agent_events::events_for(proto::AgentKind::Opencode) {
            assert!(src.contains(event), "missing arm for {event}:\n{src}");
        }
        assert!(src.contains("\"user\""), "{src}");
        assert!(src.contains("role"), "{src}");
        assert!(is_installed(proto::AgentKind::Opencode, &h, DEV));
        let run_lines: Vec<&str> = src
            .lines()
            .filter(|l| l.contains("$`") && l.contains("sh -c"))
            .collect();
        assert!(!run_lines.is_empty(), "no run() call found:\n{src}");
        for line in run_lines {
            assert!(
                line.contains("printf"),
                "arm risks inheriting the TUI's stdin:\n{line}"
            );
        }
        for event in crate::agent_events::OPENCODE_CORRELATION_EVENTS {
            assert!(src.contains(event), "missing arm for {event}:\n{src}");
        }
        for needle in [
            "parents.set",
            "client.session.get",
            "client.session.messages",
            "last_assistant_message",
            "parentID",
            "request_id",
            "requestID",
        ] {
            assert!(src.contains(needle), "missing {needle}:\n{src}");
        }

        let message_updated_branch = src
            .split("message.updated\") {")
            .nth(1)
            .and_then(|rest| rest.split_once("}\n"))
            .map(|(branch, _)| branch)
            .unwrap_or_default();
        assert!(
            message_updated_branch.contains("parentOf"),
            "message.updated must be gated to the root session, the same as \
             session.idle, or a child's own prompt reopens the parent pane \
             mid-turn:\n{src}"
        );

        assert!(uninstall(proto::AgentKind::Opencode, &h, DEV).expect("uninstall"));
        assert!(!path.exists(), "Houston's own plugin file is removed");
        assert!(!uninstall(proto::AgentKind::Opencode, &h, DEV).expect("second uninstall"));
    }

    #[test]
    fn opencode_leaves_a_file_it_does_not_own_alone_in_both_directions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Opencode, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let mine = "// mine, hand-written\nexport const Whatever = () => {}\n";
        std::fs::write(&path, mine).expect("write");

        let err = install(proto::AgentKind::Opencode, &h, &launcher(), DEV)
            .expect_err("must refuse to overwrite a file Houston does not own");
        assert!(format!("{err:#}").contains("no Houston marker"), "{err:#}");
        assert_eq!(read(&path), mine);

        assert!(!uninstall(proto::AgentKind::Opencode, &h, DEV).expect("uninstall"));
        assert_eq!(read(&path), mine, "and uninstall never deletes it either");
    }

    #[test]
    fn a_file_edited_underneath_us_is_left_alone_rather_than_repaired() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = install(proto::AgentKind::Opencode, &h, &launcher(), DEV).expect("install");
        std::fs::write(&path, "// the user took this over\n").expect("edit");
        assert!(!is_installed(proto::AgentKind::Opencode, &h, DEV));
        assert!(!uninstall(proto::AgentKind::Opencode, &h, DEV).expect("uninstall"));
        assert_eq!(read(&path), "// the user took this over\n");
    }

    #[test]
    fn antigravity_installs_and_uninstalls_hooks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Antigravity, &h).expect("path");

        assert!(!is_installed(proto::AgentKind::Antigravity, &h, DEV));
        install(proto::AgentKind::Antigravity, &h, &launcher(), DEV).expect("install");
        assert!(is_installed(proto::AgentKind::Antigravity, &h, DEV));
        assert!(path.exists());

        let content = read(&path);
        assert!(content.contains("SessionStart"));
        assert!(content.contains("PreInvocation"));
        assert!(content.contains("Stop"));
        assert!(content.contains("antigravity"));
        assert!(content.contains(DEV));
        assert!(!content.contains("PostInvocation"), "{content}");
        let root: serde_json::Value = serde_json::from_str(&content).expect("valid JSON");
        let group = root["houston"].as_object().expect("houston group");
        for tool_event in ["PreToolUse", "PostToolUse"] {
            let entries = group[tool_event]
                .as_array()
                .unwrap_or_else(|| panic!("{tool_event} must be installed: {group:?}"));
            assert_eq!(
                entries[0]["matcher"], ".*",
                "{tool_event} must use the matcher dialect"
            );
            assert!(entries[0]["hooks"][0]["command"]
                .as_str()
                .unwrap()
                .contains(DEV));
        }

        assert!(uninstall(proto::AgentKind::Antigravity, &h, DEV).expect("uninstall"));
        assert!(!is_installed(proto::AgentKind::Antigravity, &h, DEV));
    }

    #[test]
    fn antigravity_install_sweeps_an_event_it_no_longer_maps() {
        let dir = tempfile::tempdir().expect("tempdir");
        let h = home(&dir);
        let path = config_path(proto::AgentKind::Antigravity, &h).expect("path");
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        let stale = format!(
            r#"{{"houston":{{
                 "PostInvocation":[{{"matcher":"*","hooks":[
                   {{"type":"command","command":"old-hook {DEV}"}}]}}],
                 "PostToolUse":[{{"type":"command","command":"someone-elses-hook"}}]
               }}}}"#
        );
        std::fs::write(&path, stale).expect("seed");

        install(proto::AgentKind::Antigravity, &h, &launcher(), DEV).expect("install");

        let root: serde_json::Value =
            serde_json::from_str(&read(&path)).expect("valid JSON after install");
        let group = root["houston"].as_object().expect("houston group");
        assert!(
            !group.contains_key("PostInvocation"),
            "a retired event must not survive an install, matcher-wrapped residue included: \
             {group:?}"
        );
        let post_tool_use = group["PostToolUse"]
            .as_array()
            .expect("PostToolUse must be installed");
        assert!(
            post_tool_use
                .iter()
                .any(|e| e["command"].as_str() == Some("someone-elses-hook")),
            "somebody else's hook is not Houston's to remove: {post_tool_use:?}"
        );
        assert!(
            post_tool_use.iter().any(|e| e["hooks"][0]["command"]
                .as_str()
                .is_some_and(|c| c.contains(DEV))),
            "Houston's own entry must also be there: {post_tool_use:?}"
        );
        assert!(
            group.contains_key("Stop")
                && group.contains_key("PreInvocation")
                && group.contains_key("SessionStart")
                && group.contains_key("PreToolUse")
        );
    }

    #[test]
    fn the_command_names_the_provider_and_its_own_event_name() {
        for provider in PROVIDERS {
            let events = crate::agent_events::events_for(provider);
            assert!(
                !events.is_empty(),
                "{provider:?} has an installer but no event mapping"
            );
            for (event, _) in events {
                let cmd = hook_command(&launcher(), provider, event, DEV);
                assert!(cmd.contains(&format!("hook {event} ")), "{cmd}");
                assert!(
                    cmd.contains(&format!("--agent {}", provider_slug(provider))),
                    "{cmd}"
                );
                assert!(has_sentinel(&cmd, DEV), "{cmd}");
            }
            assert_eq!(
                provider_from_slug(provider_slug(provider)).expect("slug"),
                provider
            );
        }
        let err = provider_from_slug("unknown_provider").expect_err("unknown has no installer");
        assert!(format!("{err:#}").contains("unknown_provider"), "{err:#}");
    }

    #[cfg(unix)]
    #[test]
    #[allow(clippy::disallowed_methods)]
    fn a_hook_command_whose_launcher_is_gone_exits_quietly() {
        use std::os::unix::fs::PermissionsExt;

        let bin = tempfile::tempdir().unwrap();
        let real = bin.path().join("houston-hook");
        std::fs::write(&real, "#!/bin/sh\necho HOOK-RAN\n").unwrap();
        std::fs::set_permissions(&real, std::fs::Permissions::from_mode(0o755)).unwrap();

        let sh = |command: &str| {
            std::process::Command::new("/bin/sh")
                .args(["-c", command])
                .output()
                .unwrap()
        };

        for provider in PROVIDERS {
            let cmd = hook_command(&real, provider, "Stop", DEV);
            let present = sh(&cmd);
            assert!(
                present.status.success(),
                "{provider:?}: a healthy launcher must still run: {present:?}"
            );
            assert!(
                String::from_utf8_lossy(&present.stdout).contains("HOOK-RAN"),
                "{provider:?}: and must actually reach the binary: {present:?}"
            );
        }

        std::fs::remove_file(&real).unwrap();
        for provider in PROVIDERS {
            let cmd = hook_command(&real, provider, "Stop", DEV);
            let gone = sh(&cmd);
            assert!(
                gone.status.success(),
                "{provider:?}: a missing launcher must exit 0, not {:?}",
                gone.status
            );
            assert!(
                gone.stderr.is_empty(),
                "{provider:?}: and say nothing the agent could show as a hook error: {}",
                String::from_utf8_lossy(&gone.stderr)
            );
            assert!(
                gone.stdout.is_empty(),
                "{provider:?}: nor anything the agent could splice into a prompt: {}",
                String::from_utf8_lossy(&gone.stdout)
            );
        }
    }
}
