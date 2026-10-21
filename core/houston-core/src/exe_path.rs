/// Resolves against the process environment: for entry points that own it.
pub fn resolve(command: &str) -> Option<std::path::PathBuf> {
    resolve_in(&crate::host_env::HostEnv::capture(), command)
}

pub fn resolve_in(env: &crate::host_env::HostEnv, command: &str) -> Option<std::path::PathBuf> {
    if command.contains('/') || command.contains('\\') {
        return Some(std::path::PathBuf::from(command));
    }
    let path = env.var_os("PATH")?;
    let mut candidates: Vec<String> = candidate_extensions(env)
        .into_iter()
        .map(|ext| format!("{command}{ext}"))
        .collect();
    #[cfg(windows)]
    candidates.push(command.to_string());
    #[cfg(not(windows))]
    {
        let _ = &candidates;
        candidates.push(command.to_string());
    }
    for dir in std::env::split_paths(path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for cand in &candidates {
            let joined = dir.join(cand);
            if joined.is_file() {
                return Some(absolute(&joined));
            }
        }
    }
    None
}

fn candidate_extensions(env: &crate::host_env::HostEnv) -> Vec<String> {
    #[cfg(not(windows))]
    let _ = env;
    #[cfg(windows)]
    {
        const DEFAULT_PATHEXT: &str = ".COM;.EXE;.BAT;.CMD";
        let raw = env.var("PATHEXT").unwrap_or_default();
        let trimmed = raw.trim();
        let source = if trimmed.is_empty() {
            DEFAULT_PATHEXT
        } else {
            trimmed
        };
        let mut out: Vec<String> = Vec::new();
        for ext in source.split(';') {
            let ext = ext.trim();
            if ext.is_empty() || ext == "." {
                continue;
            }
            let normalized = if ext.starts_with('.') {
                ext.to_string()
            } else {
                format!(".{ext}")
            };
            if !out
                .iter()
                .any(|seen| seen.eq_ignore_ascii_case(&normalized))
            {
                out.push(normalized);
            }
        }
        out
    }
    #[cfg(not(windows))]
    {
        Vec::new()
    }
}

fn absolute(p: &std::path::Path) -> std::path::PathBuf {
    if p.is_absolute() {
        p.to_path_buf()
    } else {
        match std::env::current_dir() {
            Ok(cwd) => cwd.join(p),
            Err(_) => p.to_path_buf(),
        }
    }
}
pub fn ascii_safe(p: &std::path::Path) -> std::path::PathBuf {
    #[cfg(windows)]
    {
        // Below Windows' MAX_PATH (260) with margin for what gets appended
        // downstream; only a path at risk of tipping over it pays for the
        // short-name lookup below.
        const RISK_LEN: usize = 230;
        let s = p.to_string_lossy();
        if s.is_ascii() && s.len() < RISK_LEN {
            return p.to_path_buf();
        }
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;

        let wide: Vec<u16> = p.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives both calls; `buf` is
        // sized from the first call's own reported length.
        unsafe {
            let need = GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0);
            if need > 0 {
                let mut buf = vec![0u16; need as usize];
                let written = GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), need);
                if written > 0 {
                    let short = String::from_utf16_lossy(&buf[..written as usize]);
                    return std::path::PathBuf::from(short);
                }
            }
        }
        p.to_path_buf()
    }
    #[cfg(not(windows))]
    {
        p.to_path_buf()
    }
}

pub fn command_spelling(p: &std::path::Path) -> String {
    #[cfg(windows)]
    {
        ascii_safe(p).display().to_string().replace('\\', "/")
    }
    #[cfg(not(windows))]
    {
        p.to_string_lossy().into_owned()
    }
}

pub fn strip_deleted_exe_suffix(exe: &std::path::Path) -> std::path::PathBuf {
    match exe.to_str().and_then(|s| s.strip_suffix(" (deleted)")) {
        Some(stripped) => std::path::PathBuf::from(stripped),
        None => exe.to_path_buf(),
    }
}

/// Git for Windows puts launchers in `<root>\cmd` and `<root>\bin` that start the real
/// `<root>\<toolchain>\bin\git.exe` as a second process on every call; the real binary
/// sets up the same `MSYSTEM`, `HOME` and `PATH` itself. `None` means use `shim` as is.
pub fn git_for_windows_binary(shim: &std::path::Path) -> Option<std::path::PathBuf> {
    let dir = shim.parent()?;
    let dir_name = dir.file_name()?.to_str()?;
    if !dir_name.eq_ignore_ascii_case("cmd") && !dir_name.eq_ignore_ascii_case("bin") {
        return None;
    }
    let root = dir.parent()?;
    ["mingw64", "clangarm64", "mingw32"]
        .iter()
        .map(|toolchain| root.join(toolchain).join("bin").join("git.exe"))
        .find(|real| real.is_file())
}

pub const HELPER_NAME: &str = if cfg!(windows) {
    "tr-helper.exe"
} else {
    "tr-helper"
};

pub fn agent_helper_exe(exe: &std::path::Path) -> std::path::PathBuf {
    let exe = strip_deleted_exe_suffix(exe);
    if let Some(dir) = exe.parent() {
        let helper = dir.join(HELPER_NAME);
        if helper.is_file() {
            return helper;
        }
    }
    exe
}

#[cfg(test)]
mod tests {
    use super::*;

    /// PATH is `dir` followed by the process's own entries.
    #[allow(dead_code)]
    fn env_with_path(dir: &std::path::Path, pathext: Option<&str>) -> crate::host_env::HostEnv {
        let mut parts = vec![dir.to_path_buf()];
        if let Some(old) = crate::host_env::HostEnv::capture().var_os("PATH") {
            parts.extend(std::env::split_paths(old));
        }
        let path = std::env::join_paths(parts).expect("tempdir paths never contain separators");
        crate::host_env::HostEnv::from_pairs([("PATH", path)]).with("PATHEXT", pathext)
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    fn assert_hit(dir: &std::path::Path, expected_file: &str, got: Option<std::path::PathBuf>) {
        let got = got.unwrap_or_else(|| panic!("expected {expected_file} under {}", dir.display()));
        assert_eq!(got.parent(), Some(dir), "{got:?}");
        let name = got.file_name().and_then(|n| n.to_str()).unwrap_or("");
        assert!(
            name.eq_ignore_ascii_case(expected_file),
            "resolved {got:?}, expected {expected_file}"
        );
    }

    #[test]
    fn separator_inputs_pass_through_untouched() {
        assert_eq!(
            resolve("/usr/bin/env"),
            Some(std::path::PathBuf::from("/usr/bin/env"))
        );
        assert_eq!(
            resolve("bin/tool"),
            Some(std::path::PathBuf::from("bin/tool"))
        );
        assert_eq!(
            resolve(r"C:\tools\tool.exe"),
            Some(std::path::PathBuf::from(r"C:\tools\tool.exe"))
        );
        assert_eq!(
            resolve(r"tools\tool"),
            Some(std::path::PathBuf::from(r"tools\tool"))
        );
    }

    #[test]
    #[cfg(windows)]
    fn pathext_order_decides_between_cmd_and_exe() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("claude.cmd"), b"").unwrap();
        std::fs::write(dir.path().join("claude.exe"), b"").unwrap();
        let env = env_with_path(dir.path(), Some(".COM;.EXE;.BAT;.CMD"));
        assert_hit(dir.path(), "claude.exe", resolve_in(&env, "claude"));

        let env = env_with_path(dir.path(), Some(".CMD;.EXE"));
        assert_hit(dir.path(), "claude.cmd", resolve_in(&env, "claude"));
    }

    #[test]
    #[cfg(windows)]
    fn unset_pathext_falls_back_to_default_and_extensions_beat_bare_name() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("claude.cmd"), b"").unwrap();
        std::fs::write(dir.path().join("claude.exe"), b"").unwrap();
        std::fs::write(dir.path().join("tool"), b"").unwrap();
        std::fs::write(dir.path().join("tool.EXE"), b"").unwrap();
        let env = env_with_path(dir.path(), None);

        assert_hit(dir.path(), "claude.exe", resolve_in(&env, "claude"));
        assert_hit(dir.path(), "tool.EXE", resolve_in(&env, "tool"));
    }

    #[test]
    #[cfg(windows)]
    fn bare_name_still_wins_when_no_extension_sibling_exists() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("only"), b"").unwrap();
        let env = env_with_path(dir.path(), None);

        assert_hit(dir.path(), "only", resolve_in(&env, "only"));
    }

    #[test]
    #[cfg(unix)]
    fn bare_tool_resolves_on_unix_without_any_extension_logic() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tool"), b"").unwrap();
        std::fs::create_dir(dir.path().join("dirmatch")).unwrap();
        let env = env_with_path(dir.path(), None);

        assert_eq!(resolve_in(&env, "tool"), Some(dir.path().join("tool")));
        assert_eq!(resolve_in(&env, "dirmatch"), None);
    }

    #[test]
    fn a_name_found_nowhere_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let env = env_with_path(dir.path(), None);
        assert_eq!(resolve_in(&env, "tr-exe-resolve-missing-probe"), None);
    }

    #[test]
    fn no_path_means_none() {
        let env = crate::host_env::HostEnv::from_pairs::<&str, &str>([]);
        assert_eq!(resolve_in(&env, "anything-at-all"), None);
    }

    #[test]
    fn strip_deleted_exe_suffix_strips_only_the_literal_suffix() {
        assert_eq!(
            strip_deleted_exe_suffix(std::path::Path::new("/opt/houston-core (deleted)")),
            std::path::PathBuf::from("/opt/houston-core")
        );
        assert_eq!(
            strip_deleted_exe_suffix(std::path::Path::new("/opt/houston-core")),
            std::path::PathBuf::from("/opt/houston-core")
        );
        assert_eq!(
            strip_deleted_exe_suffix(std::path::Path::new("/opt/houston-core (deleted)/bin")),
            std::path::PathBuf::from("/opt/houston-core (deleted)/bin")
        );
    }

    fn touch(path: &std::path::Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, b"").unwrap();
    }

    #[test]
    fn a_git_for_windows_launcher_resolves_to_its_toolchain_binary() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("mingw64").join("bin").join("git.exe");
        touch(&real);
        for launcher_dir in ["cmd", "bin", "Cmd"] {
            let shim = root.path().join(launcher_dir).join("git.exe");
            touch(&shim);
            assert_eq!(
                git_for_windows_binary(&shim).as_deref(),
                Some(real.as_path()),
                "{shim:?}"
            );
        }
    }

    #[test]
    fn an_arm64_install_resolves_to_clangarm64() {
        let root = tempfile::tempdir().unwrap();
        let shim = root.path().join("cmd").join("git.exe");
        let real = root.path().join("clangarm64").join("bin").join("git.exe");
        touch(&shim);
        touch(&real);
        assert_eq!(git_for_windows_binary(&shim), Some(real));
    }

    #[test]
    fn a_git_outside_a_git_for_windows_layout_is_used_as_is() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("mingw64").join("bin").join("git.exe");
        touch(&real);
        assert_eq!(
            git_for_windows_binary(&real),
            None,
            "already the real binary"
        );

        let shims = root.path().join("shims").join("git.exe");
        touch(&shims);
        assert_eq!(git_for_windows_binary(&shims), None, "not a launcher dir");

        let bare = tempfile::tempdir().unwrap();
        let lone = bare.path().join("cmd").join("git.exe");
        touch(&lone);
        assert_eq!(git_for_windows_binary(&lone), None, "no toolchain binary");
        std::fs::create_dir_all(bare.path().join("mingw64").join("bin").join("git.exe")).unwrap();
        assert_eq!(
            git_for_windows_binary(&lone),
            None,
            "a directory is not a binary"
        );
    }

    #[test]
    fn agent_helper_prefers_a_sibling_and_falls_back_to_the_host() {
        let dir = tempfile::tempdir().unwrap();
        let host = dir.path().join("houston");
        std::fs::write(&host, b"#!/bin/sh\n").unwrap();

        assert_eq!(agent_helper_exe(&host), host, "must fall back to the host");

        let helper = dir.path().join(HELPER_NAME);
        std::fs::write(&helper, b"#!/bin/sh\n").unwrap();
        assert_eq!(
            agent_helper_exe(&host),
            helper,
            "must prefer the sibling helper once it exists"
        );
    }

    #[test]
    fn a_directory_named_like_the_helper_is_not_mistaken_for_one() {
        let dir = tempfile::tempdir().unwrap();
        let host = dir.path().join("houston");
        std::fs::write(&host, b"#!/bin/sh\n").unwrap();
        std::fs::create_dir(dir.path().join(HELPER_NAME)).unwrap();
        assert_eq!(agent_helper_exe(&host), host);
    }

    #[test]
    fn a_deleted_suffix_is_stripped_before_the_sibling_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let helper = dir.path().join(HELPER_NAME);
        std::fs::write(&helper, b"#!/bin/sh\n").unwrap();
        let host_deleted =
            std::path::PathBuf::from(format!("{}/houston (deleted)", dir.path().display()));
        assert_eq!(agent_helper_exe(&host_deleted), helper);
    }
}
