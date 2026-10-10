//! The one seam to `wsl.exe`. Every in-distro command is `-d <distro> --exec <argv...>`:
//! after `--`, `wsl.exe` hands argv to a login shell that parses it a second time.

use std::io;
use std::path::Path;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncWrite};

pub const WSL_EXE: &str = "wsl.exe";
// Long enough for a stopped distro to boot and for wsl-ensure's own handoff wait.
const RUN_TIMEOUT: Duration = Duration::from_secs(180);

pub enum Stdin<'a> {
    Null,
    File(&'a Path),
}

#[derive(Debug, Clone, Default)]
pub struct RunOutput {
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

/// One relay connection's upstream: the child's stdin and stdout.
pub struct Piped {
    pub stdin: Box<dyn AsyncWrite + Send + Unpin>,
    pub stdout: Box<dyn AsyncRead + Send + Unpin>,
    pub child: Option<tokio::process::Child>,
}

pub trait Runner: Send + Sync + 'static {
    /// Runs `wsl.exe <argv>` to completion.
    fn run(&self, argv: &[String], stdin: Stdin<'_>) -> io::Result<RunOutput>;
    /// Starts `wsl.exe <argv>` with piped stdin and stdout.
    fn spawn_piped(&self, argv: &[String]) -> io::Result<Piped>;
}

pub struct WslExe;

impl Runner for WslExe {
    fn run(&self, argv: &[String], stdin: Stdin<'_>) -> io::Result<RunOutput> {
        let mut cmd = houston_core::spawn::command(WSL_EXE);
        cmd.args(argv).env("WSL_UTF8", "1");
        let output = match stdin {
            Stdin::Null => {
                houston_core::spawn::output_within(cmd, RUN_TIMEOUT)?.ok_or_else(timed_out)?
            }
            Stdin::File(path) => cmd
                .stdin(std::fs::File::open(path)?)
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .output()?,
        };
        Ok(RunOutput {
            code: output.status.code(),
            stdout: output.stdout,
            stderr: output.stderr,
        })
    }

    fn spawn_piped(&self, argv: &[String]) -> io::Result<Piped> {
        let mut child = houston_core::spawn::tokio_command(WSL_EXE)
            .args(argv)
            .env("WSL_UTF8", "1")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin was piped");
        let stdout = child.stdout.take().expect("stdout was piped");
        Ok(Piped {
            stdin: Box::new(stdin),
            stdout: Box::new(stdout),
            child: Some(child),
        })
    }
}

/// `output_within` kills the child at the deadline; this is how that reaches the caller.
pub fn timed_out() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        format!("timed out after {} s", RUN_TIMEOUT.as_secs()),
    )
}

/// For error messages; no argv built here carries a secret.
pub fn describe(argv: &[String]) -> String {
    format!("{WSL_EXE} {}", argv.join(" "))
}

pub fn list() -> Vec<String> {
    vec!["-l".into(), "-v".into()]
}

fn in_distro(distro: &str, exec: &[&str]) -> Vec<String> {
    ["-d", distro, "--exec"]
        .iter()
        .chain(exec)
        .map(|arg| arg.to_string())
        .collect()
}

const PROBE_SCRIPT: &str = "uname -m; getconf GNU_LIBC_VERSION 2>/dev/null || true";

/// Prints the machine architecture, then `glibc <version>` when glibc is present.
pub fn probe(distro: &str) -> Vec<String> {
    in_distro(distro, &["/bin/sh", "-c", PROBE_SCRIPT])
}

const HASH_SCRIPT: &str = "printf '%s\\n' \"$HOME\"; \
     cd \"$HOME/.local/lib/houston-wsl/$1\" 2>/dev/null && \
     sha256sum houston-core tr-helper houston-supervisor 2>/dev/null; exit 0";

/// Prints `$HOME`, then one `sha256sum` line per installed file of `build`.
pub fn remote_hashes(distro: &str, build: &str) -> Vec<String> {
    in_distro(distro, &["/bin/sh", "-c", HASH_SCRIPT, "sh", build])
}

const INSTALL_SCRIPT: &str = "set -e; d=\"$HOME/.local/lib/houston-wsl/$1\"; mkdir -p \"$d\"; \
     cat > \"$d/.$2.new\"; \
     if ! printf '%s  %s\\n' \"$3\" \"$d/.$2.new\" | sha256sum -c --status; then \
     rm -f \"$d/.$2.new\"; echo \"$d/.$2.new does not match sha256 $3\" >&2; exit 1; fi; \
     chmod 755 \"$d/.$2.new\"; mv -f \"$d/.$2.new\" \"$d/$2\"";

/// Reads one file from stdin into `.<name>.new`, checks its sha256, then renames it.
pub fn install(distro: &str, build: &str, name: &str, sha256: &str) -> Vec<String> {
    in_distro(
        distro,
        &["/bin/sh", "-c", INSTALL_SCRIPT, "sh", build, name, sha256],
    )
}

fn core_bin(install_dir: &str) -> String {
    format!("{install_dir}/houston-core")
}

pub fn ensure(distro: &str, install_dir: &str, channel: &str) -> Vec<String> {
    in_distro(
        distro,
        &[&core_bin(install_dir), "wsl-ensure", "--channel", channel],
    )
}

pub fn proxy(distro: &str, install_dir: &str, channel: &str) -> Vec<String> {
    in_distro(
        distro,
        &[&core_bin(install_dir), "wsl-proxy", "--channel", channel],
    )
}

pub fn launcher_remove(distro: &str, install_dir: &str) -> Vec<String> {
    in_distro(distro, &[&core_bin(install_dir), "wsl-launcher-remove"])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_distro_command_uses_exec() {
        let dir = "/home/u/.local/lib/houston-wsl/abc1234";
        let commands = [
            probe("Ubuntu"),
            remote_hashes("Ubuntu", "abc1234"),
            install("Ubuntu", "abc1234", "houston-core", &"0".repeat(64)),
            ensure("Ubuntu", dir, "wslt"),
            proxy("Ubuntu", dir, "wslt"),
            launcher_remove("Ubuntu", dir),
        ];
        for argv in &commands {
            assert_eq!(&argv[..3], ["-d", "Ubuntu", "--exec"], "{argv:?}");
            assert!(!argv.iter().any(|arg| arg == "--"), "{argv:?}");
        }
        assert_eq!(
            ensure("Ubuntu", dir, "wslt")[3..],
            [
                &format!("{dir}/houston-core"),
                "wsl-ensure",
                "--channel",
                "wslt"
            ]
        );
        assert_eq!(list(), ["-l", "-v"]);
    }

    // The scripts run unchanged inside the distro; a Unix host runs the same `sh`.
    #[cfg(unix)]
    #[test]
    #[allow(clippy::disallowed_methods)]
    fn install_script_writes_new_then_renames() {
        use sha2::Digest;
        let home = tempfile::tempdir().unwrap();
        let payload = b"\x7fELF payload";
        let sha = format!("{:x}", sha2::Sha256::digest(payload));
        let source = home.path().join("payload");
        std::fs::write(&source, payload).unwrap();
        let argv = install("Ubuntu", "b1", "tr-helper", &sha);
        let status = std::process::Command::new(&argv[3])
            .args(&argv[4..])
            .env("HOME", home.path())
            .stdin(std::fs::File::open(&source).unwrap())
            .status()
            .unwrap();
        assert!(status.success());
        let dir = home.path().join(".local/lib/houston-wsl/b1");
        assert_eq!(std::fs::read(dir.join("tr-helper")).unwrap(), payload);
        assert!(!dir.join(".tr-helper.new").exists());

        let bad = install("Ubuntu", "b1", "houston-core", &"0".repeat(64));
        let status = std::process::Command::new(&bad[3])
            .args(&bad[4..])
            .env("HOME", home.path())
            .stdin(std::fs::File::open(&source).unwrap())
            .status()
            .unwrap();
        assert!(!status.success(), "a hash mismatch must not install");
        assert!(!dir.join("houston-core").exists() && !dir.join(".houston-core.new").exists());

        let out = std::process::Command::new(&remote_hashes("Ubuntu", "b1")[3])
            .args(&remote_hashes("Ubuntu", "b1")[4..])
            .env("HOME", home.path())
            .output()
            .unwrap();
        let text = String::from_utf8(out.stdout).unwrap();
        assert!(
            text.starts_with(&format!("{}\n", home.path().display())),
            "{text}"
        );
        assert!(text.contains(&format!("{sha}  tr-helper")), "{text}");
    }
}
