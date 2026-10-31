//! v1 configs as v1's installers wrote them (whole-file pretty JSON with sorted keys, the
//! Codex trust block and parked `notify`), under a temporary home. Nothing here reads the
//! real home or starts a real agent CLI: `PATH` names a directory the test controls.

use super::Target;
use crate::sys::host_env::HostEnv;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

pub const DEV: &str = "--houston-managed=dev";
pub const RELEASE: &str = "--houston-managed";

pub const OPENCODE_USER_PLUGIN: &str = "export const Mine = async () => ({})\n";

/// The shape v1's Codex registration left: `codex mcp add houston --url ...` and the
/// timeout key v1 then added between its markers.
pub const CODEX_WITH_MCP: &str = "model = \"o3\"\n\
\n\
[mcp_servers.houston]\n\
url = \"http://127.0.0.1:4242/mcp\"\n\
bearer_token_env_var = \"HOUSTON_MCP_TOKEN\"\n\
# >>> houston managed (codex timeout) >>>\n\
tool_timeout_sec = 630\n\
# <<< houston managed (codex timeout) <<<\n\
\n\
[mcp_servers.mine]\n\
command = \"my-server\"\n";

pub const CODEX_WITHOUT_MCP: &str = "model = \"o3\"\n\
\n\
[mcp_servers.mine]\n\
command = \"my-server\"\n";

fn user_hook() -> Value {
    json!({"type": "command", "command": "notify-send mine"})
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    Claude,
    Codex,
    Opencode,
    Antigravity,
    Zcode,
}

pub const PROVIDERS: [Provider; 5] = [
    Provider::Claude,
    Provider::Codex,
    Provider::Opencode,
    Provider::Antigravity,
    Provider::Zcode,
];

pub type Snapshot = BTreeMap<PathBuf, (Vec<u8>, SystemTime)>;

pub struct TestHome {
    dir: tempfile::TempDir,
}

fn channel_of(sentinel: &str) -> Option<&str> {
    sentinel.strip_prefix(RELEASE)?.strip_prefix('=')
}

fn pretty(value: &Value) -> String {
    let mut out = serde_json::to_string_pretty(value).expect("fixture JSON");
    out.push('\n');
    out
}

impl TestHome {
    pub fn new() -> Self {
        let dir = tempfile::tempdir().expect("temporary home");
        std::fs::create_dir_all(dir.path().join("home")).expect("home dir");
        std::fs::create_dir_all(dir.path().join("no-claude")).expect("PATH dir");
        Self { dir }
    }

    pub fn root(&self) -> &Path {
        self.dir.path()
    }

    pub fn home(&self) -> PathBuf {
        self.root().join("home")
    }

    pub fn channel_dir(&self, channel: Option<&str>) -> PathBuf {
        let dir = crate::sys::paths::dir_for(&self.home(), channel);
        std::fs::create_dir_all(&dir).expect("channel dir");
        dir
    }

    pub fn target(&self, channel: Option<&str>) -> Target {
        self.target_with_path(channel, &self.root().join("no-claude"))
    }

    pub fn target_with_path(&self, channel: Option<&str>, path: &Path) -> Target {
        let env = HostEnv::from_pairs([("PATH", path.as_os_str().to_owned())]);
        Target::from_env(&env, &self.home(), channel)
    }

    pub fn read(&self, path: &Path) -> String {
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("reading {}: {e}", path.display()))
    }

    fn write(&self, path: &Path, text: &str) {
        std::fs::create_dir_all(path.parent().expect("parent")).expect("config dir");
        std::fs::write(path, text).expect("write fixture");
    }

    pub fn claude_settings(&self) -> PathBuf {
        self.home().join(".claude").join("settings.json")
    }

    pub fn claude_json(&self) -> PathBuf {
        self.home().join(".claude.json")
    }

    fn codex_hooks(&self) -> PathBuf {
        self.home().join(".codex").join("hooks.json")
    }

    pub fn codex_config(&self) -> PathBuf {
        self.home().join(".codex").join("config.toml")
    }

    pub fn antigravity_mcp(&self) -> PathBuf {
        self.home()
            .join(".gemini")
            .join("config")
            .join("mcp_config.json")
    }

    /// v1's Codex entry (`codex mcp add` plus v1's timeout block) and its marked
    /// Antigravity entry, beside a user's own server in each file; `eol` ends every line.
    pub fn write_shared_mcp_entries(&self, eol: &str) {
        self.write(&self.codex_config(), &CODEX_WITH_MCP.replace('\n', eol));
        let root = json!({"mcpServers": {
            "houston": {
                "serverUrl": "${HOUSTON_MCP_URL}",
                "headers": {"Authorization": "Bearer ${HOUSTON_MCP_TOKEN}"},
                "_houston": "managed",
            },
            "mine": {"serverUrl": "http://localhost:9/mcp"},
        }});
        self.write(&self.antigravity_mcp(), &pretty(&root));
    }

    /// Writes `text` (relative to the home) as a config file.
    pub fn write_file(&self, relative: &str, text: &str) -> PathBuf {
        let path = relative
            .split('/')
            .fold(self.home(), |path, part| path.join(part));
        self.write(&path, text);
        path
    }

    pub fn opencode_plugin(&self) -> PathBuf {
        self.opencode_dir().join("houston-notify.js")
    }

    pub fn opencode_user_plugin(&self) -> PathBuf {
        self.opencode_dir().join("mine.js")
    }

    fn opencode_dir(&self) -> PathBuf {
        self.home().join(".config").join("opencode").join("plugins")
    }

    fn antigravity_hooks(&self) -> PathBuf {
        self.home()
            .join(".gemini")
            .join("config")
            .join("hooks.json")
    }

    fn zcode_files(&self) -> [PathBuf; 2] {
        let dir = self.home().join(".zcode").join("cli");
        [dir.join("setting.json"), dir.join("config.json")]
    }

    fn launcher(&self, sentinel: &str) -> String {
        crate::sys::paths::dir_for(&self.home(), channel_of(sentinel))
            .join("bin")
            .join("claude-hook")
            .display()
            .to_string()
    }

    // The POSIX guard v1 wrapped every shell hook in.
    fn guarded(&self, sentinel: &str, tail: &str) -> String {
        let launcher = self.launcher(sentinel);
        format!("if [ -x '{launcher}' ]; then exec '{launcher}' {tail} {sentinel}; fi")
    }

    fn files(&self, provider: Provider, sentinels: &[&str]) -> Vec<(PathBuf, Option<String>)> {
        match provider {
            Provider::Claude => vec![(self.claude_settings(), Some(self.claude(sentinels)))],
            Provider::Codex => vec![
                (self.codex_hooks(), Some(self.codex_hooks_json(sentinels))),
                (self.codex_config(), Some(self.codex_toml(sentinels))),
            ],
            Provider::Opencode => vec![(
                self.opencode_plugin(),
                sentinels.first().map(|s| {
                    let idle = self.guarded(s, "hook session.idle --agent opencode");
                    format!(
                        "// Installed by Houston ({s}). Houston rewrites this file on install and\n\
                         // deletes it on uninstall — edit it and Houston will leave it alone instead.\n\
                         export const HoustonNotify = async ({{ $, client }}) => {{\n\
                         \x20 const CMDS = {{\n\
                         \x20   \"session.idle\": {idle:?},\n\
                         \x20 }}\n\
                         \x20 return {{}}\n\
                         }}\n"
                    )
                }),
            )],
            Provider::Antigravity => vec![(self.antigravity_hooks(), Some(self.antigravity(sentinels)))],
            Provider::Zcode => self
                .zcode_files()
                .into_iter()
                .map(|path| (path, Some(self.zcode(sentinels))))
                .collect(),
        }
    }

    fn claude(&self, sentinels: &[&str]) -> String {
        let group = |s: &str, event: &str| {
            let command = format!(
                "if [ -z \"${{TR_SESSION:-}}\" ]; then exit 0; fi; {}",
                self.guarded(s, &format!("hook {event}"))
            );
            json!({"hooks": [{"type": "command", "command": command, "async": event != "Stop", "timeout": 30}]})
        };
        let mut stop = vec![json!({"hooks": [{"type": "command", "command": "notify-send done"}]})];
        stop.extend(sentinels.iter().map(|s| group(s, "Stop")));
        let mut hooks = json!({"Stop": stop});
        if !sentinels.is_empty() {
            hooks["SessionStart"] =
                Value::Array(sentinels.iter().map(|s| group(s, "SessionStart")).collect());
        }
        let mut root = json!({"hooks": hooks, "model": "opus"});
        // One statusLine exists at a time; the first channel to install owns it.
        if let Some(s) = sentinels.first() {
            root["statusLine"] = json!({
                "type": "command",
                "command": format!("'{}' quota-statusline {s}", self.launcher(s)),
            });
        }
        pretty(&root)
    }

    fn codex_hooks_json(&self, sentinels: &[&str]) -> String {
        let group = |s: &str, event: &str| json!({"hooks": [{"type": "command", "command": self.guarded(s, &format!("hook {event} --agent codex"))}]});
        let mut stop = vec![json!({"hooks": [{"type": "command", "command": "say done"}]})];
        stop.extend(sentinels.iter().map(|s| group(s, "Stop")));
        let mut hooks = json!({"Stop": stop});
        if !sentinels.is_empty() {
            hooks["SessionStart"] =
                Value::Array(sentinels.iter().map(|s| group(s, "SessionStart")).collect());
        }
        pretty(&json!({"hooks": hooks}))
    }

    fn codex_toml(&self, sentinels: &[&str]) -> String {
        let mut out = String::from("model = \"o3\"\n");
        match sentinels.first() {
            // The first channel to install parks the user's notify under its own marker.
            Some(s) => out.push_str(&format!("# notify = [\"say\"] # {s} parked-user-notify\n")),
            None => out.push_str("notify = [\"say\"]\n"),
        }
        let hooks = self
            .codex_hooks()
            .display()
            .to_string()
            .replace('\\', "\\\\");
        for (i, s) in sentinels.iter().enumerate() {
            out.push_str(&format!(
                "# BEGIN Houston Codex hook trust {s}\n\
                 [hooks.state.\"{hooks}:stop:{}:0\"]\n\
                 trusted_hash = \"sha256:{i:064}\"\n\
                 enabled = true\n\
                 # END Houston Codex hook trust {s}\n",
                i + 1
            ));
        }
        out
    }

    fn antigravity(&self, sentinels: &[&str]) -> String {
        let mut root = json!({"mine": {"Stop": [{"type": "command", "command": "echo hi"}]}});
        if !sentinels.is_empty() {
            let stop: Vec<Value> = sentinels
                .iter()
                .map(|s| json!({"type": "command", "command": self.guarded(s, "hook Stop --agent antigravity")}))
                .collect();
            let pre: Vec<Value> = sentinels
                .iter()
                .map(|s| {
                    json!({"matcher": ".*", "hooks": [{"type": "command", "command": self.guarded(s, "hook PreToolUse --agent antigravity")}]})
                })
                .collect();
            root["houston"] = json!({"Stop": stop, "PreToolUse": pre});
        }
        pretty(&root)
    }

    fn zcode(&self, sentinels: &[&str]) -> String {
        // Windows starts the launcher without a shell (`process`), elsewhere through one.
        let entry = |s: &str, event: &str| {
            if cfg!(windows) {
                json!({"type": "process", "command": format!("{}.exe", self.launcher(s)),
                       "args": ["hook", event, "--agent", "zcode", s]})
            } else {
                json!({"type": "command", "command": self.guarded(s, &format!("hook {event} --agent zcode"))})
            }
        };
        let mut stop = vec![json!({"hooks": [{"type": "command", "command": "echo user"}]})];
        stop.extend(
            sentinels
                .iter()
                .map(|s| json!({"hooks": [entry(s, "Stop")]})),
        );
        let mut events = json!({"Stop": stop});
        let mut dirs = vec![json!("/opt/user-plugin")];
        let mut root = json!({"theme": "dark"});
        if !sentinels.is_empty() {
            events["PreToolUse"] = Value::Array(
                sentinels
                    .iter()
                    .map(|s| json!({"hooks": [entry(s, "PreToolUse")], "matcher": "AskUserQuestion"}))
                    .collect(),
            );
            root["houstonParkedHooksEnabled"] = Value::Null;
            dirs.extend(sentinels.iter().map(|s| {
                json!(crate::sys::paths::dir_for(&self.home(), channel_of(s))
                    .join("zcode-plugin")
                    .display()
                    .to_string())
            }));
        }
        let mut hooks = json!({"events": events});
        if !sentinels.is_empty() {
            hooks["enabled"] = json!(true);
        }
        root["hooks"] = hooks;
        root["plugins"] = json!({"dirs": dirs});
        pretty(&root)
    }

    /// Writes every provider's config as v1 left it after installing `sentinels` in order.
    pub fn install_all(&self, sentinels: &[&str]) {
        self.write(&self.opencode_user_plugin(), OPENCODE_USER_PLUGIN);
        for provider in PROVIDERS {
            for (path, text) in self.files(provider, sentinels) {
                if let Some(text) = text {
                    self.write(&path, &text);
                }
            }
        }
    }

    /// Every file v1's install of one channel touched, sorted.
    pub fn managed_files(&self) -> Vec<PathBuf> {
        let mut out: Vec<PathBuf> = PROVIDERS
            .into_iter()
            .flat_map(|p| self.files(p, &[DEV]))
            .map(|(path, _)| path)
            .collect();
        out.sort();
        out
    }

    /// Each of `provider`'s files is byte-identical to v1's output for `sentinels` alone.
    pub fn assert_only(&self, provider: Provider, sentinels: &[&str]) {
        for (path, expected) in self.files(provider, sentinels) {
            match expected {
                Some(text) => {
                    assert_eq!(self.read(&path), text, "{provider:?}: {}", path.display())
                }
                None => assert!(
                    !path.exists(),
                    "{provider:?}: {} should be gone",
                    path.display()
                ),
            }
        }
    }

    /// Hook events of a Claude settings file or a ZCode settings file.
    fn events(provider: Provider, root: &mut Value) -> &mut serde_json::Map<String, Value> {
        let hooks = &mut root["hooks"];
        let events = match provider {
            Provider::Claude => hooks,
            Provider::Zcode => &mut hooks["events"],
            other => panic!("{other:?} keeps no user hook beside Houston's in one group"),
        };
        events.as_object_mut().expect("hook events object")
    }

    /// A user adds their own hook to every group v1 created for `dev` (Claude, ZCode), as
    /// v1's uninstall anticipated; returns how many groups now hold both.
    pub fn share_houston_groups(&self, provider: Provider) -> usize {
        let mut shared = 0;
        for (path, _) in self.files(provider, &[DEV]) {
            let mut root: Value = serde_json::from_str(&self.read(&path)).expect("fixture JSON");
            for groups in Self::events(provider, &mut root)
                .values_mut()
                .filter_map(Value::as_array_mut)
            {
                for group in groups {
                    let hooks = group["hooks"].as_array_mut().expect("group hooks");
                    if hooks.iter().any(|h| h.to_string().contains(DEV)) {
                        hooks.push(user_hook());
                        shared += 1;
                    }
                }
            }
            self.write(&path, &pretty(&root));
        }
        shared
    }

    /// After a `dev` cleanup: each shared group holds the user's hook alone, and without
    /// those groups every file is v1's output with no channel installed.
    pub fn assert_user_groups_left(&self, provider: Provider, shared: usize) {
        let mut found = 0;
        for ((path, _), (_, bare)) in self
            .files(provider, &[DEV])
            .into_iter()
            .zip(self.files(provider, &[]))
        {
            let mut root: Value = serde_json::from_str(&self.read(&path)).expect("cleaned JSON");
            let events = Self::events(provider, &mut root);
            for groups in events.values_mut().filter_map(Value::as_array_mut) {
                let before = groups.len();
                groups.retain(|g| g["hooks"] != json!([user_hook()]));
                found += before - groups.len();
            }
            events.retain(|_, v| v.as_array().is_none_or(|g| !g.is_empty()));
            let bare: Value = serde_json::from_str(&bare.expect("bare fixture")).expect("JSON");
            assert_eq!(root, bare, "{provider:?}: {}", path.display());
        }
        assert_eq!(
            found, shared,
            "{provider:?}: groups left holding the user hook"
        );
    }

    /// The command of the first hook v1 installed for `dev` in Claude's settings.
    pub fn claude_houston_command(&self) -> String {
        let root: Value = serde_json::from_str(&self.claude(&[DEV])).expect("fixture JSON");
        root["hooks"]["Stop"][1]["hooks"][0]["command"]
            .as_str()
            .expect("Houston's Stop command")
            .to_string()
    }

    pub fn write_claude_mcp_entry(&self) {
        let root = json!({
            "mcpServers": {"houston": {
                "type": "http",
                "url": "${HOUSTON_MCP_URL}",
                "headers": {"Authorization": "Bearer ${HOUSTON_MCP_TOKEN}"},
            }},
            "userID": "u",
        });
        self.write(
            &self.claude_json(),
            &serde_json::to_string(&root).expect("json"),
        );
    }

    /// A stand-in `claude` that appends its arguments to `calls.txt` beside itself.
    pub fn fake_claude(&self) -> PathBuf {
        let bin = self.root().join("fake-bin");
        std::fs::create_dir_all(&bin).expect("fake bin dir");
        if cfg!(windows) {
            self.write(
                &bin.join("claude.cmd"),
                "@echo off\r\necho %*>>\"%~dp0calls.txt\"\r\n",
            );
        } else {
            let script = bin.join("claude");
            self.write(
                &script,
                "#!/bin/sh\necho \"$@\" >> \"$(dirname \"$0\")/calls.txt\"\n",
            );
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755))
                    .expect("chmod fake claude");
            }
        }
        bin
    }

    pub fn fake_claude_calls(&self, bin: &Path) -> Vec<String> {
        std::fs::read_to_string(bin.join("calls.txt"))
            .unwrap_or_default()
            .lines()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect()
    }

    pub fn write_daemon_json(&self, channel: Option<&str>, pid: u32) {
        let record = json!({"port": 1, "token": "t", "pid": pid, "generation": 1});
        self.write(
            &self.channel_dir(channel).join("daemon.json"),
            &serde_json::to_string(&record).expect("json"),
        );
    }

    /// Moves every file's mtime into the past, so a rewrite with equal bytes still shows.
    pub fn age_everything(&self) {
        let past = SystemTime::UNIX_EPOCH + Duration::from_secs(978_307_200);
        for (path, _) in self.snapshot() {
            if path.is_file() {
                std::fs::File::options()
                    .write(true)
                    .open(&path)
                    .and_then(|f| f.set_modified(past))
                    .unwrap_or_else(|e| panic!("aging {}: {e}", path.display()));
            }
        }
    }

    /// Occurrences of `sentinel` as a whole token in every file under the home.
    pub fn sentinel_count(&self, sentinel: &str) -> usize {
        self.snapshot()
            .values()
            .map(|(bytes, _)| {
                String::from_utf8_lossy(bytes)
                    .split(|c: char| {
                        c.is_whitespace()
                            || matches!(c, '"' | '\'' | ',' | '[' | ']' | ';' | '(' | ')')
                    })
                    .filter(|t| *t == sentinel || t.strip_suffix('.') == Some(sentinel))
                    .count()
            })
            .sum()
    }

    pub fn snapshot(&self) -> Snapshot {
        snapshot_of(&self.home())
    }
}

pub fn sorted(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = paths.to_vec();
    out.sort();
    out
}

/// Every file below `root` with its bytes and mtime, and every directory. A directory's
/// mtime is left out: NTFS settles it lazily after a write inside, and its entries
/// already show a file created or removed there.
pub fn snapshot_of(root: &Path) -> Snapshot {
    let mut out = Snapshot::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("read fixture dir").flatten() {
            let path = entry.path();
            let meta = entry.metadata().expect("fixture metadata");
            if meta.is_dir() {
                stack.push(path.clone());
                out.insert(path, (Vec::new(), SystemTime::UNIX_EPOCH));
            } else {
                let mtime = meta.modified().expect("mtime");
                out.insert(
                    path.clone(),
                    (std::fs::read(&path).expect("fixture bytes"), mtime),
                );
            }
        }
    }
    out
}

pub fn set_readonly_tree(root: &Path, readonly: bool) {
    for (path, _) in snapshot_of(root) {
        set_readonly(&path, readonly);
    }
    set_readonly(root, readonly);
}

#[cfg(unix)]
fn set_readonly(path: &Path, readonly: bool) {
    use std::os::unix::fs::PermissionsExt;
    let mode = match (path.is_dir(), readonly) {
        (true, true) => 0o555,
        (true, false) => 0o755,
        (false, true) => 0o444,
        (false, false) => 0o644,
    };
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)).expect("chmod fixture");
}

// Windows ignores the attribute on directories; on files it refuses writes and deletes.
#[cfg(windows)]
#[allow(clippy::permissions_set_readonly_false)]
fn set_readonly(path: &Path, readonly: bool) {
    if path.is_dir() {
        return;
    }
    let mut perms = std::fs::metadata(path)
        .expect("fixture metadata")
        .permissions();
    perms.set_readonly(readonly);
    std::fs::set_permissions(path, perms).expect("attrib fixture");
}

/// The PID of a process that has exited and been reaped.
pub fn exited_pid() -> u32 {
    let mut cmd = if cfg!(windows) {
        let mut c = crate::sys::spawn::command("cmd.exe");
        c.args(["/D", "/C", "exit 0"]);
        c
    } else {
        let mut c = crate::sys::spawn::command("/bin/sh");
        c.args(["-c", "exit 0"]);
        c
    };
    let mut child = cmd.spawn().expect("spawn a short-lived process");
    let pid = child.id();
    child.wait().expect("reap it");
    pid
}

/// A long-running process whose image is named `stem` (`houston-core` was v1's daemon):
/// a copy of a system binary that waits, killed and reaped on drop.
pub struct FakeDaemon(std::process::Child);

impl FakeDaemon {
    pub fn spawn(dir: &Path, stem: &str) -> Self {
        std::fs::create_dir_all(dir).expect("fake daemon dir");
        let (source, name, args): (PathBuf, String, &[&str]) = if cfg!(windows) {
            let system = std::env::var_os("SystemRoot")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
            (
                system.join("System32").join("ping.exe"),
                format!("{stem}.exe"),
                &["-n", "60", "127.0.0.1"],
            )
        } else {
            (PathBuf::from("/bin/sleep"), stem.to_string(), &["60"])
        };
        let image = dir.join(name);
        std::fs::copy(&source, &image).expect("copy the stand-in daemon binary");
        let child = crate::sys::spawn::command(&image)
            .args(args)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .expect("start the stand-in daemon");
        Self(child)
    }

    pub fn pid(&self) -> u32 {
        self.0.id()
    }
}

impl Drop for FakeDaemon {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
