use anyhow::{Context, Result};
use base64::Engine as _;
use std::io::Write as _;
use std::path::{Path, PathBuf};

const TOKEN_FILE_ENV: &str = "HOUSTON_SHELL_INTEGRATION_TOKEN_FILE";
const TOKEN_BYTES: usize = 32;

pub fn mint_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::fill(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

pub struct TokenFileGuard {
    path: PathBuf,
    armed: bool,
}

impl TokenFileGuard {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for TokenFileGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_token_file(&self.path);
        }
    }
}

pub fn create_token_file(int_dir: &Path, session: u32, token: &str) -> Result<TokenFileGuard> {
    let session_dir = int_dir.join("sessions").join(session.to_string());
    std::fs::create_dir_all(&session_dir)
        .with_context(|| format!("creating {}", session_dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&session_dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("securing {}", session_dir.display()))?;
    }
    let path = session_dir.join("token");
    match std::fs::remove_file(&path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e).with_context(|| format!("removing stale {}", path.display())),
    }
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        // 0600: any other local user could read the capability and forge
        // markers into this session's PTY. The rc unlinks it once sourced.
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let mut file = options
        .open(&path)
        .with_context(|| format!("creating {}", path.display()))?;
    if let Err(e) = file.write_all(token.as_bytes()) {
        let _ = std::fs::remove_file(&path);
        return Err(e).with_context(|| format!("writing {}", path.display()));
    }
    Ok(TokenFileGuard { path, armed: true })
}

pub fn remove_token_file(path: &Path) -> Result<()> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).with_context(|| format!("removing {}", path.display())),
    }
}

pub struct TokenRedactor {
    token: Vec<u8>,
    pending: Vec<u8>,
}

#[derive(Debug)]
pub enum RedactedChunk<'a> {
    Borrowed(&'a [u8]),
    Owned(Vec<u8>),
}

impl RedactedChunk<'_> {
    pub fn len(&self) -> usize {
        self.as_ref().len()
    }

    pub fn is_empty(&self) -> bool {
        self.as_ref().is_empty()
    }

    pub fn extend(&mut self, bytes: impl AsRef<[u8]>) {
        let bytes = bytes.as_ref();
        match self {
            Self::Borrowed(current) => {
                let mut owned = Vec::with_capacity(current.len() + bytes.len());
                owned.extend_from_slice(current);
                owned.extend_from_slice(bytes);
                *self = Self::Owned(owned);
            }
            Self::Owned(current) => current.extend_from_slice(bytes),
        }
    }
}

impl AsRef<[u8]> for RedactedChunk<'_> {
    fn as_ref(&self) -> &[u8] {
        match self {
            Self::Borrowed(bytes) => bytes,
            Self::Owned(bytes) => bytes,
        }
    }
}

impl<const N: usize> PartialEq<&[u8; N]> for RedactedChunk<'_> {
    fn eq(&self, other: &&[u8; N]) -> bool {
        self.as_ref() == other.as_slice()
    }
}

impl TokenRedactor {
    pub fn new(token: &str) -> Self {
        Self {
            token: token.as_bytes().to_vec(),
            pending: Vec::new(),
        }
    }

    pub fn feed<'a>(&mut self, input: &'a [u8]) -> RedactedChunk<'a> {
        let first = self.token[0];
        if self.pending.is_empty() {
            let Some(first_hit) = memchr::memchr(first, input) else {
                return RedactedChunk::Borrowed(input);
            };
            let mut out = Vec::with_capacity(input.len());
            out.extend_from_slice(&input[..first_hit]);
            self.scan_candidates(input, first_hit, &mut out);
            return RedactedChunk::Owned(out);
        }

        let mut out = Vec::with_capacity(input.len());
        let mut cursor = 0;
        while cursor < input.len() && !self.pending.is_empty() {
            self.pending.push(input[cursor]);
            cursor += 1;
            if self.pending == self.token {
                out.extend(std::iter::repeat_n(b'*', self.token.len()));
                self.pending.clear();
                break;
            }
            while !self.token.starts_with(&self.pending) {
                out.push(self.pending.remove(0));
                if self.pending.is_empty() {
                    break;
                }
            }
        }
        if self.pending.is_empty() {
            self.scan_candidates(input, cursor, &mut out);
        }
        RedactedChunk::Owned(out)
    }

    fn scan_candidates(&mut self, input: &[u8], mut cursor: usize, out: &mut Vec<u8>) {
        let first = self.token[0];
        while cursor < input.len() {
            let Some(relative) = memchr::memchr(first, &input[cursor..]) else {
                out.extend_from_slice(&input[cursor..]);
                break;
            };
            let candidate = cursor + relative;
            out.extend_from_slice(&input[cursor..candidate]);
            let tail = &input[candidate..];
            if tail.starts_with(&self.token) {
                out.extend(std::iter::repeat_n(b'*', self.token.len()));
                cursor = candidate + self.token.len();
            } else if self.token.starts_with(tail) {
                self.pending.extend_from_slice(tail);
                break;
            } else {
                out.push(first);
                cursor = candidate + 1;
            }
        }
    }

    pub fn finish(&mut self) -> Vec<u8> {
        let redacted = vec![b'*'; self.pending.len()];
        self.pending.clear();
        redacted
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellKind {
    Bash,
    Zsh,
    Other,
}

pub fn shell_kind(shell: &str) -> ShellKind {
    match Path::new(shell).file_name().and_then(|n| n.to_str()) {
        Some("bash") => ShellKind::Bash,
        Some("zsh") => ShellKind::Zsh,
        _ => ShellKind::Other,
    }
}

pub fn env_disabled() -> bool {
    std::env::var("HOUSTON_SHELL_INTEGRATION").is_ok_and(|v| v == "0")
}

const BASHRC: &str = r#"# Houston shell integration (generated — do not edit; regenerated on
# every daemon start). Sources your real ~/.bashrc first, then installs
# prompt/command markers (OSC 133 + OSC 9;9) for the Houston daemon.
# Read and unlink the capability before user startup code or child processes can reach it.
__tr_token_file="${HOUSTON_SHELL_INTEGRATION_TOKEN_FILE-}"
unset HOUSTON_SHELL_INTEGRATION_TOKEN_FILE
__tr_token=""
# Residual exposure: between spawn and this unlink, only the user's shell startup path is running.
if [ -n "$__tr_token_file" ] && [ -f "$__tr_token_file" ]; then
  __tr_token="$(< "$__tr_token_file")"
  /bin/rm -f -- "$__tr_token_file"
fi
unset __tr_token_file
if [ -f "$HOME/.bashrc" ]; then . "$HOME/.bashrc"; fi

unalias claude 2>/dev/null || true
claude() {
  if [ -n "${HOUSTON_MCP_CONFIG-}" ]; then
    command claude --mcp-config "$HOUSTON_MCP_CONFIG" "$@"
  else
    command claude "$@"
  fi
}

__tr_ran=""
__tr_at_prompt=""
__tr_in_pc=""
__tr_ec=0

# The DEBUG trap fires for every simple command, including the user's own
# PROMPT_COMMAND parts on an empty Enter — those must never become command
# blocks. __tr_first runs FIRST in PROMPT_COMMAND: it captures the true exit
# code (before user prompt parts clobber $?) and raises __tr_in_pc, which the
# trap treats as "prompt machinery, not a user command". __tr_prompt runs
# LAST: it emits the markers, arms the trap, and lowers the flag.
__tr_first() {
  __tr_ec=$?
  __tr_in_pc=1
}

__tr_preexec() {
  [ -n "$COMP_LINE" ] && return
  [ -n "$__tr_in_pc" ] && return
  case "$BASH_COMMAND" in __tr_first | __tr_prompt) return ;; esac
  [ -z "$__tr_at_prompt" ] && return
  __tr_at_prompt=""
  __tr_ran=1
  local cmd
  cmd=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null | sed 's/^ *[0-9]* *//')
  [ -z "$cmd" ] && cmd=$BASH_COMMAND
  printf '\033]133;C;%s;%s\007' "$__tr_token" "$(printf '%s' "$cmd" | base64 | tr -d '\n')"
}
trap '__tr_preexec' DEBUG

__tr_prompt() {
  if [ -n "$__tr_ran" ]; then
    __tr_ran=""
    printf '\033]133;D;%s;%s\007' "$__tr_token" "$__tr_ec"
  fi
  printf '\033]9;9;%s;%s\007' "$__tr_token" "$PWD"
  printf '\033]133;A;%s\007' "$__tr_token"
  __tr_at_prompt=1
  __tr_in_pc=""
}

# bash 5.1+ may hold PROMPT_COMMAND as an array — handle both shapes.
if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
  PROMPT_COMMAND=(__tr_first "${PROMPT_COMMAND[@]}" __tr_prompt)
else
  PROMPT_COMMAND="__tr_first${PROMPT_COMMAND:+;$PROMPT_COMMAND};__tr_prompt"
fi
PS1="$PS1\[\033]133;B;$__tr_token\007\]"
"#;

const ZSHRC: &str = r#"# Houston shell integration (generated — do not edit; regenerated on
# every daemon start). Sources your real .zshrc first, then installs
# prompt/command markers (OSC 133 + OSC 9;9) for the Houston daemon.
if [ -n "$HOUSTON_USER_ZDOTDIR" ] && [ -f "$HOUSTON_USER_ZDOTDIR/.zshrc" ]; then
  ZDOTDIR="$HOUSTON_USER_ZDOTDIR" . "$HOUSTON_USER_ZDOTDIR/.zshrc"
elif [ -f "$HOME/.zshrc" ]; then
  . "$HOME/.zshrc"
fi

unalias claude 2>/dev/null || true
claude() {
  if [ -n "${HOUSTON_MCP_CONFIG-}" ]; then
    command claude --mcp-config "$HOUSTON_MCP_CONFIG" "$@"
  else
    command claude "$@"
  fi
}

typeset -g __tr_ran=""

__tr_preexec() {
  __tr_ran=1
  printf '\033]133;C;%s;%s\007' "$__tr_token" "$(printf '%s' "$1" | base64 | tr -d '\n')"
}
__tr_precmd() {
  local ec=$?
  if [ -n "$__tr_ran" ]; then
    __tr_ran=""
    printf '\033]133;D;%s;%s\007' "$__tr_token" "$ec"
  fi
  printf '\033]9;9;%s;%s\007' "$__tr_token" "$PWD"
  printf '\033]133;A;%s\007' "$__tr_token"
}
__tr_chpwd() {
  printf '\033]9;9;%s;%s\007' "$__tr_token" "$PWD"
}
autoload -Uz add-zsh-hook
add-zsh-hook preexec __tr_preexec
add-zsh-hook precmd __tr_precmd
add-zsh-hook chpwd __tr_chpwd
PS1="$PS1%{$(printf '\033]133;B;%s\007' "$__tr_token")%}"
"#;

const ZSHENV: &str = r#"# Houston shell integration (generated — do not edit).
# Chain to the user's .zshenv, keeping our ZDOTDIR in charge of .zshrc.
# Read and unlink the capability before user startup code or child processes can reach it.
typeset -g __tr_token_file="${HOUSTON_SHELL_INTEGRATION_TOKEN_FILE-}"
unset HOUSTON_SHELL_INTEGRATION_TOKEN_FILE
typeset -g __tr_token=""
# Residual exposure: between spawn and this unlink, only the user's shell startup path is running.
if [ -n "$__tr_token_file" ] && [ -f "$__tr_token_file" ]; then
  __tr_token="$(< "$__tr_token_file")"
  /bin/rm -f -- "$__tr_token_file"
fi
unset __tr_token_file
if [ -n "$HOUSTON_USER_ZDOTDIR" ] && [ -f "$HOUSTON_USER_ZDOTDIR/.zshenv" ]; then
  __tr_zdotdir="$ZDOTDIR"
  ZDOTDIR="$HOUSTON_USER_ZDOTDIR" . "$HOUSTON_USER_ZDOTDIR/.zshenv"
  ZDOTDIR="$__tr_zdotdir"
elif [ -f "$HOME/.zshenv" ] && [ "$HOME" != "${ZDOTDIR:-}" ]; then
  . "$HOME/.zshenv"
fi
"#;

const ZPROFILE: &str = r#"# Houston shell integration (generated — do not edit).
if [ -n "$HOUSTON_USER_ZDOTDIR" ] && [ -f "$HOUSTON_USER_ZDOTDIR/.zprofile" ]; then
  ZDOTDIR="$HOUSTON_USER_ZDOTDIR" . "$HOUSTON_USER_ZDOTDIR/.zprofile"
elif [ -f "$HOME/.zprofile" ]; then
  . "$HOME/.zprofile"
fi
"#;

const ZLOGIN: &str = r#"# Houston shell integration (generated — do not edit).
if [ -n "$HOUSTON_USER_ZDOTDIR" ] && [ -f "$HOUSTON_USER_ZDOTDIR/.zlogin" ]; then
  ZDOTDIR="$HOUSTON_USER_ZDOTDIR" . "$HOUSTON_USER_ZDOTDIR/.zlogin"
elif [ -f "$HOME/.zlogin" ]; then
  . "$HOME/.zlogin"
fi
"#;

pub struct Injection {
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

pub fn materialize(state_dir: &Path) -> Result<PathBuf> {
    let dir = state_dir.join("shell-integration");
    let zsh_dir = dir.join("zsh");
    std::fs::create_dir_all(&zsh_dir).with_context(|| format!("creating {}", zsh_dir.display()))?;
    std::fs::write(dir.join("bashrc"), BASHRC)
        .with_context(|| format!("writing {}", dir.join("bashrc").display()))?;
    std::fs::write(zsh_dir.join(".zshrc"), ZSHRC)
        .with_context(|| format!("writing {}", zsh_dir.join(".zshrc").display()))?;
    std::fs::write(zsh_dir.join(".zshenv"), ZSHENV)
        .with_context(|| format!("writing {}", zsh_dir.join(".zshenv").display()))?;
    std::fs::write(zsh_dir.join(".zprofile"), ZPROFILE)
        .with_context(|| format!("writing {}", zsh_dir.join(".zprofile").display()))?;
    std::fs::write(zsh_dir.join(".zlogin"), ZLOGIN)
        .with_context(|| format!("writing {}", zsh_dir.join(".zlogin").display()))?;
    Ok(dir)
}

fn is_integration_zdotdir(dir: &str) -> bool {
    let path = Path::new(dir);
    if path.file_name().and_then(|n| n.to_str()) != Some("zsh") {
        return false;
    }
    path.parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
        == Some("shell-integration")
}

pub fn injection(int_dir: &Path, shell: &str, token_file: &Path) -> Option<Injection> {
    let token_file = token_file.display().to_string();
    match shell_kind(shell) {
        ShellKind::Bash => Some(Injection {
            args: vec![
                "--rcfile".into(),
                int_dir.join("bashrc").display().to_string(),
            ],
            env: vec![(TOKEN_FILE_ENV.to_string(), token_file)],
        }),
        ShellKind::Zsh => {
            let mut env = vec![
                (
                    "ZDOTDIR".to_string(),
                    int_dir.join("zsh").display().to_string(),
                ),
                (TOKEN_FILE_ENV.to_string(), token_file),
            ];
            if let Ok(user_zdot) = std::env::var("ZDOTDIR") {
                if !is_integration_zdotdir(&user_zdot) {
                    env.push(("HOUSTON_USER_ZDOTDIR".to_string(), user_zdot));
                }
            }
            Some(Injection {
                args: Vec::new(),
                env,
            })
        }
        ShellKind::Other => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_TOKEN: &str = "test-token";

    fn test_token_file() -> &'static Path {
        Path::new("/tmp/houston-shell-token-test")
    }

    #[test]
    fn shell_kind_by_basename() {
        assert_eq!(shell_kind("/bin/bash"), ShellKind::Bash);
        assert_eq!(shell_kind("/usr/bin/zsh"), ShellKind::Zsh);
        assert_eq!(shell_kind("zsh"), ShellKind::Zsh);
        assert_eq!(shell_kind("/usr/bin/fish"), ShellKind::Other);
    }

    #[test]
    fn materialize_writes_all_rc_files_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = materialize(tmp.path()).unwrap();
        let dir2 = materialize(tmp.path()).unwrap();
        assert_eq!(dir, dir2);
        assert!(dir.join("bashrc").is_file());
        assert!(dir.join("zsh/.zshrc").is_file());
        assert!(dir.join("zsh/.zshenv").is_file());
        let bashrc = std::fs::read_to_string(dir.join("bashrc")).unwrap();
        assert!(bashrc.contains("133;C"), "bash rc emits command markers");
    }

    #[test]
    #[cfg(unix)]
    fn claude_shell_function_uses_inline_config_only_when_present_with_errexit() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let dir = materialize(tmp.path()).unwrap();
        let bin = tmp.path().join("bin");
        std::fs::create_dir(&bin).unwrap();
        let stub = bin.join("claude");
        std::fs::write(
            &stub,
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$HOUSTON_TEST_ARGS\"\n",
        )
        .unwrap();
        std::fs::set_permissions(&stub, std::fs::Permissions::from_mode(0o755)).unwrap();
        let args_file = tmp.path().join("args");
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap());
        for (shell, rc) in [
            ("bash", dir.join("bashrc")),
            ("zsh", dir.join("zsh/.zshrc")),
        ] {
            for config in [None, Some(r#"{"mcpServers":{"houston":{}}}"#)] {
                let mut command = crate::spawn::command(shell);
                command
                    .args([
                        "-e",
                        "-c",
                        "source \"$1\"; claude first 'two words'",
                        "houston-test",
                    ])
                    .arg(&rc)
                    .env("HOME", tmp.path())
                    .env("PATH", &path)
                    .env("HOUSTON_TEST_ARGS", &args_file);
                if let Some(config) = config {
                    command.env(crate::mcp_launch::CONFIG_ENV, config);
                } else {
                    command.env_remove(crate::mcp_launch::CONFIG_ENV);
                }
                let output = command.output().unwrap();
                assert!(
                    output.status.success(),
                    "{shell}: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
                let args = std::fs::read_to_string(&args_file).unwrap();
                let expected = match config {
                    Some(value) => format!("--mcp-config\n{value}\nfirst\ntwo words\n"),
                    None => "first\ntwo words\n".to_string(),
                };
                assert_eq!(args, expected, "{shell}");
            }
        }
    }

    static ZDOTDIR_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn with_zdotdir<T>(value: Option<&str>, body: impl FnOnce() -> T) -> T {
        let _guard = ZDOTDIR_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let previous = std::env::var("ZDOTDIR").ok();
        match value {
            Some(v) => std::env::set_var("ZDOTDIR", v),
            None => std::env::remove_var("ZDOTDIR"),
        }
        let out = body();
        match previous {
            Some(v) => std::env::set_var("ZDOTDIR", v),
            None => std::env::remove_var("ZDOTDIR"),
        }
        out
    }

    #[test]
    fn an_integration_dir_is_recognised_whichever_channel_owns_it() {
        assert!(is_integration_zdotdir(
            "/home/u/.houston/shell-integration/zsh"
        ));
        assert!(is_integration_zdotdir(
            "/home/u/.houston-dev/shell-integration/zsh"
        ));
        assert!(is_integration_zdotdir("/anywhere/shell-integration/zsh"));
        assert!(!is_integration_zdotdir("/home/u/.config/zsh"));
        assert!(!is_integration_zdotdir("/home/u/shell-integration"));
        assert!(!is_integration_zdotdir("/home/u/shell-integration/bash"));
    }

    #[test]
    fn a_pane_never_chains_to_another_houstons_integration_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = materialize(tmp.path()).unwrap();

        let leaked = "/home/u/.houston/shell-integration/zsh";
        let zsh = with_zdotdir(Some(leaked), || {
            injection(&dir, "/bin/zsh", test_token_file()).unwrap()
        });
        assert!(
            !zsh.env.iter().any(|(k, _)| k == "HOUSTON_USER_ZDOTDIR"),
            "HOUSTON_USER_ZDOTDIR must be absent when the inherited ZDOTDIR is an \
             integration dir, got {:?}",
            zsh.env
        );
        assert!(
            zsh.env.iter().any(|(k, _)| k == "ZDOTDIR"),
            "this channel's own ZDOTDIR is still injected"
        );
    }

    #[test]
    fn a_real_user_config_is_still_chained_to() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = materialize(tmp.path()).unwrap();

        let user = "/home/u/.config/zsh";
        let zsh = with_zdotdir(Some(user), || {
            injection(&dir, "/bin/zsh", test_token_file()).unwrap()
        });
        assert_eq!(
            zsh.env
                .iter()
                .find(|(k, _)| k == "HOUSTON_USER_ZDOTDIR")
                .map(|(_, v)| v.as_str()),
            Some(user)
        );
    }

    #[test]
    fn injection_shapes_per_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = materialize(tmp.path()).unwrap();
        let bash = injection(&dir, "/bin/bash", test_token_file()).unwrap();
        assert_eq!(bash.args[0], "--rcfile");
        assert!(bash
            .env
            .iter()
            .any(|(k, v)| k == TOKEN_FILE_ENV && v == "/tmp/houston-shell-token-test"));
        let zsh = injection(&dir, "/bin/zsh", test_token_file()).unwrap();
        assert!(zsh.env.iter().any(|(k, _)| k == "ZDOTDIR"));
        assert!(zsh
            .env
            .iter()
            .any(|(k, v)| k == TOKEN_FILE_ENV && v == "/tmp/houston-shell-token-test"));
        assert!(injection(&dir, "/usr/bin/fish", test_token_file()).is_none());
    }

    #[test]
    fn generated_rcs_read_and_unlink_before_user_startup_code() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = materialize(tmp.path()).unwrap();
        let bashrc = std::fs::read_to_string(dir.join("bashrc")).unwrap();
        let zshenv = std::fs::read_to_string(dir.join("zsh/.zshenv")).unwrap();
        for rc in [&bashrc, &zshenv] {
            let capture = rc.find("__tr_token_file=").unwrap();
            let unset = rc
                .find("unset HOUSTON_SHELL_INTEGRATION_TOKEN_FILE")
                .unwrap();
            let read = rc.find("__tr_token=\"$(<").unwrap();
            let unlink = rc.find("/bin/rm -f --").unwrap();
            assert!(
                capture < unset && unset < read && read < unlink,
                "the rc captures the path, unsets it, reads the token, then unlinks"
            );
        }
        assert!(bashrc.find("/bin/rm -f --").unwrap() < bashrc.find("$HOME/.bashrc").unwrap());
        assert!(
            zshenv.find("/bin/rm -f --").unwrap()
                < zshenv.find("$HOUSTON_USER_ZDOTDIR/.zshenv").unwrap()
        );
    }

    #[cfg(unix)]
    #[test]
    fn token_file_is_private_and_guarded_until_session_ownership_transfers() {
        use std::os::unix::fs::PermissionsExt as _;

        let tmp = tempfile::tempdir().unwrap();
        let int_dir = materialize(tmp.path()).unwrap();
        let guard = create_token_file(&int_dir, 42, TEST_TOKEN).unwrap();
        let path = guard.path().to_path_buf();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), TEST_TOKEN);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        drop(guard);
        assert!(
            !path.exists(),
            "a failed spawn must not retain its token file"
        );
    }

    #[test]
    fn token_redactor_handles_split_tokens_without_changing_length() {
        let mut redactor = TokenRedactor::new(TEST_TOKEN);
        let mut out = redactor.feed(b"before test-");
        out.extend(redactor.feed(b"token after"));
        out.extend(redactor.finish());
        assert_eq!(out.len(), b"before test-token after".len());
        assert_eq!(out, b"before ********** after");
    }

    #[test]
    fn token_redactor_borrows_a_chunk_without_a_candidate_byte() {
        let mut redactor = TokenRedactor::new(TEST_TOKEN);
        let input = b"plain echo\n";
        let RedactedChunk::Borrowed(output) = redactor.feed(input) else {
            panic!("a no-candidate chunk must use the zero-copy path");
        };
        assert!(std::ptr::eq(output.as_ptr(), input.as_ptr()));
    }

    #[test]
    fn minted_tokens_are_random_base64url_capabilities() {
        let first = mint_token();
        let second = mint_token();
        assert_eq!(first.len(), 43);
        assert_ne!(first, second);
        assert!(first
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
    }
}
