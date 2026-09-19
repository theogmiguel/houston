use std::path::{Path, PathBuf};
use std::sync::Mutex;

pub struct AllowedRoots(pub Mutex<Vec<PathBuf>>);

impl AllowedRoots {
    pub fn new() -> Self {
        Self(Mutex::new(Vec::new()))
    }
}

fn to_absolute_raw(input: &str) -> Result<PathBuf, String> {
    let path = Path::new(input);
    if path.is_absolute() {
        Ok(path.to_path_buf())
    } else {
        let cwd = std::env::current_dir().map_err(|e| {
            format!(
                "cannot resolve relative path {input:?} to an absolute path: \
                 current working directory is unavailable ({e})"
            )
        })?;
        Ok(PathBuf::from(format!(
            "{}{}{}",
            cwd.display(),
            std::path::MAIN_SEPARATOR,
            input
        )))
    }
}

fn append_tail(mut result: PathBuf, tail: &[std::ffi::OsString]) -> PathBuf {
    for component in tail.iter().rev() {
        if component == ".." {
            result.pop();
        } else {
            result.push(component);
        }
    }
    result
}

pub async fn real_or_nearest_ancestor(path: &str) -> Result<PathBuf, String> {
    real_or_nearest_ancestor_of(&to_absolute_raw(path)?).await
}

async fn real_or_nearest_ancestor_of(absolute: &Path) -> Result<PathBuf, String> {
    let mut p = absolute.to_path_buf();
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    loop {
        match tokio::fs::canonicalize(&p).await {
            Ok(real) => {
                return Ok(append_tail(real, &tail));
            }
            Err(_) => {
                let parent = p.parent().map(Path::to_path_buf);
                match parent {
                    Some(parent) if parent != p => {
                        match p.components().next_back() {
                            Some(std::path::Component::Normal(name)) => {
                                tail.push(name.to_os_string());
                            }
                            Some(std::path::Component::ParentDir) => {
                                tail.push(std::ffi::OsString::from(".."));
                            }
                            _ => {}
                        }
                        p = parent;
                    }
                    _ => {
                        return Ok(append_tail(p, &tail));
                    }
                }
            }
        }
    }
}

pub async fn assert_within_allowed_roots(
    path: &str,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let real = real_or_nearest_ancestor(path).await?;
    check_within(&real, path, allowed_roots)?;
    Ok(real)
}

fn check_within(real: &Path, path: &str, allowed_roots: &[PathBuf]) -> Result<(), String> {
    let ok = allowed_roots.iter().any(|root| real.starts_with(root));
    if !ok {
        let detail = if allowed_roots.is_empty() {
            " (no workspace roots are open yet)".to_string()
        } else {
            format!(
                " (expected under one of: {})",
                allowed_roots
                    .iter()
                    .map(|r| r.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        };
        return Err(format!(
            "path is outside every open workspace root: {path}{detail}"
        ));
    }
    Ok(())
}

pub async fn assert_entry_within_allowed_roots(
    path: &str,
    allowed_roots: &[PathBuf],
) -> Result<PathBuf, String> {
    let last_segment = path
        .trim_end_matches(std::path::MAIN_SEPARATOR)
        .rsplit(std::path::MAIN_SEPARATOR)
        .next()
        .unwrap_or("");
    if matches!(last_segment, "" | "." | "..") {
        return Err(format!(
            "not a file or directory name: {path} ends in {last_segment:?} \
             (expected a path whose last component is an entry name, e.g. /ws/notes.md)"
        ));
    }
    let absolute = to_absolute_raw(path)?;
    let name = match absolute.components().next_back() {
        Some(std::path::Component::Normal(name)) => name.to_os_string(),
        other => {
            return Err(format!(
                "not a file or directory name: {path} ends in {other:?} \
                 (expected a path whose last component is an entry name, e.g. /ws/notes.md)"
            ))
        }
    };
    let parent = absolute
        .parent()
        .expect("a path ending in a Normal component always has a parent");
    let parent_real = real_or_nearest_ancestor_of(parent).await?;
    check_within(&parent_real, path, allowed_roots)?;
    Ok(parent_real.join(name))
}

pub async fn register_allowed_root(path: &str, state: &AllowedRoots) -> Result<PathBuf, String> {
    let real = real_or_nearest_ancestor(path).await?;
    let mut roots = state
        .0
        .lock()
        .map_err(|_| "allowed-roots lock poisoned".to_string())?;
    if !roots.contains(&real) {
        roots.push(real.clone());
    }
    Ok(real)
}

#[tauri::command]
pub async fn fs_add_allowed_root(
    root: String,
    state: tauri::State<'_, AllowedRoots>,
) -> Result<(), String> {
    register_allowed_root(&root, state.inner()).await?;
    Ok(())
}

async fn resolve_roots(roots: &[String]) -> Result<Vec<PathBuf>, String> {
    let mut resolved = Vec::with_capacity(roots.len());
    for root in roots {
        resolved.push(real_or_nearest_ancestor(root).await?);
    }
    Ok(resolved)
}

#[tauri::command]
pub async fn fs_set_allowed_roots(
    roots: Vec<String>,
    state: tauri::State<'_, AllowedRoots>,
) -> Result<(), String> {
    let resolved = resolve_roots(&roots).await?;
    *state
        .0
        .lock()
        .map_err(|_| "allowed-roots lock poisoned".to_string())? = resolved;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tauri::Manager;
    use tempfile::tempdir;
    use tokio::fs;

    #[cfg(unix)]
    #[tokio::test]
    async fn rejects_a_symlink_then_dotdot_escape_that_lands_outside_the_allowed_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let secret = base.path().join("secret");
        fs::create_dir_all(&ws).await.unwrap();
        fs::create_dir_all(&secret).await.unwrap();
        fs::write(secret.join("creds.txt"), "TOP SECRET CREDS")
            .await
            .unwrap();
        symlink("../secret", ws.join("link")).unwrap();

        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];
        let attack_path = format!("{}/link/../secret/creds.txt", ws.display());

        let result = assert_within_allowed_roots(&attack_path, &roots).await;
        let err = result.expect_err("attack path must be rejected");
        assert!(
            err.contains("outside every open workspace root"),
            "unexpected message: {err}"
        );
    }

    #[tokio::test]
    async fn resolves_and_allows_an_ordinary_file_inside_the_allowed_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();
        fs::write(ws.join("file.txt"), "hello").await.unwrap();

        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];
        let real = assert_within_allowed_roots(ws.join("file.txt").to_str().unwrap(), &roots)
            .await
            .unwrap();
        assert_eq!(real, fs::canonicalize(ws.join("file.txt")).await.unwrap());
    }

    #[tokio::test]
    async fn allows_a_not_yet_existing_file_under_an_allowed_root() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();

        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];
        let real = assert_within_allowed_roots(ws.join("brand-new.txt").to_str().unwrap(), &roots)
            .await
            .unwrap();
        assert_eq!(
            real,
            fs::canonicalize(&ws).await.unwrap().join("brand-new.txt")
        );
    }

    #[tokio::test]
    async fn rejects_a_path_with_no_allowed_roots_open_yet() {
        let base = tempdir().unwrap();
        let target = base.path().join("x");

        let result = assert_within_allowed_roots(target.to_str().unwrap(), &[]).await;
        let err = result.expect_err("must be rejected with no roots open");
        assert!(
            err.contains("no workspace roots are open yet"),
            "unexpected message: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn set_allowed_roots_normalizes_a_symlinked_workspace_root_the_same_way_a_path_check_resolves(
    ) {
        let base = tempdir().unwrap();
        let real_dir = base.path().join("dev-real");
        let link = base.path().join("dev-link");
        fs::create_dir_all(&real_dir).await.unwrap();
        fs::write(real_dir.join("file.txt"), "hello").await.unwrap();
        symlink(&real_dir, &link).unwrap();

        let roots = resolve_roots(&[link.to_str().unwrap().to_string()])
            .await
            .unwrap();

        let resolved =
            assert_within_allowed_roots(real_dir.join("file.txt").to_str().unwrap(), &roots)
                .await
                .unwrap();
        assert_eq!(
            resolved,
            fs::canonicalize(real_dir.join("file.txt")).await.unwrap()
        );
    }

    #[tokio::test]
    async fn a_terminal_dotdot_pair_cancels_out_above_the_root_instead_of_being_dropped() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();

        let ws_real = real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap();
        let roots = vec![ws_real.clone()];
        let attack_path = format!("{}/nonexistent/../..", ws.display());

        let resolved = real_or_nearest_ancestor(&attack_path).await.unwrap();
        assert_eq!(
            resolved,
            ws_real.parent().unwrap().to_path_buf(),
            "both '..' tokens must cancel, landing one level above the root"
        );

        let result = assert_within_allowed_roots(&attack_path, &roots).await;
        let err = result.expect_err("a path resolving above the root must be rejected");
        assert!(
            err.contains("outside every open workspace root"),
            "unexpected message: {err}"
        );
    }

    #[tokio::test]
    async fn a_multi_level_missing_tail_is_reassembled_in_the_right_order() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();

        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];
        let real = assert_within_allowed_roots(
            ws.join("a").join("b").join("c.txt").to_str().unwrap(),
            &roots,
        )
        .await
        .unwrap();
        assert_eq!(
            real,
            fs::canonicalize(&ws)
                .await
                .unwrap()
                .join("a")
                .join("b")
                .join("c.txt")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_deleted_cwd_returns_an_error_instead_of_panicking_on_a_relative_path() {
        let orig_cwd = std::env::current_dir().unwrap();
        let base = tempdir().unwrap();
        let stale = base.path().join("stale-cwd");
        fs::create_dir_all(&stale).await.unwrap();
        std::env::set_current_dir(&stale).unwrap();
        fs::remove_dir(&stale).await.unwrap();

        let result = real_or_nearest_ancestor("relative/path").await;

        std::env::set_current_dir(&orig_cwd).unwrap();

        let err = result.expect_err("a deleted cwd must produce an error, not a panic");
        assert!(
            err.contains("relative/path"),
            "error should name the offending value: {err}"
        );
        assert!(
            err.contains("current working directory"),
            "error should name the expected shape: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_entry_gate_does_not_resolve_the_final_symlink_the_way_the_read_gate_does() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let target = base.path().join("target.txt");
        fs::create_dir_all(&ws).await.unwrap();
        fs::write(&target, "TARGET").await.unwrap();
        let link = ws.join("link");
        symlink(&target, &link).unwrap();

        let ws_real = real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap();
        let roots = vec![ws_real.clone()];
        let link_str = link.to_str().unwrap();

        assert!(assert_within_allowed_roots(link_str, &roots).await.is_err());
        let entry = assert_entry_within_allowed_roots(link_str, &roots)
            .await
            .unwrap();
        assert_eq!(entry, ws_real.join("link"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_entry_gate_still_refuses_a_symlink_then_dotdot_escape() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        let secret = base.path().join("secret");
        fs::create_dir_all(&ws).await.unwrap();
        fs::create_dir_all(&secret).await.unwrap();
        fs::write(secret.join("creds.txt"), "TOP SECRET CREDS")
            .await
            .unwrap();
        symlink("../secret", ws.join("link")).unwrap();

        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];
        let attack_path = format!("{}/link/../secret/creds.txt", ws.display());

        let err = assert_entry_within_allowed_roots(&attack_path, &roots)
            .await
            .expect_err("attack path must be rejected");
        assert!(
            err.contains("outside every open workspace root"),
            "unexpected message: {err}"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_entry_gate_refuses_a_path_that_does_not_end_in_a_name() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();
        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];

        for tail in ["..", "."] {
            let path = format!("{}/{tail}", ws.display());
            let err = assert_entry_within_allowed_roots(&path, &roots)
                .await
                .expect_err("a path with no final name must be refused");
            assert!(
                err.contains("not a file or directory name") && err.contains(&path),
                "must name the offending value and the expected shape: {err}"
            );
        }
        let err = assert_entry_within_allowed_roots("/", &roots)
            .await
            .expect_err("the filesystem root must be refused");
        assert!(err.contains("not a file or directory name"), "{err}");
    }

    #[tokio::test]
    async fn the_entry_gate_distinguishes_no_roots_open_from_outside_the_open_ones() {
        let base = tempdir().unwrap();
        let target = base.path().join("x.txt");
        fs::write(&target, "hi").await.unwrap();

        let err = assert_entry_within_allowed_roots(target.to_str().unwrap(), &[])
            .await
            .expect_err("must be rejected with no roots open");
        assert!(err.contains("no workspace roots are open yet"), "{err}");

        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();
        let roots = vec![real_or_nearest_ancestor(ws.to_str().unwrap())
            .await
            .unwrap()];
        let err = assert_entry_within_allowed_roots(target.to_str().unwrap(), &roots)
            .await
            .expect_err("must be rejected as outside the open roots");
        assert!(err.contains("expected under one of:"), "{err}");
    }

    #[tokio::test]
    async fn adding_the_same_root_twice_does_not_duplicate_it() {
        let base = tempdir().unwrap();
        let ws = base.path().join("ws");
        fs::create_dir_all(&ws).await.unwrap();

        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![fs_add_allowed_root])
            .manage(AllowedRoots::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .expect("mock window builds");

        for _ in 0..2 {
            let response = tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: "fs_add_allowed_root".into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(serde_json::json!({
                        "root": ws.to_str().unwrap(),
                    })),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            );
            assert!(
                response.is_ok(),
                "fs_add_allowed_root must succeed: {response:?}"
            );
        }

        let state = app.state::<AllowedRoots>();
        let roots = state.0.lock().unwrap();
        assert_eq!(
            roots.len(),
            1,
            "re-adding the same root must not duplicate it"
        );
    }

    #[tokio::test]
    async fn add_appends_set_replaces_and_a_registered_root_is_honored_by_a_check() {
        let base = tempdir().unwrap();
        let ws_a = base.path().join("ws-a");
        let ws_b = base.path().join("ws-b");
        fs::create_dir_all(&ws_a).await.unwrap();
        fs::create_dir_all(&ws_b).await.unwrap();
        fs::write(ws_b.join("file.txt"), "hello").await.unwrap();

        let app = tauri::test::mock_builder()
            .invoke_handler(tauri::generate_handler![
                fs_add_allowed_root,
                fs_set_allowed_roots
            ])
            .manage(AllowedRoots::new())
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .expect("mock app builds");
        let window = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            tauri::WebviewUrl::App("index.html".into()),
        )
        .build()
        .expect("mock window builds");

        let invoke = |cmd: &'static str, body: serde_json::Value| {
            tauri::test::get_ipc_response(
                &window,
                tauri::webview::InvokeRequest {
                    cmd: cmd.into(),
                    callback: tauri::ipc::CallbackFn(0),
                    error: tauri::ipc::CallbackFn(1),
                    url: if cfg!(any(windows, target_os = "android")) {
                        "http://tauri.localhost"
                    } else {
                        "tauri://localhost"
                    }
                    .parse()
                    .unwrap(),
                    body: tauri::ipc::InvokeBody::Json(body),
                    headers: Default::default(),
                    invoke_key: tauri::test::INVOKE_KEY.into(),
                },
            )
        };

        let response = invoke(
            "fs_add_allowed_root",
            serde_json::json!({ "root": ws_a.to_str().unwrap() }),
        );
        assert!(response.is_ok(), "first add must succeed: {response:?}");
        let response = invoke(
            "fs_add_allowed_root",
            serde_json::json!({ "root": ws_b.to_str().unwrap() }),
        );
        assert!(response.is_ok(), "second add must succeed: {response:?}");
        {
            let state = app.state::<AllowedRoots>();
            let roots = state.0.lock().unwrap();
            assert_eq!(roots.len(), 2, "add must append rather than replace");
        }

        let response = invoke(
            "fs_set_allowed_roots",
            serde_json::json!({ "roots": [ws_b.to_str().unwrap()] }),
        );
        assert!(response.is_ok(), "set must succeed: {response:?}");
        let roots_after_set = {
            let state = app.state::<AllowedRoots>();
            let roots = state.0.lock().unwrap();
            assert_eq!(roots.len(), 1, "set must replace, not append");
            roots.clone()
        };

        let resolved =
            assert_within_allowed_roots(ws_b.join("file.txt").to_str().unwrap(), &roots_after_set)
                .await
                .unwrap();
        assert_eq!(
            resolved,
            fs::canonicalize(ws_b.join("file.txt")).await.unwrap()
        );
    }
}
