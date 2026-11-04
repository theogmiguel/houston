//! The Windows PATH the v2 server's PowerShell probe would rebuild at every boot.
//! Claimed only when certain; Linux keeps the server's login-shell probe, which
//! also carries `__MISE_DIFF` and `JAVA_HOME`.

use std::ffi::OsString;
use std::path::Path;

use crate::sys::host_env::HostEnv;

const DEFAULT_PATHEXT: [&str; 4] = [".COM", ".EXE", ".BAT", ".CMD"];

/// The variables the server's Windows probe reads, as plain strings.
#[derive(Debug, Default, Clone)]
pub struct WindowsInputs {
    pub path: Option<String>,
    pub pathext: Option<String>,
    pub appdata: Option<String>,
    pub localappdata: Option<String>,
    pub userprofile: Option<String>,
}

/// File checks, injectable so tests never depend on the machine's PATH.
pub struct Probe<'a> {
    /// A regular file after following links, as the server's `stat` sees it.
    pub is_file: &'a dyn Fn(&Path) -> bool,
    /// Any non-directory entry, links included, as process creation finds it.
    pub exists: &'a dyn Fn(&Path) -> bool,
}

/// The full child environment for a prepared spawn, or `None` when the server
/// must probe for itself. Every PATH spelling is replaced by one `PATH` key, as
/// the server's `setWindowsPath` leaves it.
pub fn prepared_server_env(env: &HostEnv, cwd: &Path) -> Option<Vec<(OsString, OsString)>> {
    if !cfg!(windows) {
        return None;
    }
    let path_keys = env
        .entries()
        .filter(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .count();
    if path_keys > 1 {
        return None;
    }
    let inputs = WindowsInputs {
        path: utf8(env, "PATH")?,
        pathext: utf8(env, "PATHEXT")?,
        appdata: utf8(env, "APPDATA")?,
        localappdata: utf8(env, "LOCALAPPDATA")?,
        userprofile: utf8(env, "USERPROFILE")?,
    };
    let probe = Probe {
        is_file: &|path| path.is_file(),
        exists: &|path| std::fs::symlink_metadata(path).is_ok_and(|meta| !meta.is_dir()),
    };
    let path = prepared_windows_path(&inputs, cwd, &probe)?;
    let mut out: Vec<(OsString, OsString)> = env
        .entries()
        .filter(|(key, _)| !key.eq_ignore_ascii_case("PATH"))
        .map(|(key, value)| (key.to_os_string(), value.to_os_string()))
        .collect();
    out.push(("PATH".into(), path.into()));
    Some(out)
}

/// `Some(None)` for an unset variable; `None` (refuse to prepare) for one that is
/// not Unicode, which the server would read lossily.
fn utf8(env: &HostEnv, name: &str) -> Option<Option<String>> {
    match env.var_os(name) {
        None => Some(None),
        Some(value) => value.to_str().map(|v| Some(v.to_string())),
    }
}

/// The PATH `resolveWindowsEnvironment` would produce when its `-NoProfile`
/// probe is the only one it runs, or `None` when that is not certain.
pub fn prepared_windows_path(inputs: &WindowsInputs, cwd: &Path, probe: &Probe) -> Option<String> {
    if finds_pwsh(inputs.path.as_deref(), cwd, probe) {
        return None;
    }
    let inherited = inputs.path.as_deref().filter(|p| !p.is_empty());
    // The probe echoes its inherited PATH (a failed one adds nothing), but only
    // ASCII entries survive its OEM code-page capture; a garbled copy of a
    // non-ASCII entry would lead. This PATH keeps the user's entries and order.
    let merged = merge_path_values(inherited, inherited);
    let known = known_cli_dirs(inputs).join(";");
    let baseline = merge_path_values(merged.as_deref(), Some(&known))?;
    node_on_path(&baseline, inputs.pathext.as_deref(), probe).then_some(baseline)
}

/// `pwsh.exe` is the server's first candidate; process creation looks in the
/// working directory and then in PATH.
fn finds_pwsh(path: Option<&str>, cwd: &Path, probe: &Probe) -> bool {
    if (probe.exists)(&cwd.join("pwsh.exe")) {
        return true;
    }
    path.unwrap_or_default()
        .split(';')
        .map(|entry| strip_wrapping_quotes(entry.trim()))
        .filter(|entry| !entry.is_empty())
        .any(|entry| (probe.exists)(&Path::new(entry).join("pwsh.exe")))
}

/// `mergePathValues` for win32: entries trimmed and unquoted, first spelling
/// kept, duplicates compared without case.
fn merge_path_values(preferred: Option<&str>, inherited: Option<&str>) -> Option<String> {
    let mut merged: Vec<String> = Vec::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in [preferred, inherited].into_iter().flatten() {
        if raw.is_empty() {
            continue;
        }
        for entry in raw.split(';') {
            let sanitized = entry.trim().replace('"', "");
            if sanitized.is_empty() {
                continue;
            }
            let normalized = strip_wrapping_quotes(sanitized.trim()).to_lowercase();
            if normalized.is_empty() || seen.contains(&normalized) {
                continue;
            }
            seen.push(normalized);
            merged.push(sanitized);
        }
    }
    (!merged.is_empty()).then(|| merged.join(";"))
}

fn strip_wrapping_quotes(value: &str) -> &str {
    value.trim_start_matches('"').trim_end_matches('"')
}

/// `resolveKnownWindowsCliDirs`, in the server's order.
fn known_cli_dirs(inputs: &WindowsInputs) -> Vec<String> {
    let trimmed = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string)
    };
    let mut dirs = Vec::new();
    if let Some(appdata) = trimmed(&inputs.appdata) {
        dirs.push(format!("{appdata}\\npm"));
    }
    if let Some(local) = trimmed(&inputs.localappdata) {
        dirs.push(format!("{local}\\Programs\\nodejs"));
        dirs.push(format!("{local}\\Volta\\bin"));
        dirs.push(format!("{local}\\pnpm"));
    }
    if let Some(profile) = trimmed(&inputs.userprofile) {
        dirs.push(format!("{profile}\\.local\\bin"));
        dirs.push(format!("{profile}\\.bun\\bin"));
        dirs.push(format!("{profile}\\scoop\\shims"));
    }
    dirs
}

/// `resolveWindowsPathExtensions`: upper-cased, dot-prefixed, deduplicated.
fn path_extensions(pathext: Option<&str>) -> Vec<String> {
    let mut parsed: Vec<String> = Vec::new();
    for entry in pathext.unwrap_or_default().split(';') {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            continue;
        }
        let ext = if trimmed.starts_with('.') {
            trimmed.to_uppercase()
        } else {
            format!(".{}", trimmed.to_uppercase())
        };
        if !parsed.contains(&ext) {
            parsed.push(ext);
        }
    }
    if parsed.is_empty() {
        DEFAULT_PATHEXT.iter().map(|e| e.to_string()).collect()
    } else {
        parsed
    }
}

/// `isCommandAvailable("node")` against the baseline PATH.
fn node_on_path(path: &str, pathext: Option<&str>, probe: &Probe) -> bool {
    let mut candidates: Vec<String> = Vec::new();
    for ext in path_extensions(pathext) {
        for name in [format!("node{ext}"), format!("node{}", ext.to_lowercase())] {
            if !candidates.contains(&name) {
                candidates.push(name);
            }
        }
    }
    path.split(';')
        .map(|entry| strip_wrapping_quotes(entry.trim()))
        .filter(|entry| !entry.is_empty())
        .any(|entry| {
            candidates
                .iter()
                .any(|name| (probe.is_file)(&Path::new(entry).join(name)))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::path::PathBuf;

    fn files(paths: &[(&str, &str)]) -> HashSet<PathBuf> {
        paths
            .iter()
            .map(|(dir, name)| Path::new(dir).join(name))
            .collect()
    }

    fn inputs(path: &str) -> WindowsInputs {
        WindowsInputs {
            path: Some(path.to_string()),
            pathext: Some(".COM;.EXE;.BAT;.CMD".to_string()),
            appdata: Some(r"C:\Users\u\AppData\Roaming".to_string()),
            localappdata: Some(r"C:\Users\u\AppData\Local".to_string()),
            userprofile: Some(r"C:\Users\u".to_string()),
        }
    }

    fn run(inputs: &WindowsInputs, present: &HashSet<PathBuf>) -> Option<String> {
        let is_file = |path: &Path| present.contains(path);
        let probe = Probe {
            is_file: &is_file,
            exists: &is_file,
        };
        prepared_windows_path(inputs, Path::new(r"C:\cwd"), &probe)
    }

    #[test]
    fn the_prepared_path_matches_the_servers_merge() {
        // Same answer as the server's own test: inherited PATH deduplicated
        // without case or quotes, then the known CLI directories it lacks.
        let present = files(&[(r"C:\Program Files\nodejs", "node.exe")]);
        let got = run(
            &inputs(
                r#"C:\Windows;"C:\Program Files\nodejs";c:\windows;;C:\Users\u\.bun\bin;C:\Users\José\bin"#,
            ),
            &present,
        );
        let expected = [
            r"C:\Windows",
            r"C:\Program Files\nodejs",
            r"C:\Users\u\.bun\bin",
            r"C:\Users\José\bin",
            r"C:\Users\u\AppData\Roaming\npm",
            r"C:\Users\u\AppData\Local\Programs\nodejs",
            r"C:\Users\u\AppData\Local\Volta\bin",
            r"C:\Users\u\AppData\Local\pnpm",
            r"C:\Users\u\.local\bin",
            r"C:\Users\u\scoop\shims",
        ]
        .join(";");
        assert_eq!(got.as_deref(), Some(expected.as_str()));
    }

    #[test]
    fn node_in_a_known_cli_dir_counts() {
        let present = files(&[(r"C:\Users\u\AppData\Local\Programs\nodejs", "node.exe")]);
        assert!(run(&inputs(r"C:\Windows"), &present).is_some());
    }

    #[test]
    fn a_missing_node_leaves_the_profile_probe_to_the_server() {
        assert_eq!(run(&inputs(r"C:\Windows"), &HashSet::new()), None);
    }

    #[test]
    fn a_resolvable_pwsh_leaves_the_probe_to_the_server() {
        let present = files(&[
            (r"C:\Program Files\nodejs", "node.exe"),
            (r"C:\Program Files\PowerShell\7", "pwsh.exe"),
        ]);
        assert_eq!(
            run(
                &inputs(r"C:\Program Files\nodejs;C:\Program Files\PowerShell\7"),
                &present
            ),
            None
        );
        let in_cwd = files(&[
            (r"C:\Program Files\nodejs", "node.exe"),
            (r"C:\cwd", "pwsh.exe"),
        ]);
        assert_eq!(run(&inputs(r"C:\Program Files\nodejs"), &in_cwd), None);
    }

    #[test]
    fn pathext_decides_which_node_names_count() {
        let present = files(&[(r"C:\tools", "node.cmd")]);
        let mut with_cmd = inputs(r"C:\tools");
        assert!(run(&with_cmd, &present).is_some());
        with_cmd.pathext = Some("exe".to_string());
        assert_eq!(run(&with_cmd, &present), None);
        with_cmd.pathext = Some(" ; ".to_string());
        assert!(
            run(&with_cmd, &present).is_some(),
            "an empty PATHEXT falls back to the default list"
        );
    }

    #[test]
    fn blank_profile_variables_add_no_directories() {
        let present = files(&[(r"C:\tools", "node.exe")]);
        let bare = WindowsInputs {
            path: Some(r"C:\tools".to_string()),
            appdata: Some("  ".to_string()),
            ..WindowsInputs::default()
        };
        assert_eq!(run(&bare, &present).as_deref(), Some(r"C:\tools"));
    }

    #[test]
    fn non_windows_hosts_never_claim_a_prepared_environment() {
        if cfg!(windows) {
            return;
        }
        let env = HostEnv::from_pairs([("PATH", "/usr/bin")]);
        assert!(prepared_server_env(&env, Path::new("/")).is_none());
    }

    #[cfg(windows)]
    #[test]
    fn two_path_spellings_leave_the_probe_to_the_server() {
        let env = HostEnv::from_pairs([("Path", r"C:\a"), ("PATH", r"C:\b")]);
        assert!(prepared_server_env(&env, Path::new(r"C:\")).is_none());
    }
}
