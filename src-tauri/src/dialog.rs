use std::path::PathBuf;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

use crate::fs_allowlist::{register_allowed_root, AllowedRoots};

async fn await_pick<F>(register: F) -> Result<Option<PathBuf>, String>
where
    F: FnOnce(Box<dyn FnOnce(Result<Option<PathBuf>, String>) + Send>),
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    register(Box::new(move |result| {
        let _ = tx.send(result);
    }));
    rx.await.map_err(|_| {
        "dialog callback was dropped without firing: the native picker's \
         run_on_main_thread dispatch failed, so no result (not even a \
         cancel) was ever produced"
            .to_string()
    })?
}

async fn await_pick_many<F>(register: F) -> Result<Option<Vec<PathBuf>>, String>
where
    F: FnOnce(Box<dyn FnOnce(Result<Option<Vec<PathBuf>>, String>) + Send>),
{
    let (tx, rx) = tokio::sync::oneshot::channel();
    register(Box::new(move |result| {
        let _ = tx.send(result);
    }));
    rx.await.map_err(|_| {
        "dialog callback was dropped without firing: the native picker's \
         run_on_main_thread dispatch failed, so no result (not even a \
         cancel) was ever produced"
            .to_string()
    })?
}

fn to_pick_result(command: &str, picked: Option<FilePath>) -> Result<Option<PathBuf>, String> {
    match picked {
        Some(file_path) => file_path
            .into_path()
            .map(Some)
            .map_err(|e| format!("{command}: selected path is not a filesystem path: {e}")),
        None => Ok(None),
    }
}

async fn register_and_return(
    picked: Option<PathBuf>,
    roots: &AllowedRoots,
) -> Result<Option<String>, String> {
    let Some(path) = picked else {
        return Ok(None);
    };
    let verbatim = path.to_string_lossy().into_owned();
    register_allowed_root(&verbatim, roots).await?;
    Ok(Some(verbatim))
}

fn to_pick_results(
    command: &str,
    picked: Option<Vec<FilePath>>,
) -> Result<Option<Vec<PathBuf>>, String> {
    let Some(paths) = picked else {
        return Ok(None);
    };
    paths
        .into_iter()
        .map(|file_path| {
            let shown = file_path.to_string();
            file_path.into_path().map_err(|e| {
                format!("{command}: selected path {shown:?} is not a filesystem path: {e}")
            })
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

#[tauri::command]
pub async fn dialog_pick_directory<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, AllowedRoots>,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let picked = await_pick(|cb| {
        let mut builder = app.dialog().file();
        if let Some(dir) = initial_path.as_deref().filter(|dir| !dir.trim().is_empty()) {
            builder = builder.set_directory(dir);
        }
        builder
            .pick_folder(move |file_path| cb(to_pick_result("dialog_pick_directory", file_path)));
    })
    .await?;
    register_and_return(picked, state.inner()).await
}

/// The renderer refuses to load a larger file into memory; an oversized pick
/// carries its size and an empty body so the UI can name the limit.
pub const THEME_FILE_MAX_BYTES: u64 = 256 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PickedThemeFile {
    pub name: String,
    pub size: u64,
    pub text: String,
}

pub fn read_theme_file(path: &std::path::Path) -> Result<PickedThemeFile, String> {
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("reading theme file metadata {}: {e}", path.display()))?;
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned());
    let text = if metadata.len() > THEME_FILE_MAX_BYTES {
        String::new()
    } else {
        let bytes = std::fs::read(path)
            .map_err(|e| format!("reading theme file {}: {e}", path.display()))?;
        String::from_utf8_lossy(&bytes).into_owned()
    };
    Ok(PickedThemeFile {
        name,
        size: metadata.len(),
        text,
    })
}

#[tauri::command]
pub async fn dialog_pick_theme_files<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<Vec<PickedThemeFile>>, String> {
    let picked = await_pick_many(|cb| {
        app.dialog()
            .file()
            .set_title("Import a theme")
            .add_filter("Theme files", &["json"])
            .pick_files(move |paths| cb(to_pick_results("dialog_pick_theme_files", paths)));
    })
    .await?;
    let Some(paths) = picked else {
        return Ok(None);
    };
    let mut files = Vec::with_capacity(paths.len());
    for path in paths {
        files.push(read_theme_file(&path)?);
    }
    Ok(Some(files))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
    use tempfile::tempdir;

    #[cfg(unix)]
    #[tokio::test]
    async fn a_picked_path_is_returned_verbatim_while_its_resolved_form_is_registered() {
        let base = tempdir().unwrap();
        let real_dir = base.path().join("real-target");
        let link = base.path().join("via-symlink");
        std::fs::create_dir_all(&real_dir).unwrap();
        symlink(&real_dir, &link).unwrap();

        let roots = AllowedRoots::new();
        let returned = register_and_return(Some(link.clone()), &roots)
            .await
            .unwrap();

        assert_eq!(
            returned,
            Some(link.to_string_lossy().into_owned()),
            "the returned path must be the symlink path verbatim, not resolved"
        );
        let expected_real = std::fs::canonicalize(&real_dir).unwrap();
        let guard = roots.0.lock().unwrap();
        assert_eq!(
            guard.as_slice(),
            &[expected_real],
            "the registered root must be the resolved real target, not the symlink"
        );
    }

    #[tokio::test]
    async fn a_cancelled_dialog_returns_none_and_registers_nothing() {
        let roots = AllowedRoots::new();
        let returned = register_and_return(None, &roots).await.unwrap();

        assert_eq!(returned, None);
        let guard = roots.0.lock().unwrap();
        assert!(
            guard.is_empty(),
            "cancel must not register any root, found: {guard:?}"
        );
    }

    #[tokio::test]
    async fn re_picking_the_same_path_twice_does_not_duplicate_the_root() {
        let base = tempdir().unwrap();
        let picked_dir = base.path().join("chosen");
        std::fs::create_dir_all(&picked_dir).unwrap();

        let roots = AllowedRoots::new();
        register_and_return(Some(picked_dir.clone()), &roots)
            .await
            .unwrap();
        register_and_return(Some(picked_dir.clone()), &roots)
            .await
            .unwrap();

        let guard = roots.0.lock().unwrap();
        assert_eq!(guard.len(), 1, "re-picking must not duplicate the root");
    }

    #[tokio::test]
    async fn await_pick_resolves_ok_some_when_the_callback_fires_with_a_path() {
        let path = PathBuf::from("/tmp/whatever-was-picked");
        let picked = await_pick(|cb| cb(Ok(Some(path.clone())))).await.unwrap();
        assert_eq!(picked, Some(path));
    }

    #[tokio::test]
    async fn await_pick_resolves_ok_none_when_the_callback_fires_with_a_cancel() {
        let picked = await_pick(|cb| cb(Ok(None))).await.unwrap();
        assert_eq!(picked, None);
    }

    #[tokio::test]
    async fn await_pick_propagates_a_named_error_from_the_callback() {
        let err = await_pick(|cb| cb(Err("boom".to_string())))
            .await
            .expect_err("callback error must propagate");
        assert_eq!(err, "boom");
    }

    #[tokio::test]
    async fn await_pick_many_propagates_a_named_error_and_survives_a_dropped_callback() {
        let err = await_pick_many(|cb| cb(Err("boom".to_string())))
            .await
            .expect_err("callback error must propagate");
        assert_eq!(err, "boom");

        let dropped = await_pick_many(drop)
            .await
            .expect_err("a dropped callback must be an Err, never Ok(None)");
        assert!(
            dropped.contains("dropped without firing"),
            "error should name what happened: {dropped}"
        );
    }

    #[tokio::test]
    async fn a_dropped_callback_becomes_a_named_error_not_a_panic_and_not_none() {
        let result = await_pick(|cb| {
            drop(cb);
        })
        .await;

        let err = result.expect_err("a dropped callback must be an Err, never Ok(None)");
        assert!(
            err.contains("dropped without firing"),
            "error should name what happened: {err}"
        );
    }
}

#[cfg(test)]
mod theme_file_tests {
    use super::*;

    #[test]
    fn a_theme_file_carries_its_name_size_and_text() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("mine.json");
        std::fs::write(&path, r#"{"name":"Mine"}"#).expect("write fixture");
        let file = read_theme_file(&path).expect("read theme");
        assert_eq!(file.name, "mine.json");
        assert_eq!(file.size, 15);
        assert_eq!(file.text, r#"{"name":"Mine"}"#);
    }

    #[test]
    fn an_oversized_theme_file_is_named_but_not_loaded() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("huge.json");
        std::fs::write(&path, vec![b'x'; THEME_FILE_MAX_BYTES as usize + 1])
            .expect("write fixture");
        let file = read_theme_file(&path).expect("read theme");
        assert_eq!(file.name, "huge.json");
        assert_eq!(file.size, THEME_FILE_MAX_BYTES + 1);
        assert!(file.text.is_empty(), "oversized bodies must stay empty");
    }
}
