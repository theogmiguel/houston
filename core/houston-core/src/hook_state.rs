use anyhow::{anyhow, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub fn hook_state_dir(state_dir: &Path) -> PathBuf {
    state_dir.join("hooks")
}

const SCOPES_NAME: &str = "scopes.json";

pub fn scopes_path(state_dir: &Path) -> PathBuf {
    hook_state_dir(state_dir).join(SCOPES_NAME)
}

const FILE_V: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScopeEntry {
    pub swarm: u64,
    pub work_root: String,
    pub root_dir: String,
    pub scope: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ScopesFile {
    v: u32,
    scopes: Vec<ScopeEntry>,
}

fn ensure_dir(state_dir: &Path) -> Result<PathBuf> {
    let dir = hook_state_dir(state_dir);
    // Checked before create_dir_all: that call succeeds *through* a
    // pre-existing symlink (and set_permissions follows it), so a symlinked
    // `hooks` would have Houston chmodding something it does not own.
    if let Ok(meta) = std::fs::symlink_metadata(&dir) {
        if !meta.is_dir() {
            let kind = if meta.file_type().is_symlink() {
                "a symlink"
            } else {
                "not a directory"
            };
            return Err(anyhow!(
                "{} is {kind}, not a real directory — refusing to chmod through it",
                dir.display()
            ));
        }
    }
    std::fs::create_dir_all(&dir).with_context(|| format!("creating {}", dir.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))
            .with_context(|| format!("chmod {}", dir.display()))?;
    }
    Ok(dir)
}

// Named `<name>.tr-tmp.<pid>.<seq>` rather than a NamedTempFile: that cleans
// up on drop but not on SIGKILL, and its name carries no pid — which is
// exactly what the liveness sweep below needs.
const TMP_INFIX: &str = ".tr-tmp.";

fn write_file(state_dir: &Path, name: &str, bytes: &[u8]) -> Result<()> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = ensure_dir(state_dir)?;
    sweep_stale_tmp(&dir);
    let tmp = dir.join(format!(
        "{name}{TMP_INFIX}{}.{}",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));
    // tmp + rename, never a bare write: a reader with no daemon has no
    // rebuild path, so it must never observe a half-written file.
    let dest = dir.join(name);
    if let Err(e) = std::fs::write(&tmp, bytes) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("writing {}", tmp.display()));
    }
    if let Err(e) = std::fs::rename(&tmp, &dest) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e).with_context(|| format!("renaming {} to {}", tmp.display(), dest.display()));
    }
    Ok(())
}

// The pid in the name is what makes this safe: process_is_alive skips
// anything whose writer might still be mid-rename, so only provably-dead
// writers' files are removed. Never touches `scopes.json` — no `.tr-tmp.`.
fn sweep_stale_tmp(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some((_, rest)) = name.split_once(TMP_INFIX) else {
            continue;
        };
        let Some((pid_str, _seq)) = rest.split_once('.') else {
            continue;
        };
        let Ok(pid) = pid_str.parse::<u32>() else {
            continue;
        };
        if crate::pid::process_is_alive(pid) {
            continue;
        }
        let _ = std::fs::remove_file(entry.path());
    }
}

pub fn write_scopes(state_dir: &Path, scopes: &[ScopeEntry]) -> Result<()> {
    let body = serde_json::to_vec_pretty(&ScopesFile {
        v: FILE_V,
        scopes: scopes.to_vec(),
    })
    .context("serializing the swarm scope registry")?;
    write_file(state_dir, SCOPES_NAME, &body)
}

pub fn read_scopes(state_dir: &Path) -> Vec<ScopeEntry> {
    let path = scopes_path(state_dir);
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            tracing::warn!(
                "swarm scope registry {} is unreadable ({e}); treating as no live scopes",
                path.display()
            );
            return Vec::new();
        }
    };
    let file = match serde_json::from_slice::<ScopesFile>(&bytes) {
        Ok(f) if f.v == FILE_V => f,
        Ok(f) => {
            tracing::warn!(
                "swarm scope registry {} has version {} (expected {FILE_V}); treating as no live scopes",
                path.display(),
                f.v
            );
            return Vec::new();
        }
        Err(e) => {
            tracing::warn!(
                "swarm scope registry {} is malformed ({e}); treating as no live scopes",
                path.display()
            );
            return Vec::new();
        }
    };
    for e in &file.scopes {
        if let Err(bad) = check_entry(e) {
            tracing::warn!(
                "swarm scope registry {} is malformed ({bad:#}); treating as no live scopes",
                path.display()
            );
            return Vec::new();
        }
    }
    file.scopes
}

// Not a style check: `Path::new("/x").starts_with("")` is `true`, so one
// empty `work_root` would make every cwd a candidate — mis-routing every
// pane, or (with a second live swarm) refusing every one.
fn check_entry(e: &ScopeEntry) -> Result<()> {
    for (field, value) in [("work_root", &e.work_root), ("scope", &e.scope)] {
        if value.is_empty() || !Path::new(value).is_absolute() {
            return Err(anyhow!(
                "swarm {} has {field} {value:?} — expected a non-empty absolute path",
                e.swarm
            ));
        }
    }
    Ok(())
}

// Tried twice, literal and canonicalized: `work_root` holds `$HOME` verbatim
// while `cwd` arrives symlink-resolved, so a symlinked `$HOME` would miss
// the literal check. Canonicalizing can only add matches, never remove one.
pub fn candidates<'a>(scopes: &'a [ScopeEntry], cwd: &Path) -> Vec<&'a ScopeEntry> {
    let cwd_real = real_path(cwd);
    scopes
        .iter()
        .filter(|e| {
            let root = Path::new(&e.work_root);
            cwd.starts_with(root) || cwd_real.starts_with(real_path(root))
        })
        .collect()
}

// Comparison aid only, never the record, and fail-soft on purpose: this also
// resolves a `cwd` whose pane and directory may already be gone, and that
// must stay a routing question, not become an error.
fn real_path(p: &Path) -> PathBuf {
    p.canonicalize().unwrap_or_else(|_| p.to_path_buf())
}

// The candidate set is built for this cwd before anything looks at its
// size, and the size is tested in exactly one place below — never on the
// registry's size, only on how many of its entries own this cwd.
pub fn resolve_scope(scopes: &[ScopeEntry], cwd: &Path) -> Result<Option<ScopeEntry>> {
    if !cwd.is_absolute() {
        return Err(anyhow!(
            "cwd {:?} is not absolute — scope resolution expects an absolute directory path",
            cwd.display().to_string()
        ));
    }
    let found = candidates(scopes, cwd);
    match found.len() {
        0 => Ok(None),
        1 => Ok(Some(found[0].clone())),
        _ => {
            let listed = found
                .iter()
                .map(|e| format!("swarm {} at {}", e.swarm, e.work_root))
                .collect::<Vec<_>>()
                .join(", ");
            Err(anyhow!(
                "cwd {} is under {} live swarm scopes ({listed}) — refusing to guess; \
                 set TR_SWARM_SCOPE to name one",
                cwd.display(),
                found.len()
            ))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(id: u64, work_root: &str) -> ScopeEntry {
        ScopeEntry {
            swarm: id,
            work_root: work_root.to_string(),
            root_dir: work_root.to_string(),
            scope: format!("{work_root}/.houston/swarm/{id}"),
        }
    }

    fn w(name: &str) -> String {
        if cfg!(windows) {
            format!("C:/w/{name}")
        } else {
            format!("/w/{name}")
        }
    }

    #[derive(Clone, Default)]
    struct LogBuf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);

    impl std::io::Write for LogBuf {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().write(buf)
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'a> tracing_subscriber::fmt::MakeWriter<'a> for LogBuf {
        type Writer = Self;
        fn make_writer(&'a self) -> Self::Writer {
            self.clone()
        }
    }

    #[test]
    fn cwd_resolves_to_the_live_scope_with_no_daemon_and_no_env() {
        let state = tempfile::tempdir().unwrap();
        write_scopes(state.path(), &[entry(7, &w("alpha"))]).unwrap();

        let got =
            resolve_scope(&read_scopes(state.path()), Path::new(&w("alpha/src/deep"))).unwrap();
        assert_eq!(got, Some(entry(7, &w("alpha"))));
    }

    #[test]
    fn one_candidate_is_not_a_special_case_it_is_the_same_path() {
        let scopes = vec![entry(1, &w("alpha")), entry(2, &w("beta"))];
        let cwd = PathBuf::from(w("alpha/sub"));
        let cwd = cwd.as_path();

        let found = candidates(&scopes, cwd);
        assert_eq!(found.len(), 1, "candidate set: {found:?}");
        assert_eq!(
            resolve_scope(&scopes, cwd).unwrap().as_ref(),
            Some(found[0]),
            "resolution must be exactly candidates()[0] — not a global-count shortcut"
        );

        assert!(candidates(&scopes, Path::new(&w("gamma"))).is_empty());
        assert_eq!(
            resolve_scope(&scopes, Path::new(&w("gamma"))).unwrap(),
            None
        );

        assert!(candidates(&scopes, Path::new(&w("alphabet"))).is_empty());
    }

    #[test]
    fn two_live_scopes_on_one_workspace_refuse_by_name() {
        let scopes = vec![entry(3, &w("shared")), entry(9, &w("shared"))];
        let err = resolve_scope(&scopes, Path::new(&w("shared/pkg"))).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("swarm 3"), "must name candidate 3: {text}");
        assert!(text.contains("swarm 9"), "must name candidate 9: {text}");
        assert!(text.contains(&w("shared")), "must name the roots: {text}");
        assert!(
            text.contains("refusing to guess"),
            "must refuse, not pick: {text}"
        );
    }

    #[test]
    fn a_relative_cwd_is_a_named_error_not_a_silent_miss() {
        let err = resolve_scope(&[entry(1, &w("alpha"))], Path::new("alpha/sub")).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("alpha/sub"), "must name the value: {text}");
        assert!(text.contains("absolute"), "must name the shape: {text}");
    }

    #[test]
    fn a_halted_swarm_stops_resolving_after_the_rebuild() {
        let state = tempfile::tempdir().unwrap();
        write_scopes(state.path(), &[entry(1, &w("alpha")), entry(2, &w("beta"))]).unwrap();
        assert!(
            resolve_scope(&read_scopes(state.path()), Path::new(&w("beta/x")))
                .unwrap()
                .is_some()
        );

        write_scopes(state.path(), &[entry(1, &w("alpha"))]).unwrap();
        assert_eq!(
            resolve_scope(&read_scopes(state.path()), Path::new(&w("beta/x"))).unwrap(),
            None,
            "a halted swarm must not resolve"
        );
        assert!(
            resolve_scope(&read_scopes(state.path()), Path::new(&w("alpha/x")))
                .unwrap()
                .is_some()
        );
    }

    #[test]
    fn missing_and_malformed_files_degrade_and_say_so() {
        let state = tempfile::tempdir().unwrap();

        assert!(read_scopes(state.path()).is_empty());

        write_file(state.path(), SCOPES_NAME, b"{ not json").unwrap();

        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        let scopes = tracing::subscriber::with_default(subscriber, || read_scopes(state.path()));
        assert!(
            scopes.is_empty(),
            "malformed registry must degrade to empty"
        );
        let logged = String::from_utf8(buf.0.lock().unwrap().clone()).unwrap();
        assert!(
            logged.contains("malformed") && logged.contains("no live scopes"),
            "the registry degrade must name the failure and the outcome: {logged}"
        );
        assert!(
            logged.contains(&scopes_path(state.path()).display().to_string()),
            "the registry degrade must name the file itself: {logged}"
        );

        write_file(
            state.path(),
            SCOPES_NAME,
            br#"{"v":99,"scopes":[{"swarm":5,"work_root":"/w/x","root_dir":"/w/x","scope":"/w/x/.houston/swarm/5"}]}"#,
        )
        .unwrap();
        assert!(
            read_scopes(state.path()).is_empty(),
            "a future shape must degrade, not be half-read"
        );
    }

    fn captured(f: impl FnOnce()) -> String {
        crate::test_tracing_capture::ensure_permissive_global_default();
        let buf = LogBuf::default();
        let subscriber = tracing_subscriber::fmt().with_writer(buf.clone()).finish();
        tracing::subscriber::with_default(subscriber, f);
        let logged = buf.0.lock().unwrap().clone();
        String::from_utf8(logged).unwrap()
    }

    #[test]
    fn an_entry_with_a_non_absolute_work_root_degrades_the_whole_file() {
        let state = tempfile::tempdir().unwrap();
        let mut bad = entry(4, "");
        bad.scope = format!("{}/.houston/swarm/4", w("beta"));
        write_scopes(state.path(), &[entry(1, &w("alpha")), bad]).unwrap();

        let logged = captured(|| {
            let scopes = read_scopes(state.path());
            assert!(
                scopes.is_empty(),
                "an empty work_root must poison the whole file, not become a wildcard: {scopes:?}"
            );
            assert_eq!(
                resolve_scope(&read_scopes(state.path()), Path::new(&w("anywhere/at/all")),)
                    .unwrap(),
                None
            );
        });
        assert!(logged.contains("swarm 4"), "must name the entry: {logged}");
        assert!(
            logged.contains("work_root"),
            "must name the field: {logged}"
        );
        assert!(
            logged.contains("absolute"),
            "must name the expected shape: {logged}"
        );

        write_scopes(state.path(), &[entry(5, "relative/root")]).unwrap();
        assert!(read_scopes(state.path()).is_empty());
    }

    #[test]
    fn the_version_and_unreadable_degrades_are_named_too() {
        let state = tempfile::tempdir().unwrap();
        write_file(
            state.path(),
            SCOPES_NAME,
            br#"{"v":99,"scopes":[{"swarm":5,"work_root":"/w/x","root_dir":"/w/x","scope":"/w/x/.houston/swarm/5"}]}"#,
        )
        .unwrap();
        let logged = captured(|| assert!(read_scopes(state.path()).is_empty()));
        assert!(
            logged.contains("version 99") && logged.contains("expected 1"),
            "the version degrade must name both versions: {logged}"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let path = scopes_path(state.path());
            write_scopes(state.path(), &[entry(1, &w("alpha"))]).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o000)).unwrap();
            if std::fs::read(&path).is_ok() {
                return;
            }
            let logged = captured(|| assert!(read_scopes(state.path()).is_empty()));
            assert!(
                logged.contains("unreadable") && logged.contains("no live scopes"),
                "the unreadable degrade must name the failure and the outcome: {logged}"
            );
            assert!(
                logged.contains(&path.display().to_string()),
                "the unreadable degrade must name the file: {logged}"
            );
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_root_in_the_record_still_matches_a_physical_cwd() {
        let base = tempfile::tempdir().unwrap();
        let real = base.path().join("real-home/w");
        std::fs::create_dir_all(real.join("src")).unwrap();
        std::os::unix::fs::symlink(base.path().join("real-home"), base.path().join("home"))
            .unwrap();

        let stored = base.path().join("home/w");
        let scopes = vec![entry(7, &stored.display().to_string())];
        let cwd = real.join("src").canonicalize().unwrap();
        assert_ne!(cwd, stored.join("src"), "precondition: the paths differ");

        assert_eq!(
            resolve_scope(&scopes, &cwd).unwrap().map(|e| e.swarm),
            Some(7),
            "a symlinked $HOME component must not lose the scope"
        );
        assert_eq!(scopes[0].work_root, stored.display().to_string());
    }

    #[test]
    fn a_cwd_that_no_longer_exists_still_resolves() {
        let scopes = vec![entry(2, &w("gone"))];
        assert_eq!(
            resolve_scope(&scopes, Path::new(&w("gone/deleted/dir")))
                .unwrap()
                .map(|e| e.swarm),
            Some(2),
            "an unresolvable path must stay a routing question, not become a miss"
        );
    }

    #[cfg(unix)]
    #[test]
    fn tmp_residue_from_a_dead_writer_is_swept_and_a_live_one_is_kept() {
        let state = tempfile::tempdir().unwrap();
        write_scopes(state.path(), &[]).unwrap();
        let dir = hook_state_dir(state.path());

        #[allow(clippy::disallowed_methods)]
        let mut child = std::process::Command::new("true").spawn().unwrap();
        let dead_pid = child.id();
        child.wait().unwrap();
        assert!(
            !crate::pid::process_is_alive(dead_pid),
            "precondition: the reaped child must read as not alive"
        );
        let stale = dir.join(format!("{SCOPES_NAME}{TMP_INFIX}{dead_pid}.{}", u64::MAX));
        std::fs::write(&stale, "junk").unwrap();
        let in_flight = dir.join(format!(
            "other{TMP_INFIX}{}.{}",
            std::process::id(),
            u64::MAX - 1
        ));
        std::fs::write(&in_flight, "junk").unwrap();

        write_scopes(state.path(), &[entry(1, &w("alpha"))]).unwrap();

        assert!(!stale.exists(), "residue from a dead writer must be swept");
        assert!(
            in_flight.exists(),
            "a tmp file whose writer is still alive may be mid-rename — it must survive"
        );
        assert_eq!(
            read_scopes(state.path()).len(),
            1,
            "and the sweep must not disturb the file it was sweeping around"
        );
    }

    #[test]
    fn a_regular_file_in_the_way_is_named_rather_than_left_to_create_dir_all() {
        let state = tempfile::tempdir().unwrap();
        std::fs::write(hook_state_dir(state.path()), "not a directory").unwrap();
        let err = write_scopes(state.path(), &[]).unwrap_err();
        let text = format!("{err:#}");
        assert!(
            text.contains("not a directory"),
            "must name what is in the way: {text}"
        );
        assert!(
            text.contains(&hook_state_dir(state.path()).display().to_string()),
            "must name the path: {text}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_hook_state_dir_is_0700() {
        use std::os::unix::fs::PermissionsExt;
        let state = tempfile::tempdir().unwrap();
        write_scopes(state.path(), &[]).unwrap();
        let mode = std::fs::metadata(hook_state_dir(state.path()))
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o700, "got {mode:o}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_hook_dir_is_refused_rather_than_chmodded_through() {
        let state = tempfile::tempdir().unwrap();
        let elsewhere = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(elsewhere.path(), hook_state_dir(state.path())).unwrap();
        let err = write_scopes(state.path(), &[]).unwrap_err();
        let text = format!("{err:#}");
        assert!(text.contains("symlink"), "{text}");
        assert!(text.contains("refusing to chmod through it"), "{text}");
    }
}
