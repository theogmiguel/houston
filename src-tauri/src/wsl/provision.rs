//! Copies the bundled Linux binaries into `~/.local/lib/houston-wsl/<build>/` inside a
//! distro, streaming only the files whose sha256 differs from the installed copy.

use super::command::{self, Runner, Stdin};
use super::distros::decode;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

pub const BUNDLED: [&str; 3] = ["houston-core", "tr-helper", "houston-supervisor"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Installed {
    /// Absolute POSIX path inside the distro.
    pub install_dir: String,
    pub written: Vec<&'static str>,
}

pub fn bundled_files(dir: &Path) -> Result<Vec<(&'static str, PathBuf)>, String> {
    BUNDLED
        .iter()
        .map(|name| {
            let path = dir.join(name);
            if path.is_file() {
                Ok((*name, path))
            } else {
                Err(format!(
                    "the bundled Linux binary {} is missing; expected houston-core, tr-helper \
                     and houston-supervisor in {} (a development build sets HOUSTON_WSL_BIN_DIR)",
                    path.display(),
                    dir.display()
                ))
            }
        })
        .collect()
}

pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut file =
        std::fs::File::open(path).map_err(|e| format!("reading {}: {e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = file
            .read(&mut buf)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn valid_build(build: &str) -> bool {
    !build.is_empty()
        && build != "."
        && build != ".."
        && build
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
}

fn parse_remote(stdout: &[u8]) -> Result<(String, HashMap<String, String>), String> {
    let text = String::from_utf8_lossy(stdout);
    let mut lines = text.lines();
    let home = lines
        .next()
        .unwrap_or_default()
        .trim()
        .trim_end_matches('/');
    if !home.starts_with('/') {
        return Err(format!(
            "the distro reported home directory {home:?}; expected an absolute POSIX path"
        ));
    }
    let hashes = lines
        .filter_map(|line| {
            let (hash, name) = line.split_once("  ")?;
            Some((name.trim().to_string(), hash.trim().to_string()))
        })
        .collect();
    Ok((home.to_string(), hashes))
}

/// Asks the distro for `$HOME` and the installed hashes of `build`.
pub fn remote_state(
    runner: &dyn Runner,
    distro: &str,
    build: &str,
) -> Result<(String, HashMap<String, String>), String> {
    let argv = command::remote_hashes(distro, build);
    let out = runner
        .run(&argv, Stdin::Null)
        .map_err(|e| format!("{} could not run: {e}", command::describe(&argv)))?;
    if out.code != Some(0) {
        return Err(format!(
            "reading the installed Houston files in {distro} failed (exit {:?}): {}",
            out.code,
            decode(&out.stderr).trim()
        ));
    }
    parse_remote(&out.stdout)
}

pub fn install_dir(home: &str, build: &str) -> String {
    format!(
        "{home}/.local/lib/{}/{build}",
        houston_core::wsl_ensure::INSTALL_DIR_NAME
    )
}

pub fn provision(
    runner: &dyn Runner,
    distro: &str,
    build: &str,
    bundle_dir: &Path,
) -> Result<Installed, String> {
    if !valid_build(build) {
        return Err(format!(
            "build {build:?} cannot name an install directory; expected letters, digits, '.', '-' or '_'"
        ));
    }
    let files = bundled_files(bundle_dir)?;
    let (home, remote) = remote_state(runner, distro, build)?;
    let mut written = Vec::new();
    for (name, path) in files {
        let sha = sha256_file(&path)?;
        if remote.get(name) == Some(&sha) {
            continue;
        }
        let argv = command::install(distro, build, name, &sha);
        let out = runner
            .run(&argv, Stdin::File(&path))
            .map_err(|e| format!("{} could not run: {e}", command::describe(&argv)))?;
        if out.code != Some(0) {
            return Err(format!(
                "installing {name} into {} in {distro} failed (exit {:?}): {}",
                install_dir(&home, build),
                out.code,
                decode(&out.stderr).trim()
            ));
        }
        written.push(name);
    }
    Ok(Installed {
        install_dir: install_dir(&home, build),
        written,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::wsl::command::{Piped, RunOutput};
    use std::sync::Mutex;

    pub(crate) fn bundle_dir() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        for name in BUNDLED {
            std::fs::write(dir.path().join(name), format!("\x7fELF {name}")).unwrap();
        }
        dir
    }

    struct Recorder {
        remote: String,
        calls: Mutex<Vec<(Vec<String>, Option<PathBuf>)>>,
    }

    impl Runner for Recorder {
        fn run(&self, argv: &[String], stdin: Stdin<'_>) -> std::io::Result<RunOutput> {
            let stdin = match stdin {
                Stdin::Null => None,
                Stdin::File(path) => Some(path.to_path_buf()),
            };
            self.calls.lock().unwrap().push((argv.to_vec(), stdin));
            let stdout = if argv == command::remote_hashes("Ubuntu", "b2").as_slice() {
                self.remote.clone().into_bytes()
            } else {
                Vec::new()
            };
            Ok(RunOutput {
                code: Some(0),
                stdout,
                stderr: Vec::new(),
            })
        }

        fn spawn_piped(&self, _argv: &[String]) -> std::io::Result<Piped> {
            unreachable!("provisioning starts no relay")
        }
    }

    #[test]
    fn installs_when_hash_differs() {
        let bundle = bundle_dir();
        let stale = sha256_file(&bundle.path().join("tr-helper")).unwrap();
        let runner = Recorder {
            remote: format!(
                "/home/u\n{}  houston-core\n{stale}  tr-helper\n",
                "0".repeat(64)
            ),
            calls: Mutex::new(Vec::new()),
        };
        let installed = provision(&runner, "Ubuntu", "b2", bundle.path()).unwrap();
        assert_eq!(installed.install_dir, "/home/u/.local/lib/houston-wsl/b2");
        assert_eq!(installed.written, ["houston-core", "houston-supervisor"]);

        let calls = runner.calls.lock().unwrap();
        assert_eq!(calls.len(), 3, "{calls:?}");
        assert_eq!(calls[0], (command::remote_hashes("Ubuntu", "b2"), None));
        for ((argv, stdin), name) in calls[1..]
            .iter()
            .zip(["houston-core", "houston-supervisor"])
        {
            let path = bundle.path().join(name);
            let sha = sha256_file(&path).unwrap();
            assert_eq!(argv, &command::install("Ubuntu", "b2", name, &sha));
            assert_eq!(
                stdin.as_deref(),
                Some(path.as_path()),
                "the file streams on stdin"
            );
            let script = &argv[5];
            assert!(
                script.contains("$HOME/.local/lib/houston-wsl/$1"),
                "{script}"
            );
            assert!(script.contains("cat > \"$d/.$2.new\""), "{script}");
            assert!(
                script.contains("mv -f \"$d/.$2.new\" \"$d/$2\""),
                "{script}"
            );
            assert_eq!(&argv[6..], ["sh", "b2", name, sha.as_str()]);
        }
    }

    #[test]
    fn skips_when_hashes_match() {
        let bundle = bundle_dir();
        let lines: String = BUNDLED
            .iter()
            .map(|name| {
                format!(
                    "{}  {name}\n",
                    sha256_file(&bundle.path().join(name)).unwrap()
                )
            })
            .collect();
        let runner = Recorder {
            remote: format!("/home/u/\n{lines}"),
            calls: Mutex::new(Vec::new()),
        };
        let installed = provision(&runner, "Ubuntu", "b2", bundle.path()).unwrap();
        assert!(installed.written.is_empty());
        assert_eq!(installed.install_dir, "/home/u/.local/lib/houston-wsl/b2");
        let calls = runner.calls.lock().unwrap();
        assert_eq!(
            *calls,
            [(command::remote_hashes("Ubuntu", "b2"), None)],
            "matching hashes write nothing"
        );
    }

    #[test]
    fn a_missing_bundle_file_names_its_path() {
        let bundle = bundle_dir();
        std::fs::remove_file(bundle.path().join("houston-supervisor")).unwrap();
        let err = bundled_files(bundle.path()).unwrap_err();
        let expected = bundle.path().join("houston-supervisor");
        assert!(err.contains(&expected.display().to_string()), "{err}");
    }
}
